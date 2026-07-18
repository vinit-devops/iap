/**
 * M22.3 — Aurora handlers (@aws-sdk/client-rds): `aws:rds:DBCluster` and
 * `aws:rds:DBClusterInstance`, the Database kind's serverless relational
 * engine. Aurora Serverless v2 at the cheapest posture: MinCapacity defaults
 * to 0 ACU (scales to zero when idle), MaxCapacity to 1 ACU, and the writer
 * instance class defaults to `db.serverless`.
 *
 * CLUSTER
 *   read   → DescribeDBClusters + ListTagsForResource (status `deleting`
 *            reads absent — on its way out, never updated or resurrected)
 *   create → CreateDBCluster with ManageMasterUserPassword (RDS-managed
 *            master secret — no password material ever passes through IaP),
 *            ServerlessV2ScalingConfiguration, StorageEncrypted always on
 *   update → single ModifyDBCluster (ApplyImmediately) + AddTagsToResource
 *   delete → ModifyDBCluster(DeletionProtection=false) when live-protected
 *            (fail-closed: if the disable throws, the delete never runs),
 *            then DeleteDBCluster (SkipFinalSnapshot — zero-orphan teardown)
 *
 * INSTANCE
 *   read   → DescribeDBInstances (TagList inline; `deleting` reads absent)
 *   create → CreateDBInstance into the cluster named by the REQUIRED
 *            `clusterId` attribute (fail-closed when missing — an unattached
 *            cluster instance is meaningless)
 *   update → ModifyDBInstance (ApplyImmediately) on instanceClass drift
 *   delete → DeleteDBInstance (SkipFinalSnapshot)
 *
 * Engine is immutable on the cluster; the owning cluster is immutable on the
 * instance — drift on either replaces (ADR-0006). The subnet placement is a
 * SIBLING `aws:rds:DBSubnetGroup` resource wired in via the `subnetGroupName`
 * attribute + `dependsOn` (unlike ElastiCache, the handler does not own it),
 * so it is create-only wiring, never projected. `engineVersion` is
 * desired-gated: AWS picks a default minor version, and an unpinned plan must
 * not read that default as drift (M22.1 SQS SSE lesson).
 */

import {
  AddTagsToResourceCommand,
  CreateDBClusterCommand,
  CreateDBInstanceCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  ListTagsForResourceCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
} from '@aws-sdk/client-rds';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const CLUSTER_NOT_FOUND = ['DBClusterNotFoundFault', 'DBClusterNotFound'] as const;
const INSTANCE_NOT_FOUND = ['DBInstanceNotFoundFault', 'DBInstanceNotFound'] as const;

/** Cheapest Serverless v2 posture: scale-to-zero floor, 1 ACU ceiling. */
const DEFAULT_MIN_CAPACITY = '0';
const DEFAULT_MAX_CAPACITY = '1';
const DEFAULT_BACKUP_RETENTION = '1';
/** Serverless v2 writer/reader instance class. */
const DEFAULT_INSTANCE_CLASS = 'db.serverless';

/**
 * Map the IaP-level `engine` attribute to the Aurora engine name. Unknown
 * values pass through verbatim (a plan may already say `aurora-postgresql`);
 * absent defaults to aurora-postgresql.
 */
const ENGINE_MAP: Record<string, string> = {
  postgresql: 'aurora-postgresql',
  postgres: 'aurora-postgresql',
  mysql: 'aurora-mysql',
};

function auroraEngine(value: string): string {
  if (value === '') return 'aurora-postgresql';
  return ENGINE_MAP[value] ?? value;
}

export class RdsClusterHandler implements TargetHandler {
  static readonly targetType = 'aws:rds:DBCluster' as const;
  readonly targetType = RdsClusterHandler.targetType;
  /** Engine cannot change in place (ADR-0006). */
  readonly immutableProjectionKeys = ['engine'] as const;

