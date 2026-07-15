/**
 * The provider executor boundary (spec ch. 14; roadmap Phase 14). The
 * deployment engine drives execution through this interface, so it is
 * independent of any one provider. A conformant executor applies desired
 * objects to a substrate (Read/Create/Update/Replace/Delete/Import/Verify) and
 * reports which applied — including a PARTIAL outcome when a step fails (§14.7).
 * The reference `@iap/provider-mock` substrate implements execution; a fixture
 * executor drives the orchestration deterministically in tests.
 */
import type { StateObject } from '@iap/state';

/** One deployment request: the desired object set and the destructive/delete ids. */
export interface DeploymentPlan {
  planId: string;
  /** Desired managed objects, by logical id. */
  desired: Record<string, StateObject>;
  /** Logical ids this plan destroys or replaces (require explicit approval). */
  destructive: string[];
}

export interface ExecutionOutcome {
  outcome: 'succeeded' | 'partial';
  /** Objects successfully applied (committed to state, even on partial). */
  applied: Record<string, StateObject>;
  /** Logical ids that failed to apply. */
  failed: string[];
  /** Deterministic, secret-redacted log. */
  log: string[];
}

export interface VerifyOutcome {
  converged: boolean;
  /** Attribute-name-only differences (never values). */
  differences: string[];
}

/** A provider executor. Pure with respect to IaP: no AI, no MCP (§14 exit criterion). */
export interface DeploymentExecutor {
  apply(plan: DeploymentPlan): ExecutionOutcome;
  /** Verify the world converges to the given desired objects (post-deploy / drift). */
  verify(desired: Record<string, StateObject>): VerifyOutcome;
}

/**
 * A deterministic in-memory executor for driving and testing the orchestration.
 * Applies desired objects to an internal world; `failOn` injects apply failures
 * (exercising partial outcomes and recovery), and `driftOn` makes named objects
 * report divergence at verify time.
 */
export function fixtureExecutor(
  options: { failOn?: string[]; driftOn?: string[] } = {},
): DeploymentExecutor {
  const world: Record<string, StateObject> = {};
  const failOn = new Set(options.failOn ?? []);
  const driftOn = new Set(options.driftOn ?? []);
  return {
    apply(plan) {
      const applied: Record<string, StateObject> = {};
      const failed: string[] = [];
      const log: string[] = [];
      for (const id of Object.keys(plan.desired).sort()) {
        if (failOn.has(id)) {
          failed.push(id);
          log.push(`apply ${id}: injected-failure`);
          continue;
        }
        world[id] = plan.desired[id] as StateObject;
        applied[id] = plan.desired[id] as StateObject;
        log.push(`apply ${id}: applied`);
      }
      // Deletes: ids in the world but not desired (and marked destructive) are removed.
      for (const id of plan.destructive) {
        if (!(id in plan.desired) && id in world) {
          delete world[id];
          log.push(`delete ${id}: applied`);
        }
      }
      return { outcome: failed.length > 0 ? 'partial' : 'succeeded', applied, failed, log };
    },
    verify(desired) {
      const differences: string[] = [];
      for (const id of Object.keys(desired).sort()) {
        if (driftOn.has(id)) differences.push(`${id}: attributes diverged`);
        else if (!(id in world)) differences.push(`${id}: missing`);
      }
      return { converged: differences.length === 0, differences };
    },
  };
}
