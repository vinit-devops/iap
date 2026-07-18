/**
 * `AwsExecutor` — applies a `ProviderPlan` to live AWS across the registered
 * target types (see `registry.ts`; the supported set is derived from handler
 * registrations, ADR-0004).
 *
 * The live gate is a code-level default: `plan()` and `apply()` issue ONLY
 * read/describe calls unless the caller passes `apply: true`. With the gate
 * closed the executor behaves as a dry run — it reads, classifies each object
 * (create | no-op | update | replace | delete), and issues zero mutating
 * commands.
 *
 * REPLACEMENT (ADR-0006): drift on a handler-declared immutable projection key
 * classifies as `replace`, never `update`. Replacement is destructive
 * (delete+create) and sits behind its OWN gate — it executes only when the
 * caller passes `replace: true` in addition to `apply: true`, and only for
 * managed resources; otherwise it fails closed as a recorded error.
 *
 * `apply()` never throws across its boundary: per-object failures (including a
 * refusal to delete an unmanaged resource, a closed replacement gate, or an
 * unsupported target type) are collected into the structured report. Ordering
 * is deterministic (by logicalId) so repeated runs and hashes are stable.
 */

import type { PlanResource, ProviderPlan } from '@iap/provider-sdk';
import { createClientBundle } from './clients.js';
import type { ClientBundle } from './clients.js';
import { resolveRegion } from './credentials.js';
import type { AwsRuntimeOptions } from './credentials.js';
import { HANDLER_REGISTRY } from './registry.js';
import type { HandlerContext } from './registry.js';
import { MANAGED_TAG_KEY, MANAGED_TAG_VALUE, buildTags } from './tags.js';
import { errMessage } from './util.js';
import { UnsupportedTargetTypeError } from './types.js';
import type {
  ApplyOutcomeItem,
  ApplyReport,
  PlanAction,
  PlanItem,
  PlanReport,
  ResourceState,
  TargetHandler,
} from './types.js';

export interface AwsExecutorOptions extends AwsRuntimeOptions {
  /** Caller tags merged into every created resource (mandatory tags still win). */
  tags?: Record<string, string>;
  /** Inject pre-built clients (e.g. for tests); otherwise clients are lazy-constructed. */
  clients?: Partial<ClientBundle>;
  /**
   * Extra handler instances keyed by their self-declared targetType — they
   * extend (or shadow) the registry for THIS executor instance. Used by tests
   * and controlled harnesses; the static registry stays the canonical set.
   */
  handlers?: TargetHandler[];
}

export interface PlanOptions {
  /** Classify the plan's resources for teardown (existing → delete). */
  destroy?: boolean;
}

export interface ApplyOptions {
  /** THE LIVE GATE. Mutating calls happen only when this is exactly true. */
  apply?: boolean;
  /**
   * THE REPLACEMENT GATE. A `replace` action (immutable-attribute drift) is
   * destructive delete+create and executes only when this is exactly true —
   * otherwise it is recorded as a refusal, exactly like an unmanaged delete.
   */
  replace?: boolean;
  /** Delete the plan's resources instead of converging them. */
  destroy?: boolean;
  /** Extra caller tags for this run (merged over constructor tags). */
  tags?: Record<string, string>;
}

export class AwsExecutor {
  private readonly region: string;
  private readonly callerTags: Record<string, string>;
  private readonly context: HandlerContext;
  private readonly injected: Map<string, TargetHandler>;
  private readonly instances = new Map<string, TargetHandler>();

  constructor(options: AwsExecutorOptions = {}) {
    this.region = resolveRegion(options);
    this.callerTags = options.tags ?? {};
    this.context = {
      clients: createClientBundle(options, options.clients ?? {}),
      region: this.region,
    };
    this.injected = new Map((options.handlers ?? []).map((h) => [h.targetType, h]));
  }

  /**
   * Dry-run planning: read-only. Fails closed (throws) on any unsupported
   * target type before issuing any call.
   */
  async plan(providerPlan: ProviderPlan, options: PlanOptions = {}): Promise<PlanReport> {
    this.assertSupported(providerPlan);
    const destroy = options.destroy === true;
    const items: PlanItem[] = [];
    for (const resource of this.ordered(providerPlan, destroy)) {
      const handler = this.handler(resource.type);
      const current = await handler.read(resource);
      const action = this.classify(handler, resource, current, destroy);
      items.push({
        logicalId: resource.logicalId,
        targetType: resource.type,
        action,
        reason: this.reason(action, current),
      });
    }
    return { planId: providerPlan.planHash, region: this.region, mode: 'plan', destroy, items };
  }

