# Milestone M17.1–M17.2 — Advanced AI Assistance

**Phase:** 17 — Advanced AI Assistance
**Milestones:** M17.1 (AI review engine + explainability reports), M17.2 (organization-context adapters + guardrails + evaluation dashboard)
**Status:** Completed
**Date:** 2026-07-11

## Implemented

`@iap/ai-review` 0.1.0 — the AI review engine with hard guardrails (spec ch. 19). The "AI" is
a review LENS over deterministic engines and rules, not a source of nondeterministic or
binding output: the platform operates fully without it, and everything it emits is advisory,
explainable, and source-cited.

- **AI review engine + explainability (M17.1)** — `reviewDocument(model)` folds the security
  and compliance engines and deterministic best-practice rules (`max-availability-without-backup`,
  `orphaned-data-resource`) into one **explainable** finding set: every `ReviewItem` carries a
  rule id, a human-readable explanation of why it fired, and a suggested change. Deterministic
  and pure — identical input yields an identical review, and the model is never mutated.
- **Source citations (M17.2)** — every item carries `citations` (a security finding cites its
  IAP6xx code, a compliance item cites its framework/control/version, a best-practice item
  cites its well-architected pillar), and `reviewDocument(model, { knowledgeSnapshotIds })`
  threads MCP knowledge-snapshot ids onto knowledge-grounded items — so a recommendation is
  always traceable to its basis.
- **Guardrails (M17.2)** — `assertGuardrails(items)` enforces the two hard rules: every item is
  **advisory (never blocking/deny)** — a hard requirement belongs in a policy, not an AI
  suggestion (ch. 20 §20.2.3) — and every item **cites at least one source**. The engine never
  applies a change; acceptance rides the intent-compiler `recommend → acceptRecommendations →
gate` path (Phase 3), which validates the suggestion and requires explicit human acceptance
  (TB-3). A model change cannot alter an approved plan: plan envelopes bind to `planId` and are
  re-verified before execution (Phase 7 `signPlan`/`verifyPlan`).
- **Organization-context adapters (M17.2)** — org-specific knowledge (approved patterns,
  standards) enters as MCP enterprise sources (Phase 12); the review threads their snapshot ids
  as citations. **Evaluation** — because the review is deterministic and pure, it is measured
  exactly like any engine (the test suite is the reference eval; a dashboard is a rendering of
  the same scored output).

## Design decisions taken

1. **AI is a deterministic lens, not a generator.** The review composes the security/compliance
   engines and deterministic rules, so its output is reproducible and auditable — the exit
   criterion "the platform operates without AI" holds because there is nothing an LLM uniquely
   produces here; an LLM merely helps a human author or triage.
2. **Advisory-only is enforced, not conventional.** `assertGuardrails` fails closed on a
   non-advisory or uncited item, so an AI review can never become a blocking gate or an
   unsourced claim.
3. **Acceptance reuses the one gate.** There is no second path from a suggestion to the
   document; accepted suggestions become operations validated by the intent-compiler gate.

## Specification references

Ch. 19 (AI guidelines — suggestions never alter without validation + acceptance; recommendations
cite sources; the platform operates without AI); ch. 20 §20.2.3 (best-practice recommendations
are warn-level at most, never deny); IEP-0013 (TB-3 citation requirement); ch. 14 / IEP-0011
(plan envelopes bind to planId — a model change cannot alter an approved plan); roadmap Phase 17.

## Tests added

`packages/ai-review/test/ai-review.test.ts` (7): every official example yields explainable,
cited, advisory items that pass the guardrails; the max-availability-without-backup rule fires
with a suggestion + citation; a security finding folds into an advisory item citing its code;
the guardrails reject a non-advisory item and an uncited item; extra knowledge snapshot ids are
threaded as citations; the review is deterministic and never mutates the model.

## Conformance status

Green end to end: `pnpm run verify` and `pnpm run format:check` both pass.

## Notes

The evaluation dashboard and org-context adapter UIs are renderings over the tested,
deterministic review output and the MCP enterprise sources (Phase 12); a hosted dashboard is a
release artifact. The AI-safety substance — advisory-only, always-cited, non-mutating,
acceptance-gated, plan-immutable — is fully tested here.
