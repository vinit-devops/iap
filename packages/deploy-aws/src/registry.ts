/**
 * Handler registry (ADR-0004). Each handler class self-declares its
 * `targetType` as a static; a registration pairs that declaration with a
 * factory. `SUPPORTED_TARGET_TYPES` and the dispatch map are DERIVED from the
 * registrations — adding a handler means adding exactly one `register(...)`
 * line, never editing a hand-maintained list.
 *
 * Registration is static (no dynamic/plugin loading) so the supported set is
 * deterministic and auditable; an unregistered target type still fails closed
 * via `UnsupportedTargetTypeError` at the executor boundary.
 */

import type { ClientBundle } from './clients.js';
import { S3BucketHandler } from './s3.js';
import { SqsQueueHandler } from './sqs.js';
import { IamRoleHandler } from './iam.js';
import { AcmCertificateHandler } from './acm.js';
import { ResourceGroupHandler } from './resource-groups.js';
import { SecretsManagerSecretHandler } from './secrets-manager.js';
import { TargetGroupHandler } from './target-group.js';
import { EcsServiceHandler } from './ecs-service.js';
import { ElastiCacheReplicationGroupHandler } from './elasticache.js';
import { LoadBalancerHandler } from './load-balancer.js';
import { RdsInstanceHandler } from './rds-instance.js';
import { RdsSubnetGroupHandler } from './rds-subnet-group.js';
import { ApiGatewayHttpApiHandler } from './apigateway-http-api.js';
import { LambdaFunctionHandler } from './lambda-function.js';
import { LogGroupHandler } from './log-group.js';
import { SchedulerScheduleHandler } from './scheduler-schedule.js';
import { SnsTopicHandler } from './sns-topic.js';
import { SsmParameterHandler } from './ssm-parameter.js';
import { DynamoDbTableHandler } from './dynamodb.js';
import { TimestreamDatabaseHandler, TimestreamTableHandler } from './timestream.js';
import { KmsKeyHandler } from './kms.js';
import { BackupPlanHandler, BackupVaultHandler } from './backup.js';
import { RdsClusterHandler, RdsClusterInstanceHandler } from './rds-cluster.js';
import { DocdbClusterHandler, DocdbInstanceHandler } from './docdb.js';
import { NeptuneClusterHandler, NeptuneInstanceHandler } from './neptune.js';
import { MemoryDbClusterHandler } from './memorydb.js';
import { MqBrokerHandler } from './mq.js';
import { Ec2VolumeHandler } from './ec2-volume.js';
import { EfsFileSystemHandler } from './efs.js';
import { FsxFileSystemHandler } from './fsx.js';
import { Ec2InstanceHandler } from './ec2-instance.js';
import { LaunchTemplateHandler } from './launch-template.js';
import { AutoScalingGroupHandler } from './autoscaling.js';
import { AppRunnerServiceHandler } from './apprunner.js';
import {
  BatchComputeEnvironmentHandler,
  BatchJobDefinitionHandler,
  BatchJobQueueHandler,
} from './batch.js';
import { Wafv2WebAclHandler } from './wafv2.js';
import { Route53HostedZoneHandler, Route53RecordSetHandler } from './route53.js';
import { EcrRepositoryHandler } from './ecr.js';
import { CloudWatchAlarmHandler, CloudWatchDashboardHandler } from './cloudwatch.js';
import { KeyspacesKeyspaceHandler, KeyspacesTableHandler } from './keyspaces.js';
import {
  RedshiftServerlessNamespaceHandler,
  RedshiftServerlessWorkgroupHandler,
} from './redshift-serverless.js';
import { VpcHandler, SubnetHandler, SecurityGroupHandler } from './vpc.js';
import { InternetGatewayHandler, RouteTableHandler, NatGatewayHandler } from './network-routing.js';
import { StateMachineHandler } from './state-machine.js';
import { KinesisStreamHandler } from './kinesis.js';
import { FirehoseDeliveryStreamHandler } from './firehose.js';
import { MskClusterHandler } from './msk.js';
import { OpenSearchDomainHandler } from './opensearch.js';
import { CloudFrontDistributionHandler } from './cloudfront.js';
import { EventBusHandler, EventRuleHandler } from './eventbridge.js';
import { CognitoUserPoolHandler, CognitoUserPoolClientHandler } from './cognito.js';
import type { TargetHandler } from './types.js';

