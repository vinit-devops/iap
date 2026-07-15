/**
 * `@iap/cost` — the reference cost model and estimation engine (spec ch. 16,
 * IEP-0005; roadmap Phase 10).
 *
 * Cost is an ANNOTATION layer, never document content: the core document
 * describes intent; cost tooling projects prices onto it. A cost report is a
 * pure function of three versioned inputs — the canonical profile-merged
 * document, a mapping cost model, and a content-addressed price snapshot — so
 * identical inputs yield a byte-identical report (§16.9). No clock, no network:
 * the snapshot IS the pricing input.
 *
 * This package ships the engine (`estimateCost`), the report and snapshot
 * formats (companion schemas `cost-report-v1` / `price-snapshot-v1`), a
 * reference cost model and price snapshot to exercise them, and the
 * deterministic optimization-suggestion rules. Provider-distributed cost models
 * and budget-policy plan-time enforcement arrive in M10.2.
 */

export { estimateCost } from './estimate.js';
export type { EstimateOptions } from './estimate.js';

export { referenceCostModel, quantityToGiB, parseThroughput } from './model.js';
export type { BillItem, CostModel, PricingContext, ResourceDecomposition } from './model.js';

export {
  loadSnapshot,
  priceSnapshotSchema,
  referenceSnapshot,
  snapshotContentAddress,
  validateSnapshot,
} from './snapshot.js';
export type { PriceEntry, PriceSnapshot, SnapshotValidation } from './snapshot.js';

export { costReportSchema, validateReport } from './report.js';
export type {
  CostConfidence,
  CostReport,
  CostSuggestion,
  ReportValidation,
  ResourceCost,
  Rollup,
} from './report.js';

export { suggestOptimizations } from './suggest.js';
export type { SuggestContext } from './suggest.js';

export { annotateModel, diffReports, evaluateBudgets } from './budget.js';
export type { CostDiff, ResourceCostDelta } from './budget.js';
