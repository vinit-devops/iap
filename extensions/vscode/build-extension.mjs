/**
 * build-extension.mjs — bundle the IaP VS Code extension entry
 * (`extension.js`) and its `vscode-languageclient` dependency into a single
 * self-contained CommonJS file, `extension.bundled.js` (Phase 19, M19.4).
 *
 * The extension host always provides `vscode`, so it stays external. Everything
 * else — `vscode-languageclient/node` and its transitive deps — is inlined so a
 * clean install (no monorepo deps, no global packages) can start the LSP client
 * without a MODULE_NOT_FOUND. Node built-ins remain external (platform=node).
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(extRoot, '..', '..');
const esbuild = join(
  repoRoot,
  'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild',
);

const entry = join(extRoot, 'extension.js');
const outfile = join(extRoot, 'extension.bundled.js');

function log(msg) {
  process.stdout.write(`[build-extension] ${msg}\n`);
}

log('esbuild bundle …');
execFileSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node22',
    '--external:vscode',
    `--outfile=${outfile}`,
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

/* Sanity: `vscode` must remain external (host-provided); vscode-languageclient
 * must be INLINED (no bare require left that would MODULE_NOT_FOUND on a clean
 * install). */
if (!existsSync(outfile)) {
  throw new Error('extension bundle was not produced');
}
const bundle = readFileSync(outfile, 'utf8');
if (!/require\(["']vscode["']\)/.test(bundle)) {
  throw new Error('bundle does not keep `vscode` external — host module would not resolve');
}
if (/require\(["']vscode-languageclient\/node["']\)/.test(bundle)) {
  throw new Error('bundle left `vscode-languageclient/node` as a bare require — not inlined');
}

const sizeKb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
log(`done → ${outfile} (${sizeKb} KiB)`);
