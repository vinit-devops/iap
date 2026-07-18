/**
 * M22.3 Aurora handlers (`aws:rds:DBCluster` + `aws:rds:DBClusterInstance`),
 * mock-tested: Serverless v2 create at the cheapest posture (min 0 ACU,
 * managed master password — no plaintext password anywhere), converged no-op,
 * capacity drift in place, the immutable engine replace (gated delete+create),
 * deletion-protection-disable-before-delete, the required-clusterId fail-close,
 * and dependsOn-aware ordering across the two resource types.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
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
  RDSClient,
} from '@aws-sdk/client-rds';
import type { DBCluster } from '@aws-sdk/client-rds';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const rds = mockClient(RDSClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => rds.reset());

/** A live, available, Serverless v2 aurora-postgresql cluster at defaults. */
function liveCluster(overrides: Partial<DBCluster> = {}): DBCluster {
  return {
    DBClusterIdentifier: 'ledger',
    DBClusterArn: 'arn:aws:rds:eu-central-1:000000000000:cluster:ledger',
    Status: 'available',
    Engine: 'aurora-postgresql',
    ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1 },
    BackupRetentionPeriod: 1,
    DeletionProtection: false,
    ...overrides,
  };
}

const managedTagList = [{ Key: 'iap:managed', Value: 'true' }];

