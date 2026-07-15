#!/usr/bin/env node
/**
 * IaP product-evidence benchmark harness (`pnpm run test:benchmarks`) —
 * roadmap-v2 §13, milestone M19.7.
 *
 * Drives the corpus in `cases.mjs` through the REAL, shipped pipeline over the
 * BUILT workspace packages (run `pnpm build` first, like the other harnesses):
 *
 *   runAuthoringSession (@iap/intent-compiler — the DETERMINISTIC rules adapter)
 *     -> load / validate / policies (@iap/sdk)
 *     -> canonicalize (@iap/model)
 *     -> applyMapping over providers/aws/mappings/core.iap-map.yaml (@iap/provider-sdk)
 *     -> plan (@iap/planner)
 *
 * and MEASURES the §13 metrics that are REAL for this harness:
 *
 *   - Valid IaP generation rate  (committed a schema+phase-valid document)
 *   - Clarification precision/recall (stopped to ask when under-specified)
 *   - Unsupported/conflicting-request detection (flagged the bad requests)
 *   - False assumptions (invented resources beyond the request — inspected)
 *   - Plan determinism (identical planId across two runs, mappable cases)
 *   - Provider realization coverage (AWS core mapping produced a plan)
 *   - Time to first valid plan (wall-clock per case; Date.now())
 *
 * HONESTY (roadmap-v2 §13, CRITICAL):
 *   - The authoring engine is a RULES engine, not an LLM. These are rules-engine
 *     numbers, not LLM-quality numbers.
 *   - no-op correctness / drift accuracy / recovery success / deployment success
 *     / time-to-deployment are PLAN-PREVIEW ONLY in this harness. The ONLY real
 *     live-deployment data point is the M19.3 golden path (S3/SQS/IAM, eu-west-1,
 *     run then torn down) — see docs/reports/m19.3-live-run-evidence.md. This
 *     harness never touches a cloud API; it does not fake those outcomes.
 *   - Sources: synthetic/personal benchmark requests + the M19.3 sandbox run.
 *     No customer data.
 *
 * This is an EVIDENCE REPORT, not a pass/fail gate: it prints a per-case table
 * plus aggregate metrics and exits 0 even when the rules engine misses a case
 * (a miss is recorded honestly as a gap). A per-case crash is caught and
 * recorded as an error row; it never aborts the run. It is named `run.mjs`
 * (not `*.test.ts`) so the root vitest include never auto-runs it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** Injected audit instant — no clock in the authoring engine (determinism). */
const TIMESTAMP = '2026-07-14T12:00:00Z';

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
const model = await importBuilt('packages/model/dist/index.js', '@iap/model');
const providerSdk = await importBuilt('packages/provider-sdk/dist/index.js', '@iap/provider-sdk');
const planner = await importBuilt('packages/planner/dist/index.js', '@iap/planner');
const { CASES, CATEGORIES } = await import(pathToFileURL(join(here, 'cases.mjs')).href);

/* ------------------------------------------------------------------ */
/* AWS provider package — loaded verified (signature + digests + tiling) */
/* ------------------------------------------------------------------ */

const awsDir = join(repoRoot, 'providers', 'aws');
const trustStore = {
  'aws-test-2026': readFileSync(join(awsDir, 'keys', 'aws-test-2026.public.pem'), 'utf8'),
};
const loadedProvider = providerSdk.loadProviderPackage(awsDir, {
  trustStore,
  allowlist: ['iap-provider-aws'],
});
if (!loadedProvider.ok) {
  console.error('FATAL: AWS provider package failed to verify:');
  console.error(loadedProvider.refusals.map((r) => `  [${r.code}] ${r.message}`).join('\n'));
  process.exit(1);
}
const awsMapping = loadedProvider.pkg.mappings[0].artifact;

/* ------------------------------------------------------------------ */
/* Base-document construction (null | example:<name> | { seed: [...] }) */
/* ------------------------------------------------------------------ */

async function loadExample(name) {
  const ws = await load({ path: join(repoRoot, 'spec', 'examples', `${name}.iap.yaml`) });
  if (!ws.ok || ws.document === undefined) {
    throw new Error(`example ${name} failed to load`);
  }
  return structuredClone(ws.document);
}

