/**
 * `aws:dynamodb:Table` handler (@aws-sdk/client-dynamodb) — key-value
 * Database class (M22.2).
 *
 * read → DescribeTable (+ ListTagsOfResource with the table ARN)
 * create → CreateTable (billing mode, key schema, SSE, deletion protection,
 *          tags at creation)
 * update → UpdateTable (drifted mutable attrs only) + TagResource
 * delete → UpdateTable(DeletionProtectionEnabled=false) when protected, then
 *          DeleteTable (fail-closed: if the disable fails, delete never runs)
 *
 * KEY SCHEMA FORMAT — the `keySchema` desired attribute is a compact
 * serialization: `<name>:<S|N|B>` for the HASH key, optionally followed by
 * `,<name>:<S|N|B>` for the RANGE key. Examples: `pk:S`, `pk:S,sk:N`.
 * Defaults to `id:S` when absent. The key schema is IMMUTABLE — drift on it
 * classifies as gated replace (ADR-0006); this is the roadmap-mandated first
 * live replacement exercise.
 *
 * A table in DELETING status reads as absent — like a Secrets Manager secret
 * with DeletedDate set, it is on its way out and must never be updated or
 * resurrected (a create racing the deletion fails with ResourceInUseException,
 * which is the honest signal to retry after the deletion completes).
 *
 * SSE is desired-gated (M22.1 SQS lesson): every DynamoDB table is encrypted
 * at rest by default with an AWS owned key, and such tables report SSE fields
 * on read. A plan that does not pin `sseEnabled` / `sseKmsKeyArn` must not
 * read the AWS default as drift, so both keys project as '' on both sides
 * unless the plan sets them.
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';
import type {
  AttributeDefinition,
  BillingMode,
  DynamoDBClient,
  KeySchemaElement,
  ScalarAttributeType,
  SSESpecification,
} from '@aws-sdk/client-dynamodb';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;
const DEFAULT_KEY_SCHEMA = 'id:S';
const DEFAULT_BILLING_MODE = 'PAY_PER_REQUEST';
/** Sensible small floor when billingMode=PROVISIONED without explicit units. */
const PROVISIONED_DEFAULT_UNITS = 5;

interface ParsedKey {
  name: string;
  type: ScalarAttributeType;
}

/**
 * Parse the compact `name:S[,name:N]` serialization into ordered key parts —
 * first element is the HASH key, optional second is the RANGE key.
 */
function parseKeySchema(serialized: string): ParsedKey[] {
  const parts = serialized
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0 || parts.length > 2) {
    throw new Error(
      `invalid keySchema '${serialized}': expected 'name:S' or 'name:S,name:N' (HASH[,RANGE])`,
    );
  }
  return parts.map((part) => {
    const [name, type] = part.split(':').map((s) => s.trim());
    if (!name || type === undefined || !['S', 'N', 'B'].includes(type.toUpperCase())) {
      throw new Error(
        `invalid keySchema element '${part}': expected '<name>:<S|N|B>'`,
      );
    }
    return { name, type: type.toUpperCase() as ScalarAttributeType };
  });
}

/** Canonical re-serialization so DESIRED and LIVE forms compare equal. */
function canonicalKeySchema(keys: ParsedKey[]): string {
  return keys.map((k) => `${k.name}:${k.type}`).join(',');
}

export class DynamoDbTableHandler implements TargetHandler {
  static readonly targetType = 'aws:dynamodb:Table' as const;
  readonly targetType = DynamoDbTableHandler.targetType;
  /** Key schema is immutable — drift on it classifies as replace (ADR-0006). */
  readonly immutableProjectionKeys = ['keySchema'] as const;

  constructor(private readonly client: DynamoDBClient) {}

  private desiredKeys(resource: PlanResource): ParsedKey[] {
    const serialized = scalarStr(resource.desiredAttributes['keySchema']) || DEFAULT_KEY_SCHEMA;
    return parseKeySchema(serialized);
  }

