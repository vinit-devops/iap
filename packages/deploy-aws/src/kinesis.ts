/**
 * `aws:kinesis:Stream` handler (@aws-sdk/client-kinesis) — the Stream kind's
 * Kinesis data stream (M23.5).
 *
 *   read   → DescribeStreamSummary (by StreamName) + ListTagsForStream.
 *            ResourceNotFoundException → absent; a stream in DELETING status
 *            reads as absent (async teardown — never update or resurrect it).
 *   create → CreateStream with StreamModeDetails.StreamMode from attr
 *            `streamMode` (default ON_DEMAND — no shard capacity to manage, the
 *            cheap posture; PROVISIONED takes ShardCount from `shardCount`,
 *            default 1), then AddTagsToStream. Retention is nudged off the AWS
 *            24h default via Increase/DecreaseStreamRetentionPeriod, and
 *            server-side encryption is turned on with StartStreamEncryption when
 *            the plan pins it. The StreamARN is resolved with a follow-up
 *            DescribeStreamSummary (CreateStream returns no body).
 *   update → UpdateStreamMode (ON_DEMAND ↔ PROVISIONED converts IN PLACE — mode
 *            is MUTABLE, not a replacement) / UpdateShardCount (PROVISIONED only)
 *            / Increase|DecreaseStreamRetentionPeriod / StartStreamEncryption
 *            (desired-gated), then AddTagsToStream to re-assert ownership.
 *   delete → DeleteStream with EnforceConsumerDeletion=true (registered
 *            consumers must not block managed teardown).
 *
 * REPLACEMENT (ADR-0006): N/A — a Kinesis stream has NO immutable projection
 * key. StreamName is the identity (a rename is a different resource), streamMode
 * converts in place, shard count and retention scale in place, and encryption
 * toggles in place. Nothing about the stream forces a destructive delete+create,
 * so `immutableProjectionKeys` is intentionally left undeclared.
 *
 * SHARD COUNT is mode-gated: an ON_DEMAND stream still reports an OpenShardCount
 * (AWS starts it at 4 and autoscales), so the projection compares shard count
 * ONLY when the plan pins PROVISIONED mode — an ON_DEMAND plan must never read
 * the managed shard count as drift. ENCRYPTION is desired-gated (DynamoDB SSE
 * lesson): a plan that pins neither `kmsKeyId` nor `encryption` projects the
 * encryption keys as '' on both sides, so a live default is never drift.
 */

import {
  AddTagsToStreamCommand,
  CreateStreamCommand,
  DecreaseStreamRetentionPeriodCommand,
  DeleteStreamCommand,
  DescribeStreamSummaryCommand,
  IncreaseStreamRetentionPeriodCommand,
  ListTagsForStreamCommand,
  StartStreamEncryptionCommand,
  UpdateShardCountCommand,
  UpdateStreamModeCommand,
} from '@aws-sdk/client-kinesis';
import type { KinesisClient, StreamMode } from '@aws-sdk/client-kinesis';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;
const DEFAULT_MODE = 'ON_DEMAND';
const DEFAULT_SHARD_COUNT = '1';
const DEFAULT_RETENTION_HOURS = '24';
/** AWS-managed KMS key for Kinesis when a plan asks for encryption without a CMK. */
const KINESIS_MANAGED_KEY = 'alias/aws/kinesis';

export class KinesisStreamHandler implements TargetHandler {
  static readonly targetType = 'aws:kinesis:Stream' as const;
  readonly targetType = KinesisStreamHandler.targetType;
  // No immutable projection key — streamMode/shardCount/retention/encryption all
  // reconcile in place, so replacement (ADR-0006) does not apply. Intentionally
  // undeclared (see file header).

  constructor(private readonly kinesis: KinesisClient) {}

  /** True when the plan pins ON-stream encryption (desired-gated comparison). */
  private encryptionPinned(resource: PlanResource): boolean {
    return (
      resource.desiredAttributes['kmsKeyId'] !== undefined ||
      resource.desiredAttributes['encryption'] !== undefined
    );
  }

  private desiredMode(resource: PlanResource): StreamMode {
    return (scalarStr(resource.desiredAttributes['streamMode']) || DEFAULT_MODE) as StreamMode;
  }

