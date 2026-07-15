/**
 * The security report (spec ch. 15 §15.9) — the intent-level review surface,
 * assembled purely from the canonical document: derived least-privilege grants,
 * the zero-trust reachability graph, encryption posture, and the IAP6xx findings
 * with a deterministic risk level. Every official example produces one.
 */
import type { CanonicalModel, Finding } from '@iap/model';
import { DATA_KINDS, deriveEncryption, deriveGrants, deriveReachability } from './derive.js';
import type { EncryptionPosture, Grant, Reachability } from './derive.js';
import { scoreRisk, securityFindings } from './findings.js';
import type { RiskLevel } from './findings.js';

export interface SecurityReport {
  reportVersion: '1';
  formatVersion: 1;
  document: string;
  profile: string | null;
  modelHash: string;
  grants: Grant[];
  reachability: Reachability[];
  encryption: EncryptionPosture[];
  findings: Finding[];
  risk: RiskLevel;
}

/** Derive the full security report for a canonical model. Pure and deterministic. */
export function securityReport(model: CanonicalModel): SecurityReport {
  const findings = securityFindings(model);
  const reachability = deriveReachability(model);
  const publicDataKinds = reachability.filter(
    (r) => DATA_KINDS.has(r.kind) && r.exposure === 'public',
  ).length;
  return {
    reportVersion: '1',
    formatVersion: 1,
    document: model.metadata.name,
    profile: model.profile,
    modelHash: model.hash,
    grants: deriveGrants(model),
    reachability,
    encryption: deriveEncryption(model),
    findings,
    risk: scoreRisk(findings, publicDataKinds),
  };
}

/** True when the report contains any error-severity finding (blocks per policy). */
export function hasBlockingFindings(report: SecurityReport): boolean {
  return report.findings.some((f) => f.severity === 'error');
}
