/**
 * `@iap/security` — the security analysis engine (spec ch. 15; roadmap Phase 11,
 * M11.1). Security is DERIVED from the canonical document, never annotated onto
 * it: least-privilege grants come solely from edge `access` attributes (§15.3),
 * the reachability graph from `exposure` + connectivity edges (§15.4), and
 * encryption/secret posture from intent fields (§15.5–§15.6). The engine emits
 * the IAP6xx findings (IAP601–IAP603 at validation; IAP604 is plan-time) with a
 * deterministic risk level. Pure — no clock, no network, no provider input.
 */
export {
  DATA_KINDS,
  WORKLOAD_KINDS,
  deriveEncryption,
  deriveGrants,
  deriveReachability,
  identityOfWorkloads,
} from './derive.js';
export type { EncryptionPosture, Grant, Reachability } from './derive.js';

export { scoreRisk, securityFindings } from './findings.js';
export type { RiskLevel } from './findings.js';

export { hasBlockingFindings, securityReport } from './report.js';
export type { SecurityReport } from './report.js';
