/**
 * The cost report artifact (`cost-report/v1`; spec ch. 16 §16.2/§16.8). A pure
 * function of three versioned inputs — the canonical model (by `modelHash`), a
 * cost model (`costModel`), and a price snapshot (`priceSnapshot`) — so
 * identical inputs yield byte-identical bytes (§16.9). Cost is an annotation
 * layer: this artifact is tool output and never enters the document or its hash.
 */
import { readFileSync } from 'node:fs';
import type { JsonSchema } from '@iap/model';
import { createValidator } from '@iap/parser';
import type { ValidateFunction } from 'ajv';

/** exact: fully determined by declared fields · estimate: usage-dependent from stated assumptions · unknown: uncovered or missing price. */
export type CostConfidence = 'exact' | 'estimate' | 'unknown';

/** One resource's cost entry. Numbers are ABSENT when `confidence` is `unknown` (§16.2). */
export interface ResourceCost {
  kind: string;
  estimatedMonthly?: number;
  estimatedHourly?: number;
  confidence: CostConfidence;
  assumptions: string[];
}

/** An aggregate: the sum of priced members, its weakest confidence, and whether it omits unknowns. */
export interface Rollup {
  estimatedMonthly: number;
  confidence: CostConfidence;
  /** True when the aggregate omits one or more unknown-confidence members — a lower bound. */
  lowerBound: boolean;
}

/** A deterministic optimization suggestion (§16.4); advisory only. */
export interface CostSuggestion {
  rule: string;
  resource: string;
  detail: string;
  estimatedMonthlySavings: number;
}

export interface CostReport {
  reportVersion: '1';
  formatVersion: 1;
  document: string;
  profile: string | null;
  /** SHA-256 of the canonical model the report was computed from (reproducibility anchor). */
  modelHash: string;
  /** The price snapshot content address (`id#sha256:<hex>`). */
  priceSnapshot: string;
  /** The cost model identity as `id@version`. */
  costModel: string;
  currency: string;
  resources: Record<string, ResourceCost>;
  rollups: {
    byApplication: Record<string, Rollup>;
    byLabel: Record<string, Rollup>;
  };
  totals: Rollup;
  suggestions: CostSuggestion[];
}

let cachedSchema: JsonSchema | undefined;
/** The embedded cost-report-v1 schema (parsed, cached; drift-tested vs spec/schema). */
export function costReportSchema(): JsonSchema {
  cachedSchema ??= JSON.parse(
    readFileSync(new URL('../schemas/cost-report-v1.schema.json', import.meta.url), 'utf8'),
  ) as JsonSchema;
  return cachedSchema;
}

let cachedValidator: ValidateFunction | undefined;

export interface ReportValidation {
  ok: boolean;
  errors: string[];
}

/** Structurally validate a report against the companion schema. */
export function validateReport(candidate: unknown): ReportValidation {
  cachedValidator ??= createValidator(costReportSchema());
  const ok = cachedValidator(candidate) as boolean;
  const errors = ok
    ? []
    : (cachedValidator.errors ?? []).map((e) =>
        `${e.instancePath || '/'} ${e.message ?? ''}`.trim(),
      );
  return { ok, errors };
}
