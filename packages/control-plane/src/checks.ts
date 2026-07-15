/**
 * PR checks (roadmap Phase 16, M16.2). Given a base and head canonical model,
 * report the deltas a reviewer needs: intent (resources added/removed/changed),
 * cost (monthly delta + budget breaches), security (risk change + new
 * findings), and compliance (new control violations). Each dimension yields a
 * pass/fail, so a git application can block a PR that regresses posture. Pure —
 * reuses the reference engines; no clock, no network.
 */
import type { CanonicalModel, CanonicalResource } from '@iap/model';
import { estimateCost, evaluateBudgets, referenceCostModel, referenceSnapshot } from '@iap/cost';
import { securityReport } from '@iap/security';
import { evaluateCompliance } from '@iap/compliance';

export interface IntentDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface CheckDimension {
  pass: boolean;
  detail: string;
}

export interface PrChecks {
  intent: IntentDelta & CheckDimension;
  cost: CheckDimension & { monthlyDelta: number };
  security: CheckDimension & { baseRisk: string; headRisk: string; newFindings: string[] };
  compliance: CheckDimension & { newViolations: string[] };
  pass: boolean;
}

function intentDelta(base: CanonicalModel, head: CanonicalModel): IntentDelta {
  const baseIds = new Set(Object.keys(base.resources));
  const headIds = new Set(Object.keys(head.resources));
  const added = [...headIds].filter((id) => !baseIds.has(id)).sort();
  const removed = [...baseIds].filter((id) => !headIds.has(id)).sort();
  const changed = [...headIds]
    .filter((id) => baseIds.has(id))
    .filter(
      (id) =>
        JSON.stringify((base.resources[id] as CanonicalResource).spec) !==
        JSON.stringify((head.resources[id] as CanonicalResource).spec),
    )
    .sort();
  return { added, removed, changed };
}

const RISK_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Compute the four PR-check dimensions between base and head. */
export function prChecks(base: CanonicalModel, head: CanonicalModel): PrChecks {
  // Intent.
  const delta = intentDelta(base, head);
  const intent: PrChecks['intent'] = {
    ...delta,
    pass: true,
    detail: `+${delta.added.length} -${delta.removed.length} ~${delta.changed.length}`,
  };

  // Cost.
  const snapshot = referenceSnapshot();
  const costModel = referenceCostModel();
  const baseReport = estimateCost(base, { costModel, snapshot });
  const headReport = estimateCost(head, { costModel, snapshot });
  const monthlyDelta =
    Math.round(
      (headReport.totals.estimatedMonthly - baseReport.totals.estimatedMonthly + Number.EPSILON) *
        100,
    ) / 100;
  const budgetBreaches = evaluateBudgets(head, headReport).filter((f) => f.severity === 'error');
  const cost: PrChecks['cost'] = {
    monthlyDelta,
    pass: budgetBreaches.length === 0,
    detail: `${monthlyDelta >= 0 ? '+' : ''}${monthlyDelta}/mo${budgetBreaches.length > 0 ? `; ${budgetBreaches.length} budget breach(es)` : ''}`,
  };

  // Security.
  const baseSec = securityReport(base);
  const headSec = securityReport(head);
  const baseFindingKeys = new Set(baseSec.findings.map((f) => `${f.code}${f.path}`));
  const newFindings = headSec.findings
    .filter((f) => f.severity === 'error' && !baseFindingKeys.has(`${f.code}${f.path}`))
    .map((f) => `${f.code} ${f.path}`);
  const security: PrChecks['security'] = {
    baseRisk: baseSec.risk,
    headRisk: headSec.risk,
    newFindings,
    pass:
      newFindings.length === 0 && (RISK_RANK[headSec.risk] ?? 0) <= (RISK_RANK[baseSec.risk] ?? 0),
    detail: `risk ${baseSec.risk} -> ${headSec.risk}; ${newFindings.length} new error finding(s)`,
  };

  // Compliance.
  const baseComp = evaluateCompliance(base);
  const headComp = evaluateCompliance(head);
  const baseViol = new Set(
    baseComp.findings.filter((f) => f.severity === 'error').map((f) => String(f.policyId)),
  );
  const newViolations = headComp.findings
    .filter((f) => f.severity === 'error' && !baseViol.has(String(f.policyId)))
    .map((f) => String(f.policyId));
  const compliance: PrChecks['compliance'] = {
    newViolations,
    pass: newViolations.length === 0,
    detail: `${newViolations.length} new control violation(s)`,
  };

  return {
    intent,
    cost,
    security,
    compliance,
    pass: intent.pass && cost.pass && security.pass && compliance.pass,
  };
}
