/**
 * `aws:states:StateMachine` handler (@aws-sdk/client-sfn) — the Workflow kind's
 * Step Functions state machine (M23.4).
 *
 * IDENTITY — the state machine Name is the resourceId, but every Step Functions
 * operation is ARN-driven. State machines carry an ACCOUNT/REGION-scoped ARN
 * that embeds the name (`arn:aws:states:<region>:<acct>:stateMachine:<name>`),
 * yet the create response is the only place the ARN is handed back, so the
 * handler resolves it by paginating ListStateMachines until
 * `name === resourceIdOf(...)` and keeps `stateMachineArn` internal
 * (backup.ts / apprunner.ts name→ARN idiom).
 *
 *   read   → ListStateMachines (paginate) → DescribeStateMachine +
 *            ListTagsForResource (by the SM ARN). Absent when no name match,
 *            or when the machine is DELETING (async teardown — the name lingers
 *            in ListStateMachines briefly; honest read reports it gone).
 *   create → CreateStateMachine: Name = resourceId, Type from attr `type`
 *            (default EXPRESS — cheap/fast; STANDARD also valid), RoleArn from
 *            attr `roleArn` (REQUIRED — fail closed if absent; the mapping wires
 *            a sibling aws:iam:Role with a states.amazonaws.com trust policy),
 *            Definition from attr `definition` (default: a minimal valid ASL
 *            Pass-state), logging off by default, Tags.
 *   update → UpdateStateMachine (Definition and/or RoleArn — both mutable in
 *            place) + TagResource. Type CANNOT change in place.
 *   delete → DeleteStateMachine by the resolved ARN. Deletion is asynchronous
 *            (Status → DELETING); the live driver polls, not us.
 *
 * REPLACEMENT (ADR-0006): `type` is IMMUTABLE — EXPRESS ↔ STANDARD cannot
 * convert in place, so type drift classifies as `replace` (gated delete+create).
 * `roleArn` and `definition` reconcile in place via UpdateStateMachine.
 * `definition` is normalized to canonical JSON (parse + key-sorted re-stringify)
 * on both sides so whitespace/key-order differences are NOT reported as drift.
 */

import {
  CreateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeStateMachineCommand,
  ListStateMachinesCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UpdateStateMachineCommand,
} from '@aws-sdk/client-sfn';
import type { SFNClient, StateMachineType, Tag } from '@aws-sdk/client-sfn';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

const DEFAULT_TYPE = 'EXPRESS';
/** Minimal valid Amazon States Language: a single Pass state that ends. */
const DEFAULT_DEFINITION =
  '{"Comment":"iap","StartAt":"Done","States":{"Done":{"Type":"Pass","End":true}}}';

/** Recursively sort object keys so canonical JSON is order-independent. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Normalize an ASL definition for stable drift comparison: parse then
 * re-stringify with sorted keys and no incidental whitespace. Invalid JSON is
 * compared verbatim (trimmed) — an honest, non-crashing fallback.
 */
function canonicalJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.stringify(sortDeep(JSON.parse(trimmed)));
  } catch {
    return trimmed;
  }
}

/** SFN tags are `{ key, value }` (lowercase) — not the `{ Key, Value }` shape. */
function toSfnTags(tags: Record<string, string>): Tag[] {
  return Object.keys(tags)
    .sort()
    .map((key) => ({ key, value: tags[key] ?? '' }));
}

function fromSfnTags(list: readonly Tag[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const entry of list) {
    if (entry.key !== undefined) tags[entry.key] = entry.value ?? '';
  }
  return tags;
}

export class StateMachineHandler implements TargetHandler {
  static readonly targetType = 'aws:states:StateMachine' as const;
  readonly targetType = StateMachineHandler.targetType;
  /** EXPRESS ↔ STANDARD cannot convert in place (ADR-0006). */
  readonly immutableProjectionKeys = ['type'] as const;

  constructor(private readonly sfn: SFNClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      type: scalarStr(a['type']) || DEFAULT_TYPE,
      roleArn: scalarStr(a['roleArn']),
      definition: canonicalJson(scalarStr(a['definition']) || DEFAULT_DEFINITION),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const arn = await this.resolveArn(resourceIdOf(resource));
    if (arn === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const found = await this.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
    // DELETING is terminal — the name lingers in ListStateMachines during the
    // async teardown, but the machine is gone (apprunner DELETED idiom).
    if (found.status === 'DELETING') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tagResult = await this.sfn.send(new ListTagsForResourceCommand({ resourceArn: arn }));
    const tags = fromSfnTags(tagResult.tags ?? []);

    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: arn,
      projection: {
        type: found.type ?? '',
        roleArn: found.roleArn ?? '',
        definition: canonicalJson(found.definition ?? ''),
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const roleArn = this.roleArnOf(resource, d);
    const created = await this.sfn.send(
      new CreateStateMachineCommand({
        name,
        type: d['type'] as StateMachineType,
        roleArn,
        definition: d['definition'],
        tags: toSfnTags(tags),
      }),
    );
    return created.stateMachineArn ?? `states:stateMachine/${name}`;
  }

  /** Definition and/or RoleArn reconcile in place; type drift is a replace. */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const arn = await this.arnOf(resource, current);
    const d = this.desiredProjection(resource);
    const roleArn = this.roleArnOf(resource, d);
    await this.sfn.send(
      new UpdateStateMachineCommand({
        stateMachineArn: arn,
        definition: d['definition'],
        roleArn,
      }),
    );
    await this.sfn.send(
      new TagResourceCommand({ resourceArn: arn, tags: toSfnTags(current.tags) }),
    );
  }

  /** Async delete by resolved ARN; DELETING is terminal (live driver polls). */
  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const arn = await this.arnOf(resource, current);
    await this.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: arn }));
  }

  /**
   * RoleArn is mandatory — Step Functions has no default execution role. The
   * mapping wires a sibling aws:iam:Role (states.amazonaws.com trust); a
   * missing roleArn fails closed rather than creating a broken machine.
   */
  private roleArnOf(resource: PlanResource, desired: Record<string, string>): string {
    const roleArn = desired['roleArn'];
    if (!roleArn) {
      throw new Error(
        `state machine ${resourceIdOf(resource)} needs a roleArn attribute ` +
          `(states.amazonaws.com execution role) — fail closed`,
      );
    }
    return roleArn;
  }

  /** ARN from the read state when available, else re-resolved by name. */
  private async arnOf(resource: PlanResource, current: ResourceState): Promise<string> {
    const name = resourceIdOf(resource);
    const arn = current.identifier ?? (await this.resolveArn(name));
    if (arn === undefined) {
      throw new Error(`state machine ${name} not found by name — refusing blind operation`);
    }
    return arn;
  }

  /**
   * Name → ARN resolution: paginate ListStateMachines until the page carrying
   * the matching `name`. The ARN never leaves the handler.
   */
  private async resolveArn(name: string): Promise<string | undefined> {
    let nextToken: string | undefined;
    do {
      const page = await this.sfn.send(new ListStateMachinesCommand({ nextToken }));
      const match = (page.stateMachines ?? []).find((m) => m.name === name);
      if (match?.stateMachineArn !== undefined) return match.stateMachineArn;
      nextToken = page.nextToken;
    } while (nextToken !== undefined);
    return undefined;
  }
}
