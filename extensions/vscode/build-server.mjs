/**
 * build-server.mjs — bundle the IaP language server (`@iap/language-server`)
 * into a single, zero-dependency ESM file under `extensions/vscode/server/`
 * so the packaged extension is self-contained (Phase 19, M19.4).
 *
 * The in-repo server depends on 5 `@iap/* workspace:*` engines plus
 * `vscode-languageserver` / `vscode-languageserver-textdocument`. An external
 * install cannot resolve `workspace:*`, so — exactly like
 * `tools/packaging/build-cli.mjs` — we esbuild-bundle the built entry
 * (`packages/language-server/dist/main.js`) into `server/server.js`, inline all
 * `@iap/*` + `vscode-languageserver*`, keep node builtins external, and
 * physically STAGE the runtime assets the code loads via
 * `new URL('../schemas/<file>', import.meta.url)` so those paths resolve.
 *
 * Layout produced:
 *
 *   server/
 *     server.js               (the bundle; createRequire banner, launched as `node server.js --stdio`)
 *     schemas/*.schema.json    (staged: the only assets the server loads at runtime)
 *
 * The bundle lives at `server/server.js`, so its sole dynamic asset ref
 * (`new URL('../schemas/<name>', import.meta.url)` in `@iap/model`) is
 * rewritten at build time to `./schemas/<name>` so the staged schemas — which
 * sit next to `server.js` under `server/` — resolve. This keeps the whole
 * server payload self-contained under a single `server/` directory.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(extRoot, '..', '..');
const esbuild = join(
  repoRoot,
  'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild',
);

const serverDir = join(extRoot, 'server');
const bundlePath = join(serverDir, 'server.js');

function log(msg) {
  process.stdout.write(`[build-server] ${msg}\n`);
}

/* 1. Ensure the language server (and its @iap/* engines) are built. Prefer a
 *    `pnpm` on PATH; fall back to `corepack pnpm` (repo standard when no pnpm
 *    shim is installed). */
log('building @iap/language-server …');
const pnpmArgs = ['--filter', '@iap/language-server', 'run', 'build'];
try {
  execFileSync('pnpm', pnpmArgs, { cwd: repoRoot, stdio: 'inherit' });
} catch (err) {
  if (err && err.code === 'ENOENT') {
    log('`pnpm` not on PATH — retrying via `corepack pnpm`');
    execFileSync('corepack', ['pnpm', ...pnpmArgs], { cwd: repoRoot, stdio: 'inherit' });
  } else {
    throw err;
  }
}

const entry = join(repoRoot, 'packages/language-server/dist/main.js');
if (!existsSync(entry)) {
  throw new Error(`language-server entry not built: ${entry}`);
}

/* Clean output. */
rmSync(serverDir, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });

/* 2. Bundle the server into a single self-contained ESM file.
 *    platform=node keeps node:* builtins external; @iap/* and
 *    vscode-languageserver* are inlined. The createRequire banner supplies a
 *    global `require` for any bundled CJS dep that calls it (same gotcha
 *    build-cli.mjs handled). main.js begins with a `#!` shebang which esbuild
 *    hoists to line 1; the banner lands after it. */
log('esbuild bundle …');
execFileSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    "--banner:js=import{createRequire as __iapCreateRequire}from'node:module';const require=__iapCreateRequire(import.meta.url);",
    `--outfile=${bundlePath}`,
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

/* 2b. Sanity-check the emitted bundle. */
let bundle = readFileSync(bundlePath, 'utf8');
if (!bundle.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('server bundle does not start with a line-1 shebang');
}
if (bundle.slice(1).includes('#!/usr/bin/env node')) {
  throw new Error('server bundle has a duplicate shebang — a second `#!` is a syntax error');
}
if (!bundle.includes('import.meta.url')) {
  throw new Error('server bundle lost import.meta.url — asset paths would not resolve');
}
const hashed = bundle.match(/[A-Za-z0-9_-]+\.[A-Z0-9]{8}\.(?:json|yaml|md)/g);
if (hashed) {
  throw new Error(`esbuild rewrote asset refs to hashed names (${hashed.join(', ')})`);
}

/* 2c. The bundle sits at server/server.js, but the only runtime asset loader
 *     (@iap/model) resolves schemas via `new URL('../schemas/<name>',
 *     import.meta.url)` — one level ABOVE the bundle. Rewrite that base to
 *     `./schemas/` so schemas staged NEXT TO server.js (under server/) resolve.
 *     This is the one dynamic asset ref the server pulls in; assert it exists
 *     before and after so the rewrite can never silently no-op. */
const assetRefBefore = '`../schemas/${name}`';
if (!bundle.includes(assetRefBefore)) {
  throw new Error(`server bundle is missing expected asset ref: ${assetRefBefore}`);
}
bundle = bundle.replaceAll(assetRefBefore, '`./schemas/${name}`');
if (!bundle.includes('`./schemas/${name}`')) {
  throw new Error('failed to rewrite schema asset base to ./schemas/');
}
writeFileSync(bundlePath, bundle);
log('rewrote schema asset base → ./schemas/ (resolves next to server.js)');

/* 3. Stage the runtime schema assets next to server.js (server/schemas/). */
const schemasDest = join(serverDir, 'schemas');
mkdirSync(schemasDest, { recursive: true });
const modelSchemas = join(repoRoot, 'packages/model/schemas');
const schemaFiles = ['iap-v1.schema.json', 'iap-mapping-v1.schema.json'];
for (const file of schemaFiles) {
  const src = join(modelSchemas, file);
  if (!existsSync(src)) {
    throw new Error(`missing server runtime schema: ${src}`);
  }
  cpSync(src, join(schemasDest, file));
}
log(`staged ${schemaFiles.length} runtime schemas → server/schemas/`);

/* 4. Mark the server dir as ESM so `node server.js` treats the bundle as an ES
 *    module cleanly (no MODULE_TYPELESS_PACKAGE_JSON warning / reparse). The
 *    parent extension package.json is CommonJS, so this local marker is what
 *    makes server.js unambiguously ESM regardless of install location. */
writeFileSync(
  join(serverDir, 'package.json'),
  `${JSON.stringify({ name: 'iap-language-server-bundle', private: true, type: 'module' }, null, 2)}\n`,
);
log('wrote server/package.json (type: module)');

const sizeKb = (readFileSync(bundlePath).length / 1024).toFixed(1);
log(`done → ${bundlePath} (${sizeKb} KiB)`);
