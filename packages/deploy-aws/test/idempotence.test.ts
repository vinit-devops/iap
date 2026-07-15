import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { CreateRoleCommand, GetRoleCommand, IAMClient, TagRoleCommand } from '@aws-sdk/client-iam';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const iam = mockClient(IAMClient);

const MANAGED_TAGSET = [{ Key: 'iap:managed', Value: 'true' }];

beforeEach(() => {
  s3.reset();
  sqs.reset();
  iam.reset();
});

describe('idempotence: present + converged → no-op, no mutating command', () => {
  it('aws:s3:Bucket converged', async () => {
    s3.on(HeadBucketCommand).resolves({});
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: MANAGED_TAGSET });
    s3.on(GetBucketEncryptionCommand).resolves({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
    s3.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });

    const plan = providerPlan([
      planResource('assets', 'aws:s3:Bucket', {
        sseAlgorithm: 'AES256',
        versioningStatus: 'Enabled',
      }),
    ]);
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('no-op');
    expect(report.items[0]?.applied).toBe(false);
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(0);
    expect(s3.commandCalls(PutBucketEncryptionCommand)).toHaveLength(0);
    expect(s3.commandCalls(PutBucketVersioningCommand)).toHaveLength(0);
    expect(s3.commandCalls(PutBucketTaggingCommand)).toHaveLength(0);
  });

  it('aws:sqs:Queue converged', async () => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: 'https://sqs.test/jobs' });
    sqs.on(GetQueueAttributesCommand).resolves({
      Attributes: { FifoQueue: 'false', MessageRetentionPeriod: '345600' },
    });
    sqs.on(ListQueueTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });

    const plan = providerPlan([
      planResource('jobs', 'aws:sqs:Queue', { fifoQueue: false, messageRetentionPeriod: 345600 }),
    ]);
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('no-op');
    expect(sqs.commandCalls(CreateQueueCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SetQueueAttributesCommand)).toHaveLength(0);
  });

  it('aws:iam:Role converged', async () => {
    iam.on(GetRoleCommand).resolves({
      Role: {
        RoleName: 'task',
        Arn: 'arn:aws:iam::1:role/task',
        Path: '/',
        RoleId: 'AROA',
        CreateDate: new Date(0),
        AssumeRolePolicyDocument: encodeURIComponent(
          JSON.stringify({
            Statement: [{ Principal: { Service: 'ecs-tasks.amazonaws.com' } }],
          }),
        ),
        Tags: [{ Key: 'iap:managed', Value: 'true' }],
      },
    });

    const plan = providerPlan([
      planResource('task', 'aws:iam:Role', { assumeRoleService: 'ecs-tasks.amazonaws.com' }),
    ]);
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('no-op');
    expect(iam.commandCalls(CreateRoleCommand)).toHaveLength(0);
    expect(iam.commandCalls(TagRoleCommand)).toHaveLength(0);
  });
});
