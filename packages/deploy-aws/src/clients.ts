/**
 * Lazy per-service SDK client cache (ADR-0004). The bundle exposes one
 * property per AWS service, but a client is constructed only on FIRST ACCESS
 * by a handler and reused thereafter — a run never constructs clients for
 * services it does not touch. Region/credential resolution stays eager and
 * fail-closed; construction itself performs no network I/O (the credential
 * provider is lazy), so nothing reaches AWS until a command is sent by a
 * handler under an open apply gate.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { IAMClient } from '@aws-sdk/client-iam';
import { ACMClient } from '@aws-sdk/client-acm';
import { BackupClient } from '@aws-sdk/client-backup';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { TimestreamWriteClient } from '@aws-sdk/client-timestream-write';
import { AppRunnerClient } from '@aws-sdk/client-apprunner';
import { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import { BatchClient } from '@aws-sdk/client-batch';
import { DocDBClient } from '@aws-sdk/client-docdb';
import { EFSClient } from '@aws-sdk/client-efs';
import { FSxClient } from '@aws-sdk/client-fsx';
import { MemoryDBClient } from '@aws-sdk/client-memorydb';
import { MqClient } from '@aws-sdk/client-mq';
import { NeptuneClient } from '@aws-sdk/client-neptune';
import { WAFV2Client } from '@aws-sdk/client-wafv2';
import { Route53Client } from '@aws-sdk/client-route-53';
import { ECRClient } from '@aws-sdk/client-ecr';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { KeyspacesClient } from '@aws-sdk/client-keyspaces';
import { RedshiftServerlessClient } from '@aws-sdk/client-redshift-serverless';
import { SFNClient } from '@aws-sdk/client-sfn';
import { KinesisClient } from '@aws-sdk/client-kinesis';
import { FirehoseClient } from '@aws-sdk/client-firehose';
import { KafkaClient } from '@aws-sdk/client-kafka';
import { OpenSearchClient } from '@aws-sdk/client-opensearch';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECSClient } from '@aws-sdk/client-ecs';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SNSClient } from '@aws-sdk/client-sns';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient } from '@aws-sdk/client-rds';
import { ResourceGroupsClient } from '@aws-sdk/client-resource-groups';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { resolveCredentials, resolveRegion } from './credentials.js';
import type { AwsRuntimeOptions } from './credentials.js';

export interface ClientBundle {
  s3: S3Client;
  sqs: SQSClient;
  iam: IAMClient;
  acm: ACMClient;
  backup: BackupClient;
  dynamodb: DynamoDBClient;
  kms: KMSClient;
  timestreamWrite: TimestreamWriteClient;
  apprunner: AppRunnerClient;
  autoscaling: AutoScalingClient;
  batch: BatchClient;
  docdb: DocDBClient;
  efs: EFSClient;
  fsx: FSxClient;
  memorydb: MemoryDBClient;
  mq: MqClient;
  neptune: NeptuneClient;
  wafv2: WAFV2Client;
  route53: Route53Client;
  ecr: ECRClient;
  cloudwatch: CloudWatchClient;
  keyspaces: KeyspacesClient;
  redshiftServerless: RedshiftServerlessClient;
  sfn: SFNClient;
  kinesis: KinesisClient;
  firehose: FirehoseClient;
  kafka: KafkaClient;
  opensearch: OpenSearchClient;
  cloudfront: CloudFrontClient;
  eventbridge: EventBridgeClient;
  cognito: CognitoIdentityProviderClient;
  apigatewayv2: ApiGatewayV2Client;
  cloudwatchLogs: CloudWatchLogsClient;
  ec2: EC2Client;
  ecs: ECSClient;
  elasticache: ElastiCacheClient;
  elbv2: ElasticLoadBalancingV2Client;
  lambda: LambdaClient;
  rds: RDSClient;
  resourceGroups: ResourceGroupsClient;
  scheduler: SchedulerClient;
  secretsManager: SecretsManagerClient;
  sns: SNSClient;
  ssm: SSMClient;
  sts: STSClient;
}

/**
 * Create the lazy bundle. `overrides` (e.g. test doubles) short-circuit the
 * cache: an injected client is returned as-is and nothing is constructed for
 * that service.
 */
