/**
 * `@iap/control-plane` — the enterprise control-plane core (roadmap Phase 16).
 * Multi-tenant project isolation, RBAC, a separation-of-duties approval engine
 * (an author can never approve their own change; every approval is evidence),
 * an append-only audit log, and PR checks reporting intent/cost/security/
 * compliance deltas so a git application can block a regressing change. Pure
 * and deterministic; the HTTP/API and git-application surfaces are thin clients
 * over this core.
 */
export { ACTIONS, APPROVAL_REFUSALS, ROLES, approve, can } from './rbac.js';
export type {
  Action,
  Approval,
  ApprovalOutcome,
  ApprovalRefusal,
  ApprovalRequest,
  Role,
} from './rbac.js';

export { prChecks } from './checks.js';
export type { CheckDimension, IntentDelta, PrChecks } from './checks.js';

export { ControlPlane } from './project.js';
export type { AuditEntry, ProjectRef } from './project.js';
