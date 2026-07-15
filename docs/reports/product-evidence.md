# IaP Product Evidence — Benchmark Validation (M19.7)

**Milestone:** Phase 19 · M19.7 — Product evidence and benchmark validation (roadmap-v2 §13).
**Harness:** `tests/benchmarks/` (`pnpm run test:benchmarks`).
**Run date:** 2026-07-14 · **Corpus:** 26 synthetic benchmark requests across all 16 §13 categories.
**Status:** measured, reproducible, exits 0.

## What this evidence is — and is not

- **Real, reproducible measurement.** Every number below comes from running the shipped pipeline
  over the 26-request corpus in `tests/benchmarks/cases.mjs`. The harness drives the actual
  packages — no mock authoring, no hand-tuned outputs:

  ```
  runAuthoringSession (@iap/intent-compiler)
    → load / validate / policies (@iap/sdk)
    → canonicalize (@iap/model)
    → applyMapping over providers/aws/mappings/core.iap-map.yaml (@iap/provider-sdk)
    → plan (@iap/planner)
  ```

- **Authoring is a deterministic RULES engine, not an LLM.** The in-tree adapter
  (`rulesAdapter`) extracts intent by rule, with no model call and no clock. Every number here is
  a **rules-engine** number. These are **not** LLM-quality generation figures and must not be read
  as such.

- **Deployment is plan-preview only, with one real live data point.** This harness never calls a
  cloud API. It plans; it does not deploy. The **only** genuine live-deployment evidence is the
  **M19.3 golden path** — real S3/SQS/IAM resources created, reconciled, and destroyed in
  `eu-west-1`, zero orphans — recorded in
  [`docs/reports/m19.3-live-run-evidence.md`](./m19.3-live-run-evidence.md). No-op correctness,
  drift accuracy, recovery success, deployment success, and time-to-deployment are cited from that
  run, not fabricated here.

- **Sources.** Synthetic/personal benchmark requests authored from the §13 category list, plus the
  M19.3 sandbox run. **No customer data, no adoption numbers, no invented outcomes.**

## Corpus coverage (all 16 §13 categories)

| Category             | Cases | Category             | Cases |
| -------------------- | ----- | -------------------- | ----- |
| Web applications     | 2     | Security             | 1     |
| Internal APIs        | 2     | Compliance           | 2     |
| Event-driven systems | 2     | Incremental updates  | 2     |
| Serverless workloads | 1     | Removal              | 2     |
| Databases            | 1     | Drift reconciliation | 1     |
| Caches               | 1     | Unsupported          | 3     |
| Private services     | 1     | Conflicting          | 3     |
| High availability    | 1     | Budget               | 1     |

26 cases total (> 20 required). The unsupported and conflicting buckets deliberately include
requests the system should refuse or question: `Deploy to Azure…`, `A blockchain validator node`,
`a vpn and a dynamodb table`, `public but must be fully private`, and `cheapest possible with
5-region active-active HA`.

## Measured results (§13 metric list)

| §13 metric                        | Result                     | Notes                                                                                                                                                             |
| --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Valid IaP generation**          | **100% (17/17)**           | Of cases that should commit, all produced a schema+phase-valid doc that re-validates green.                                                                       |
| **Clarification precision**       | **100% (3/3)**             | Every blocking `needs-input` ask was warranted — no spurious asks.                                                                                                |
| Clarification recall              | **100% (3/3)**             | The engine stopped to ask on all three genuinely under-specified requests.                                                                                        |
| **Unsupported-request detection** | **57.1% (4/7)**            | Detected: blockchain, vpn+dynamodb, budget-vs-HA conflict, and the dangling-output removal. **Missed: 3** (see gaps).                                             |
| **False assumptions**             | **0 invented resources**   | No case created a resource the request did not imply. The 1 default the engine did choose (a cache engine) is **surfaced** as an explicit assumption, not hidden. |
| **Manual corrections**            | not measured               | Requires human-in-the-loop authoring; out of scope for an automated harness. Stated honestly rather than estimated.                                               |
| **Plan determinism**              | **100% (19/19)**           | Every mappable case produced a byte-identical `planId` across two independent runs.                                                                               |
| **Deployment success**            | plan-preview → **M19.3**   | Live create succeeded once (S3/SQS/IAM). Everything else is plan-only.                                                                                            |
| **No-op correctness**             | plan-preview → **M19.3**   | Live no-op verified once (idempotent re-run). Not re-measured live here.                                                                                          |
| **Drift accuracy**                | plan-preview → **M19.3**   | Live out-of-band drift detected once. Not re-measured live here.                                                                                                  |
| **Recovery success**              | plan-preview → **M19.3**   | Live partial-failure recovery verified once. Not re-measured live here.                                                                                           |
| **Time to first valid plan**      | **median 45 ms**           | Per case, NL request → committed doc → AWS realization → plan. Full 26-case run ≈ 1.2 s.                                                                          |
| **Time to deployment**            | → **M19.3** (single point) | Live deployment timing exists only for the one golden-path run.                                                                                                   |

