/**
 * M22.2 `aws:dynamodb:Table` handler, mock-tested: create with the compact
 * keySchema serialization, converged no-op, mutable update-in-place, the
 * immutable keySchema replace (gated delete+create), managed-only destroy,
 * and the default-SSE desired-gating regression (M22.1 SQS lesson).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';
import type { DescribeTableCommandOutput } from '@aws-sdk/client-dynamodb';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const ddb = mockClient(DynamoDBClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => ddb.reset());

/** A live, ACTIVE, iap-managed pk:S,sk:N on-demand table. */
function liveTable(overrides: Partial<NonNullable<DescribeTableCommandOutput['Table']>> = {}) {
  return {
    TableName: 'sessions',
    TableArn: 'arn:aws:dynamodb:eu-central-1:000000000000:table/sessions',
    TableStatus: 'ACTIVE' as const,
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' as const },
      { AttributeName: 'sk', KeyType: 'RANGE' as const },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' as const },
      { AttributeName: 'sk', AttributeType: 'N' as const },
    ],
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' as const },
    DeletionProtectionEnabled: false,
    ...overrides,
  };
}

const managedTags = { Tags: [{ Key: 'iap:managed', Value: 'true' }] };

describe('aws:dynamodb:Table', () => {
  const plan = providerPlan([
    planResource('sessions', 'aws:dynamodb:Table', { keySchema: 'pk:S,sk:N' }),
  ]);

  it('absent → CreateTable with parsed KeySchema/AttributeDefinitions, BillingMode, iap tags', async () => {
    ddb.on(DescribeTableCommand).rejects(serviceError('ResourceNotFoundException'));
    ddb.on(CreateTableCommand).resolves({
      TableDescription: { TableArn: 'arn:aws:dynamodb:::table/sessions' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:dynamodb:::table/sessions');
    const input = ddb.commandCalls(CreateTableCommand)[0]?.args[0].input;
    expect(input?.TableName).toBe('sessions');
    expect(input?.KeySchema).toEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
    expect(input?.AttributeDefinitions).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'N' },
    ]);
    expect(input?.BillingMode).toBe('PAY_PER_REQUEST'); // default — no throughput
    expect(input?.ProvisionedThroughput).toBeUndefined();
    expect(input?.DeletionProtectionEnabled).toBe(false); // default — teardown-safe
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(input?.Tags?.some((t) => t.Key === 'iap:planId')).toBe(true);
    expect(input?.Tags?.some((t) => t.Key === 'iap:resourceId')).toBe(true);
  });

  it('billingMode=PROVISIONED → small default throughput at create', async () => {
    const provisioned = providerPlan([
      planResource('sessions', 'aws:dynamodb:Table', {
        keySchema: 'pk:S',
        billingMode: 'PROVISIONED',
      }),
    ]);
    ddb.on(DescribeTableCommand).rejects(serviceError('ResourceNotFoundException'));
    ddb.on(CreateTableCommand).resolves({});

    await executor().apply(provisioned, { apply: true });
    const input = ddb.commandCalls(CreateTableCommand)[0]?.args[0].input;
    expect(input?.BillingMode).toBe('PROVISIONED');
    expect(input?.ProvisionedThroughput?.ReadCapacityUnits).toBe(5);
    expect(input?.ProvisionedThroughput?.WriteCapacityUnits).toBe(5);
  });

  it('present + converged → no-op, nothing mutated', async () => {
    ddb.on(DescribeTableCommand).resolves({ Table: liveTable() });
    ddb.on(ListTagsOfResourceCommand).resolves(managedTags);

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(ddb.commandCalls(CreateTableCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateTableCommand)).toHaveLength(0);
    expect(ddb.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it('mutable drift (deletionProtection) → update-in-place, no delete', async () => {
    const protectedPlan = providerPlan([
      planResource('sessions', 'aws:dynamodb:Table', {
        keySchema: 'pk:S,sk:N',
        deletionProtection: true,
      }),
    ]);
    ddb.on(DescribeTableCommand).resolves({ Table: liveTable() }); // live: unprotected
    ddb.on(ListTagsOfResourceCommand).resolves(managedTags);
    ddb.on(UpdateTableCommand).resolves({});
    ddb.on(TagResourceCommand).resolves({});

    const report = await executor().apply(protectedPlan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = ddb.commandCalls(UpdateTableCommand)[0]?.args[0].input;
    expect(input?.TableName).toBe('sessions');
    expect(input?.DeletionProtectionEnabled).toBe(true);
    expect(input?.BillingMode).toBeUndefined(); // only the drifted attribute
    expect(ddb.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it('billingMode drift → UpdateTable with throughput when switching to PROVISIONED', async () => {
    const provisionedPlan = providerPlan([
      planResource('sessions', 'aws:dynamodb:Table', {
        keySchema: 'pk:S,sk:N',
        billingMode: 'PROVISIONED',
      }),
    ]);
    ddb.on(DescribeTableCommand).resolves({ Table: liveTable() }); // live: on-demand
    ddb.on(ListTagsOfResourceCommand).resolves(managedTags);
    ddb.on(UpdateTableCommand).resolves({});
    ddb.on(TagResourceCommand).resolves({});

    const report = await executor().apply(provisionedPlan, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    const input = ddb.commandCalls(UpdateTableCommand)[0]?.args[0].input;
    expect(input?.BillingMode).toBe('PROVISIONED');
    expect(input?.ProvisionedThroughput?.ReadCapacityUnits).toBe(5);
  });

  it('keySchema drift is IMMUTABLE → plans replace; gate open executes delete THEN create', async () => {
    // Live table keyed id:S; the plan wants pk:S,sk:N — the first live
    // replacement exercise (ADR-0006).
    ddb.on(DescribeTableCommand).resolves({
      Table: liveTable({
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      }),
    });
    ddb.on(ListTagsOfResourceCommand).resolves(managedTags);
    ddb.on(DeleteTableCommand).resolves({});
    ddb.on(CreateTableCommand).resolves({
      TableDescription: { TableArn: 'arn:aws:dynamodb:::table/sessions-new' },
    });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('replace');

    // Gate closed → refuses, nothing destroyed.
    const refused = await executor().apply(plan, { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(ddb.commandCalls(DeleteTableCommand)).toHaveLength(0);

    // Gate open → delete THEN create, in that order.
    const report = await executor().apply(plan, { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:dynamodb:::table/sessions-new');
    const mutations = ddb
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((name) => name === 'DeleteTableCommand' || name === 'CreateTableCommand');
    expect(mutations).toEqual(['DeleteTableCommand', 'CreateTableCommand']);
  });

  it('destroy → DeleteTable on a managed table', async () => {
    ddb.on(DescribeTableCommand).resolves({ Table: liveTable() });
    ddb.on(ListTagsOfResourceCommand).resolves(managedTags);
    ddb.on(DeleteTableCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(ddb.commandCalls(DeleteTableCommand)[0]?.args[0].input?.TableName).toBe('sessions');
    expect(ddb.commandCalls(UpdateTableCommand)).toHaveLength(0); // was not protected
  });

  it('destroy disables deletion protection FIRST when the live table is protected', async () => {
    ddb.on(DescribeTableCommand).resolves({
      Table: liveTable({ DeletionProtectionEnabled: true }),
    });
    ddb.on(ListTagsOfResourceCommand).resolves(managedTags);
    ddb.on(UpdateTableCommand).resolves({});
    ddb.on(DeleteTableCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(ddb.commandCalls(UpdateTableCommand)[0]?.args[0].input?.DeletionProtectionEnabled).toBe(false);
    const order = ddb
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((name) => name === 'UpdateTableCommand' || name === 'DeleteTableCommand');
    expect(order).toEqual(['UpdateTableCommand', 'DeleteTableCommand']);
  });

  it('destroy refuses an unmanaged table (managed-only gate)', async () => {
    ddb.on(DescribeTableCommand).resolves({ Table: liveTable() });
    ddb.on(ListTagsOfResourceCommand).resolves({ Tags: [] }); // not ours

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(ddb.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it('default-SSE regression: live SSE fields with no desired sse attributes → no drift', async () => {
    // Every DynamoDB table is encrypted at rest by default; a live table can
    // report SSEDescription (e.g. KMS) without the plan pinning anything.
    // Desired-gated comparison must read this as converged (M22.1 SQS lesson).
    ddb.on(DescribeTableCommand).resolves({
      Table: liveTable({
        SSEDescription: {
          Status: 'ENABLED',
          SSEType: 'KMS',
          KMSMasterKeyArn: 'arn:aws:kms:eu-central-1:000000000000:key/default',
        },
      }),
    });
    ddb.on(ListTagsOfResourceCommand).resolves(managedTags);

    const report = await executor().plan(plan); // plan has NO sse attributes
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('pinned sseKmsKeyArn → CreateTable carries the KMS SSESpecification', async () => {
    const encrypted = providerPlan([
      planResource('sessions', 'aws:dynamodb:Table', {
        keySchema: 'pk:S',
        sseKmsKeyArn: 'arn:aws:kms:eu-central-1:000000000000:key/cmk',
      }),
    ]);
    ddb.on(DescribeTableCommand).rejects(serviceError('ResourceNotFoundException'));
    ddb.on(CreateTableCommand).resolves({});

    await executor().apply(encrypted, { apply: true });
    const sse = ddb.commandCalls(CreateTableCommand)[0]?.args[0].input?.SSESpecification;
    expect(sse?.Enabled).toBe(true);
    expect(sse?.SSEType).toBe('KMS');
    expect(sse?.KMSMasterKeyId).toBe('arn:aws:kms:eu-central-1:000000000000:key/cmk');
  });

  it('a DELETING table reads as absent (never updated, never resurrected)', async () => {
    ddb.on(DescribeTableCommand).resolves({ Table: liveTable({ TableStatus: 'DELETING' }) });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create'); // absent-in-progress
    expect(ddb.commandCalls(ListTagsOfResourceCommand)).toHaveLength(0); // not even tag-read
  });
});
