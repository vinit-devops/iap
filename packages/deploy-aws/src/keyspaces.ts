/**
 * `aws:cassandra:Keyspace` + `aws:cassandra:Table` handlers
 * (@aws-sdk/client-keyspaces) — Amazon Keyspaces, the wide-column Database
 * class (M23.2). This mirrors the Timestream parent/child sibling pattern: a
 * Table lives INSIDE a Keyspace exactly as a Timestream Table lives inside a
 * Database, referenced across resources by a `keyspaceName` desired attribute.
 *
 * Keyspace — the name IS the identity and nothing else is configurable in
 * scope, so the projection is EMPTY beyond identity (like backup.ts
 * BackupVault). A present keyspace always reads converged; replacement is N/A.
 *   read   → GetKeyspace (ResourceNotFoundException → absent) + ListTagsForResource
 *   create → CreateKeyspace (tags inline)
 *   update → tags only (empty projection can never classify as update/replace,
 *            so this only ever reconciles caller tags on a manual invocation)
 *   delete → DeleteKeyspace
 * Note: CreateKeyspace / DeleteKeyspace are ASYNC in Keyspaces
 * (CREATING→ACTIVE, DELETING). Repo idiom is NO ACTIVE waiter on create — the
 * driver verifies readiness, exactly as the Timestream handlers do.
 *
 * Table — lives inside a keyspace: `keyspaceName` arrives as a desired
 * attribute (cross-resource reference to the sibling Keyspace's resourceId)
 * and is IMMUTABLE — a table cannot move keyspaces, so drift on it classifies
 * as replace (gated delete+create, ADR-0006). The primary-key SCHEMA
 * (partition + clustering columns) is likewise immutable → replace. Capacity
 * mode, TTL, and point-in-time recovery are mutable and reconcile in place via
 * UpdateTable.
 *   read   → GetTable + ListTagsForResource (a missing table OR a missing
 *            PARENT keyspace both surface as ResourceNotFoundException → absent)
 *   create → CreateTable (schemaDefinition parsed from the compact `schema`
 *            attr; capacitySpecification PAY_PER_REQUEST by default; tags)
 *   update → UpdateTable (capacity mode / ttl / pitr) + TagResource
 *   delete → DeleteTable
 *
 * SCHEMA SERIALIZATION — the `schema` desired attribute is a compact,
 * comma-separated list of column specs. Each spec is colon-delimited:
 *
 *     <name>:<type>[:<role>[:<order>]]
 *
 *   role  — `pk` partition key · `ck` clustering key · omitted/`r` regular
 *   order — `asc` | `desc` (clustering keys only; default `asc`)
 *
 * Every listed column becomes part of `allColumns` (so the key columns are
 * always included, as CreateTable requires). At least one partition key is
 * mandatory — a schema without one fails closed.
 *
 *   Example: `id:uuid:pk,event_time:timestamp:ck:desc,payload:text`
 *     partitionKeys = [id]
 *     clusteringKeys = [event_time DESC]
 *     allColumns = [id uuid, event_time timestamp, payload text]
 */

import {
  CreateKeyspaceCommand,
  CreateTableCommand,
  DeleteKeyspaceCommand,
  DeleteTableCommand,
  GetKeyspaceCommand,
  GetTableCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-keyspaces';
import type {
  CapacitySpecification,
  ClusteringKey,
  ColumnDefinition,
  KeyspacesClient,
  PartitionKey,
  PointInTimeRecovery,
  SchemaDefinition,
  Tag,
  TimeToLive,
} from '@aws-sdk/client-keyspaces';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

/** A missing keyspace OR a missing table both surface as this. */
const NOT_FOUND = ['ResourceNotFoundException'] as const;

const PAY_PER_REQUEST = 'PAY_PER_REQUEST';
const PROVISIONED = 'PROVISIONED';

/** Keyspaces tags are lowercase `{ key, value }` (unlike the S3/IAM shape). */
function toKeyspacesTags(tags: Record<string, string>): Tag[] {
  return Object.keys(tags)
    .sort()
    .map((key) => ({ key, value: tags[key] ?? '' }));
}

function fromKeyspacesTags(list: ReadonlyArray<Tag> = []): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const entry of list) {
    if (entry.key !== undefined) tags[entry.key] = entry.value ?? '';
  }
  return tags;
}

