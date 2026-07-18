/**
 * `aws:scheduler:Schedule` handler (@aws-sdk/client-scheduler) — the Job
 * kind's cron trigger (M22.1).
 *
 * OWNERSHIP (M22.1 live finding): Scheduler tags apply to schedule GROUPS,
 * never schedules — TagResource/ListTagsForResource reject schedule ARNs. The
 * handler therefore owns a per-resource schedule group (named after the
 * resource) that carries the iap:managed tags; the schedule lives inside it
 * and is deleted with it.
 *
 * read → GetSchedule (in the owned group) + group tags
 * create → CreateScheduleGroup (tagged) + CreateSchedule targeting the
 *          sibling Lambda function (name convention: same resourceId)
 * update → UpdateSchedule
 * delete → DeleteSchedule + DeleteScheduleGroup
 *
 * IaP cron (`0 3 * * *` / `@daily`) coerces to Scheduler `cron(...)`/`rate(...)`.
 */

import {
  CreateScheduleCommand,
  CreateScheduleGroupCommand,
  DeleteScheduleCommand,
  DeleteScheduleGroupCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  ListTagsForResourceCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { GetFunctionCommand } from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;
const ALREADY_EXISTS = ['ConflictException'] as const;

/** IaP schedule (5-field cron or @macro) → EventBridge Scheduler expression. */
export function toScheduleExpression(schedule: string): string {
  const macros: Record<string, string> = {
    '@hourly': 'rate(1 hour)',
    '@daily': 'rate(1 day)',
    '@weekly': 'rate(7 days)',
    '@monthly': 'cron(0 0 1 * ? *)',
  };
  const macro = macros[schedule];
  if (macro !== undefined) return macro;
  // 5-field cron → 6-field AWS cron: day-of-month/day-of-week exclusivity
  // (AWS requires one of them to be `?`).
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return schedule; // pass through; AWS validates
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const awsDom = dow !== '*' && dom === '*' ? '?' : dom;
  const awsDow = awsDom === '?' ? dow : '?';
  return `cron(${minute} ${hour} ${awsDom} ${month} ${awsDow} *)`;
}

export class SchedulerScheduleHandler implements TargetHandler {
  static readonly targetType = 'aws:scheduler:Schedule' as const;
  readonly targetType = SchedulerScheduleHandler.targetType;

  constructor(
    private readonly client: SchedulerClient,
    private readonly lambda: LambdaClient,
    private readonly iam: IAMClient,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      scheduleExpression: toScheduleExpression(scalarStr(a['scheduleExpression']) || '@daily'),
      retries: scalarStr(a['retries']) || '0',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const Name = resourceIdOf(resource);
    let schedule;
    try {
      schedule = await this.client.send(new GetScheduleCommand({ Name, GroupName: Name }));
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    // Ownership tags live on the handler-owned schedule GROUP.
    let tags: Record<string, string> = {};
    try {
      const group = await this.client.send(new GetScheduleGroupCommand({ Name }));
      if (group.Arn !== undefined) {
        const tagResult = await this.client.send(
          new ListTagsForResourceCommand({ ResourceArn: group.Arn }),
        );
        tags = fromTagList(tagResult.Tags ?? []);
      }
    } catch (err) {
      if (!nameMatches(err, NOT_FOUND)) throw err;
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        scheduleExpression: schedule.ScheduleExpression ?? '',
        retries: String(schedule.Target?.RetryPolicy?.MaximumRetryAttempts ?? 0),
      },
    };
    if (schedule.Arn !== undefined) state.identifier = schedule.Arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const Name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    try {
      await this.client.send(
        new CreateScheduleGroupCommand({ Name, Tags: toTagList(tags) }),
      );
    } catch (err) {
      if (!nameMatches(err, ALREADY_EXISTS)) throw err;
    }
    // Name-convention siblings emitted by the Job mapping (same resourceId).
    const [fn, role] = await Promise.all([
      this.lambda.send(new GetFunctionCommand({ FunctionName: Name })),
      this.iam.send(new GetRoleCommand({ RoleName: Name })),
    ]);
    const targetArn = fn.Configuration?.FunctionArn;
    const roleArn = role.Role?.Arn;
    if (targetArn === undefined || roleArn === undefined) {
      throw new Error(`schedule ${Name} needs sibling function + role (name convention)`);
    }

    const created = await this.client.send(
      new CreateScheduleCommand({
        Name,
        GroupName: Name,
        ScheduleExpression: d['scheduleExpression'],
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: {
          Arn: targetArn,
          RoleArn: roleArn,
          RetryPolicy: { MaximumRetryAttempts: Number(d['retries']) },
        },
      }),
    );
    return created.ScheduleArn ?? `scheduler:schedule/${Name}/${Name}`;
  }

  async update(resource: PlanResource, _current: ResourceState): Promise<void> {
    const Name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const [fn, role] = await Promise.all([
      this.lambda.send(new GetFunctionCommand({ FunctionName: Name })),
      this.iam.send(new GetRoleCommand({ RoleName: Name })),
    ]);
    await this.client.send(
      new UpdateScheduleCommand({
        Name,
        GroupName: Name,
        ScheduleExpression: d['scheduleExpression'],
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: {
          Arn: fn.Configuration?.FunctionArn ?? '',
          RoleArn: role.Role?.Arn ?? '',
          RetryPolicy: { MaximumRetryAttempts: Number(d['retries']) },
        },
      }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    const Name = resourceIdOf(resource);
    await this.client.send(new DeleteScheduleCommand({ Name, GroupName: Name }));
    try {
      await this.client.send(new DeleteScheduleGroupCommand({ Name }));
    } catch (err) {
      if (!nameMatches(err, NOT_FOUND)) throw err;
    }
  }
}
