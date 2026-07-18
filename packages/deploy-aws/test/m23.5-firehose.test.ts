/**
 * M23.5 `aws:firehose:DeliveryStream` handler, mock-tested: create with an S3
 * destination and the required bucket ARN + role ARN (fail-closed with ZERO
 * mutating calls when either is missing), converged no-op, destination drift →
 * UpdateDestination (version-fenced), the immutable deliveryStreamType replace,
 * managed-only destroy refusal, and the name→describe absent handling.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  FirehoseClient,
  ListTagsForDeliveryStreamCommand,
  TagDeliveryStreamCommand,
  UpdateDestinationCommand,
} from '@aws-sdk/client-firehose';
import type { DeliveryStreamDescription } from '@aws-sdk/client-firehose';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const firehose = mockClient(FirehoseClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const BUCKET_ARN = 'arn:aws:s3:::events-lake';
const ROLE_ARN = 'arn:aws:iam::000000000000:role/events-firehose';

beforeEach(() => firehose.reset());

/** A live, ACTIVE, iap-managed DirectPut → S3 delivery stream description. */
function liveStream(
  overrides: Partial<DeliveryStreamDescription> = {},
): DeliveryStreamDescription {
  return {
    DeliveryStreamName: 'events',
    DeliveryStreamARN: 'arn:aws:firehose:eu-central-1:000000000000:deliverystream/events',
    DeliveryStreamStatus: 'ACTIVE',
    DeliveryStreamType: 'DirectPut',
    VersionId: '1',
    Destinations: [
      {
        DestinationId: 'destinationId-000000000001',
        S3DestinationDescription: { BucketARN: BUCKET_ARN, RoleARN: ROLE_ARN },
      },
    ],
    HasMoreDestinations: false,
    ...overrides,
  } as DeliveryStreamDescription;
}

const managedTags = { Tags: [{ Key: 'iap:managed', Value: 'true' }] };

/** A well-formed plan wiring bucket + role (the sibling S3/IAM refs). */
function fullPlan() {
  return providerPlan([
    planResource('events', 'aws:firehose:DeliveryStream', {
      destinationBucketArn: BUCKET_ARN,
      roleArn: ROLE_ARN,
    }),
  ]);
}

