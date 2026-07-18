/**
 * `aws:sns:Topic` handler (@aws-sdk/client-sns) — the Topic kind (M22.1).
 *
 * read → GetTopicAttributes (by constructed ARN) + ListTagsForResource
 * create → CreateTopic (FIFO gets the required .fifo suffix)
 * update → SetTopicAttributes (mutable attributes)
 * delete → DeleteTopic
 *
 * FifoTopic is immutable — drift replaces (ADR-0006). SSE uses the AWS-managed
 * SNS key (alias/aws/sns); customer-managed CMKs arrive with KMS in M22.2.
 */

import {
  CreateTopicCommand,
  DeleteTopicCommand,
  GetTopicAttributesCommand,
  ListTagsForResourceCommand,
  SetTopicAttributesCommand,
  TagResourceCommand,
} from '@aws-sdk/client-sns';
import type { SNSClient } from '@aws-sdk/client-sns';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { STSClient } from '@aws-sdk/client-sts';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['NotFoundException', 'NotFound'] as const;
const SNS_MANAGED_KEY = 'alias/aws/sns';

export class SnsTopicHandler implements TargetHandler {
  static readonly targetType = 'aws:sns:Topic' as const;
  readonly targetType = SnsTopicHandler.targetType;
  /** Standard ↔ FIFO cannot convert in place (ADR-0006). */
  readonly immutableProjectionKeys = ['fifoTopic'] as const;

  private accountId: string | undefined;

  constructor(
    private readonly client: SNSClient,
    private readonly sts: STSClient,
    private readonly region: string,
  ) {}

  private topicName(resource: PlanResource): string {
    const base = resourceIdOf(resource);
    const fifo = scalarStr(resource.desiredAttributes['fifoTopic']) === 'true';
    return fifo && !base.endsWith('.fifo') ? `${base}.fifo` : base;
  }

  private async topicArn(resource: PlanResource): Promise<string> {
    if (this.accountId === undefined) {
      const identity = await this.sts.send(new GetCallerIdentityCommand({}));
      this.accountId = identity.Account ?? '';
    }
    return `arn:aws:sns:${this.region}:${this.accountId}:${this.topicName(resource)}`;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      fifoTopic: scalarStr(a['fifoTopic']) === 'true' ? 'true' : 'false',
      sseEnabled: scalarStr(a['sseEnabled']) === 'true' ? 'true' : 'false',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const TopicArn = await this.topicArn(resource);
    let attrs: Record<string, string>;
    try {
      const found = await this.client.send(new GetTopicAttributesCommand({ TopicArn }));
      attrs = found.Attributes ?? {};
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    const tagResult = await this.client.send(
      new ListTagsForResourceCommand({ ResourceArn: TopicArn }),
    );
    const tags = fromTagList(tagResult.Tags ?? []);

    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: TopicArn,
      projection: {
        fifoTopic: attrs['FifoTopic'] === 'true' ? 'true' : 'false',
        sseEnabled: attrs['KmsMasterKeyId'] ? 'true' : 'false',
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const d = this.desiredProjection(resource);
    const Attributes: Record<string, string> = {};
    if (d['fifoTopic'] === 'true') {
      Attributes['FifoTopic'] = 'true';
      const dedup = scalarStr(resource.desiredAttributes['contentBasedDeduplication']);
      if (dedup === 'true') Attributes['ContentBasedDeduplication'] = 'true';
    }
    if (d['sseEnabled'] === 'true') Attributes['KmsMasterKeyId'] = SNS_MANAGED_KEY;
    const created = await this.client.send(
      new CreateTopicCommand({
        Name: this.topicName(resource),
        ...(Object.keys(Attributes).length > 0 ? { Attributes } : {}),
        Tags: toTagList(tags),
      }),
    );
    return created.TopicArn ?? `sns:${this.topicName(resource)}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const TopicArn = current.identifier ?? '';
    const d = this.desiredProjection(resource);
    if (d['sseEnabled'] !== current.projection['sseEnabled']) {
      await this.client.send(
        new SetTopicAttributesCommand({
          TopicArn,
          AttributeName: 'KmsMasterKeyId',
          AttributeValue: d['sseEnabled'] === 'true' ? SNS_MANAGED_KEY : '',
        }),
      );
    }
    await this.client.send(
      new TagResourceCommand({ ResourceArn: TopicArn, Tags: toTagList(current.tags) }),
    );
  }

  async delete(_resource: PlanResource, current: ResourceState): Promise<void> {
    await this.client.send(new DeleteTopicCommand({ TopicArn: current.identifier ?? '' }));
  }
}
