# Phase 3 Completion Report — Intent Authoring Engine and Intent Compiler

**Date:** 2026-07-11 · **Milestones:** M3.1–M3.5
(`docs/milestones/M3.1-compiler-operation-model.md`,
`docs/milestones/M3.2-M3.4-authoring-engine.md`,
`docs/milestones/M3.5-evaluation-authoring.md`)

Phase 3 delivers the full path from natural language to a validated IaP document — the
compiler operation gate (M3.1), the authoring engine above it (M3.2–M3.4), and the
evaluation benchmark plus runnable authoring prototype that close it (M3.5). The
normative invariant holds throughout: an LLM never writes YAML into the source of truth;
proposals are data, `apply` is the gate, and only the committed result serializes bytes.

## Exit-criteria verification

| Exit criterion                                                         | Status   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Natural-language requests generate valid IaP for all official examples | **Pass** | `runAuthoringSession` commits valid documents for requests across every official-example class (web app + gateway + DB + cache, batch job + object storage, serverless function, messaging, private/internal, incremental edits, compliance). The evaluation benchmark's **IaP-validity** measure re-loads and re-validates every committed case green through the whole ch. 8 pipeline (phases 1–5 + extensions), and the authoring-e2e suite commits a full basic-webapp-class document that reloads with zero errors. Requests whose intent the core vocabulary cannot express (named provider regions, provider products) are reported as unsupported, never emitted as invalid IaP. |
| No unvalidated LLM-generated YAML is written to disk                   | **Pass** | OP-1, enforced structurally: every authoring export returns DATA (facets, batches, questions, prose); `apply` is the only path to a serializer, and it hands one back only after strict-schema + full-pipeline dry-run success. `op-conformance.test.ts` pins the entire export surface (now incl. `runAuthoringSession`) and audits that no export turns a raw proposal into bytes. The prototype composes only that surface — it reaches YAML solely through a committed result.                                                                                                                                                                                                       |
| Low-confidence fields require confirmation                             | **Pass** | OP-3: `apply` refuses any operation below the 0.8 confidence threshold, or carrying assumptions or attached clarifications, without a recorded confirmation. Extractor-inferred structure sits at the 0.7 tier by design (below threshold), so it can never commit unconfirmed. The prototype's `requiredConfirmations`/answer flow surfaces exactly these; `autoAnswerDefaults` still cannot commit a value-requiring or free-form question.                                                                                                                                                                                                                                            |
| Same confirmed operations produce same IaP regardless of model         | **Pass** | Model independence proven two ways: the `fixtureAdapter` (replay) and `rulesAdapter` yield byte-identical documents, canonical JSON, and hashes through the gate (`adapter.test.ts`); and the benchmark's **deterministic-serialization** measure runs each committed request twice for byte-identical YAML and equal canonical hash. The whole engine is clock-free — audit timestamps are injected, never read.                                                                                                                                                                                                                                                                        |
| Compiler cannot call deployment APIs                                   | **Pass** | Dependency boundary: `@iap/intent-compiler` imports only `@iap/model` + `@iap/parser` + `@iap/sdk` (+ `ajv`) — never `@iap/provider-sdk`, `@iap/planner`, or any execution surface (asserted by the package boundary test). `verify` performs no network I/O anywhere. The prototype adds no dependency and no deploy path.                                                                                                                                                                                                                                                                                                                                                              |
| Every generated field has provenance                                   | **Pass** | OP-4: `apply` emits a per-field provenance record citing the writing operation id and its source (`explicit-user`, `confirmed-clarification`, `accepted-recommendation`) for every written leaf, sorted by path. The prototype returns these on the committed result; `author.test.ts` asserts every provenance record cites a non-empty operation id, and `explainBatch` renders per-field provenance in the preview.                                                                                                                                                                                                                                                                   |

## Deliverables checklist (roadmap Phase 3)

- **Intent compiler SDK** ✓ — `@iap/intent-compiler` (M3.1 gate + M3.2–M3.4 engine).
- **Compiler operation schema** ✓ — `spec/schema/compiler-operations-v1.schema.json`.
- **Clarification engine** ✓ — closed eight-trigger rule set with machine-answerable questions (`clarify`).
- **Provenance model** ✓ — closed source/channel vocabularies, OP-4 records.
- **AI adapter interface** ✓ — vendor-neutral `ModelAdapter` + `createAdapterSession` middleware.
- **Prompt registry** ✓ — exact-version, sha256-pinned prompt artifacts.
- **Evaluation suite** ✓ — `tests/evaluation/` over all eleven §3.7 categories and eight measures (`pnpm run test:eval`).
- **Natural-language authoring prototype** ✓ — `runAuthoringSession` + `tools/authoring-prototype/author.mjs`.

## Evaluation results (§3.7)

On the curated 16-case corpus driven through the reference `rulesAdapter`:

- resource extraction — P/R/F1 = 100 %
- relationship extraction — P/R/F1 = 100 %
- clarification precision — P/R/F1 = 100 %
- unsupported-feature detection — P/R/F1 = 100 %
- false assumptions — 0 (target 0)
- IaP validity, semantic equivalence, deterministic serialization — hold for every committed case

123/123 benchmark checks green; coverage spans all eleven requirement categories.

## Verification state

Full `pnpm run verify` green: build across all workspace packages, ESLint clean,
**1036 unit tests passed + 5 skipped across 54 files**, spec-conformance harness,
provider-conformance suite, golden-plan determinism suite, and the new evaluation
benchmark (123/123). `pnpm run format:check` clean.

## Downstream unblocked

- **M5.3** (`iap create`, Phase 5) — the reference CLI wraps `runAuthoringSession`.
- **Phase 12** (MCP and Authoritative Knowledge Framework) — depends on the finished
  authoring engine; the `recommend`/`acceptRecommendations` seam already models the
  IEP-0013 knowledge-snapshot citation requirement (TB-3) for real MCP retrieval.
