/**
 * build-mcp.mjs — produce an EXTERNALLY INSTALLABLE, self-contained
 * `@iap/mcp-server` package under `dist-pkg/mcp-server/` (roadmap-v3 M20.1).
 *
 * The in-repo `@iap/mcp-server` depends on 6 `@iap/* workspace:*` packages; an
 * external `npm install` cannot resolve `workspace:*`. The whole MCP graph is
 * pure JS (no native deps, no MCP SDK — the stdio transport is hand-rolled), so
 * we BUNDLE it into a single ESM file with esbuild and physically STAGE the
 * runtime data files the code loads via `new URL('../<dir>/<file>', import.meta.url)`.
 *
 * Layout produced (all asset dirs sit next to `dist/` so the bundle's `../`
 * refs — `import.meta.url` points at `dist/iap-mcp-server.js` — resolve):
 *
 *   dist-pkg/mcp-server/
 *     package.json                (name "@iap/mcp-server", bin, ZERO deps)
 *     README.md                   (npm page: tools, trust boundary, client config)
 *     LICENSE                     (Apache-2.0, copied from the repo root)
 *     dist/iap-mcp-server.js      (bundle; shebang banner)
 *     schemas/*.schema.json       (5 merged, no basename collisions)
 *     prompts/*.md                (byte-exact — content-hash pinned)
 *     snapshots/reference-cloud.snapshot.json
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/packaging/build-mcp.mjs → repo root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(repoRoot, 'dist-pkg', 'mcp-server');
const esbuild = join(
  repoRoot,
  'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild',
);

function log(msg) {
  process.stdout.write(`[build-mcp] ${msg}\n`);
}

/* 1. Build every @iap/* so their dist/ exist (the bundle imports from dist).
 *    Run pnpm via corepack, and the recursive build directly (not the root
 *    `build` script, whose body invokes a bare `pnpm` that is not on PATH when
 *    only corepack is installed). */
log('pnpm -r run build …');
execFileSync(
  'corepack',
  ['pnpm', '-r', '--filter', './packages/**', '--filter', './providers/**', 'run', 'build'],
  { cwd: repoRoot, stdio: 'inherit' },
);

/* Clean output. */
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'dist'), { recursive: true });

/* 2. Bundle the stdio entrypoint into a single self-contained ESM file.
 *    platform=node keeps node:* builtins external; everything else
 *    (all @iap/*) is inlined.
 *    NOTE: the entry `bin.ts` already begins with `#!/usr/bin/env node`, and
 *    esbuild hoists that shebang to the top of the output. A `--banner:js`
 *    shebang would DUPLICATE it (a second `#!` on line 2 is a syntax error),
 *    so we rely on the hoisted source shebang and assert it below. */
