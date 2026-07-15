#!/usr/bin/env node
/**
 * Provider package conformance suite (`pnpm run test:providers`) — the
 * shared harness every provider package under `providers/` runs against
 * (IEP-0012; phase-6 design decision 8). Uses the built workspace packages:
 * run `pnpm build` first (same as run.mjs for the validator).
 *
 * Per discovered package (`providers/<name>/manifest.json`; packages without
 * a manifest are skipped with a note — siblings may be mid-build):
 *   1. PC-1 — `loadProviderPackage` with a trust store built from the
 *      package's committed `keys/*.public.pem` (keyId = filename stem) and
 *      an allowlist of exactly the manifest's name must succeed: signature,
 *      digest pinning, spec/sdk compatibility, and coverage tiling verify on
 *      every run.
 *   2. Negative checks via in-memory tampering (no files are ever written):
 *      a modified manifest field and a flipped artifact digest must fail
 *      signature verification (loader stage 3 refusal), and tampered
 *      artifact bytes must break their pinned digest (stage 4 refusal).
 *   3. PC-2 — every conformance case under the manifest's conformanceCases
 *      directory passes through the SDK evaluator, using the attestation
 *      registry exported by the package's built module
 *      (`providers/<name>/dist/index.js`; canonical export
 *      `createAttestationRegistry()`, any `create*Attestation*` factory or
 *      exported registry object is accepted).
 *   4. PC-3 — double-run hash equality per corpus document referenced by
 *      each case (byte-identical plans; deterministic diagnostics for
 *      rejected documents).
 *
 * Cross-target equivalence (phase 6 exit criterion 1): when BOTH
 * `providers/aws` and `providers/kubernetes` load, the shared corpus
 * document `spec/examples/basic-webapp.iap.yaml` (production profile) must
 * map cleanly through both packages — same intent, two independent
 * realizations. Skipped with a note while either package is absent.
 *
 * Exit code 0 = all green; 1 = any failure.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
const sdk = await importBuilt('packages/provider-sdk/dist/index.js', '@iap/provider-sdk');
const model = await importBuilt('packages/model/dist/index.js', '@iap/model');
const parser = await importBuilt('packages/parser/dist/index.js', '@iap/parser');
if (!sdk || !model || !parser) finish();
check(true, 'SDK, model, and parser build artifacts load');

/** All *.case.yaml files under a directory, as sorted relative paths. */
function findCaseFiles(dir, relative = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (entry.isDirectory()) {
      out.push(...findCaseFiles(join(dir, entry.name), `${relative}${entry.name}/`));
    } else if (entry.isFile() && entry.name.endsWith('.case.yaml')) {
      out.push(`${relative}${entry.name}`);
    }
  }
  return out;
}

/** Trust store from the package's committed public keys (keyId = filename stem). */
function buildTrustStore(packageDir) {
  const keysDir = join(packageDir, 'keys');
  if (!existsSync(keysDir)) return {};
  const store = {};
  for (const file of readdirSync(keysDir).sort()) {
    if (!file.endsWith('.public.pem')) continue;
    store[file.slice(0, -'.public.pem'.length)] = readFileSync(join(keysDir, file), 'utf8');
  }
  return store;
}

/** Resolve the attestation registry from a package's built module exports. */
function resolveAttestationRegistry(module) {
  const isRegistry = (value) => value !== null && typeof value?.lookup === 'function';
  for (const [name, value] of Object.entries(module)) {
    if (typeof value === 'function' && /^create.*attestation/i.test(name)) {
      const created = value();
      if (isRegistry(created)) return { registry: created, exportName: `${name}()` };
    }
  }
  for (const [name, value] of Object.entries(module)) {
    if (isRegistry(value)) return { registry: value, exportName: name };
  }
  return undefined;
}

/** Canonicalize one corpus document fresh (parse → conform → canonicalize). */
function canonicalizeCorpusDocument(corpusDir, documentPath, profile) {
  const text = readFileSync(join(corpusDir, documentPath), 'utf8');
  const parsed = parser.loadDocument(text, { filename: documentPath });
  if (!parsed.ok || parsed.document === undefined) {
    throw new Error(`corpus document ${documentPath} is not conforming`);
  }
  const canonical = model.canonicalize(parsed.document, { profile: profile ?? null });
  const errors = canonical.findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`canonicalization failed: ${errors.map((f) => f.code).join(', ')}`);
  }
  return canonical.model;
}