  /** True when the plan pins any SSE posture (desired-gated comparison). */
  private ssePinned(resource: PlanResource): boolean {
    return (
      resource.desiredAttributes['sseEnabled'] !== undefined ||
      resource.desiredAttributes['sseKmsKeyArn'] !== undefined
    );
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    const projection: Record<string, string> = {
      keySchema: canonicalKeySchema(this.desiredKeys(resource)),
      billingMode: scalarStr(a['billingMode']) || DEFAULT_BILLING_MODE,
      deletionProtection: scalarStr(a['deletionProtection']) === 'true' ? 'true' : 'false',
      // SSE compares only when the plan pins it — DynamoDB always encrypts at
      // rest with an AWS owned key, and an unpinned plan must not read that
      // default as drift (M22.1 SQS SSE lesson).
      sseEnabled: '',
      sseKmsKeyArn: '',
    };
    if (this.ssePinned(resource)) {
      const kmsArn = scalarStr(a['sseKmsKeyArn']);
      projection['sseEnabled'] =
        kmsArn !== '' || scalarStr(a['sseEnabled']) === 'true' ? 'true' : 'false';
      projection['sseKmsKeyArn'] = kmsArn;
    }
    return projection;
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const TableName = resourceIdOf(resource);
    let table;
    try {
      const found = await this.client.send(new DescribeTableCommand({ TableName }));
      table = found.Table;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (table === undefined || table.TableStatus === 'DELETING') {
      // Deletion in progress — treat as absent; never update a dying table.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const arn = table.TableArn;
    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.client.send(
        new ListTagsOfResourceCommand({ ResourceArn: arn }),
      );
      tags = fromTagList(tagResult.Tags ?? []);
    }

    // Rebuild the canonical keySchema serialization from the live table.
    const attrTypes = new Map<string, string>();
    for (const def of table.AttributeDefinitions ?? []) {
      if (def.AttributeName !== undefined) {
        attrTypes.set(def.AttributeName, def.AttributeType ?? '');
      }
    }
    const hash = (table.KeySchema ?? []).find((k) => k.KeyType === 'HASH');
    const range = (table.KeySchema ?? []).find((k) => k.KeyType === 'RANGE');
    const liveKeys = [hash, range]
      .filter((k): k is KeySchemaElement => k?.AttributeName !== undefined)
      .map((k) => `${k.AttributeName}:${attrTypes.get(k.AttributeName ?? '') ?? ''}`);

    const projection: Record<string, string> = {
      keySchema: liveKeys.join(','),
      // Tables without a BillingModeSummary predate on-demand — PROVISIONED.
      billingMode: table.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
      deletionProtection: table.DeletionProtectionEnabled === true ? 'true' : 'false',
      sseEnabled: '',
      sseKmsKeyArn: '',
    };
    if (this.ssePinned(resource)) {
      projection['sseEnabled'] = table.SSEDescription?.Status === 'ENABLED' ? 'true' : 'false';
      projection['sseKmsKeyArn'] =
        scalarStr(resource.desiredAttributes['sseKmsKeyArn']) === ''
          ? '' // compare the ARN only when the plan pins a specific key
          : (table.SSEDescription?.KMSMasterKeyArn ?? '');
    }

    const state: ResourceState = { exists: true, managed: isManaged(tags), tags, projection };
    if (arn !== undefined) state.identifier = arn;
    return state;
  }

  /** SSESpecification for create/update; undefined when the plan pins nothing. */
  private sseSpecification(resource: PlanResource): SSESpecification | undefined {
    if (!this.ssePinned(resource)) return undefined;
    const kmsArn = scalarStr(resource.desiredAttributes['sseKmsKeyArn']);
    if (kmsArn !== '') return { Enabled: true, SSEType: 'KMS', KMSMasterKeyId: kmsArn };
    if (scalarStr(resource.desiredAttributes['sseEnabled']) === 'true') {
      return { Enabled: true, SSEType: 'KMS' }; // AWS managed key (aws/dynamodb)
    }
    return { Enabled: false }; // explicit false → AWS owned key (the default)
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const TableName = resourceIdOf(resource);
    const keys = this.desiredKeys(resource);
    const d = this.desiredProjection(resource);
    const KeySchema: KeySchemaElement[] = keys.map((key, index) => ({
      AttributeName: key.name,
      KeyType: index === 0 ? 'HASH' : 'RANGE',
    }));
    const AttributeDefinitions: AttributeDefinition[] = keys.map((key) => ({
      AttributeName: key.name,
      AttributeType: key.type,
    }));
    const billingMode = d['billingMode'] as BillingMode;
    const sse = this.sseSpecification(resource);
    const created = await this.client.send(
      new CreateTableCommand({
        TableName,
        KeySchema,
        AttributeDefinitions,
        BillingMode: billingMode,
        ...(billingMode === 'PROVISIONED'
          ? {
              ProvisionedThroughput: {
                ReadCapacityUnits: PROVISIONED_DEFAULT_UNITS,
                WriteCapacityUnits: PROVISIONED_DEFAULT_UNITS,
              },
            }
          : {}),
        ...(sse !== undefined ? { SSESpecification: sse } : {}),
        DeletionProtectionEnabled: d['deletionProtection'] === 'true',
        Tags: toTagList(tags),
      }),
    );
    // No ACTIVE waiter here — matching repo idiom (RDS/ElastiCache create
    // without waiting; the live-run driver verifies convergence). Bounded
    // waiters exist only where teardown ordering requires them.
    return created.TableDescription?.TableArn ?? `dynamodb:table/${TableName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const TableName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: Record<string, unknown> = {};
    if (d['billingMode'] !== live['billingMode']) {
      changes['BillingMode'] = d['billingMode'];
      if (d['billingMode'] === 'PROVISIONED') {
        changes['ProvisionedThroughput'] = {
          ReadCapacityUnits: PROVISIONED_DEFAULT_UNITS,
          WriteCapacityUnits: PROVISIONED_DEFAULT_UNITS,
        };
      }
    }
    if (d['deletionProtection'] !== live['deletionProtection']) {
      changes['DeletionProtectionEnabled'] = d['deletionProtection'] === 'true';
    }
    if (
      this.ssePinned(resource) &&
      (d['sseEnabled'] !== live['sseEnabled'] || d['sseKmsKeyArn'] !== live['sseKmsKeyArn'])
    ) {
      changes['SSESpecification'] = this.sseSpecification(resource);
    }
    if (Object.keys(changes).length > 0) {
      await this.client.send(new UpdateTableCommand({ TableName, ...changes }));
    }
    // Reconcile tags on the live table (repo idiom: re-assert ownership tags).
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagResourceCommand({
          ResourceArn: current.identifier,
          Tags: toTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const TableName = resourceIdOf(resource);
    // Deletion protection is part of the desired posture — disable it first so
    // managed teardown succeeds. Fail-closed: if the disable throws, the
    // DeleteTable below never runs.
    if (current.projection['deletionProtection'] === 'true') {
      await this.client.send(
        new UpdateTableCommand({ TableName, DeletionProtectionEnabled: false }),
      );
    }
    await this.client.send(new DeleteTableCommand({ TableName }));
  }
}