export function createClientBundle(
  options: AwsRuntimeOptions = {},
  overrides: Partial<ClientBundle> = {},
): ClientBundle {
  const region = resolveRegion(options);
  const credentials = resolveCredentials(options);
  const cache: Partial<ClientBundle> = { ...overrides };
  return {
    get s3() {
      return (cache.s3 ??= new S3Client({ region, credentials }));
    },
    get sqs() {
      return (cache.sqs ??= new SQSClient({ region, credentials }));
    },
    get iam() {
      return (cache.iam ??= new IAMClient({ region, credentials }));
    },
    get acm() {
      return (cache.acm ??= new ACMClient({ region, credentials }));
    },
    get backup() {
      return (cache.backup ??= new BackupClient({ region, credentials }));
    },
    get dynamodb() {
      return (cache.dynamodb ??= new DynamoDBClient({ region, credentials }));
    },
    get kms() {
      return (cache.kms ??= new KMSClient({ region, credentials }));
    },
    get timestreamWrite() {
      return (cache.timestreamWrite ??= new TimestreamWriteClient({ region, credentials }));
    },
    get apprunner() {
      return (cache.apprunner ??= new AppRunnerClient({ region, credentials }));
    },
    get autoscaling() {
      return (cache.autoscaling ??= new AutoScalingClient({ region, credentials }));
    },
    get batch() {
      return (cache.batch ??= new BatchClient({ region, credentials }));
    },
    get docdb() {
      return (cache.docdb ??= new DocDBClient({ region, credentials }));
    },
    get efs() {
      return (cache.efs ??= new EFSClient({ region, credentials }));
    },
    get fsx() {
      return (cache.fsx ??= new FSxClient({ region, credentials }));
    },
    get memorydb() {
      return (cache.memorydb ??= new MemoryDBClient({ region, credentials }));
    },
    get mq() {
      return (cache.mq ??= new MqClient({ region, credentials }));
    },
    get neptune() {
      return (cache.neptune ??= new NeptuneClient({ region, credentials }));
    },
    get wafv2() {
      return (cache.wafv2 ??= new WAFV2Client({ region, credentials }));
    },
    get route53() {
      return (cache.route53 ??= new Route53Client({ region, credentials }));
    },
    get ecr() {
      return (cache.ecr ??= new ECRClient({ region, credentials }));
    },
    get cloudwatch() {
      return (cache.cloudwatch ??= new CloudWatchClient({ region, credentials }));
    },
    get keyspaces() {
      return (cache.keyspaces ??= new KeyspacesClient({ region, credentials }));
    },
    get redshiftServerless() {
      return (cache.redshiftServerless ??= new RedshiftServerlessClient({ region, credentials }));
    },
    get sfn() {
      return (cache.sfn ??= new SFNClient({ region, credentials }));
    },
    get kinesis() {
      return (cache.kinesis ??= new KinesisClient({ region, credentials }));
    },
    get firehose() {
      return (cache.firehose ??= new FirehoseClient({ region, credentials }));
    },
    get kafka() {
      return (cache.kafka ??= new KafkaClient({ region, credentials }));
    },
    get opensearch() {
      return (cache.opensearch ??= new OpenSearchClient({ region, credentials }));
    },
    get cloudfront() {
      return (cache.cloudfront ??= new CloudFrontClient({ region, credentials }));
    },
    get eventbridge() {
      return (cache.eventbridge ??= new EventBridgeClient({ region, credentials }));
    },
    get cognito() {
      return (cache.cognito ??= new CognitoIdentityProviderClient({ region, credentials }));
    },
    get apigatewayv2() {
      return (cache.apigatewayv2 ??= new ApiGatewayV2Client({ region, credentials }));
    },
    get cloudwatchLogs() {
      return (cache.cloudwatchLogs ??= new CloudWatchLogsClient({ region, credentials }));
    },
    get lambda() {
      return (cache.lambda ??= new LambdaClient({ region, credentials }));
    },
    get scheduler() {
      return (cache.scheduler ??= new SchedulerClient({ region, credentials }));
    },
    get sns() {
      return (cache.sns ??= new SNSClient({ region, credentials }));
    },
    get ssm() {
      return (cache.ssm ??= new SSMClient({ region, credentials }));
    },
    get sts() {
      return (cache.sts ??= new STSClient({ region, credentials }));
    },
    get ec2() {
      return (cache.ec2 ??= new EC2Client({ region, credentials }));
    },
    get ecs() {
      return (cache.ecs ??= new ECSClient({ region, credentials }));
    },
    get elasticache() {
      return (cache.elasticache ??= new ElastiCacheClient({ region, credentials }));
    },
    get rds() {
      return (cache.rds ??= new RDSClient({ region, credentials }));
    },
    get elbv2() {
      return (cache.elbv2 ??= new ElasticLoadBalancingV2Client({ region, credentials }));
    },
    get resourceGroups() {
      return (cache.resourceGroups ??= new ResourceGroupsClient({ region, credentials }));
    },
    get secretsManager() {
      return (cache.secretsManager ??= new SecretsManagerClient({ region, credentials }));
    },
  };
}