  /**
   * Execute the plan. Reads always run; mutating commands run ONLY when
   * `options.apply === true`. Never throws across the boundary.
   */
  async apply(providerPlan: ProviderPlan, options: ApplyOptions = {}): Promise<ApplyReport> {
    const gateOpen = options.apply === true;
    const replaceGateOpen = options.replace === true;
    const destroy = options.destroy === true;
    const planId = providerPlan.planHash;
    const errors: string[] = [];
    const items: ApplyOutcomeItem[] = [];

    // Fail closed on unsupported target types and unorderable plans (cycles)
    // — but as recorded errors, not thrown ones, to honour the never-throw
    // contract of apply().
    let orderedResources: PlanResource[];
    try {
      this.assertSupported(providerPlan);
      orderedResources = this.ordered(providerPlan, destroy);
    } catch (err) {
      return {
        planId,
        region: this.region,
        applied: gateOpen,
        mode: gateOpen ? 'apply' : 'dry-run',
        destroy,
        items,
        errors: [errMessage(err)],
      };
    }

    for (const resource of orderedResources) {
      const item: ApplyOutcomeItem = {
        logicalId: resource.logicalId,
        targetType: resource.type,
        action: 'no-op',
        applied: false,
      };
      try {
        const handler = this.handler(resource.type);
        const current = await handler.read(resource);
        const action = this.classify(handler, resource, current, destroy);
        item.action = action;
        if (current.identifier !== undefined) item.identifier = current.identifier;

        if (!gateOpen) {
          // GATE CLOSED: read-only dry run — do not mutate.
          items.push(item);
          continue;
        }

        switch (action) {
          case 'create': {
            const tags = buildTags(planId, resource.logicalId, {
              ...this.callerTags,
              ...options.tags,
            });
            item.identifier = await handler.create(resource, tags);
            item.applied = true;
            break;
          }
          case 'update':
            await handler.update(resource, current);
            item.applied = true;
            break;
          case 'replace': {
            if (!current.managed) {
              // Replacement deletes the existing resource — managed-only, like destroy.
              item.error =
                `refusing to replace ${resource.logicalId}: not tagged ` +
                `${MANAGED_TAG_KEY}=${MANAGED_TAG_VALUE} (managed-only replace)`;
              errors.push(item.error);
              break;
            }
            if (!replaceGateOpen) {
              // REPLACEMENT GATE CLOSED: destructive delete+create needs replace: true.
              item.error =
                `refusing to replace ${resource.logicalId}: immutable attribute drift ` +
                `requires delete+create (destructive); re-run with the replacement gate open`;
              errors.push(item.error);
              break;
            }
            await handler.delete(resource, current);
            const tags = buildTags(planId, resource.logicalId, {
              ...this.callerTags,
              ...options.tags,
            });
            item.identifier = await handler.create(resource, tags);
            item.applied = true;
            break;
          }
          case 'delete': {
            if (!current.managed) {
              // Managed-only destroy: refuse anything not tagged by us.
              item.error =
                `refusing to delete ${resource.logicalId}: not tagged ` +
                `${MANAGED_TAG_KEY}=${MANAGED_TAG_VALUE} (managed-only destroy)`;
              errors.push(item.error);
              break;
            }
            await handler.delete(resource, current);
            item.applied = true;
            break;
          }
          case 'no-op':
            break;
        }
      } catch (err) {
        item.error = errMessage(err);
        errors.push(`${resource.logicalId}: ${item.error}`);
      }
      items.push(item);
    }

    return {
      planId,
      region: this.region,
      applied: gateOpen,
      mode: gateOpen ? 'apply' : 'dry-run',
      destroy,
      items,
      errors,
    };
  }

