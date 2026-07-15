/**
 * The execution seam shared by `iap deploy` and `iap destroy`.
 *
 * SAFETY: production code constructs the real `AwsExecutor` from
 * `@iap/deploy-aws` through {@link defaultExecutorFactory}. Tests replace the
 * factory with {@link setExecutorFactory} so the CLI drives a FAKE executor and
 * never touches AWS. The injected object need only satisfy the structural
 * {@link Executor} contract (`plan()` / `apply()`); nothing here is aware of the
 * AWS SDK beyond the default factory.
 *
 * This module also owns the durable persistence of an apply outcome to the
 * `FileStateBackend` (lease-locked, CAS write, append-only history) so both
 * commands record state identically.
 */

import { AwsExecutor } from '@iap/deploy-aws';
import type { ApplyReport, PlanReport } from '@iap/deploy-aws';
import type { ProviderPlan } from '@iap/provider-sdk';
import { FileStateBackend, stateIntegrity } from '@iap/state';
import type { StateBackend, StateDocument, StateObject, StateRef } from '@iap/state';

/** Read-only plan classification for a provider plan (`create|no-op|update|delete`). */
export interface ExecutorPlanOptions {
  destroy?: boolean;
}

/** Apply options — `apply` is THE LIVE GATE; mutations happen only when it is true. */
export interface ExecutorApplyOptions {
  apply?: boolean;
  destroy?: boolean;
  tags?: Record<string, string>;
}

/** The structural contract both the real `AwsExecutor` and test fakes satisfy. */
export interface Executor {
  plan(providerPlan: ProviderPlan, options?: ExecutorPlanOptions): Promise<PlanReport>;
  apply(providerPlan: ProviderPlan, options?: ExecutorApplyOptions): Promise<ApplyReport>;
}

/** How the executor is constructed for a given region/profile. */
export interface ExecutorEnv {
  region?: string;
  profile?: string;
}

export type ExecutorFactory = (env: ExecutorEnv) => Executor;

/** Production factory: the real AWS runtime. Never used by the test suite. */
export const defaultExecutorFactory: ExecutorFactory = (env) => new AwsExecutor(env);

let overrideFactory: ExecutorFactory | null = null;

/**
 * Install a factory used in place of {@link defaultExecutorFactory} — the test
 * injection seam. Pass `null` to restore the production path.
 */
export function setExecutorFactory(factory: ExecutorFactory | null): void {
  overrideFactory = factory;
}

/** The factory in force: the injected one when set, otherwise the real AWS one. */
export function executorFactory(): ExecutorFactory {
  return overrideFactory ?? defaultExecutorFactory;
}

/** Default state root when `--state` is omitted. */
export const DEFAULT_STATE_DIR = '.iap-state';

/** Open the durable file-backed state backend rooted at `--state` (or default). */
export function openStateBackend(rootDir: string): StateBackend {
  return new FileStateBackend({ rootDir });
}

/** The state identity for a (document, profile) pair. */
export function stateRefFor(documentName: string, profile: string | null): StateRef {
  return { document: documentName, profile };
}

export interface PersistOptions {
  destroy: boolean;
  actor: string;
  /** RFC 3339 instant, injected so lease expiry and history stay deterministic. */
  timestamp: string;
}

/**
 * Durably record an apply outcome: created/updated objects are written into the
 * snapshot (destroyed ones removed), a new monotonic revision is CAS-written
 * under a lease lock, and an immutable history record is appended. Secrets are
 * never stored — only desired attributes and the resource identifier.
 */
export async function persistOutcome(
  backend: StateBackend,
  ref: StateRef,
  providerPlan: ProviderPlan,
  report: ApplyReport,
  options: PersistOptions,
): Promise<StateDocument> {
  const lock = await backend.acquireLock(
    ref,
    { holder: options.actor, operation: 'apply', ttlSeconds: 300, planId: report.planId },
    options.timestamp,
  );
  try {
    const existing = await backend.read(ref);
    const currentRevision = existing?.revision ?? 0;
    const objects: Record<string, StateObject> = { ...(existing?.objects ?? {}) };

    for (const item of report.items) {
      if (!item.applied) continue;
      if (options.destroy) {
        delete objects[item.logicalId];
        continue;
      }
      const resource = providerPlan.resources.find((r) => r.logicalId === item.logicalId);
      objects[item.logicalId] = {
        type: item.targetType,
        attributes: {
          ...(resource?.desiredAttributes ?? {}),
          ...(item.identifier === undefined ? {} : { identifier: item.identifier }),
        },
        managed: true,
        ...(resource !== undefined && resource.dependsOn.length > 0
          ? { dependsOn: [...resource.dependsOn] }
          : {}),
      };
    }

    const doc: StateDocument = {
      ref,
      revision: currentRevision + 1,
      integrity: stateIntegrity(objects),
      objects,
    };
    await backend.write(ref, doc, currentRevision, lock);

    const applied = report.items.filter((i) => i.applied).map((i) => i.logicalId);
    const failed = report.items.filter((i) => i.error !== undefined).map((i) => i.logicalId);
    await backend.appendHistory(
      ref,
      {
        revision: doc.revision,
        planId: report.planId,
        timestamp: options.timestamp,
        actor: options.actor,
        outcome: report.errors.length > 0 ? 'partial' : 'succeeded',
        approvals: [options.actor],
        applied,
        failed,
        findings: [],
      },
      lock,
    );
    return doc;
  } finally {
    await backend.releaseLock(lock);
  }
}