Additional coverage signal measured by the harness:

- **Provider realization (AWS core): 95% (19/20).** Of the 20 committed documents, 19 mapped
  cleanly through `providers/aws/mappings/core.iap-map.yaml` to a valid plan. The one that did not
  is the serverless image-resizer: it produces a **valid IaP document** with a `Function` resource,
  which the AWS **core** mapping does not yet cover (`unsupported-kind`). This is an honest
  provider-coverage gap, not an authoring failure.

## What the rules-based authoring actually achieves

Across the 26 requests the deterministic rules engine:

- **Authored valid, deterministic infrastructure** for every well-formed request — web apps,
  internal APIs with databases, event-driven queues, caches, object stores, workload identities,
  and HA databases — each producing a document that re-validates green and plans to a stable
  `planId`.
- **Asked instead of guessing** on under-specified input (`We need an internal API`,
  `must be HIPAA compliant`) — 3/3 recall, 3/3 precision, no false clarifications.
- **Failed closed on destructive intent.** `Remove the orders-db` on `basic-webapp` was **refused**
  because outputs still reference it (IAP203); `Remove the db` committed only with explicit
  destructive acknowledgment.
- **Invented nothing.** Zero unrequested resources across all committed cases; the single default
  it chose is surfaced as an explicit assumption.
- **Planned deterministically.** 19/19 mappable cases yielded identical `planId` on repeat runs.

## Honest gaps and limitations

1. **Unsupported/conflicting detection is partial (4/7).** The rules engine flags requests by
   keyword/capability (blockchain, dynamodb, vpn) and detects the cost-vs-HA conflict via a
   clarification trigger, but it **misses semantic contradictions it has no rule for**:
   - `Deploy to Azure…` — the unsupported target is **not** flagged; the engine authors the
     provider-neutral `Service` and ignores the target term.
   - `public … but fully private` — the public/private contradiction is **not** detected; it commits.
   - `cheapest possible with 5-region active-active HA` — the cost/HA contradiction is **not**
     detected; it commits.
     These are exactly the kind of open-ended semantic checks a rules engine is weakest at, and are
     reported by the harness as detection gaps.

2. **No LLM authoring numbers.** All figures are for the deterministic rules adapter. No
   LLM-generation quality is claimed or measured.

3. **Deployment measured live exactly once.** Only the M19.3 S3/SQS/IAM golden path is real live
   evidence. AWS provider coverage is narrow (core kinds; no `Function`/Lambda in the core
   mapping). Everything deployment-shaped in this harness is plan-preview.

4. **Manual-correction rate not measured** (needs human authoring sessions).

5. **No customer/adoption data.** Synthetic and personal requests plus one sandbox run only.

## Reproduce

```bash
pnpm build            # harness runs against built dist/, like the other suites
pnpm run test:benchmarks
```

The harness prints a per-case table and the aggregate metrics above, then exits 0. It is an
evidence report, not a pass/fail gate: a detection miss is recorded as a gap, and a per-case error
is captured as an error row rather than aborting the run.
