/**
 * M23.2 Redshift Serverless handlers (`aws:redshiftserverless:Namespace` +
 * `aws:redshiftserverless:Workgroup`), the warehouse branch of the Database
 * kind. Mock-tested: namespace create with the Secrets Manager-managed admin
 * password (NO plaintext password anywhere) + tags, converged no-op with a
 * desired-gated kmsKeyId, immutable dbName replace, managed-only destroy;
 * workgroup create at the 8-RPU floor bound to its namespace, the required
 * namespaceName fail-close (zero calls), baseCapacity drift in place, the
 * immutable namespaceName replace, destroy; and dependsOn-aware ordering across
 * the pair (namespace before workgroup on create, reversed on destroy).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateNamespaceCommand,
  CreateWorkgroupCommand,
  DeleteNamespaceCommand,
  DeleteWorkgroupCommand,
  GetNamespaceCommand,
  GetWorkgroupCommand,
  ListTagsForResourceCommand,
  RedshiftServerlessClient,
  TagResourceCommand,
  UpdateNamespaceCommand,
  UpdateWorkgroupCommand,
} from '@aws-sdk/client-redshift-serverless';
import type { Namespace, Workgroup } from '@aws-sdk/client-redshift-serverless';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const rss = mockClient(RedshiftServerlessClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => rss.reset());

const managedTagList = [{ key: 'iap:managed', value: 'true' }];

/** A live, available namespace at defaults with a managed admin secret. */
function liveNamespace(overrides: Partial<Namespace> = {}): Namespace {
  return {
    namespaceName: 'warehouse',
    namespaceArn: 'arn:aws:redshift-serverless:eu-central-1:000000000000:namespace/warehouse',
    dbName: 'iapdb',
    adminUsername: 'iapadmin',
    status: 'AVAILABLE',
    adminPasswordSecretArn: 'arn:aws:secretsmanager:eu-central-1:000000000000:secret:rs-admin-abc',
    ...overrides,
  };
}

/** A live, available workgroup bound to `warehouse` at the 8-RPU floor. */
function liveWorkgroup(overrides: Partial<Workgroup> = {}): Workgroup {
  return {
    workgroupName: 'warehouse-wg',
    workgroupArn: 'arn:aws:redshift-serverless:eu-central-1:000000000000:workgroup/warehouse-wg',
    namespaceName: 'warehouse',
    baseCapacity: 8,
    publiclyAccessible: false,
    status: 'AVAILABLE',
    endpoint: {
      address: 'warehouse-wg.000000000000.eu-central-1.redshift-serverless.amazonaws.com',
      port: 5439,
    },
    ...overrides,
  };
}

