/**
 * demo-e2e.mjs — the FULL v0.1 plan-preview workflow against the PACKAGED CLI
 * (Phase 19, M19.4, artifact 6 + the M19.5 gate). Unlike smoke-cli.mjs (which
 * uses `iap init`), this exercises NATURAL-LANGUAGE authoring end to end:
 *
 *   install packaged iap → iap create "<NL>" → validate → cost → security →
 *   compliance → diagram → deterministic AWS plan preview
 *
 * using only `examples/iap-demo/` assets (request.txt + a bare AWS mapping),
 * proving an external clean environment can do the whole thing with no monorepo
 * source paths. Exits non-zero on any failure; always cleans up.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgDir = join(repoRoot, 'dist-pkg', 'cli');
const demoDir = join(repoRoot, 'examples', 'iap-demo');

function log(msg) {
  process.stdout.write(`[demo-e2e] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[demo-e2e] FAIL: ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
}

if (!existsSync(join(pkgDir, 'package.json'))) {
  fail(`${pkgDir} not built — run \`pnpm run build:cli-pkg\` first`);
}

const request = readFileSync(join(demoDir, 'request.txt'), 'utf8').trim();
const work = mkdtempSync(join(tmpdir(), 'iap-demo-'));
log(`temp workspace: ${work}`);

try {
  /* Install the packaged tarball into a fresh project outside the repo. */
  const packJson = execFileSync('npm', ['pack', '--json', `--pack-destination=${work}`], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  const tarball = join(work, JSON.parse(packJson)[0].filename);
  const proj = join(work, 'project');
  execFileSync('mkdir', ['-p', proj]);
  execFileSync('npm', ['init', '-y'], { cwd: proj, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: proj,
    stdio: 'inherit',
  });
  const iap = join(proj, 'node_modules', '.bin', 'iap');
  if (!existsSync(iap)) fail('installed bin node_modules/.bin/iap not found');

  /* Bring in ONLY the demo assets (no workspace paths). */
  execFileSync('cp', [join(demoDir, 'aws-core.iap-map.yaml'), proj]);

  const run = (args) => execFileSync(iap, args, { cwd: proj, encoding: 'utf8' });

  /* 1. Natural-language authoring (deterministic with a pinned timestamp). */
  run(['create', request, '--timestamp', '2026-07-12T00:00:00Z']);
  const doc = join(proj, 'infrastructure.iap.yaml');
  if (!existsSync(doc))
    fail('iap create did not write infrastructure.iap.yaml from the NL request');
  const authored = readFileSync(doc, 'utf8');
  if (!/apiVersion:\s*iap\.dev\/v1/.test(authored))
    fail('authored doc is not canonical iap.dev/v1');
  log('iap create "<natural language>" → valid infrastructure.iap.yaml');

  /* 2. Validate. */
  run(['validate', '-f', 'infrastructure.iap.yaml']);
  log('iap validate → exit 0');

  /* 3. Analyze — each must succeed and emit JSON where applicable. */
  JSON.parse(run(['cost', '-f', 'infrastructure.iap.yaml', '--output', 'json']));
  JSON.parse(run(['security', '-f', 'infrastructure.iap.yaml', '--output', 'json']));
  JSON.parse(run(['compliance', '-f', 'infrastructure.iap.yaml', '--output', 'json']));
  run(['diagram', '-f', 'infrastructure.iap.yaml', '--view', 'architecture']);
  log('iap cost / security / compliance / diagram → all exit 0');

  /* 4. Deterministic AWS plan preview (bare mapping artifact; twice → identical). */
  const planArgs = [
    'plan',
    '-f',
    'infrastructure.iap.yaml',
    '--mapping',
    'aws-core.iap-map.yaml',
    '--output',
    'json',
  ];
  const p1 = JSON.parse(run(planArgs));
  const p2 = JSON.parse(run(planArgs));
  if (typeof p1.planId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(p1.planId)) {
    fail(`plan planId not of form sha256:<hex>: ${JSON.stringify(p1.planId)}`);
  }
  if (p1.planId !== p2.planId) fail(`plan non-deterministic: ${p1.planId} !== ${p2.planId}`);
  log(`iap plan → deterministic AWS plan preview, planId ${p1.planId}`);

  log(
    'PASS — external clean install: NL → valid IaP → validate → analyze → deterministic AWS plan',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
  log(`cleaned up ${work}`);
}
