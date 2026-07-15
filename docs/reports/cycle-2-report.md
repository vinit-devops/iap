# Cycle 2 Report (roadmap §17)

**Phase:** 0 (signed off) · 0.5 (completed) · 1 (completed)
**Milestones:** Phase 0 exit-criteria sign-off · M05.3 · M1.1 – M1.5 (each with a reviewable document under `docs/milestones/`)

**Implemented:**

- Phase 0 and Phase 0.5 completion reports with per-criterion evidence (`docs/reports/phase-0-completion.md`, `phase-0.5-completion.md`)
- M05.3 — retroactive IEPs 0001–0007 formalizing the shipped v1 design (recovered rationale, alternatives, forward links); IEP index updated
- M1.1 — canonicalization precision: exact-rational quantity/duration normalization algorithm and the seven default-materialization rules with presence-semantic and conditional-default carve-outs (ch. 1 §1.5.1–§1.5.2, ch. 2 §2.7, IEP-0008 resolution record) — closes both determinism blockers from the gap analysis
- M1.2 — non-breaking corrections: per-kind resilience defaults machine-readable, edge `access` default, two new annotation keywords, replicatesTo failover non-goal, require-autofix scoping; code vocabulary kept in lockstep
- M1.3 — 16 new conformance cases (IAP104 ×3, IAP2xx ×4, IAP3xx ×2, IAP402, IAP5xx ×2, IAP6xx ×2, IAP803, post-merge IAP101); suite now 3 valid + 22 invalid cases
- M1.4 — 5 new official examples (serverless, private-internal, data-processing, hybrid, import-intent); the roadmap's Phase 1 example list is fully covered at 9 examples
- M1.5 — error-code registry (32 codes, harness-cross-checked against chapter 8 — which caught and fixed a real omission, IAP805) + schema compatibility 1.0 baseline freezing the kind registry, verb set, grammars, and vocabulary
- Phase 1 completion report: all five exit criteria pass

**Files changed:** ~40 created/modified (per-milestone docs list details).

**Tests added:** 21 new unit-test assertions (54 total) + 23 new harness checks (41 total).

**Conformance status:** `pnpm run verify` green — build, lint, 54/54 unit tests, 41/41 spec checks, prettier clean. All 9 examples and 25 conformance cases produce declared outcomes.

**Architecture decisions:** canonical spelling prefers binary suffixes (deterministic total order); per-kind defaults via explicit def-splitting; error-code registry lives under `spec/conformance/` as a normative-adjacent artifact.

**Specification gaps:** both M1.1 determinism blockers closed. Remaining known deferrals: `internal`-realization declaration by mappings (explicitly deferred), IEP-0008..0013 open questions awaiting maintainer decisions, plan-time/framework codes (IAP505/IAP604/IAP7xx) uncoverable until engines exist.

**Security findings:** none; new examples/cases contain no credential material (IAP602 case uses a placeholder value that itself demonstrates the violation).

**Known limitations:** semantic conformance cases assert schema-validity + expected code only — the executing semantic validator is Phase 2 (M2.4/M2.5); golden canonical hashes await the M2.3 canonicalization engine; no git per user directive.

**Next milestone:** Phase 2 — M2.1 (full-fidelity parser: per-node source maps) and M2.2 (CIM per IEP-0008), building on the M0.6 packages.
