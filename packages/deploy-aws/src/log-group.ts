/**
 * `aws:logs:LogGroup` handler (@aws-sdk/client-cloudwatch-logs) — the derived
 * log posture for Function/Job (M22.1). Owns the `/aws/lambda/<id>` group so
 * retention is managed (Lambda would otherwise auto-create it with
 * never-expire retention) and teardown leaves zero orphans.
 *
 * read → DescribeLogGroups (prefix match) + ListTagsForResource
 * create → CreateLogGroup + PutRetentionPolicy
 * update → PutRetentionPolicy
 * delete → DeleteLogGroup
 */

import {
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  ListTagsForResourceCommand,
  PutRetentionPolicyCommand,
  TagResourceCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;

export class LogGroupHandler implements TargetHandler {
  static readonly targetType = 'aws:logs:LogGroup' as const;
  readonly targetType = LogGroupHandler.targetType;

  constructor(private readonly client: CloudWatchLogsClient) {}

  /** The Lambda log-group convention for the sibling function (same resourceId). */
  private groupName(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['logGroupName']) || `/aws/lambda/${resourceIdOf(resource)}`;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    return { retentionInDays: scalarStr(resource.desiredAttributes['retentionInDays']) || '14' };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = this.groupName(resource);
    const found = await this.client.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: name }),
    );
    const group = (found.logGroups ?? []).find((g) => g.logGroupName === name);
    if (group === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (group.arn !== undefined) {
      try {
        const tagResult = await this.client.send(
          // Log-group tag ARNs must NOT carry the trailing ":*".
          new ListTagsForResourceCommand({ resourceArn: group.arn.replace(/:\*$/, '') }),
        );
        tags = tagResult.tags ?? {};
      } catch (err) {
        if (!nameMatches(err, NOT_FOUND)) throw err;
      }
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        retentionInDays: group.retentionInDays === undefined ? '' : String(group.retentionInDays),
      },
    };
    if (group.arn !== undefined) state.identifier = group.arn.replace(/:\*$/, '');
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const logGroupName = this.groupName(resource);
    await this.client.send(new CreateLogGroupCommand({ logGroupName, tags }));
    await this.client.send(
      new PutRetentionPolicyCommand({
        logGroupName,
        retentionInDays: Number(this.desiredProjection(resource)['retentionInDays']),
      }),
    );
    return `logs:log-group:${logGroupName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const logGroupName = this.groupName(resource);
    await this.client.send(
      new PutRetentionPolicyCommand({
        logGroupName,
        retentionInDays: Number(this.desiredProjection(resource)['retentionInDays']),
      }),
    );
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagResourceCommand({ resourceArn: current.identifier, tags: current.tags }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(new DeleteLogGroupCommand({ logGroupName: this.groupName(resource) }));
  }
}
