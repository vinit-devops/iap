/**
 * `aws:timestream:Database` + `aws:timestream:Table` handlers
 * (@aws-sdk/client-timestream-write) — time-series Database class (M22.2).
 *
 * Database:
 *   read → DescribeDatabase + ListTagsForResource
 *   create → CreateDatabase (optional customer `kmsKeyId`; Timestream otherwise
 *            encrypts with an AWS-managed key — an unpinned plan must NOT read
 *            that default as drift, so the key is desired-gated exactly like
 *            the SQS managed-SSE default, M22.1 live finding)
 *   update → TagResource; UpdateDatabase only for a pinned kmsKeyId change
 *   delete → DeleteDatabase
 *
 * Table: lives INSIDE a database — `databaseName` arrives as a desired
 * attribute (cross-resource reference to the sibling Database's resourceId)
 * and is IMMUTABLE: a table cannot move databases, so drift on it classifies
 * as replace (gated delete+create, ADR-0006). Retention is mutable and
 * reconciles in place via UpdateTable.
 *   read → DescribeTable + ListTagsForResource (a missing parent database
 *          surfaces as the same ResourceNotFoundException → absent)
 *   create → CreateTable with RetentionProperties (memory hours / magnetic days)
 *   update → UpdateTable (retention) + TagResource
 *   delete → DeleteTable
 */

