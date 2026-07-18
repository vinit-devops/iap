/**
 * `aws:memorydb:Cluster` handler (@aws-sdk/client-memorydb) — the Cache
 * kind's durable, multi-AZ redis-compatible engine (M22.3).
 *
 * read   → DescribeClusters (ShowShardDetails for the replica count) +
 *          ListTags on the cluster ARN; a cluster in 'deleting' status reads
 *          as absent (converging toward gone — recreate, don't reconcile)
 * create → handler-owned CreateSubnetGroup ('<name>-subnets' over the
 *          default-VPC subnets, ADR-0005) THEN CreateCluster (single shard)
 * update → UpdateCluster for drifted mutables + TagResource
 * delete → DeleteCluster, bounded wait for gone, then DeleteSubnetGroup
 *
 * TLS cannot change in place — drift on `tlsEnabled` replaces (ADR-0006,
 * gated delete+create). `aclName` and `replicas` reconcile via UpdateCluster;
 * `nodeType` also reconciles in place but is a SLOW vertical scale live —
 * MemoryDB resizes shard by shard, so the call returns fast while convergence
 * takes tens of minutes (eventual-convergence honesty, M21.3 precedent).
 * EngineVersion is desired-gated: projected and compared only when the plan
 * pins one, so service-side minor upgrades never read as drift.
 */

import {
  CreateClusterCommand,
  CreateSubnetGroupCommand,
  DeleteClusterCommand,
  DeleteSubnetGroupCommand,
  DescribeClustersCommand,
  ListTagsCommand,
  TagResourceCommand,
  UpdateClusterCommand,
} from '@aws-sdk/client-memorydb';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { MemoryDBClient, UpdateClusterRequest } from '@aws-sdk/client-memorydb';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSubnetIds } from './network.js';

const NOT_FOUND = ['ClusterNotFoundFault', 'ClusterNotFound'] as const;
const DEFAULT_NODE_TYPE = 'db.t4g.small';
const DEFAULT_ACL = 'open-access';

export class MemoryDbClusterHandler implements TargetHandler {
  static readonly targetType = 'aws:memorydb:Cluster' as const;
  readonly targetType = MemoryDbClusterHandler.targetType;
  /** In-transit TLS cannot change in place (ADR-0006). */
  readonly immutableProjectionKeys = ['tlsEnabled'] as const;

  constructor(private readonly memorydb: MemoryDBClient, private readonly ec2: EC2Client) {}

