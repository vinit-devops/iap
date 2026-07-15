# Phase 1 Completion Report — IaP v1 Stabilization

**Date:** 2026-07-10 · **Milestones:** M1.1–M1.5 (all completed with reviewable docs under `docs/milestones/`)

## Exit criteria verification

| Exit criterion                                                    | Status   | Evidence                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No known contradiction exists between normative prose and schemas | **Pass** | Gap report §3 mismatches closed in M1.2 (annotation additions); model drift tests assert constants ≡ schema enums and embedded ≡ spec schemas; harness cross-checks error-code registry ≡ chapter 8 on every run.                                                                                                    |
| All official examples pass                                        | **Pass** | 9/9 examples validate (`pnpm run test:spec`, 41/41 checks; also exercised through `@iap/parser`, 54/54 unit tests). Roadmap Phase 1 example list fully covered: basic web app, container platform, serverless, enterprise PCI, multi-region, private internal, event-driven, data-processing, hybrid, import intent. |
| All invalid conformance examples fail predictably                 | **Pass** | 22 invalid cases: every `schema-invalid` case is rejected at its intended constraint; every semantic case (IAP104/2xx/3xx/4xx/5xx/6xx/8xx) is schema-valid and carries its expected code, asserted by the harness.                                                                                                   |
| Breaking changes require an accepted IEP                          | **Pass** | Phase 0.5 process complete; compatibility baseline (`docs/reports/schema-compatibility-1.0.md`) enumerates frozen surfaces; M1.2 revision audited as annotation-only.                                                                                                                                                |
| The core kind registry is frozen for the implementation milestone | **Pass** | Declared frozen in the compatibility baseline: 13 core + 9 reserved kinds, closed verb set, top-level keys, operators, grammars.                                                                                                                                                                                     |

## Deliverables checklist (roadmap Phase 1)

IaP v1 draft release ✓ (the versioned repo state; formal tagged release deferred until git is enabled) · Stable JSON Schema ✓ · Stable provider-mapping schema ✓ · Conformance suite ✓ (3 valid + 22 invalid cases + 9 examples by reference) · Canonicalization rules ✓ (ch. 1 §1.5.1–§1.5.2) · Error-code registry ✓ (`spec/conformance/error-codes.yaml`, 32 codes) · Schema compatibility report ✓

## Remaining scope notes

- Semantic-case assertions currently verify schema-validity + expected-code headers; executing the semantic checks themselves is exactly the Phase 2 validator work (M2.4/M2.5).
- Golden canonical-form fixtures (hashes) arrive with the Phase 2 canonicalization engine (M2.3), now unblocked by M1.1.
- Uncovered codes (IAP303 advisory, IAP505/IAP604 plan-time, IAP7xx framework bundles) need engines that do not exist yet; tracked in M1.3's milestone doc.

## Decision

Phase 1 is **complete**. Phase 2 (Canonical Model and Reference SDK) is unblocked; its first milestones extend the M0.6 packages (full-fidelity parser M2.1, CIM per IEP-0008 M2.2, canonicalization + hashing M2.3).
