/**
 * M21.3 handlers, mock-tested (aws-sdk-client-mock): ECS Service, ALB
 * LoadBalancer, RDS DBInstance + DBSubnetGroup, ElastiCache ReplicationGroup.
 * After this wave every target type in core.iap-map.yaml is executable.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateClusterCommand,
  CreateServiceCommand,
  DeleteClusterCommand,
  DeleteServiceCommand,
  DeregisterTaskDefinitionCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTaskDefinitionsCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import {
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  ElasticLoadBalancingV2Client,
  ModifyLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBInstanceCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  ListTagsForResourceCommand as RdsListTagsCommand,
  ModifyDBInstanceCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  CreateCacheSubnetGroupCommand,
  CreateReplicationGroupCommand,
  DeleteCacheSubnetGroupCommand,
  DeleteReplicationGroupCommand,
  DescribeReplicationGroupsCommand,
  ElastiCacheClient,
  IncreaseReplicaCountCommand,
  ListTagsForResourceCommand as EcListTagsCommand,
} from '@aws-sdk/client-elasticache';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const ecs = mockClient(ECSClient);
const elbv2 = mockClient(ElasticLoadBalancingV2Client);
const rds = mockClient(RDSClient);
const ec = mockClient(ElastiCacheClient);
const ec2 = mockClient(EC2Client);

const MANAGED = [{ Key: 'iap:managed', Value: 'true' }];
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

function mockDefaultNetwork() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
      { SubnetId: 'subnet-c', AvailabilityZone: 'eu-central-1c' },
    ],
  });
  ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-default' }] });
}

beforeEach(() => {
  ecs.reset();
  elbv2.reset();
  rds.reset();
  ec.reset();
  ec2.reset();
});

describe('aws:ecs:Service', () => {
  const plan = providerPlan([
    planResource('web', 'aws:ecs:Service', {
      launchType: 'FARGATE',
      image: 'public.ecr.aws/docker/library/nginx:alpine',
      cpu: 256,
      memory: 512,
      desiredCount: 1,
      assignPublicIp: false,
      availabilityZoneSpread: 2,
    }),
  ]);

  it('absent → cluster + task definition + service created on default network', async () => {
    ecs.on(DescribeServicesCommand).rejects(serviceError('ClusterNotFoundException'));
    ecs.on(CreateClusterCommand).resolves({ cluster: { clusterName: 'web-cluster' } });
    ecs.on(RegisterTaskDefinitionCommand).resolves({
      taskDefinition: { taskDefinitionArn: 'arn:td/web:1' },
    });
    ecs.on(CreateServiceCommand).resolves({ service: { serviceArn: 'arn:svc/web' } });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe('arn:svc/web');
    const svc = ecs.commandCalls(CreateServiceCommand)[0]?.args[0].input;
    expect(svc?.cluster).toBe('web-cluster');
    expect(svc?.launchType).toBe('FARGATE');
    expect(svc?.networkConfiguration?.awsvpcConfiguration?.subnets).toEqual([
      'subnet-a',
      'subnet-b',
    ]);
    expect(svc?.networkConfiguration?.awsvpcConfiguration?.assignPublicIp).toBe('DISABLED');
    const td = ecs.commandCalls(RegisterTaskDefinitionCommand)[0]?.args[0].input;
    expect(td?.containerDefinitions?.[0]?.image).toBe('public.ecr.aws/docker/library/nginx:alpine');
  });

  it('present + converged → no-op (image/cpu/memory read from the task definition)', async () => {
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          serviceArn: 'arn:svc/web',
          status: 'ACTIVE',
          launchType: 'FARGATE',
          desiredCount: 1,
          taskDefinition: 'arn:td/web:1',
          tags: [{ key: 'iap:managed', value: 'true' }],
          networkConfiguration: { awsvpcConfiguration: { assignPublicIp: 'DISABLED' } },
        },
      ],
    });
    ecs.on(DescribeTaskDefinitionCommand).resolves({
      taskDefinition: {
        cpu: '256',
        memory: '512',
        containerDefinitions: [{ image: 'public.ecr.aws/docker/library/nginx:alpine' }],
      },
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('image drift → update registers a new task definition revision', async () => {
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          serviceArn: 'arn:svc/web',
          status: 'ACTIVE',
          launchType: 'FARGATE',
          desiredCount: 1,
          taskDefinition: 'arn:td/web:1',
          tags: [{ key: 'iap:managed', value: 'true' }],
          networkConfiguration: { awsvpcConfiguration: { assignPublicIp: 'DISABLED' } },
        },
      ],
    });
    ecs.on(DescribeTaskDefinitionCommand).resolves({
      taskDefinition: {
        cpu: '256',
        memory: '512',
        containerDefinitions: [{ image: 'old-image:1' }],
      },
    });
    ecs.on(RegisterTaskDefinitionCommand).resolves({
      taskDefinition: { taskDefinitionArn: 'arn:td/web:2' },
    });
    ecs.on(UpdateServiceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    expect(ecs.commandCalls(UpdateServiceCommand)[0]?.args[0].input?.taskDefinition).toBe(
      'arn:td/web:2',
    );
  });

  it('launchType drift is IMMUTABLE → replace', async () => {
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          serviceArn: 'arn:svc/web',
          status: 'ACTIVE',
          launchType: 'EC2', // live differs from desired FARGATE
          desiredCount: 1,
          taskDefinition: 'arn:td/web:1',
          tags: [{ key: 'iap:managed', value: 'true' }],
          networkConfiguration: { awsvpcConfiguration: { assignPublicIp: 'DISABLED' } },
        },
      ],
    });
    ecs.on(DescribeTaskDefinitionCommand).resolves({
      taskDefinition: {
        cpu: '256',
        memory: '512',
        containerDefinitions: [{ image: 'public.ecr.aws/docker/library/nginx:alpine' }],
      },
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy → service + all task-definition revisions + cluster removed (waits for INACTIVE)', async () => {
    ecs
      .on(DescribeServicesCommand)
      .resolvesOnce({
        services: [
          {
            serviceArn: 'arn:svc/web',
            status: 'ACTIVE',
            launchType: 'FARGATE',
            desiredCount: 1,
            taskDefinition: 'arn:td/web:2',
            tags: [{ key: 'iap:managed', value: 'true' }],
            networkConfiguration: { awsvpcConfiguration: { assignPublicIp: 'DISABLED' } },
          },
        ],
      })
      // Post-delete waiter polls: the service is INACTIVE.
      .resolves({ services: [{ status: 'INACTIVE' }] });
    ecs.on(DescribeTaskDefinitionCommand).resolves({
      taskDefinition: {
        cpu: '256',
        memory: '512',
        containerDefinitions: [{ image: 'public.ecr.aws/docker/library/nginx:alpine' }],
      },
    });
    ecs.on(DeleteServiceCommand).resolves({});
    ecs
      .on(ListTaskDefinitionsCommand)
      .resolves({ taskDefinitionArns: ['arn:td/web:1', 'arn:td/web:2'] });
    ecs.on(DeregisterTaskDefinitionCommand).resolves({});
    ecs.on(DeleteClusterCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(ecs.commandCalls(DeleteServiceCommand)[0]?.args[0].input?.force).toBe(true);
    expect(ecs.commandCalls(DeregisterTaskDefinitionCommand)).toHaveLength(2);
    expect(ecs.commandCalls(DeleteClusterCommand)[0]?.args[0].input?.cluster).toBe('web-cluster');
  });
});

describe('aws:elasticloadbalancing:LoadBalancer', () => {
  const plan = providerPlan([
    planResource('edge', 'aws:elasticloadbalancing:LoadBalancer', {
      loadBalancerType: 'application',
      scheme: 'internal',
      dropInvalidHeaderFields: true,
      accessLogsEnabled: false,
    }),
  ]);
  const liveLb = {
    LoadBalancerArn: 'arn:lb/edge',
    LoadBalancerName: 'edge',
    Type: 'application' as const,
    Scheme: 'internal' as const,
  };

  it('absent → CreateLoadBalancer over ≥2 default subnets + attributes applied', async () => {
    elbv2.on(DescribeLoadBalancersCommand).rejects(serviceError('LoadBalancerNotFoundException'));
    mockDefaultNetwork();
    elbv2.on(CreateLoadBalancerCommand).resolves({ LoadBalancers: [liveLb] });
    elbv2.on(ModifyLoadBalancerAttributesCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.identifier).toBe('arn:lb/edge');
    const input = elbv2.commandCalls(CreateLoadBalancerCommand)[0]?.args[0].input;
    expect(input?.Subnets).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);
    const attrs = elbv2.commandCalls(ModifyLoadBalancerAttributesCommand)[0]?.args[0].input
      ?.Attributes;
    expect(attrs).toContainEqual({
      Key: 'routing.http.drop_invalid_header_fields.enabled',
      Value: 'true',
    });
  });

  it('accessLogsEnabled without a bucket fails closed', async () => {
    const bad = providerPlan([
      planResource('edge', 'aws:elasticloadbalancing:LoadBalancer', {
        scheme: 'internal',
        accessLogsEnabled: true,
      }),
    ]);
    elbv2.on(DescribeLoadBalancersCommand).rejects(serviceError('LoadBalancerNotFoundException'));
    mockDefaultNetwork();
    elbv2.on(CreateLoadBalancerCommand).resolves({ LoadBalancers: [liveLb] });

    const report = await executor().apply(bad, { apply: true });
    expect(report.errors[0]).toContain('accessLogsBucket');
  });

  it('scheme drift is IMMUTABLE → replace', async () => {
    elbv2.on(DescribeLoadBalancersCommand).resolves({
      LoadBalancers: [{ ...liveLb, Scheme: 'internet-facing' }],
    });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: 'arn:lb/edge', Tags: MANAGED }],
    });
    elbv2.on(DescribeLoadBalancerAttributesCommand).resolves({
      Attributes: [
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'access_logs.s3.enabled', Value: 'false' },
      ],
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteLoadBalancer by ARN', async () => {
    elbv2.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [liveLb] });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: 'arn:lb/edge', Tags: MANAGED }],
    });
    elbv2.on(DescribeLoadBalancerAttributesCommand).resolves({ Attributes: [] });
    elbv2.on(DeleteLoadBalancerCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(elbv2.commandCalls(DeleteLoadBalancerCommand)[0]?.args[0].input?.LoadBalancerArn).toBe(
      'arn:lb/edge',
    );
  });
});

describe('aws:rds:DBInstance', () => {
  const plan = providerPlan([
    planResource('orders-db', 'aws:rds:DBInstance', {
      engine: 'postgres',
      instanceClass: 'db.t4g.micro',
      multiAZ: false,
      storageEncrypted: true,
      allocatedStorage: 20,
      publiclyAccessible: false,
      backupRetentionPeriod: 7,
      deletionProtection: true,
    }),
  ]);
  const liveDb = {
    DBInstanceIdentifier: 'orders-db',
    DBInstanceArn: 'arn:rds/orders-db',
    Engine: 'postgres',
    DBInstanceClass: 'db.t4g.micro',
    MultiAZ: false,
    StorageEncrypted: true,
    AllocatedStorage: 20,
    PubliclyAccessible: false,
    BackupRetentionPeriod: 7,
    DeletionProtection: true,
    TagList: MANAGED,
  };

  it('absent → CreateDBInstance with RDS-managed master password (no secret material)', async () => {
    rds.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));
    rds
      .on(CreateDBInstanceCommand)
      .resolves({ DBInstance: { DBInstanceArn: 'arn:rds/orders-db' } });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    const input = rds.commandCalls(CreateDBInstanceCommand)[0]?.args[0].input;
    expect(input?.ManageMasterUserPassword).toBe(true);
    expect(input?.MasterUserPassword).toBeUndefined();
    expect(input?.DeletionProtection).toBe(true);
    expect(input?.StorageEncrypted).toBe(true);
  });

  it('present + converged → no-op', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [liveDb] });
    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('backup-retention drift → targeted ModifyDBInstance (ApplyImmediately)', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [{ ...liveDb, BackupRetentionPeriod: 1 }],
    });
    rds.on(ModifyDBInstanceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    const input = rds.commandCalls(ModifyDBInstanceCommand)[0]?.args[0].input;
    expect(input?.BackupRetentionPeriod).toBe(7);
    expect(input?.ApplyImmediately).toBe(true);
    expect(input?.DBInstanceClass).toBeUndefined(); // only the drifted field
  });

  it('engine drift is IMMUTABLE → replace', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [{ ...liveDb, Engine: 'mysql' }],
    });
    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy → deletion protection disabled FIRST, then delete without snapshot', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [liveDb] });
    rds.on(ModifyDBInstanceCommand).resolves({});
    rds.on(DeleteDBInstanceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(rds.commandCalls(ModifyDBInstanceCommand)[0]?.args[0].input?.DeletionProtection).toBe(
      false,
    );
    const del = rds.commandCalls(DeleteDBInstanceCommand)[0]?.args[0].input;
    expect(del?.SkipFinalSnapshot).toBe(true);
    expect(del?.DeleteAutomatedBackups).toBe(true);
  });
});

describe('aws:rds:DBSubnetGroup', () => {
  const plan = providerPlan([
    planResource('orders-db-subnets', 'aws:rds:DBSubnetGroup', { subnetTier: 'private' }),
  ]);

  it('absent → CreateDBSubnetGroup over the default VPC subnets with the tier tag', async () => {
    rds.on(DescribeDBSubnetGroupsCommand).rejects(serviceError('DBSubnetGroupNotFoundFault'));
    mockDefaultNetwork();
    rds.on(CreateDBSubnetGroupCommand).resolves({
      DBSubnetGroup: { DBSubnetGroupArn: 'arn:rds:subgrp/orders-db-subnets' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    const input = rds.commandCalls(CreateDBSubnetGroupCommand)[0]?.args[0].input;
    expect(input?.SubnetIds).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);
    expect(input?.Tags).toContainEqual({ Key: 'iap:subnetTier', Value: 'private' });
  });

  it('present + converged → no-op (tier round-trips via the tag)', async () => {
    rds.on(DescribeDBSubnetGroupsCommand).resolves({
      DBSubnetGroups: [{ DBSubnetGroupArn: 'arn:rds:subgrp/orders-db-subnets' }],
    });
    rds.on(RdsListTagsCommand).resolves({
      TagList: [...MANAGED, { Key: 'iap:subnetTier', Value: 'private' }],
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('destroy → DeleteDBSubnetGroup', async () => {
    rds.on(DescribeDBSubnetGroupsCommand).resolves({
      DBSubnetGroups: [{ DBSubnetGroupArn: 'arn:rds:subgrp/orders-db-subnets' }],
    });
    rds.on(RdsListTagsCommand).resolves({ TagList: MANAGED });
    rds.on(DeleteDBSubnetGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
  });
});

describe('aws:elasticache:ReplicationGroup', () => {
  const plan = providerPlan([
    planResource('session-cache', 'aws:elasticache:ReplicationGroup', {
      engine: 'redis',
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      automaticFailoverEnabled: false,
      numCacheClusters: 1,
      authTokenEnabled: true,
    }),
  ]);
  const liveRg = {
    ReplicationGroupId: 'session-cache',
    ARN: 'arn:ec/session-cache',
    Engine: 'redis',
    AtRestEncryptionEnabled: true,
    TransitEncryptionEnabled: true,
    AutomaticFailover: 'disabled' as const,
    MemberClusters: ['session-cache-001'],
    AuthTokenEnabled: true,
  };

  it('absent → cache subnet group + CreateReplicationGroup with a generated auth token (TLS on)', async () => {
    ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));
    ec.on(CreateCacheSubnetGroupCommand).resolves({});
    ec.on(CreateReplicationGroupCommand).resolves({
      ReplicationGroup: { ARN: 'arn:ec/session-cache' },
    });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    const subnetInput = ec.commandCalls(CreateCacheSubnetGroupCommand)[0]?.args[0].input;
    expect(subnetInput?.CacheSubnetGroupName).toBe('session-cache-subnets');
    expect(subnetInput?.SubnetIds).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);
    const input = ec.commandCalls(CreateReplicationGroupCommand)[0]?.args[0].input;
    expect(input?.CacheSubnetGroupName).toBe('session-cache-subnets'); // Redis AUTH needs a VPC
    expect(input?.TransitEncryptionEnabled).toBe(true);
    expect(typeof input?.AuthToken).toBe('string');
    expect((input?.AuthToken ?? '').length).toBeGreaterThanOrEqual(16);
  });

  it('no auth token is sent when transit encryption is off (AWS-rejected combo)', async () => {
    const noTls = providerPlan([
      planResource('session-cache', 'aws:elasticache:ReplicationGroup', {
        engine: 'redis',
        transitEncryptionEnabled: false,
        authTokenEnabled: true,
      }),
    ]);
    ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));
    ec.on(CreateCacheSubnetGroupCommand).resolves({});
    ec.on(CreateReplicationGroupCommand).resolves({ ReplicationGroup: { ARN: 'arn:ec/x' } });
    mockDefaultNetwork();

    await executor().apply(noTls, { apply: true });
    expect(
      ec.commandCalls(CreateReplicationGroupCommand)[0]?.args[0].input?.AuthToken,
    ).toBeUndefined();
  });

  it('present + converged → no-op', async () => {
    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [liveRg] });
    ec.on(EcListTagsCommand).resolves({ TagList: MANAGED });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('numCacheClusters increase → IncreaseReplicaCount (safe update)', async () => {
    const scaled = providerPlan([
      planResource('session-cache', 'aws:elasticache:ReplicationGroup', {
        engine: 'redis',
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        automaticFailoverEnabled: false,
        numCacheClusters: 2,
        authTokenEnabled: true,
      }),
    ]);
    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [liveRg] });
    ec.on(EcListTagsCommand).resolves({ TagList: MANAGED });
    ec.on(IncreaseReplicaCountCommand).resolves({});

    const report = await executor().apply(scaled, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    expect(ec.commandCalls(IncreaseReplicaCountCommand)[0]?.args[0].input?.NewReplicaCount).toBe(1);
  });

  it('at-rest encryption drift is IMMUTABLE → replace', async () => {
    ec.on(DescribeReplicationGroupsCommand).resolves({
      ReplicationGroups: [{ ...liveRg, AtRestEncryptionEnabled: false }],
    });
    ec.on(EcListTagsCommand).resolves({ TagList: MANAGED });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteReplicationGroup, wait for gone, then delete the subnet group', async () => {
    ec.on(DescribeReplicationGroupsCommand)
      .resolvesOnce({ ReplicationGroups: [liveRg] }) // the read
      .resolves({ ReplicationGroups: [] }); // the deletion waiter
    ec.on(EcListTagsCommand).resolves({ TagList: MANAGED });
    ec.on(DeleteReplicationGroupCommand).resolves({});
    ec.on(DeleteCacheSubnetGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(
      ec.commandCalls(DeleteReplicationGroupCommand)[0]?.args[0].input?.RetainPrimaryCluster,
    ).toBe(false);
    expect(
      ec.commandCalls(DeleteCacheSubnetGroupCommand)[0]?.args[0].input?.CacheSubnetGroupName,
    ).toBe('session-cache-subnets');
  });
});