  constructor(private readonly rds: RDSClient, private readonly ec2: EC2Client) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      engine: auroraEngine(scalarStr(a['engine'])),
      // engineVersion compares only when the plan pins one — AWS chooses a
      // default minor version and unpinned plans must not read it as drift.
      engineVersion: scalarStr(a['engineVersion']),
      minCapacity: scalarStr(a['minCapacity']) || DEFAULT_MIN_CAPACITY,
      maxCapacity: scalarStr(a['maxCapacity']) || DEFAULT_MAX_CAPACITY,
      backupRetentionPeriod: scalarStr(a['backupRetentionPeriod']) || DEFAULT_BACKUP_RETENTION,
      deletionProtection: scalarStr(a['deletionProtection']) === 'true' ? 'true' : 'false',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const id = resourceIdOf(resource);
    let cluster;
    try {
      const found = await this.rds.send(
        new DescribeDBClustersCommand({ DBClusterIdentifier: id }),
      );
      cluster = found.DBClusters?.[0];
    } catch (err) {
      if (nameMatches(err, CLUSTER_NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (cluster === undefined || cluster.Status === 'deleting') {
      // Deletion in progress — treat as absent; never touch a dying cluster.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (cluster.DBClusterArn !== undefined) {
      const tagResult = await this.rds.send(
        new ListTagsForResourceCommand({ ResourceName: cluster.DBClusterArn }),
      );
      tags = fromTagList(tagResult.TagList ?? []);
    }

    const scaling = cluster.ServerlessV2ScalingConfiguration;
    const desiredVersion = scalarStr(resource.desiredAttributes['engineVersion']);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        engine: cluster.Engine ?? '',
        engineVersion: desiredVersion === '' ? '' : (cluster.EngineVersion ?? ''),
        minCapacity: scaling?.MinCapacity === undefined ? '' : String(scaling.MinCapacity),
        maxCapacity: scaling?.MaxCapacity === undefined ? '' : String(scaling.MaxCapacity),
        backupRetentionPeriod:
          cluster.BackupRetentionPeriod === undefined
            ? DEFAULT_BACKUP_RETENTION
            : String(cluster.BackupRetentionPeriod),
        deletionProtection: cluster.DeletionProtection === true ? 'true' : 'false',
      },
    };
    if (cluster.DBClusterArn !== undefined) state.identifier = cluster.DBClusterArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    // Subnet placement is a sibling aws:rds:DBSubnetGroup resource; live plans
    // wire the dependency via dependsOn so the group exists before this runs.
    const subnetGroup = scalarStr(resource.desiredAttributes['subnetGroupName']);
    const created = await this.rds.send(
      new CreateDBClusterCommand({
        DBClusterIdentifier: id,
        Engine: d['engine'],
        ...(d['engineVersion'] ? { EngineVersion: d['engineVersion'] } : {}),
        // Serverless v2, cheapest posture: min 0 ACU scales to zero when idle.
        ServerlessV2ScalingConfiguration: {
          MinCapacity: Number(d['minCapacity']),
          MaxCapacity: Number(d['maxCapacity']),
        },
        // RDS-managed master credentials (Secrets Manager secret owned and
        // rotated by AWS): no password material ever touches IaP code or logs.
        MasterUsername: 'iapadmin',
        ManageMasterUserPassword: true,
        ...(subnetGroup ? { DBSubnetGroupName: subnetGroup } : {}),
        StorageEncrypted: true,
        DeletionProtection: d['deletionProtection'] === 'true',
        BackupRetentionPeriod: Number(d['backupRetentionPeriod']),
        Tags: toTagList(tags),
      }),
    );
    // No available-waiter here — repo idiom: creates do not wait in-handler;
    // the live-run driver verifies convergence (serverless v2 ~1-3 min).
    return created.DBCluster?.DBClusterArn ?? `rds:cluster:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: Record<string, unknown> = {};
    if (d['minCapacity'] !== live['minCapacity'] || d['maxCapacity'] !== live['maxCapacity']) {
      changes['ServerlessV2ScalingConfiguration'] = {
        MinCapacity: Number(d['minCapacity']),
        MaxCapacity: Number(d['maxCapacity']),
      };
    }
    if (d['backupRetentionPeriod'] !== live['backupRetentionPeriod']) {
      changes['BackupRetentionPeriod'] = Number(d['backupRetentionPeriod']);
    }
    if (d['deletionProtection'] !== live['deletionProtection']) {
      changes['DeletionProtection'] = d['deletionProtection'] === 'true';
    }
    if (d['engineVersion'] !== '' && d['engineVersion'] !== live['engineVersion']) {
      changes['EngineVersion'] = d['engineVersion'];
    }
    if (Object.keys(changes).length > 0) {
      await this.rds.send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: resourceIdOf(resource),
          ApplyImmediately: true,
          ...changes,
        }),
      );
    }
    // Re-assert ownership tags on the live cluster (repo idiom).
    if (current.identifier !== undefined) {
      await this.rds.send(
        new AddTagsToResourceCommand({
          ResourceName: current.identifier,
          Tags: toTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const id = resourceIdOf(resource);
    // Deletion protection is part of the desired posture — disable it first.
    // Fail-closed: if the disable throws, the DeleteDBCluster never runs.
    if (current.projection['deletionProtection'] === 'true') {
      await this.rds.send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: id,
          DeletionProtection: false,
          ApplyImmediately: true,
        }),
      );
    }
    await this.rds.send(
      new DeleteDBClusterCommand({ DBClusterIdentifier: id, SkipFinalSnapshot: true }),
    );
  }
}

export class RdsClusterInstanceHandler implements TargetHandler {
  static readonly targetType = 'aws:rds:DBClusterInstance' as const;
  readonly targetType = RdsClusterInstanceHandler.targetType;
  /** An instance cannot move between clusters in place (ADR-0006). */
  readonly immutableProjectionKeys = ['clusterId'] as const;

  constructor(private readonly rds: RDSClient) {}

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
      const found = await this.rds.send(
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
      // Deletion in progress — treat as absent; never touch a dying instance.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromTagList(instance.TagList ?? []);
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
    // The owning cluster is REQUIRED — an unattached "cluster instance" is
    // meaningless. Fail closed before issuing any call.
    if (d['clusterId'] === '') {
      throw new Error(
        `aws:rds:DBClusterInstance ${id}: required attribute 'clusterId' is missing — ` +
          `refusing to create an instance without its owning cluster (fail closed)`,
      );
    }
    const engine = auroraEngine(scalarStr(resource.desiredAttributes['engine']));
    const created = await this.rds.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: id,
        DBClusterIdentifier: d['clusterId'],
        DBInstanceClass: d['instanceClass'],
        Engine: engine,
        Tags: toTagList(tags),
      }),
    );
    // No available-waiter — repo idiom (db.serverless instance ~3-10 min; the
    // live-run driver verifies convergence).
    return created.DBInstance?.DBInstanceArn ?? `rds:db:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    if (d['instanceClass'] === current.projection['instanceClass']) return;
    await this.rds.send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: resourceIdOf(resource),
        DBInstanceClass: d['instanceClass'],
        ApplyImmediately: true,
      }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.rds.send(
      new DeleteDBInstanceCommand({
        DBInstanceIdentifier: resourceIdOf(resource),
        SkipFinalSnapshot: true,
      }),
    );
  }
}