  private desiredKeyId(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['kmsKeyId']) || KINESIS_MANAGED_KEY;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const mode = this.desiredMode(resource);
    const projection: Record<string, string> = {
      streamMode: mode,
      // Shard count is meaningful only under PROVISIONED — ON_DEMAND manages its
      // own shards, so it compares as '' on both sides (mode-gated).
      shardCount:
        mode === 'PROVISIONED'
          ? scalarStr(resource.desiredAttributes['shardCount']) || DEFAULT_SHARD_COUNT
          : '',
      retentionHours:
        scalarStr(resource.desiredAttributes['retentionHours']) || DEFAULT_RETENTION_HOURS,
      // Encryption compares only when the plan pins it (DynamoDB SSE lesson).
      encryptionType: '',
      kmsKeyId: '',
    };
    if (this.encryptionPinned(resource)) {
      projection['encryptionType'] = 'KMS';
      projection['kmsKeyId'] = scalarStr(resource.desiredAttributes['kmsKeyId']);
    }
    return projection;
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const StreamName = resourceIdOf(resource);
    let summary;
    try {
      const found = await this.kinesis.send(new DescribeStreamSummaryCommand({ StreamName }));
      summary = found.StreamDescriptionSummary;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (summary === undefined || summary.StreamStatus === 'DELETING') {
      // Deletion in progress — treat as absent; never update a dying stream.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tagResult = await this.kinesis.send(new ListTagsForStreamCommand({ StreamName }));
    const tags = fromTagList(tagResult.Tags ?? []);

    // Streams predating on-demand carry no StreamModeDetails — they are PROVISIONED.
    const liveMode = summary.StreamModeDetails?.StreamMode ?? 'PROVISIONED';
    const desiredMode = this.desiredMode(resource);
    const projection: Record<string, string> = {
      streamMode: liveMode,
      // Mode-gated on the DESIRED mode — an ON_DEMAND plan never compares the
      // managed OpenShardCount (which AWS starts at 4 and autoscales).
      shardCount:
        desiredMode === 'PROVISIONED' && summary.OpenShardCount !== undefined
          ? String(summary.OpenShardCount)
          : '',
      retentionHours:
        summary.RetentionPeriodHours !== undefined ? String(summary.RetentionPeriodHours) : '',
      encryptionType: '',
      kmsKeyId: '',
    };
    if (this.encryptionPinned(resource)) {
      projection['encryptionType'] = summary.EncryptionType === 'KMS' ? 'KMS' : '';
      // Compare the key ARN only when the plan pins a specific CMK.
      projection['kmsKeyId'] =
        scalarStr(resource.desiredAttributes['kmsKeyId']) === '' ? '' : (summary.KeyId ?? '');
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection,
    };
    if (summary.StreamARN !== undefined) state.identifier = summary.StreamARN;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const StreamName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const StreamMode = d['streamMode'] as StreamMode;
    await this.kinesis.send(
      new CreateStreamCommand({
        StreamName,
        StreamModeDetails: { StreamMode },
        // ON_DEMAND must NOT carry a ShardCount; PROVISIONED requires one.
        ...(StreamMode === 'PROVISIONED'
          ? { ShardCount: Number(d['shardCount'] || DEFAULT_SHARD_COUNT) }
          : {}),
      }),
    );
    await this.kinesis.send(new AddTagsToStreamCommand({ StreamName, Tags: tags }));
    // A fresh stream defaults to 24h retention — nudge it only when the plan
    // asks for something else.
    await this.reconcileRetention(StreamName, DEFAULT_RETENTION_HOURS, d['retentionHours'] ?? '');
    if (this.encryptionPinned(resource)) {
      await this.kinesis.send(
        new StartStreamEncryptionCommand({
          StreamName,
          EncryptionType: 'KMS',
          KeyId: this.desiredKeyId(resource),
        }),
      );
    }
    // CreateStream returns no body — resolve the ARN with a summary read.
    const summary = await this.kinesis.send(new DescribeStreamSummaryCommand({ StreamName }));
    return summary.StreamDescriptionSummary?.StreamARN ?? `kinesis:stream/${StreamName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const StreamName = resourceIdOf(resource);
    const StreamARN = current.identifier;
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const desiredMode = d['streamMode'] as StreamMode;
    const modeChanging = d['streamMode'] !== live['streamMode'];

    // ON_DEMAND ↔ PROVISIONED converts in place (mode is mutable, not a replace).
    if (modeChanging && StreamARN !== undefined) {
      await this.kinesis.send(
        new UpdateStreamModeCommand({
          StreamARN,
          StreamModeDetails: { StreamMode: desiredMode },
        }),
      );
    }
    // Shard count scales only under PROVISIONED, and only when the mode is not
    // being flipped this run (a fresh PROVISIONED stream inherits its count from
    // the conversion; a follow-up converge adjusts it if still drifted).
    if (
      desiredMode === 'PROVISIONED' &&
      !modeChanging &&
      d['shardCount'] !== '' &&
      d['shardCount'] !== live['shardCount']
    ) {
      await this.kinesis.send(
        new UpdateShardCountCommand({
          StreamName,
          TargetShardCount: Number(d['shardCount']),
          ScalingType: 'UNIFORM_SCALING',
        }),
      );
    }
    await this.reconcileRetention(
      StreamName,
      live['retentionHours'] ?? '',
      d['retentionHours'] ?? '',
    );
    if (
      this.encryptionPinned(resource) &&
      (d['encryptionType'] !== live['encryptionType'] || d['kmsKeyId'] !== live['kmsKeyId'])
    ) {
      await this.kinesis.send(
        new StartStreamEncryptionCommand({
          StreamName,
          EncryptionType: 'KMS',
          KeyId: this.desiredKeyId(resource),
        }),
      );
    }
    // Re-assert ownership tags (repo idiom).
    await this.kinesis.send(new AddTagsToStreamCommand({ StreamName, Tags: current.tags }));
  }

  async delete(resource: PlanResource, _current: ResourceState): Promise<void> {
    await this.kinesis.send(
      new DeleteStreamCommand({
        StreamName: resourceIdOf(resource),
        EnforceConsumerDeletion: true,
      }),
    );
  }

  /**
   * Nudge retention off `fromHours` to `toHours` in the direction AWS demands:
   * Kinesis has separate Increase/Decrease calls, and each rejects a no-change.
   */
  private async reconcileRetention(
    StreamName: string,
    fromHours: string,
    toHours: string,
  ): Promise<void> {
    if (toHours === '' || toHours === fromHours) return;
    const target = Number(toHours);
    const current = Number(fromHours || DEFAULT_RETENTION_HOURS);
    if (Number.isNaN(target) || target === current) return;
    if (target > current) {
      await this.kinesis.send(
        new IncreaseStreamRetentionPeriodCommand({
          StreamName,
          RetentionPeriodHours: target,
        }),
      );
    } else {
      await this.kinesis.send(
        new DecreaseStreamRetentionPeriodCommand({
          StreamName,
          RetentionPeriodHours: target,
        }),
      );
    }
  }
}