export class KeyspacesKeyspaceHandler implements TargetHandler {
  static readonly targetType = 'aws:cassandra:Keyspace' as const;
  readonly targetType = KeyspacesKeyspaceHandler.targetType;

  constructor(private readonly keyspaces: KeyspacesClient) {}

  /**
   * Empty beyond identity: the keyspace name is the only managed attribute and
   * it IS the resource id, so drift can never classify as update/replace
   * (replacement is N/A — like backup.ts BackupVault).
   */
  desiredProjection(_resource: PlanResource): Record<string, string> {
    return {};
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const keyspaceName = resourceIdOf(resource);
    let arn: string | undefined;
    try {
      const found = await this.keyspaces.send(new GetKeyspaceCommand({ keyspaceName }));
      arn = found.resourceArn;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.keyspaces.send(
        new ListTagsForResourceCommand({ resourceArn: arn }),
      );
      tags = fromKeyspacesTags(tagResult.tags);
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {},
    };
    if (arn !== undefined) state.identifier = arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const keyspaceName = resourceIdOf(resource);
    // CreateKeyspace is async (CREATING→ACTIVE); repo idiom is no ACTIVE waiter
    // — the driver verifies readiness.
    const created = await this.keyspaces.send(
      new CreateKeyspaceCommand({ keyspaceName, tags: toKeyspacesTags(tags) }),
    );
    return created.resourceArn ?? `keyspaces:keyspace/${keyspaceName}`;
  }

