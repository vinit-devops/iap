/**
 * M23.5 `aws:kinesis:Stream` handler, mock-tested: on-demand create with iap
 * tags, converged no-op with unpinned encryption/retention (no false drift), the
 * ON_DEMAND→PROVISIONED in-place mode conversion (UpdateStreamMode, NOT a
 * replace), retention Increase/Decrease drift, PROVISIONED shard-count drift
 * (UpdateShardCount), the DELETING→absent read, managed-only destroy refusal,
 * and the replacement-N/A shape (no immutable projection key).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AddTagsToStreamCommand,
  CreateStreamCommand,
  DecreaseStreamRetentionPeriodCommand,
  DeleteStreamCommand,
  DescribeStreamSummaryCommand,
  IncreaseStreamRetentionPeriodCommand,
  KinesisClient,
  ListTagsForStreamCommand,
  StartStreamEncryptionCommand,
  UpdateShardCountCommand,
  UpdateStreamModeCommand,
} from '@aws-sdk/client-kinesis';
import type { StreamDescriptionSummary } from '@aws-sdk/client-kinesis';
import { AwsExecutor, KinesisStreamHandler } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const kinesis = mockClient(KinesisClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => kinesis.reset());

/** A live, ACTIVE, iap-managed ON_DEMAND stream summary. */
function liveSummary(overrides: Partial<StreamDescriptionSummary> = {}): StreamDescriptionSummary {
  return {
    StreamName: 'events',
    StreamARN: 'arn:aws:kinesis:eu-central-1:000000000000:stream/events',
    StreamStatus: 'ACTIVE',
    StreamModeDetails: { StreamMode: 'ON_DEMAND' },
    RetentionPeriodHours: 24,
    OpenShardCount: 4,
    ...overrides,
  } as StreamDescriptionSummary;
}

const managedTags = { Tags: [{ Key: 'iap:managed', Value: 'true' }] };

