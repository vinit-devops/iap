/**
 * M22.3 MemoryDB handler, mock-tested: `aws:memorydb:Cluster`.
 *
 * Covers: handler-owned subnet group created BEFORE the cluster (default-VPC
 * subnets), secure defaults (TLS on, open-access ACL, db.t4g.small, 1 shard,
 * 0 replicas), converged no-op with an UNPINNED engine version never reading
 * as drift, mutable drift (aclName/nodeType/replicas) → UpdateCluster in
 * place, tlsEnabled drift → replace classification behind the replacement
 * gate (refusal closed, delete-then-create open), 'deleting' status reading
 * as absent, and managed-only destroy with subnet-group cleanup.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateClusterCommand,
  CreateSubnetGroupCommand,
  DeleteClusterCommand,
  DeleteSubnetGroupCommand,
  DescribeClustersCommand,
  ListTagsCommand,
  MemoryDBClient,
  TagResourceCommand,
  UpdateClusterCommand,
} from '@aws-sdk/client-memorydb';
import {
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const memorydb = mockClient(MemoryDBClient);
const ec2 = mockClient(EC2Client);

const MANAGED = [{ Key: 'iap:managed', Value: 'true' }];
const CLUSTER_ARN = 'arn:aws:memorydb:eu-central-1:000000000000:cluster/jarvis-cache';
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
}

beforeEach(() => {
  memorydb.reset();
  ec2.reset();
});

const plan = providerPlan([planResource('jarvis-cache', 'aws:memorydb:Cluster')]);

/** Converged against the all-defaults plan; live engine version UNPINNED by it. */
const liveCluster = {
  Name: 'jarvis-cache',
  ARN: CLUSTER_ARN,
  Status: 'available',
  NodeType: 'db.t4g.small',
  NumberOfShards: 1,
  Shards: [{ Name: '0001', NumberOfNodes: 1 }],
  TLSEnabled: true,
  ACLName: 'open-access',
  EngineVersion: '7.1',
};

