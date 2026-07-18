/**
 * `aws:docdb:DBCluster` + `aws:docdb:DBInstance` handlers
 * (@aws-sdk/client-docdb) — the Database kind's document store (M22.3).
 *
 * Cluster:
 *   read   → DescribeDBClusters (NotFound / status `deleting` → absent)
 *            + ListTagsForResource
 *   create → handler-owned CreateDBSubnetGroup `<clusterId>-subnets` over the
 *            default VPC's subnets (ADR-0005; the M21.3 ElastiCache live-fix
 *            pattern), then CreateDBCluster Engine docdb, StorageEncrypted.
 *            The master password is generated locally (randomBytes), passed
 *            once to AWS, and NEVER logged, stored, projected, or read back —
 *            the ssm-parameter write-only idiom.
 *   update → ModifyDBCluster (ApplyImmediately) for retention / protection
 *   delete → DeleteDBCluster SkipFinalSnapshot, bounded waiter until the
 *            cluster is gone, then DeleteDBSubnetGroup. A subnet-group-in-use
 *            error surfaces honestly — never swallowed.
 *
 * Instance: CreateDBInstance joined to the cluster named by the `clusterId`
 * attribute (fail-closed when missing). `clusterId` is immutable — drift
 * replaces (ADR-0006); `instanceClass` reconciles in place.
 */

import { randomBytes } from 'node:crypto';
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
} from '@aws-sdk/client-docdb';
import type { DocDBClient } from '@aws-sdk/client-docdb';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSubnetIds } from './network.js';

const CLUSTER_NOT_FOUND = ['DBClusterNotFoundFault', 'DBClusterNotFound'] as const;
const INSTANCE_NOT_FOUND = ['DBInstanceNotFoundFault', 'DBInstanceNotFound'] as const;
const DEFAULT_INSTANCE_CLASS = 'db.t4g.medium';
/** Cluster/instance teardown budget: 10s polls × 90 = 15 minutes (live-observed 5–15 min). */
const DELETE_WAIT_ATTEMPTS = 90;
const DELETE_WAIT_INTERVAL_MS = 10_000;

export class DocdbClusterHandler implements TargetHandler {
  static readonly targetType = 'aws:docdb:DBCluster' as const;
  readonly targetType = DocdbClusterHandler.targetType;
  /** Engine cannot change in place (ADR-0006). */
  readonly immutableProjectionKeys = ['engine'] as const;

  constructor(
    private readonly docdb: DocDBClient,
    private readonly ec2: EC2Client,
  ) {}

