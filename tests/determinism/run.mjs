#!/usr/bin/env node
/**
 * Golden-plan determinism suite (`pnpm run test:determinism`) — PL-4 and the
 * ch. 24 §24.4 determinism procedure over the BUILT packages: run
 * `pnpm build` first (same as tests/conformance/run.mjs).
 *
 * For every official example in `spec/examples/` × the signed mock provider
 * package × `emptySnapshot()` × the pinned identity vector of
 * `manifest.json`:
 *
 *   1. **PL-4 golden bytes.** Build the plan through the real pipeline
 *      (loadDocument → canonicalize → applyMapping → plan) and byte-compare
 *      the canonical artifact serialization against the committed golden in
 *      `golden-plans/` (`<example>.plan.json` — exactly the canonical JSON
 *      bytes `canonicalPlanSerialization` + planId produce, wrapped in the
 *      artifact envelope-free form; no timestamps anywhere). An example the
 *      mock mapping deliberately rejects (see manifest.json) commits its
 *      deterministic diagnostic set as `<example>.rejection.json` instead.
 *   2. **PL-1 / §24.4 perturbed replay.** Re-run the whole pipeline with the
 *      environment perturbed (different TZ, locale, extra env var, different
 *      working directory — everything a pure function must ignore; the
 *      pipeline performs no network I/O, satisfying the network-disabled
 *      run vacuously) and byte-compare against run A. No tolerance band.
 *   3. **Exit criterion 2.** Re-plan from a key-shuffled re-serialization of
 *      the source document (every object key in reverse-sorted order) and
 *      assert the identical planId (identical rejection bytes for the
 *      rejection golden).
 *
 * Regeneration (intentional planner-behavior changes ONLY, in the same
 * reviewed change that bumps PLANNER_VERSION):
 *
 *   node tests/determinism/run.mjs --update
 *
 * Exit code 0 = all green; 1 = any byte difference.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const goldenDir = join(repoRoot, 'tests', 'determinism', 'golden-plans');
const update = process.argv.includes('--update');

let failures = 0;
let checks = 0;
function check(ok, label, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ok      ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL    ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function finish() {
  console.log(
    failures === 0
      ? `\nall ${checks} checks passed`
      : `\n${failures} failure(s) out of ${checks} checks`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

async function importBuilt(relative, label) {
  try {
    return await import(pathToFileURL(join(repoRoot, relative)).href);
  } catch (e) {
    check(false, `${label} build artifact loads (run \`pnpm build\` first)`, e.message);
    return undefined;
  }
}

console.log('harness');
const model = await importBuilt('packages/model/dist/index.js', '@iap/model');
const parser = await importBuilt('packages/parser/dist/index.js', '@iap/parser');
const sdk = await importBuilt('packages/provider-sdk/dist/index.js', '@iap/provider-sdk');
const planner = await importBuilt('packages/planner/dist/index.js', '@iap/planner');
if (!model || !parser || !sdk || !planner) finish();
check(true, 'model, parser, provider-sdk, and planner build artifacts load');

const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'determinism', 'manifest.json'), 'utf8'),
);

// The goldens plan over the VERIFIED mock package, not a raw file read: the
// mapping version identity comes from the signed manifest (PC-1 posture).
const packageDir = join(repoRoot, 'providers', manifest.provider);
const trustStore = {
  'mock-test-2026': readFileSync(join(packageDir, 'keys', 'mock-test-2026.public.pem'), 'utf8'),
};
const loaded = sdk.loadProviderPackage(packageDir, {
  trustStore,
  allowlist: ['iap-provider-mock'],
});
check(
  loaded.ok,
  `providers/${manifest.provider} loads verified (signature, digests, tiling)`,
  loaded.ok ? '' : loaded.refusals.map((r) => `[${r.code}] ${r.message}`).join('; '),
);
if (!loaded.ok) finish();
const mapping = loaded.pkg.mappings[0].artifact;

/** Recursively rebuild a JSON value with object keys in reverse-sorted order. */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === 'object' && value !== null) {
    const out = {};
    for (const key of Object.keys(value).sort().reverse()) out[key] = reverseKeys(value[key]);
    return out;
  }
  return value;
}

/** Identity 2: profile name → sha256 over the canonical serialization of its definition. */
function profileHashesFor(document, profile) {
  if (profile === null) return {};
  const definition = document?.profiles?.[profile];
  if (definition === undefined) throw new Error(`profile "${profile}" not found in document`);
  return { [profile]: planner.sha256Digest(model.canonicalJsonStringify(definition)) };
}

/**
 * The full deterministic pipeline over source text: parse → canonicalize
 * (pinned profile) → applyMapping (verified package) → plan (empty snapshot,
 * pinned identities). Returns { golden, planId } where golden is the exact
 * canonical byte string committed under golden-plans/.
 */
