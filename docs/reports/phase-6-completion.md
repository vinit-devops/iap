# Phase 6 Completion Report — Provider Mapping and Plugin Framework

**Date:** 2026-07-11 · **Milestones:** M6.1–M6.5 (all completed with reviewable docs under `docs/milestones/`) · **Governing IEP:** IEP-0012 · **Design record:** `docs/architecture/phase-6-design.md`

## Exit criteria verification

| Exit criterion                                         | Status   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same IaP model maps to at least two targets            | **Pass** | The shared runner's cross-target check (`tests/conformance/providers.mjs`): the canonical `basic-webapp.iap.yaml` (production profile) maps through `providers/aws` into **12 plan resources** and through `providers/kubernetes` into **16 plan resources**, both with zero diagnostics — one document, two independent signed packages, structurally different realizations (RDS vs PostgresCluster, ELB+ACM vs Gateway API) honoring the same intent (ch. 12 §12.8).          |
| Unsupported intent fails explicitly                    | **Pass** | Fail-closed at three layers: engine diagnostics with the closed reason taxonomy (`unsupported-value spec.availability` for `maximum` on AWS/K8s Database, `unsupported-kind` for Function, exactly-once Queue delivery, memcached Cache, mysql on Kubernetes — per-package fail-closed test suites); `expect: rejected` conformance cases in every package (PC-2); and loader-time static tiling so a mapping with a derive-map gap or unbound output never loads at all (PC-1). |
| Every provider parameter is traceable                  | **Pass** | The engine attaches provenance (`constant` \| `from` \| `map` + source field + rule index) to every derived attribute; the AWS and Kubernetes acceptance tests assert **every** `desiredAttributes` entry across every plan resource carries a provenance record (`providers/*/test/webapp-acceptance.test.ts`); plan `inputs` are part of the hashed identity (ch. 12 §12.2).                                                                                                   |
| Provider packages cannot modify the original IaP model | **Pass** | The engine deep-freezes its input; mutation attempts throw. Non-interference tests in the SDK and in all three provider packages assert the canonical hash of the model is byte-identical before and after mapping (CM-6). Packages interact with the core only through the loader/engine — no hook can suppress or alter core findings (IEP-0012).                                                                                                                              |
| Plugin compatibility and signature checks enforced     | **Pass** | `loadProviderPackage` refuses on any of: signature mismatch (ed25519 over the canonical signing form), unknown keyId/trust store miss, allowlist miss, per-file digest mismatch, `specCompat`/`sdkCompat` range exclusion, mapping-schema invalidity, or coverage-tiling defect — no degraded load. Exercised by SDK loader tests and re-exercised live on every `pnpm run test:providers` run, including in-memory tamper refusals per package (PC-1).                          |

## Deliverables checklist (roadmap Phase 6)

Provider SDK ✓ (M6.1: `@iap/provider-sdk` — manifest, loader, signing, engine, evaluator) · Plugin manifest format ✓ (`plugin.iap.dev/v1`, `spec/schema/plugin-manifest-v1.schema.json`) · Plugin loader ✓ · Signature verification ✓ (ed25519 + digest pinning, zero new dependencies) · Mock provider ✓ (M6.2: execution-level, in-memory substrate, injectable failures, halt-wave/idempotence/secret-hygiene lifecycle suite) · Provider conformance suite ✓ (M6.4: `conformance.iap.dev/v1` case schema, attestation registries, shared runner wired into `verify`) · Initial AWS mappings ✓ (M6.3: 8 kinds, core certification) · Kubernetes mapping ✓ (M6.5: same 8 kinds, independent attestations).

Certification levels claimed (PC-5, no partial claims): mock = **execution**, aws = **core**, kubernetes = **core**. Execution/drift depth for real providers arrives with Phase 14.

## Verification state

`pnpm run verify` green end to end: build ×13 packages, ESLint clean, **610 passed + 5 skipped** unit tests across 29 files, **61/61** spec harness checks, **45/45** provider conformance checks (`pnpm run test:providers`, now part of `verify`). `pnpm run format:check` clean.

## Specification gaps found by implementation

- **Mapping-time diagnostics have no registry codes** — ch. 12 mandates loud rejection but assigns no IaP codes; the ch. 8 registry is validation-stage-scoped. Resolved for now with the SDK's closed reason taxonomy (design decision 3); candidate IEP: formalize mapping/plan-stage diagnostic codes.
- **`expect: unsupported` semantics** needed sharpening: any mapping failure verdicts as `rejected`; `unsupported` is reserved for capabilities on successfully mapped resources with no registered attestation. Documented in the M6.3/M6.5 milestone docs; IEP-0012's assertion-format section should adopt this wording when revised.
- **Abstract-output completeness pulls in grouping kinds**: a document-level acceptance surface (basic-webapp) requires mapping `Identity` and `Application`, not just workload/data kinds — packages that skip grouping kinds cannot claim whole-document coverage. Worth a note in ch. 12 guidance.
- **Case-level `profile` applies to per-assertion override documents too** (evaluator behavior) — override corpus documents must define the profile; noted in the M6.2/M6.4 milestone doc.

## Remaining scope notes

- Azure and GCP mappings (roadmap "first implementations" items 4–5) are intentionally not part of Phase 6's exit criteria; they become community/reference work once the planner (Phase 7) and execution depth (Phase 14) exist.
- Attestation sandboxing (IEP-0012 open question 1) is deferred: registries are supplied programmatically; dynamic loading of attestation modules from package artifacts awaits the trust-boundary work in Phases 14/16.
- The signing trust model uses per-package committed test keys; a real trust store / certification-signing chain is Phase 18 (registry) work.

## Decision

Phase 6 is **complete**: all five exit criteria pass with mechanical evidence, all five milestones have reviewable documents, and the full verification suite (including the new provider conformance suite) is green. Phase 7 (Deterministic Planner) is unblocked.
