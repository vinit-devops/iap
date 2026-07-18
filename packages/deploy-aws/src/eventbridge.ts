/**
 * `aws:events:EventBus` + `aws:events:Rule` handlers
 * (@aws-sdk/client-eventbridge) — the eventing kind (M24.2).
 *
 * EventBus — a custom bus's name IS its identity; nothing else is configurable
 * in scope (an unpinned KMS key / dead-letter config is out of scope here), so
 * the projection is EMPTY and a present bus always reads converged. `update`
 * exists only to reconcile tags (BackupVault idiom). Replacement is N/A.
 *   read   → DescribeEventBus (ResourceNotFoundException → absent) + ListTagsForResource (bus ARN)
 *   create → CreateEventBus (Name, Tags; EventSourceName omitted for a custom bus)
 *   update → TagResource (tags only)
 *   delete → DeleteEventBus
 *
 * Rule — a rule lives ON a bus: `eventBusName` arrives as a desired attribute
 * (cross-resource reference to the sibling EventBus's resourceId; defaults to
 * the account 'default' bus when omitted) and is IMMUTABLE — a rule cannot move
 * buses, so drift on it classifies as replace (gated delete+create, ADR-0006).
 * A rule needs exactly one trigger: an `eventPattern` OR a `scheduleExpression`
 * (fail closed when neither is present). `state`, the trigger, and an optional
 * single `targetArn` (the routesTo edge — a Lambda/SNS/… to invoke) are MUTABLE
 * and reconcile in place via a re-PutRule + PutTargets/RemoveTargets diff.
 *   read   → DescribeRule (Name, EventBusName; ResourceNotFoundException →
 *            absent) + ListTagsForResource + (when a target is pinned)
 *            ListTargetsByRule
 *   create → PutRule (+ PutTargets when a targetArn is pinned)
 *   update → PutRule (re-put reconciles pattern/schedule/state) +
 *            PutTargets/RemoveTargets diff + TagResource
 *   delete → RemoveTargets (ALL) then DeleteRule — order matters: a rule that
 *            still has targets cannot be deleted, and a failed RemoveTargets
 *            must abort the teardown (fail closed), never fall through to
 *            DeleteRule.
 */

import {
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DeleteRuleCommand,
  DescribeEventBusCommand,
  DescribeRuleCommand,
  ListTagsForResourceCommand,
  ListTargetsByRuleCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  TagResourceCommand,
} from '@aws-sdk/client-eventbridge';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;

/** Account bus when a rule does not name a sibling EventBus (AWS default). */
const DEFAULT_EVENT_BUS = 'default';

/** JSON event patterns compare structurally — whitespace is not drift. */
function normalizePattern(pattern: string): string {
  if (pattern === '') return '';
  try {
    return JSON.stringify(JSON.parse(pattern));
  } catch {
    return pattern; // not JSON — compare verbatim, let AWS validate on write
  }
}

export class EventBusHandler implements TargetHandler {
  static readonly targetType = 'aws:events:EventBus' as const;
  readonly targetType = EventBusHandler.targetType;
  // A custom bus has no mutable config beyond its identity+tags — replace N/A.

  constructor(private readonly eventbridge: EventBridgeClient) {}

  /**
   * Empty beyond identity: the bus name IS the resource id and nothing else is
   * configurable in scope, so drift can never classify as update/replace — a
   * present bus is always converged (update only reconciles tags).
   */
  desiredProjection(_resource: PlanResource): Record<string, string> {
    return {};
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const Name = resourceIdOf(resource);
    let arn: string | undefined;
    try {
      const found = await this.eventbridge.send(new DescribeEventBusCommand({ Name }));
      arn = found.Arn;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.eventbridge.send(
        new ListTagsForResourceCommand({ ResourceARN: arn }),
      );
      tags = fromTagList(tagResult.Tags ?? []);
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {},
    };
    if (arn !== undefined) state.identifier = arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const Name = resourceIdOf(resource);
    const created = await this.eventbridge.send(
      new CreateEventBusCommand({ Name, Tags: toTagList(tags) }),
    );
    return created.EventBusArn ?? `events:event-bus/${Name}`;
  }

