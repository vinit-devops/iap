/**
 * Execution-level handlers for the mock provider: `executePlan` (execute),
 * `readObject` (read), `importObject` (import), and `verifyConvergence`.
 *
 * Lifecycle semantics follow spec ch. 14 as the engine-side contract the
 * handlers plug into:
 *
 * - **Diff taxonomy (§14.2)** — each plan resource classifies as `create`,
 *   `update`, `replace` (an immutable-after-create attribute changed, per
 *   `MOCK_REPLACE_ON` ∪ the plan's `lifecycle.replaceOn`), or is excluded as
 *   a no-op; managed substrate objects absent from the plan classify
 *   `delete`. A `failed` object with unchanged desired attributes retries as
 *   `update` (§14.2: retries are update-in-place, never no-op).
 * - **Execution graph (§14.3)** — impacted dependents of changed nodes join
 *   as `verify` nodes (readiness re-check only); ordering through excluded
 *   no-op nodes is preserved by transitive-edge insertion.
 * - **Waves (§14.4)** — wave n holds nodes whose longest dependency path is
 *   n, lexicographic within a wave. Delete waves run first, ordered in
 *   reverse (§14.3: a deleted object is removed only after every deleted
 *   object that depends on it).
 * - **Halt-wave failure recovery (§14.7)** — operations in the wave where a
 *   failure occurs run to completion; not-yet-started transitive dependents
 *   are cancelled and stay pending; independent branches complete. The
 *   failed object is set to `failed`, the result outcome to `partial`.
 *   Recovery is re-execution of the same plan: the diff then emits exactly
 *   the unfinished work (resume *is* re-plan).
 *
 * Everything is deterministic: no clock, no randomness, no environment —
 * identity comes from the substrate's injected counter, failures from its
 * injected failure plan.
 */

import { canonicalJsonStringify, compareCodePoints } from '@iap/model';
import type { PlanResource, ProviderPlan, Scalar } from '@iap/provider-sdk';
import type { MockObjectRecord, MockObjectView, MockSubstrate } from './substrate.js';
import { MOCK_REPLACE_ON, generateOutputs, sensitiveFieldsFor } from './substrate.js';

/** Execution-graph node actions (ch. 14 lifecycle vocabulary). */
export type PlanAction = 'create' | 'update' | 'replace' | 'delete' | 'verify';

export interface ExecutedOperation {
  logicalId: string;
  type: string;
  action: PlanAction;
  status: 'applied' | 'failed' | 'cancelled';
  /** Index into `ExecutionResult.waves`. */
  wave: number;
  /** Redacted resulting attributes (applied create/update/replace/verify only). */
  attributes?: Record<string, Scalar>;
  /** Failure reason (`injected-failure`, `exists-unmanaged`, `verify-mismatch`). */
  reason?: string;
}

export interface ExecutionResult {
  planHash: string;
  /** `partial` when any operation failed or was cancelled (§14.7). */
  outcome: 'succeeded' | 'partial';
  /** Wave presentation: logicalIds per wave, delete waves first. */
  waves: string[][];
  /** Operations in execution order (wave order, lexicographic within). */
  operations: ExecutedOperation[];
  /** Deterministic, secret-redacted execution log. */
  log: string[];
  /** Substrate state hash after execution (idempotence witness). */
  stateHash: string;
}

export type ReadResult =
  { ok: true; object: MockObjectView } | { ok: false; reason: 'not-found' | 'injected-failure' };

export type ImportResult =
  | { ok: true; object: MockObjectView; drifted: string[] }
  | { ok: false; reason: 'not-found' | 'already-managed' | 'injected-failure' };

export interface ConvergenceResult {
  converged: boolean;
  /** Human-readable differences; attribute names only, never values. */
  differences: string[];
}

/* ------------------------------------------------------------------ */

function attributesEqual(a: Record<string, Scalar>, b: Record<string, Scalar>): boolean {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}

function changedAttributeNames(
  desired: Record<string, Scalar>,
  current: Record<string, Scalar>,
): string[] {
  const names = new Set([...Object.keys(desired), ...Object.keys(current)]);
  return [...names].filter((name) => desired[name] !== current[name]).sort(compareCodePoints);
}

function replaceOnAttributes(resource: PlanResource): Set<string> {
  return new Set([...(MOCK_REPLACE_ON[resource.type] ?? []), ...resource.lifecycle.replaceOn]);
}

/**
 * Longest-path wave layering (§14.4) over `deps` (restricted to `nodes`).
 * Returns waves as sorted arrays of node ids.
 */