  /** Projection is identity-only, so this only ever reconciles tags. */
  async update(_resource: PlanResource, current: ResourceState): Promise<void> {
    if (current.identifier !== undefined) {
      await this.keyspaces.send(
        new TagResourceCommand({
          resourceArn: current.identifier,
          tags: toKeyspacesTags(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    // DeleteKeyspace is async (DELETING); no waiter, mirroring create.
    await this.keyspaces.send(
      new DeleteKeyspaceCommand({ keyspaceName: resourceIdOf(resource) }),
    );
  }
}

interface ParsedSchema {
  partitionKeys: PartitionKey[];
  clusteringKeys: ClusteringKey[];
  allColumns: ColumnDefinition[];
}

export class KeyspacesTableHandler implements TargetHandler {
  static readonly targetType = 'aws:cassandra:Table' as const;
  readonly targetType = KeyspacesTableHandler.targetType;
  /**
   * A table cannot move keyspaces (keyspaceName), and its primary-key schema
   * (partition + clustering columns) cannot change in place — drift on any of
   * these replaces (gated delete+create, ADR-0006). Capacity/ttl/pitr are
   * mutable and reconcile via UpdateTable.
   */
  readonly immutableProjectionKeys = [
    'keyspaceName',
    'partitionKeys',
    'clusteringKeys',
    'allColumns',
  ] as const;

  constructor(private readonly keyspaces: KeyspacesClient) {}

  /** The parent keyspace is a cross-resource reference — fail closed without it. */
  private keyspaceName(resource: PlanResource): string {
    const name = scalarStr(resource.desiredAttributes['keyspaceName']);
    if (name === '') {
      throw new Error(
        `aws:cassandra:Table ${resource.logicalId} needs a keyspaceName attribute ` +
          `(the parent aws:cassandra:Keyspace resourceId)`,
      );
    }
    return name;
  }

  /** Parse the compact `schema` attribute into the AWS SchemaDefinition parts. */
  private parseSchema(resource: PlanResource): ParsedSchema {
    const raw = scalarStr(resource.desiredAttributes['schema']);
    if (raw === '') {
      throw new Error(
        `aws:cassandra:Table ${resource.logicalId} needs a schema attribute ` +
          `(e.g. 'id:uuid:pk,event_time:timestamp:ck:desc,payload:text')`,
      );
    }
    const partitionKeys: PartitionKey[] = [];
    const clusteringKeys: ClusteringKey[] = [];
    const allColumns: ColumnDefinition[] = [];
    for (const spec of raw.split(',')) {
      const trimmed = spec.trim();
      if (trimmed === '') continue;
      const [name, type, role, order] = trimmed.split(':').map((p) => p.trim());
      if (!name || !type) {
        throw new Error(
          `aws:cassandra:Table ${resource.logicalId} has a malformed schema column: '${spec}'`,
        );
      }
      allColumns.push({ name, type });
      const kind = (role ?? 'r').toLowerCase();
      if (kind === 'pk') {
        partitionKeys.push({ name });
      } else if (kind === 'ck') {
        clusteringKeys.push({ name, orderBy: (order ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC' });
      }
    }
    if (partitionKeys.length === 0) {
      throw new Error(
        `aws:cassandra:Table ${resource.logicalId} schema needs at least one partition key ` +
          `(mark a column with role 'pk')`,
      );
    }
    return { partitionKeys, clusteringKeys, allColumns };
  }

  private schemaDefinition(resource: PlanResource): SchemaDefinition {
    const parsed = this.parseSchema(resource);
    return {
      allColumns: parsed.allColumns,
      partitionKeys: parsed.partitionKeys,
      ...(parsed.clusteringKeys.length > 0 ? { clusteringKeys: parsed.clusteringKeys } : {}),
    };
  }

  /** Deterministic key/column signatures for drift comparison. */
  private schemaProjection(resource: PlanResource): {
    partitionKeys: string;
    clusteringKeys: string;
    allColumns: string;
  } {
    const parsed = this.parseSchema(resource);
    return {
      partitionKeys: parsed.partitionKeys.map((k) => k.name).join(','),
      clusteringKeys: parsed.clusteringKeys.map((k) => `${k.name}:${k.orderBy}`).join(','),
      allColumns: [...parsed.allColumns]
        .map((c) => `${c.name}:${c.type}`)
        .sort()
        .join(','),
    };
  }

  private capacityMode(resource: PlanResource): string {
    const mode = scalarStr(resource.desiredAttributes['capacityMode']) || PAY_PER_REQUEST;
    return mode === PROVISIONED ? PROVISIONED : PAY_PER_REQUEST;
  }

  private capacitySpecification(resource: PlanResource): CapacitySpecification {
    if (this.capacityMode(resource) === PROVISIONED) {
      return {
        throughputMode: PROVISIONED,
        readCapacityUnits: Number(scalarStr(resource.desiredAttributes['readCapacityUnits']) || '1'),
        writeCapacityUnits: Number(
          scalarStr(resource.desiredAttributes['writeCapacityUnits']) || '1',
        ),
      };
    }
    return { throughputMode: PAY_PER_REQUEST };
  }

  /** Desired PITR status; default DISABLED (matches the AWS create default). */
  private pitrStatus(resource: PlanResource): 'ENABLED' | 'DISABLED' {
    return scalarStr(resource.desiredAttributes['pointInTimeRecovery']).toUpperCase() === 'ENABLED'
      ? 'ENABLED'
      : 'DISABLED';
  }

  /** Desired TTL status; default disabled (represented as ''). TTL cannot be disabled once on. */
  private ttlEnabled(resource: PlanResource): boolean {
    return scalarStr(resource.desiredAttributes['ttl']).toUpperCase() === 'ENABLED';
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const schema = this.schemaProjection(resource);
    return {
      keyspaceName: this.keyspaceName(resource),
      partitionKeys: schema.partitionKeys,
      clusteringKeys: schema.clusteringKeys,
      allColumns: schema.allColumns,
      capacityMode: this.capacityMode(resource),
      pitr: this.pitrStatus(resource),
      ttl: this.ttlEnabled(resource) ? 'ENABLED' : '',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const tableName = resourceIdOf(resource);
    const keyspaceName = this.keyspaceName(resource);
    let table;
    try {
      const found = await this.keyspaces.send(new GetTableCommand({ keyspaceName, tableName }));
      table = found;
    } catch (err) {
      // A missing table AND a missing PARENT keyspace both raise
      // ResourceNotFoundException — either way the table is absent and
      // converges via create once the sibling Keyspace exists.
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (table.resourceArn !== undefined) {
      const tagResult = await this.keyspaces.send(
        new ListTagsForResourceCommand({ resourceArn: table.resourceArn }),
      );
      tags = fromKeyspacesTags(tagResult.tags);
    }

    const partitionKeys = (table.schemaDefinition?.partitionKeys ?? [])
      .map((k) => k.name ?? '')
      .join(',');
    const clusteringKeys = (table.schemaDefinition?.clusteringKeys ?? [])
      .map((k) => `${k.name ?? ''}:${k.orderBy ?? 'ASC'}`)
      .join(',');
    const allColumns = [...(table.schemaDefinition?.allColumns ?? [])]
      .map((c) => `${c.name ?? ''}:${c.type ?? ''}`)
      .sort()
      .join(',');
    const liveMode = table.capacitySpecification?.throughputMode ?? PAY_PER_REQUEST;
    const livePitr = table.pointInTimeRecovery?.status ?? 'DISABLED';
    const liveTtl = table.ttl?.status === 'ENABLED' ? 'ENABLED' : '';

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        keyspaceName: table.keyspaceName ?? keyspaceName,
        partitionKeys,
        clusteringKeys,
        allColumns,
        capacityMode: liveMode,
        pitr: livePitr,
        ttl: liveTtl,
      },
    };
    if (table.resourceArn !== undefined) state.identifier = table.resourceArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const tableName = resourceIdOf(resource);
    const keyspaceName = this.keyspaceName(resource);
    const pitr: PointInTimeRecovery | undefined =
      this.pitrStatus(resource) === 'ENABLED' ? { status: 'ENABLED' } : undefined;
    const ttl: TimeToLive | undefined = this.ttlEnabled(resource) ? { status: 'ENABLED' } : undefined;
    const created = await this.keyspaces.send(
      new CreateTableCommand({
        keyspaceName,
        tableName,
        schemaDefinition: this.schemaDefinition(resource),
        capacitySpecification: this.capacitySpecification(resource),
        ...(pitr ? { pointInTimeRecovery: pitr } : {}),
        ...(ttl ? { ttl } : {}),
        tags: toKeyspacesTags(tags),
      }),
    );
    return created.resourceArn ?? `keyspaces:table/${keyspaceName}/${tableName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const keyspaceName = this.keyspaceName(resource);
    const tableName = resourceIdOf(resource);
    // Amazon Keyspaces UpdateTable rejects changing more than ONE custom
    // property per call ("Changing more than one custom property is not
    // supported. Tried changing N" — M23.2 live finding). Sending unchanged
    // properties still counts, so only send the ones that actually drifted,
    // and issue a SEPARATE UpdateTable for each. `current.projection` is the
    // live read; `desired` is what the plan wants.
    const desired = this.desiredProjection(resource);
    const live = current.projection;

    // Reconcile tags FIRST, while the table is still ACTIVE. An UpdateTable
    // moves the table to UPDATING and Keyspaces then rejects any further
    // mutation — including TagResource — with "… is currently being created,
    // altered or deleted" (M23.2 live finding). Tagging before the property
    // change avoids that race.
    if (current.identifier !== undefined) {
      await this.keyspaces.send(
        new TagResourceCommand({
          resourceArn: current.identifier,
          tags: toKeyspacesTags(current.tags),
        }),
      );
    }

    if ((desired['capacityMode'] ?? '') !== (live['capacityMode'] ?? '')) {
      await this.keyspaces.send(
        new UpdateTableCommand({
          keyspaceName,
          tableName,
          capacitySpecification: this.capacitySpecification(resource),
        }),
      );
    }
    if ((desired['pitr'] ?? '') !== (live['pitr'] ?? '')) {
      await this.keyspaces.send(
        new UpdateTableCommand({
          keyspaceName,
          tableName,
          pointInTimeRecovery: { status: this.pitrStatus(resource) },
        }),
      );
    }
    // TTL cannot be disabled once enabled — only ever send an enable.
    if ((desired['ttl'] ?? '') !== (live['ttl'] ?? '') && this.ttlEnabled(resource)) {
      const ttl: TimeToLive = { status: 'ENABLED' };
      await this.keyspaces.send(
        new UpdateTableCommand({ keyspaceName, tableName, ttl }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    // On replace, the live table sits in the OLD keyspace (the immutable key
    // that drifted) — delete where it actually lives, not where it should be.
    const keyspaceName = current.projection['keyspaceName'] || this.keyspaceName(resource);
    await this.keyspaces.send(
      new DeleteTableCommand({ keyspaceName, tableName: resourceIdOf(resource) }),
    );
  }
}
