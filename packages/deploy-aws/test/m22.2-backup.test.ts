/**
 * M22.2 backup-posture handlers, mock-tested: AWS Backup vault + plan.
 *
 * Covers: vault create with mandatory tags, converged no-op, managed-only
 * destroy, non-empty-vault delete failure surfacing fail-closed; plan create
 * (rule from attributes + defaults, fail-closed missing vaultName),
 * schedule/retention drift → UpdateBackupPlan in place, and destroy via
 * name-resolved generated id including ListBackupPlans pagination.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BackupClient,
  CreateBackupPlanCommand,
  CreateBackupVaultCommand,
  DeleteBackupPlanCommand,
  DeleteBackupVaultCommand,
  DescribeBackupVaultCommand,
  GetBackupPlanCommand,
  ListBackupPlansCommand,
  ListTagsCommand,
  UpdateBackupPlanCommand,
} from '@aws-sdk/client-backup';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const backup = mockClient(BackupClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const VAULT_ARN = 'arn:aws:backup:eu-central-1:000000000000:backup-vault:jarvis-vault';
const PLAN_ARN = 'arn:aws:backup:eu-central-1:000000000000:backup-plan:plan-id-1';

beforeEach(() => {
  backup.reset();
});

describe('aws:backup:BackupVault', () => {
  const vaultPlan = providerPlan([planResource('jarvis-vault', 'aws:backup:BackupVault')]);

  it('absent → CreateBackupVault carrying the mandatory iap tags', async () => {
    backup.on(DescribeBackupVaultCommand).rejects(serviceError('ResourceNotFoundException', 404));
    backup.on(CreateBackupVaultCommand).resolves({ BackupVaultArn: VAULT_ARN });

    const report = await executor().apply(vaultPlan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(VAULT_ARN);
    const input = backup.commandCalls(CreateBackupVaultCommand)[0]?.args[0].input;
    expect(input?.BackupVaultName).toBe('jarvis-vault');
    expect(input?.BackupVaultTags?.['iap:managed']).toBe('true');
    expect(input?.BackupVaultTags?.['iap:planId']).toBe('plan-hash-0001');
    expect(input?.BackupVaultTags?.['iap:resourceId']).toBe('jarvis-vault.aws:backup:BackupVault');
  });

  it('present → no-op (identity-only projection); destroy → DeleteBackupVault', async () => {
    backup.on(DescribeBackupVaultCommand).resolves({
      BackupVaultName: 'jarvis-vault',
      BackupVaultArn: VAULT_ARN,
    });
    backup.on(ListTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });
    backup.on(DeleteBackupVaultCommand).resolves({});

    const planned = await executor().plan(vaultPlan);
    expect(planned.items[0]?.action).toBe('no-op');

    const report = await executor().apply(vaultPlan, { apply: true, destroy: true });
    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(backup.commandCalls(DeleteBackupVaultCommand)[0]?.args[0].input?.BackupVaultName).toBe(
      'jarvis-vault',
    );
  });

  it('destroy refuses an unmanaged vault (managed-only gate)', async () => {
    backup.on(DescribeBackupVaultCommand).resolves({
      BackupVaultName: 'jarvis-vault',
      BackupVaultArn: VAULT_ARN,
    });
    backup.on(ListTagsCommand).resolves({ Tags: {} });

    const report = await executor().apply(vaultPlan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(backup.commandCalls(DeleteBackupVaultCommand)).toHaveLength(0);
  });

  it('delete failure (recovery points remain) surfaces as a recorded error', async () => {
    backup.on(DescribeBackupVaultCommand).resolves({
      BackupVaultName: 'jarvis-vault',
      BackupVaultArn: VAULT_ARN,
      NumberOfRecoveryPoints: 3,
    });
    backup.on(ListTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });
    backup
      .on(DeleteBackupVaultCommand)
      .rejects(serviceError('InvalidRequestException', 400));

    const report = await executor().apply(vaultPlan, { apply: true, destroy: true });

    // Fail closed: the failure is RECORDED, never a silent success.
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('InvalidRequestException');
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('jarvis-vault.aws:backup:BackupVault');
  });
});

describe('aws:backup:BackupPlan', () => {
  const listedPlan = {
    BackupPlanId: 'plan-id-1',
    BackupPlanArn: PLAN_ARN,
    BackupPlanName: 'jarvis-plan',
  };

  it('absent → CreateBackupPlan with the daily rule from attributes + tags', async () => {
    const plan = providerPlan([
      planResource('jarvis-plan', 'aws:backup:BackupPlan', {
        vaultName: 'jarvis-vault',
        scheduleExpression: 'cron(0 3 * * ? *)',
        retentionDays: 30,
      }),
    ]);
    backup.on(ListBackupPlansCommand).resolves({ BackupPlansList: [] });
    backup.on(CreateBackupPlanCommand).resolves({ BackupPlanId: 'plan-id-1', BackupPlanArn: PLAN_ARN });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(PLAN_ARN);
    const input = backup.commandCalls(CreateBackupPlanCommand)[0]?.args[0].input;
    expect(input?.BackupPlan?.BackupPlanName).toBe('jarvis-plan');
    const rule = input?.BackupPlan?.Rules?.[0];
    expect(rule?.RuleName).toBe('daily');
    expect(rule?.TargetBackupVaultName).toBe('jarvis-vault');
    expect(rule?.ScheduleExpression).toBe('cron(0 3 * * ? *)');
    expect(rule?.Lifecycle?.DeleteAfterDays).toBe(30);
    expect(input?.BackupPlanTags?.['iap:managed']).toBe('true');
    expect(input?.BackupPlanTags?.['iap:resourceId']).toBe('jarvis-plan.aws:backup:BackupPlan');
  });

  it('defaults apply when only vaultName is given: daily 05:00 cron, 7-day retention', async () => {
    const plan = providerPlan([
      planResource('jarvis-plan', 'aws:backup:BackupPlan', { vaultName: 'jarvis-vault' }),
    ]);
    backup.on(ListBackupPlansCommand).resolves({ BackupPlansList: [] });
    backup.on(CreateBackupPlanCommand).resolves({ BackupPlanId: 'plan-id-1', BackupPlanArn: PLAN_ARN });

    await executor().apply(plan, { apply: true });

    const rule = backup.commandCalls(CreateBackupPlanCommand)[0]?.args[0].input?.BackupPlan?.Rules?.[0];
    expect(rule?.ScheduleExpression).toBe('cron(0 5 * * ? *)');
    expect(rule?.Lifecycle?.DeleteAfterDays).toBe(7);
  });

  it('missing vaultName fails closed — recorded error, no create call', async () => {
    const plan = providerPlan([planResource('jarvis-plan', 'aws:backup:BackupPlan')]);
    backup.on(ListBackupPlansCommand).resolves({ BackupPlansList: [] });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('vaultName');
    expect(report.errors).toHaveLength(1);
    expect(backup.commandCalls(CreateBackupPlanCommand)).toHaveLength(0);
  });

  it('schedule/retention drift → UpdateBackupPlan in place (never delete+create)', async () => {
    const plan = providerPlan([
      planResource('jarvis-plan', 'aws:backup:BackupPlan', {
        vaultName: 'jarvis-vault',
        scheduleExpression: 'cron(0 3 * * ? *)',
        retentionDays: 30,
      }),
    ]);
    backup.on(ListBackupPlansCommand).resolves({ BackupPlansList: [listedPlan] });
    backup.on(GetBackupPlanCommand).resolves({
      BackupPlanId: 'plan-id-1',
      BackupPlanArn: PLAN_ARN,
      BackupPlan: {
        BackupPlanName: 'jarvis-plan',
        Rules: [
          {
            RuleName: 'daily',
            TargetBackupVaultName: 'jarvis-vault',
            ScheduleExpression: 'cron(0 5 * * ? *)',
            Lifecycle: { DeleteAfterDays: 7 },
          },
        ],
      },
    });
    backup.on(ListTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });
    backup.on(UpdateBackupPlanCommand).resolves({ BackupPlanId: 'plan-id-1' });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = backup.commandCalls(UpdateBackupPlanCommand)[0]?.args[0].input;
    expect(input?.BackupPlanId).toBe('plan-id-1'); // the name-resolved generated id
    const rule = input?.BackupPlan?.Rules?.[0];
    expect(rule?.ScheduleExpression).toBe('cron(0 3 * * ? *)');
    expect(rule?.Lifecycle?.DeleteAfterDays).toBe(30);
    // Mutable-only projection: rule drift NEVER cascades into replacement.
    expect(backup.commandCalls(DeleteBackupPlanCommand)).toHaveLength(0);
    expect(backup.commandCalls(CreateBackupPlanCommand)).toHaveLength(0);
  });

  it('destroy → DeleteBackupPlan with the id resolved by name across pages', async () => {
    const plan = providerPlan([
      planResource('jarvis-plan', 'aws:backup:BackupPlan', { vaultName: 'jarvis-vault' }),
    ]);
    // Page 1 has no match; the name lives on page 2 — resolution must paginate.
    backup
      .on(ListBackupPlansCommand)
      .resolvesOnce({
        NextToken: 'page-2',
        BackupPlansList: [{ BackupPlanId: 'other-id', BackupPlanName: 'other-plan' }],
      })
      .resolves({ BackupPlansList: [listedPlan] });
    backup.on(GetBackupPlanCommand).resolves({
      BackupPlanId: 'plan-id-1',
      BackupPlanArn: PLAN_ARN,
      BackupPlan: {
        BackupPlanName: 'jarvis-plan',
        Rules: [
          {
            RuleName: 'daily',
            TargetBackupVaultName: 'jarvis-vault',
            ScheduleExpression: 'cron(0 5 * * ? *)',
            Lifecycle: { DeleteAfterDays: 7 },
          },
        ],
      },
    });
    backup.on(ListTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });
    backup.on(DeleteBackupPlanCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(backup.commandCalls(DeleteBackupPlanCommand)[0]?.args[0].input?.BackupPlanId).toBe(
      'plan-id-1',
    );
    // Read walked page 1 (NextToken) then page 2; delete re-resolved by name.
    const listCalls = backup.commandCalls(ListBackupPlansCommand);
    expect(listCalls.length).toBeGreaterThanOrEqual(3);
    expect(listCalls[1]?.args[0].input?.NextToken).toBe('page-2');
  });
});