describe('aws:redshiftserverless:Namespace', () => {
  const plan = providerPlan([planResource('warehouse', 'aws:redshiftserverless:Namespace', {})]);

  it('absent → CreateNamespace: managed admin password, dbName default, tags — and NO plaintext password anywhere', async () => {
    rss.on(GetNamespaceCommand).rejects(serviceError('ResourceNotFoundException'));
    rss.on(CreateNamespaceCommand).resolves({
      namespace: { namespaceArn: 'arn:aws:redshift-serverless:::namespace/warehouse' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:redshift-serverless:::namespace/warehouse');
    const input = rss.commandCalls(CreateNamespaceCommand)[0]?.args[0].input;
    expect(input?.namespaceName).toBe('warehouse');
    expect(input?.dbName).toBe('iapdb'); // default
    expect(input?.adminUsername).toBe('iapadmin');
    // Secrets Manager-managed admin credentials — no password material via IaP.
    expect(input?.manageAdminPassword).toBe(true);
    expect(input?.adminUserPassword).toBeUndefined();
    expect(input?.kmsKeyId).toBeUndefined(); // unpinned → AWS-managed key
    expect(input?.tags?.some((t) => t.key === 'iap:managed' && t.value === 'true')).toBe(true);
    expect(input?.tags?.some((t) => t.key === 'iap:planId')).toBe(true);
    // Belt and braces: no call in the whole run carried an adminUserPassword,
    // and no projection value leaks a password.
    for (const call of rss.calls()) {
      const anyInput = (call.args[0] as { input: Record<string, unknown> }).input;
      expect(anyInput['adminUserPassword']).toBeUndefined();
    }
    for (const item of report.items) {
      expect(JSON.stringify(item)).not.toContain('adminUserPassword');
    }
  });

  it('create honours a pinned dbName + kmsKeyId', async () => {
    const pinned = providerPlan([
      planResource('warehouse', 'aws:redshiftserverless:Namespace', {
        dbName: 'analytics',
        kmsKeyId: 'arn:aws:kms:eu-central-1:000000000000:key/abc',
      }),
    ]);
    rss.on(GetNamespaceCommand).rejects(serviceError('ResourceNotFoundException'));
    rss.on(CreateNamespaceCommand).resolves({});

    await executor().apply(pinned, { apply: true });
    const input = rss.commandCalls(CreateNamespaceCommand)[0]?.args[0].input;
    expect(input?.dbName).toBe('analytics');
    expect(input?.kmsKeyId).toBe('arn:aws:kms:eu-central-1:000000000000:key/abc');
    expect(input?.manageAdminPassword).toBe(true);
  });

  it('present + converged → no-op; unpinned kmsKeyId is not drift', async () => {
    rss.on(GetNamespaceCommand).resolves({
      // AWS reports a concrete KmsKeyId — an unpinned plan must not read that
      // default as drift (desired-gated comparison).
      namespace: liveNamespace({ kmsKeyId: 'AWS_OWNED_KMS_KEY' }),
    });
    rss.on(ListTagsForResourceCommand).resolves({ tags: managedTagList });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(rss.commandCalls(CreateNamespaceCommand)).toHaveLength(0);
    expect(rss.commandCalls(UpdateNamespaceCommand)).toHaveLength(0);
    expect(rss.commandCalls(DeleteNamespaceCommand)).toHaveLength(0);
  });

  it('dbName drift is IMMUTABLE → plans replace; gate closed refuses; gate open deletes THEN creates', async () => {
    // Live dbName iapdb, plan pins a different dbName → create-only identity.
    const renamed = providerPlan([
      planResource('warehouse', 'aws:redshiftserverless:Namespace', { dbName: 'analytics' }),
    ]);
    rss.on(GetNamespaceCommand).resolves({ namespace: liveNamespace() }); // dbName iapdb
    rss.on(ListTagsForResourceCommand).resolves({ tags: managedTagList });
    rss.on(DeleteNamespaceCommand).resolves({});
    rss.on(CreateNamespaceCommand).resolves({
      namespace: { namespaceArn: 'arn:aws:redshift-serverless:::namespace/warehouse-new' },
    });

    const planned = await executor().plan(renamed);
    expect(planned.items[0]?.action).toBe('replace');

    // Replacement gate closed → refusal recorded, nothing destroyed.
    const refused = await executor().apply(renamed, { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(rss.commandCalls(DeleteNamespaceCommand)).toHaveLength(0);

    // Gate open → delete THEN create, in that order.
    const report = await executor().apply(renamed, { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    const mutations = rss
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'DeleteNamespaceCommand' || n === 'CreateNamespaceCommand');
    expect(mutations).toEqual(['DeleteNamespaceCommand', 'CreateNamespaceCommand']);
  });

  it('destroy deletes a managed namespace; refuses an unmanaged one', async () => {
    rss.on(GetNamespaceCommand).resolves({ namespace: liveNamespace() });
    rss.on(DeleteNamespaceCommand).resolves({});

    // Unmanaged (no iap:managed tag) → managed-only destroy refuses, no delete.
    rss.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'owner', value: 'someone' }] });
    const refused = await executor().apply(plan, { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('managed-only destroy');
    expect(rss.commandCalls(DeleteNamespaceCommand)).toHaveLength(0);

    // Managed → deletes.
    rss.on(ListTagsForResourceCommand).resolves({ tags: managedTagList });
    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = rss.commandCalls(DeleteNamespaceCommand)[0]?.args[0].input;
    expect(input?.namespaceName).toBe('warehouse');
  });

  it('a namespace in DELETING status reads as absent (never updated, never resurrected)', async () => {
    rss.on(GetNamespaceCommand).resolves({ namespace: liveNamespace({ status: 'DELETING' }) });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create'); // absent-in-progress
    expect(rss.commandCalls(ListTagsForResourceCommand)).toHaveLength(0); // not even tag-read
  });
});

describe('aws:redshiftserverless:Workgroup', () => {
  const plan = providerPlan([
    planResource('warehouse-wg', 'aws:redshiftserverless:Workgroup', {
      namespaceName: 'warehouse',
    }),
  ]);

  it('absent → CreateWorkgroup: 8-RPU floor, bound to its namespace, not public, tagged', async () => {
    rss.on(GetWorkgroupCommand).rejects(serviceError('ResourceNotFoundException'));
    rss.on(CreateWorkgroupCommand).resolves({
      workgroup: { workgroupArn: 'arn:aws:redshift-serverless:::workgroup/warehouse-wg' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(
      'arn:aws:redshift-serverless:::workgroup/warehouse-wg',
    );
    const input = rss.commandCalls(CreateWorkgroupCommand)[0]?.args[0].input;
    expect(input?.workgroupName).toBe('warehouse-wg');
    expect(input?.namespaceName).toBe('warehouse');
    expect(input?.baseCapacity).toBe(8); // serverless floor default
    expect(input?.publiclyAccessible).toBe(false); // default — teardown-safe
    expect(input?.enhancedVpcRouting).toBe(false);
    expect(input?.tags?.some((t) => t.key === 'iap:managed' && t.value === 'true')).toBe(true);
  });

  it('create honours a pinned baseCapacity', async () => {
    const sized = providerPlan([
      planResource('warehouse-wg', 'aws:redshiftserverless:Workgroup', {
        namespaceName: 'warehouse',
        baseCapacity: 32,
      }),
    ]);
    rss.on(GetWorkgroupCommand).rejects(serviceError('ResourceNotFoundException'));
    rss.on(CreateWorkgroupCommand).resolves({});

    await executor().apply(sized, { apply: true });
    const input = rss.commandCalls(CreateWorkgroupCommand)[0]?.args[0].input;
    expect(input?.baseCapacity).toBe(32);
  });

  it('missing namespaceName fails CLOSED: recorded error, ZERO calls', async () => {
    const orphan = providerPlan([
      planResource('warehouse-wg', 'aws:redshiftserverless:Workgroup', {}),
    ]);

    const report = await executor().apply(orphan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('namespaceName');
    expect(report.errors).toHaveLength(1);
    // Fails closed BEFORE any SDK call — not even the read reaches AWS.
    expect(rss.calls()).toHaveLength(0);
  });

  it('baseCapacity drift → UpdateWorkgroup in place (no replace)', async () => {
    const scaled = providerPlan([
      planResource('warehouse-wg', 'aws:redshiftserverless:Workgroup', {
        namespaceName: 'warehouse',
        baseCapacity: 64,
      }),
    ]);
    rss.on(GetWorkgroupCommand).resolves({ workgroup: liveWorkgroup() }); // live: 8
    rss.on(ListTagsForResourceCommand).resolves({ tags: managedTagList });
    rss.on(UpdateWorkgroupCommand).resolves({});
    rss.on(TagResourceCommand).resolves({});

    const report = await executor().apply(scaled, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    expect(rss.commandCalls(UpdateWorkgroupCommand)).toHaveLength(1);
    const input = rss.commandCalls(UpdateWorkgroupCommand)[0]?.args[0].input;
    expect(input?.workgroupName).toBe('warehouse-wg');
    expect(input?.baseCapacity).toBe(64);
    expect(input?.publiclyAccessible).toBeUndefined(); // only drifted attrs
    expect(rss.commandCalls(DeleteWorkgroupCommand)).toHaveLength(0);
  });

  it('namespaceName drift is IMMUTABLE → replace classification', async () => {
    const moved = providerPlan([
      planResource('warehouse-wg', 'aws:redshiftserverless:Workgroup', {
        namespaceName: 'other-namespace',
      }),
    ]);
    rss.on(GetWorkgroupCommand).resolves({ workgroup: liveWorkgroup() }); // bound to warehouse
    rss.on(ListTagsForResourceCommand).resolves({ tags: managedTagList });

    const planned = await executor().plan(moved);
    expect(planned.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteWorkgroup on a managed workgroup', async () => {
    rss.on(GetWorkgroupCommand).resolves({ workgroup: liveWorkgroup() });
    rss.on(ListTagsForResourceCommand).resolves({ tags: managedTagList });
    rss.on(DeleteWorkgroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = rss.commandCalls(DeleteWorkgroupCommand)[0]?.args[0].input;
    expect(input?.workgroupName).toBe('warehouse-wg');
  });

  it('a workgroup in DELETING status reads as absent', async () => {
    rss.on(GetWorkgroupCommand).resolves({ workgroup: liveWorkgroup({ status: 'DELETING' }) });
    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create');
    expect(rss.commandCalls(ListTagsForResourceCommand)).toHaveLength(0);
  });
});

describe('namespace + workgroup dependsOn ordering', () => {
  /**
   * The workgroup ('a-wg') sorts alphabetically BEFORE the namespace
   * ('b-ns') — only dependsOn can order the pair correctly, exactly like a
   * live warehouse plan where the workgroup depends on its namespace (and a
   * namespace cannot be deleted while a workgroup still references it).
   */
  function pair() {
    const namespace = planResource('b-ns', 'aws:redshiftserverless:Namespace', {});
    const workgroup = planResource('a-wg', 'aws:redshiftserverless:Workgroup', {
      namespaceName: 'b-ns',
    });
    workgroup.dependsOn = [namespace.logicalId];
    return { namespace, workgroup };
  }

  it('create: the namespace acts FIRST even though the workgroup sorts first', async () => {
    const { namespace, workgroup } = pair();
    rss.on(GetNamespaceCommand).rejects(serviceError('ResourceNotFoundException'));
    rss.on(GetWorkgroupCommand).rejects(serviceError('ResourceNotFoundException'));
    rss.on(CreateNamespaceCommand).resolves({});
    rss.on(CreateWorkgroupCommand).resolves({});

    const report = await executor().apply(providerPlan([workgroup, namespace]), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([
      namespace.logicalId,
      workgroup.logicalId,
    ]);
    const calls = rss.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('CreateNamespaceCommand')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('CreateNamespaceCommand')).toBeLessThan(
      calls.indexOf('CreateWorkgroupCommand'),
    );
  });

  it('destroy: reversed — the workgroup is deleted BEFORE its namespace', async () => {
    const { namespace, workgroup } = pair();
    rss.on(GetNamespaceCommand).resolves({
      namespace: liveNamespace({ namespaceName: 'b-ns' }),
    });
    rss.on(GetWorkgroupCommand).resolves({
      workgroup: liveWorkgroup({ workgroupName: 'a-wg', namespaceName: 'b-ns' }),
    });
    rss.on(ListTagsForResourceCommand).resolves({ tags: managedTagList });
    rss.on(DeleteNamespaceCommand).resolves({});
    rss.on(DeleteWorkgroupCommand).resolves({});

    const report = await executor().apply(providerPlan([workgroup, namespace]), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([
      workgroup.logicalId,
      namespace.logicalId,
    ]);
    const calls = rss.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('DeleteWorkgroupCommand')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('DeleteWorkgroupCommand')).toBeLessThan(
      calls.indexOf('DeleteNamespaceCommand'),
    );
  });
});
