/**
 * M22.2 time-series handlers, mock-tested: Timestream for LiveAnalytics
 * Database + Table. Covers the desired-gated KMS default (no false drift on
 * the AWS-managed key), the cross-resource databaseName reference (immutable →
 * gated replace, ADR-0006), retention update-in-place, and managed-only
 * destroy.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateDatabaseCommand,
  CreateTableCommand,
  DeleteDatabaseCommand,
  DeleteTableCommand,
  DescribeDatabaseCommand,
  DescribeTableCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  TimestreamWriteClient,
  UpdateDatabaseCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-timestream-write';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const tsw = mockClient(TimestreamWriteClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => tsw.reset());

describe('aws:timestream:Database', () => {
  const dbPlan = (attrs: Record<string, string> = {}) =>
    providerPlan([planResource('metrics', 'aws:timestream:Database', attrs)]);

  it('absent → CreateDatabase with mandatory iap tags (no KmsKeyId when unpinned)', async () => {
    tsw.on(DescribeDatabaseCommand).rejects(serviceError('ResourceNotFoundException', 404));
    tsw.on(CreateDatabaseCommand).resolves({ Database: { Arn: 'arn:timestream:db/metrics' } });

    const report = await executor().apply(dbPlan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:timestream:db/metrics');
    const input = tsw.commandCalls(CreateDatabaseCommand)[0]?.args[0].input;
    expect(input?.DatabaseName).toBe('metrics');
    expect(input?.KmsKeyId).toBeUndefined(); // unpinned → Timestream's AWS-managed key
    const tags = input?.Tags ?? [];
    expect(tags.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(tags.some((t) => t.Key === 'iap:resourceId')).toBe(true);
    expect(tags.some((t) => t.Key === 'iap:planId')).toBe(true);
  });

  it('present + converged: the AWS-managed default key does NOT read as drift when unpinned', async () => {
    tsw.on(DescribeDatabaseCommand).resolves({
      Database: {
        Arn: 'arn:timestream:db/metrics',
        DatabaseName: 'metrics',
        // Timestream always reports SOME key — the account's AWS-managed one
        // when the plan never pinned any. Must classify no-op, not update.
        KmsKeyId: 'arn:aws:kms:eu-central-1:000000000000:key/aws-managed-default',
      },
    });
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });

    const report = await executor().plan(dbPlan());
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('pinned kmsKeyId drift → UpdateDatabase (update-in-place, never delete)', async () => {
    tsw.on(DescribeDatabaseCommand).resolves({
      Database: {
        Arn: 'arn:timestream:db/metrics',
        DatabaseName: 'metrics',
        KmsKeyId: 'arn:aws:kms:eu-central-1:000000000000:key/aws-managed-default',
      },
    });
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });
    tsw.on(UpdateDatabaseCommand).resolves({});
    tsw.on(TagResourceCommand).resolves({});

    const desired = dbPlan({ kmsKeyId: 'arn:aws:kms:eu-central-1:000000000000:key/customer' });
    const report = await executor().apply(desired, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = tsw.commandCalls(UpdateDatabaseCommand)[0]?.args[0].input;
    expect(input?.KmsKeyId).toBe('arn:aws:kms:eu-central-1:000000000000:key/customer');
    expect(tsw.commandCalls(DeleteDatabaseCommand)).toHaveLength(0);
  });

  it('destroy → DeleteDatabase when managed; refuses unmanaged (managed-only gate)', async () => {
    tsw.on(DescribeDatabaseCommand).resolves({
      Database: { Arn: 'arn:timestream:db/metrics', DatabaseName: 'metrics' },
    });
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });
    tsw.on(DeleteDatabaseCommand).resolves({});

    const report = await executor().apply(dbPlan(), { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(tsw.commandCalls(DeleteDatabaseCommand)[0]?.args[0].input?.DatabaseName).toBe('metrics');

    // Not tagged iap:managed=true → the delete is refused, nothing issued.
    tsw.reset();
    tsw.on(DescribeDatabaseCommand).resolves({
      Database: { Arn: 'arn:timestream:db/metrics', DatabaseName: 'metrics' },
    });
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [] });

    const refused = await executor().apply(dbPlan(), { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('managed-only destroy');
    expect(tsw.commandCalls(DeleteDatabaseCommand)).toHaveLength(0);
  });
});

describe('aws:timestream:Table', () => {
  const tablePlan = (attrs: Record<string, string | number> = {}) =>
    providerPlan([
      planResource('readings', 'aws:timestream:Table', { databaseName: 'metrics', ...attrs }),
    ]);

  it('absent → CreateTable inside the parent database with retention + iap tags', async () => {
    tsw.on(DescribeTableCommand).rejects(serviceError('ResourceNotFoundException', 404));
    tsw.on(CreateTableCommand).resolves({ Table: { Arn: 'arn:timestream:table/metrics/readings' } });

    const report = await executor().apply(
      tablePlan({ memoryRetentionHours: 12, magneticRetentionDays: 30 }),
      { apply: true },
    );

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:timestream:table/metrics/readings');
    const input = tsw.commandCalls(CreateTableCommand)[0]?.args[0].input;
    expect(input?.DatabaseName).toBe('metrics');
    expect(input?.TableName).toBe('readings');
    expect(input?.RetentionProperties?.MemoryStoreRetentionPeriodInHours).toBe(12);
    expect(input?.RetentionProperties?.MagneticStoreRetentionPeriodInDays).toBe(30);
    const tags = input?.Tags ?? [];
    expect(tags.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('unpinned retention falls back to 24h memory / 7d magnetic', async () => {
    tsw.on(DescribeTableCommand).rejects(serviceError('ResourceNotFoundException', 404));
    tsw.on(CreateTableCommand).resolves({ Table: { Arn: 'arn:timestream:table/metrics/readings' } });

    await executor().apply(tablePlan(), { apply: true });
    const input = tsw.commandCalls(CreateTableCommand)[0]?.args[0].input;
    expect(input?.RetentionProperties?.MemoryStoreRetentionPeriodInHours).toBe(24);
    expect(input?.RetentionProperties?.MagneticStoreRetentionPeriodInDays).toBe(7);
  });

  it('missing databaseName fails closed with a clear recorded error', async () => {
    const orphan = providerPlan([planResource('readings', 'aws:timestream:Table')]);

    const report = await executor().apply(orphan, { apply: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('databaseName');
    // Fails before ANY call — read never even describes.
    expect(tsw.commandCalls(DescribeTableCommand)).toHaveLength(0);
  });

  it('retention drift → UpdateTable in place (no delete)', async () => {
    tsw.on(DescribeTableCommand).resolves({
      Table: {
        Arn: 'arn:timestream:table/metrics/readings',
        DatabaseName: 'metrics',
        TableName: 'readings',
        RetentionProperties: {
          MemoryStoreRetentionPeriodInHours: 24,
          MagneticStoreRetentionPeriodInDays: 7,
        },
      },
    });
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });
    tsw.on(UpdateTableCommand).resolves({});
    tsw.on(TagResourceCommand).resolves({});

    const report = await executor().apply(tablePlan({ magneticRetentionDays: 30 }), { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = tsw.commandCalls(UpdateTableCommand)[0]?.args[0].input;
    expect(input?.DatabaseName).toBe('metrics');
    expect(input?.TableName).toBe('readings');
    expect(input?.RetentionProperties?.MemoryStoreRetentionPeriodInHours).toBe(24); // default kept
    expect(input?.RetentionProperties?.MagneticStoreRetentionPeriodInDays).toBe(30);
    expect(tsw.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it('databaseName drift is IMMUTABLE → replace, executed only behind the gate', async () => {
    const liveInLegacy = {
      Table: {
        Arn: 'arn:timestream:table/legacy/readings',
        DatabaseName: 'legacy', // desired parent is 'metrics' → immutable drift
        TableName: 'readings',
        RetentionProperties: {
          MemoryStoreRetentionPeriodInHours: 24,
          MagneticStoreRetentionPeriodInDays: 7,
        },
      },
    };
    tsw.on(DescribeTableCommand).resolves(liveInLegacy);
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });

    const planned = await executor().plan(tablePlan());
    expect(planned.items[0]?.action).toBe('replace');
    expect(planned.items[0]?.reason).toContain('delete+create');

    // Replacement gate CLOSED: refuse — destructive delete+create needs replace: true.
    const refused = await executor().apply(tablePlan(), { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(tsw.commandCalls(DeleteTableCommand)).toHaveLength(0);
    expect(tsw.commandCalls(CreateTableCommand)).toHaveLength(0);

    // Gate OPEN: delete (from the OLD database, where the table lives) THEN create.
    tsw.on(DeleteTableCommand).resolves({});
    tsw.on(CreateTableCommand).resolves({ Table: { Arn: 'arn:timestream:table/metrics/readings' } });

    const replaced = await executor().apply(tablePlan(), { apply: true, replace: true });
    expect(replaced.items[0]?.applied).toBe(true);
    expect(replaced.errors).toHaveLength(0);
    const del = tsw.commandCalls(DeleteTableCommand)[0]?.args[0].input;
    expect(del?.DatabaseName).toBe('legacy');
    expect(del?.TableName).toBe('readings');
    const created = tsw.commandCalls(CreateTableCommand)[0]?.args[0].input;
    expect(created?.DatabaseName).toBe('metrics');
  });

  it('destroy → DeleteTable when managed; refuses unmanaged', async () => {
    tsw.on(DescribeTableCommand).resolves({
      Table: {
        Arn: 'arn:timestream:table/metrics/readings',
        DatabaseName: 'metrics',
        TableName: 'readings',
      },
    });
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });
    tsw.on(DeleteTableCommand).resolves({});

    const report = await executor().apply(tablePlan(), { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = tsw.commandCalls(DeleteTableCommand)[0]?.args[0].input;
    expect(input?.DatabaseName).toBe('metrics');
    expect(input?.TableName).toBe('readings');

    tsw.reset();
    tsw.on(DescribeTableCommand).resolves({
      Table: { Arn: 'arn:timestream:table/metrics/readings', DatabaseName: 'metrics' },
    });
    tsw.on(ListTagsForResourceCommand).resolves({ Tags: [] });

    const refused = await executor().apply(tablePlan(), { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('managed-only destroy');
    expect(tsw.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it('parent database gone → table reads absent (ResourceNotFoundException from the database)', async () => {
    // Timestream raises the SAME ResourceNotFoundException whether the table
    // or its parent database is missing — both converge via create.
    tsw.on(DescribeTableCommand).rejects(
      serviceError('ResourceNotFoundException', 404),
    );

    const report = await executor().plan(tablePlan());
    expect(report.items[0]?.action).toBe('create');
  });
});
