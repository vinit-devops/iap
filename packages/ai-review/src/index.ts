/**
 * `@iap/ai-review` — the AI review engine and guardrails (spec ch. 19; roadmap
 * Phase 17). Deterministic, explainable, source-cited, advisory review over a
 * document: AI suggestions never alter infrastructure without validation and
 * explicit acceptance (they are data here; acceptance rides the intent-compiler
 * gate), recommendations cite sources, the platform operates fully without AI,
 * and a model change cannot alter an approved plan (plan envelopes bind to
 * planId, Phase 7). Org-context adapters ride the MCP enterprise sources
 * (Phase 12).
 */
export { assertGuardrails, reviewDocument } from './review.js';
export type { ReviewItem, ReviewOptions, ReviewSeverity } from './review.js';