describe('aws:memorydb:Cluster', () => {
  it('absent → CreateSubnetGroup (default-VPC subnets) THEN CreateCluster with secure defaults', async () => {
    memorydb.on(DescribeClustersCommand).rejects(serviceError('ClusterNotFoundFault', 404));
    memorydb.on(CreateSubnetGroupCommand).resolves({});
    memorydb.on(CreateClusterCommand).resolves({ Cluster: { ARN: CLUSTER_ARN } });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(CLUSTER_ARN);

    // The handler-owned subnet group is created BEFORE the cluster.
    const order = memorydb.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('CreateSubnetGroupCommand')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('CreateSubnetGroupCommand')).toBeLessThan(
      order.indexOf('CreateClusterCommand'),
    );

    const subnetInput = memorydb.commandCalls(CreateSubnetGroupCommand)[0]?.args[0].input;
    expect(subnetInput?.SubnetGroupName).toBe('jarvis-cache-subnets');
    expect(subnetInput?.SubnetIds).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);

    const input = memorydb.commandCalls(CreateClusterCommand)[0]?.args[0].input;
    expect(input?.ClusterName).toBe('jarvis-cache');
    expect(input?.NodeType).toBe('db.t4g.small');
    expect(input?.NumShards).toBe(1);
    expect(input?.NumReplicasPerShard).toBe(0);
    expect(input?.TLSEnabled).toBe(true);
    expect(input?.ACLName).toBe('open-access');
    expect(input?.EngineVersion).toBeUndefined(); // unpinned — the service picks
    expect(input?.SubnetGroupName).toBe('jarvis-cache-subnets');
    expect(input?.Tags).toEqual(
      expect.arrayContaining([{ Key: 'iap:managed', Value: 'true' }]),
    );
  });

  it('present + converged → no-op; the unpinned engine version NEVER reads as drift', async () => {
    memorydb.on(DescribeClustersCommand).resolves({ Clusters: [liveCluster] });
    memorydb.on(ListTagsCommand).resolves({ TagList: MANAGED });

    const report = await executor().plan(plan);

    // Live runs 7.1 and the plan pins nothing — still converged.
    expect(report.items[0]?.action).toBe('no-op');
  });

  it("a cluster in 'deleting' status reads as absent → create classification", async () => {
    memorydb.on(DescribeClustersCommand).resolves({
      Clusters: [{ ...liveCluster, Status: 'deleting' }],
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create');
  });

  it('aclName + nodeType drift → UpdateCluster in place (never delete+create)', async () => {
    const drifted = providerPlan([
      planResource('jarvis-cache', 'aws:memorydb:Cluster', {
        aclName: 'jarvis-acl',
        nodeType: 'db.r6g.large',
      }),
    ]);
    memorydb.on(DescribeClustersCommand).resolves({ Clusters: [liveCluster] });
    memorydb.on(ListTagsCommand).resolves({ TagList: MANAGED });
    memorydb.on(UpdateClusterCommand).resolves({});
    memorydb.on(TagResourceCommand).resolves({});

    const report = await executor().apply(drifted, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = memorydb.commandCalls(UpdateClusterCommand)[0]?.args[0].input;
    expect(input?.ClusterName).toBe('jarvis-cache');
    expect(input?.ACLName).toBe('jarvis-acl');
    expect(input?.NodeType).toBe('db.r6g.large'); // slow vertical scale live, still in place
    expect(memorydb.commandCalls(DeleteClusterCommand)).toHaveLength(0);
    expect(memorydb.commandCalls(CreateClusterCommand)).toHaveLength(0);
  });

  it('replicas drift → UpdateCluster ReplicaConfiguration', async () => {
    const scaled = providerPlan([
      planResource('jarvis-cache', 'aws:memorydb:Cluster', { replicas: 1 }),
    ]);
    memorydb.on(DescribeClustersCommand).resolves({ Clusters: [liveCluster] });
    memorydb.on(ListTagsCommand).resolves({ TagList: MANAGED });
    memorydb.on(UpdateClusterCommand).resolves({});
    memorydb.on(TagResourceCommand).resolves({});

    const report = await executor().apply(scaled, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    const input = memorydb.commandCalls(UpdateClusterCommand)[0]?.args[0].input;
    expect(input?.ReplicaConfiguration).toEqual({ ReplicaCount: 1 });
  });

  it('tlsEnabled drift is IMMUTABLE → replace classification; gate closed refuses', async () => {
    const noTls = providerPlan([
      planResource('jarvis-cache', 'aws:memorydb:Cluster', { tlsEnabled: false }),
    ]);
    memorydb.on(DescribeClustersCommand).resolves({ Clusters: [liveCluster] });
    memorydb.on(ListTagsCommand).resolves({ TagList: MANAGED });

    const planned = await executor().plan(noTls);
    expect(planned.items[0]?.action).toBe('replace');

    // apply: true WITHOUT replace: true → recorded refusal, zero mutations.
    const report = await executor().apply(noTls, { apply: true });
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('refusing to replace');
    expect(memorydb.commandCalls(DeleteClusterCommand)).toHaveLength(0);
    expect(memorydb.commandCalls(CreateClusterCommand)).toHaveLength(0);
  });

  it('replacement gate open → delete (cluster gone, subnet group cleaned) THEN create', async () => {
    const noTls = providerPlan([
      planResource('jarvis-cache', 'aws:memorydb:Cluster', { tlsEnabled: false }),
    ]);
    memorydb
      .on(DescribeClustersCommand)
      .resolvesOnce({ Clusters: [liveCluster] }) // the read
      .resolves({ Clusters: [] }); // the deletion waiter
    memorydb.on(ListTagsCommand).resolves({ TagList: MANAGED });
    memorydb.on(DeleteClusterCommand).resolves({});
    memorydb.on(DeleteSubnetGroupCommand).resolves({});
    memorydb.on(CreateSubnetGroupCommand).resolves({});
    memorydb.on(CreateClusterCommand).resolves({ Cluster: { ARN: CLUSTER_ARN } });
    mockDefaultNetwork();

    const report = await executor().apply(noTls, { apply: true, replace: true });

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);
    const order = memorydb.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('DeleteClusterCommand')).toBeLessThan(
      order.indexOf('CreateClusterCommand'),
    );
    expect(memorydb.commandCalls(CreateClusterCommand)[0]?.args[0].input?.TLSEnabled).toBe(false);
  });

  it('destroy refuses an unmanaged cluster (managed-only gate)', async () => {
    memorydb.on(DescribeClustersCommand).resolves({ Clusters: [liveCluster] });
    memorydb.on(ListTagsCommand).resolves({ TagList: [] });

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(memorydb.commandCalls(DeleteClusterCommand)).toHaveLength(0);
  });

  it('destroy → DeleteCluster, wait for gone, then DeleteSubnetGroup', async () => {
    memorydb
      .on(DescribeClustersCommand)
      .resolvesOnce({ Clusters: [liveCluster] }) // the read
      .resolves({ Clusters: [] }); // the deletion waiter
    memorydb.on(ListTagsCommand).resolves({ TagList: MANAGED });
    memorydb.on(DeleteClusterCommand).resolves({});
    memorydb.on(DeleteSubnetGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(memorydb.commandCalls(DeleteClusterCommand)[0]?.args[0].input?.ClusterName).toBe(
      'jarvis-cache',
    );
    expect(
      memorydb.commandCalls(DeleteSubnetGroupCommand)[0]?.args[0].input?.SubnetGroupName,
    ).toBe('jarvis-cache-subnets');
  });
});
