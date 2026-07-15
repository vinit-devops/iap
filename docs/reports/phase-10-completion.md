# Phase 10 Completion Report — Cost Engine

**Date:** 2026-07-11 · **Milestones:** M10.1, M10.2
(`docs/milestones/M10.1-cost-model-snapshot.md`, `docs/milestones/M10.2-budget-provider-cost.md`)

Phase 10 delivers cost estimation and budget governance as a pure annotation layer over the
canonical model (spec ch. 16, IEP-0005): `@iap/cost` (engine, schemas, reference model +
snapshot, budget validation, cost-diff, suggestions), the mock provider cost model, and the
`iap cost` command. Cost is never document content; a report is a byte-reproducible function
of the canonical model, a cost model version, and a content-addressed price snapshot.

## Exit-criteria verification

| Exit criterion                                                         | Status   | Evidence                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported resources expose cost metadata                               | **Pass** | `estimateCost` produces a `cost-report/v1` entry for every resource with hourly/monthly estimates, currency, confidence, and assumptions; every official example yields a schema-valid report (`packages/cost/test/cost.test.ts`).                                                                                                                                                              |
| Missing price data is visible                                          | **Pass** | An uncovered kind OR a resource whose SKU is absent from the snapshot is reported `confidence: unknown` with NO numbers and a stated reason; roll-ups/totals that omit it are flagged `lowerBound: true` with weakest confidence — never a silent zero.                                                                                                                                         |
| Estimates are reproducible from stored pricing snapshots               | **Pass** | The engine is pure and clock/network-free; the snapshot (content address `id#sha256:<hex>`) is the only pricing input. Identical inputs yield byte-identical reports; the report records `modelHash` + `priceSnapshot` + `costModel` so any change is attributable to exactly one input (§16.9).                                                                                                |
| Budget violations can block planning or deployment according to policy | **Pass** | `evaluateBudgets` evaluates budget policies (deny/warn `greater-than` over `x-iap-cost.*`) at plan time and emits **IAP505** for exceeded deny budgets; `iap cost` exits **1** on any IAP505 error. Unknown-cost resources are reported unevaluable (warning), never passed; Application budgets evaluate the roll-up. (`packages/cost/test/budget.test.ts`, `packages/cli/test/cost.test.ts`.) |

## Deliverables checklist (roadmap Phase 10)

- **Cost model API** ✓ — `CostModel` interface + `estimateCost` engine (M10.1).
- **Provider cost adapters** ✓ — `mockCostModel` distributed with the mock mapping (M10.2); AWS/K8s follow the same shape.
- **Cost report** ✓ — `cost-report/v1` schema + `iap cost` human/JSON rendering.
- **Budget policies** ✓ — `evaluateBudgets` → IAP505 at plan time (M10.2).
- **Cost-diff integration** ✓ — `diffReports` + `iap cost --against`.
- **Price snapshot format** ✓ — `price-snapshot-v1`, content-addressed (M10.1).
- **Optimization suggestions** ✓ — deterministic `excess-availability` / `orphaned-resource` (M10.1).

## Verification state

Full `pnpm run verify` green: build (incl. `@iap/cost`), lint, unit tests (cost engine 20 +
budget 10 + mock cost 4 + CLI cost 6), spec harness (both cost schemas compile), provider
conformance, determinism, evaluation benchmark. `pnpm run format:check` clean.

## Notes and follow-ons

- Provider-distributed cost models for AWS/Kubernetes, and wiring `iap cost --mapping` to a
  package's cost model, follow the mock pattern.
- Carbon (`x-iap-carbon`, §16.6) and oversizing suggestions (needing a versioned observed-
  utilization input) are deferred with their inputs.
- Plan-artifact budget findings (where IAP505 lives in the plan) join when the planner
  consumes cost annotations (Phase 14 execution / IEP-0011 owns the plan surface).
