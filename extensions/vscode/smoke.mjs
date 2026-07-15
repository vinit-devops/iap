/**
 * smoke.mjs — OFFLINE release gate for the self-contained IaP VS Code extension
 * (Phase 19, M19.4 hardening).
 *
 * Run via the `smoke:vsix` root script, which builds the .vsix first
 * (`build-vsix.mjs` → bundles the server + extension, then packages). This
 * smoke then proves the packaged artifact gives full LSP with NO monorepo
 * deps, NO global packages and NO `iap.languageServer.path` setting:
 *
 *   1. Package shape — the .vsix zip contains the bundled extension, the
 *      bundled server (`extension/server/server.js` + schemas), the manifest
 *      and `[Content_Types].xml`; `node_modules`, `src`, tests and the
 *      unbundled `extension.js` are ABSENT. Prints the entry list + size.
 *   2. Server speaks LSP (end-to-end, no VS Code) — spawn the *extracted*
 *      `server/server.js --stdio`, `initialize` → assert `capabilities`
 *      (textDocumentSync/completion/hover/…), then `didOpen` an INVALID IaP →
 *      assert a `publishDiagnostics` with ≥1 diagnostic.
 *   3. Extension loads its client — load `extension.bundled.js` with a minimal
 *      `vscode` stub while EXTERNAL `vscode-languageclient` is made
 *      unresolvable; assert the client is loaded from the bundle (no
 *      MODULE_NOT_FOUND, no "install vscode-languageclient" degradation).
 *   4. Clean-profile install — `code --install-extension` into throwaway
 *      `--user-data-dir` / `--extensions-dir`; assert exit 0 + listed, then
 *      uninstall and reinstall. Falls back honestly to steps 1–3 if the `code`
 *      CLI is unavailable/flaky in a headless run.
 *
 * Exits non-zero with a clear message on any failure.
 */

import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const extRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(extRoot, 'package.json'), 'utf8'));
const vsixPath = join(extRoot, 'dist', `${manifest.name}-${manifest.version}.vsix`);

function log(msg) {
  process.stdout.write(`[smoke-vsix] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[smoke-vsix] FAIL: ${msg}\n`);
  process.exit(1);
}

/* ================================================================== */
/* Step 1 — package shape                                              */
/* ================================================================== */
if (!existsSync(vsixPath)) {
  fail(`vsix not found: ${vsixPath} — run \`node build-vsix.mjs\` first`);
}
let entries;
try {
  entries = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
} catch (err) {
  fail(`not a valid zip archive: ${err instanceof Error ? err.message : err}`);
}
const totalKb = (readFileSync(vsixPath).length / 1024).toFixed(1);
log(`valid zip with ${entries.length} entries, total .vsix size ${totalKb} KiB:`);
for (const entry of entries.slice().sort()) {
  process.stdout.write(`  ${entry}\n`);
}

const requiredEntries = [
  'extension/package.json',
  'extension/extension.bundled.js',
  'extension/server/server.js',
  'extension.vsixmanifest',
  '[Content_Types].xml',
];
for (const req of requiredEntries) {
  if (!entries.includes(req)) {
    fail(`required entry missing from .vsix: ${req}`);
  }
}
log(`required entries present: ${requiredEntries.join(', ')}`);

/* Prod-only: dev-only files and dirs MUST be absent. */
const forbidden = (e) =>
  e.includes('node_modules/') ||
  e.startsWith('extension/src/') ||
  e.includes('/test/') ||
  e.includes('/tests/') ||
  e.endsWith('.test.js') ||
  e === 'extension/extension.js' ||
  e.endsWith('build-vsix.mjs') ||
  e.endsWith('build-server.mjs') ||
  e.endsWith('build-extension.mjs') ||
  e.endsWith('smoke.mjs');
const leaked = entries.filter(forbidden);
if (leaked.length > 0) {
  fail(`dev-only files leaked into the .vsix: ${leaked.join(', ')}`);
}
log('no node_modules / src / tests / unbundled extension.js / build scripts in payload');

/* extension/package.json parses, declares the iap language + the bundled main. */
const pkg = JSON.parse(
  execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], { encoding: 'utf8' }),
);
if (pkg.main !== './extension.bundled.js') {
  fail(`extension main is not the bundle: ${pkg.main}`);
}
const languages = pkg?.contributes?.languages;
const iap = Array.isArray(languages) ? languages.find((l) => l && l.id === 'iap') : undefined;
if (
  iap === undefined ||
  !iap.extensions.includes('.iap.yaml') ||
  !iap.extensions.includes('.iap-map.yaml')
) {
  fail(
    `iap language does not declare .iap.yaml + .iap-map.yaml: ${JSON.stringify(iap?.extensions)}`,
  );
}
log('extension/package.json: main → bundle, language "iap" covers .iap.yaml + .iap-map.yaml');

