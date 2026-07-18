/**
 * `@iap/deploy-aws` — the real AWS execution runtime for IaP (Phase 19 /
 * M19.3). Consumes a `ProviderPlan` and reconciles it against live AWS across
 * a narrow golden path (S3 buckets, SQS queues, IAM roles).
 *
 * Safety is built into the shape of the API: the executor defaults to a
 * read-only dry run and issues mutating calls only when the caller passes an
 * explicit `apply: true`; every created resource is tagged `iap:managed=true`;
 * and destroy refuses any resource not carrying that tag.
 */

export { AwsExecutor } from './executor.js';
export type { AwsExecutorOptions, ApplyOptions, PlanOptions } from './executor.js';

export { createClientBundle } from './clients.js';
export type { ClientBundle } from './clients.js';

export { resolveRegion, resolveCredentials } from './credentials.js';
export type { AwsRuntimeOptions } from './credentials.js';

export {
  MANAGED_TAG_KEY,
  MANAGED_TAG_VALUE,
  PLAN_TAG_KEY,
  RESOURCE_TAG_KEY,
  buildTags,
  fromTagList,
  isManaged,
  toTagList,
} from './tags.js';

export { S3BucketHandler } from './s3.js';
export { SqsQueueHandler } from './sqs.js';
export { IamRoleHandler } from './iam.js';
export { AcmCertificateHandler } from './acm.js';
export { ResourceGroupHandler } from './resource-groups.js';
export { SecretsManagerSecretHandler } from './secrets-manager.js';
export { TargetGroupHandler } from './target-group.js';
export { EcsServiceHandler } from './ecs-service.js';
export { ElastiCacheReplicationGroupHandler } from './elasticache.js';
export { LoadBalancerHandler } from './load-balancer.js';
export { RdsInstanceHandler } from './rds-instance.js';
export { RdsSubnetGroupHandler } from './rds-subnet-group.js';
export { defaultSecurityGroupId, defaultSubnetIds, defaultVpcId } from './network.js';
export { ApiGatewayHttpApiHandler } from './apigateway-http-api.js';
export { LambdaFunctionHandler } from './lambda-function.js';
export { LogGroupHandler } from './log-group.js';
export { SchedulerScheduleHandler, toScheduleExpression } from './scheduler-schedule.js';
export { SnsTopicHandler } from './sns-topic.js';
export { SsmParameterHandler } from './ssm-parameter.js';
export { DynamoDbTableHandler } from './dynamodb.js';
export { TimestreamDatabaseHandler, TimestreamTableHandler } from './timestream.js';
export { KmsKeyHandler } from './kms.js';
export { BackupPlanHandler, BackupVaultHandler } from './backup.js';
export { RdsClusterHandler, RdsClusterInstanceHandler } from './rds-cluster.js';
export { DocdbClusterHandler, DocdbInstanceHandler } from './docdb.js';
export { NeptuneClusterHandler, NeptuneInstanceHandler } from './neptune.js';
export { MemoryDbClusterHandler } from './memorydb.js';
export { MqBrokerHandler } from './mq.js';
export { Ec2VolumeHandler } from './ec2-volume.js';
export { EfsFileSystemHandler } from './efs.js';
export { FsxFileSystemHandler } from './fsx.js';
export { Ec2InstanceHandler } from './ec2-instance.js';
export { LaunchTemplateHandler } from './launch-template.js';
export { AutoScalingGroupHandler } from './autoscaling.js';
export { AppRunnerServiceHandler } from './apprunner.js';
export {
  BatchComputeEnvironmentHandler,
  BatchJobDefinitionHandler,
  BatchJobQueueHandler,
} from './batch.js';
export { Wafv2WebAclHandler } from './wafv2.js';
export { Route53HostedZoneHandler, Route53RecordSetHandler } from './route53.js';
export { EcrRepositoryHandler } from './ecr.js';
export { CloudWatchAlarmHandler, CloudWatchDashboardHandler } from './cloudwatch.js';
export { KeyspacesKeyspaceHandler, KeyspacesTableHandler } from './keyspaces.js';
export {
  RedshiftServerlessNamespaceHandler,
  RedshiftServerlessWorkgroupHandler,
} from './redshift-serverless.js';
export { VpcHandler, SubnetHandler, SecurityGroupHandler } from './vpc.js';
export { InternetGatewayHandler, RouteTableHandler, NatGatewayHandler } from './network-routing.js';
export { StateMachineHandler } from './state-machine.js';
export { KinesisStreamHandler } from './kinesis.js';
export { FirehoseDeliveryStreamHandler } from './firehose.js';
export { MskClusterHandler } from './msk.js';
export { OpenSearchDomainHandler } from './opensearch.js';
export { CloudFrontDistributionHandler } from './cloudfront.js';
export { EventBusHandler, EventRuleHandler } from './eventbridge.js';
export { CognitoUserPoolHandler, CognitoUserPoolClientHandler } from './cognito.js';

export { resourceIdOf } from './util.js';

export {
  HANDLER_REGISTRATIONS,
  HANDLER_REGISTRY,
  SUPPORTED_TARGET_TYPES,
  buildHandlerRegistry,
  isSupportedTargetType,
} from './registry.js';
export type { HandlerContext, HandlerRegistration } from './registry.js';

export { UnsupportedTargetTypeError } from './types.js';
export type { SupportedTargetType } from './registry.js';
export type {
  ApplyOutcomeItem,
  ApplyReport,
  PlanAction,
  PlanItem,
  PlanReport,
  ResourceState,
  TargetHandler,
} from './types.js';