function runPipeline(text, filename, spec) {
  const parsed = parser.loadDocument(text, { filename });
  if (!parsed.ok || parsed.document === undefined) {
    throw new Error(`${filename} is not a conforming document`);
  }
  const profile = spec.profile ?? null;
  const canonical = model.canonicalize(parsed.document, { profile });
  const errors = canonical.findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`canonicalization failed: ${errors.map((f) => f.code).join(', ')}`);
  }
  const mapped = sdk.applyMapping(canonical.model, mapping);
  if (!mapped.ok) {
    if (spec.expect !== 'rejection') {
      throw new Error(
        `mapping rejected: ${mapped.diagnostics.map((d) => `${d.reason} ${d.resourceId ?? ''}`).join('; ')}`,
      );
    }
    return {
      golden: model.canonicalJsonStringify({ diagnostics: mapped.diagnostics }),
      planId: null,
    };
  }
  if (spec.expect === 'rejection') {
    throw new Error('manifest expects a rejection, but the mapping succeeded');
  }
  const artifact = planner.plan(mapped.plan, planner.emptySnapshot(), {
    ...manifest.identities,
    profileHashes: profileHashesFor(parsed.document, profile),
  });
  const validation = planner.validatePlanArtifact(artifact);
  if (!validation.ok) {
    throw new Error(`plan artifact schema-invalid: ${validation.errors.join('; ')}`);
  }
  return { golden: model.canonicalJsonStringify(artifact), planId: artifact.planId };
}

/** Run fn with the environment perturbed per §24.4, restoring it afterwards. */
function perturbed(fn) {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  try {
    process.env.TZ = 'Pacific/Kiritimati';
    process.env.LANG = 'C';
    process.env.LC_ALL = 'C';
    process.env.IAP_DETERMINISM_PERTURBATION = 'run-b';
    process.chdir(tmpdir());
    return fn();
  } finally {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
}

console.log('\ngolden plans (PL-4, §24.4)');
mkdirSync(goldenDir, { recursive: true });

for (const [name, spec] of Object.entries(manifest.examples)) {
  const filename = `${name}.iap.yaml`;
  const text = readFileSync(join(repoRoot, 'spec', 'examples', filename), 'utf8');
  const goldenPath = join(
    goldenDir,
    spec.expect === 'rejection' ? `${name}.rejection.json` : `${name}.plan.json`,
  );
  const kind = spec.expect === 'rejection' ? 'rejection' : 'plan';
  const profileLabel = spec.profile ? ` (profile ${spec.profile})` : ' (base document)';

  let runA;
  try {
    runA = runPipeline(text, filename, spec);
  } catch (e) {
    check(false, `${name}${profileLabel} plans through the pipeline`, e.message);
    continue;
  }

  if (update) {
    writeFileSync(goldenPath, runA.golden);
    console.log(`  update  wrote golden-plans/${name}.${kind}.json`);
  }

  if (!existsSync(goldenPath)) {
    check(false, `${name}: committed ${kind} golden exists`, 'run with --update to generate');
    continue;
  }
  const committed = readFileSync(goldenPath, 'utf8');
  check(
    committed === runA.golden,
    `${name}${profileLabel}: canonical ${kind} bytes match the committed golden (PL-4)`,
    committed === runA.golden
      ? ''
      : 'byte difference — intentional planner changes must regenerate goldens with --update in the same reviewed change',
  );

  // Run B: byte-identical replay under a perturbed environment (§24.4 —
  // different TZ, locale, env vars, and working directory; no tolerance).
  try {
    const runB = perturbed(() => runPipeline(text, filename, spec));
    check(
      runB.golden === runA.golden,
      `${name}: perturbed-environment replay is byte-identical (PL-1, CP-3)`,
    );
  } catch (e) {
    check(false, `${name}: perturbed-environment replay is byte-identical (PL-1, CP-3)`, e.message);
  }

  // Run C: a key-shuffled re-serialization of the document must yield the
  // identical planId (exit criterion 2 — independence from YAML ordering).
  try {
    const shuffledText = stringify(reverseKeys(parse(text)), { aliasDuplicateObjects: false });
    const runC = runPipeline(shuffledText, filename, spec);
    check(
      spec.expect === 'rejection'
        ? runC.golden === runA.golden
        : runC.planId === runA.planId && runC.golden === runA.golden,
      `${name}: key-shuffled document yields the identical ${spec.expect === 'rejection' ? 'rejection bytes' : 'planId'} (exit criterion 2)`,
    );
  } catch (e) {
    check(false, `${name}: key-shuffled document yields the identical planId`, e.message);
  }
}

finish();