  private classify(
    handler: TargetHandler,
    resource: PlanResource,
    current: ResourceState,
    destroy: boolean,
  ): PlanAction {
    if (destroy) return current.exists ? 'delete' : 'no-op';
    if (!current.exists) return 'create';
    const desired = handler.desiredProjection(resource);
    const keys = new Set([...Object.keys(desired), ...Object.keys(current.projection)]);
    const driftedKeys = [...keys].filter(
      (key) => (desired[key] ?? '') !== (current.projection[key] ?? ''),
    );
    if (driftedKeys.length === 0) return 'no-op';
    const immutable = new Set(handler.immutableProjectionKeys ?? []);
    return driftedKeys.some((key) => immutable.has(key)) ? 'replace' : 'update';
  }

  private reason(action: PlanAction, current: ResourceState): string {
    switch (action) {
      case 'create':
        return 'absent — will create';
      case 'update':
        return 'present but drifted — will reconcile';
      case 'replace':
        return 'present but immutable attribute drifted — will replace (delete+create)';
      case 'delete':
        return current.managed ? 'managed — will delete' : 'present — will delete if managed';
      case 'no-op':
        return current.exists ? 'present and converged' : 'absent — nothing to do';
    }
  }

  private handler(type: string): TargetHandler {
    const cached = this.instances.get(type);
    if (cached !== undefined) return cached;
    const injected = this.injected.get(type);
    if (injected !== undefined) {
      this.instances.set(type, injected);
      return injected;
    }
    const registration = HANDLER_REGISTRY.get(type);
    if (registration === undefined) throw new UnsupportedTargetTypeError(type);
    const instance = registration.create(this.context);
    this.instances.set(type, instance);
    return instance;
  }

  private supports(type: string): boolean {
    return this.injected.has(type) || HANDLER_REGISTRY.has(type);
  }

  private assertSupported(providerPlan: ProviderPlan): void {
    for (const resource of providerPlan.resources) {
      if (!this.supports(resource.type)) {
        throw new UnsupportedTargetTypeError(resource.type);
      }
    }
  }

  /**
   * Deterministic execution order: topological over `dependsOn` (a resource
   * runs only after every dependency it names), alphabetical by logicalId
   * among the ready set — so plans without dependencies keep the historic
   * pure-alphabetical order. Destroy REVERSES the topology (dependents are
   * deleted before what they depend on — M22.2 live finding: subnet groups /
   * vaults must outlive the clusters / plans built on them). A dependency
   * cycle fails closed; a dependsOn naming a logicalId outside this plan is
   * ignored (cross-plan references are the engine's concern, not ordering's).
   */
  private ordered(providerPlan: ProviderPlan, destroy = false): PlanResource[] {
    const resources = [...providerPlan.resources].sort((a, b) =>
      a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0,
    );
    const inPlan = new Set(resources.map((r) => r.logicalId));
    const indegree = new Map<string, number>(resources.map((r) => [r.logicalId, 0]));
    const dependents = new Map<string, string[]>();
    for (const resource of resources) {
      for (const dep of resource.dependsOn ?? []) {
        if (!inPlan.has(dep) || dep === resource.logicalId) continue;
        indegree.set(resource.logicalId, (indegree.get(resource.logicalId) ?? 0) + 1);
        const list = dependents.get(dep);
        if (list === undefined) dependents.set(dep, [resource.logicalId]);
        else list.push(resource.logicalId);
      }
    }

    const byId = new Map(resources.map((r) => [r.logicalId, r]));
    // `resources` is already alphabetical, so scanning it keeps the ready set
    // deterministic without a priority queue.
    const ordered: PlanResource[] = [];
    const ready = resources.filter((r) => indegree.get(r.logicalId) === 0).map((r) => r.logicalId);
    while (ready.length > 0) {
      const id = ready.shift() as string;
      ordered.push(byId.get(id) as PlanResource);
      for (const dependent of dependents.get(id) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) {
          // Insert keeping the ready queue alphabetical (deterministic).
          const at = ready.findIndex((r) => r > dependent);
          if (at === -1) ready.push(dependent);
          else ready.splice(at, 0, dependent);
        }
      }
    }
    if (ordered.length !== resources.length) {
      const stuck = resources
        .filter((r) => (indegree.get(r.logicalId) ?? 0) > 0)
        .map((r) => r.logicalId);
      throw new Error(`dependsOn cycle among: ${stuck.join(', ')} — refusing to order the plan`);
    }
    return destroy ? ordered.reverse() : ordered;
  }
}
