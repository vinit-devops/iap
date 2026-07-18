/**
 * `aws:elasticache:ReplicationGroup` handler (@aws-sdk/client-elasticache) —
 * the Cache kind's store. Two engine modes on the SAME target type,
 * discriminated by the desired `engine` attribute:
 *
 * redis (default, M21.3, live-proven):
 *   read → DescribeReplicationGroups + ListTagsForResource
 *   create → CreateReplicationGroup (auth token generated locally, never
 *            logged, never read back; only set when transit encryption is on —
 *            an auth token without TLS is an AWS-rejected combination)
 *   update → ModifyReplicationGroup (automatic failover), Increase/Decrease
 *            replica count on numCacheClusters drift
 *   delete → DeleteReplicationGroup (no final snapshot)
 *
 * memcached (M22.3): NOT a replication group — the cache-cluster API family.
 *   read → DescribeCacheClusters (ShowCacheNodeInfo); NotFound or a
 *          'deleting' status → absent
 *   create → CreateCacheCluster (Engine memcached, no auth token — memcached
 *            has no transit-encryption AUTH, the redis secret logic never
 *            fires on this branch)
 *   update → ModifyCacheCluster (NumCacheNodes / CacheNodeType,
 *            ApplyImmediately)
 *   delete → DeleteCacheCluster
 *
 * Both modes share the handler-owned cache subnet group (created with,
 * deleted after, the store — M21.3 live fix, ADR-0005). When the desired
 * family comes up absent, read probes the SIBLING family under the same id so
 * a redis↔memcached engine flip surfaces as immutable drift (gated replace,
 * ADR-0006) instead of a blind duplicate create; delete dispatches on the
 * LIVE engine so the replace flow tears down the correct API family.
 *
 * Engine and both redis encryption modes are immutable — drift replaces
 * (ADR-0006). `cacheNodeMemory` is a sizing hint the mapping emits; node type
 * selection from it is a later refinement — `cacheNodeType` attribute wins,
 * default cache.t4g.micro (honest gap, noted in evidence).
 */

import { randomBytes } from 'node:crypto';
import {
  CreateCacheClusterCommand,
  CreateCacheSubnetGroupCommand,
  CreateReplicationGroupCommand,
  DecreaseReplicaCountCommand,
  DeleteCacheClusterCommand,
  DeleteCacheSubnetGroupCommand,
  DeleteReplicationGroupCommand,
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
  IncreaseReplicaCountCommand,
  ListTagsForResourceCommand,
  ModifyCacheClusterCommand,
  ModifyReplicationGroupCommand,
} from '@aws-sdk/client-elasticache';
import type { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSubnetIds } from './network.js';

const NOT_FOUND = ['ReplicationGroupNotFoundFault', 'ReplicationGroupNotFound'] as const;
const CLUSTER_NOT_FOUND = ['CacheClusterNotFoundFault', 'CacheClusterNotFound'] as const;
const DEFAULT_NODE_TYPE = 'cache.t4g.micro';

export class ElastiCacheReplicationGroupHandler implements TargetHandler {
  static readonly targetType = 'aws:elasticache:ReplicationGroup' as const;
  readonly targetType = ElastiCacheReplicationGroupHandler.targetType;
  /**
   * Engine and encryption modes cannot change in place (ADR-0006). `engine`
   * covers the redis↔memcached flip — the natural replacement story for this
   * service; the encryption keys only appear in the redis projection.
   */
  readonly immutableProjectionKeys = [
    'engine',
    'atRestEncryptionEnabled',
    'transitEncryptionEnabled',
  ] as const;

  constructor(
    private readonly client: ElastiCacheClient,
    private readonly ec2: EC2Client,
  ) {}

  /** The handler-owned cache subnet group (created with, deleted after, the store). */
  private subnetGroupName(resource: PlanResource): string {
    return `${resourceIdOf(resource)}-subnets`;
  }

  private bool(value: string): string {
    return value === 'true' ? 'true' : 'false';
  }

