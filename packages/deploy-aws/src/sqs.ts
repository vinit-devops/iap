/**
 * `aws:sqs:Queue` handler (@aws-sdk/client-sqs).
 *
 * read → GetQueueUrl (+ GetQueueAttributes / ListQueueTags)
 * create → CreateQueue, TagQueue
 * update → SetQueueAttributes (mutable attributes only)
 * delete → DeleteQueue
 *
 * The physical queue name is the plan resourceId; FIFO queues get the required
 * `.fifo` suffix. FifoQueue is immutable, so it is set at create time and
 * excluded from SetQueueAttributes on update.
 */

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  SetQueueAttributesCommand,
  TagQueueCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['NonExistentQueue', 'QueueDoesNotExist'] as const;

/** desired attribute key → AWS queue attribute name. */
const ATTR_MAP: ReadonlyArray<readonly [string, string]> = [
  ['fifoQueue', 'FifoQueue'],
  ['contentBasedDeduplication', 'ContentBasedDeduplication'],
  ['messageRetentionPeriod', 'MessageRetentionPeriod'],
  ['sqsManagedSseEnabled', 'SqsManagedSseEnabled'],
];

/** AWS attribute name that is immutable after creation. */
const IMMUTABLE = new Set(['FifoQueue']);

/** SQS attributes whose value is a count of SECONDS (AWS wants an integer string). */
const SECONDS_ATTRS = new Set(['MessageRetentionPeriod', 'VisibilityTimeout', 'DelaySeconds']);
const DURATION_UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Coerce an IaP duration (`^[0-9]+(ms|s|m|h|d)$`, e.g. `7d`) to an integer count
 * of seconds as a string, which is what SQS second-valued attributes require.
 * A value that is already a bare integer is passed through unchanged.
 */
function toSecondsString(value: string): string {
  const m = /^([0-9]+)(ms|s|m|h|d)$/.exec(value);
  if (m === null) return value; // already integer seconds (or leave for AWS to reject)
  const amount = Number(m[1]);
  const unit = m[2] ?? 's';
  const factor = DURATION_UNIT_SECONDS[unit] ?? 1;
  return String(Math.round(amount * factor));
}

export class SqsQueueHandler implements TargetHandler {
  static readonly targetType = 'aws:sqs:Queue' as const;
  readonly targetType = SqsQueueHandler.targetType;
  /** FifoQueue cannot change after creation — drift on it means replace (ADR-0006). */
  readonly immutableProjectionKeys = ['fifoQueue'] as const;

  constructor(private readonly client: SQSClient) {}

  private queueName(resource: PlanResource): string {
    const base = resourceIdOf(resource);
    const fifo = scalarStr(resource.desiredAttributes['fifoQueue']) === 'true';
    return fifo && !base.endsWith('.fifo') ? `${base}.fifo` : base;
  }