/** Everything a handler factory may need; clients are lazy (ADR-0004). */
export interface HandlerContext {
  clients: ClientBundle;
  region: string;
}

export interface HandlerRegistration<T extends string = string> {
  readonly targetType: T;
  readonly create: (context: HandlerContext) => TargetHandler;
}

/** Pair a handler class's self-declared targetType with its factory. */
function register<T extends string>(
  handlerClass: { readonly targetType: T },
  create: (context: HandlerContext) => TargetHandler,
): HandlerRegistration<T> {
  return { targetType: handlerClass.targetType, create };
}

export const HANDLER_REGISTRATIONS = [
  register(S3BucketHandler, (ctx) => new S3BucketHandler(ctx.clients.s3, ctx.region)),
  register(SqsQueueHandler, (ctx) => new SqsQueueHandler(ctx.clients.sqs)),
  register(IamRoleHandler, (ctx) => new IamRoleHandler(ctx.clients.iam)),
  // M21.2 — cheap mapped targets
  register(ResourceGroupHandler, (ctx) => new ResourceGroupHandler(ctx.clients.resourceGroups)),
  register(
    SecretsManagerSecretHandler,
    (ctx) => new SecretsManagerSecretHandler(ctx.clients.secretsManager),
  ),
  register(
    AcmCertificateHandler,
    (ctx) => new AcmCertificateHandler(ctx.clients.acm, ctx.clients.route53),
  ),
  register(TargetGroupHandler, (ctx) => new TargetGroupHandler(ctx.clients.elbv2, ctx.clients.ec2)),
  // M21.3 — compute/data mapped targets (every mapped target executable)
  register(EcsServiceHandler, (ctx) => new EcsServiceHandler(ctx.clients.ecs, ctx.clients.ec2)),
  register(
    LoadBalancerHandler,
    (ctx) => new LoadBalancerHandler(ctx.clients.elbv2, ctx.clients.ec2),
  ),
  register(RdsInstanceHandler, (ctx) => new RdsInstanceHandler(ctx.clients.rds)),
  register(
    RdsSubnetGroupHandler,
    (ctx) => new RdsSubnetGroupHandler(ctx.clients.rds, ctx.clients.ec2),
  ),
  register(
    ElastiCacheReplicationGroupHandler,
    (ctx) => new ElastiCacheReplicationGroupHandler(ctx.clients.elasticache, ctx.clients.ec2),
  ),
  // M22.1 — serverless core
  register(
    LambdaFunctionHandler,
    (ctx) => new LambdaFunctionHandler(ctx.clients.lambda, ctx.clients.iam),
  ),
  register(
    ApiGatewayHttpApiHandler,
    (ctx) => new ApiGatewayHttpApiHandler(ctx.clients.apigatewayv2, ctx.region),
  ),
  register(
    SnsTopicHandler,
    (ctx) => new SnsTopicHandler(ctx.clients.sns, ctx.clients.sts, ctx.region),
  ),
  register(SsmParameterHandler, (ctx) => new SsmParameterHandler(ctx.clients.ssm)),
  register(
    SchedulerScheduleHandler,
    (ctx) =>
      new SchedulerScheduleHandler(ctx.clients.scheduler, ctx.clients.lambda, ctx.clients.iam),
  ),
  register(LogGroupHandler, (ctx) => new LogGroupHandler(ctx.clients.cloudwatchLogs)),
  // M22.2 — serverless data + derived posture
  register(DynamoDbTableHandler, (ctx) => new DynamoDbTableHandler(ctx.clients.dynamodb)),
  register(
    TimestreamDatabaseHandler,
    (ctx) => new TimestreamDatabaseHandler(ctx.clients.timestreamWrite),
  ),
  register(
    TimestreamTableHandler,
    (ctx) => new TimestreamTableHandler(ctx.clients.timestreamWrite),
  ),
  register(KmsKeyHandler, (ctx) => new KmsKeyHandler(ctx.clients.kms)),
  register(BackupVaultHandler, (ctx) => new BackupVaultHandler(ctx.clients.backup)),
  register(BackupPlanHandler, (ctx) => new BackupPlanHandler(ctx.clients.backup)),
  // M22.3 — VPC data engines
  register(RdsClusterHandler, (ctx) => new RdsClusterHandler(ctx.clients.rds, ctx.clients.ec2)),
  register(RdsClusterInstanceHandler, (ctx) => new RdsClusterInstanceHandler(ctx.clients.rds)),
  register(
    DocdbClusterHandler,
    (ctx) => new DocdbClusterHandler(ctx.clients.docdb, ctx.clients.ec2),
  ),
  register(DocdbInstanceHandler, (ctx) => new DocdbInstanceHandler(ctx.clients.docdb)),
  register(
    NeptuneClusterHandler,
    (ctx) => new NeptuneClusterHandler(ctx.clients.neptune, ctx.clients.ec2),
  ),
  register(NeptuneInstanceHandler, (ctx) => new NeptuneInstanceHandler(ctx.clients.neptune)),
  register(
    MemoryDbClusterHandler,
    (ctx) => new MemoryDbClusterHandler(ctx.clients.memorydb, ctx.clients.ec2),
  ),
  register(MqBrokerHandler, (ctx) => new MqBrokerHandler(ctx.clients.mq, ctx.clients.ec2)),
  // M22.4 — volumes
  register(Ec2VolumeHandler, (ctx) => new Ec2VolumeHandler(ctx.clients.ec2)),
  register(
    EfsFileSystemHandler,
    (ctx) => new EfsFileSystemHandler(ctx.clients.efs, ctx.clients.ec2),
  ),
  register(
    FsxFileSystemHandler,
    (ctx) => new FsxFileSystemHandler(ctx.clients.fsx, ctx.clients.ec2),
  ),
  // M22.5 — compute runtimes + edge-adjacent
  register(Ec2InstanceHandler, (ctx) => new Ec2InstanceHandler(ctx.clients.ec2)),
  register(LaunchTemplateHandler, (ctx) => new LaunchTemplateHandler(ctx.clients.ec2)),
  register(
    AutoScalingGroupHandler,
    (ctx) => new AutoScalingGroupHandler(ctx.clients.autoscaling, ctx.clients.ec2),
  ),
  register(AppRunnerServiceHandler, (ctx) => new AppRunnerServiceHandler(ctx.clients.apprunner)),
  register(
    BatchComputeEnvironmentHandler,
    (ctx) => new BatchComputeEnvironmentHandler(ctx.clients.batch),
  ),
  register(BatchJobQueueHandler, (ctx) => new BatchJobQueueHandler(ctx.clients.batch)),
  register(BatchJobDefinitionHandler, (ctx) => new BatchJobDefinitionHandler(ctx.clients.batch)),
  register(Wafv2WebAclHandler, (ctx) => new Wafv2WebAclHandler(ctx.clients.wafv2)),
  // M23.2 — 1.1.0 handler wave (graduated kinds + wide-column/warehouse Database)
  register(Route53HostedZoneHandler, (ctx) => new Route53HostedZoneHandler(ctx.clients.route53)),
  register(Route53RecordSetHandler, (ctx) => new Route53RecordSetHandler(ctx.clients.route53)),
  register(EcrRepositoryHandler, (ctx) => new EcrRepositoryHandler(ctx.clients.ecr)),
  register(CloudWatchAlarmHandler, (ctx) => new CloudWatchAlarmHandler(ctx.clients.cloudwatch)),
  register(
    CloudWatchDashboardHandler,
    (ctx) => new CloudWatchDashboardHandler(ctx.clients.cloudwatch),
  ),
  register(KeyspacesKeyspaceHandler, (ctx) => new KeyspacesKeyspaceHandler(ctx.clients.keyspaces)),
  register(KeyspacesTableHandler, (ctx) => new KeyspacesTableHandler(ctx.clients.keyspaces)),
  register(
    RedshiftServerlessNamespaceHandler,
    (ctx) => new RedshiftServerlessNamespaceHandler(ctx.clients.redshiftServerless),
  ),
  register(
    RedshiftServerlessWorkgroupHandler,
    (ctx) => new RedshiftServerlessWorkgroupHandler(ctx.clients.redshiftServerless),
  ),
  // M23.4 — Network (VPC graph) + Workflow (Step Functions)
  register(VpcHandler, (ctx) => new VpcHandler(ctx.clients.ec2)),
  register(SubnetHandler, (ctx) => new SubnetHandler(ctx.clients.ec2)),
  register(SecurityGroupHandler, (ctx) => new SecurityGroupHandler(ctx.clients.ec2)),
  register(InternetGatewayHandler, (ctx) => new InternetGatewayHandler(ctx.clients.ec2)),
  register(RouteTableHandler, (ctx) => new RouteTableHandler(ctx.clients.ec2)),
  register(NatGatewayHandler, (ctx) => new NatGatewayHandler(ctx.clients.ec2)),
  register(StateMachineHandler, (ctx) => new StateMachineHandler(ctx.clients.sfn)),
  // M23.5 — Stream (Kinesis/Firehose/MSK) + Search (OpenSearch)
  register(KinesisStreamHandler, (ctx) => new KinesisStreamHandler(ctx.clients.kinesis)),
  register(
    FirehoseDeliveryStreamHandler,
    (ctx) => new FirehoseDeliveryStreamHandler(ctx.clients.firehose),
  ),
  register(MskClusterHandler, (ctx) => new MskClusterHandler(ctx.clients.kafka, ctx.clients.ec2)),
  register(OpenSearchDomainHandler, (ctx) => new OpenSearchDomainHandler(ctx.clients.opensearch)),
  // M24.2 — edge (Cdn) + eventing (EventBus) + Cognito (Identity user-directory)
  register(
    CloudFrontDistributionHandler,
    (ctx) => new CloudFrontDistributionHandler(ctx.clients.cloudfront),
  ),
  register(EventBusHandler, (ctx) => new EventBusHandler(ctx.clients.eventbridge)),
  register(EventRuleHandler, (ctx) => new EventRuleHandler(ctx.clients.eventbridge)),
  register(CognitoUserPoolHandler, (ctx) => new CognitoUserPoolHandler(ctx.clients.cognito)),
  register(
    CognitoUserPoolClientHandler,
    (ctx) => new CognitoUserPoolClientHandler(ctx.clients.cognito),
  ),
] as const;

/** Build a dispatch map, failing fast on duplicate targetType declarations. */
export function buildHandlerRegistry(
  registrations: readonly HandlerRegistration[],
): Map<string, HandlerRegistration> {
  const map = new Map<string, HandlerRegistration>();
  for (const registration of registrations) {
    if (map.has(registration.targetType)) {
      throw new Error(`duplicate handler registration for target type: ${registration.targetType}`);
    }
    map.set(registration.targetType, registration);
  }
  return map;
}

export const HANDLER_REGISTRY: ReadonlyMap<string, HandlerRegistration> =
  buildHandlerRegistry(HANDLER_REGISTRATIONS);

/** The target types the executor realizes — derived, not hand-maintained. */
export type SupportedTargetType = (typeof HANDLER_REGISTRATIONS)[number]['targetType'];

export const SUPPORTED_TARGET_TYPES: readonly SupportedTargetType[] = HANDLER_REGISTRATIONS.map(
  (registration) => registration.targetType,
);

export function isSupportedTargetType(type: string): type is SupportedTargetType {
  return HANDLER_REGISTRY.has(type);
}