  /** Projection is identity-only, so this only ever reconciles tags. */
  async update(_resource: PlanResource, current: ResourceState): Promise<void> {
    if (current.identifier !== undefined) {
      await this.eventbridge.send(
        new TagResourceCommand({ ResourceARN: current.identifier, Tags: toTagList(current.tags) }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.eventbridge.send(new DeleteEventBusCommand({ Name: resourceIdOf(resource) }));
  }
}

export class EventRuleHandler implements TargetHandler {
  static readonly targetType = 'aws:events:Rule' as const;
  readonly targetType = EventRuleHandler.targetType;
  /** A rule cannot move buses — eventBusName drift replaces (ADR-0006). */
  readonly immutableProjectionKeys = ['eventBusName'] as const;

  constructor(private readonly eventbridge: EventBridgeClient) {}

  /** The bus this rule lives on — the sibling EventBus id, or the account default. */
  private eventBusName(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['eventBusName']) || DEFAULT_EVENT_BUS;
  }

  /** Deterministic, rule-scoped target id so update/delete can address it. */
  private targetId(resource: PlanResource): string {
    return `${resourceIdOf(resource)}-target`;
  }

  /**
   * The rule's trigger + state in the AWS shape. Fails closed when neither an
   * event pattern nor a schedule expression is present — a rule with no trigger
   * is invalid and must not be created.
   */
  private ruleTrigger(resource: PlanResource): {
    EventPattern?: string;
    ScheduleExpression?: string;
    State: 'ENABLED' | 'DISABLED';
  } {
    const a = resource.desiredAttributes;
    const pattern = scalarStr(a['eventPattern']);
    const schedule = scalarStr(a['scheduleExpression']);
    if (pattern === '' && schedule === '') {
      throw new Error(
        `aws:events:Rule ${resource.logicalId} needs an eventPattern or a scheduleExpression`,
      );
    }
    const State: 'ENABLED' | 'DISABLED' =
      scalarStr(a['enabled']) === 'false' ? 'DISABLED' : 'ENABLED';
    return {
      ...(pattern !== '' ? { EventPattern: pattern } : {}),
      ...(schedule !== '' ? { ScheduleExpression: schedule } : {}),
      State,
    };
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      eventBusName: this.eventBusName(resource),
      eventPattern: normalizePattern(scalarStr(a['eventPattern'])),
      scheduleExpression: scalarStr(a['scheduleExpression']),
      state: scalarStr(a['enabled']) === 'false' ? 'DISABLED' : 'ENABLED',
      // Desired-gated: an unpinned plan compares '' on both sides so a live
      // target it does not manage never reads as drift (timestream KMS idiom).
      targetArn: scalarStr(a['targetArn']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const Name = resourceIdOf(resource);
    const EventBusName = this.eventBusName(resource);
    let rule;
    try {
      rule = await this.eventbridge.send(new DescribeRuleCommand({ Name, EventBusName }));
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (rule.Arn !== undefined) {
      const tagResult = await this.eventbridge.send(
        new ListTagsForResourceCommand({ ResourceARN: rule.Arn }),
      );
      tags = fromTagList(tagResult.Tags ?? []);
    }

    // Only mirror the live target when the plan actually pins one, so an
    // unmanaged target never reads as drift.
    const pinned = resource.desiredAttributes['targetArn'] !== undefined;
    let targetArn = '';
    if (pinned) {
      const targets = await this.eventbridge.send(
        new ListTargetsByRuleCommand({ Rule: Name, EventBusName }),
      );
      targetArn = targets.Targets?.[0]?.Arn ?? '';
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        eventBusName: rule.EventBusName ?? EventBusName,
        eventPattern: normalizePattern(rule.EventPattern ?? ''),
        scheduleExpression: rule.ScheduleExpression ?? '',
        state: rule.State ?? '',
        targetArn,
      },
    };
    if (rule.Arn !== undefined) state.identifier = rule.Arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const Name = resourceIdOf(resource);
    const EventBusName = this.eventBusName(resource);
    const created = await this.eventbridge.send(
      new PutRuleCommand({
        Name,
        EventBusName,
        ...this.ruleTrigger(resource),
        Tags: toTagList(tags),
      }),
    );
    const targetArn = scalarStr(resource.desiredAttributes['targetArn']);
    if (targetArn !== '') {
      await this.eventbridge.send(
        new PutTargetsCommand({
          Rule: Name,
          EventBusName,
          Targets: [{ Id: this.targetId(resource), Arn: targetArn }],
        }),
      );
    }
    return created.RuleArn ?? `events:rule/${EventBusName}/${Name}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const Name = resourceIdOf(resource);
    const EventBusName = this.eventBusName(resource);
    // Re-put reconciles pattern / schedule / state in place.
    await this.eventbridge.send(
      new PutRuleCommand({ Name, EventBusName, ...this.ruleTrigger(resource) }),
    );

    // Target diff (only when the plan manages a target).
    const desiredTarget = scalarStr(resource.desiredAttributes['targetArn']);
    const currentTarget = current.projection['targetArn'] ?? '';
    if (desiredTarget !== '' && desiredTarget !== currentTarget) {
      await this.eventbridge.send(
        new PutTargetsCommand({
          Rule: Name,
          EventBusName,
          Targets: [{ Id: this.targetId(resource), Arn: desiredTarget }],
        }),
      );
    } else if (desiredTarget === '' && currentTarget !== '') {
      await this.eventbridge.send(
        new RemoveTargetsCommand({ Rule: Name, EventBusName, Ids: [this.targetId(resource)] }),
      );
    }

    if (current.identifier !== undefined) {
      await this.eventbridge.send(
        new TagResourceCommand({ ResourceARN: current.identifier, Tags: toTagList(current.tags) }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const Name = resourceIdOf(resource);
    // On replace the rule sits on the OLD bus (the immutable key that drifted) —
    // tear it down where it actually lives, not where it should be.
    const EventBusName = current.projection['eventBusName'] || this.eventBusName(resource);

    // A rule cannot be deleted while it still has targets. Remove them FIRST;
    // a RemoveTargets failure must abort here (fail closed) so DeleteRule is
    // never reached with targets still attached.
    const targets = await this.eventbridge.send(
      new ListTargetsByRuleCommand({ Rule: Name, EventBusName }),
    );
    const ids = (targets.Targets ?? [])
      .map((t) => t.Id)
      .filter((id): id is string => id !== undefined);
    if (ids.length > 0) {
      await this.eventbridge.send(
        new RemoveTargetsCommand({ Rule: Name, EventBusName, Ids: ids }),
      );
    }
    await this.eventbridge.send(new DeleteRuleCommand({ Name, EventBusName }));
  }
}
