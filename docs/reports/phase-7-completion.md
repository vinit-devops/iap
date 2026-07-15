# Phase 7 Completion Report — Deterministic Planner

**Date:** 2026-07-11 · **Status:** All exit criteria pass · **Milestones:** M7.1+M7.2 (`docs/milestones/M7.1-M7.2-planner-core.md`), M7.3+M7.4 (`docs/milestones/M7.3-M7.4-planner-completion.md`) · **Design:** `docs/architecture/phase-7-design.md` · **Governing IEP:** IEP-0011

## Exit criteria

| #   | Exit criterion                                             | Verdict  | Evidence                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Identical inputs produce byte-equivalent normalized plans  | **Pass** | `tests/determinism/run.mjs` (29/29): committed golden bytes match per official example, and a full re-run under a perturbed environment (TZ/locale/env/cwd per ch. 24 §24.4) is byte-identical; `packages/planner/test/plan.test.ts` double-run byte identity; provider-suite PC-3 double-runs (45/45)                                                                                        |
| 2   | Plans are independent of input YAML ordering               | **Pass** | Determinism runner re-plans every example from a key-shuffled re-serialization of the source text ⇒ identical `planId`; end-to-end key-order test in `plan.test.ts`                                                                                                                                                                                                                           |
| 3   | Destructive changes are clearly marked                     | **Pass** | Every replace/delete appears in the always-present `destructiveActions` with `destructive: true` and a ch. 14 §14.6 reversibility class (PL-3); asserted in `plan.test.ts`, required by `spec/schema/plan-v1.schema.json`, rendered by `iap plan`                                                                                                                                             |
| 4   | Unsupported rollback is explicitly reported                | **Pass** | `rollback.limitations` is non-empty exactly when an irreversible action exists (stateful delete with no restore source), with a deterministic §14.6 reason per action; asserted in `plan.test.ts`; every destructive action additionally carries one approval gate from a closed vocabulary                                                                                                   |
| 5   | Plan execution cannot proceed after relevant inputs change | **Pass** | `verifyPlan`/`refuseIfInvalid` (PL-2) recompute all nine determinism identities from the current artifacts and refuse on a closed taxonomy; `envelope.test.ts` perturbs each identity individually (12 points) ⇒ `identity-mismatch`, advanced state ⇒ `state-advanced`, expiry boundary ⇒ `expired`, tampered content ⇒ `plan-id-mismatch`, tampered/extended envelope ⇒ `signature-invalid` |

## Verification state at sign-off

`pnpm run verify` exit 0 — 14 workspace projects build, ESLint clean, **757 passed + 5 skipped** unit tests across 37 files, **62/62** spec-harness checks, **45/45** provider-conformance checks, **29/29** determinism checks. `pnpm run format:check` clean.

## What Phase 7 delivered

`@iap/planner` 0.2.0: the nine-element determinism input vector with `inputsHash`; semantic per-attribute diff on canonical values; the closed lifecycle rule order with fail-closed statefulness derivation and reversibility classes; the Kahn wave scheduler with deletes after forward waves in reverse dependency order; canonical `plan.iap.dev/v1` artifacts (`planId` = SHA-256 of canonical content, envelope never hashed); risk rule table v1 with explicit thresholds; rollback limitations and approval gates; ed25519 plan envelopes with injected, tamper-evident expiry; and PL-2 invalidation. Plus: the mock provider widened to all example-declared kinds (mapping/manifest 1.1.0, honest rejection surface retained, re-signed), the golden-plan determinism suite wired into `verify`, and the CLI `iap plan` unlock — while the toolchain remains structurally unable to execute anything (no deploy engine until Phase 14).

## Spec gaps and candidate follow-ups (non-blocking)

- **Plan-stage diagnostic codes**: like mapping-time diagnostics (Phase 6 report), planner refusals use a package-level closed taxonomy (`PLAN_REFUSAL_CODES`), not IaP registry codes — same candidate-IEP umbrella as the mapping taxonomy.
- **IEP-0011 open question 1 (trust distribution)**: plan signing verifies against caller-supplied per-key trust stores in v1; registry/chain distribution remains open.
- **IEP-0011 open question 2 (risk-rules versioning)**: resolved for v1 by folding the rule-table version into `PLANNER_VERSION` (exercised in the 0.1.0 → 0.2.0 bump); a standalone `riskRules` identity element would need an IEP.
- **Per-action reversibility metadata in mappings**: statefulness is currently derived fail-closed from provenance and output bindings; IEP-0011's provider impact assigns this to mapping artifacts — needs a mapping-schema minor.
- **§14.2 stateful-replace protection**: realized as the machine-checkable `stateful-replace` approval gate rather than a planner throw (documented as milestone design decision 4); chapter wording could be sharpened to match.

## Deferred by design

Cost delta computation → Phase 10 (identity 7 already pinned and hashed); compliance delta → Phase 11; real discovery snapshots → Phase 12; execution engine consuming `verifyPlan`/`refuseIfInvalid` → Phase 14; approval workflow → Phase 16.
