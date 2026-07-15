/**
 * RBAC and the separation-of-duties approval engine (roadmap Phase 16, M16.1).
 * A closed role/permission model scopes what a principal may do in a project,
 * and the approval engine makes separation of duties enforceable: the author of
 * a change can never approve it, and only an approver role may. Every approval
 * is recorded as evidence, so a deployment can be tied to identity + approval.
 */

/** Closed role set (least → most privileged). */
export const ROLES = ['viewer', 'author', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Closed action set the control plane authorizes. */
export const ACTIONS = ['view', 'author', 'approve', 'deploy', 'administer'] as const;
export type Action = (typeof ACTIONS)[number];

const GRANTS: Record<Role, Set<Action>> = {
  viewer: new Set(['view']),
  author: new Set(['view', 'author']),
  approver: new Set(['view', 'author', 'approve']),
  admin: new Set(['view', 'author', 'approve', 'deploy', 'administer']),
};

/** True when a role may perform an action. */
export function can(role: Role, action: Action): boolean {
  return GRANTS[role].has(action);
}

export interface ApprovalRequest {
  changeId: string;
  /** The principal who authored the change. */
  author: string;
  /** Human-readable summary of what the change does. */
  summary: string;
}

export interface Approval {
  changeId: string;
  approver: string;
  approverRole: Role;
  /** Injected RFC 3339 instant. */
  timestamp: string;
  decision: 'approved' | 'rejected';
}

export const APPROVAL_REFUSALS = ['self-approval', 'insufficient-role'] as const;
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number];

export type ApprovalOutcome =
  { ok: true; approval: Approval } | { ok: false; refusal: ApprovalRefusal; message: string };

/**
 * Approve (or reject) a change under separation of duties: the author may never
 * approve their own change (`self-approval`), and the approver must hold the
 * `approve` action (`insufficient-role`). Both are enforced before any approval
 * evidence is produced.
 */
export function approve(
  request: ApprovalRequest,
  approver: { id: string; role: Role },
  decision: 'approved' | 'rejected',
  timestamp: string,
): ApprovalOutcome {
  if (approver.id === request.author) {
    return {
      ok: false,
      refusal: 'self-approval',
      message: `"${approver.id}" cannot approve their own change (separation of duties)`,
    };
  }
  if (!can(approver.role, 'approve')) {
    return {
      ok: false,
      refusal: 'insufficient-role',
      message: `role "${approver.role}" cannot approve changes`,
    };
  }
  return {
    ok: true,
    approval: {
      changeId: request.changeId,
      approver: approver.id,
      approverRole: approver.role,
      timestamp,
      decision,
    },
  };
}