function layerWaves(nodes: readonly string[], deps: ReadonlyMap<string, Set<string>>): string[][] {
  const depth = new Map<string, number>();
  const visit = (id: string, trail: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0; // cycles cannot occur (validated upstream); guard anyway
    trail.add(id);
    let max = -1;
    for (const dep of deps.get(id) ?? []) {
      max = Math.max(max, visit(dep, trail));
    }
    trail.delete(id);
    depth.set(id, max + 1);
    return max + 1;
  };
  const waves: string[][] = [];
  for (const id of [...nodes].sort(compareCodePoints)) {
    const d = visit(id, new Set());
    (waves[d] ??= []).push(id);
  }
  return waves.map((wave) => wave.sort(compareCodePoints));
}

/* ------------------------------------------------------------------ */

/**
 * Execute a provider plan against the substrate: diff, schedule into waves,
 * and apply with halt-wave failure semantics. Executing an already-converged
 * plan is a no-op (empty execution graph, outcome `succeeded`).
 */
export function executePlan(substrate: MockSubstrate, plan: ProviderPlan): ExecutionResult {
  const planResources = new Map<string, PlanResource>(
    plan.resources.map((resource) => [resource.logicalId, resource]),
  );

  // ---- Diff (§14.2) -------------------------------------------------
  const actions = new Map<string, PlanAction>();
  for (const resource of plan.resources) {
    const existing = substrate.getRecord(resource.logicalId);
    if (existing === undefined || !existing.managed) {
      // Unmanaged objects are invisible to the diff; the create step below
      // fails on the conflict (import adopts them first).
      actions.set(resource.logicalId, 'create');
    } else if (existing.status === 'failed') {
      actions.set(resource.logicalId, 'update'); // retry of the same intent
    } else if (!attributesEqual(resource.desiredAttributes, existing.desiredAttributes)) {
      const changed = changedAttributeNames(resource.desiredAttributes, existing.desiredAttributes);
      const immutable = replaceOnAttributes(resource);
      actions.set(
        resource.logicalId,
        changed.some((name) => immutable.has(name)) ? 'replace' : 'update',
      );
    }
    // else: no-op — excluded from the execution graph (may re-join as verify).
  }
  const deletes = substrate
    .listRecords()
    .filter((record) => record.managed && !planResources.has(record.logicalId))
    .map((record) => record.logicalId);

  // ---- Execution graph (§14.3) --------------------------------------
  // Transitive ordering through excluded no-op nodes: expand a dependency to
  // the nearest included nodes reachable through the plan's dependsOn edges.
  const changeNodes = new Set(actions.keys());
  const expandCache = new Map<string, Set<string>>();
  const expandDep = (logicalId: string, trail: Set<string>): Set<string> => {
    const cached = expandCache.get(logicalId);
    if (cached !== undefined) return cached;
    if (trail.has(logicalId)) return new Set();
    trail.add(logicalId);
    const out = new Set<string>();
    if (changeNodes.has(logicalId)) {
      out.add(logicalId);
    } else {
      for (const dep of planResources.get(logicalId)?.dependsOn ?? []) {
        for (const reached of expandDep(dep, trail)) out.add(reached);
      }
    }
    trail.delete(logicalId);
    expandCache.set(logicalId, out);
    return out;
  };

  // Impacted dependents of changed nodes join as verify nodes (§14.3; the
  // mock simplifies "may change bound outputs" to: every impacted dependent
  // verifies).
  const verifyNodes = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const resource of plan.resources) {
      if (changeNodes.has(resource.logicalId) || verifyNodes.has(resource.logicalId)) continue;
      const impacted = resource.dependsOn.some(
        (dep) =>
          changeNodes.has(dep) || verifyNodes.has(dep) || [...expandDep(dep, new Set())].length > 0,
      );
      if (impacted) {
        verifyNodes.add(resource.logicalId);
        grew = true;
      }
    }
  }

  const applyNodes = [...changeNodes, ...verifyNodes];
  const applyDeps = new Map<string, Set<string>>();
  const included = new Set(applyNodes);
  for (const id of applyNodes) {
    const deps = new Set<string>();
    for (const dep of planResources.get(id)?.dependsOn ?? []) {
      if (included.has(dep)) {
        deps.add(dep);
      } else {
        for (const reached of expandDep(dep, new Set())) deps.add(reached);
      }
    }
    applyDeps.set(id, deps);
  }

  // Delete ordering is reversed: dependents are removed before their
  // dependencies (§14.3), using the dependency edges stored at apply time.
  const deleteSet = new Set(deletes);
  const deleteDeps = new Map<string, Set<string>>();
  for (const id of deletes) deleteDeps.set(id, new Set());
  for (const id of deletes) {
    for (const dep of substrate.getRecord(id)?.dependsOn ?? []) {
      if (deleteSet.has(dep)) deleteDeps.get(dep)?.add(id); // reversed edge
    }
  }

  const deleteWaves = layerWaves(deletes, deleteDeps);
  const applyWaves = layerWaves(applyNodes, applyDeps);
  const waves = [...deleteWaves, ...applyWaves];

  // ---- Apply with halt-wave semantics (§14.7) ------------------------
  const operations: ExecutedOperation[] = [];
  const log: string[] = [];
  const blocked = new Set<string>(); // failed or cancelled node ids

  const dependencyBlocked = (id: string, deps: ReadonlyMap<string, Set<string>>): boolean =>
    [...(deps.get(id) ?? [])].some((dep) => blocked.has(dep));

  const record = (operation: ExecutedOperation): void => {
    operations.push(operation);
    const suffix =
      operation.status === 'applied'
        ? operation.attributes !== undefined
          ? ` => ${canonicalJsonStringify(operation.attributes)}`
          : ''
        : ` (${operation.reason ?? operation.status})`;
    log.push(
      `wave ${operation.wave + 1}: ${operation.status === 'applied' ? '' : `${operation.status.toUpperCase()} `}${operation.action} ${operation.logicalId}${suffix}`,
    );
  };

  let waveIndex = 0;
  for (const wave of deleteWaves) {
    for (const logicalId of wave) {
      const existing = substrate.getRecord(logicalId) as MockObjectRecord;
      const base = { logicalId, type: existing.type, action: 'delete' as const, wave: waveIndex };
      if (dependencyBlocked(logicalId, deleteDeps)) {
        blocked.add(logicalId);
        record({ ...base, status: 'cancelled' });
        continue;
      }
      if (substrate.shouldFail(logicalId, 'delete')) {
        existing.status = 'failed';
        blocked.add(logicalId);
        record({ ...base, status: 'failed', reason: 'injected-failure' });
        continue;
      }
      substrate.deleteRecord(logicalId);
      record({ ...base, status: 'applied' });
    }
    waveIndex += 1;
  }

  for (const wave of applyWaves) {
    for (const logicalId of wave) {
      const action = actions.get(logicalId) ?? 'verify';
      const resource = planResources.get(logicalId) as PlanResource;
      const base = { logicalId, type: resource.type, action, wave: waveIndex };
      if (dependencyBlocked(logicalId, applyDeps)) {
        blocked.add(logicalId);
        record({ ...base, status: 'cancelled' });
        continue;
      }

      if (action === 'verify') {
        const existing = substrate.getRecord(logicalId);
        const converged =
          existing !== undefined &&
          existing.managed &&
          existing.status === 'ready' &&
          attributesEqual(resource.desiredAttributes, existing.desiredAttributes);
        if (!converged) {
          blocked.add(logicalId);
          record({ ...base, status: 'failed', reason: 'verify-mismatch' });
        } else {
          record({ ...base, status: 'applied', attributes: substrate.view(existing).attributes });
        }
        continue;
      }

      const operation = action; // create | update | replace
      if (substrate.shouldFail(logicalId, operation)) {
        const existing = substrate.getRecord(logicalId);
        if (existing !== undefined && existing.managed) {
          existing.status = 'failed';
        } else {
          // Failed create: record the placeholder so the model describes
          // reality (§14.7) and the retry classifies as update.
          substrate.setRecord({
            logicalId,
            type: resource.type,
            desiredAttributes: {},
            outputs: {},
            dependsOn: [...resource.dependsOn],
            sensitiveFields: sensitiveFieldsFor(resource.type, resource.sensitiveFields),
            status: 'failed',
            managed: true,
            generation: 0,
            sequence: 0,
          });
        }
        blocked.add(logicalId);
        record({ ...base, status: 'failed', reason: 'injected-failure' });
        continue;
      }

      const existing = substrate.getRecord(logicalId);
      if (action === 'create' && existing !== undefined && !existing.managed) {
        blocked.add(logicalId);
        record({ ...base, status: 'failed', reason: 'exists-unmanaged' });
        continue;
      }

      let next: MockObjectRecord;
      if (action === 'create' || existing === undefined) {
        const sequence = substrate.nextSequence();
        next = {
          logicalId,
          type: resource.type,
          desiredAttributes: { ...resource.desiredAttributes },
          outputs: generateOutputs(resource.type, logicalId, sequence),
          dependsOn: [...resource.dependsOn],
          sensitiveFields: sensitiveFieldsFor(resource.type, resource.sensitiveFields),
          status: 'ready',
          managed: true,
          generation: 1,
          sequence,
        };
      } else if (action === 'replace') {
        // Create successor, rebind, delete predecessor (§14.2): new identity
        // (fresh sequence, fresh generated outputs), lineage in generation.
        const sequence = substrate.nextSequence();
        next = {
          ...existing,
          desiredAttributes: { ...resource.desiredAttributes },
          outputs: generateOutputs(resource.type, logicalId, sequence),
          dependsOn: [...resource.dependsOn],
          sensitiveFields: sensitiveFieldsFor(resource.type, resource.sensitiveFields),
          status: 'ready',
          generation: existing.generation + 1,
          sequence,
        };
      } else {
        // update — in place: identity and generated outputs are retained; a
        // retried failed create generates its outputs now.
        const sequence = existing.sequence === 0 ? substrate.nextSequence() : existing.sequence;
        next = {
          ...existing,
          desiredAttributes: { ...resource.desiredAttributes },
          outputs:
            Object.keys(existing.outputs).length > 0
              ? existing.outputs
              : generateOutputs(resource.type, logicalId, sequence),
          dependsOn: [...resource.dependsOn],
          sensitiveFields: sensitiveFieldsFor(resource.type, resource.sensitiveFields),
          status: 'ready',
          generation: existing.generation + 1,
          sequence,
        };
      }
      substrate.setRecord(next);
      record({ ...base, status: 'applied', attributes: substrate.view(next).attributes });
    }
    waveIndex += 1;
  }

  return {
    planHash: plan.planHash,
    outcome: blocked.size > 0 ? 'partial' : 'succeeded',
    waves,
    operations,
    log,
    stateHash: substrate.stateHash(),
  };
}

