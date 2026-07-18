/**
 * M23.2 Amazon Keyspaces handlers, mock-tested: the wide-column Database class
 * (Keyspace + Table). Covers the empty keyspace projection (identity-only,
 * like BackupVault), the cross-resource keyspaceName reference (immutable →
 * gated replace, ADR-0006), the compact `schema` serialization parsed into a
 * SchemaDefinition (partition + clustering keys), PAY_PER_REQUEST default,
 * capacity/pitr update-in-place, schema/keyspace drift → replace, managed-only
 * destroy, and dependsOn ordering (keyspace before table on create, reversed
 * on destroy — mirroring test/ordering.test.ts via report.items order).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateKeyspaceCommand,
  CreateTableCommand,
  DeleteKeyspaceCommand,
  DeleteTableCommand,
  GetKeyspaceCommand,
  GetTableCommand,
  KeyspacesClient,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-keyspaces';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const keyspaces = mockClient(KeyspacesClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => keyspaces.reset());

describe('aws:cassandra:Keyspace', () => {
  const ksPlan = (attrs: Record<string, string> = {}) =>
    providerPlan([planResource('app', 'aws:cassandra:Keyspace', attrs)]);

  it('absent → CreateKeyspace with mandatory iap tags inline', async () => {
    keyspaces.on(GetKeyspaceCommand).rejects(serviceError('ResourceNotFoundException', 404));
    keyspaces.on(CreateKeyspaceCommand).resolves({ resourceArn: 'arn:keyspaces:keyspace/app' });

    const report = await executor().apply(ksPlan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:keyspaces:keyspace/app');
    const input = keyspaces.commandCalls(CreateKeyspaceCommand)[0]?.args[0].input;
    expect(input?.keyspaceName).toBe('app');
    const tags = input?.tags ?? [];
    expect(tags.some((t) => t.key === 'iap:managed' && t.value === 'true')).toBe(true);
    expect(tags.some((t) => t.key === 'iap:resourceId')).toBe(true);
    expect(tags.some((t) => t.key === 'iap:planId')).toBe(true);
  });

  it('present → no-op: the empty projection can never classify as update/replace', async () => {
    keyspaces.on(GetKeyspaceCommand).resolves({
      keyspaceName: 'app',
      resourceArn: 'arn:keyspaces:keyspace/app',
      replicationStrategy: 'SINGLE_REGION',
    });
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });

    const report = await executor().plan(ksPlan());
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('destroy → DeleteKeyspace when managed; refuses unmanaged (managed-only gate)', async () => {
    keyspaces.on(GetKeyspaceCommand).resolves({
      keyspaceName: 'app',
      resourceArn: 'arn:keyspaces:keyspace/app',
      replicationStrategy: 'SINGLE_REGION',
    });
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });
    keyspaces.on(DeleteKeyspaceCommand).resolves({});

    const report = await executor().apply(ksPlan(), { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(keyspaces.commandCalls(DeleteKeyspaceCommand)[0]?.args[0].input?.keyspaceName).toBe('app');

    // Not tagged iap:managed=true → the delete is refused, nothing issued.
    keyspaces.reset();
    keyspaces.on(GetKeyspaceCommand).resolves({
      keyspaceName: 'app',
      resourceArn: 'arn:keyspaces:keyspace/app',
      replicationStrategy: 'SINGLE_REGION',
    });
    keyspaces.on(ListTagsForResourceCommand).resolves({ tags: [] });

    const refused = await executor().apply(ksPlan(), { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('managed-only destroy');
    expect(keyspaces.commandCalls(DeleteKeyspaceCommand)).toHaveLength(0);
  });
});

describe('aws:cassandra:Table', () => {
  const SCHEMA = 'id:uuid:pk,event_time:timestamp:ck:desc,payload:text';
  const tablePlan = (attrs: Record<string, string> = {}) =>
    providerPlan([
      planResource('events', 'aws:cassandra:Table', {
        keyspaceName: 'app',
        schema: SCHEMA,
        ...attrs,
      }),
    ]);

  it('absent → CreateTable with parsed schemaDefinition + PAY_PER_REQUEST + iap tags', async () => {
    keyspaces.on(GetTableCommand).rejects(serviceError('ResourceNotFoundException', 404));
    keyspaces.on(CreateTableCommand).resolves({ resourceArn: 'arn:keyspaces:table/app/events' });

    const report = await executor().apply(tablePlan(), { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:keyspaces:table/app/events');
    const input = keyspaces.commandCalls(CreateTableCommand)[0]?.args[0].input;
    expect(input?.keyspaceName).toBe('app');
    expect(input?.tableName).toBe('events');
    // Partition key parsed from role `pk`.
    expect(input?.schemaDefinition?.partitionKeys).toEqual([{ name: 'id' }]);
    // Clustering key parsed from role `ck` with the DESC order modifier.
    expect(input?.schemaDefinition?.clusteringKeys).toEqual([
      { name: 'event_time', orderBy: 'DESC' },
    ]);
    // allColumns includes the key columns AND the regular column.
    expect(input?.schemaDefinition?.allColumns).toEqual([
      { name: 'id', type: 'uuid' },
      { name: 'event_time', type: 'timestamp' },
      { name: 'payload', type: 'text' },
    ]);
    expect(input?.capacitySpecification?.throughputMode).toBe('PAY_PER_REQUEST');
    const tags = input?.tags ?? [];
    expect(tags.some((t) => t.key === 'iap:managed' && t.value === 'true')).toBe(true);
  });

  it('missing keyspaceName fails closed with a recorded error and ZERO calls', async () => {
    const orphan = providerPlan([
      planResource('events', 'aws:cassandra:Table', { schema: SCHEMA }),
    ]);

    const report = await executor().apply(orphan, { apply: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('keyspaceName');
    // Fails before ANY call — read never even describes.
    expect(keyspaces.commandCalls(GetTableCommand)).toHaveLength(0);
  });

  it('capacity + pitr drift → one UpdateTable PER property (Keyspaces one-property-per-call rule)', async () => {
    // M23.2 LIVE FINDING: Amazon Keyspaces UpdateTable rejects changing more
    // than one custom property per call ("Changing more than one custom
    // property is not supported. Tried changing 2"). When both capacity AND
    // pitr drift, the handler must issue TWO UpdateTable calls, one property
    // each — never a single combined request.
    keyspaces.on(GetTableCommand).resolves({
      keyspaceName: 'app',
      tableName: 'events',
      resourceArn: 'arn:keyspaces:table/app/events',
      schemaDefinition: {
        allColumns: [
          { name: 'id', type: 'uuid' },
          { name: 'event_time', type: 'timestamp' },
          { name: 'payload', type: 'text' },
        ],
        partitionKeys: [{ name: 'id' }],
        clusteringKeys: [{ name: 'event_time', orderBy: 'DESC' }],
      },
      capacitySpecification: { throughputMode: 'PAY_PER_REQUEST' },
      pointInTimeRecovery: { status: 'DISABLED' },
    });
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });
    keyspaces.on(UpdateTableCommand).resolves({ resourceArn: 'arn:keyspaces:table/app/events' });
    keyspaces.on(TagResourceCommand).resolves({});

    const report = await executor().apply(
      tablePlan({
        capacityMode: 'PROVISIONED',
        readCapacityUnits: '5',
        writeCapacityUnits: '5',
        pointInTimeRecovery: 'ENABLED',
      }),
      { apply: true },
    );

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const calls = keyspaces.commandCalls(UpdateTableCommand);
    // Exactly two calls — one per drifted custom property.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const input = call.args[0].input;
      expect(input?.keyspaceName).toBe('app');
      expect(input?.tableName).toBe('events');
      // Each call carries EXACTLY ONE custom property (never both).
      const customProps = [
        input?.capacitySpecification,
        input?.pointInTimeRecovery,
        input?.ttl,
      ].filter((p) => p !== undefined);
      expect(customProps).toHaveLength(1);
    }
    const capacityCall = calls.find((c) => c.args[0].input?.capacitySpecification !== undefined);
    expect(capacityCall?.args[0].input?.capacitySpecification?.throughputMode).toBe('PROVISIONED');
    expect(capacityCall?.args[0].input?.capacitySpecification?.readCapacityUnits).toBe(5);
    const pitrCall = calls.find((c) => c.args[0].input?.pointInTimeRecovery !== undefined);
    expect(pitrCall?.args[0].input?.pointInTimeRecovery?.status).toBe('ENABLED');
    expect(keyspaces.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it('pitr-only drift → a SINGLE UpdateTable carrying only pointInTimeRecovery', async () => {
    // Regression for the exact M23.2 live failure: enabling PITR alone must NOT
    // also resend the (unchanged) capacitySpecification — sending it counts as
    // a second custom property and AWS rejects the call.
    keyspaces.on(GetTableCommand).resolves({
      keyspaceName: 'app',
      tableName: 'events',
      resourceArn: 'arn:keyspaces:table/app/events',
      schemaDefinition: {
        allColumns: [
          { name: 'id', type: 'uuid' },
          { name: 'event_time', type: 'timestamp' },
          { name: 'payload', type: 'text' },
        ],
        partitionKeys: [{ name: 'id' }],
        clusteringKeys: [{ name: 'event_time', orderBy: 'DESC' }],
      },
      capacitySpecification: { throughputMode: 'PAY_PER_REQUEST' },
      pointInTimeRecovery: { status: 'DISABLED' },
    });
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });
    keyspaces.on(UpdateTableCommand).resolves({ resourceArn: 'arn:keyspaces:table/app/events' });
    keyspaces.on(TagResourceCommand).resolves({});

    // Only PITR drifts (capacity stays PAY_PER_REQUEST).
    const report = await executor().apply(
      tablePlan({ pointInTimeRecovery: 'ENABLED' }),
      { apply: true },
    );

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const calls = keyspaces.commandCalls(UpdateTableCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.pointInTimeRecovery?.status).toBe('ENABLED');
    // The unchanged capacity is NOT resent — that was the live bug.
    expect(input?.capacitySpecification).toBeUndefined();
    expect(input?.ttl).toBeUndefined();
  });

  it('keyspaceName drift is IMMUTABLE → replace, executed only behind the gate', async () => {
    const liveInLegacy = {
      keyspaceName: 'legacy', // desired parent is 'app' → immutable drift
      tableName: 'events',
      resourceArn: 'arn:keyspaces:table/legacy/events',
      schemaDefinition: {
        allColumns: [
          { name: 'id', type: 'uuid' },
          { name: 'event_time', type: 'timestamp' },
          { name: 'payload', type: 'text' },
        ],
        partitionKeys: [{ name: 'id' }],
        clusteringKeys: [{ name: 'event_time', orderBy: 'DESC' }],
      },
      capacitySpecification: { throughputMode: 'PAY_PER_REQUEST' },
      pointInTimeRecovery: { status: 'DISABLED' },
    };
    keyspaces.on(GetTableCommand).resolves(liveInLegacy);
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });

    const planned = await executor().plan(tablePlan());
    expect(planned.items[0]?.action).toBe('replace');
    expect(planned.items[0]?.reason).toContain('delete+create');

    // Gate CLOSED: refuse — destructive delete+create needs replace: true.
    const refused = await executor().apply(tablePlan(), { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(keyspaces.commandCalls(DeleteTableCommand)).toHaveLength(0);
    expect(keyspaces.commandCalls(CreateTableCommand)).toHaveLength(0);

    // Gate OPEN: delete (from the OLD keyspace, where the table lives) THEN create.
    keyspaces.on(DeleteTableCommand).resolves({});
    keyspaces.on(CreateTableCommand).resolves({ resourceArn: 'arn:keyspaces:table/app/events' });

    const replaced = await executor().apply(tablePlan(), { apply: true, replace: true });
    expect(replaced.items[0]?.applied).toBe(true);
    expect(replaced.errors).toHaveLength(0);
    const del = keyspaces.commandCalls(DeleteTableCommand)[0]?.args[0].input;
    expect(del?.keyspaceName).toBe('legacy');
    expect(del?.tableName).toBe('events');
    const created = keyspaces.commandCalls(CreateTableCommand)[0]?.args[0].input;
    expect(created?.keyspaceName).toBe('app');
  });

  it('schema (partition/clustering key) drift is IMMUTABLE → replace', async () => {
    keyspaces.on(GetTableCommand).resolves({
      keyspaceName: 'app',
      tableName: 'events',
      resourceArn: 'arn:keyspaces:table/app/events',
      schemaDefinition: {
        allColumns: [
          { name: 'id', type: 'uuid' },
          { name: 'payload', type: 'text' },
        ],
        // Live table has NO clustering key — desired declares one → schema drift.
        partitionKeys: [{ name: 'id' }],
        clusteringKeys: [],
      },
      capacitySpecification: { throughputMode: 'PAY_PER_REQUEST' },
      pointInTimeRecovery: { status: 'DISABLED' },
    });
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });

    const planned = await executor().plan(tablePlan());
    expect(planned.items[0]?.action).toBe('replace');
    expect(planned.items[0]?.reason).toContain('delete+create');
  });

  it('destroy → DeleteTable when managed; refuses unmanaged', async () => {
    keyspaces.on(GetTableCommand).resolves({
      keyspaceName: 'app',
      tableName: 'events',
      resourceArn: 'arn:keyspaces:table/app/events',
      schemaDefinition: {
        allColumns: [{ name: 'id', type: 'uuid' }],
        partitionKeys: [{ name: 'id' }],
      },
      capacitySpecification: { throughputMode: 'PAY_PER_REQUEST' },
      pointInTimeRecovery: { status: 'DISABLED' },
    });
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });
    keyspaces.on(DeleteTableCommand).resolves({});

    const report = await executor().apply(tablePlan(), { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = keyspaces.commandCalls(DeleteTableCommand)[0]?.args[0].input;
    expect(input?.keyspaceName).toBe('app');
    expect(input?.tableName).toBe('events');

    keyspaces.reset();
    keyspaces.on(GetTableCommand).resolves({
      keyspaceName: 'app',
      tableName: 'events',
      resourceArn: 'arn:keyspaces:table/app/events',
      schemaDefinition: {
        allColumns: [{ name: 'id', type: 'uuid' }],
        partitionKeys: [{ name: 'id' }],
      },
    });
    keyspaces.on(ListTagsForResourceCommand).resolves({ tags: [] });

    const refused = await executor().apply(tablePlan(), { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('managed-only destroy');
    expect(keyspaces.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it('parent keyspace gone → table reads absent (ResourceNotFoundException)', async () => {
    // Keyspaces raises the SAME ResourceNotFoundException whether the table or
    // its parent keyspace is missing — both converge via create.
    keyspaces.on(GetTableCommand).rejects(serviceError('ResourceNotFoundException', 404));

    const report = await executor().plan(tablePlan());
    expect(report.items[0]?.action).toBe('create');
  });
});

describe('dependsOn ordering: keyspace before table (reversed on destroy)', () => {
  // 'a-table' sorts BEFORE 'a-ks' alphabetically — only dependsOn can order the
  // keyspace first, exactly as in test/ordering.test.ts.
  function keyspaceAndTable() {
    const ks = planResource('a-ks', 'aws:cassandra:Keyspace', {});
    const table = planResource('a-table', 'aws:cassandra:Table', {
      keyspaceName: 'a-ks',
      schema: 'id:uuid:pk,payload:text',
    });
    table.dependsOn = [ks.logicalId];
    return { ks, table };
  }

  it('create: keyspace runs BEFORE the table it holds', async () => {
    const { ks, table } = keyspaceAndTable();
    keyspaces.on(GetKeyspaceCommand).rejects(serviceError('ResourceNotFoundException', 404));
    keyspaces.on(GetTableCommand).rejects(serviceError('ResourceNotFoundException', 404));
    keyspaces.on(CreateKeyspaceCommand).resolves({ resourceArn: 'arn:keyspaces:keyspace/a-ks' });
    keyspaces.on(CreateTableCommand).resolves({ resourceArn: 'arn:keyspaces:table/a-ks/a-table' });

    const report = await executor().apply(providerPlan([table, ks]), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([ks.logicalId, table.logicalId]);
    const calls = keyspaces.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('CreateKeyspaceCommand')).toBeLessThan(
      calls.indexOf('CreateTableCommand'),
    );
  });

  it('destroy: reverses the topology — table deleted BEFORE its keyspace', async () => {
    const { ks, table } = keyspaceAndTable();
    keyspaces.on(GetKeyspaceCommand).resolves({
      keyspaceName: 'a-ks',
      resourceArn: 'arn:keyspaces:keyspace/a-ks',
      replicationStrategy: 'SINGLE_REGION',
    });
    keyspaces.on(GetTableCommand).resolves({
      keyspaceName: 'a-ks',
      tableName: 'a-table',
      resourceArn: 'arn:keyspaces:table/a-ks/a-table',
      schemaDefinition: {
        allColumns: [{ name: 'id', type: 'uuid' }],
        partitionKeys: [{ name: 'id' }],
      },
    });
    keyspaces
      .on(ListTagsForResourceCommand)
      .resolves({ tags: [{ key: 'iap:managed', value: 'true' }] });
    keyspaces.on(DeleteTableCommand).resolves({});
    keyspaces.on(DeleteKeyspaceCommand).resolves({});

    const report = await executor().apply(providerPlan([table, ks]), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([table.logicalId, ks.logicalId]);
    const calls = keyspaces.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('DeleteTableCommand')).toBeLessThan(
      calls.indexOf('DeleteKeyspaceCommand'),
    );
  });
});