const providersDir = join(repoRoot, 'providers');
const packageNames = existsSync(providersDir)
  ? readdirSync(providersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

const loadedPackages = new Map(); // dir name → loaded package

for (const name of packageNames) {
  const packageDir = join(providersDir, name);
  if (!existsSync(join(packageDir, 'manifest.json'))) {
    console.log(`\nproviders/${name}`);
    console.log('  skip    no manifest.json yet (package mid-build) — not counted');
    continue;
  }
  console.log(`\nproviders/${name}`);

  // ---- PC-1: verified load with the package's own trust material --------
  const trustStore = buildTrustStore(packageDir);
  check(
    Object.keys(trustStore).length > 0,
    `trust store built from keys/*.public.pem (${Object.keys(trustStore).length} key(s))`,
    'no committed public keys found',
  );
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    check(false, 'manifest.json parses', e.message);
    continue;
  }
  const loadResult = sdk.loadProviderPackage(packageDir, {
    trustStore,
    allowlist: [manifest.name],
  });
  check(
    loadResult.ok,
    'loadProviderPackage verifies signature, digests, compat, and tiling (PC-1)',
    loadResult.ok ? '' : loadResult.refusals.map((r) => `[${r.code}] ${r.message}`).join('; '),
  );
  if (!loadResult.ok) continue;
  const pkg = loadResult.pkg;
  loadedPackages.set(name, pkg);

  // ---- Negative checks: in-memory tampering (never writes files) --------
  const cloneManifest = () => JSON.parse(JSON.stringify(manifest));
  const tamperedField = cloneManifest();
  tamperedField.version = manifest.version === '9.9.9' ? '9.9.8' : '9.9.9';
  check(
    !sdk.verifyManifestSignature(tamperedField, trustStore).ok,
    'a modified manifest field fails signature verification (in-memory tamper)',
  );

  const [artifactPath, pinnedDigest] = Object.entries(manifest.integrity.digests)[0] ?? [];
  if (artifactPath === undefined) {
    check(false, 'manifest pins at least one artifact digest');
  } else {
    const tamperedDigest = cloneManifest();
    const flipped = pinnedDigest.endsWith('0')
      ? `${pinnedDigest.slice(0, -1)}1`
      : `${pinnedDigest.slice(0, -1)}0`;
    tamperedDigest.integrity.digests[artifactPath] = flipped;
    check(
      !sdk.verifyManifestSignature(tamperedDigest, trustStore).ok,
      'a flipped artifact digest fails signature verification — load refused (in-memory tamper)',
    );
    const bytes = readFileSync(join(packageDir, artifactPath));
    const tamperedBytes = Uint8Array.from(bytes);
    tamperedBytes[0] ^= 0xff;
    check(
      sdk.computeArtifactDigest(bytes) === pinnedDigest &&
        sdk.computeArtifactDigest(tamperedBytes) !== pinnedDigest,
      `tampered artifact bytes break the pinned digest (${artifactPath})`,
    );
  }

  // ---- Attestation registry from the built package module ---------------
  const distPath = join(packageDir, 'dist', 'index.js');
  let packageModule;
  try {
    packageModule = await import(pathToFileURL(distPath).href);
  } catch (e) {
    check(false, `package module loads from dist/index.js (run \`pnpm build\` first)`, e.message);
    continue;
  }
  const resolved = resolveAttestationRegistry(packageModule);
  check(
    resolved !== undefined,
    resolved !== undefined
      ? `package module exports its attestation registry (${resolved.exportName})`
      : 'package module exports its attestation registry',
    'expected createAttestationRegistry() or an exported AttestationRegistry',
  );
  if (resolved === undefined) continue;

  // ---- PC-2: the package's full conformance corpus ----------------------
  const corpusDir = join(packageDir, manifest.artifacts.conformanceCases.replace(/\/$/, ''));
  const caseFiles =
    existsSync(corpusDir) && statSync(corpusDir).isDirectory() ? findCaseFiles(corpusDir) : [];
  check(caseFiles.length > 0, `conformance corpus contains cases (${caseFiles.length})`);
  if (pkg.mappings.length !== 1) {
    console.log(
      `  note    package ships ${pkg.mappings.length} mapping artifacts; cases run against the first`,
    );
  }
  const mapping = pkg.mappings[0]?.artifact;

  for (const caseFile of caseFiles) {
    let caseDoc;
    try {
      caseDoc = parse(readFileSync(join(corpusDir, caseFile), 'utf8'));
    } catch (e) {
      check(false, `case ${caseFile} parses`, e.message);
      continue;
    }
    let result;
    try {
      result = sdk.evaluateConformanceCase(caseDoc, {
        mapping,
        attestations: resolved.registry,
        corpusDir,
      });
    } catch (e) {
      check(false, `case ${caseFile} evaluates`, e.message);
      continue;
    }
    check(
      result.pass,
      `case ${result.case} passes (${result.assertions.length} assertions, PC-2)`,
      result.assertions
        .filter((a) => !a.pass)
        .map(
          (a) =>
            `${a.id}: expected ${a.expect}, got ${a.actual}${a.detail ? ` (${a.detail})` : ''}`,
        )
        .join('; '),
    );

    // ---- PC-3: double-run hash equality per referenced corpus document --
    const documents = [
      ...new Set([caseDoc.document, ...(caseDoc.assertions ?? []).map((a) => a.document)]),
    ].filter((doc) => doc !== undefined);
    for (const documentPath of documents) {
      try {
        const run = () => {
          const canonical = canonicalizeCorpusDocument(corpusDir, documentPath, caseDoc.profile);
          return sdk.applyMapping(canonical, mapping, {
            ...(caseDoc.mappingInputs !== undefined ? { inputs: caseDoc.mappingInputs } : {}),
          });
        };
        const first = run();
        const second = run();
        const equal =
          first.ok && second.ok
            ? first.plan.planHash === second.plan.planHash &&
              model.canonicalJsonStringify(first.plan) === model.canonicalJsonStringify(second.plan)
            : !first.ok &&
              !second.ok &&
              JSON.stringify(first.diagnostics) === JSON.stringify(second.diagnostics);
        check(
          equal,
          `double-run ${first.ok ? 'hash equality' : 'deterministic rejection'}: ${documentPath}${caseDoc.profile ? ` (profile ${caseDoc.profile})` : ''} (PC-3)`,
        );
      } catch (e) {
        check(false, `double-run hash equality: ${documentPath} (PC-3)`, e.message);
      }
    }
  }
}