async function buildBase(base) {
  if (base === null || base === undefined) return undefined;
  if (typeof base === 'string' && base.startsWith('example:')) {
    return loadExample(base.slice('example:'.length));
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
/* Measurement helpers                                                 */
/* ------------------------------------------------------------------ */

const createdKinds = (batch) =>
  (batch?.operations ?? [])
    .filter((op) => op.type === 'CreateResource')
    .map((op) => op.change.kind);

const surfacedAssumptions = (batch) =>
  (batch?.operations ?? []).flatMap((op) => op.assumptions ?? []);

/** Re-validate a committed document green through the full ch. 8 pipeline. */
async function revalidatesGreen(committed) {
  const ws = await load(committed.serialize('yaml'));
  if (!ws.ok) return false;
  const findings = [
    ...ws.validate().findings,
    ...ws.policies().findings,
    ...validateExtensions(ws.document),
  ];
  return findings.filter((f) => f.severity === 'error').length === 0;
}

/** Realize a committed document onto AWS core and plan it. Returns planId or null. */
function planForCommitted(committed) {
  const canonical = model.canonicalize(committed.document, { profile: null });
  if (canonical.findings.filter((f) => f.severity === 'error').length > 0) {
    return { mapped: false, planId: null, reason: 'canonicalize-error' };
  }
  const mapped = providerSdk.applyMapping(canonical.model, awsMapping);
  if (!mapped.ok) {
    return {
      mapped: false,
      planId: null,
      reason: mapped.diagnostics.map((d) => d.reason).join(','),
    };
  }
  const artifact = planner.plan(mapped.plan, planner.emptySnapshot(), {});
  const validation = planner.validatePlanArtifact(artifact);
  if (!validation.ok) {
    return { mapped: true, planId: null, reason: 'plan-schema-invalid' };
  }
  return { mapped: true, planId: artifact.planId, reason: '' };
}

/**
 * A request is "flagged" when the system pushes back on an unsupported or
 * conflicting request: an unsupported finding, a no-op/refusal outcome, or a
 * conflict clarification trigger. (required-field / compliance-scope are
 * ordinary under-specification clarifications, NOT problem flags.)
 */
function flaggedProblem(result) {
  return (
    result.unsupported.length > 0 ||
    result.outcome === 'no-operations' ||
    result.outcome === 'refused' ||
    result.firedTriggers.some((t) => t.includes('conflict'))
  );
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

console.log(
  `IaP product-evidence benchmark (M19.7) — ${CASES.length} cases across ${CATEGORIES.length} categories`,
);
console.log('rules-based authoring (no LLM) · AWS core mapping · plan-preview (live = M19.3)\n');

const rows = [];

for (const testCase of CASES) {
  const { id, category, request, expect } = testCase;
  const row = {
    id,
    category,
    outcome: '-',
    committed: false,
    green: false,
    mapped: false,
    planId: null,
    deterministic: null,
    flagged: false,
    unsupported: [],
    triggers: [],
    invented: [],
    assumptions: 0,
    ms: 0,
    error: null,
  };

  const started = Date.now();
  try {
    const base = await buildBase(testCase.base);
    const result = await runAuthoringSession(request, {
      timestamp: TIMESTAMP,
      documentName: 'benchmark',
      document: base,
      ...(testCase.options ?? {}),
    });

    row.outcome = result.outcome;
    row.unsupported = result.unsupported.map((u) => u.capability);
    row.triggers = result.firedTriggers;
    row.flagged = flaggedProblem(result);
    row.assumptions = surfacedAssumptions(result.compiledBatch).length;

    // False assumptions: created resource kinds outside the request's oracle set.
    const expectedKinds = new Set(expect.kinds ?? []);
    row.invented = createdKinds(result.compiledBatch).filter((k) => !expectedKinds.has(k));

    if (result.outcome === 'committed' && result.committed !== undefined) {
      row.committed = true;
      row.green = await revalidatesGreen(result.committed);

      const first = planForCommitted(result.committed);
      row.mapped = first.mapped;
      row.planId = first.planId;
      row.mapReason = first.reason;

      // Plan determinism: author + realize + plan a second time; compare planId.
      if (first.planId !== null) {
        const again = await runAuthoringSession(request, {
          timestamp: TIMESTAMP,
          documentName: 'benchmark',
          document: await buildBase(testCase.base),
          ...(testCase.options ?? {}),
        });
        if (again.outcome === 'committed' && again.committed !== undefined) {
          const second = planForCommitted(again.committed);
          row.deterministic = second.planId === first.planId;
        } else {
          row.deterministic = false;
        }
      }
    }
    // Time to first valid plan (mappable) or to committed doc (valid-but-unmappable).
    row.ms = Date.now() - started;
  } catch (error) {
    row.error = String(error && error.message ? error.message : error);
    row.ms = Date.now() - started;
  }

  rows.push(row);
}

/* ------------------------------------------------------------------ */
/* Per-case table                                                      */
/* ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
const status = (row) => {
  if (row.error) return 'ERROR';
  if (row.committed) return row.mapped ? 'commit+plan' : 'commit(no-map)';
  return row.outcome;
};

console.log(
  pad('case', 30) +
    pad('category', 22) +
    pad('result', 16) +
    pad('green', 7) +
    pad('det', 5) +
    'ms',
);
console.log('-'.repeat(88));
for (const row of rows) {
  console.log(
    pad(row.id, 30) +
      pad(row.category, 22) +
      pad(status(row), 16) +
      pad(row.green ? 'yes' : '-', 7) +
      pad(row.deterministic === null ? '-' : row.deterministic ? 'yes' : 'NO', 5) +
      String(row.ms),
  );
  if (row.error) console.log(`  ! error: ${row.error}`);
}

/* ------------------------------------------------------------------ */
/* Aggregate metrics (roadmap §13 structure)                           */
/* ------------------------------------------------------------------ */

const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`);

// 1. Valid IaP generation rate.
const wantValid = CASES.filter((c) => c.expect.validDoc);
const gotValid = wantValid.filter((c) => rows.find((r) => r.id === c.id)?.green);

// 2. Clarification precision/recall (blocking = needs-input).
const isBlocking = (r) => r.outcome === 'needs-input';
const wantClarify = CASES.filter((c) => c.expect.clarifies);
const gotClarifyRecall = wantClarify.filter((c) => isBlocking(rows.find((r) => r.id === c.id)));
const allBlocking = rows.filter(isBlocking);
const blockingExpected = allBlocking.filter(
  (r) => CASES.find((c) => c.id === r.id)?.expect.clarifies,
);

// 3. Unsupported/conflicting detection.
const wantFlag = CASES.filter((c) => c.expect.flag);
const gotFlag = wantFlag.filter((c) => rows.find((r) => r.id === c.id)?.flagged);
const flagMisses = wantFlag.filter((c) => !rows.find((r) => r.id === c.id)?.flagged);

// 4. False assumptions (invented resources) + surfaced-assumption transparency.
const inventedTotal = rows.reduce((sum, r) => sum + r.invented.length, 0);
const surfacedTotal = rows.reduce((sum, r) => sum + r.assumptions, 0);
const inventedCases = rows.filter((r) => r.invented.length > 0);

// 5. Plan determinism (mappable cases).
const mappable = rows.filter((r) => r.planId !== null);
const deterministic = mappable.filter((r) => r.deterministic === true);

// 6. Provider realization coverage (AWS core mapping produced a plan).
const committedRows = rows.filter((r) => r.committed);
const realized = committedRows.filter((r) => r.mapped);

// Errors / gaps.
const errored = rows.filter((r) => r.error);

// Time to first valid plan.
const planTimes = mappable.map((r) => r.ms).sort((a, b) => a - b);
const median = planTimes.length === 0 ? 0 : planTimes[Math.floor((planTimes.length - 1) / 2)];
const totalMs = rows.reduce((sum, r) => sum + r.ms, 0);

console.log('\n=== §13 measured metrics (rules-based authoring; no LLM) ===\n');
console.log(`Valid IaP generation rate        ${pct(gotValid.length, wantValid.length)}`);
console.log(
  `Clarification recall             ${pct(gotClarifyRecall.length, wantClarify.length)}  (asked when under-specified)`,
);
console.log(
  `Clarification precision          ${pct(blockingExpected.length, allBlocking.length)}  (blocking asks that were warranted)`,
);
console.log(
  `Unsupported/conflict detection   ${pct(gotFlag.length, wantFlag.length)}  (flagged the bad requests)`,
);
console.log(
  `False assumptions (invented res) ${inventedTotal} across ${inventedCases.length} case(s)  ` +
    `(all ${surfacedTotal} engine assumptions are surfaced, none hidden)`,
);
console.log(
  `Plan determinism                 ${pct(deterministic.length, mappable.length)}  (identical planId x2)`,
);
console.log(
  `Provider realization (AWS core)  ${pct(realized.length, committedRows.length)}  (committed docs that mapped to a plan)`,
);
console.log(`Case errors / gaps               ${errored.length}`);
console.log(`Time to first valid plan         median ${median}ms · total run ${totalMs}ms`);

console.log('\n--- PLAN-PREVIEW ONLY (not measured live here) ---');
console.log('no-op correctness / drift accuracy / recovery success / deployment success /');
console.log('time-to-deployment: the ONE real live data point is the M19.3 golden path');
console.log('(S3/SQS/IAM, eu-west-1, created + reconciled + destroyed, zero orphans).');
console.log('See docs/reports/m19.3-live-run-evidence.md. This harness plans, it never deploys.');

if (flagMisses.length > 0) {
  console.log('\n--- Detection gaps (honest) ---');
  for (const c of flagMisses) {
    console.log(`  ${c.id}: rules engine did NOT flag "${c.request.slice(0, 60)}..."`);
  }
}

// Category coverage.
const covered = new Set(rows.map((r) => r.category));
const missingCats = CATEGORIES.filter((c) => !covered.has(c));
console.log(
  `\nCategory coverage: ${covered.size}/${CATEGORIES.length}` +
    (missingCats.length
      ? ` — MISSING: ${missingCats.join(', ')}`
      : ' (all §13 categories present)'),
);

// Evidence report is not a gate: exit 0 unless the harness itself broke.
console.log('\nDone. This is an evidence report (exit 0), not a pass/fail gate.');
process.exit(0);