  /** The handler-owned DB subnet group (created with, deleted after, the cluster). */
  private subnetGroupName(resource: PlanResource): string {
    return `${resourceIdOf(resource)}-subnets`;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      engine: scalarStr(a['engine']) || 'docdb',
      backupRetentionPeriod: scalarStr(a['backupRetentionPeriod']) || '1',
      deletionProtection: scalarStr(a['deletionProtection']) === 'true' ? 'true' : 'false',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const id = resourceIdOf(resource);
    let cluster;
    try {
      const found = await this.docdb.send(
        new DescribeDBClustersCommand({ DBClusterIdentifier: id }),
      );
      cluster = found.DBClusters?.[0];
    } catch (err) {
      if (nameMatches(err, CLUSTER_NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    // A deleting cluster reads as absent — never updated, never resurrected.
    if (cluster === undefined || cluster.Status === 'deleting') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (cluster.DBClusterArn !== undefined) {
      const tagResult = await this.docdb.send(
        new ListTagsForResourceCommand({ ResourceName: cluster.DBClusterArn }),
      );
      tags = fromTagList(tagResult.TagList ?? []);
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        engine: cluster.Engine ?? 'docdb',
        backupRetentionPeriod:
          cluster.BackupRetentionPeriod === undefined ? '1' : String(cluster.BackupRetentionPeriod),
        deletionProtection: cluster.DeletionProtection === true ? 'true' : 'false',
      },
    };
    if (cluster.DBClusterArn !== undefined) state.identifier = cluster.DBClusterArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    // Handler-owned subnet group FIRST (ADR-0005 / M21.3 live-fix pattern):
    // the cluster must land in a VPC the handler controls the placement of.
    const DBSubnetGroupName = this.subnetGroupName(resource);
    const SubnetIds = await defaultSubnetIds(this.ec2);
    try {
      await this.docdb.send(
        new CreateDBSubnetGroupCommand({
          DBSubnetGroupName,
          DBSubnetGroupDescription: 'IaP-managed DocumentDB subnet group',
          SubnetIds,
          Tags: toTagList(tags),
        }),
      );
    } catch (err) {
      if (!nameMatches(err, ['DBSubnetGroupAlreadyExists'])) throw err;
    }
    // Master password: generated locally, passed once to AWS, never logged,
    // stored, projected, or read back (write-only — the ssm-parameter idiom).
    // base64url alphabet avoids the '/', '"', '@' characters DocDB rejects.
    const created = await this.docdb.send(
      new CreateDBClusterCommand({
        DBClusterIdentifier: id,
        Engine: d['engine'],
        DBSubnetGroupName,
        MasterUsername: 'iapadmin',
        MasterUserPassword: randomBytes(24).toString('base64url'),
        StorageEncrypted: true,
        BackupRetentionPeriod: Number(d['backupRetentionPeriod']),
        DeletionProtection: d['deletionProtection'] === 'true',
        Tags: toTagList(tags),
      }),
    );
    return created.DBCluster?.DBClusterArn ?? `docdb:cluster:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: { BackupRetentionPeriod?: number; DeletionProtection?: boolean } = {};
    if (d['backupRetentionPeriod'] !== live['backupRetentionPeriod'])
      changes.BackupRetentionPeriod = Number(d['backupRetentionPeriod']);
    if (d['deletionProtection'] !== live['deletionProtection'])
      changes.DeletionProtection = d['deletionProtection'] === 'true';
    if (Object.keys(changes).length === 0) return;
    await this.docdb.send(
      new ModifyDBClusterCommand({
        DBClusterIdentifier: resourceIdOf(resource),
        ApplyImmediately: true,
        ...changes,
      }),
    );
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const id = resourceIdOf(resource);
    // Deletion protection is posture, not a delete blocker — disable it first
    // (zero-orphan teardown, rds-instance idiom).
    if (current.projection['deletionProtection'] === 'true') {
      await this.docdb.send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: id,
          DeletionProtection: false,
          ApplyImmediately: true,
        }),
      );
    }
    await this.docdb.send(
      new DeleteDBClusterCommand({ DBClusterIdentifier: id, SkipFinalSnapshot: true }),
    );
    // The subnet group cannot be deleted while the cluster exists — bounded
    // waiter, then remove it. A residual in-use error surfaces honestly
    // (never swallowed): the next destroy run converges it.
    await this.waitForClusterDeleted(id);
    try {
      await this.docdb.send(
        new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: this.subnetGroupName(resource) }),
      );
    } catch (err) {
      if (!nameMatches(err, ['DBSubnetGroupNotFoundFault', 'DBSubnetGroupNotFound'])) throw err;
    }
  }

  private async waitForClusterDeleted(id: string): Promise<void> {
    for (let attempt = 0; attempt < DELETE_WAIT_ATTEMPTS; attempt += 1) {
      try {
        const found = await this.docdb.send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: id }),
        );
        if ((found.DBClusters?.length ?? 0) === 0) return;
      } catch (err) {
        if (nameMatches(err, CLUSTER_NOT_FOUND)) return;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, DELETE_WAIT_INTERVAL_MS));
    }
    throw new Error(
      `DocumentDB cluster ${id} did not finish deleting within the 15-minute waiter budget`,
    );
  }
}

export class DocdbInstanceHandler implements TargetHandler {
  static readonly targetType = 'aws:docdb:DBInstance' as const;
  readonly targetType = DocdbInstanceHandler.targetType;
  /** The owning cluster cannot change in place (ADR-0006). */
  readonly immutableProjectionKeys = ['clusterId'] as const;

  constructor(private readonly docdb: DocDBClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      clusterId: scalarStr(a['clusterId']),
      instanceClass: scalarStr(a['instanceClass']) || DEFAULT_INSTANCE_CLASS,
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const id = resourceIdOf(resource);
    let instance;
    try {
      const found = await this.docdb.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }),
      );
      instance = found.DBInstances?.[0];
    } catch (err) {
      if (nameMatches(err, INSTANCE_NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (instance === undefined || instance.DBInstanceStatus === 'deleting') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (instance.DBInstanceArn !== undefined) {
      const tagResult = await this.docdb.send(
        new ListTagsForResourceCommand({ ResourceName: instance.DBInstanceArn }),
      );
      tags = fromTagList(tagResult.TagList ?? []);
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        clusterId: instance.DBClusterIdentifier ?? '',
        instanceClass: instance.DBInstanceClass ?? '',
      },
    };
    if (instance.DBInstanceArn !== undefined) state.identifier = instance.DBInstanceArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    // Fail closed: an instance without a cluster to join is unrealizable.
    if (d['clusterId'] === '') {
      throw new Error(
        `aws:docdb:DBInstance ${id}: missing required attribute 'clusterId' ` +
          `(the DocumentDB cluster to join) — failing closed`,
      );
    }
    const created = await this.docdb.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: id,
        DBClusterIdentifier: d['clusterId'],
        DBInstanceClass: d['instanceClass'],
        Engine: 'docdb',
        Tags: toTagList(tags),
      }),
    );
    return created.DBInstance?.DBInstanceArn ?? `docdb:instance:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    if (d['instanceClass'] === current.projection['instanceClass']) return;
    await this.docdb.send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: resourceIdOf(resource),
        DBInstanceClass: d['instanceClass'],
        ApplyImmediately: true,
      }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    const id = resourceIdOf(resource);
    await this.docdb.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: id }));
    // Destroy order is instance → cluster (reversed dependsOn); the cluster
    // delete rejects while a member instance lingers — wait until it is gone.
    await this.waitForInstanceDeleted(id);
  }

  private async waitForInstanceDeleted(id: string): Promise<void> {
    for (let attempt = 0; attempt < DELETE_WAIT_ATTEMPTS; attempt += 1) {
      try {
        const found = await this.docdb.send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }),
        );
        if ((found.DBInstances?.length ?? 0) === 0) return;
      } catch (err) {
        if (nameMatches(err, INSTANCE_NOT_FOUND)) return;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, DELETE_WAIT_INTERVAL_MS));
    }
    throw new Error(
      `DocumentDB instance ${id} did not finish deleting within the 15-minute waiter budget`,
    );
  }
}