/** Read handler: redacted view of one substrate object. */
export function readObject(substrate: MockSubstrate, logicalId: string): ReadResult {
  if (substrate.shouldFail(logicalId, 'read')) {
    return { ok: false, reason: 'injected-failure' };
  }
  const record = substrate.getRecord(logicalId);
  if (record === undefined) return { ok: false, reason: 'not-found' };
  return { ok: true, object: substrate.view(record) };
}

/**
 * Import handler: adopt an existing out-of-band object under management for
 * the given plan resource, reporting (by name only) which desired attributes
 * currently drift from the observed state. Importing a missing or
 * already-managed object fails closed.
 */
export function importObject(substrate: MockSubstrate, resource: PlanResource): ImportResult {
  if (substrate.shouldFail(resource.logicalId, 'import')) {
    return { ok: false, reason: 'injected-failure' };
  }
  const record = substrate.getRecord(resource.logicalId);
  if (record === undefined) return { ok: false, reason: 'not-found' };
  if (record.managed) return { ok: false, reason: 'already-managed' };
  record.managed = true;
  record.dependsOn = [...resource.dependsOn];
  record.sensitiveFields = sensitiveFieldsFor(resource.type, [
    ...record.sensitiveFields,
    ...resource.sensitiveFields,
  ]);
  const drifted = changedAttributeNames(resource.desiredAttributes, record.desiredAttributes);
  return { ok: true, object: substrate.view(record), drifted };
}

