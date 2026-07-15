/**
 * smoke-mcp.mjs — the release gate for the externally installable
 * `@infraasprompt/mcp-server` package (roadmap-v3 M20.1).
 *
 * Proves that a CLEAN environment with an empty node_modules can install the
 * packaged MCP server and drive it over stdio JSON-RPC. It:
 *   1. `npm pack`s `dist-pkg/mcp-server` into a tarball,
 *   2. `npm install`s that tarball into a FRESH temp project created OUTSIDE
 *      the repo (mkdtemp under the OS temp dir — no access to the monorepo
 *      node_modules, so the install must resolve with NO workspace deps),
 *   3. asserts the installed package contains no `workspace:` strings and no
 *      absolute monorepo paths,
 *   4. spawns `node_modules/.bin/iap-mcp-server` and speaks MCP JSON-RPC over
 *      stdio (newline-delimited JSON framing, per the MCP spec):
 *        - `initialize`            → protocolVersion 2025-06-18, serverInfo
 *        - `tools/list`            → EXACTLY the 5 read-only iap_* tools; no
 *                                    deployment/mutation-named tool anywhere
 *        - `tools/call iap_validate` on a real example doc → ok result
 *        - `tools/call iis_validate` (legacy name) → unknown-tool error
 *          (hard rename, ADR-0003 — no aliases)
 *   5. proves the roadmap exit criterion literally: from a clean dir with a
 *      clean npm cache, `npx --package=<tarball> iap-mcp-server` starts and
 *      answers the `initialize` handshake,
 *   6. exits non-zero with a clear message on any failure; always cleans up.
 */

import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

// tools/packaging/smoke-mcp.mjs → repo root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgDir = join(repoRoot, 'dist-pkg', 'mcp-server');

const PROTOCOL_VERSION = '2025-06-18';
const EXPECTED_TOOLS = ['iap_author', 'iap_compliance', 'iap_cost', 'iap_security', 'iap_validate'];
const FORBIDDEN_VERBS = [
  'deploy',
  'destroy',
  'apply',
  'rollback',
  'provision',
  'mutate',
  'delete',
  'push',
  'execute',
];

function log(msg) {
  process.stdout.write(`[smoke-mcp] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[smoke-mcp] FAIL: ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
}

/* ------- newline-delimited JSON framing (mirrors src/transport.ts) --------- */

function encodeMessage(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

class FrameDecoder {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const bodies = [];
    for (;;) {
      const newline = this.buffer.indexOf(0x0a); // '\n'
      if (newline === -1) break;
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 0) bodies.push(line);
    }
    return bodies;
  }
}

/** A JSON-RPC client over a spawned server's stdio. */
class McpClient {
  #child;
  #pending = new Map();
  #nextId = 1;

  constructor(command, args, options = {}) {
    this.#child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    const decoder = new FrameDecoder();
    this.#child.stdout.on('data', (chunk) => {
      for (const body of decoder.push(chunk)) {
        const message = JSON.parse(body);
        const resolve = this.#pending.get(message.id);
        if (resolve !== undefined) {
          this.#pending.delete(message.id);
          resolve(message);
        }
      }
    });
    this.stderr = '';
    this.#child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
  }

  /** Send a request and await its framed response (30 s timeout). */
  request(method, params = {}) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`no response to "${method}" (id ${id}) within 30s\n${this.stderr}`));
      }, 30_000);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.#child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    return promise;
  }

  notify(method, params = {}) {
    this.#child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  /** Close stdin and await a clean exit. */
  close() {
    return new Promise((resolve) => {
      this.#child.once('exit', (code) => resolve(code));
      this.#child.stdin.end();
      // Belt and braces: don't let a wedged server hang the smoke forever.
      setTimeout(() => this.#child.kill('SIGKILL'), 10_000).unref();
    });
  }
}

/* ------------------------------- assertions -------------------------------- */

function assertInitialize(response, label) {
  const result = response.result;
  if (result === undefined) fail(`${label}: initialize errored: ${JSON.stringify(response.error)}`);
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    fail(`${label}: protocolVersion ${result.protocolVersion} !== ${PROTOCOL_VERSION}`);
  }
  if (result.serverInfo?.name !== '@iap/mcp-server') {
    fail(`${label}: serverInfo.name ${result.serverInfo?.name} !== @iap/mcp-server`);
  }
  if (typeof result.capabilities?.tools !== 'object') {
    fail(`${label}: capabilities.tools missing`);
  }
  log(
    `${label}: initialize → protocol ${result.protocolVersion}, server ${result.serverInfo.name} ${result.serverInfo.version}`,
  );
}

/** Recursively scan the installed package for forbidden strings. */
function scanInstalledPackage(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanInstalledPackage(path);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    if (text.includes('workspace:')) fail(`installed file ${path} contains "workspace:"`);
    if (text.includes(repoRoot))
      fail(`installed file ${path} contains the monorepo path ${repoRoot}`);
  }
}

/* --------------------------------- smoke ----------------------------------- */

if (!existsSync(join(pkgDir, 'package.json'))) {
  fail(`${pkgDir} not built — run \`pnpm run build:mcp-pkg\` first`);
}