  /** The mode discriminator: the DESIRED engine attribute, default redis. */
  private engineOf(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['engine']) || 'redis';
  }

  private isMemcached(resource: PlanResource): boolean {
    return this.engineOf(resource) === 'memcached';
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    if (this.isMemcached(resource)) {
      // Memcached has no replication, no encryption modes, no AUTH — the
      // managed surface is the engine, node count, and node type.
      return {
        engine: 'memcached',
        nodes: scalarStr(a['nodes']) || '1',
        nodeType: scalarStr(a['cacheNodeType']) || DEFAULT_NODE_TYPE,
      };
    }
    return {
      engine: this.engineOf(resource),
      atRestEncryptionEnabled: this.bool(scalarStr(a['atRestEncryptionEnabled'])),
      transitEncryptionEnabled: this.bool(scalarStr(a['transitEncryptionEnabled'])),
      automaticFailoverEnabled: this.bool(scalarStr(a['automaticFailoverEnabled'])),
      numCacheClusters: scalarStr(a['numCacheClusters']) || '1',
      authTokenEnabled: this.bool(scalarStr(a['authTokenEnabled'])),
    };
  }

  /**
   * Dispatch on the DESIRED engine to pick the API family. When the desired
   * family is absent, probe the sibling family under the same id: a live
   * memcached cluster where redis is desired (or vice versa) must classify as
   * engine drift → gated replace, never as a duplicate create.
   */
  async read(resource: PlanResource): Promise<ResourceState> {
    const memcached = this.isMemcached(resource);
    const primary = memcached
      ? await this.readCacheCluster(resource)
      : await this.readReplicationGroup(resource);
    if (primary.exists) return primary;
    const sibling = memcached
      ? await this.readReplicationGroup(resource)
      : await this.readCacheCluster(resource);
    return sibling.exists ? sibling : primary;
  }

  private async readReplicationGroup(resource: PlanResource): Promise<ResourceState> {
    const id = resourceIdOf(resource);
    let group;
    try {
      const found = await this.client.send(
        new DescribeReplicationGroupsCommand({ ReplicationGroupId: id }),
      );
      group = found?.ReplicationGroups?.[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (group === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = await this.readTags(group.ARN);
    const failover = group.AutomaticFailover ?? 'disabled';
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        engine: group.Engine ?? 'redis',
        atRestEncryptionEnabled: group.AtRestEncryptionEnabled === true ? 'true' : 'false',
        transitEncryptionEnabled: group.TransitEncryptionEnabled === true ? 'true' : 'false',
        automaticFailoverEnabled:
          failover === 'enabled' || failover === 'enabling' ? 'true' : 'false',
        numCacheClusters: String(group.MemberClusters?.length ?? 0),
        authTokenEnabled: group.AuthTokenEnabled === true ? 'true' : 'false',
      },
    };
    if (group.ARN !== undefined) state.identifier = group.ARN;
    return state;
  }

  private async readCacheCluster(resource: PlanResource): Promise<ResourceState> {
    const id = resourceIdOf(resource);
    let cluster;
    try {
      const found = await this.client.send(
        new DescribeCacheClustersCommand({ CacheClusterId: id, ShowCacheNodeInfo: true }),
      );
      cluster = found?.CacheClusters?.[0];
    } catch (err) {
      if (nameMatches(err, CLUSTER_NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    // A cluster already draining out is absent for convergence purposes.
    if (cluster === undefined || cluster.CacheClusterStatus === 'deleting') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = await this.readTags(cluster.ARN);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        engine: cluster.Engine ?? 'memcached',
        nodes: String(cluster.NumCacheNodes ?? cluster.CacheNodes?.length ?? 0),
        nodeType: cluster.CacheNodeType ?? '',
      },
    };
    if (cluster.ARN !== undefined) state.identifier = cluster.ARN;
    return state;
  }

  /**
   * Tags for either family. During transitional windows the tag API rejects
   * reads: modify answers InvalidReplicationGroupState /
   * InvalidCacheClusterState, and the CREATE window answers *NotFound for a
   * store the describe JUST returned (M22.3 live finding: a memcached
   * cluster in 'creating' describes fine, but ListTagsForResource throws
   * CacheClusterNotFoundFault "is either not present or not available").
   * readTags is only reached after the describe proved existence, so a
   * NotFound here is a state window, not absence. A read must stay
   * read-only-usable: tags unknown → treated unmanaged → destroy still
   * fails closed.
   */
  private async readTags(arn: string | undefined): Promise<Record<string, string>> {
    if (arn === undefined) return {};
    try {
      const tagResult = await this.client.send(
        new ListTagsForResourceCommand({ ResourceName: arn }),
      );
      return fromTagList(tagResult.TagList ?? []);
    } catch (err) {
      const tolerated = [
        'InvalidReplicationGroupState',
        'InvalidCacheClusterState',
        ...NOT_FOUND,
        ...CLUSTER_NOT_FOUND,
      ];
      if (!nameMatches(err, tolerated)) {
        throw err;
      }
      return {};
    }
  }

  /**
   * Handler-owned cache subnet group over the default VPC subnets, shared by
   * both engine modes (ADR-0005; live finding in the M21.3 run: "Redis Auth
   * can only be enabled within an Amazon VPC"). Returns its name.
   */
  private async ensureSubnetGroup(
    resource: PlanResource,
    tags: Record<string, string>,
  ): Promise<string> {
    const CacheSubnetGroupName = this.subnetGroupName(resource);
    const SubnetIds = await defaultSubnetIds(this.ec2);
    try {
      await this.client.send(
        new CreateCacheSubnetGroupCommand({
          CacheSubnetGroupName,
          CacheSubnetGroupDescription: 'IaP-managed cache subnet group',
          SubnetIds,
          Tags: toTagList(tags),
        }),
      );
    } catch (err) {
      if (!nameMatches(err, ['CacheSubnetGroupAlreadyExists'])) throw err;
    }
    return CacheSubnetGroupName;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const CacheSubnetGroupName = await this.ensureSubnetGroup(resource, tags);

    if (this.isMemcached(resource)) {
      // No AUTH token, no encryption params — memcached supports neither;
      // the redis auth-secret logic must never fire on this branch.
      const created = await this.client.send(
        new CreateCacheClusterCommand({
          CacheClusterId: id,
          Engine: 'memcached',
          CacheNodeType: d['nodeType'],
          NumCacheNodes: Number(d['nodes']),
          CacheSubnetGroupName,
          Tags: toTagList(tags),
        }),
      );
      return created.CacheCluster?.ARN ?? `elasticache:cc:${id}`;
    }

    const nodeType = scalarStr(resource.desiredAttributes['cacheNodeType']) || DEFAULT_NODE_TYPE;
    // Auth token: generated locally, passed once to AWS, never stored or
    // logged. AWS only accepts it with TLS on.
    const withAuthToken = d['authTokenEnabled'] === 'true' && d['transitEncryptionEnabled'] === 'true';
    const created = await this.client.send(
      new CreateReplicationGroupCommand({
        CacheSubnetGroupName,
        ReplicationGroupId: id,
        ReplicationGroupDescription: 'IaP-managed cache',
        Engine: d['engine'],
        CacheNodeType: nodeType,
        NumCacheClusters: Number(d['numCacheClusters']),
        AutomaticFailoverEnabled: d['automaticFailoverEnabled'] === 'true',
        AtRestEncryptionEnabled: d['atRestEncryptionEnabled'] === 'true',
        TransitEncryptionEnabled: d['transitEncryptionEnabled'] === 'true',
        ...(withAuthToken ? { AuthToken: randomBytes(24).toString('base64url') } : {}),
        Tags: toTagList(tags),
      }),
    );
    return created.ReplicationGroup?.ARN ?? `elasticache:rg:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    if (this.isMemcached(resource)) {
      return this.updateCacheCluster(resource, current);
    }
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;
    // Replica count FIRST: AWS refuses to enable automatic failover until at
    // least one read replica exists (M21.3 live finding — ordering matters).
    const desiredCount = Number(d['numCacheClusters']);
    const liveCount = Number(live['numCacheClusters'] || '0');
    if (desiredCount > liveCount) {
      await this.client.send(
        new IncreaseReplicaCountCommand({
          ReplicationGroupId: id,
          NewReplicaCount: desiredCount - 1,
          ApplyImmediately: true,
        }),
      );
    } else if (desiredCount < liveCount) {
      await this.client.send(
        new DecreaseReplicaCountCommand({
          ReplicationGroupId: id,
          NewReplicaCount: Math.max(0, desiredCount - 1),
          ApplyImmediately: true,
        }),
      );
    }
    // Replica creation is async — a failover modify in the same pass would
    // race it. When replicas changed this pass, failover reconciles on the
    // NEXT apply (honest eventual convergence, one more idempotent run).
    const replicasChanged = desiredCount !== liveCount;
    if (!replicasChanged && d['automaticFailoverEnabled'] !== live['automaticFailoverEnabled']) {
      await this.client.send(
        new ModifyReplicationGroupCommand({
          ReplicationGroupId: id,
          AutomaticFailoverEnabled: d['automaticFailoverEnabled'] === 'true',
          ApplyImmediately: true,
        }),
      );
    }
  }

  /** Memcached reconcile: one ModifyCacheCluster with only the drifted fields. */
  private async updateCacheCluster(resource: PlanResource, current: ResourceState): Promise<void> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const modify: {
      NumCacheNodes?: number;
      CacheNodeIdsToRemove?: string[];
      CacheNodeType?: string;
    } = {};
    const desiredNodes = Number(d['nodes']);
    const liveNodes = Number(live['nodes'] || '0');
    if (desiredNodes !== liveNodes) {
      modify.NumCacheNodes = desiredNodes;
      if (desiredNodes < liveNodes) {
        // Scale-in must name the nodes to drop — remove the highest-numbered.
        modify.CacheNodeIdsToRemove = await this.cacheNodeIdsToRemove(id, liveNodes - desiredNodes);
      }
    }
    const desiredNodeType = d['nodeType'] ?? DEFAULT_NODE_TYPE;
    if (desiredNodeType !== live['nodeType']) {
      modify.CacheNodeType = desiredNodeType; // mutable but slow — a rolling node swap
    }
    if (Object.keys(modify).length === 0) return;
    await this.client.send(
      new ModifyCacheClusterCommand({ CacheClusterId: id, ...modify, ApplyImmediately: true }),
    );
  }

  private async cacheNodeIdsToRemove(id: string, removeCount: number): Promise<string[]> {
    const found = await this.client.send(
      new DescribeCacheClustersCommand({ CacheClusterId: id, ShowCacheNodeInfo: true }),
    );
    const ids = (found?.CacheClusters?.[0]?.CacheNodes ?? [])
      .map((node) => node.CacheNodeId)
      .filter((nodeId): nodeId is string => nodeId !== undefined)
      .sort();
    return ids.slice(-removeCount);
  }

  /**
   * Dispatch on the LIVE engine (falling back to desired): in the replace
   * flow the resource being torn down may belong to the OTHER API family
   * than the one now desired (the redis↔memcached flip).
   */
  async delete(resource: PlanResource, current?: ResourceState): Promise<void> {
    const id = resourceIdOf(resource);
    const liveEngine = current?.projection['engine'] || this.engineOf(resource);
    if (liveEngine === 'memcached') {
      await this.client.send(new DeleteCacheClusterCommand({ CacheClusterId: id }));
      await this.waitForClusterDeleted(id);
    } else {
      await this.client.send(
        new DeleteReplicationGroupCommand({
          ReplicationGroupId: id,
          RetainPrimaryCluster: false,
        }),
      );
      await this.waitForGroupDeleted(id);
    }
    // The subnet group cannot be deleted while the store exists — hence the
    // bounded waiters above (10s interval, ≤60 attempts = 10 min budget).
    try {
      await this.client.send(
        new DeleteCacheSubnetGroupCommand({ CacheSubnetGroupName: this.subnetGroupName(resource) }),
      );
    } catch (err) {
      if (!nameMatches(err, ['CacheSubnetGroupNotFoundFault', 'CacheSubnetGroupNotFound'])) throw err;
    }
  }

  private async waitForGroupDeleted(id: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const found = await this.client.send(
          new DescribeReplicationGroupsCommand({ ReplicationGroupId: id }),
        );
        if ((found?.ReplicationGroups?.length ?? 0) === 0) return;
      } catch (err) {
        if (nameMatches(err, NOT_FOUND)) return;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error(
      `replication group ${id} did not finish deleting within the 10-minute waiter budget`,
    );
  }

  private async waitForClusterDeleted(id: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const found = await this.client.send(
          new DescribeCacheClustersCommand({ CacheClusterId: id }),
        );
        if ((found?.CacheClusters?.length ?? 0) === 0) return;
      } catch (err) {
        if (nameMatches(err, CLUSTER_NOT_FOUND)) return;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error(
      `cache cluster ${id} did not finish deleting within the 10-minute waiter budget`,
    );
  }
}
