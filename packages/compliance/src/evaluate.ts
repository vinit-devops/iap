/**
 * The compliance evaluator and evidence report (spec ch. 17 §17.4/§17.6). For
 * each active framework's bundle, every control is evaluated against its
 * in-scope resources and given a disposition — `satisfied`, `violated`, or
 * `not-applicable` — with the contributing document paths. Violations emit
 * **IAP701** (control-violation) carrying framework, control, bundle version,
 * and resource path; a declared framework with no in-scope resources emits
 * **IAP702** (structural requirement unmet). The report is derived entirely
 * from the canonical document and the bundle versions — an audit at the intent
 * level, re-verifiable by any party — and NEVER a claim of certification.
 */
import type { CanonicalModel, CanonicalResource, Finding } from '@iap/model';
import { FRAMEWORK_BUNDLES } from './bundles.js';
import type { ComplianceControl, FrameworkBundle } from './bundles.js';
import { derivedViolations, fieldRuleHolds } from './rules.js';

export type Disposition = 'satisfied' | 'violated' | 'not-applicable';

export interface ControlEvidence {
  framework: string;
  bundleVersion: string;
  control: string;
  title: string;
  disposition: Disposition;
  /** Resource ids that determined the disposition (violating ones when violated). */
  resources: string[];
  remediation?: string;
  technicalEvidence: string;
  externalEvidence?: string;
}

export interface ComplianceReport {
  reportVersion: '1';
  formatVersion: 1;
  document: string;
  profile: string | null;
  modelHash: string;
  frameworks: string[];
  bundles: { framework: string; version: string }[];
  evidence: ControlEvidence[];
  findings: Finding[];
  summary: { satisfied: number; violated: number; notApplicable: number };
  /** Normative distinction: configuration coverage, not formal certification (§17.6). */
  disclaimer: string;
}

const DISCLAIMER =
  'This report evaluates configuration coverage of the declared frameworks at the intent level. ' +
  'It is NOT a claim of formal certification; external evidence and an accredited assessment are still required.';

function inScope(
  model: CanonicalModel,
  bundle: FrameworkBundle,
  control: ComplianceControl,
): string[] {
  return Object.keys(model.resources)
    .sort()
    .filter((id) => {
      const resource = model.resources[id] as CanonicalResource;
      if (control.targetKinds !== undefined && !control.targetKinds.includes(resource.kind))
        return false;
      if (control.scoped === true && bundle.scopeLabel !== undefined) {
        return resource.labels[bundle.scopeLabel] === 'true';
      }
      return true;
    });
}

function evaluateControl(
  model: CanonicalModel,
  bundle: FrameworkBundle,
  control: ComplianceControl,
): { evidence: ControlEvidence; findings: Finding[] } {
  const scope = inScope(model, bundle, control);
  const base = {
    framework: bundle.framework,
    bundleVersion: bundle.version,
    control: control.id,
    title: control.title,
    technicalEvidence: control.technicalEvidence,
    ...(control.externalEvidence === undefined
      ? {}
      : { externalEvidence: control.externalEvidence }),
  };

  let violating: string[];
  if (control.rule.kind === 'field') {
    if (scope.length === 0) {
      return { evidence: { ...base, disposition: 'not-applicable', resources: [] }, findings: [] };
    }
    violating = scope.filter(
      (id) => !fieldRuleHolds(model.resources[id] as CanonicalResource, control.rule as never),
    );
  } else {
    const all = derivedViolations(model, control.rule.check);
    // A derived control scoped to targeted resources narrows to the in-scope set.
    violating =
      control.targetKinds === undefined && control.scoped !== true
        ? all
        : all.filter((id) => scope.includes(id));
    // Applicability: a derived edge-check with no relevant edges/resources is not-applicable.
    if (
      control.rule.check !== 'no-undeclared-reachability' &&
      violating.length === 0 &&
      scope.length === 0 &&
      all.length === 0
    ) {
      const anySubject = model.edges.some(
        (e) => e.type === 'connectsTo' || e.type === 'storesDataIn' || e.type === 'authenticatedBy',
      );
      if (!anySubject) {
        return {
          evidence: { ...base, disposition: 'not-applicable', resources: [] },
          findings: [],
        };
      }
    }
  }

  if (violating.length > 0) {
    const findings: Finding[] = violating.map((id) => ({
      code: 'IAP701',
      severity: 'error',
      path: `/resources/${id}`,
      policyId: `${bundle.framework}/${control.id}@${bundle.version}`,
      message: `${bundle.framework} control ${control.id} (${control.title}) violated by "${id}" — ${control.remediation}`,
    }));
    return {
      evidence: {
        ...base,
        disposition: 'violated',
        resources: violating,
        remediation: control.remediation,
      },
      findings,
    };
  }
  return { evidence: { ...base, disposition: 'satisfied', resources: scope }, findings: [] };
}

/** Evaluate every active framework bundle against the model. Pure and deterministic. */
export function evaluateCompliance(model: CanonicalModel): ComplianceReport {
  const frameworks = Array.isArray(model.compliance?.frameworks)
    ? [...(model.compliance?.frameworks as string[])].sort()
    : [];
  const evidence: ControlEvidence[] = [];
  const findings: Finding[] = [];
  const bundles: { framework: string; version: string }[] = [];

  for (const framework of frameworks) {
    const bundle = FRAMEWORK_BUNDLES[framework];
    if (bundle === undefined) {
      findings.push({
        code: 'IAP702',
        severity: 'error',
        path: '/compliance/frameworks',
        message: `no registered bundle for framework "${framework}"`,
      });
      continue;
    }
    bundles.push({ framework: bundle.framework, version: bundle.version });

    // IAP702 — a scoped framework declared with nothing in scope is structurally unmet.
    if (bundle.scopeLabel !== undefined) {
      const anyScoped = Object.values(model.resources).some(
        (r) => (r as CanonicalResource).labels[bundle.scopeLabel as string] === 'true',
      );
      if (!anyScoped) {
        findings.push({
          code: 'IAP702',
          severity: 'error',
          path: '/compliance/frameworks',
          policyId: `${bundle.framework}@${bundle.version}`,
          message: `framework "${framework}" is declared but no resource carries the '${bundle.scopeLabel}' scope label — nothing is in scope (ch. 17 §17.7)`,
        });
      }
    }

    for (const control of bundle.controls) {
      const result = evaluateControl(model, bundle, control);
      evidence.push(result.evidence);
      findings.push(...result.findings);
    }
  }

  findings.sort((a, b) =>
    a.code === b.code
      ? String(a.policyId).localeCompare(String(b.policyId)) || a.path.localeCompare(b.path)
      : a.code.localeCompare(b.code),
  );

  const summary = evidence.reduce(
    (acc, e) => {
      if (e.disposition === 'satisfied') acc.satisfied += 1;
      else if (e.disposition === 'violated') acc.violated += 1;
      else acc.notApplicable += 1;
      return acc;
    },
    { satisfied: 0, violated: 0, notApplicable: 0 },
  );

  return {
    reportVersion: '1',
    formatVersion: 1,
    document: model.metadata.name,
    profile: model.profile,
    modelHash: model.hash,
    frameworks,
    bundles,
    evidence,
    findings,
    summary,
    disclaimer: DISCLAIMER,
  };
}