// Temp workspace OUTSIDE the repo (OS temp dir), so nothing resolves against
// the monorepo node_modules.
const work = mkdtempSync(join(tmpdir(), 'iap-mcp-smoke-'));
log(`temp workspace: ${work}`);

try {
  /* 1. npm pack → tarball in the temp dir. */
  log('npm pack …');
  const packJson = execFileSync('npm', ['pack', '--json', `--pack-destination=${work}`], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  const tarball = join(work, JSON.parse(packJson)[0].filename);
  log(`packed: ${tarball}`);

  /* 2. Fresh project, install the tarball with NO other deps. */
  const proj = join(work, 'project');
  execFileSync('mkdir', ['-p', proj]);
  execFileSync('npm', ['init', '-y'], { cwd: proj, stdio: 'ignore' });
  log('npm install <tarball> …');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: proj,
    stdio: 'inherit',
  });

  const bin = join(proj, 'node_modules', '.bin', 'iap-mcp-server');
  if (!existsSync(bin)) fail('installed bin node_modules/.bin/iap-mcp-server not found');

  /* 3. The installed package must be fully self-contained. */
  const pkgName = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name;
  const installed = join(proj, 'node_modules', ...pkgName.split('/'));
  const deps = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).dependencies;
  if (deps !== undefined && Object.keys(deps).length > 0) {
    fail(`installed package.json has dependencies: ${JSON.stringify(deps)}`);
  }
  scanInstalledPackage(installed);
  log('installed package: zero dependencies, no workspace: strings, no monorepo paths');

  /* 4. Drive the installed bin over stdio JSON-RPC. */
  const client = new McpClient(bin, [], { cwd: proj });

  /* 4a. initialize */
  assertInitialize(
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'smoke-mcp', version: '0.0.0' },
    }),
    'installed bin',
  );
  client.notify('notifications/initialized');

  /* 4b. tools/list → exactly the 5 read-only tools, nothing mutation-named. */
  const listed = (await client.request('tools/list')).result?.tools;
  if (!Array.isArray(listed)) fail('tools/list returned no tools array');
  const names = listed.map((t) => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
    fail(
      `tools/list mismatch: got ${JSON.stringify(names)}, want ${JSON.stringify(EXPECTED_TOOLS)}`,
    );
  }
  for (const t of listed) {
    for (const verb of FORBIDDEN_VERBS) {
      if (t.name.toLowerCase().includes(verb)) {
        fail(`tools/list exposes a mutation-named tool "${t.name}" (verb "${verb}")`);
      }
    }
    if (t.inputSchema?.type !== 'object') fail(`tool ${t.name} has no object inputSchema`);
  }
  log(`tools/list → exactly [${names.join(', ')}], all read-only`);

  /* 4c. A real tools/call: validate a real example document. */
  const document = readFileSync(join(repoRoot, 'spec/examples/basic-webapp.iap.yaml'), 'utf8');
  const validate = (
    await client.request('tools/call', {
      name: 'iap_validate',
      arguments: { document },
    })
  ).result;
  if (validate?.isError !== false) {
    fail(`iap_validate returned isError=${validate?.isError}: ${validate?.content?.[0]?.text}`);
  }
  const verdict = JSON.parse(validate.content[0].text);
  if (verdict.ok !== true || !Array.isArray(verdict.findings)) {
    fail(`iap_validate verdict not ok: ${validate.content[0].text.slice(0, 300)}`);
  }
  log(`tools/call iap_validate → ok:true, ${verdict.findings.length} findings`);

  /* 4d. Hard rename: the legacy iis_* tool name must be an unknown-tool error. */
  const legacy = (
    await client.request('tools/call', {
      name: 'iis_validate',
      arguments: { document },
    })
  ).result;
  if (legacy?.isError !== true || !legacy.content?.[0]?.text.includes('unknown tool')) {
    fail(`legacy iis_validate was not rejected as unknown: ${JSON.stringify(legacy)}`);
  }
  log('tools/call iis_validate → rejected as unknown tool (no legacy aliases)');

  const code = await client.close();
  if (code !== 0) fail(`installed bin exited with code ${code}`);
  log('server exited cleanly on stdin close');

  /* 5. Exit criterion, literally: npx runs the packed tarball in a clean dir
   *    with a clean npm cache and answers the stdio handshake. */
  const npxDir = join(work, 'npx-clean');
  execFileSync('mkdir', ['-p', npxDir]);
  log('npx --package=<tarball> iap-mcp-server …');
  const npx = new McpClient('npx', ['--yes', `--package=${tarball}`, 'iap-mcp-server'], {
    cwd: npxDir,
    env: { ...process.env, npm_config_cache: join(work, 'npx-cache') },
  });
  assertInitialize(
    await npx.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'smoke-mcp-npx', version: '0.0.0' },
    }),
    'npx',
  );
  await npx.close();

  log('PASS — clean install + MCP stdio handshake + tool calls verified');
} finally {
  rmSync(work, { recursive: true, force: true });
  log(`cleaned up ${work}`);
}