import {
  CreateDatabaseCommand,
  CreateTableCommand,
  DeleteDatabaseCommand,
  DeleteTableCommand,
  DescribeDatabaseCommand,
  DescribeTableCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UpdateDatabaseCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-timestream-write';
import type { RetentionProperties, TimestreamWriteClient } from '@aws-sdk/client-timestream-write';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;

/** Memory-store retention when the plan does not pin it (hours). */
const DEFAULT_MEMORY_RETENTION_HOURS = '24';
/** Magnetic-store retention when the plan does not pin it (days). */
const DEFAULT_MAGNETIC_RETENTION_DAYS = '7';

export class TimestreamDatabaseHandler implements TargetHandler {
  static readonly targetType = 'aws:timestream:Database' as const;
  readonly targetType = TimestreamDatabaseHandler.targetType;

  constructor(private readonly client: TimestreamWriteClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    // Desired-gated: an unpinned plan compares '' on both sides, so the
    // AWS-managed default key never reads as drift (M22.1 SQS lesson).
    return { kmsKeyId: scalarStr(resource.desiredAttributes['kmsKeyId']) };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const DatabaseName = resourceIdOf(resource);
    let database;
    try {
      const found = await this.client.send(new DescribeDatabaseCommand({ DatabaseName }));
      database = found.Database;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (database?.Arn !== undefined) {
      const tagResult = await this.client.send(
        new ListTagsForResourceCommand({ ResourceARN: database.Arn }),
      );
      tags = fromTagList(tagResult.Tags ?? []);
    }

    // The live key mirrors into the projection only when the plan pins one;
    // otherwise '' so the Timestream-managed default is not drift.
    const pinned = resource.desiredAttributes['kmsKeyId'] !== undefined;
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: { kmsKeyId: pinned ? (database?.KmsKeyId ?? '') : '' },
    };
    if (database?.Arn !== undefined) state.identifier = database.Arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const DatabaseName = resourceIdOf(resource);
    const KmsKeyId = scalarStr(resource.desiredAttributes['kmsKeyId']);
    const created = await this.client.send(
      new CreateDatabaseCommand({
        DatabaseName,
        // Omitted entirely when unpinned — Timestream falls back to its
        // AWS-managed key in the account.
        ...(KmsKeyId ? { KmsKeyId } : {}),
        Tags: toTagList(tags),
      }),
    );
    return created.Database?.Arn ?? `timestream:database/${DatabaseName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const DatabaseName = resourceIdOf(resource);
    const desiredKey = scalarStr(resource.desiredAttributes['kmsKeyId']);
    // UpdateDatabase rotates the database key — issued only for a pinned,
    // actually-drifted kmsKeyId (never to "reconcile" the managed default).
    if (desiredKey !== '' && desiredKey !== (current.projection['kmsKeyId'] ?? '')) {
      await this.client.send(new UpdateDatabaseCommand({ DatabaseName, KmsKeyId: desiredKey }));
    }
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagResourceCommand({ ResourceARN: current.identifier, Tags: toTagList(current.tags) }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(new DeleteDatabaseCommand({ DatabaseName: resourceIdOf(resource) }));
  }
}

export class TimestreamTableHandler implements TargetHandler {
  static readonly targetType = 'aws:timestream:Table' as const;
  readonly targetType = TimestreamTableHandler.targetType;
  /** A table cannot move databases — databaseName drift replaces (ADR-0006). */
  readonly immutableProjectionKeys = ['databaseName'] as const;

  constructor(private readonly client: TimestreamWriteClient) {}

  /** The parent database is a cross-resource reference — fail closed without it. */
  private databaseName(resource: PlanResource): string {
    const name = scalarStr(resource.desiredAttributes['databaseName']);
    if (name === '') {
      throw new Error(
        `aws:timestream:Table ${resource.logicalId} needs a databaseName attribute ` +
          `(the parent aws:timestream:Database resourceId)`,
      );
    }
    return name;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    return {
      databaseName: this.databaseName(resource),
      memoryRetentionHours:
        scalarStr(resource.desiredAttributes['memoryRetentionHours']) ||
        DEFAULT_MEMORY_RETENTION_HOURS,
      magneticRetentionDays:
        scalarStr(resource.desiredAttributes['magneticRetentionDays']) ||
        DEFAULT_MAGNETIC_RETENTION_DAYS,
    };
  }

  /** Desired retention in the AWS shape (defaults applied). */
  private retention(resource: PlanResource): RetentionProperties {
    const desired = this.desiredProjection(resource);
    return {
      MemoryStoreRetentionPeriodInHours: Number(desired['memoryRetentionHours']),
      MagneticStoreRetentionPeriodInDays: Number(desired['magneticRetentionDays']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const TableName = resourceIdOf(resource);
    const DatabaseName = this.databaseName(resource);
    let table;
    try {
      const found = await this.client.send(new DescribeTableCommand({ DatabaseName, TableName }));
      table = found.Table;
    } catch (err) {
      // Covers both a missing table and a missing PARENT database — either
      // way the table is absent and converges via create (once the sibling
      // Database handler has created the parent).
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (table?.Arn !== undefined) {
      const tagResult = await this.client.send(
        new ListTagsForResourceCommand({ ResourceARN: table.Arn }),
      );
      tags = fromTagList(tagResult.Tags ?? []);
    }

    const retention = table?.RetentionProperties;
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        databaseName: table?.DatabaseName ?? DatabaseName,
        memoryRetentionHours:
          retention?.MemoryStoreRetentionPeriodInHours === undefined
            ? ''
            : String(retention.MemoryStoreRetentionPeriodInHours),
        magneticRetentionDays:
          retention?.MagneticStoreRetentionPeriodInDays === undefined
            ? ''
            : String(retention.MagneticStoreRetentionPeriodInDays),
      },
    };
    if (table?.Arn !== undefined) state.identifier = table.Arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const TableName = resourceIdOf(resource);
    const DatabaseName = this.databaseName(resource);
    const created = await this.client.send(
      new CreateTableCommand({
        DatabaseName,
        TableName,
        RetentionProperties: this.retention(resource),
        Tags: toTagList(tags),
      }),
    );
    return created.Table?.Arn ?? `timestream:table/${DatabaseName}/${TableName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    await this.client.send(
      new UpdateTableCommand({
        DatabaseName: this.databaseName(resource),
        TableName: resourceIdOf(resource),
        RetentionProperties: this.retention(resource),
      }),
    );
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagResourceCommand({ ResourceARN: current.identifier, Tags: toTagList(current.tags) }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    // On replace, the live table sits in the OLD database (the immutable key
    // that drifted) — delete where it actually lives, not where it should be.
    const DatabaseName = current.projection['databaseName'] || this.databaseName(resource);
    await this.client.send(
      new DeleteTableCommand({ DatabaseName, TableName: resourceIdOf(resource) }),
    );
  }
}
