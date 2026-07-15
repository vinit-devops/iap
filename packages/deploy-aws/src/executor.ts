/**
 * `AwsExecutor` — applies a `ProviderPlan` to live AWS across the three v0.1
 * golden-path target types.
 *
 * The live gate is a code-level default: `plan()` and `apply()` issue ONLY
 * read/describe calls unless the caller passes `apply: true`. With the gate
 * closed the executor behaves as a dry run — it reads, classifies each object
 * (create | no-op | update | delete), and issues zero mutating commands.
 *
 * `apply()` never throws across its boundary: per-object failures (including a
 * refusal to delete an unmanaged resource, or an unsupported target type) are
 * collected into the structured report. Ordering is deterministic (by
 * logicalId) so repeated runs and hashes are stable.
 */

import type { PlanResource, ProviderPlan } from '@iap/provider-sdk';
import { createClientBundle } from './clients.js';
import type { ClientBundle } from './clients.js';
import { resolveRegion } from './credentials.js';
import type { AwsRuntimeOptions } from './credentials.js';
import { S3BucketHandler } from './s3.js';
import { SqsQueueHandler } from './sqs.js';
import { IamRoleHandler } from './iam.js';
import { MANAGED_TAG_KEY, MANAGED_TAG_VALUE, buildTags } from './tags.js';
import { canonical, errMessage } from './util.js';
import { UnsupportedTargetTypeError, isSupportedTargetType } from './types.js';
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
  /** Inject pre-built clients (e.g. for tests); otherwise clients are created. */
  clients?: Partial<ClientBundle>;
}

export interface PlanOptions {
  /** Classify the plan's resources for teardown (existing → delete). */
  destroy?: boolean;
}

export interface ApplyOptions {
  /** THE LIVE GATE. Mutating calls happen only when this is exactly true. */
  apply?: boolean;
  /** Delete the plan's resources instead of converging them. */
  destroy?: boolean;
  /** Extra caller tags for this run (merged over constructor tags). */
  tags?: Record<string, string>;
}

export class AwsExecutor {
  private readonly region: string;
  private readonly callerTags: Record<string, string>;
  private readonly handlers: Map<string, TargetHandler>;

  constructor(options: AwsExecutorOptions = {}) {
    this.region = resolveRegion(options);
    this.callerTags = options.tags ?? {};
    const base = createClientBundle(options);
    const bundle: ClientBundle = {
      s3: options.clients?.s3 ?? base.s3,
      sqs: options.clients?.sqs ?? base.sqs,
      iam: options.clients?.iam ?? base.iam,
    };
    this.handlers = new Map<string, TargetHandler>([
      ['aws:s3:Bucket', new S3BucketHandler(bundle.s3, this.region)],
      ['aws:sqs:Queue', new SqsQueueHandler(bundle.sqs)],
      ['aws:iam:Role', new IamRoleHandler(bundle.iam)],
    ]);
  }

  /**
   * Dry-run planning: read-only. Fails closed (throws) on any unsupported
   * target type before issuing any call.
   */
  async plan(providerPlan: ProviderPlan, options: PlanOptions = {}): Promise<PlanReport> {
    this.assertSupported(providerPlan);
    const destroy = options.destroy === true;
    const items: PlanItem[] = [];
    for (const resource of this.ordered(providerPlan)) {
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
    const destroy = options.destroy === true;
    const planId = providerPlan.planHash;
    const errors: string[] = [];
    const items: ApplyOutcomeItem[] = [];

    // Fail closed on unsupported target types — but as a recorded error, not a
    // thrown one, to honour the never-throw contract of apply().
    try {
      this.assertSupported(providerPlan);
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

    for (const resource of this.ordered(providerPlan)) {
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
    const drifted =
      canonical(handler.desiredProjection(resource)) !== canonical(current.projection);
    return drifted ? 'update' : 'no-op';
  }

  private reason(action: PlanAction, current: ResourceState): string {
    switch (action) {
      case 'create':
        return 'absent — will create';
      case 'update':
        return 'present but drifted — will reconcile';
      case 'delete':
        return current.managed ? 'managed — will delete' : 'present — will delete if managed';
      case 'no-op':
        return current.exists ? 'present and converged' : 'absent — nothing to do';
    }
  }

  private handler(type: string): TargetHandler {
    const handler = this.handlers.get(type);
    if (!handler) throw new UnsupportedTargetTypeError(type);
    return handler;
  }

  private assertSupported(providerPlan: ProviderPlan): void {
    for (const resource of providerPlan.resources) {
      if (!isSupportedTargetType(resource.type)) {
        throw new UnsupportedTargetTypeError(resource.type);
      }
    }
  }

  private ordered(providerPlan: ProviderPlan): PlanResource[] {
    return [...providerPlan.resources].sort((a, b) =>
      a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0,
    );
  }
}
