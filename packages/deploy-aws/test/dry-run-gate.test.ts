import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const s3 = mockClient(S3Client);

const plan = providerPlan([
  planResource('assets', 'aws:s3:Bucket', { sseAlgorithm: 'AES256', versioningStatus: 'Enabled' }),
]);

const MUTATING = [
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  DeleteBucketCommand,
];

describe('dry-run gate (the live gate)', () => {
  beforeEach(() => {
    s3.reset();
    // Absent bucket: HeadBucket 404.
    s3.on(HeadBucketCommand).rejects(serviceError('NotFound', 404));
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: [] });
    s3.on(GetBucketEncryptionCommand).resolves({});
    s3.on(GetBucketVersioningCommand).resolves({});
  });

  it('plan() issues only reads and never a mutating command', async () => {
    const executor = new AwsExecutor({ region: 'us-east-1' });
    const report = await executor.plan(plan);

    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.action).toBe('create');
    expect(s3.commandCalls(HeadBucketCommand)).toHaveLength(1);
    for (const Command of MUTATING) {
      expect(s3.commandCalls(Command), Command.name).toHaveLength(0);
    }
  });

  it('apply() WITHOUT apply:true is a dry run: reads only, zero mutations', async () => {
    const executor = new AwsExecutor({ region: 'us-east-1' });
    const report = await executor.apply(plan);

    expect(report.mode).toBe('dry-run');
    expect(report.applied).toBe(false);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(false);
    for (const Command of MUTATING) {
      expect(s3.commandCalls(Command), Command.name).toHaveLength(0);
    }
  });

  it('apply({ apply: true }) opens the gate and issues the create', async () => {
    s3.on(CreateBucketCommand).resolves({});
    s3.on(PutBucketEncryptionCommand).resolves({});
    s3.on(PutBucketVersioningCommand).resolves({});
    s3.on(PutBucketTaggingCommand).resolves({});

    const executor = new AwsExecutor({ region: 'us-east-1' });
    const report = await executor.apply(plan, { apply: true });

    expect(report.mode).toBe('apply');
    expect(report.applied).toBe(true);
    expect(report.items[0]?.applied).toBe(true);
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(1);
  });
});