  /** The handler-owned subnet group (created with, deleted after, the cluster). */
  private subnetGroupName(resource: PlanResource): string {
    return `${resourceIdOf(resource)}-subnets`;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      nodeType: scalarStr(a['nodeType']) || DEFAULT_NODE_TYPE,
      replicas: scalarStr(a['replicas']) || '0',
      // Secure default: TLS on unless the plan explicitly opts out.
      tlsEnabled: scalarStr(a['tlsEnabled']) === 'false' ? 'false' : 'true',
      aclName: scalarStr(a['aclName']) || DEFAULT_ACL,
      // Desired-gated: '' when unpinned so minor upgrades never read as drift.
      engineVersion: scalarStr(a['engineVersion']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const id = resourceIdOf(resource);
    let cluster;
    try {
      const found = await this.memorydb.send(
        new DescribeClustersCommand({ ClusterName: id, ShowShardDetails: true }),
      );
      cluster = found.Clusters?.[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    // A cluster mid-teardown is on its way to absent; treating it as present
    // would produce update calls the service rejects.
    if (cluster === undefined || cluster.Status === 'deleting') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (cluster.ARN !== undefined) {
      try {
        const tagResult = await this.memorydb.send(
          new ListTagsCommand({ ResourceArn: cluster.ARN }),
        );
        tags = fromTagList(tagResult.TagList ?? []);
      } catch (err) {
        // During modify windows the tag API rejects reads — tags unknown →
        // treated unmanaged → destroy still fails closed (M21.3 pattern).
        if (!nameMatches(err, ['InvalidClusterStateFault'])) throw err;
      }
    }

    const desiredVersion = scalarStr(resource.desiredAttributes['engineVersion']);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        nodeType: cluster.NodeType ?? '',
        // Single-shard posture: replicas = nodes in shard 0 minus the primary.
        replicas: String(Math.max(0, (cluster.Shards?.[0]?.NumberOfNodes ?? 1) - 1)),
        tlsEnabled: cluster.TLSEnabled === true ? 'true' : 'false',
        aclName: cluster.ACLName ?? '',
        engineVersion: desiredVersion === '' ? '' : (cluster.EngineVersion ?? ''),
      },
    };
    if (cluster.ARN !== undefined) state.identifier = cluster.ARN;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    // MemoryDB clusters are VPC-resident — the handler owns a subnet group
    // over the default-VPC subnets (ADR-0005), created BEFORE the cluster.
    const SubnetGroupName = this.subnetGroupName(resource);
    const SubnetIds = await defaultSubnetIds(this.ec2);
    try {
      await this.memorydb.send(
        new CreateSubnetGroupCommand({
          SubnetGroupName,
          Description: 'IaP-managed memorydb subnet group',
          SubnetIds,
          Tags: toTagList(tags),
        }),
      );
    } catch (err) {
      if (!nameMatches(err, ['SubnetGroupAlreadyExists'])) throw err;
    }
    const created = await this.memorydb.send(
      new CreateClusterCommand({
        ClusterName: id,
        NodeType: d['nodeType'],
        NumShards: 1,
        NumReplicasPerShard: Number(d['replicas']),
        TLSEnabled: d['tlsEnabled'] === 'true',
        ACLName: d['aclName'],
        // EngineVersion only when the plan pins one — otherwise the service
        // picks (and later patches) the current default, never read as drift.
        ...(d['engineVersion'] ? { EngineVersion: d['engineVersion'] } : {}),
        SubnetGroupName,
        Tags: toTagList(tags),
      }),
    );
    return created.Cluster?.ARN ?? `memorydb:cluster:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: Omit<UpdateClusterRequest, 'ClusterName'> = {};
    // NodeType reconciles in place but is a slow vertical scale live: the
    // call returns immediately, the resize converges over tens of minutes.
    if (d['nodeType'] !== live['nodeType']) changes.NodeType = d['nodeType'];
    if (d['aclName'] !== live['aclName']) changes.ACLName = d['aclName'];
    if (d['replicas'] !== live['replicas']) {
      changes.ReplicaConfiguration = { ReplicaCount: Number(d['replicas']) };
    }
    if (d['engineVersion'] !== '' && d['engineVersion'] !== live['engineVersion']) {
      changes.EngineVersion = d['engineVersion'];
    }
    if (Object.keys(changes).length > 0) {
      await this.memorydb.send(new UpdateClusterCommand({ ClusterName: id, ...changes }));
    }
    if (current.identifier !== undefined) {
      await this.memorydb.send(
        new TagResourceCommand({
          ResourceArn: current.identifier,
          Tags: toTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    const id = resourceIdOf(resource);
    await this.memorydb.send(new DeleteClusterCommand({ ClusterName: id }));
    // The subnet group cannot be deleted while the cluster still holds it —
    // bounded waiter (10s interval, ≤90 attempts = 15 min budget; live
    // deletion runs ~5-10 min). If the group is still in use after the
    // budget, the error surfaces honestly instead of a fake clean teardown.
    await this.waitForClusterDeleted(id);
    try {
      await this.memorydb.send(
        new DeleteSubnetGroupCommand({ SubnetGroupName: this.subnetGroupName(resource) }),
      );
    } catch (err) {
      // Only "already gone" is benign; SubnetGroupInUseFault must surface.
      if (!nameMatches(err, ['SubnetGroupNotFound'])) throw err;
    }
  }

  private async waitForClusterDeleted(id: string): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const found = await this.memorydb.send(new DescribeClustersCommand({ ClusterName: id }));
        if ((found.Clusters?.length ?? 0) === 0) return;
      } catch (err) {
        if (nameMatches(err, NOT_FOUND)) return;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error(
      `memorydb cluster ${id} did not finish deleting within the 15-minute waiter budget`,
    );
  }
}