/**
 * Convergence verification: every plan resource exists managed, ready, and
 * attribute-exact; no extra managed objects remain. Differences name
 * objects and attributes only — never attribute values (secret hygiene).
 */
export function verifyConvergence(substrate: MockSubstrate, plan: ProviderPlan): ConvergenceResult {
  const differences: string[] = [];
  const planIds = new Set<string>();
  for (const resource of [...plan.resources].sort((a, b) =>
    compareCodePoints(a.logicalId, b.logicalId),
  )) {
    planIds.add(resource.logicalId);
    const record = substrate.getRecord(resource.logicalId);
    if (record === undefined) {
      differences.push(`${resource.logicalId}: missing from the substrate`);
      continue;
    }
    if (!record.managed) differences.push(`${resource.logicalId}: exists but is not managed`);
    if (record.status !== 'ready')
      differences.push(`${resource.logicalId}: status is ${record.status}`);
    for (const name of changedAttributeNames(
      resource.desiredAttributes,
      record.desiredAttributes,
    )) {
      differences.push(`${resource.logicalId}: attribute "${name}" diverges from desired state`);
    }
  }
  for (const record of substrate.listRecords()) {
    if (record.managed && !planIds.has(record.logicalId)) {
      differences.push(`${record.logicalId}: managed object not present in the plan`);
    }
  }
  return { converged: differences.length === 0, differences };
}
