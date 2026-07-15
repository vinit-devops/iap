#!/usr/bin/env node
/**
 * Intent-compiler evaluation benchmark (`pnpm run test:eval`) — roadmap §3.7.
 *
 * Runs the shipped `runAuthoringSession` (the M3.5 natural-language authoring
 * prototype) over the curated `dataset.mjs` corpus, which spans the eleven
 * §3.7 requirement categories, and scores the eight §3.7 measures against the
 * dataset's ORACLE expectations (authored from request semantics, not from the
 * implementation):
 *
 *   1. Correct resource extraction       (multiset precision/recall/F1)
 *   2. Correct relationship extraction   (set precision/recall/F1)
 *   3. Clarification precision           (fired vs expected triggers)
 *   4. Unsupported-feature detection     (set precision/recall/F1)
 *   5. False assumptions                 (count outside the allowed set; want 0)
 *   6. IaP validity                      (committed doc re-validates green)
 *   7. Semantic equivalence              (serialized bytes round-trip to the
 *                                         same canonical hash)
 *   8. Deterministic serialization       (same request twice → identical bytes)
 *
 * Runs against the BUILT packages (run `pnpm build` first, like the other
 * harnesses). It is BOTH a measurement instrument — it prints per-category and
 * overall precision/recall/F1 — and a conformance gate: every case must meet
 * its oracle exactly, so any regression in extraction, clarification, or
 * determinism turns the run red.
 *
 * Exit code 0 = all green; 1 = any case missed its expectation.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

async function importBuilt(relative, label) {
  try {
    return await import(pathToFileURL(join(repoRoot, relative)).href);
  } catch (error) {
    console.error(
      `FATAL: could not import built ${label} (${relative}). Run \`pnpm build\` first.`,
    );
    console.error(String(error));
    process.exit(1);
  }
}

const { runAuthoringSession } = await importBuilt(
  'packages/intent-compiler/dist/index.js',
  '@iap/intent-compiler',
);
const { load, validateExtensions } = await importBuilt('packages/sdk/dist/index.js', '@iap/sdk');
const { CASES, CATEGORIES } = await import(pathToFileURL(join(here, 'dataset.mjs')).href);

const TIMESTAMP = '2026-07-11T12:00:00Z';

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

/* ------------------------------------------------------------------ */
/* Signal extraction from a session result                            */
/* ------------------------------------------------------------------ */

const createdKinds = (batch) =>
  (batch?.operations ?? [])
    .filter((op) => op.type === 'CreateResource')
    .map((op) => op.change.kind);

const createdRelationships = (batch) =>
  (batch?.operations ?? [])
    .filter((op) => op.type === 'CreateRelationship')
    .map((op) => `${op.target.resourceId}-${op.change.type}->${op.change.target}`);

const assumptionFields = (batch) =>
  (batch?.operations ?? []).flatMap((op) =>
    op.assumptions.map((a) => `${op.target.resourceId ?? op.operationId}.${a.field}`),
  );

/* ------------------------------------------------------------------ */
/* Scoring primitives                                                 */
/* ------------------------------------------------------------------ */