describe('aws:rds:DBCluster', () => {
  const plan = providerPlan([
    planResource('ledger', 'aws:rds:DBCluster', { engine: 'postgresql' }),
  ]);

  it('absent → CreateDBCluster: Serverless v2 scale-to-zero, managed master password, encrypted, tagged — and NO plaintext password anywhere', async () => {
    rds.on(DescribeDBClustersCommand).rejects(serviceError('DBClusterNotFoundFault'));
    rds.on(CreateDBClusterCommand).resolves({
      DBCluster: { DBClusterArn: 'arn:aws:rds:::cluster:ledger' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:rds:::cluster:ledger');
    const input = rds.commandCalls(CreateDBClusterCommand)[0]?.args[0].input;
    expect(input?.DBClusterIdentifier).toBe('ledger');
    expect(input?.Engine).toBe('aurora-postgresql'); // postgresql → aurora-postgresql
    // Cheapest posture: min 0 ACU (scales to zero idle), max 1 ACU.
    expect(input?.ServerlessV2ScalingConfiguration).toEqual({ MinCapacity: 0, MaxCapacity: 1 });
    // RDS-managed master secret — no password material through IaP, ever.
    expect(input?.MasterUsername).toBe('iapadmin');
    expect(input?.ManageMasterUserPassword).toBe(true);
    expect(input?.MasterUserPassword).toBeUndefined();
    expect(input?.StorageEncrypted).toBe(true);
    expect(input?.DeletionProtection).toBe(false); // default — teardown-safe
    expect(input?.BackupRetentionPeriod).toBe(1);
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(input?.Tags?.some((t) => t.Key === 'iap:planId')).toBe(true);
    // Belt and braces: no call in the whole run carried a MasterUserPassword.
    for (const call of rds.calls()) {
      const anyInput = (call.args[0] as { input: Record<string, unknown> }).input;
      expect(anyInput['MasterUserPassword']).toBeUndefined();
    }
  });

  it('create wires the sibling subnet group name when the plan sets it', async () => {
    const wired = providerPlan([
      planResource('ledger', 'aws:rds:DBCluster', {
        engine: 'mysql',
        subnetGroupName: 'ledger-subnets',
      }),
    ]);
    rds.on(DescribeDBClustersCommand).rejects(serviceError('DBClusterNotFoundFault'));
    rds.on(CreateDBClusterCommand).resolves({});

    await executor().apply(wired, { apply: true });
    const input = rds.commandCalls(CreateDBClusterCommand)[0]?.args[0].input;
    expect(input?.Engine).toBe('aurora-mysql'); // mysql → aurora-mysql
    expect(input?.DBSubnetGroupName).toBe('ledger-subnets');
  });

  it('present + converged → no-op; unpinned engineVersion is not drift', async () => {
    rds.on(DescribeDBClustersCommand).resolves({
      // AWS always reports a concrete EngineVersion — an unpinned plan must
      // not read that default as drift (desired-gated comparison).
      DBClusters: [liveCluster({ EngineVersion: '16.6' })],
    });
    rds.on(ListTagsForResourceCommand).resolves({ TagList: managedTagList });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(rds.commandCalls(CreateDBClusterCommand)).toHaveLength(0);
    expect(rds.commandCalls(ModifyDBClusterCommand)).toHaveLength(0);
    expect(rds.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);
  });

  it('capacity drift → single ModifyDBCluster in place (ApplyImmediately), no replace', async () => {
    const scaled = providerPlan([
      planResource('ledger', 'aws:rds:DBCluster', {
        engine: 'postgresql',
        minCapacity: 0.5,
        maxCapacity: 4,
      }),
    ]);
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [liveCluster()] }); // live: 0/1
    rds.on(ListTagsForResourceCommand).resolves({ TagList: managedTagList });
    rds.on(ModifyDBClusterCommand).resolves({});
    rds.on(AddTagsToResourceCommand).resolves({});

    const report = await executor().apply(scaled, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    expect(rds.commandCalls(ModifyDBClusterCommand)).toHaveLength(1);
    const input = rds.commandCalls(ModifyDBClusterCommand)[0]?.args[0].input;
    expect(input?.DBClusterIdentifier).toBe('ledger');
    expect(input?.ApplyImmediately).toBe(true);
    expect(input?.ServerlessV2ScalingConfiguration).toEqual({ MinCapacity: 0.5, MaxCapacity: 4 });
    expect(input?.BackupRetentionPeriod).toBeUndefined(); // only drifted attrs
    expect(rds.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);
  });

  it('engine drift is IMMUTABLE → plans replace; gate closed refuses; gate open deletes THEN creates', async () => {
    // Live aurora-mysql, plan wants postgresql → aurora-postgresql (ADR-0006).
    rds.on(DescribeDBClustersCommand).resolves({
      DBClusters: [liveCluster({ Engine: 'aurora-mysql' })],
    });
    rds.on(ListTagsForResourceCommand).resolves({ TagList: managedTagList });
    rds.on(DeleteDBClusterCommand).resolves({});
    rds.on(CreateDBClusterCommand).resolves({
      DBCluster: { DBClusterArn: 'arn:aws:rds:::cluster:ledger-new' },
    });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('replace');

    // Replacement gate closed → refusal recorded, nothing destroyed.
    const refused = await executor().apply(plan, { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(rds.commandCalls(DeleteDBClusterCommand)).toHaveLength(0);

    // Gate open → delete THEN create, in that order.
    const report = await executor().apply(plan, { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:rds:::cluster:ledger-new');
    const mutations = rds
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'DeleteDBClusterCommand' || n === 'CreateDBClusterCommand');
    expect(mutations).toEqual(['DeleteDBClusterCommand', 'CreateDBClusterCommand']);
  });

  it('destroy disables deletion protection FIRST when live-protected, then deletes without a snapshot', async () => {
    rds.on(DescribeDBClustersCommand).resolves({
      DBClusters: [liveCluster({ DeletionProtection: true })],
    });
    rds.on(ListTagsForResourceCommand).resolves({ TagList: managedTagList });
    rds.on(ModifyDBClusterCommand).resolves({});
    rds.on(DeleteDBClusterCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    const modify = rds.commandCalls(ModifyDBClusterCommand)[0]?.args[0].input;
    expect(modify?.DeletionProtection).toBe(false);
    const del = rds.commandCalls(DeleteDBClusterCommand)[0]?.args[0].input;
    expect(del?.DBClusterIdentifier).toBe('ledger');
    expect(del?.SkipFinalSnapshot).toBe(true);
    const order = rds
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'ModifyDBClusterCommand' || n === 'DeleteDBClusterCommand');
    expect(order).toEqual(['ModifyDBClusterCommand', 'DeleteDBClusterCommand']);
  });

  it('a cluster in `deleting` status reads as absent (never updated, never resurrected)', async () => {
    rds.on(DescribeDBClustersCommand).resolves({
      DBClusters: [liveCluster({ Status: 'deleting' })],
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create'); // absent-in-progress
    expect(rds.commandCalls(ListTagsForResourceCommand)).toHaveLength(0); // not even tag-read
  });
});

describe('aws:rds:DBClusterInstance', () => {
  it('absent → CreateDBInstance into the owning cluster with db.serverless + tags', async () => {
    const plan = providerPlan([
      planResource('ledger-writer', 'aws:rds:DBClusterInstance', {
        clusterId: 'ledger',
        engine: 'postgresql',
      }),
    ]);
    rds.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));
    rds.on(CreateDBInstanceCommand).resolves({
      DBInstance: { DBInstanceArn: 'arn:aws:rds:::db:ledger-writer' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:rds:::db:ledger-writer');
    const input = rds.commandCalls(CreateDBInstanceCommand)[0]?.args[0].input;
    expect(input?.DBInstanceIdentifier).toBe('ledger-writer');
    expect(input?.DBClusterIdentifier).toBe('ledger');
    expect(input?.DBInstanceClass).toBe('db.serverless'); // Serverless v2 default
    expect(input?.Engine).toBe('aurora-postgresql');
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('missing clusterId fails CLOSED: recorded error, zero mutating calls', async () => {
    const orphan = providerPlan([
      planResource('ledger-writer', 'aws:rds:DBClusterInstance', { engine: 'postgresql' }),
    ]);
    rds.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));

    const report = await executor().apply(orphan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('clusterId');
    expect(report.errors).toHaveLength(1);
    expect(rds.commandCalls(CreateDBInstanceCommand)).toHaveLength(0);
    // The only call issued was the read — nothing mutated.
    expect(rds.calls().map((c) => c.args[0].constructor.name)).toEqual([
      'DescribeDBInstancesCommand',
    ]);
  });

  it('instanceClass drift → ModifyDBInstance in place; clusterId drift → replace classification', async () => {
    const plan = providerPlan([
      planResource('ledger-writer', 'aws:rds:DBClusterInstance', {
        clusterId: 'ledger',
        instanceClass: 'db.r6g.large',
      }),
    ]);
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'ledger-writer',
          DBInstanceArn: 'arn:aws:rds:::db:ledger-writer',
          DBInstanceStatus: 'available',
          DBClusterIdentifier: 'ledger',
          DBInstanceClass: 'db.serverless',
          TagList: managedTagList,
        },
      ],
    });
    rds.on(ModifyDBInstanceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    const input = rds.commandCalls(ModifyDBInstanceCommand)[0]?.args[0].input;
    expect(input?.DBInstanceClass).toBe('db.r6g.large');
    expect(input?.ApplyImmediately).toBe(true);

    // Same live instance, but the plan points at a DIFFERENT cluster —
    // an instance cannot move between clusters in place (ADR-0006).
    const moved = providerPlan([
      planResource('ledger-writer', 'aws:rds:DBClusterInstance', {
        clusterId: 'other-cluster',
        instanceClass: 'db.serverless',
      }),
    ]);
    const planned = await executor().plan(moved);
    expect(planned.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteDBInstance with SkipFinalSnapshot on a managed instance', async () => {
    const plan = providerPlan([
      planResource('ledger-writer', 'aws:rds:DBClusterInstance', { clusterId: 'ledger' }),
    ]);
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'ledger-writer',
          DBInstanceStatus: 'available',
          DBClusterIdentifier: 'ledger',
          DBInstanceClass: 'db.serverless',
          TagList: managedTagList,
        },
      ],
    });
    rds.on(DeleteDBInstanceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = rds.commandCalls(DeleteDBInstanceCommand)[0]?.args[0].input;
    expect(input?.DBInstanceIdentifier).toBe('ledger-writer');
    expect(input?.SkipFinalSnapshot).toBe(true);
  });
});

describe('cluster + instance dependsOn ordering (M22.2 executor fix)', () => {
  /**
   * Instance sorts alphabetically BEFORE the cluster ('a-writer' < 'b-ledger')
   * — only dependsOn can order the pair correctly, exactly like a live plan
   * where the writer instance depends on its cluster.
   */
  function pair() {
    const cluster = planResource('b-ledger', 'aws:rds:DBCluster', { engine: 'postgresql' });
    const instance = planResource('a-writer', 'aws:rds:DBClusterInstance', {
      clusterId: 'b-ledger',
      engine: 'postgresql',
    });
    instance.dependsOn = [cluster.logicalId];
    return { cluster, instance };
  }

  it('create: the cluster acts FIRST even though the instance sorts first', async () => {
    const { cluster, instance } = pair();
    rds.on(DescribeDBClustersCommand).rejects(serviceError('DBClusterNotFoundFault'));
    rds.on(DescribeDBInstancesCommand).rejects(serviceError('DBInstanceNotFoundFault'));
    rds.on(CreateDBClusterCommand).resolves({});
    rds.on(CreateDBInstanceCommand).resolves({});

    const report = await executor().apply(providerPlan([instance, cluster]), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([cluster.logicalId, instance.logicalId]);
    const calls = rds.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('CreateDBClusterCommand')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('CreateDBClusterCommand')).toBeLessThan(
      calls.indexOf('CreateDBInstanceCommand'),
    );
  });

  it('destroy: reversed — the instance is deleted BEFORE its cluster', async () => {
    const { cluster, instance } = pair();
    rds.on(DescribeDBClustersCommand).resolves({
      DBClusters: [liveClusterNamed('b-ledger')],
    });
    rds.on(ListTagsForResourceCommand).resolves({ TagList: managedTagList });
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'a-writer',
          DBInstanceStatus: 'available',
          DBClusterIdentifier: 'b-ledger',
          DBInstanceClass: 'db.serverless',
          TagList: managedTagList,
        },
      ],
    });
    rds.on(DeleteDBInstanceCommand).resolves({});
    rds.on(DeleteDBClusterCommand).resolves({});

    const report = await executor().apply(providerPlan([instance, cluster]), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([instance.logicalId, cluster.logicalId]);
    const calls = rds.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('DeleteDBInstanceCommand')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('DeleteDBInstanceCommand')).toBeLessThan(
      calls.indexOf('DeleteDBClusterCommand'),
    );
  });

  function liveClusterNamed(id: string): DBCluster {
    return {
      DBClusterIdentifier: id,
      DBClusterArn: `arn:aws:rds:eu-central-1:000000000000:cluster:${id}`,
      Status: 'available',
      Engine: 'aurora-postgresql',
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1 },
      BackupRetentionPeriod: 1,
      DeletionProtection: false,
    };
  }
});
