/**
 * build-cli.mjs — produce an EXTERNALLY INSTALLABLE, self-contained `iap`
 * package under `dist-pkg/cli/` (Phase 19, M19.4, artifact 1).
 *
 * The in-repo `@iap/cli` depends on 10 `@iap/* workspace:*` packages plus
 * `yaml`; an external `npm install` cannot resolve `workspace:*`. The whole
 * CLI graph is pure JS (only `yaml` + `ajv`, both pure), so we BUNDLE it into
 * a single ESM file with esbuild and physically STAGE the runtime data files
 * the code loads via `new URL('../<dir>/<file>', import.meta.url)`.
 *
 * Layout produced (all asset dirs sit next to `dist/` so the bundle's `../`
 * refs — `import.meta.url` points at `dist/iap.js` — resolve):
 *
 *   dist-pkg/cli/
 *     package.json                (name "iap", version 0.1.0, bin, NO deps)
 *     dist/iap.js                 (bundle; shebang banner)
 *     schemas/*.schema.json       (8 merged, no basename collisions)
 *     registry/error-codes.yaml
 *     prompts/*.md                (byte-exact — content-hash pinned)
 *     snapshots/reference-cloud.snapshot.json
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/packaging/build-cli.mjs → repo root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(repoRoot, 'dist-pkg', 'cli');
const esbuild = join(
  repoRoot,
  'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild',
);

function log(msg) {
  process.stdout.write(`[build-cli] ${msg}\n`);
}

/* 1. Build every @iap/* so their dist/ exist (the bundle imports from dist). */
log('pnpm run build …');
execFileSync('pnpm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

/* Clean output. */
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'dist'), { recursive: true });

/* 2. Bundle the CLI into a single self-contained ESM file.
 *    platform=node keeps node:* builtins external; everything else
 *    (yaml, ajv, all @iap/*) is inlined.
 *    NOTE: the entry `cli.ts` already begins with `#!/usr/bin/env node`, and
 *    esbuild hoists that shebang to the top of the output. A `--banner:js`
 *    shebang would DUPLICATE it (a second `#!` on line 2 is a syntax error),
 *    so we rely on the hoisted source shebang and assert it below. */
const bundlePath = join(outDir, 'dist', 'iap.js');
log('esbuild bundle …');
execFileSync(
  esbuild,
  [
    join(repoRoot, 'packages/cli/src/cli.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    // Some bundled CJS deps do `require("process")` etc. esbuild's ESM
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
for (const literal of [
  'new URL(`../schemas/${name}`, import.meta.url)',
  '"../registry/error-codes.yaml"',
  '"../package.json"',
]) {
  if (!bundle.includes(literal)) {
    throw new Error(`bundle is missing expected asset ref: ${literal}`);
  }
}

/* 3. Stage runtime assets next to dist/ so `../<dir>/<file>` resolves. */
function copyInto(destDir, ...sources) {
  mkdirSync(destDir, { recursive: true });
  for (const src of sources) {
    cpSync(src, join(destDir, src.split('/').pop()));
  }
}

// 3a. 8 schemas from 5 packages → schemas/ (no basename collisions).
const schemasDest = join(outDir, 'schemas');
mkdirSync(schemasDest, { recursive: true });
const schemaPkgs = ['model', 'cost', 'intent-compiler', 'planner', 'provider-sdk'];
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
if (schemaCount !== 8) throw new Error(`expected 8 schemas, staged ${schemaCount}`);
log(`staged ${schemaCount} schemas`);

// 3b. error-codes registry.
copyInto(join(outDir, 'registry'), join(repoRoot, 'packages/cli/registry/error-codes.yaml'));

// 3c. prompts (byte-exact — content-hash pinned).
const promptsSrc = join(repoRoot, 'packages/intent-compiler/prompts');
const promptFiles = readdirSync(promptsSrc).filter((f) => f.endsWith('.md'));
copyInto(join(outDir, 'prompts'), ...promptFiles.map((f) => join(promptsSrc, f)));
log(`staged ${promptFiles.length} prompts`);

// 3d. cost reference snapshot.
copyInto(
  join(outDir, 'snapshots'),
  join(repoRoot, 'packages/cost/snapshots/reference-cloud.snapshot.json'),
);

/* 4. Emit a self-contained package.json (no workspace deps, zero runtime deps). */
const srcPkg = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
const pkg = {
  name: 'iap',
  version: srcPkg.version,
  description: srcPkg.description,
  type: 'module',
  bin: { iap: 'dist/iap.js' },
  files: ['dist', 'schemas', 'registry', 'prompts', 'snapshots'],
  engines: { node: '>=22' },
  license: srcPkg.license,
};
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

log(`done → ${outDir} (version ${pkg.version})`);
