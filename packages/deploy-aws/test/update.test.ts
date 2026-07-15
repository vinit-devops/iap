import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { GetRoleCommand, IAMClient, TagRoleCommand } from '@aws-sdk/client-iam';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const iam = mockClient(IAMClient);

beforeEach(() => {
  s3.reset();
  sqs.reset();
  iam.reset();
});

describe('update: present + drifted → correct Set/Put*', () => {
  it('aws:s3:Bucket drifted encryption → PutBucketEncryption', async () => {
    s3.on(HeadBucketCommand).resolves({});
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: [{ Key: 'iap:managed', Value: 'true' }] });
    s3.on(GetBucketEncryptionCommand).resolves({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
    s3.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3.on(PutBucketEncryptionCommand).resolves({});
    s3.on(PutBucketTaggingCommand).resolves({});

    const plan = providerPlan([
      planResource('assets', 'aws:s3:Bucket', {
        sseAlgorithm: 'aws:kms', // drift: live is AES256
        versioningStatus: 'Enabled',
      }),
    ]);
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const enc = s3.commandCalls(PutBucketEncryptionCommand)[0]?.args[0].input;
    expect(
      enc?.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault
        ?.SSEAlgorithm,
    ).toBe('aws:kms');
  });

  it('aws:sqs:Queue drifted retention → SetQueueAttributes (immutable FifoQueue excluded)', async () => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: 'https://sqs.test/jobs' });
    sqs.on(GetQueueAttributesCommand).resolves({
      Attributes: { FifoQueue: 'false', MessageRetentionPeriod: '60' },
    });
    sqs.on(ListQueueTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });
    sqs.on(SetQueueAttributesCommand).resolves({});

    const plan = providerPlan([
      planResource('jobs', 'aws:sqs:Queue', { fifoQueue: false, messageRetentionPeriod: 345600 }),
    ]);
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    const attrs = sqs.commandCalls(SetQueueAttributesCommand)[0]?.args[0].input.Attributes;
    expect(attrs?.MessageRetentionPeriod).toBe('345600');
    expect(attrs?.FifoQueue).toBeUndefined();
  });

  it('aws:iam:Role drifted trust service → TagRole (reconcile)', async () => {
    iam.on(GetRoleCommand).resolves({
      Role: {
        RoleName: 'task',
        Arn: 'arn:aws:iam::1:role/task',
        Path: '/',
        RoleId: 'AROA',
        CreateDate: new Date(0),
        AssumeRolePolicyDocument: encodeURIComponent(
          JSON.stringify({ Statement: [{ Principal: { Service: 'ecs-tasks.amazonaws.com' } }] }),
        ),
        Tags: [{ Key: 'iap:managed', Value: 'true' }],
      },
    });
    iam.on(TagRoleCommand).resolves({});

    const plan = providerPlan([
      planResource('task', 'aws:iam:Role', { assumeRoleService: 'lambda.amazonaws.com' }),
    ]);
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(iam.commandCalls(TagRoleCommand)).toHaveLength(1);
  });
});
