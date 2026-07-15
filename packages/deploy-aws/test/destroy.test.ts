import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const s3 = mockClient(S3Client);

beforeEach(() => {
  s3.reset();
  s3.on(HeadBucketCommand).resolves({});
  s3.on(GetBucketEncryptionCommand).resolves({});
  s3.on(GetBucketVersioningCommand).resolves({});
  s3.on(DeleteBucketCommand).resolves({});
});

const plan = providerPlan([planResource('assets', 'aws:s3:Bucket')]);

describe('destroy: managed-only gate', () => {
  it('refuses to delete a resource NOT tagged iap:managed', async () => {
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: [{ Key: 'team', Value: 'core' }] });

    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(s3.commandCalls(DeleteBucketCommand)).toHaveLength(0);
  });

  it('deletes a resource tagged iap:managed=true', async () => {
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: [{ Key: 'iap:managed', Value: 'true' }] });

    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(s3.commandCalls(DeleteBucketCommand)).toHaveLength(1);
  });

  it('destroy dry-run (no apply:true) issues no DeleteBucket', async () => {
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: [{ Key: 'iap:managed', Value: 'true' }] });

    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { destroy: true });

    expect(report.mode).toBe('dry-run');
    expect(report.items[0]?.action).toBe('delete');
    expect(s3.commandCalls(DeleteBucketCommand)).toHaveLength(0);
  });
});
