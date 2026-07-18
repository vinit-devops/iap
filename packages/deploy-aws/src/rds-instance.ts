/**
 * `aws:rds:DBInstance` handler (@aws-sdk/client-rds) — the Database kind's
 * relational instance (M21.3).
 *
 * read → DescribeDBInstances (TagList inline)
 * create → CreateDBInstance with ManageMasterUserPassword (RDS-managed master
 *          secret — no password material ever passes through IaP)
 * update → ModifyDBInstance (ApplyImmediately)
 * delete → ModifyDBInstance(DeletionProtection=false) then DeleteDBInstance
 *          (SkipFinalSnapshot + DeleteAutomatedBackups — zero-orphan teardown)
 *
 * Engine and storage encryption are immutable — drift on either replaces the
 * instance (ADR-0006). `requireSecureTransport` is a parameter-group setting
 * and out of scope until parameter groups land (honest gap, noted in evidence).
 */

import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  ModifyDBInstanceCommand,
} from '@aws-sdk/client-rds';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['DBInstanceNotFoundFault', 'DBInstanceNotFound'] as const;
const DEFAULTS = { instanceClass: 'db.t4g.micro', allocatedStorage: '20' } as const;

export class RdsInstanceHandler implements TargetHandler {
  static readonly targetType = 'aws:rds:DBInstance' as const;
  readonly targetType = RdsInstanceHandler.targetType;
  /** Engine and at-rest encryption cannot change in place (ADR-0006). */
  readonly immutableProjectionKeys = ['engine', 'storageEncrypted'] as const;

  constructor(private readonly client: RDSClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      engine: scalarStr(a['engine']),
      // engineVersion compares only when the plan pins one (minor upgrades
      // must not read as drift when unpinned) — absent-equals-empty rule.
      engineVersion: scalarStr(a['engineVersion']),
      instanceClass: scalarStr(a['instanceClass']) || DEFAULTS.instanceClass,
      multiAZ: scalarStr(a['multiAZ']) === 'true' ? 'true' : 'false',
      storageEncrypted: scalarStr(a['storageEncrypted']) === 'true' ? 'true' : 'false',
      allocatedStorage: scalarStr(a['allocatedStorage']) || DEFAULTS.allocatedStorage,
      publiclyAccessible: scalarStr(a['publiclyAccessible']) === 'true' ? 'true' : 'false',
      backupRetentionPeriod: scalarStr(a['backupRetentionPeriod']) || '0',
      deletionProtection: scalarStr(a['deletionProtection']) === 'true' ? 'true' : 'false',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const id = resourceIdOf(resource);
    let instance;
    try {
      const found = await this.client.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }),
      );
      instance = found.DBInstances?.[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (instance === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromTagList(instance.TagList ?? []);
    const desiredVersion = scalarStr(resource.desiredAttributes['engineVersion']);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        engine: instance.Engine ?? '',
        engineVersion: desiredVersion === '' ? '' : (instance.EngineVersion ?? ''),
        instanceClass: instance.DBInstanceClass ?? '',
        multiAZ: instance.MultiAZ === true ? 'true' : 'false',
        storageEncrypted: instance.StorageEncrypted === true ? 'true' : 'false',
        allocatedStorage:
          instance.AllocatedStorage === undefined ? '' : String(instance.AllocatedStorage),
        publiclyAccessible: instance.PubliclyAccessible === true ? 'true' : 'false',
        backupRetentionPeriod:
          instance.BackupRetentionPeriod === undefined
            ? '0'
            : String(instance.BackupRetentionPeriod),
        deletionProtection: instance.DeletionProtection === true ? 'true' : 'false',
      },
    };
    if (instance.DBInstanceArn !== undefined) state.identifier = instance.DBInstanceArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const subnetGroup = scalarStr(resource.desiredAttributes['dbSubnetGroupName']);
    const created = await this.client.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: id,
        Engine: d['engine'],
        ...(d['engineVersion'] ? { EngineVersion: d['engineVersion'] } : {}),
        DBInstanceClass: d['instanceClass'],
        AllocatedStorage: Number(d['allocatedStorage']),
        MultiAZ: d['multiAZ'] === 'true',
        StorageEncrypted: d['storageEncrypted'] === 'true',
        PubliclyAccessible: d['publiclyAccessible'] === 'true',
        BackupRetentionPeriod: Number(d['backupRetentionPeriod']),
        DeletionProtection: d['deletionProtection'] === 'true',
        // RDS-managed master credentials: no password material touches IaP.
        MasterUsername: 'iapadmin',
        ManageMasterUserPassword: true,
        ...(subnetGroup ? { DBSubnetGroupName: subnetGroup } : {}),
        Tags: toTagList(tags),
      }),
    );
    return created.DBInstance?.DBInstanceArn ?? `rds:db:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: Record<string, unknown> = {};
    if (d['instanceClass'] !== live['instanceClass']) changes['DBInstanceClass'] = d['instanceClass'];
    if (d['multiAZ'] !== live['multiAZ']) changes['MultiAZ'] = d['multiAZ'] === 'true';
    if (d['allocatedStorage'] !== live['allocatedStorage'])
      changes['AllocatedStorage'] = Number(d['allocatedStorage']);
    if (d['backupRetentionPeriod'] !== live['backupRetentionPeriod'])
      changes['BackupRetentionPeriod'] = Number(d['backupRetentionPeriod']);
    if (d['deletionProtection'] !== live['deletionProtection'])
      changes['DeletionProtection'] = d['deletionProtection'] === 'true';
    if (d['engineVersion'] !== '' && d['engineVersion'] !== live['engineVersion'])
      changes['EngineVersion'] = d['engineVersion'];
    if (Object.keys(changes).length === 0) return;
    await this.client.send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: resourceIdOf(resource),
        ApplyImmediately: true,
        ...changes,
      }),
    );
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const id = resourceIdOf(resource);
    // Deletion protection is part of the desired posture — disable it first,
    // then delete without a final snapshot (zero-orphan teardown).
    if (current.projection['deletionProtection'] === 'true') {
      await this.client.send(
        new ModifyDBInstanceCommand({
          DBInstanceIdentifier: id,
          DeletionProtection: false,
          ApplyImmediately: true,
        }),
      );
    }
    await this.client.send(
      new DeleteDBInstanceCommand({
        DBInstanceIdentifier: id,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      }),
    );
  }
}
