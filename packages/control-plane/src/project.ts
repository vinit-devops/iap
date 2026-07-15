/**
 * Multi-tenant project isolation and the audit pipeline (roadmap Phase 16,
 * M16.1/M16.3). Projects are scoped by tenant; a principal in one tenant cannot
 * reach another tenant's project. Every authorization decision and deployment is
 * appended to an immutable audit log, so the control plane can show who did what
 * under which approval. Organization policy/profile distribution rides the same
 * registry (a project inherits its org's shared policy packs).
 */
import type { Action, Role } from './rbac.js';
import { can } from './rbac.js';

export interface AuditEntry {
  timestamp: string;
  tenant: string;
  project: string;
  actor: string;
  action: Action;
  allowed: boolean;
  detail?: string;
}

export interface ProjectRef {
  tenant: string;
  project: string;
}

interface Project {
  ref: ProjectRef;
  /** principal id → role within this project. */
  members: Map<string, Role>;
  /** Org-distributed policy pack ids the project inherits (M16.3). */
  policyPacks: string[];
}

export class ControlPlane {
  private readonly projects = new Map<string, Project>();
  private readonly audit: AuditEntry[] = [];

  private key(ref: ProjectRef): string {
    return `${ref.tenant}/${ref.project}`;
  }

  createProject(ref: ProjectRef, policyPacks: string[] = []): void {
    if (this.projects.has(this.key(ref)))
      throw new Error(`project ${this.key(ref)} already exists`);
    this.projects.set(this.key(ref), { ref, members: new Map(), policyPacks });
  }

  addMember(ref: ProjectRef, principal: string, role: Role): void {
    const project = this.projects.get(this.key(ref));
    if (project === undefined) throw new Error(`no such project ${this.key(ref)}`);
    project.members.set(principal, role);
  }

  /**
   * Authorize an action. Returns false (and audits the denial) when the project
   * does not exist for this tenant (isolation), the principal is not a member,
   * or the member's role lacks the action.
   */
  authorize(
    ref: ProjectRef,
    principal: string,
    action: Action,
    now: string,
    detail?: string,
  ): boolean {
    const project = this.projects.get(this.key(ref));
    const role = project?.members.get(principal);
    const allowed = role !== undefined && can(role, action);
    this.audit.push({
      timestamp: now,
      tenant: ref.tenant,
      project: ref.project,
      actor: principal,
      action,
      allowed,
      ...(detail === undefined ? {} : { detail }),
    });
    return allowed;
  }

  /** The org-distributed policy packs a project inherits. */
  policyPacks(ref: ProjectRef): string[] {
    return [...(this.projects.get(this.key(ref))?.policyPacks ?? [])];
  }

  /** The immutable audit log, optionally filtered to one project. */
  auditLog(ref?: ProjectRef): AuditEntry[] {
    return ref === undefined
      ? [...this.audit]
      : this.audit.filter((e) => e.tenant === ref.tenant && e.project === ref.project);
  }
}