const bundlePath = join(outDir, 'dist', 'iap-mcp-server.js');
log('esbuild bundle …');
execFileSync(
  esbuild,
  [
    join(repoRoot, 'packages/mcp-server/src/bin.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    // Some bundled CJS deps may do `require("process")` etc. esbuild's ESM
    // `__require` stub uses a global `require` if one exists, else throws
    // ("Dynamic require of … is not supported"). Provide that global via
    // createRequire. This banner lands AFTER the hoisted source shebang.
    "--banner:js=import{createRequire as __iapCreateRequire}from'node:module';const require=__iapCreateRequire(import.meta.url);",
    `--outfile=${bundlePath}`,
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

/* 2b. Sanity-check the emitted bundle: esbuild must NOT have rewritten the
 *     runtime asset refs into hashed filenames, and must have preserved
 *     `import.meta.url`. If either fails, the readFileSync paths would break. */
const bundle = readFileSync(bundlePath, 'utf8');
// Exactly one shebang, on line 1 (a `#!` anywhere else is a syntax error).
if (!bundle.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('bundle does not start with a line-1 shebang — bin would not execute');
}
if (bundle.slice(1).includes('#!/usr/bin/env node')) {
  throw new Error('bundle has a duplicate shebang — a second `#!` is a syntax error');
}
if (!bundle.includes('import.meta.url')) {
  throw new Error('bundle lost import.meta.url — asset paths would not resolve');
}
const hashed = bundle.match(/[A-Za-z0-9_-]+\.[A-Z0-9]{8}\.(?:json|yaml|md)/g);
if (hashed) {
  throw new Error(
    `esbuild rewrote asset refs to hashed names (${hashed.join(', ')}) — readFileSync paths would break`,
  );
}
/* The refs the bundle ACTUALLY reads at runtime (confirmed by inspecting the
 * emitted bundle): the model schema loader (iap-v1 + iap-mapping-v1), the
 * intent-compiler operations schema, and the cost reference snapshot. The
 * prompt loader and the cost snapshot/report schema validators are tree-shaken
 * away (the MCP tools use the offline authoring path and `estimateCost`, which
 * never call them) — we still STAGE those assets below defensively, but only
 * assert the refs that must exist. */
for (const literal of [
  'new URL(`../schemas/${name}`, import.meta.url)', // @iap/model schema loader
  '"../schemas/compiler-operations-v1.schema.json"', // @iap/intent-compiler ops schema
  '"../snapshots/reference-cloud.snapshot.json"', // @iap/cost reference snapshot
]) {
  if (!bundle.includes(literal)) {
    throw new Error(`bundle is missing expected asset ref: ${literal}`);
  }
}
// A self-contained package must not leak the build machine's paths.
if (bundle.includes(repoRoot)) {
  throw new Error('bundle contains an absolute monorepo path — package is not relocatable');
}

/* 3. Stage runtime assets next to dist/ so `../<dir>/<file>` resolves. */
function copyInto(destDir, ...sources) {
  mkdirSync(destDir, { recursive: true });
  for (const src of sources) {
    cpSync(src, join(destDir, src.split('/').pop()));
  }
}

// 3a. 5 schemas from 3 packages → schemas/ (no basename collisions).
const schemasDest = join(outDir, 'schemas');
mkdirSync(schemasDest, { recursive: true });
const schemaPkgs = ['model', 'cost', 'intent-compiler'];
const seen = new Set();
let schemaCount = 0;
for (const pkg of schemaPkgs) {
  const dir = join(repoRoot, 'packages', pkg, 'schemas');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.schema.json')) continue;
    if (seen.has(file)) throw new Error(`schema basename collision: ${file}`);
    seen.add(file);
    cpSync(join(dir, file), join(schemasDest, file));
    schemaCount += 1;
  }
}
if (schemaCount !== 5) throw new Error(`expected 5 schemas, staged ${schemaCount}`);
log(`staged ${schemaCount} schemas`);

// 3b. prompts (byte-exact — content-hash pinned).
const promptsSrc = join(repoRoot, 'packages/intent-compiler/prompts');
const promptFiles = readdirSync(promptsSrc).filter((f) => f.endsWith('.md'));
copyInto(join(outDir, 'prompts'), ...promptFiles.map((f) => join(promptsSrc, f)));
log(`staged ${promptFiles.length} prompts`);

// 3c. cost reference snapshot.
copyInto(
  join(outDir, 'snapshots'),
  join(repoRoot, 'packages/cost/snapshots/reference-cloud.snapshot.json'),
);

// 3d. License (Apache-2.0) from the repo root, for the npm tarball.
cpSync(join(repoRoot, 'LICENSE'), join(outDir, 'LICENSE'));

/* 4. README for the npm package page. */
const readme = `# @iap/mcp-server

A read-only [MCP](https://modelcontextprotocol.io) (Model Context Protocol)
server for **IaP — Infrastructure as Prompt**. It lets an AI assistant
(Claude Code, Cursor, Windsurf, any MCP client) author and analyse IaP
documents over stdio using the IaP reference engines.

## Tools

| Tool | What it does |
| --- | --- |
| \`iap_author\` | Author IaP from a natural-language requirement via the intent compiler (extract → clarify → gate), with per-field provenance. |
| \`iap_validate\` | Validate an IaP document (phases 1–5) and return the findings. |
| \`iap_cost\` | Estimate cost and evaluate budgets against the reference price snapshot. |
| \`iap_security\` | Derive the security posture (grants, reachability, IAP6xx findings). |
| \`iap_compliance\` | Evaluate active compliance framework bundles and return the evidence report. |

## Trust boundary (read-only by construction)

Every tool is authoring or analysis. This server exposes **no deployment,
mutation, or provider-API tool** — an assistant using it structurally cannot
deploy or reach a cloud provider, and the server refuses to start if a
mutation-named tool is ever registered. Authoring goes through the
intent-compiler gate: an LLM never writes YAML into the source of truth.

## Client configuration

\`\`\`json
{ "mcpServers": { "iap": { "command": "npx", "args": ["-y", "@iap/mcp-server"] } } }
\`\`\`

The server speaks JSON-RPC 2.0 over stdio (newline-delimited JSON, one
message per line, per the MCP stdio transport; protocol revision 2025-06-18).
Protocol messages go to stdout; diagnostics to stderr.

## License

Apache-2.0. Part of the [IaP monorepo](https://github.com/vinit-devops/iap).
`;
writeFileSync(join(outDir, 'README.md'), readme);

/* 5. Emit a self-contained package.json (no workspace deps, zero runtime deps). */
const srcPkg = JSON.parse(readFileSync(join(repoRoot, 'packages/mcp-server/package.json'), 'utf8'));
const pkg = {
  name: '@iap/mcp-server',
  version: srcPkg.version,
  description:
    'Read-only MCP (Model Context Protocol) server for IaP — Infrastructure as Prompt. Exposes authoring and analysis tools (iap_author, iap_validate, iap_cost, iap_security, iap_compliance) over stdio; no deployment or mutation tools.',
  keywords: [
    'mcp',
    'model-context-protocol',
    'mcp-server',
    'iap',
    'infrastructure',
    'infrastructure-as-prompt',
    'infrastructure-as-code',
    'ai',
    'assistant',
    'cost',
    'security',
    'compliance',
  ],
  type: 'module',
  bin: { 'iap-mcp-server': 'dist/iap-mcp-server.js' },
  files: ['dist', 'schemas', 'prompts', 'snapshots'],
  engines: { node: '>=22' },
  license: srcPkg.license,
  repository: { type: 'git', url: 'git+https://github.com/vinit-devops/iap.git' },
  homepage: 'https://github.com/vinit-devops/iap#readme',
  bugs: { url: 'https://github.com/vinit-devops/iap/issues' },
  publishConfig: { access: 'public' },
};
if (Object.keys(pkg.bin).length === 0 || pkg.license !== 'Apache-2.0') {
  throw new Error('emitted package.json lost its bin or license');
}
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

log(`done → ${outDir} (version ${pkg.version})`);
