/**
 * M22.1 serverless-core handlers, mock-tested: Lambda, API Gateway HTTP API,
 * SNS, SSM Parameter, EventBridge Scheduler, CloudWatch Logs — plus the
 * upgrades: IAM multi-service trust + policy-safe delete, S3 public posture,
 * SQS dead-letter sibling.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateTopicCommand,
  GetTopicAttributesCommand,
  ListTagsForResourceCommand as SnsListTagsCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  CreateScheduleCommand,
  CreateScheduleGroupCommand,
  GetScheduleCommand,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  GetApisCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  CreateBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  SQSClient,
  TagQueueCommand,
} from '@aws-sdk/client-sqs';
import { AwsExecutor, toScheduleExpression } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const lambda = mockClient(LambdaClient);
const iam = mockClient(IAMClient);
const sns = mockClient(SNSClient);
const sts = mockClient(STSClient);
const ssm = mockClient(SSMClient);
const scheduler = mockClient(SchedulerClient);
const logs = mockClient(CloudWatchLogsClient);
const apigw = mockClient(ApiGatewayV2Client);
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => {
  for (const m of [lambda, iam, sns, sts, ssm, scheduler, logs, apigw, s3, sqs]) m.reset();
});

describe('aws:lambda:Function', () => {
  const plan = providerPlan([
    planResource('resizer', 'aws:lambda:Function', {
      packageType: 'Zip',
      codeReference: 's3://code-bucket/resizer.zip',
      memorySize: 256,
      timeout: '10s',
    }),
  ]);

  it('absent → CreateFunction resolving the sibling execution role by name', async () => {
    lambda.on(GetFunctionCommand).rejects(serviceError('ResourceNotFoundException'));
    iam.on(GetRoleCommand).resolves({ Role: { Arn: 'arn:iam::role/resizer', RoleName: 'resizer', Path: '/', RoleId: 'x', CreateDate: new Date(0) } });
    lambda.on(CreateFunctionCommand).resolves({ FunctionArn: 'arn:lambda:resizer' });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    const input = lambda.commandCalls(CreateFunctionCommand)[0]?.args[0].input;
    expect(input?.Role).toBe('arn:iam::role/resizer');
    expect(input?.Code?.S3Bucket).toBe('code-bucket');
    expect(input?.Runtime).toBe('nodejs22.x'); // Zip default
    expect(input?.Timeout).toBe(10); // '10s' coerced
  });

  it('packageType drift is IMMUTABLE → replace', async () => {
    lambda.on(GetFunctionCommand).resolves({
      Configuration: {
        FunctionArn: 'arn:lambda:resizer',
        PackageType: 'Image',
        MemorySize: 256,
        Timeout: 10,
      },
      Code: { ImageUri: 'img:1' },
      Tags: { 'iap:managed': 'true' },
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteFunction', async () => {
    lambda.on(GetFunctionCommand).resolves({
      Configuration: { FunctionArn: 'arn:lambda:resizer', PackageType: 'Zip', MemorySize: 256, Timeout: 10 },
      Tags: { 'iap:managed': 'true' },
    });
    lambda.on(DeleteFunctionCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
  });
});

describe('aws:iam:Role upgrades', () => {
  it('multi-service trust: comma list → Principal.Service array (sorted)', async () => {
    const plan = providerPlan([
      planResource('job-role', 'aws:iam:Role', {
        assumeRoleService: 'scheduler.amazonaws.com,lambda.amazonaws.com',
        inlinePolicy: '{"Version":"2012-10-17","Statement":[]}',
      }),
    ]);
    iam.on(GetRoleCommand).rejects(serviceError('NoSuchEntity', 404));
    iam.on(CreateRoleCommand).resolves({ Role: { Arn: 'arn:iam::role/job-role', RoleName: 'job-role', Path: '/', RoleId: 'x', CreateDate: new Date(0) } });
    iam.on(PutRolePolicyCommand).resolves({});

    await executor().apply(plan, { apply: true });
    const doc = JSON.parse(
      iam.commandCalls(CreateRoleCommand)[0]?.args[0].input?.AssumeRolePolicyDocument ?? '{}',
    ) as { Statement: Array<{ Principal: { Service: string[] } }> };
    expect(doc.Statement[0]?.Principal.Service).toEqual([
      'lambda.amazonaws.com',
      'scheduler.amazonaws.com',
    ]);
  });

  it('delete removes the inline policy before the role', async () => {
    const plan = providerPlan([
      planResource('job-role', 'aws:iam:Role', { assumeRoleService: 'lambda.amazonaws.com' }),
    ]);
    iam.on(GetRoleCommand).resolves({
      Role: {
        Arn: 'arn:iam::role/job-role', RoleName: 'job-role', Path: '/', RoleId: 'x',
        CreateDate: new Date(0),
        Tags: [{ Key: 'iap:managed', Value: 'true' }],
        AssumeRolePolicyDocument: encodeURIComponent(
          '{"Statement":[{"Principal":{"Service":"lambda.amazonaws.com"}}]}',
        ),
      },
    });
    iam.on(DeleteRolePolicyCommand).resolves({});
    iam.on(DeleteRoleCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(iam.commandCalls(DeleteRolePolicyCommand)[0]?.args[0].input?.PolicyName).toBe('job-role-inline');
  });
});

describe('aws:sns:Topic', () => {
  it('ordered topic → FIFO with .fifo suffix; fifoTopic immutable → replace on drift', async () => {
    const plan = providerPlan([
      planResource('events', 'aws:sns:Topic', { fifoTopic: true, contentBasedDeduplication: true, sseEnabled: true }),
    ]);
    sts.on(GetCallerIdentityCommand).resolves({ Account: '000000000000' });
    sns.on(GetTopicAttributesCommand).rejects(serviceError('NotFoundException', 404));
    sns.on(CreateTopicCommand).resolves({ TopicArn: 'arn:sns:events.fifo' });

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = sns.commandCalls(CreateTopicCommand)[0]?.args[0].input;
    expect(input?.Name).toBe('events.fifo');
    expect(input?.Attributes?.['FifoTopic']).toBe('true');
    expect(input?.Attributes?.['KmsMasterKeyId']).toBe('alias/aws/sns');

    // Live standard topic vs desired FIFO → replace.
    sns.reset();
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { FifoTopic: 'false' } });
    sns.on(SnsListTagsCommand).resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });
    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('replace');
  });
});

describe('aws:ssm:Parameter', () => {
  it('creates a SecureString with a generated value; never reads it back', async () => {
    const plan = providerPlan([
      planResource('api-key', 'aws:ssm:Parameter', { parameterType: 'SecureString', generateValue: true }),
    ]);
    ssm.on(GetParameterCommand).rejects(serviceError('ParameterNotFound'));
    ssm.on(PutParameterCommand).resolves({ Version: 1 });

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = ssm.commandCalls(PutParameterCommand)[0]?.args[0].input;
    expect(input?.Type).toBe('SecureString');
    expect((input?.Value ?? '').length).toBeGreaterThanOrEqual(16);
    const reads = ssm.commandCalls(GetParameterCommand);
    expect(reads.every((c) => c.args[0].input?.WithDecryption === undefined)).toBe(true);
  });
});

describe('aws:scheduler:Schedule', () => {
  it('coerces IaP schedules to Scheduler expressions', () => {
    expect(toScheduleExpression('@daily')).toBe('rate(1 day)');
    expect(toScheduleExpression('0 3 * * *')).toBe('cron(0 3 * * ? *)');
    expect(toScheduleExpression('0 9 * * 1')).toBe('cron(0 9 ? * 1 *)');
  });

  it('absent → owned schedule group (tagged) + CreateSchedule targeting siblings', async () => {
    const plan = providerPlan([
      planResource('nightly', 'aws:scheduler:Schedule', {
        scheduleExpression: '0 3 * * *',
        retries: 2,
      }),
    ]);
    scheduler.on(GetScheduleCommand).rejects(serviceError('ResourceNotFoundException'));
    scheduler.on(CreateScheduleGroupCommand).resolves({});
    lambda.on(GetFunctionCommand).resolves({ Configuration: { FunctionArn: 'arn:lambda:nightly' } });
    iam.on(GetRoleCommand).resolves({ Role: { Arn: 'arn:iam::role/nightly', RoleName: 'nightly', Path: '/', RoleId: 'x', CreateDate: new Date(0) } });
    scheduler.on(CreateScheduleCommand).resolves({ ScheduleArn: 'arn:scheduler:nightly' });

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    // Ownership tags ride the GROUP (Scheduler tags reject schedule ARNs — live finding).
    const group = scheduler.commandCalls(CreateScheduleGroupCommand)[0]?.args[0].input;
    expect(group?.Name).toBe('nightly');
    expect(group?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    const input = scheduler.commandCalls(CreateScheduleCommand)[0]?.args[0].input;
    expect(input?.GroupName).toBe('nightly');
    expect(input?.ScheduleExpression).toBe('cron(0 3 * * ? *)');
    expect(input?.Target?.Arn).toBe('arn:lambda:nightly');
    expect(input?.Target?.RoleArn).toBe('arn:iam::role/nightly');
    expect(input?.Target?.RetryPolicy?.MaximumRetryAttempts).toBe(2);
  });
});

describe('aws:logs:LogGroup', () => {
  it('absent → creates /aws/lambda/<id> with the derived retention', async () => {
    const plan = providerPlan([
      planResource('resizer', 'aws:logs:LogGroup', { retentionInDays: 30 }),
    ]);
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [] });
    logs.on(CreateLogGroupCommand).resolves({});
    logs.on(PutRetentionPolicyCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(logs.commandCalls(CreateLogGroupCommand)[0]?.args[0].input?.logGroupName).toBe('/aws/lambda/resizer');
    expect(logs.commandCalls(PutRetentionPolicyCommand)[0]?.args[0].input?.retentionInDays).toBe(30);
  });
});

describe('aws:apigatewayv2:Api', () => {
  it('absent → CreateApi (HTTP) with quick-create Lambda target', async () => {
    const plan = providerPlan([
      planResource('links-api', 'aws:apigatewayv2:Api', {
        protocolType: 'HTTP',
        targetFunctionArn: 'arn:lambda:resolve-link',
      }),
    ]);
    apigw.on(GetApisCommand).resolves({ Items: [] });
    apigw.on(CreateApiCommand).resolves({ ApiId: 'api123' });

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.identifier).toBe('api123');
    const input = apigw.commandCalls(CreateApiCommand)[0]?.args[0].input;
    expect(input?.ProtocolType).toBe('HTTP');
    expect(input?.Target).toBe('arn:lambda:resolve-link');
  });
});

describe('aws:s3:Bucket public-posture upgrade', () => {
  it('public branch → PublicAccessBlock off + public-read policy', async () => {
    const plan = providerPlan([
      planResource('site-assets', 'aws:s3:Bucket', {
        versioningStatus: 'Suspended',
        blockPublicAccess: false,
        publicReadPolicy: true,
      }),
    ]);
    s3.on(HeadBucketCommand).rejects(serviceError('NotFound', 404));
    s3.on(CreateBucketCommand).resolves({});
    s3.on(PutPublicAccessBlockCommand).resolves({});
    s3.on(PutBucketPolicyCommand).resolves({});
    s3.on(PutBucketTaggingCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    const pab = s3.commandCalls(PutPublicAccessBlockCommand)[0]?.args[0].input;
    expect(pab?.PublicAccessBlockConfiguration?.BlockPublicPolicy).toBe(false);
    const policy = JSON.parse(s3.commandCalls(PutBucketPolicyCommand)[0]?.args[0].input?.Policy ?? '{}');
    expect(policy.Statement?.[0]?.Action).toBe('s3:GetObject');
  });

  it('pre-M22.1 documents (no posture attribute) still read converged', async () => {
    const plan = providerPlan([
      planResource('assets', 'aws:s3:Bucket', { sseAlgorithm: 'AES256', versioningStatus: 'Enabled' }),
    ]);
    s3.on(HeadBucketCommand).resolves({});
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: [{ Key: 'iap:managed', Value: 'true' }] });
    s3.on(GetBucketEncryptionCommand).resolves({
      ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    });
    s3.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
    expect(s3.commandCalls(GetPublicAccessBlockCommand)).toHaveLength(0); // not even read
  });
});

describe('aws:sqs:Queue dead-letter upgrade', () => {
  it('redrive attribute → handler-owned <name>-dlq + RedrivePolicy on the main queue', async () => {
    const plan = providerPlan([
      planResource('jobs', 'aws:sqs:Queue', {
        fifoQueue: false,
        messageRetentionPeriod: 345600,
        redriveMaxReceiveCount: 5,
      }),
    ]);
    sqs.on(GetQueueUrlCommand).rejects(serviceError('QueueDoesNotExist'));
    sqs
      .on(CreateQueueCommand)
      .resolvesOnce({ QueueUrl: 'https://sqs/q/jobs-dlq' }) // the DLQ first
      .resolves({ QueueUrl: 'https://sqs/q/jobs' });
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: 'arn:sqs:jobs-dlq' } });
    sqs.on(TagQueueCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    const calls = sqs.commandCalls(CreateQueueCommand);
    expect(calls[0]?.args[0].input?.QueueName).toBe('jobs-dlq');
    const redrive = JSON.parse(calls[1]?.args[0].input?.Attributes?.['RedrivePolicy'] ?? '{}');
    expect(redrive.deadLetterTargetArn).toBe('arn:sqs:jobs-dlq');
    expect(redrive.maxReceiveCount).toBe(5);
  });

  it('destroy removes the DLQ sibling too (zero orphans)', async () => {
    const plan = providerPlan([
      planResource('jobs', 'aws:sqs:Queue', { fifoQueue: false, redriveMaxReceiveCount: 5 }),
    ]);
    sqs.on(GetQueueUrlCommand)
      .resolvesOnce({ QueueUrl: 'https://sqs/q/jobs' }) // the read
      .resolves({ QueueUrl: 'https://sqs/q/jobs-dlq' }); // the DLQ lookup at delete
    sqs.on(GetQueueAttributesCommand).resolves({
      Attributes: { RedrivePolicy: '{"deadLetterTargetArn":"arn:sqs:jobs-dlq","maxReceiveCount":5}' },
    });
    sqs.on(ListQueueTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });
    sqs.on(DeleteQueueCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const deletes = sqs.commandCalls(DeleteQueueCommand);
    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.args[0].input?.QueueUrl).toBe('https://sqs/q/jobs-dlq');
  });
});
