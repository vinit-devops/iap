/**
 * M22.3 — Memcached engine mode on the existing `aws:elasticache:ReplicationGroup`
 * target type, mock-tested (aws-sdk-client-mock).
 *
 * The desired `engine` attribute discriminates: 'memcached' drives the
 * cache-cluster API family (Create/Describe/Modify/DeleteCacheCluster);
 * 'redis' (default) keeps the live-proven M21.3 replication-group paths.
 * The redis↔memcached flip is immutable drift → gated replace (ADR-0006).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateCacheClusterCommand,
  CreateCacheSubnetGroupCommand,
  CreateReplicationGroupCommand,
  DeleteCacheClusterCommand,
  DeleteCacheSubnetGroupCommand,
  DeleteReplicationGroupCommand,
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
  ElastiCacheClient,
  ListTagsForResourceCommand,
  ModifyCacheClusterCommand,
} from '@aws-sdk/client-elasticache';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

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
  ec.reset();
  ec2.reset();
});

const memcachedPlan = (attrs: Record<string, string | number | boolean> = {}) =>
  providerPlan([
    planResource('fragment-cache', 'aws:elasticache:ReplicationGroup', {
      engine: 'memcached',
      nodes: 1,
      ...attrs,
    }),
  ]);

const liveMemcached = {
  CacheClusterId: 'fragment-cache',
  ARN: 'arn:ec/cc/fragment-cache',
  Engine: 'memcached',
  CacheClusterStatus: 'available',
  CacheNodeType: 'cache.t4g.micro',
  NumCacheNodes: 1,
};

describe('aws:elasticache:ReplicationGroup — memcached mode (M22.3)', () => {
  it('absent → subnet group FIRST, then CreateCacheCluster (memcached, t4g.micro, tags; no auth, no replication-group writes)', async () => {
    ec.on(DescribeCacheClustersCommand).rejects(serviceError('CacheClusterNotFoundFault'));
    ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));
    ec.on(CreateCacheSubnetGroupCommand).resolves({});
    ec.on(CreateCacheClusterCommand).resolves({
      CacheCluster: { ARN: 'arn:ec/cc/fragment-cache' },
    });
    mockDefaultNetwork();

    const report = await executor().apply(memcachedPlan(), { apply: true });

    expect(report.errors).toHaveLength(0);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:ec/cc/fragment-cache');

    const subnetInput = ec.commandCalls(CreateCacheSubnetGroupCommand)[0]?.args[0].input;
    expect(subnetInput?.CacheSubnetGroupName).toBe('fragment-cache-subnets');
    expect(subnetInput?.SubnetIds).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);

    const input = ec.commandCalls(CreateCacheClusterCommand)[0]?.args[0].input;
    expect(input?.Engine).toBe('memcached');
    expect(input?.CacheNodeType).toBe('cache.t4g.micro'); // default when no cacheNodeType attr
    expect(input?.NumCacheNodes).toBe(1);
    expect(input?.CacheSubnetGroupName).toBe('fragment-cache-subnets');
    expect(input?.Tags).toContainEqual({ Key: 'iap:managed', Value: 'true' });
    // Memcached has no transit-encryption AUTH — the redis secret logic must not fire.
    expect((input as Record<string, unknown> | undefined)?.['AuthToken']).toBeUndefined();
    // And nothing on the replication-group side is created or modified.
    expect(ec.commandCalls(CreateReplicationGroupCommand)).toHaveLength(0);
    // Ordering: the handler-owned subnet group exists before the cluster references it.
    const mutationOrder = ec
      .calls()
      .map((call) => call.args[0].constructor.name)
      .filter((name) => name === 'CreateCacheSubnetGroupCommand' || name === 'CreateCacheClusterCommand');
    expect(mutationOrder).toEqual(['CreateCacheSubnetGroupCommand', 'CreateCacheClusterCommand']);
  });

  it('present + converged → no-op', async () => {
    ec.on(DescribeCacheClustersCommand).resolves({ CacheClusters: [liveMemcached] });
    ec.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });

    const report = await executor().plan(memcachedPlan());
    expect(report.items[0]?.action).toBe('no-op');
  });

  it("a cluster in 'deleting' status reads as absent → create", async () => {
    ec.on(DescribeCacheClustersCommand).resolves({
      CacheClusters: [{ ...liveMemcached, CacheClusterStatus: 'deleting' }],
    });
    ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));

    const report = await executor().plan(memcachedPlan());
    expect(report.items[0]?.action).toBe('create');
  });

  it("creating-window tag read: ListTagsForResource answers NotFound for a cluster Describe just returned → read survives (tags unknown → unmanaged, destroy fails closed) — live M22.3 finding", async () => {
    ec.on(DescribeCacheClustersCommand).resolves({
      CacheClusters: [{ ...liveMemcached, CacheClusterStatus: 'creating' }],
    });
    ec.on(ListTagsForResourceCommand).rejects(serviceError('CacheClusterNotFoundFault'));

    // The read must not throw: the cluster exists (describe proved it) but
    // the tag API cannot see it yet — tags unknown, projection intact.
    const report = await executor().plan(memcachedPlan());
    expect(report.items[0]?.action).toBe('no-op');

    // And in that same window a destroy still fails closed (unmanaged).
    const destroyReport = await executor().apply(memcachedPlan(), { apply: true, destroy: true });
    expect(destroyReport.items[0]?.applied).toBe(false);
    expect(destroyReport.items[0]?.error).toContain('managed-only destroy');
    expect(ec.commandCalls(DeleteCacheClusterCommand)).toHaveLength(0);
  });

  it('nodes 1→2 drift → in-place ModifyCacheCluster (NumCacheNodes, ApplyImmediately)', async () => {
    ec.on(DescribeCacheClustersCommand).resolves({ CacheClusters: [liveMemcached] });
    ec.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    ec.on(ModifyCacheClusterCommand).resolves({});

    const report = await executor().apply(memcachedPlan({ nodes: 2 }), { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = ec.commandCalls(ModifyCacheClusterCommand)[0]?.args[0].input;
    expect(input?.CacheClusterId).toBe('fragment-cache');
    expect(input?.NumCacheNodes).toBe(2);
    expect(input?.ApplyImmediately).toBe(true);
    expect(input?.CacheNodeType).toBeUndefined(); // only the drifted field
  });

  describe('engine flip memcached→redis on a live memcached cluster (immutable drift)', () => {
    // The document now desires redis; the live resource under the same id is
    // a memcached cache cluster. The sibling-family probe surfaces it.
    const redisDesired = providerPlan([
      planResource('fragment-cache', 'aws:elasticache:ReplicationGroup', {
        engine: 'redis',
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: false,
        automaticFailoverEnabled: false,
        numCacheClusters: 1,
        authTokenEnabled: false,
      }),
    ]);

    it('classifies as replace, never update', async () => {
      ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));
      ec.on(DescribeCacheClustersCommand).resolves({ CacheClusters: [liveMemcached] });
      ec.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });

      const report = await executor().plan(redisDesired);
      expect(report.items[0]?.action).toBe('replace');
      expect(report.items[0]?.reason).toContain('delete+create');
    });

    it('replacement gate closed → refusal, zero mutating calls', async () => {
      ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));
      ec.on(DescribeCacheClustersCommand).resolves({ CacheClusters: [liveMemcached] });
      ec.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });

      const report = await executor().apply(redisDesired, { apply: true });

      expect(report.items[0]?.action).toBe('replace');
      expect(report.items[0]?.applied).toBe(false);
      expect(report.items[0]?.error).toContain('refusing to replace');
      expect(ec.commandCalls(DeleteCacheClusterCommand)).toHaveLength(0);
      expect(ec.commandCalls(CreateReplicationGroupCommand)).toHaveLength(0);
    });

    it('gate open → DeleteCacheCluster THEN CreateReplicationGroup (cross-family replace)', async () => {
      ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));
      ec
        .on(DescribeCacheClustersCommand)
        .resolvesOnce({ CacheClusters: [liveMemcached] }) // the read (sibling probe)
        .rejects(serviceError('CacheClusterNotFoundFault')); // the deletion waiter
      ec.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
      ec.on(DeleteCacheClusterCommand).resolves({});
      ec.on(DeleteCacheSubnetGroupCommand).resolves({});
      ec.on(CreateCacheSubnetGroupCommand).resolves({});
      ec.on(CreateReplicationGroupCommand).resolves({
        ReplicationGroup: { ARN: 'arn:ec/rg/fragment-cache' },
      });
      mockDefaultNetwork();

      const report = await executor().apply(redisDesired, { apply: true, replace: true });

      expect(report.errors).toHaveLength(0);
      expect(report.items[0]?.applied).toBe(true);
      expect(report.items[0]?.identifier).toBe('arn:ec/rg/fragment-cache');
      expect(ec.commandCalls(DeleteCacheClusterCommand)[0]?.args[0].input?.CacheClusterId).toBe('fragment-cache');
      expect(ec.commandCalls(DeleteReplicationGroupCommand)).toHaveLength(0); // live side was memcached
      expect(ec.commandCalls(CreateReplicationGroupCommand)[0]?.args[0].input?.Engine).toBe('redis');
      expect(ec.commandCalls(CreateCacheClusterCommand)).toHaveLength(0); // new side is redis
      const order = ec
        .calls()
        .map((call) => call.args[0].constructor.name)
        .filter((name) => name === 'DeleteCacheClusterCommand' || name === 'CreateReplicationGroupCommand');
      expect(order).toEqual(['DeleteCacheClusterCommand', 'CreateReplicationGroupCommand']);
    });
  });

  it('destroy → DeleteCacheCluster, wait for gone, then delete the handler-owned subnet group', async () => {
    ec
      .on(DescribeCacheClustersCommand)
      .resolvesOnce({ CacheClusters: [liveMemcached] }) // the read
      .rejects(serviceError('CacheClusterNotFoundFault')); // the deletion waiter
    ec.on(ListTagsForResourceCommand).resolves({ TagList: MANAGED });
    ec.on(DeleteCacheClusterCommand).resolves({});
    ec.on(DeleteCacheSubnetGroupCommand).resolves({});

    const report = await executor().apply(memcachedPlan(), { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(ec.commandCalls(DeleteCacheClusterCommand)[0]?.args[0].input?.CacheClusterId).toBe('fragment-cache');
    expect(ec.commandCalls(DeleteCacheSubnetGroupCommand)[0]?.args[0].input?.CacheSubnetGroupName).toBe('fragment-cache-subnets');
    expect(ec.commandCalls(DeleteReplicationGroupCommand)).toHaveLength(0);
  });

  it('destroy refuses an UNMANAGED memcached cluster (fails closed, no delete calls)', async () => {
    ec.on(DescribeCacheClustersCommand).resolves({ CacheClusters: [liveMemcached] });
    ec.on(ListTagsForResourceCommand).resolves({ TagList: [] }); // no iap:managed tag

    const report = await executor().apply(memcachedPlan(), { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(ec.commandCalls(DeleteCacheClusterCommand)).toHaveLength(0);
    expect(ec.commandCalls(DeleteCacheSubnetGroupCommand)).toHaveLength(0);
  });

  it('redis regression canary: a redis-shaped resource still routes to the replication-group APIs', async () => {
    const redisPlan = providerPlan([
      planResource('session-cache', 'aws:elasticache:ReplicationGroup', {
        engine: 'redis',
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        automaticFailoverEnabled: false,
        numCacheClusters: 1,
        authTokenEnabled: true,
      }),
    ]);
    ec.on(DescribeReplicationGroupsCommand).rejects(serviceError('ReplicationGroupNotFoundFault'));
    ec.on(DescribeCacheClustersCommand).rejects(serviceError('CacheClusterNotFoundFault'));
    ec.on(CreateCacheSubnetGroupCommand).resolves({});
    ec.on(CreateReplicationGroupCommand).resolves({
      ReplicationGroup: { ARN: 'arn:ec/rg/session-cache' },
    });
    mockDefaultNetwork();

    const report = await executor().apply(redisPlan, { apply: true });

    expect(report.errors).toHaveLength(0);
    expect(report.items[0]?.applied).toBe(true);
    const input = ec.commandCalls(CreateReplicationGroupCommand)[0]?.args[0].input;
    expect(input?.Engine).toBe('redis');
    expect(typeof input?.AuthToken).toBe('string'); // TLS on → generated auth token, redis-only
    expect(ec.commandCalls(CreateCacheClusterCommand)).toHaveLength(0); // never the memcached family
  });
});
