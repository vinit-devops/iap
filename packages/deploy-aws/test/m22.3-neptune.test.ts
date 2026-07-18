/**
 * M22.3 `aws:neptune:DBCluster` + `aws:neptune:DBInstance` handlers,
 * mock-tested: handler-owned subnet group created BEFORE the cluster (M21.3
 * ElastiCache live-fix pattern), the deliberate ABSENCE of master credentials
 * (Neptune auth is IAM/none), converged no-op, retention drift updating in
 * place, the immutable engine replace (gated delete+create), teardown order
 * (cluster then subnet group), and the instance's fail-closed clusterId
 * contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateDBClusterCommand,
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  ListTagsForResourceCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  NeptuneClient,
} from '@aws-sdk/client-neptune';
import { DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const neptune = mockClient(NeptuneClient);
const ec2 = mockClient(EC2Client);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => {
  neptune.reset();
  ec2.reset();
});

function mockDefaultNetwork() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
      { SubnetId: 'subnet-c', AvailabilityZone: 'eu-central-1c' },
    ],
  });
}

const MANAGED = [{ Key: 'iap:managed', Value: 'true' }];

const liveCluster = {
  DBClusterIdentifier: 'graph',
  DBClusterArn: 'arn:aws:rds:eu-central-1:000000000000:cluster:graph',
  Status: 'available',
  Engine: 'neptune',
  BackupRetentionPeriod: 1,
  DeletionProtection: false,
};

const liveInstance = {
  DBInstanceIdentifier: 'graph-a',
  DBInstanceArn: 'arn:aws:rds:eu-central-1:000000000000:db:graph-a',
  DBInstanceStatus: 'available',
  Engine: 'neptune',
  DBClusterIdentifier: 'graph',
  DBInstanceClass: 'db.t4g.medium',
};

describe('aws:neptune:DBCluster', () => {
  const plan = providerPlan([planResource('graph', 'aws:neptune:DBCluster', {})]);

  it('absent → handler-owned subnet group FIRST, then CreateDBCluster (neptune, encrypted, tagged)', async () => {
    neptune.on(DescribeDBClustersCommand).rejects(serviceError('DBClusterNotFoundFault'));
    neptune.on(CreateDBSubnetGroupCommand).resolves({});
    neptune
      .on(CreateDBClusterCommand)
      .resolves({ DBCluster: { DBClusterArn: 'arn:neptune/graph' } });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:neptune/graph');
    // Subnet group strictly BEFORE the cluster (M21.3 live-fix pattern).
    const order = neptune
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'CreateDBSubnetGroupCommand' || n === 'CreateDBClusterCommand');
    expect(order).toEqual(['CreateDBSubnetGroupCommand', 'CreateDBClusterCommand']);

    const sg = neptune.commandCalls(CreateDBSubnetGroupCommand)[0]?.args[0].input;
    expect(sg?.DBSubnetGroupName).toBe('graph-subnets');
    expect(sg?.SubnetIds).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);

    const input = neptune.commandCalls(CreateDBClusterCommand)[0]?.args[0].input;
    expect(input?.DBClusterIdentifier).toBe('graph');
    expect(input?.Engine).toBe('neptune');
    expect(input?.DBSubnetGroupName).toBe('graph-subnets');
    expect(input?.StorageEncrypted).toBe(true);
    expect(input?.BackupRetentionPeriod).toBe(1); // default
    expect(input?.DeletionProtection).toBe(false); // default
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('create sends NO master credentials (Neptune auth is IAM/none)', async () => {
    neptune.on(DescribeDBClustersCommand).rejects(serviceError('DBClusterNotFoundFault'));
    neptune.on(CreateDBSubnetGroupCommand).resolves({});
    neptune.on(CreateDBClusterCommand).resolves({});
    mockDefaultNetwork();

    await executor().apply(plan, { apply: true });

    const input = neptune.commandCalls(CreateDBClusterCommand)[0]?.args[0].input;
    expect(input?.MasterUsername).toBeUndefined();
    expect(input?.MasterUserPassword).toBeUndefined();
  });

  it('present + converged → no-op, nothing mutated', async () => {
    neptune.on(DescribeDBClustersCommand).resolves({ DBClusters: [liveCluster] });
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(neptune.commandCalls(CreateDBClusterCommand)).toHaveLength(0);
    expect(neptune.commandCalls(ModifyDBClusterCommand)).toHaveLength(0);
    expect(neptune.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);
  });

  it('backupRetentionPeriod drift → ModifyDBCluster in place (ApplyImmediately), no delete', async () => {
    const retained = providerPlan([
      planResource('graph', 'aws:neptune:DBCluster', { backupRetentionPeriod: 14 }),
    ]);
    neptune.on(DescribeDBClustersCommand).resolves({ DBClusters: [liveCluster] }); // live: 1
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    neptune.on(ModifyDBClusterCommand).resolves({});

    const report = await executor().apply(retained, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = neptune.commandCalls(ModifyDBClusterCommand)[0]?.args[0].input;
    expect(input?.DBClusterIdentifier).toBe('graph');
    expect(input?.BackupRetentionPeriod).toBe(14);
    expect(input?.ApplyImmediately).toBe(true);
    expect(input?.DeletionProtection).toBeUndefined(); // only the drifted attribute
    expect(neptune.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);
  });

  it('engine drift is IMMUTABLE → replace; gate open executes delete THEN create', async () => {
    const drifted = providerPlan([
      planResource('graph', 'aws:neptune:DBCluster', { engine: 'neptune-serverless' }),
    ]);
    // Reads: plan, refused apply, gated apply — then the deletion waiter
    // observes the cluster gone.
    neptune
      .on(DescribeDBClustersCommand)
      .resolvesOnce({ DBClusters: [liveCluster] })
      .resolvesOnce({ DBClusters: [liveCluster] })
      .resolvesOnce({ DBClusters: [liveCluster] })
      .resolves({ DBClusters: [] });
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    neptune.on(DeleteDBClusterCommand).resolves({});
    neptune.on(DeleteDBSubnetGroupCommand).resolves({});
    neptune.on(CreateDBSubnetGroupCommand).resolves({});
    neptune
      .on(CreateDBClusterCommand)
      .resolves({ DBCluster: { DBClusterArn: 'arn:neptune/graph2' } });
    mockDefaultNetwork();

    const planned = await executor().plan(drifted);
    expect(planned.items[0]?.action).toBe('replace');

    // Replacement gate closed → refuses, nothing destroyed.
    const refused = await executor().apply(drifted, { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(neptune.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);

    // Gate open → old cluster (and its subnet group) torn down, then recreated.
    const report = await executor().apply(drifted, { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:neptune/graph2');
    const order = neptune
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) =>
        [
          'DeleteDBClusterCommand',
          'DeleteDBSubnetGroupCommand',
          'CreateDBSubnetGroupCommand',
          'CreateDBClusterCommand',
        ].includes(n),
      );
    expect(order).toEqual([
      'DeleteDBClusterCommand',
      'DeleteDBSubnetGroupCommand',
      'CreateDBSubnetGroupCommand',
      'CreateDBClusterCommand',
    ]);
  });

  it('destroy → DeleteDBCluster (SkipFinalSnapshot), wait for gone, then delete the subnet group', async () => {
    neptune
      .on(DescribeDBClustersCommand)
      .resolvesOnce({ DBClusters: [liveCluster] }) // the read
      .resolves({ DBClusters: [] }); // the deletion waiter
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    neptune.on(DeleteDBClusterCommand).resolves({});
    neptune.on(DeleteDBSubnetGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    const del = neptune.commandCalls(DeleteDBClusterCommand)[0]?.args[0].input;
    expect(del?.DBClusterIdentifier).toBe('graph');
    expect(del?.SkipFinalSnapshot).toBe(true);
    expect(
      neptune.commandCalls(DeleteDBSubnetGroupCommand)[0]?.args[0].input?.DBSubnetGroupName,
    ).toBe('graph-subnets');
    const order = neptune
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'DeleteDBClusterCommand' || n === 'DeleteDBSubnetGroupCommand');
    expect(order).toEqual(['DeleteDBClusterCommand', 'DeleteDBSubnetGroupCommand']);
  });

  it('destroy refuses an unmanaged cluster (managed-only gate)', async () => {
    neptune.on(DescribeDBClustersCommand).resolves({ DBClusters: [liveCluster] });
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: [] }); // not ours

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(neptune.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);
  });
});

describe('aws:neptune:DBInstance', () => {
  const instancePlan = providerPlan([
    planResource('graph-a', 'aws:neptune:DBInstance', { clusterId: 'graph' }),
  ]);

  it('absent → CreateDBInstance joined to the clusterId, default db.t4g.medium, no credentials', async () => {
    neptune.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));
    neptune.on(CreateDBInstanceCommand).resolves({
      DBInstance: { DBInstanceArn: 'arn:neptune/graph-a' },
    });

    const report = await executor().apply(instancePlan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:neptune/graph-a');
    const input = neptune.commandCalls(CreateDBInstanceCommand)[0]?.args[0].input;
    expect(input?.DBInstanceIdentifier).toBe('graph-a');
    expect(input?.DBClusterIdentifier).toBe('graph');
    expect(input?.DBInstanceClass).toBe('db.t4g.medium'); // default
    expect(input?.Engine).toBe('neptune');
    expect(input?.MasterUsername).toBeUndefined();
    expect(input?.MasterUserPassword).toBeUndefined();
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('missing clusterId → fails closed, no instance created', async () => {
    const orphan = providerPlan([planResource('graph-a', 'aws:neptune:DBInstance', {})]);
    neptune.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));

    const report = await executor().apply(orphan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain("missing required attribute 'clusterId'");
    expect(neptune.commandCalls(CreateDBInstanceCommand)).toHaveLength(0);
  });

  it('instanceClass drift → ModifyDBInstance in place (mutable)', async () => {
    const resized = providerPlan([
      planResource('graph-a', 'aws:neptune:DBInstance', {
        clusterId: 'graph',
        instanceClass: 'db.r6g.large',
      }),
    ]);
    neptune.on(DescribeDBInstancesCommand).resolves({ DBInstances: [liveInstance] });
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    neptune.on(ModifyDBInstanceCommand).resolves({});

    const report = await executor().apply(resized, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    const input = neptune.commandCalls(ModifyDBInstanceCommand)[0]?.args[0].input;
    expect(input?.DBInstanceIdentifier).toBe('graph-a');
    expect(input?.DBInstanceClass).toBe('db.r6g.large');
    expect(input?.ApplyImmediately).toBe(true);
    expect(neptune.commandCalls(DeleteDBInstanceCommand)).toHaveLength(0);
  });

  it('clusterId drift is IMMUTABLE → replace classification', async () => {
    const moved = providerPlan([
      planResource('graph-a', 'aws:neptune:DBInstance', { clusterId: 'other-cluster' }),
    ]);
    neptune.on(DescribeDBInstancesCommand).resolves({ DBInstances: [liveInstance] }); // live: graph
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });

    const planned = await executor().plan(moved);
    expect(planned.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteDBInstance, then waits until the instance is gone (cluster deletes next)', async () => {
    neptune
      .on(DescribeDBInstancesCommand)
      .resolvesOnce({ DBInstances: [liveInstance] }) // the read
      .resolves({ DBInstances: [] }); // the deletion waiter
    neptune.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    neptune.on(DeleteDBInstanceCommand).resolves({});

    const report = await executor().apply(instancePlan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(
      neptune.commandCalls(DeleteDBInstanceCommand)[0]?.args[0].input?.DBInstanceIdentifier,
    ).toBe('graph-a');
    // The waiter re-described after the delete.
    expect(neptune.commandCalls(DescribeDBInstancesCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('a deleting instance reads as absent (never updated, never resurrected)', async () => {
    neptune.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [{ ...liveInstance, DBInstanceStatus: 'deleting' }],
    });

    const planned = await executor().plan(instancePlan);
    expect(planned.items[0]?.action).toBe('create'); // absent-in-progress
    expect(neptune.commandCalls(ListTagsForResourceCommand)).toHaveLength(0); // not even tag-read
  });
});