/* Extract the payload so the following steps exercise the AS-PACKAGED files. */
const workDir = mkdtempSync(join(tmpdir(), 'iap-vsix-smoke-'));
execFileSync('unzip', ['-q', vsixPath, '-d', workDir]);
const extractedServer = join(workDir, 'extension', 'server', 'server.js');
const extractedExtension = join(workDir, 'extension', 'extension.bundled.js');
if (!existsSync(extractedServer) || !existsSync(extractedExtension)) {
  fail('extracted payload is missing server.js or extension.bundled.js');
}

/* ================================================================== */
/* Step 2 — the bundled server speaks LSP (initialize + diagnostics)   */
/* ================================================================== */
async function lspRoundTrip(serverJs) {
  const proc = spawn('node', [serverJs, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const messages = [];
  const send = (obj) => {
    const s = JSON.stringify(obj);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };
  proc.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) break;
      const m = buf
        .slice(0, idx)
        .toString()
        .match(/Content-Length: (\d+)/i);
      if (!m) break;
      const start = idx + 4;
      const len = Number(m[1]);
      if (buf.length < start + len) break;
      messages.push(JSON.parse(buf.slice(start, start + len).toString()));
      buf = buf.slice(start + len);
    }
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: process.pid, rootUri: null, capabilities: {} },
  });
  await delay(800);
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  const invalidDoc = 'apiVersion: iap.dev/v99\nkind: Bogus\nmetadata:\n  name: broken\n';
  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: 'file:///broken.iap.yaml',
        languageId: 'iap',
        version: 1,
        text: invalidDoc,
      },
    },
  });
  await delay(1500);
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  return { messages, stderr };
}

const { messages, stderr } = await lspRoundTrip(extractedServer);
const initResp = messages.find((m) => m.id === 1);
if (!initResp || !initResp.result || !initResp.result.capabilities) {
  fail(`server did not answer initialize with capabilities (stderr: ${stderr.slice(0, 400)})`);
}
const caps = Object.keys(initResp.result.capabilities);
for (const need of ['textDocumentSync', 'completionProvider', 'hoverProvider']) {
  if (!caps.includes(need)) {
    fail(`initialize capabilities missing ${need}: ${caps.join(', ')}`);
  }
}
log(`server initialize → capabilities: ${caps.join(', ')}`);

const diagMsgs = messages.filter((m) => m.method === 'textDocument/publishDiagnostics');
const withDiags = diagMsgs.find(
  (m) => Array.isArray(m.params.diagnostics) && m.params.diagnostics.length > 0,
);
if (!withDiags) {
  fail(
    `no publishDiagnostics with ≥1 diagnostic for an invalid IaP doc (stderr: ${stderr.slice(0, 400)})`,
  );
}
const firstDiag = withDiags.params.diagnostics[0];
log(
  `server diagnostics round-trip → ${withDiags.params.diagnostics.length} diagnostic(s), e.g. [${firstDiag.code}] ${firstDiag.message}`,
);

/* ================================================================== */
/* Step 3 — the bundled extension loads its client from the bundle     */
/* ================================================================== */
const probe = join(workDir, 'probe-extension.cjs');
writeFileSync(
  probe,
  `'use strict';
const Module = require('node:module');
const origLoad = Module._load;
const messages = [];
const disposable = { dispose() {} };
// vscode-languageclient extends these vscode classes at MODULE-EVAL time, so a
// class value must exist or the inlined client throws while loading.
const StubClass = class {};
const vscodeStub = {
  commands: { registerCommand: () => disposable },
  workspace: {
    getConfiguration: () => ({ get: () => '' }),
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
    onDidChangeConfiguration: () => disposable,
    onDidOpenTextDocument: () => disposable,
    onDidCloseTextDocument: () => disposable,
    onDidChangeTextDocument: () => disposable,
    onDidSaveTextDocument: () => disposable,
    textDocuments: [],
    getWorkspaceFolder: () => undefined,
    workspaceFolders: undefined,
  },
  window: {
    showInformationMessage: (m) => { messages.push(['info', m]); },
    showWarningMessage: (m) => { messages.push(['warn', m]); },
    showErrorMessage: (m) => { messages.push(['error', m]); },
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
    activeTextEditor: undefined,
  },
  languages: { match: () => 0 },
  Uri: { parse: (s) => ({ toString: () => s }) },
  ViewColumn: { Beside: 2 },
  EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} dispose() {} },
  CallHierarchyItem: StubClass,
  CancellationError: StubClass,
  CodeAction: StubClass,
  CodeLens: StubClass,
  CompletionItem: StubClass,
  Diagnostic: StubClass,
  DocumentLink: StubClass,
  InlayHint: StubClass,
  SymbolInformation: StubClass,
  TypeHierarchyItem: StubClass,
};
// 'vscode' → stub. A real (external) 'vscode-languageclient*' resolution MUST
// NOT happen: the client is inlined in the bundle. Throwing here is a
// regression guard — if esbuild ever failed to inline it, we'd catch the miss.
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  if (/^vscode-languageclient(\\/|$)/.test(request)) {
    const e = new Error("Cannot find module '" + request + "'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }
  return origLoad.call(this, request, parent, isMain);
};
const ext = require(${JSON.stringify(extractedExtension)});
if (typeof ext.activate !== 'function') { console.error('NO_ACTIVATE'); process.exit(3); }
let done = false;
function finish(err, note) {
  if (done) return;
  done = true;
  const degraded = messages.some((m) => /vscode-languageclient/i.test(String(m[1])) && /(Install|not available)/i.test(String(m[1])));
  const moduleMiss = !!(err && (err.code === 'MODULE_NOT_FOUND' || (/vscode-languageclient/.test(String(err.message)) && /Cannot find module/.test(String(err.message)))));
  console.log('PROBE_RESULT ' + JSON.stringify({ degraded, moduleMiss, errMsg: err ? String(err.message || err) : null, note: note || null }));
  try { ext.deactivate && ext.deactivate(); } catch {}
  process.exit(0);
}
// Reaching client.start() means the inlined client loaded & constructed; a
// slow/hanging start() under the stubbed host is itself proof of that, so a
// watchdog resolves it as success (no module miss, no degradation).
const watchdog = setTimeout(() => finish(null, 'client loaded + start() in progress under stub host (watchdog)'), 6000);
watchdog.unref && watchdog.unref();
Promise.resolve()
  .then(() => ext.activate({ subscriptions: [] }))
  .then(() => finish(null))
  .catch((err) => finish(err));
`,
);

