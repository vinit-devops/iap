/**
 * Budget validation and cost-diff (spec ch. 16 §16.7, IEP-0005).
 *
 * Budgets are ordinary ch. 7 policies — a `deny`/`warn` rule with `greater-than`
 * over the `x-iap-cost.*` annotation path — evaluated at PLAN TIME, once a cost
 * report exists (at validation time the annotation path is absent, so a tool
 * reports budgets as "not yet evaluated" rather than passed). A matching `deny`
 * fails with **IAP505** (budget-exceeded); a resource whose cost is `unknown`
 * is reported UNEVALUABLE (warning), never silently passed. Document-level
 * budgets (`target.kinds: [Application]`) evaluate against the roll-up.
 *
 * This lives in `@iap/cost`, not the generic policy engine, because the generic
 * engine emits IAP501 for deny violations; budget violations are the distinct
 * plan-time code IAP505.
 */
import type { CanonicalModel, CanonicalResource, Finding, Policy } from '@iap/model';
import type { CostReport, ResourceCost } from './report.js';

const ANNOTATION_PREFIX = 'x-iap-cost.';

/** A budget policy: a leaf rule over an `x-iap-cost.*` field with `greater-than`. */
interface BudgetRule {
  field: string;
  value: number;
}

function budgetRuleOf(policy: Policy): BudgetRule | null {
  const rule = policy.rule as { field?: unknown; operator?: unknown; value?: unknown };
  if (
    typeof rule.field === 'string' &&
    rule.field.startsWith(ANNOTATION_PREFIX) &&
    rule.operator === 'greater-than' &&
    typeof rule.value === 'number'
  ) {
    return { field: rule.field, value: rule.value };
  }
  return null;
}

/** The annotation sub-field a budget rule targets (`estimatedMonthly` by default). */
function annotationField(field: string): keyof ResourceCost {
  const key = field.slice(ANNOTATION_PREFIX.length);
  return key === 'estimatedHourly' ? 'estimatedHourly' : 'estimatedMonthly';
}

function matchesTarget(policy: Policy, resource: CanonicalResource): boolean {
  const target = policy.target ?? {};
  if (Array.isArray(target.kinds) && !target.kinds.includes(resource.kind)) return false;
  const selector = target.selector;
  if (selector !== undefined) {
    if (Array.isArray(selector.kinds) && !selector.kinds.includes(resource.kind)) return false;
    const wanted = selector.labels ?? {};
    for (const [k, v] of Object.entries(wanted)) {
      if (resource.labels[k] !== v) return false;
    }
  }
  return true;
}

/** True when the policy targets the Application roll-up rather than each resource. */
function isApplicationBudget(policy: Policy): boolean {
  const kinds = policy.target?.kinds;
  return Array.isArray(kinds) && kinds.length === 1 && kinds[0] === 'Application';
}

/**
 * Evaluate every budget policy in the document against the cost report,
 * emitting IAP505 for exceeded `deny` budgets, warnings for exceeded `warn`
 * budgets, and warnings for resources whose cost is unevaluable. Deterministic:
 * findings are sorted by (policy id, path).
 */
export function evaluateBudgets(model: CanonicalModel, report: CostReport): Finding[] {
  const findings: Finding[] = [];
  const policies = model.policies ?? [];

  for (const policy of policies) {
    const budget = budgetRuleOf(policy);
    if (budget === null) continue;
    const field = annotationField(budget.field);
    const isError = policy.effect === 'deny';

    if (isApplicationBudget(policy)) {
      // Document-level: evaluate against each Application roll-up.
      for (const [appId, rollup] of Object.entries(report.rollups.byApplication)) {
        const path = `/resources/${appId}`;
        if (rollup.lowerBound) {
          findings.push({
            code: 'IAP505',
            severity: 'warning',
            path,
            policyId: policy.id,
            message: `budget "${policy.id}" is unevaluable for application "${appId}": the roll-up is a lower bound (some members have unknown cost)`,
          });
          continue;
        }
        if (rollup.estimatedMonthly > budget.value) {
          findings.push({
            code: 'IAP505',
            severity: isError ? 'error' : 'warning',
            path,
            policyId: policy.id,
            message: `budget "${policy.id}" exceeded: application "${appId}" ${field} ${rollup.estimatedMonthly} > ${budget.value} ${report.currency}`,
          });
        }
      }
      continue;
    }

    // Resource-level: evaluate each targeted resource.
    for (const id of Object.keys(model.resources).sort()) {
      const resource = model.resources[id] as CanonicalResource;
      if (!matchesTarget(policy, resource)) continue;
      const entry = report.resources[id] as ResourceCost | undefined;
      const path = `/resources/${id}`;
      if (entry === undefined || entry.confidence === 'unknown') {
        findings.push({
          code: 'IAP505',
          severity: 'warning',
          path,
          policyId: policy.id,
          message: `budget "${policy.id}" is unevaluable for "${id}": its cost is unknown`,
        });
        continue;
      }
      const amount = entry[field];
      if (typeof amount === 'number' && amount > budget.value) {
        findings.push({
          code: 'IAP505',
          severity: isError ? 'error' : 'warning',
          path,
          policyId: policy.id,
          message: `budget "${policy.id}" exceeded: "${id}" ${field} ${amount} > ${budget.value} ${report.currency}`,
        });
      }
    }
  }

  findings.sort((a, b) =>
    a.policyId === b.policyId
      ? a.path.localeCompare(b.path)
      : String(a.policyId).localeCompare(String(b.policyId)),
  );
  return findings;
}

/**
 * Annotate a copy of a canonical model's resources with their `x-iap-cost`
 * objects from the report (§16.1: derived artifact only — never write this back
 * to the source document). The input model is not mutated.
 */
export function annotateModel(model: CanonicalModel, report: CostReport): CanonicalModel {
  const resources: Record<string, CanonicalResource> = {};
  for (const [id, resource] of Object.entries(model.resources)) {
    const entry = report.resources[id];
    resources[id] =
      entry === undefined ? resource : ({ ...resource, 'x-iap-cost': entry } as CanonicalResource);
  }
  return { ...model, resources };
}

/* ------------------------------------------------------------------ */
/* Cost diff (§16.2 cost delta)                                        */
/* ------------------------------------------------------------------ */

export interface ResourceCostDelta {
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface CostDiff {
  /** Resource id → monthly delta; null endpoints mark added/removed/unknown. */
  resources: Record<string, ResourceCostDelta>;
  totalBefore: number;
  totalAfter: number;
  totalDelta: number;
}

function monthly(entry: ResourceCost | undefined): number | null {
  return entry?.estimatedMonthly ?? null;
}

/** The per-resource and total monthly delta between two reports (before → after). */
export function diffReports(before: CostReport, after: CostReport): CostDiff {
  const ids = [
    ...new Set([...Object.keys(before.resources), ...Object.keys(after.resources)]),
  ].sort();
  const resources: Record<string, ResourceCostDelta> = {};
  for (const id of ids) {
    const b = monthly(before.resources[id]);
    const a = monthly(after.resources[id]);
    const delta =
      b !== null && a !== null ? Math.round((a - b + Number.EPSILON) * 100) / 100 : null;
    resources[id] = { before: b, after: a, delta };
  }
  const totalBefore = before.totals.estimatedMonthly;
  const totalAfter = after.totals.estimatedMonthly;
  return {
    resources,
    totalBefore,
    totalAfter,
    totalDelta: Math.round((totalAfter - totalBefore + Number.EPSILON) * 100) / 100,
  };
}
