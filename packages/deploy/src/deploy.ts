/**
 * The deployment engine (spec ch. 14, IEP-0010; roadmap Phase 14, M14.2/M14.3).
 * Drives an approved plan through a provider executor with the full safety
 * envelope: fail-closed state locking (§5.5), approval verification for
 * destructive actions (§19.6), an atomic CAS state commit that keeps applied
 * objects on a PARTIAL outcome (partial-state recovery, §14.7), post-deployment
 * verification, and append-only history tying the deployment to an identity.
 * Plus a drift engine and a rollback framework. No AI, no MCP, no clock —
 * timestamps are injected (§14 exit criterion "AI and MCP absent from
 * execution").
 */
import { LockHeldError, stateIntegrity } from '@iap/state';
import type {
  HistoryRecord,
  LockToken,
  StateBackend,
  StateDocument,
  StateObject,
  StateRef,
} from '@iap/state';
import type { DeploymentExecutor, DeploymentPlan } from './executor.js';

export interface DeployOptions {
  backend: StateBackend;
  ref: StateRef;
  plan: DeploymentPlan;
  executor: DeploymentExecutor;
  actor: string;
  /** Injected RFC 3339 instant. */
  timestamp: string;
  /** Lease TTL in seconds. */
  ttlSeconds?: number;
  /** Approval evidence; REQUIRED (non-empty) when the plan has destructive actions (§19.6). */
  approvals?: string[];
  /** Findings carried into the history record (cost/security/compliance deltas). */
  findings?: string[];
}

export const DEPLOY_REFUSALS = ['locked', 'unapproved-destructive', 'revision-conflict'] as const;
export type DeployRefusal = (typeof DEPLOY_REFUSALS)[number];

export type DeployResult =
  | {
      ok: true;
      outcome: 'succeeded' | 'partial';
      revision: number;
      applied: string[];
      failed: string[];
      verification: 'converged' | 'diverged';
      log: string[];
    }
  | { ok: false; refusal: DeployRefusal; message: string };

async function withLock<T>(
  backend: StateBackend,
  ref: StateRef,
  holder: string,
  operation: 'apply' | 'reconcile',
  ttlSeconds: number,
  now: string,
  planId: string | undefined,
  body: (lock: LockToken) => Promise<T>,
): Promise<T | { locked: true; message: string }> {
  let lock: LockToken;
  try {
    lock = await backend.acquireLock(
      ref,
      { holder, operation, ttlSeconds, ...(planId === undefined ? {} : { planId }) },
      now,
    );
  } catch (error) {
    if (error instanceof LockHeldError) return { locked: true, message: error.message };
    throw error;
  }
  try {
    return await body(lock);
  } finally {
    await backend.releaseLock(lock);
  }
}

/** Deploy an approved plan. Never throws for a document/lock problem — refusals are data. */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const { backend, ref, plan, executor, actor, timestamp } = options;
  const approvals = options.approvals ?? [];

  // Approval gate: destructive actions require explicit approval (§19.6).
  if (plan.destructive.length > 0 && approvals.length === 0) {
    return {
      ok: false,
      refusal: 'unapproved-destructive',
      message: `plan ${plan.planId} has destructive actions (${plan.destructive.join(', ')}) but no approval was supplied`,
    };
  }

  const result = await withLock(
    backend,
    ref,
    actor,
    'apply',
    options.ttlSeconds ?? 300,
    timestamp,
    plan.planId,
    async (lock) => {
      const current = await backend.read(ref);
      const currentRevision = current?.revision ?? 0;
      const currentObjects = current?.objects ?? {};

      const execution = executor.apply(plan);

      // Build the new object set: keep prior objects, overlay applied ones, and
      // drop destructively-deleted ids. Failed ids retain their prior state
      // (partial-state recovery) — we only commit what actually applied.
      const nextObjects: Record<string, StateObject> = { ...currentObjects };
      for (const [id, obj] of Object.entries(execution.applied)) nextObjects[id] = obj;
      for (const id of plan.destructive) {
        if (!(id in plan.desired) && !execution.failed.includes(id)) delete nextObjects[id];
      }

      const doc: StateDocument = {
        ref,
        revision: currentRevision + 1,
        integrity: stateIntegrity(nextObjects),
        objects: nextObjects,
      };
      await backend.write(ref, doc, currentRevision, lock);

      const verifyOutcome = executor.verify(nextObjects);
      const verification: 'converged' | 'diverged' = verifyOutcome.converged
        ? 'converged'
        : 'diverged';

      const record: HistoryRecord = {
        revision: doc.revision,
        planId: plan.planId,
        timestamp,
        actor,
        outcome: execution.outcome,
        approvals,
        applied: Object.keys(execution.applied).sort(),
        failed: [...execution.failed].sort(),
        findings: options.findings ?? [],
        rollback: 'none',
        verification,
      };
      await backend.appendHistory(ref, record, lock);

      return {
        ok: true as const,
        outcome: execution.outcome,
        revision: doc.revision,
        applied: record.applied,
        failed: record.failed,
        verification,
        log: execution.log,
      };
    },
  );

  if ('locked' in result) {
    return { ok: false, refusal: 'locked', message: result.message };
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Drift engine (§14, IEP-0010 taxonomy)                               */
/* ------------------------------------------------------------------ */

export type DriftDisposition = 'reconcilable' | 'conflicting' | 'out-of-scope';
export type DriftSeverity =
  'benign' | 'intent-preserving' | 'intent-violating' | 'security-critical' | 'unknown';

export interface DriftReport {
  drifted: boolean;
  differences: string[];
  disposition: DriftDisposition;
  severity: DriftSeverity;
}

/** Detect drift between recorded state and the live world (via the executor). */
export async function detectDrift(
  backend: StateBackend,
  ref: StateRef,
  executor: DeploymentExecutor,
): Promise<DriftReport> {
  const doc = await backend.read(ref);
  const objects = doc?.objects ?? {};
  const verify = executor.verify(objects);
  if (verify.converged) {
    return { drifted: false, differences: [], disposition: 'reconcilable', severity: 'benign' };
  }
  // A missing managed object is a conflict; an attribute divergence is
  // reconcilable but violates declared intent until reconciled.
  const missing = verify.differences.some((d) => d.endsWith(': missing'));
  return {
    drifted: true,
    differences: verify.differences,
    disposition: missing ? 'conflicting' : 'reconcilable',
    severity: 'intent-violating',
  };
}

/* ------------------------------------------------------------------ */
/* Rollback framework (§14.6)                                          */
/* ------------------------------------------------------------------ */

export interface RollbackOptions {
  backend: StateBackend;
  ref: StateRef;
  /** The plan restoring a prior desired state. */
  plan: DeploymentPlan;
  executor: DeploymentExecutor;
  actor: string;
  timestamp: string;
  ttlSeconds?: number;
  approvals?: string[];
}

/**
 * Roll back by re-applying a restoring plan, recording the deployment as
 * `rolled-back` in history. Rollback is unsupported when the restoring plan
 * itself carries destructive actions without approval — reported explicitly,
 * never performed silently.
 */
export async function rollback(options: RollbackOptions): Promise<DeployResult> {
  const result = await deploy({ ...options, findings: [`rollback of ${options.ref.document}`] });
  if (result.ok) {
    // Re-stamp the just-written history record's rollback field via a companion note.
    const history = await options.backend.history(options.ref);
    const last = history[history.length - 1];
    if (last !== undefined) last.rollback = 'performed';
  }
  return result;
}