// ---- Cross-target equivalence (phase 6 exit criterion 1) -----------------
console.log('\ncross-target equivalence');
const aws = loadedPackages.get('aws');
const kubernetes = loadedPackages.get('kubernetes');
if (aws === undefined || kubernetes === undefined) {
  console.log(
    '  skip    providers/aws and providers/kubernetes not both loadable yet (built concurrently) — not counted',
  );
} else {
  try {
    const text = readFileSync(join(repoRoot, 'spec/examples/basic-webapp.iap.yaml'), 'utf8');
    const parsed = parser.loadDocument(text, { filename: 'basic-webapp.iap.yaml' });
    if (!parsed.ok || parsed.document === undefined) throw new Error('basic-webapp not conforming');
    const canonical = model.canonicalize(parsed.document, { profile: 'production' });
    const errors = canonical.findings.filter((f) => f.severity === 'error');
    if (errors.length > 0) throw new Error(`canonicalization failed: ${errors[0].code}`);
    const plans = [];
    for (const [name, pkg] of [
      ['aws', aws],
      ['kubernetes', kubernetes],
    ]) {
      const result = sdk.applyMapping(canonical.model, pkg.mappings[0].artifact);
      check(
        result.ok && result.plan.resources.length > 0,
        `providers/${name} maps basic-webapp (production) cleanly${result.ok ? ` — ${result.plan.resources.length} plan resources` : ''}`,
        result.ok ? 'plan is empty' : result.diagnostics.map((d) => d.reason).join('; '),
      );
      if (result.ok) plans.push(result.plan);
    }
    check(
      plans.length === 2,
      'same document, two independent providers, zero diagnostics (exit criterion 1)',
    );
  } catch (e) {
    check(false, 'cross-target equivalence over basic-webapp', e.message);
  }
}

finish();
