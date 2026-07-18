/**
 * M22.3 `aws:docdb:DBCluster` + `aws:docdb:DBInstance` handlers, mock-tested:
 * handler-owned subnet group created BEFORE the cluster (M21.3 ElastiCache
 * live-fix pattern), the locally generated master password staying write-only
 * (never projected, never in reports), converged no-op, retention drift
 * updating in place, the immutable engine replace (gated delete+create),
 * teardown order (cluster then subnet group — in-use surfacing honestly), and
 * the instance's fail-closed clusterId contract.
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
  DocDBClient,
  ListTagsForResourceCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
} from '@aws-sdk/client-docdb';
import { DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { DocdbClusterHandler } from '../src/docdb.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const docdb = mockClient(DocDBClient);
const ec2 = mockClient(EC2Client);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => {
  docdb.reset();
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
  DBClusterIdentifier: 'docs',
  DBClusterArn: 'arn:aws:rds:eu-central-1:000000000000:cluster:docs',
  Status: 'available',
  Engine: 'docdb',
  BackupRetentionPeriod: 1,
  DeletionProtection: false,
};

const liveInstance = {
  DBInstanceIdentifier: 'docs-a',
  DBInstanceArn: 'arn:aws:rds:eu-central-1:000000000000:db:docs-a',
  DBInstanceStatus: 'available',
  Engine: 'docdb',
  DBClusterIdentifier: 'docs',
  DBInstanceClass: 'db.t4g.medium',
};

describe('aws:docdb:DBCluster', () => {
  const plan = providerPlan([planResource('docs', 'aws:docdb:DBCluster', {})]);

  it('absent → handler-owned subnet group FIRST, then CreateDBCluster (docdb, encrypted, tagged)', async () => {
    docdb.on(DescribeDBClustersCommand).rejects(serviceError('DBClusterNotFoundFault'));
    docdb.on(CreateDBSubnetGroupCommand).resolves({});
    docdb.on(CreateDBClusterCommand).resolves({ DBCluster: { DBClusterArn: 'arn:docdb/docs' } });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:docdb/docs');
    // Subnet group strictly BEFORE the cluster (M21.3 live-fix pattern).
    const order = docdb
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'CreateDBSubnetGroupCommand' || n === 'CreateDBClusterCommand');
    expect(order).toEqual(['CreateDBSubnetGroupCommand', 'CreateDBClusterCommand']);

    const sg = docdb.commandCalls(CreateDBSubnetGroupCommand)[0]?.args[0].input;
    expect(sg?.DBSubnetGroupName).toBe('docs-subnets');
    expect(sg?.SubnetIds).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);

    const input = docdb.commandCalls(CreateDBClusterCommand)[0]?.args[0].input;
    expect(input?.DBClusterIdentifier).toBe('docs');
    expect(input?.Engine).toBe('docdb');
    expect(input?.DBSubnetGroupName).toBe('docs-subnets');
    expect(input?.StorageEncrypted).toBe(true);
    expect(input?.MasterUsername).toBe('iapadmin');
    expect(input?.BackupRetentionPeriod).toBe(1); // default
    expect(input?.DeletionProtection).toBe(false); // default
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('create sends a locally generated master password that never reaches projection or reports', async () => {
    docdb.on(DescribeDBClustersCommand).rejects(serviceError('DBClusterNotFoundFault'));
    docdb.on(CreateDBSubnetGroupCommand).resolves({});
    docdb.on(CreateDBClusterCommand).resolves({ DBCluster: { DBClusterArn: 'arn:docdb/docs' } });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    const password =
      docdb.commandCalls(CreateDBClusterCommand)[0]?.args[0].input?.MasterUserPassword;
    expect(typeof password).toBe('string');
    expect((password as string).length).toBeGreaterThanOrEqual(24);
    // base64url alphabet — none of the '/', '"', '@' characters DocDB rejects.
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);

    // Write-only: the password appears nowhere in the structured report...
    expect(JSON.stringify(report)).not.toContain(password);
    // ...and the drift projection has no credential surface at all.
    const projection = new DocdbClusterHandler(
      new DocDBClient({}),
      new EC2Client({}),
    ).desiredProjection(plan.resources[0]!);
    expect(Object.keys(projection).sort()).toEqual([
      'backupRetentionPeriod',
      'deletionProtection',
      'engine',
    ]);
    expect(JSON.stringify(projection)).not.toContain(password);
  });

  it('present + converged → no-op, nothing mutated', async () => {
    docdb.on(DescribeDBClustersCommand).resolves({ DBClusters: [liveCluster] });
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(docdb.commandCalls(CreateDBClusterCommand)).toHaveLength(0);
    expect(docdb.commandCalls(ModifyDBClusterCommand)).toHaveLength(0);
    expect(docdb.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);
  });

  it('backupRetentionPeriod drift → ModifyDBCluster in place (ApplyImmediately), no delete', async () => {
    const retained = providerPlan([
      planResource('docs', 'aws:docdb:DBCluster', { backupRetentionPeriod: 7 }),
    ]);
    docdb.on(DescribeDBClustersCommand).resolves({ DBClusters: [liveCluster] }); // live: 1
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    docdb.on(ModifyDBClusterCommand).resolves({});

    const report = await executor().apply(retained, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = docdb.commandCalls(ModifyDBClusterCommand)[0]?.args[0].input;
    expect(input?.DBClusterIdentifier).toBe('docs');
    expect(input?.BackupRetentionPeriod).toBe(7);
    expect(input?.ApplyImmediately).toBe(true);
    expect(input?.DeletionProtection).toBeUndefined(); // only the drifted attribute
    expect(docdb.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);
  });

  it('engine drift is IMMUTABLE → replace; gate open executes delete THEN create', async () => {
    const upgraded = providerPlan([
      planResource('docs', 'aws:docdb:DBCluster', { engine: 'docdb-elastic' }),
    ]);
    // Reads: plan, refused apply, gated apply — then the deletion waiter
    // observes the cluster gone.
    docdb
      .on(DescribeDBClustersCommand)
      .resolvesOnce({ DBClusters: [liveCluster] })
      .resolvesOnce({ DBClusters: [liveCluster] })
      .resolvesOnce({ DBClusters: [liveCluster] })
      .resolves({ DBClusters: [] });
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    docdb.on(DeleteDBClusterCommand).resolves({});
    docdb.on(DeleteDBSubnetGroupCommand).resolves({});
    docdb.on(CreateDBSubnetGroupCommand).resolves({});
    docdb.on(CreateDBClusterCommand).resolves({ DBCluster: { DBClusterArn: 'arn:docdb/docs2' } });
    mockDefaultNetwork();

    const planned = await executor().plan(upgraded);
    expect(planned.items[0]?.action).toBe('replace');

    // Replacement gate closed → refuses, nothing destroyed.
    const refused = await executor().apply(upgraded, { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(docdb.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);

    // Gate open → old cluster (and its subnet group) torn down, then recreated.
    const report = await executor().apply(upgraded, { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:docdb/docs2');
    const order = docdb
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
    docdb
      .on(DescribeDBClustersCommand)
      .resolvesOnce({ DBClusters: [liveCluster] }) // the read
      .resolves({ DBClusters: [] }); // the deletion waiter
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    docdb.on(DeleteDBClusterCommand).resolves({});
    docdb.on(DeleteDBSubnetGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    const del = docdb.commandCalls(DeleteDBClusterCommand)[0]?.args[0].input;
    expect(del?.DBClusterIdentifier).toBe('docs');
    expect(del?.SkipFinalSnapshot).toBe(true);
    expect(
      docdb.commandCalls(DeleteDBSubnetGroupCommand)[0]?.args[0].input?.DBSubnetGroupName,
    ).toBe('docs-subnets');
    const order = docdb
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'DeleteDBClusterCommand' || n === 'DeleteDBSubnetGroupCommand');
    expect(order).toEqual(['DeleteDBClusterCommand', 'DeleteDBSubnetGroupCommand']);
  });

  it('destroy surfaces a subnet-group-in-use error honestly (never swallowed)', async () => {
    docdb
      .on(DescribeDBClustersCommand)
      .resolvesOnce({ DBClusters: [liveCluster] })
      .resolves({ DBClusters: [] });
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    docdb.on(DeleteDBClusterCommand).resolves({});
    docdb.on(DeleteDBSubnetGroupCommand).rejects(serviceError('InvalidDBSubnetGroupStateFault'));

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('InvalidDBSubnetGroupStateFault');
    expect(report.errors).toHaveLength(1);
  });
});

describe('aws:docdb:DBInstance', () => {
  const instancePlan = providerPlan([
    planResource('docs-a', 'aws:docdb:DBInstance', { clusterId: 'docs' }),
  ]);

  it('absent → CreateDBInstance joined to the clusterId, default db.t4g.medium, tagged', async () => {
    docdb.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));
    docdb.on(CreateDBInstanceCommand).resolves({
      DBInstance: { DBInstanceArn: 'arn:docdb/docs-a' },
    });

    const report = await executor().apply(instancePlan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:docdb/docs-a');
    const input = docdb.commandCalls(CreateDBInstanceCommand)[0]?.args[0].input;
    expect(input?.DBInstanceIdentifier).toBe('docs-a');
    expect(input?.DBClusterIdentifier).toBe('docs');
    expect(input?.DBInstanceClass).toBe('db.t4g.medium'); // default
    expect(input?.Engine).toBe('docdb');
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('missing clusterId → fails closed, no instance created', async () => {
    const orphan = providerPlan([planResource('docs-a', 'aws:docdb:DBInstance', {})]);
    docdb.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));

    const report = await executor().apply(orphan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain("missing required attribute 'clusterId'");
    expect(docdb.commandCalls(CreateDBInstanceCommand)).toHaveLength(0);
  });

  it('instanceClass drift → ModifyDBInstance in place (mutable)', async () => {
    const resized = providerPlan([
      planResource('docs-a', 'aws:docdb:DBInstance', {
        clusterId: 'docs',
        instanceClass: 'db.r6g.large',
      }),
    ]);
    docdb.on(DescribeDBInstancesCommand).resolves({ DBInstances: [liveInstance] });
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    docdb.on(ModifyDBInstanceCommand).resolves({});

    const report = await executor().apply(resized, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    const input = docdb.commandCalls(ModifyDBInstanceCommand)[0]?.args[0].input;
    expect(input?.DBInstanceIdentifier).toBe('docs-a');
    expect(input?.DBInstanceClass).toBe('db.r6g.large');
    expect(input?.ApplyImmediately).toBe(true);
    expect(docdb.commandCalls(DeleteDBInstanceCommand)).toHaveLength(0);
  });

  it('clusterId drift is IMMUTABLE → replace classification', async () => {
    const moved = providerPlan([
      planResource('docs-a', 'aws:docdb:DBInstance', { clusterId: 'other-cluster' }),
    ]);
    docdb.on(DescribeDBInstancesCommand).resolves({ DBInstances: [liveInstance] }); // live: docs
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });

    const planned = await executor().plan(moved);
    expect(planned.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteDBInstance, then waits until the instance is gone (cluster deletes next)', async () => {
    docdb
      .on(DescribeDBInstancesCommand)
      .resolvesOnce({ DBInstances: [liveInstance] }) // the read
      .resolves({ DBInstances: [] }); // the deletion waiter
    docdb.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    docdb.on(DeleteDBInstanceCommand).resolves({});

    const report = await executor().apply(instancePlan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(
      docdb.commandCalls(DeleteDBInstanceCommand)[0]?.args[0].input?.DBInstanceIdentifier,
    ).toBe('docs-a');
    // The waiter re-described after the delete.
    expect(docdb.commandCalls(DescribeDBInstancesCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('a deleting instance reads as absent (never updated, never resurrected)', async () => {
    docdb.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [{ ...liveInstance, DBInstanceStatus: 'deleting' }],
    });

    const planned = await executor().plan(instancePlan);
    expect(planned.items[0]?.action).toBe('create'); // absent-in-progress
    expect(docdb.commandCalls(ListTagsForResourceCommand)).toHaveLength(0); // not even tag-read
  });
});