  private attributes(resource: PlanResource): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, awsKey] of ATTR_MAP) {
      const value = resource.desiredAttributes[key];
      if (value === undefined) continue;
      let str = scalarStr(value);
      // SQS `FifoQueue` accepts only "true"; for a standard queue it MUST be
      // omitted entirely (passing "false" → "Unknown Attribute FifoQueue").
      if (awsKey === 'FifoQueue' && str !== 'true') continue;
      // Second-valued attributes arrive as IaP durations (e.g. "7d") — SQS wants
      // an integer count of seconds.
      if (SECONDS_ATTRS.has(awsKey)) str = toSecondsString(str);
      out[awsKey] = str;
    }
    return out;
  }

  /**
   * Normalize a raw projection so the DESIRED form and the LIVE form of a
   * converged queue compare equal: second-valued attrs → integer seconds;
   * boolean-ish attrs → "true"/"false" (AWS omits false booleans on read).
   */
  private normalizeProjection(raw: Record<string, string>): Record<string, string> {
    const boolish = new Set(['fifoQueue', 'contentBasedDeduplication', 'sqsManagedSseEnabled']);
    const out: Record<string, string> = {};
    for (const [key] of ATTR_MAP) {
      const v = raw[key] ?? '';
      if (key === 'messageRetentionPeriod') out[key] = toSecondsString(v);
      else if (boolish.has(key)) out[key] = v === 'true' ? 'true' : 'false';
      else out[key] = v;
    }
    return out;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const raw: Record<string, string> = {};
    for (const [key] of ATTR_MAP) raw[key] = scalarStr(resource.desiredAttributes[key]);
    const projection: Record<string, string> = {
      ...this.normalizeProjection(raw),
      // Dead-letter posture (M22.1): compared only when the plan sets it.
      redriveMaxReceiveCount: scalarStr(resource.desiredAttributes['redriveMaxReceiveCount']),
    };
    // SQS defaults managed SSE to ON — an unpinned plan must not read the
    // AWS default as drift (M22.1 live finding). Desired-gated like redrive.
    if (resource.desiredAttributes['sqsManagedSseEnabled'] === undefined) {
      projection['sqsManagedSseEnabled'] = '';
    }
    return projection;
  }

  /** The handler-owned dead-letter queue name (FIFO suffix preserved). */
  private dlqName(resource: PlanResource): string {
    const main = this.queueName(resource);
    return main.endsWith('.fifo')
      ? `${main.slice(0, -'.fifo'.length)}-dlq.fifo`
      : `${main}-dlq`;
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const QueueName = this.queueName(resource);
    let QueueUrl: string | undefined;
    try {
      const found = await this.client.send(new GetQueueUrlCommand({ QueueName }));
      QueueUrl = found.QueueUrl;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    const attrs = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
    );
    const tagResult = await this.client.send(new ListQueueTagsCommand({ QueueUrl }));
    const tags = tagResult.Tags ?? {};
    const current: Record<string, string | undefined> = attrs.Attributes ?? {};

    const rawProjection: Record<string, string> = {};
    for (const [key, awsKey] of ATTR_MAP) rawProjection[key] = current[awsKey] ?? '';
    const projection = this.normalizeProjection(rawProjection);

    // Redrive posture mirrors only when the plan pins it (absent-equals-empty).
    let redriveMaxReceiveCount = '';
    if (scalarStr(resource.desiredAttributes['redriveMaxReceiveCount']) !== '') {
      try {
        const policy = JSON.parse(current['RedrivePolicy'] ?? '{}') as {
          maxReceiveCount?: number;
        };
        redriveMaxReceiveCount =
          policy.maxReceiveCount === undefined ? '' : String(policy.maxReceiveCount);
      } catch {
        redriveMaxReceiveCount = '';
      }
    }
    projection['redriveMaxReceiveCount'] = redriveMaxReceiveCount;
    if (resource.desiredAttributes['sqsManagedSseEnabled'] === undefined) {
      projection['sqsManagedSseEnabled'] = '';
    }

    const state: ResourceState = { exists: true, managed: isManaged(tags), tags, projection };
    if (QueueUrl !== undefined) state.identifier = QueueUrl;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const QueueName = this.queueName(resource);
    const Attributes = this.attributes(resource);
    const redrive = await this.ensureDlq(resource, tags);
    if (redrive !== undefined) Attributes['RedrivePolicy'] = redrive;
    const created = await this.client.send(new CreateQueueCommand({ QueueName, Attributes }));
    const QueueUrl = created.QueueUrl ?? '';
    await this.client.send(new TagQueueCommand({ QueueUrl, Tags: tags }));
    return QueueUrl || `sqs:${QueueName}`;
  }

  /**
   * When the plan asks for redrive, the handler owns a `<name>-dlq` sibling:
   * created (idempotently) before the main queue; returns the RedrivePolicy.
   */
  private async ensureDlq(
    resource: PlanResource,
    tags: Record<string, string>,
  ): Promise<string | undefined> {
    const maxReceive = scalarStr(resource.desiredAttributes['redriveMaxReceiveCount']);
    if (maxReceive === '') return undefined;
    const dlqName = this.dlqName(resource);
    const fifo = dlqName.endsWith('.fifo');
    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        ...(fifo ? { Attributes: { FifoQueue: 'true' } } : {}),
      }),
    );
    const dlqUrl = created.QueueUrl ?? '';
    await this.client.send(new TagQueueCommand({ QueueUrl: dlqUrl, Tags: tags }));
    const attrs = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );
    const arn = attrs.Attributes?.['QueueArn'];
    if (arn === undefined) throw new Error(`dead-letter queue ${dlqName} has no ARN`);
    return JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: Number(maxReceive) });
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const QueueUrl = current.identifier ?? '';
    const mutable: Record<string, string> = {};
    for (const [awsKey, value] of Object.entries(this.attributes(resource))) {
      if (!IMMUTABLE.has(awsKey)) mutable[awsKey] = value;
    }
    const redrive = await this.ensureDlq(resource, current.tags);
    if (redrive !== undefined) mutable['RedrivePolicy'] = redrive;
    await this.client.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: mutable }));
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    await this.client.send(new DeleteQueueCommand({ QueueUrl: current.identifier ?? '' }));
    // Remove the handler-owned DLQ sibling if one exists (zero orphans).
    try {
      const dlq = await this.client.send(
        new GetQueueUrlCommand({ QueueName: this.dlqName(resource) }),
      );
      if (dlq.QueueUrl !== undefined) {
        await this.client.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }));
      }
    } catch (err) {
      if (!nameMatches(err, NOT_FOUND)) throw err;
    }
  }
}