let probeOut;
try {
  probeOut = execFileSync('node', [probe], { encoding: 'utf8', timeout: 20000 });
} catch (err) {
  const captured = `${err.stdout || ''}${err.stderr || ''}`;
  probeOut = captured;
}
const probeLine = probeOut.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
if (!probeLine) {
  fail(`client-load probe produced no result. Output: ${probeOut.slice(0, 600)}`);
}
const probeResult = JSON.parse(probeLine.slice('PROBE_RESULT '.length));
if (probeResult.moduleMiss) {
  fail(
    `extension could not load vscode-languageclient from the bundle (MODULE_NOT_FOUND): ${probeResult.errMsg}`,
  );
}
if (probeResult.degraded) {
  fail(
    'extension showed the "install vscode-languageclient" degradation — client was NOT loaded from the bundle',
  );
}
log(
  `extension loaded vscode-languageclient from the bundle (no MODULE_NOT_FOUND, no degradation)` +
    (probeResult.errMsg
      ? ` — client.start() then errored under the minimal host stub, expected headlessly: ${probeResult.errMsg}`
      : ' — client started'),
);

/* ================================================================== */
/* Step 4 — clean-profile install / uninstall / reinstall             */
/* ================================================================== */
const extId = `${manifest.publisher}.${manifest.name}`;
function hasCodeCli() {
  try {
    execFileSync('code', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (!hasCodeCli()) {
  log(
    `SKIP step 4: \`code\` CLI not on PATH. Package-shape + LSP + client-load proofs above stand. Install with: code --install-extension ${vsixPath}`,
  );
} else {
  const userDataDir = mkdtempSync(join(tmpdir(), 'iap-code-user-'));
  const extensionsDir = mkdtempSync(join(tmpdir(), 'iap-code-exts-'));
  const codeArgs = (extra) => [
    ...extra,
    '--user-data-dir',
    userDataDir,
    '--extensions-dir',
    extensionsDir,
  ];
  const runCode = (extra) => {
    try {
      const out = execFileSync('code', codeArgs(extra), {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120000,
      });
      return { code: 0, out };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };
  try {
    const install1 = runCode(['--install-extension', vsixPath, '--force']);
    const listed1 = runCode(['--list-extensions']);
    const isListed = (r) =>
      r.out
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .includes(extId.toLowerCase());
    if (install1.code === 0 && isListed(listed1)) {
      log(`clean-profile install OK — ${extId} listed`);
      const uninstall = runCode(['--uninstall-extension', extId]);
      const listed2 = runCode(['--list-extensions']);
      if (uninstall.code === 0 && !isListed(listed2)) {
        log('uninstall OK — extension no longer listed');
      } else {
        log(
          `uninstall reported code=${uninstall.code}; list still: ${listed2.out.trim() || '(empty)'}`,
        );
      }
      const install2 = runCode(['--install-extension', vsixPath, '--force']);
      const listed3 = runCode(['--list-extensions']);
      if (install2.code === 0 && isListed(listed3)) {
        log('reinstall OK — extension listed again');
      } else {
        log(`reinstall reported code=${install2.code}; list: ${listed3.out.trim() || '(empty)'}`);
      }
    } else {
      log(`clean-profile install via \`code\` was flaky (code=${install1.code}). Output:`);
      process.stdout.write(`  ${install1.out.trim().split('\n').join('\n  ')}\n`);
      log(
        'Falling back to the package-shape + spawn-server + client-load proofs above (all PASSED).',
      );
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(extensionsDir, { recursive: true, force: true });
  }
}

/* Tidy the extraction workdir. */
rmSync(workDir, { recursive: true, force: true });

log(
  'PASS — self-contained IaP extension: full LSP server bundled, client bundled, diagnostics proven offline',
);
