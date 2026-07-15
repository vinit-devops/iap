/**
 * Risk rule table v1 (IEP-0011 risk scoring; phase-7 design decision 8).
 *
 * Risk is a pure function of the plan content: the annotator receives every
 * content member except `risk` itself and derives the annotation from
 * nothing else — no clock, no environment, no inference. Weights are
 * ordinal integers (never floating point): the table ranks
 * delete-of-stateful ≫ replace ≫ import/create ≫ update-in-place, weighted
 * by the reversibility class of ch. 14 §14.6, plus a boundary factor for
 * every exposure/encryption-affecting change the plan itself surfaces in
 * `deltas.security`.
 *
 * The rule-table version folds into `PLANNER_VERSION` (IEP-0011 open
 * question 2, resolved by design decision 8): changing any weight,
 * threshold, or factor rule here requires a planner version bump, which
 * intentionally changes every planId and inputsHash.
 */

import { compareCodePoints } from '@iap/model';
import type { PlanAction, PlanActionEntry, ReversibilityClass } from './lifecycle.js';
import type { RiskAnnotation, RiskAnnotator, RiskFactor, RiskInput } from './plan.js';

/**
 * Version of this rule table. Not an independent identity element: it is
 * part of `PLANNER_VERSION` (identity 9), so it participates in
 * `inputsHash` through the planner version alone.
 */
export const RISK_RULE_TABLE_VERSION = 1;

/**
 * Per-resource ordinal weight of one scheduled action, keyed by action class
 * and reversibility class. The table is total over the closed vocabularies —
 * combinations the current lifecycle table never emits (e.g. a
 * fully-reversible delete) still carry a defined weight, so the annotator is
 * a total pure function of any schema-valid content.
 */
export const ACTION_WEIGHTS: Readonly<
  Record<PlanAction, Readonly<Record<ReversibilityClass, number>>>
> = {
  'update-in-place': {
    'fully-reversible': 1,
    'reversible-with-data-risk': 1,
    'replacement-based-recovery': 1,
    'manual-recovery-required': 1,
    irreversible: 1,
  },
  create: {
    'fully-reversible': 2,
    'reversible-with-data-risk': 2,
    'replacement-based-recovery': 2,
    'manual-recovery-required': 2,
    irreversible: 2,
  },
  import: {
    'fully-reversible': 3,
    'reversible-with-data-risk': 3,
    'replacement-based-recovery': 3,
    'manual-recovery-required': 3,
    irreversible: 3,
  },
  replace: {
    'fully-reversible': 8,
    'replacement-based-recovery': 15,
    'reversible-with-data-risk': 30,
    'manual-recovery-required': 40,
    irreversible: 60,
  },
  delete: {
    'fully-reversible': 8,
    'replacement-based-recovery': 20,
    'reversible-with-data-risk': 30,
    'manual-recovery-required': 40,
    irreversible: 60,
  },
};

/** Weight of one `deltas.security` entry (exposure/encryption boundary change). */
export const SECURITY_BOUNDARY_WEIGHT = 5;

/** Stable factor id of the security-boundary rule. */
export const SECURITY_BOUNDARY_FACTOR_ID = 'security-boundary-change';

/**
 * Explicit class thresholds over the integer score: `low` below `medium`,
 * `critical` at or above `critical`. A single irreversible delete (weight
 * 60) is `high` on its own; two are `critical`.
 */
export const RISK_CLASS_THRESHOLDS = { medium: 25, high: 60, critical: 100 } as const;

/** Deterministic classification of an integer score (IEP-0011). */
export function classifyRiskScore(score: number): RiskAnnotation['class'] {
  if (score >= RISK_CLASS_THRESHOLDS.critical) return 'critical';
  if (score >= RISK_CLASS_THRESHOLDS.high) return 'high';
  if (score >= RISK_CLASS_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/**
 * Factor id for one scheduled action: the bare action class for the
 * non-destructive actions (their reversibility is uniform), the action
 * qualified by reversibility class for replace and delete (where the
 * reversibility carries the weight).
 */
export function riskFactorIdOf(action: PlanAction, reversibility: ReversibilityClass): string {
  return action === 'replace' || action === 'delete' ? `${action}-${reversibility}` : action;
}

/**
 * The v1 rule-table annotator: group every scheduled action into a factor by
 * `riskFactorIdOf`, weight each factor by (per-resource table weight ×
 * matched resources), add one boundary factor weighted per
 * `deltas.security` entry, sum the factor weights into the score, and
 * classify by the explicit thresholds. Factors sort by id, factor resources
 * by logical id (CP-2).
 */
export const riskRuleTableV1: RiskAnnotator = (content: RiskInput): RiskAnnotation => {
  const grouped = new Map<string, { unit: number; resources: string[] }>();
  for (const entry of content.waves.flat() as PlanActionEntry[]) {
    const id = riskFactorIdOf(entry.action, entry.reversibility);
    const unit = ACTION_WEIGHTS[entry.action][entry.reversibility];
    const group = grouped.get(id) ?? { unit, resources: [] };
    group.resources.push(entry.resource);
    grouped.set(id, group);
  }

  const factors: RiskFactor[] = [...grouped.entries()].map(([id, group]) => ({
    id,
    weight: group.unit * group.resources.length,
    resources: [...group.resources].sort(compareCodePoints),
  }));

  if (content.deltas.security.length > 0) {
    factors.push({
      id: SECURITY_BOUNDARY_FACTOR_ID,
      weight: SECURITY_BOUNDARY_WEIGHT * content.deltas.security.length,
      resources: [...new Set(content.deltas.security.map((delta) => delta.resource))].sort(
        compareCodePoints,
      ),
    });
  }

  factors.sort((a, b) => compareCodePoints(a.id, b.id));
  const score = factors.reduce((sum, factor) => sum + factor.weight, 0);
  return { score, class: classifyRiskScore(score), factors };
};
