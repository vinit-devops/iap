/**
 * Execution ordering (M22.2 live finding → fixed before M22.3): `dependsOn`
 * is honoured topologically, alphabetical among the ready set, REVERSED on
 * destroy; cycles fail closed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateBackupPlanCommand,
  CreateBackupVaultCommand,
  BackupClient,
  DeleteBackupPlanCommand,
  DeleteBackupVaultCommand,
  DescribeBackupVaultCommand,
  GetBackupPlanCommand,
  ListBackupPlansCommand,
  ListTagsCommand,
} from '@aws-sdk/client-backup';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const backup = mockClient(BackupClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

/** vault + plan where ALPHABETICAL order alone would create the plan first. */
function vaultAndPlan() {
  const vault = planResource('a-vault', 'aws:backup:BackupVault', {});
  // 'a-plan' sorts BEFORE 'a-vault' — only dependsOn can order it correctly.
  const plan = planResource('a-plan', 'aws:backup:BackupPlan', {
    vaultName: 'a-vault',
  });
  plan.dependsOn = [vault.logicalId];
  return { vault, plan };
}

beforeEach(() => {
  backup.reset();
});

describe('dependsOn-aware ordering (topological, alphabetical tiebreak)', () => {
  it('create: a dependent sorting alphabetically first still runs AFTER its dependency', async () => {
    const { vault, plan } = vaultAndPlan();
    backup.on(DescribeBackupVaultCommand).rejects(serviceError('ResourceNotFoundException'));
    backup.on(ListBackupPlansCommand).resolves({ BackupPlansList: [] });
    backup.on(CreateBackupVaultCommand).resolves({ BackupVaultArn: 'arn:aws:backup:v' });
    backup
      .on(CreateBackupPlanCommand)
      .resolves({ BackupPlanArn: 'arn:aws:backup:p', BackupPlanId: 'id-1' });

    const report = await executor().apply(providerPlan([plan, vault]), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([vault.logicalId, plan.logicalId]);
    const calls = backup.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('CreateBackupVaultCommand')).toBeLessThan(
      calls.indexOf('CreateBackupPlanCommand'),
    );
  });

  it('destroy: reverses the topology — dependent deleted BEFORE its dependency', async () => {
    const { vault, plan } = vaultAndPlan();
    const managedTags = { 'iap:managed': 'true' };
    backup.on(DescribeBackupVaultCommand).resolves({ BackupVaultArn: 'arn:aws:backup:v' });
    backup.on(ListBackupPlansCommand).resolves({
      BackupPlansList: [
        { BackupPlanId: 'id-1', BackupPlanName: 'a-plan', BackupPlanArn: 'arn:aws:backup:p' },
      ],
    });
    backup.on(GetBackupPlanCommand).resolves({
      BackupPlan: { BackupPlanName: 'a-plan', Rules: [] },
      BackupPlanArn: 'arn:aws:backup:p',
    });
    backup.on(ListTagsCommand).resolves({ Tags: managedTags });
    backup.on(DeleteBackupPlanCommand).resolves({});
    backup.on(DeleteBackupVaultCommand).resolves({});

    const report = await executor().apply(providerPlan([plan, vault]), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([plan.logicalId, vault.logicalId]);
    const calls = backup.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('DeleteBackupPlanCommand')).toBeLessThan(
      calls.indexOf('DeleteBackupVaultCommand'),
    );
  });

  it('no dependsOn → historic pure-alphabetical order preserved', async () => {
    const a = planResource('aa', 'aws:backup:BackupVault', {});
    const b = planResource('bb', 'aws:backup:BackupVault', {});
    backup.on(DescribeBackupVaultCommand).rejects(serviceError('ResourceNotFoundException'));
    const report = await executor().plan(providerPlan([b, a]));
    expect(report.items.map((i) => i.logicalId)).toEqual([a.logicalId, b.logicalId]);
  });

  it('a dependsOn cycle fails closed: apply records the error, plan throws', async () => {
    const { vault, plan } = vaultAndPlan();
    vault.dependsOn = [plan.logicalId]; // close the cycle

    const report = await executor().apply(providerPlan([plan, vault]), { apply: true });
    expect(report.items).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('dependsOn cycle');
    expect(backup.calls()).toHaveLength(0);

    await expect(executor().plan(providerPlan([plan, vault]))).rejects.toThrow('dependsOn cycle');
  });

  it('a dependsOn naming a logicalId outside the plan is ignored', async () => {
    const { vault, plan } = vaultAndPlan();
    plan.dependsOn = [vault.logicalId, 'elsewhere.aws:s3:Bucket'];
    backup.on(DescribeBackupVaultCommand).rejects(serviceError('ResourceNotFoundException'));
    backup.on(ListBackupPlansCommand).resolves({ BackupPlansList: [] });
    const report = await executor().plan(providerPlan([plan, vault]));
    expect(report.items.map((i) => i.logicalId)).toEqual([vault.logicalId, plan.logicalId]);
  });
});