/** Precision/recall/F1 over two multisets (arrays; repeats count). */
function prf(expected, actual) {
  const count = (arr) => {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const exp = count(expected);
  const act = count(actual);
  let tp = 0;
  for (const [k, n] of exp) tp += Math.min(n, act.get(k) ?? 0);
  const fp = actual.length - tp;
  const fn = expected.length - tp;
  // Empty-vs-empty is a perfect (vacuous) match.
  const precision = actual.length === 0 ? (expected.length === 0 ? 1 : 0) : tp / actual.length;
  const recall = expected.length === 0 ? (actual.length === 0 ? 1 : 0) : tp / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

/** Running accumulator for aggregate precision/recall/F1. */
function newAcc() {
  return { tp: 0, fp: 0, fn: 0 };
}
function addAcc(acc, r) {
  acc.tp += r.tp;
  acc.fp += r.fp;
  acc.fn += r.fn;
}
function accPrf(acc) {
  const precision = acc.tp + acc.fp === 0 ? 1 : acc.tp / (acc.tp + acc.fp);
  const recall = acc.tp + acc.fn === 0 ? 1 : acc.tp / (acc.tp + acc.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/* ------------------------------------------------------------------ */
/* Base-document construction                                          */
/* ------------------------------------------------------------------ */

async function loadExampleDoc(name) {
  const ws = await load({ path: join(repoRoot, 'spec', 'examples', `${name}.iap.yaml`) });
  if (!ws.ok || ws.document === undefined) {
    throw new Error(`example ${name} failed to load`);
  }
  return structuredClone(ws.document);
}

async function buildBase(base) {
  if (base === null || base === undefined) return undefined;
  if (typeof base === 'string' && base.startsWith('example:')) {
    return loadExampleDoc(base.slice('example:'.length));
  }
  if (typeof base === 'object' && Array.isArray(base.seed)) {
    let doc;
    for (const request of base.seed) {
      const seeded = await runAuthoringSession(request, {
        timestamp: TIMESTAMP,
        documentName: 'seed',
        document: doc,
        autoAnswerDefaults: true,
      });
      if (seeded.outcome !== 'committed' || seeded.committed === undefined) {
        throw new Error(`seed request did not commit: "${request}" (${seeded.outcome})`);
      }
      doc = structuredClone(seeded.committed.document);
    }
    return doc;
  }
  throw new Error(`unrecognized base spec: ${JSON.stringify(base)}`);
}

/* ------------------------------------------------------------------ */
/* Per-committed-case checks                                          */
/* ------------------------------------------------------------------ */

async function validityGreen(committed) {
  const ws = await load(committed.serialize('yaml'));
  if (!ws.ok) return false;
  const findings = [
    ...ws.validate().findings,
    ...ws.policies().findings,
    ...validateExtensions(ws.document),
  ];
  return findings.filter((f) => f.severity === 'error').length === 0;
}

async function semanticEquivalence(committed) {
  const ws = await load(committed.serialize('yaml'));
  return ws.ok && ws.canonical().hash === committed.canonicalHash;
}

/* ------------------------------------------------------------------ */
/* Run                                                                */
/* ------------------------------------------------------------------ */

const overall = {
  resources: newAcc(),
  relationships: newAcc(),
  clarification: newAcc(),
  unsupported: newAcc(),
};
const byCategory = new Map(CATEGORIES.map((c) => [c, { cases: 0, passed: 0 }]));
let falseAssumptionsTotal = 0;

console.log(
  `intent-compiler evaluation — ${CASES.length} cases across ${CATEGORIES.length} categories\n`,
);

for (const testCase of CASES) {
  const { id, category, input, expect } = testCase;
  const cat = byCategory.get(category);
  if (cat === undefined) {
    check(false, `${id} — unknown category ${category}`);
    continue;
  }
  cat.cases += 1;

  let result;
  let base;
  try {
    base = await buildBase(testCase.base);
    result = await runAuthoringSession(input, {
      timestamp: TIMESTAMP,
      documentName: 'demo',
      document: base,
      ...(testCase.options ?? {}),
    });
  } catch (error) {
    check(false, `${id} [${category}] — threw`, String(error));
    continue;
  }

  const casePassBefore = failures;

  // Outcome (hard gate).
  check(
    result.outcome === expect.outcome,
    `${id} — outcome ${result.outcome}`,
    `expected ${expect.outcome}`,
  );

  // 1. Resource extraction.
  const res = prf(expect.resources, createdKinds(result.compiledBatch));
  addAcc(overall.resources, res);
  check(
    res.f1 === 1,
    `${id} — resources F1=${res.f1.toFixed(2)}`,
    `got ${JSON.stringify(createdKinds(result.compiledBatch))}, want ${JSON.stringify(expect.resources)}`,
  );

  // 2. Relationship extraction.
  const rel = prf(expect.relationships, createdRelationships(result.compiledBatch));
  addAcc(overall.relationships, rel);
  check(
    rel.f1 === 1,
    `${id} — relationships F1=${rel.f1.toFixed(2)}`,
    `got ${JSON.stringify(createdRelationships(result.compiledBatch))}, want ${JSON.stringify(expect.relationships)}`,
  );

  // 3. Clarification precision.
  const clar = prf(expect.triggers, result.firedTriggers);
  addAcc(overall.clarification, clar);
  check(
    clar.f1 === 1,
    `${id} — clarification F1=${clar.f1.toFixed(2)}`,
    `fired ${JSON.stringify(result.firedTriggers)}, want ${JSON.stringify(expect.triggers)}`,
  );

  // 4. Unsupported-feature detection.
  const uns = prf(
    expect.unsupported,
    result.unsupported.map((u) => u.capability),
  );
  addAcc(overall.unsupported, uns);
  check(
    uns.f1 === 1,
    `${id} — unsupported F1=${uns.f1.toFixed(2)}`,
    `got ${JSON.stringify(result.unsupported.map((u) => u.capability))}, want ${JSON.stringify(expect.unsupported)}`,
  );

  // 5. False assumptions.
  const allowed = new Set(expect.allowedAssumptions ?? []);
  const falseAssumptions = assumptionFields(result.compiledBatch).filter((f) => !allowed.has(f));
  falseAssumptionsTotal += falseAssumptions.length;
  check(
    falseAssumptions.length === 0,
    `${id} — false assumptions ${falseAssumptions.length}`,
    JSON.stringify(falseAssumptions),
  );

  // 6/7/8. Validity, semantic equivalence, deterministic serialization (committed only).
  if (expect.outcome === 'committed') {
    if (result.committed === undefined) {
      check(false, `${id} — committed result present`);
    } else {
      check(await validityGreen(result.committed), `${id} — IaP validity (re-validates green)`);
      check(
        await semanticEquivalence(result.committed),
        `${id} — semantic equivalence (round-trip hash)`,
      );
      const again = await runAuthoringSession(input, {
        timestamp: TIMESTAMP,
        documentName: 'demo',
        document: await buildBase(testCase.base),
        ...(testCase.options ?? {}),
      });
      const deterministic =
        again.outcome === 'committed' &&
        again.committed !== undefined &&
        again.committed.serialize('yaml') === result.committed.serialize('yaml') &&
        again.committed.canonicalHash === result.committed.canonicalHash;
      check(deterministic, `${id} — deterministic serialization after confirmation`);
    }
  }

  if (failures === casePassBefore) cat.passed += 1;
}

/* ------------------------------------------------------------------ */
/* Scorecard                                                          */
/* ------------------------------------------------------------------ */

const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log('\n— §3.7 measures (aggregate over the corpus) —');
for (const [label, acc] of [
  ['resource extraction   ', overall.resources],
  ['relationship extraction', overall.relationships],
  ['clarification precision', overall.clarification],
  ['unsupported detection  ', overall.unsupported],
]) {
  const s = accPrf(acc);
  console.log(
    `  ${label}  P=${pct(s.precision)}  R=${pct(s.recall)}  F1=${pct(s.f1)}  (tp=${acc.tp} fp=${acc.fp} fn=${acc.fn})`,
  );
}
console.log(`  false assumptions        total=${falseAssumptionsTotal} (target 0)`);

console.log('\n— coverage by requirement category —');
for (const [category, stat] of byCategory) {
  console.log(`  ${category.padEnd(20)} ${stat.passed}/${stat.cases} cases pass`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks green`);
process.exit(failures === 0 ? 0 : 1);
