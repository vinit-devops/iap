import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  SQSClient,
  TagQueueCommand,
} from '@aws-sdk/client-sqs';
import { CreateRoleCommand, GetRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { AwsExecutor, MANAGED_TAG_KEY, PLAN_TAG_KEY, RESOURCE_TAG_KEY } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const iam = mockClient(IAMClient);

beforeEach(() => {
  s3.reset();
  sqs.reset();
  iam.reset();
});

describe('create: absent object + apply:true → Create* with mandatory tags', () => {
  it('aws:s3:Bucket → CreateBucket + PutBucketTagging carrying mandatory tags', async () => {
    s3.on(HeadBucketCommand).rejects(serviceError('NotFound', 404));
    s3.on(CreateBucketCommand).resolves({});
    s3.on(PutBucketEncryptionCommand).resolves({});
    s3.on(PutBucketVersioningCommand).resolves({});
    s3.on(PutBucketTaggingCommand).resolves({});

    const plan = providerPlan(
      [planResource('assets', 'aws:s3:Bucket', { sseAlgorithm: 'AES256' })],
      'plan-s3',
    );
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe('arn:aws:s3:::assets');
    expect(s3.commandCalls(CreateBucketCommand)[0]?.args[0].input).toMatchObject({
      Bucket: 'assets',
    });
    const tagSet = s3.commandCalls(PutBucketTaggingCommand)[0]?.args[0].input.Tagging?.TagSet ?? [];
    const tags = Object.fromEntries(tagSet.map((t) => [t.Key, t.Value]));
    expect(tags[MANAGED_TAG_KEY]).toBe('true');
    expect(tags[PLAN_TAG_KEY]).toBe('plan-s3');
    expect(tags[RESOURCE_TAG_KEY]).toBe('assets.aws:s3:Bucket');
  });

  it('aws:sqs:Queue → CreateQueue + TagQueue carrying mandatory tags', async () => {
    sqs.on(GetQueueUrlCommand).rejects(serviceError('AWS.SimpleQueueService.NonExistentQueue'));
    sqs.on(CreateQueueCommand).resolves({ QueueUrl: 'https://sqs.test/jobs' });
    sqs.on(TagQueueCommand).resolves({});

    const plan = providerPlan(
      [planResource('jobs', 'aws:sqs:Queue', { fifoQueue: false, messageRetentionPeriod: 345600 })],
      'plan-sqs',
    );
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe('https://sqs.test/jobs');
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(0);
    // A standard queue must NOT carry FifoQueue (AWS rejects FifoQueue=false).
    const createInput = sqs.commandCalls(CreateQueueCommand)[0]?.args[0].input;
    expect(createInput).toMatchObject({
      QueueName: 'jobs',
      Attributes: { MessageRetentionPeriod: '345600' },
    });
    expect(createInput?.Attributes).not.toHaveProperty('FifoQueue');
    const tagCall = sqs.commandCalls(TagQueueCommand)[0]?.args[0].input;
    expect(tagCall?.Tags?.[MANAGED_TAG_KEY]).toBe('true');
    expect(tagCall?.Tags?.[RESOURCE_TAG_KEY]).toBe('jobs.aws:sqs:Queue');
  });

  it('aws:sqs:Queue → coerces an IaP duration retention to seconds and omits FifoQueue (M19.3 live-found)', async () => {
    sqs.on(GetQueueUrlCommand).rejects(serviceError('AWS.SimpleQueueService.NonExistentQueue'));
    sqs.on(CreateQueueCommand).resolves({ QueueUrl: 'https://sqs.test/jobs' });
    sqs.on(TagQueueCommand).resolves({});

    // The AWS mapping emits messageRetentionPeriod as an IaP duration ("7d");
    // SQS requires an integer count of seconds (604800), and no FifoQueue on a
    // standard queue. Both were real failures caught in the live golden path.
    const plan = providerPlan(
      [planResource('jobs', 'aws:sqs:Queue', { fifoQueue: false, messageRetentionPeriod: '7d' })],
      'plan-sqs-duration',
    );
    await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    const input = sqs.commandCalls(CreateQueueCommand)[0]?.args[0].input;
    expect(input?.Attributes?.MessageRetentionPeriod).toBe('604800');
    expect(input?.Attributes).not.toHaveProperty('FifoQueue');
  });

  it('aws:iam:Role → CreateRole carrying mandatory tags + derived trust policy', async () => {
    iam.on(GetRoleCommand).rejects(serviceError('NoSuchEntity', 404));
    iam
      .on(CreateRoleCommand)
      .resolves({ Role: { RoleName: 'task', Arn: 'arn:aws:iam::1:role/task' } });

    const plan = providerPlan(
      [planResource('task', 'aws:iam:Role', { assumeRoleService: 'ecs-tasks.amazonaws.com' })],
      'plan-iam',
    );
    const report = await new AwsExecutor({ region: 'us-east-1' }).apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe('arn:aws:iam::1:role/task');
    const input = iam.commandCalls(CreateRoleCommand)[0]?.args[0].input;
    expect(input?.RoleName).toBe('task');
    expect(input?.AssumeRolePolicyDocument).toContain('ecs-tasks.amazonaws.com');
    const tags = Object.fromEntries((input?.Tags ?? []).map((t) => [t.Key, t.Value]));
    expect(tags[MANAGED_TAG_KEY]).toBe('true');
    expect(tags[RESOURCE_TAG_KEY]).toBe('task.aws:iam:Role');
  });
});
