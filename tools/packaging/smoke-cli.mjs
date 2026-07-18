/**
 * smoke-cli.mjs — the release gate for the externally installable `iap`
 * package (Phase 19, M19.4, artifact 1).
 *
 * Proves that a CLEAN environment with an empty node_modules can install the
 * packaged CLI and run the plan-preview workflow. It:
 *   1. `npm pack`s `dist-pkg/cli` into a tarball,
 *   2. `npm install`s that tarball into a FRESH temp project created OUTSIDE
 *      the repo (mkdtemp under the OS temp dir — no access to the monorepo
 *      node_modules, so the install must resolve with NO workspace deps),
 *   3. invokes the installed `iap` bin and asserts:
 *        - `iap --version`        → prints the packaged version
 *        - `iap init`             → writes infrastructure.iap.yaml
 *        - `iap validate`         → exit 0 on a real example doc
 *        - `iap plan … --output json` → exit 0, JSON planId of form sha256:…,
 *          and the SAME planId across two runs (determinism)
 *   4. exits non-zero with a clear message on any failure; always cleans up.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/packaging/smoke-cli.mjs → repo root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgDir = join(repoRoot, 'dist-pkg', 'cli');

function log(msg) {
  process.stdout.write(`[smoke-cli] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[smoke-cli] FAIL: ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
}

if (!existsSync(join(pkgDir, 'package.json'))) {
  fail(`${pkgDir} not built — run \`pnpm run build:cli-pkg\` first`);
}

// Expected version is whatever the built package declares — the smoke gate
// must track the release version, not a hardcoded constant.
const expectedVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;

// Temp workspace OUTSIDE the repo (OS temp dir), so nothing resolves against
// the monorepo node_modules.
const work = mkdtempSync(join(tmpdir(), 'iap-smoke-'));
log(`temp workspace: ${work}`);

let iap;
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
  // Minimal package.json so npm treats it as a project root (stops upward
  // traversal for node_modules).
  execFileSync('npm', ['init', '-y'], { cwd: proj, stdio: 'ignore' });
  log('npm install <tarball> …');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: proj,
    stdio: 'inherit',
  });

  iap = join(proj, 'node_modules', '.bin', 'iap');
  if (!existsSync(iap)) fail('installed bin node_modules/.bin/iap not found');

  const run = (args, opts = {}) =>
    execFileSync(iap, args, { cwd: proj, encoding: 'utf8', ...opts });

  /* 3a. --version */
  const version = run(['--version']).trim();
  log(`iap --version → ${version}`);
  if (!version.includes(expectedVersion))
    fail(`--version did not report ${expectedVersion}: "${version}"`);

  /* 3b. init → starter doc */
  run(['init']);
  const starter = join(proj, 'infrastructure.iap.yaml');
  if (!existsSync(starter)) fail('iap init did not write infrastructure.iap.yaml');
  log('iap init → infrastructure.iap.yaml written');

  /* Bring in a real example doc + the bare AWS mapping. */
  execFileSync('cp', [join(repoRoot, 'spec/examples/basic-webapp.iap.yaml'), proj]);
  execFileSync('cp', [join(repoRoot, 'providers/aws/mappings/core.iap-map.yaml'), proj]);

  /* 3c. validate a valid doc → exit 0 */
  run(['validate', '-f', 'basic-webapp.iap.yaml']);
  log('iap validate → exit 0');

  /* 3d. plan --output json → planId sha256:…, deterministic across two runs */
  const planArgs = [
    'plan',
    '-f',
    'basic-webapp.iap.yaml',
    '--mapping',
    'core.iap-map.yaml',
    '--profile',
    'production',
    '--output',
    'json',
  ];
  const plan1 = JSON.parse(run(planArgs));
  const plan2 = JSON.parse(run(planArgs));
  if (typeof plan1.planId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(plan1.planId)) {
    fail(`plan planId not of form sha256:<hex>: ${JSON.stringify(plan1.planId)}`);
  }
  if (plan1.planId !== plan2.planId) {
    fail(`plan is non-deterministic: ${plan1.planId} !== ${plan2.planId}`);
  }
  log(`iap plan → planId ${plan1.planId}`);
  log('iap plan → deterministic (identical planId across two runs)');

  log('PASS — clean install + plan-preview workflow verified');
} finally {
  rmSync(work, { recursive: true, force: true });
  log(`cleaned up ${work}`);
}