describe('aws:kinesis:Stream', () => {
  const plan = providerPlan([planResource('events', 'aws:kinesis:Stream')]);

  it('absent → CreateStream ON_DEMAND (no ShardCount) + AddTagsToStream with iap tags', async () => {
    kinesis
      .on(DescribeStreamSummaryCommand)
      .rejectsOnce(serviceError('ResourceNotFoundException'))
      .resolves({ StreamDescriptionSummary: liveSummary() });
    kinesis.on(CreateStreamCommand).resolves({});
    kinesis.on(AddTagsToStreamCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(
      'arn:aws:kinesis:eu-central-1:000000000000:stream/events',
    );
    const create = kinesis.commandCalls(CreateStreamCommand)[0]?.args[0].input;
    expect(create?.StreamName).toBe('events');
    expect(create?.StreamModeDetails?.StreamMode).toBe('ON_DEMAND');
    expect(create?.ShardCount).toBeUndefined(); // ON_DEMAND manages its own shards
    const tags = kinesis.commandCalls(AddTagsToStreamCommand)[0]?.args[0].input?.Tags;
    expect(tags?.['iap:managed']).toBe('true');
    expect(tags?.['iap:planId']).toBeDefined();
    expect(tags?.['iap:resourceId']).toBeDefined();
    // Default retention (24h) matches a fresh stream — no retention nudge.
    expect(kinesis.commandCalls(IncreaseStreamRetentionPeriodCommand)).toHaveLength(0);
    expect(kinesis.commandCalls(DecreaseStreamRetentionPeriodCommand)).toHaveLength(0);
    expect(kinesis.commandCalls(StartStreamEncryptionCommand)).toHaveLength(0); // unpinned
  });

  it('PROVISIONED create carries ShardCount from the plan', async () => {
    const provisioned = providerPlan([
      planResource('events', 'aws:kinesis:Stream', {
        streamMode: 'PROVISIONED',
        shardCount: 3,
      }),
    ]);
    kinesis
      .on(DescribeStreamSummaryCommand)
      .rejectsOnce(serviceError('ResourceNotFoundException'))
      .resolves({ StreamDescriptionSummary: liveSummary() });
    kinesis.on(CreateStreamCommand).resolves({});
    kinesis.on(AddTagsToStreamCommand).resolves({});

    await executor().apply(provisioned, { apply: true });
    const create = kinesis.commandCalls(CreateStreamCommand)[0]?.args[0].input;
    expect(create?.StreamModeDetails?.StreamMode).toBe('PROVISIONED');
    expect(create?.ShardCount).toBe(3);
  });

  it('present + converged → no-op; unpinned encryption/retention read no drift', async () => {
    // Live stream reports an OpenShardCount (4) and a 24h retention; an
    // ON_DEMAND plan that pins neither shards, retention, nor encryption must
    // read as converged.
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary({
        EncryptionType: 'KMS', // a live default — must NOT be drift when unpinned
        KeyId: 'alias/aws/kinesis',
      }),
    });
    kinesis.on(ListTagsForStreamCommand).resolves(managedTags);

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(kinesis.commandCalls(CreateStreamCommand)).toHaveLength(0);
    expect(kinesis.commandCalls(UpdateStreamModeCommand)).toHaveLength(0);
    expect(kinesis.commandCalls(DeleteStreamCommand)).toHaveLength(0);
  });

  it('streamMode ON_DEMAND→PROVISIONED converts IN PLACE via UpdateStreamMode (not a replace)', async () => {
    const provisioned = providerPlan([
      planResource('events', 'aws:kinesis:Stream', {
        streamMode: 'PROVISIONED',
        shardCount: 1,
      }),
    ]);
    // Live: ON_DEMAND with a single open shard, so only the mode drifts.
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary({
        StreamModeDetails: { StreamMode: 'ON_DEMAND' },
        OpenShardCount: 1,
      }),
    });
    kinesis.on(ListTagsForStreamCommand).resolves(managedTags);
    kinesis.on(UpdateStreamModeCommand).resolves({});
    kinesis.on(AddTagsToStreamCommand).resolves({});

    const planned = await executor().plan(provisioned);
    expect(planned.items[0]?.action).toBe('update'); // mutable, NOT replace

    const report = await executor().apply(provisioned, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    const mode = kinesis.commandCalls(UpdateStreamModeCommand)[0]?.args[0].input;
    expect(mode?.StreamARN).toBe('arn:aws:kinesis:eu-central-1:000000000000:stream/events');
    expect(mode?.StreamModeDetails?.StreamMode).toBe('PROVISIONED');
    // No shard change (1 == 1), and no destructive delete.
    expect(kinesis.commandCalls(UpdateShardCountCommand)).toHaveLength(0);
    expect(kinesis.commandCalls(DeleteStreamCommand)).toHaveLength(0);
  });

  it('retention drift → Increase then, in the other direction, Decrease', async () => {
    const longer = providerPlan([
      planResource('events', 'aws:kinesis:Stream', { retentionHours: 48 }),
    ]);
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary({ RetentionPeriodHours: 24 }),
    });
    kinesis.on(ListTagsForStreamCommand).resolves(managedTags);
    kinesis.on(IncreaseStreamRetentionPeriodCommand).resolves({});
    kinesis.on(AddTagsToStreamCommand).resolves({});

    await executor().apply(longer, { apply: true });
    expect(
      kinesis.commandCalls(IncreaseStreamRetentionPeriodCommand)[0]?.args[0].input
        ?.RetentionPeriodHours,
    ).toBe(48);
    expect(kinesis.commandCalls(DecreaseStreamRetentionPeriodCommand)).toHaveLength(0);

    // Now the plan wants LESS retention than the live 168h → Decrease.
    kinesis.reset();
    const shorter = providerPlan([
      planResource('events', 'aws:kinesis:Stream', { retentionHours: 24 }),
    ]);
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary({ RetentionPeriodHours: 168 }),
    });
    kinesis.on(ListTagsForStreamCommand).resolves(managedTags);
    kinesis.on(DecreaseStreamRetentionPeriodCommand).resolves({});
    kinesis.on(AddTagsToStreamCommand).resolves({});

    await executor().apply(shorter, { apply: true });
    expect(
      kinesis.commandCalls(DecreaseStreamRetentionPeriodCommand)[0]?.args[0].input
        ?.RetentionPeriodHours,
    ).toBe(24);
    expect(kinesis.commandCalls(IncreaseStreamRetentionPeriodCommand)).toHaveLength(0);
  });

  it('PROVISIONED shardCount drift → UpdateShardCount (UNIFORM_SCALING)', async () => {
    const scaled = providerPlan([
      planResource('events', 'aws:kinesis:Stream', {
        streamMode: 'PROVISIONED',
        shardCount: 4,
      }),
    ]);
    // Live: already PROVISIONED with a single shard — only the count drifts.
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary({
        StreamModeDetails: { StreamMode: 'PROVISIONED' },
        OpenShardCount: 1,
      }),
    });
    kinesis.on(ListTagsForStreamCommand).resolves(managedTags);
    kinesis.on(UpdateShardCountCommand).resolves({});
    kinesis.on(AddTagsToStreamCommand).resolves({});

    const report = await executor().apply(scaled, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    const shard = kinesis.commandCalls(UpdateShardCountCommand)[0]?.args[0].input;
    expect(shard?.StreamName).toBe('events');
    expect(shard?.TargetShardCount).toBe(4);
    expect(shard?.ScalingType).toBe('UNIFORM_SCALING');
    expect(kinesis.commandCalls(UpdateStreamModeCommand)).toHaveLength(0); // mode unchanged
  });

  it('a DELETING stream reads as absent (never updated, never resurrected)', async () => {
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary({ StreamStatus: 'DELETING' }),
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create'); // absent-in-progress
    expect(kinesis.commandCalls(ListTagsForStreamCommand)).toHaveLength(0); // not even tag-read
  });

  it('destroy → DeleteStream with EnforceConsumerDeletion on a managed stream', async () => {
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary(),
    });
    kinesis.on(ListTagsForStreamCommand).resolves(managedTags);
    kinesis.on(DeleteStreamCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const del = kinesis.commandCalls(DeleteStreamCommand)[0]?.args[0].input;
    expect(del?.StreamName).toBe('events');
    expect(del?.EnforceConsumerDeletion).toBe(true);
  });

  it('destroy refuses an unmanaged stream (managed-only gate)', async () => {
    kinesis.on(DescribeStreamSummaryCommand).resolves({
      StreamDescriptionSummary: liveSummary(),
    });
    kinesis.on(ListTagsForStreamCommand).resolves({ Tags: [] }); // not ours

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(kinesis.commandCalls(DeleteStreamCommand)).toHaveLength(0);
  });

  it('replacement is N/A — no immutable projection key is declared', () => {
    const handler = new KinesisStreamHandler(new KinesisClient({ region: 'eu-central-1' }));
    expect(handler.immutableProjectionKeys).toBeUndefined();
    expect(handler.targetType).toBe('aws:kinesis:Stream');
  });
});