describe('aws:firehose:DeliveryStream', () => {
  it('absent → CreateDeliveryStream DirectPut with S3 destination + iap tags', async () => {
    firehose.on(DescribeDeliveryStreamCommand).rejects(serviceError('ResourceNotFoundException'));
    firehose.on(CreateDeliveryStreamCommand).resolves({
      DeliveryStreamARN: 'arn:aws:firehose:eu-central-1:000000000000:deliverystream/events',
    });

    const report = await executor().apply(fullPlan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(
      'arn:aws:firehose:eu-central-1:000000000000:deliverystream/events',
    );
    const create = firehose.commandCalls(CreateDeliveryStreamCommand)[0]?.args[0].input;
    expect(create?.DeliveryStreamName).toBe('events');
    expect(create?.DeliveryStreamType).toBe('DirectPut');
    expect(create?.S3DestinationConfiguration?.BucketARN).toBe(BUCKET_ARN);
    expect(create?.S3DestinationConfiguration?.RoleARN).toBe(ROLE_ARN);
    expect(create?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(create?.Tags?.some((t) => t.Key === 'iap:resourceId')).toBe(true);
  });

  it('fail-closed: a missing destinationBucketArn issues ZERO mutating calls', async () => {
    const noBucket = providerPlan([
      planResource('events', 'aws:firehose:DeliveryStream', { roleArn: ROLE_ARN }),
    ]);
    firehose.on(DescribeDeliveryStreamCommand).rejects(serviceError('ResourceNotFoundException'));

    const report = await executor().apply(noBucket, { apply: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('destinationBucketArn');
    expect(firehose.commandCalls(CreateDeliveryStreamCommand)).toHaveLength(0);
  });

  it('fail-closed: a missing roleArn issues ZERO mutating calls', async () => {
    const noRole = providerPlan([
      planResource('events', 'aws:firehose:DeliveryStream', { destinationBucketArn: BUCKET_ARN }),
    ]);
    firehose.on(DescribeDeliveryStreamCommand).rejects(serviceError('ResourceNotFoundException'));

    const report = await executor().apply(noRole, { apply: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('roleArn');
    expect(firehose.commandCalls(CreateDeliveryStreamCommand)).toHaveLength(0);
  });

  it('present + converged → no-op, nothing mutated', async () => {
    firehose.on(DescribeDeliveryStreamCommand).resolves({
      DeliveryStreamDescription: liveStream(),
    });
    firehose.on(ListTagsForDeliveryStreamCommand).resolves(managedTags);

    const planned = await executor().plan(fullPlan());
    expect(planned.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(fullPlan(), { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(firehose.commandCalls(CreateDeliveryStreamCommand)).toHaveLength(0);
    expect(firehose.commandCalls(UpdateDestinationCommand)).toHaveLength(0);
    expect(firehose.commandCalls(DeleteDeliveryStreamCommand)).toHaveLength(0);
  });

  it('destination drift → UpdateDestination (version-fenced) + TagDeliveryStream', async () => {
    const newBucket = 'arn:aws:s3:::events-lake-v2';
    const rebucketed = providerPlan([
      planResource('events', 'aws:firehose:DeliveryStream', {
        destinationBucketArn: newBucket,
        roleArn: ROLE_ARN,
      }),
    ]);
    // Live points at the old bucket → destination drift.
    firehose.on(DescribeDeliveryStreamCommand).resolves({
      DeliveryStreamDescription: liveStream(),
    });
    firehose.on(ListTagsForDeliveryStreamCommand).resolves(managedTags);
    firehose.on(UpdateDestinationCommand).resolves({});
    firehose.on(TagDeliveryStreamCommand).resolves({});

    const report = await executor().apply(rebucketed, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const upd = firehose.commandCalls(UpdateDestinationCommand)[0]?.args[0].input;
    expect(upd?.CurrentDeliveryStreamVersionId).toBe('1');
    expect(upd?.DestinationId).toBe('destinationId-000000000001');
    expect(upd?.S3DestinationUpdate?.BucketARN).toBe(newBucket);
    expect(upd?.S3DestinationUpdate?.RoleARN).toBe(ROLE_ARN);
    expect(firehose.commandCalls(TagDeliveryStreamCommand)).toHaveLength(1);
    expect(firehose.commandCalls(DeleteDeliveryStreamCommand)).toHaveLength(0);
  });

  it('deliveryStreamType drift is IMMUTABLE → plans replace (gated delete+create)', async () => {
    // Live stream is KinesisStreamAsSource; the plan wants the default DirectPut.
    firehose.on(DescribeDeliveryStreamCommand).resolves({
      DeliveryStreamDescription: liveStream({ DeliveryStreamType: 'KinesisStreamAsSource' }),
    });
    firehose.on(ListTagsForDeliveryStreamCommand).resolves(managedTags);
    firehose.on(DeleteDeliveryStreamCommand).resolves({});
    firehose.on(CreateDeliveryStreamCommand).resolves({
      DeliveryStreamARN: 'arn:aws:firehose:eu-central-1:000000000000:deliverystream/events-new',
    });

    const planned = await executor().plan(fullPlan());
    expect(planned.items[0]?.action).toBe('replace');

    // Gate closed → refuses, nothing destroyed.
    const refused = await executor().apply(fullPlan(), { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(firehose.commandCalls(DeleteDeliveryStreamCommand)).toHaveLength(0);

    // Gate open → delete THEN create, in that order.
    const report = await executor().apply(fullPlan(), { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    const mutations = firehose
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter(
        (name) =>
          name === 'DeleteDeliveryStreamCommand' || name === 'CreateDeliveryStreamCommand',
      );
    expect(mutations).toEqual(['DeleteDeliveryStreamCommand', 'CreateDeliveryStreamCommand']);
  });

  it('destroy refuses an unmanaged delivery stream (managed-only gate)', async () => {
    firehose.on(DescribeDeliveryStreamCommand).resolves({
      DeliveryStreamDescription: liveStream(),
    });
    firehose.on(ListTagsForDeliveryStreamCommand).resolves({ Tags: [] }); // not ours

    const report = await executor().apply(fullPlan(), { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(firehose.commandCalls(DeleteDeliveryStreamCommand)).toHaveLength(0);
  });

  it('name→describe: ResourceNotFoundException reads as absent (plans create)', async () => {
    firehose.on(DescribeDeliveryStreamCommand).rejects(serviceError('ResourceNotFoundException'));

    const report = await executor().plan(fullPlan());
    expect(report.items[0]?.action).toBe('create');
    expect(firehose.commandCalls(ListTagsForDeliveryStreamCommand)).toHaveLength(0);
  });

  it('a DELETING delivery stream reads as absent', async () => {
    firehose.on(DescribeDeliveryStreamCommand).resolves({
      DeliveryStreamDescription: liveStream({ DeliveryStreamStatus: 'DELETING' }),
    });

    const report = await executor().plan(fullPlan());
    expect(report.items[0]?.action).toBe('create');
    expect(firehose.commandCalls(ListTagsForDeliveryStreamCommand)).toHaveLength(0);
  });
});
