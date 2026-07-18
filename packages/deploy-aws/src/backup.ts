/**
 * `aws:backup:BackupVault` + `aws:backup:BackupPlan` handlers
 * (@aws-sdk/client-backup) — backup posture (M22.2).
 *
 * BackupVault — the name IS the identity; nothing else is configurable in
 * scope, so the projection is empty and a present vault always reads
 * converged (update exists only for tag reconciliation).
 *   read   → DescribeBackupVault + ListTags (vault ARN)
 *   create → CreateBackupVault (BackupVaultTags)
 *   update → TagResource (tags only)
 *   delete → DeleteBackupVault — FAILS when the vault still holds recovery
 *            points; that error must surface in the report (fail closed),
 *            never be swallowed as a successful teardown.
 *
 * BackupPlan — plans have GENERATED ids, so identity is resolved by NAME:
 * ListBackupPlans is paginated until `BackupPlanName === resourceIdOf(...)`
 * and the resolved BackupPlanId stays internal to the handler.
 *   read   → ListBackupPlans (paginate) → GetBackupPlan + ListTags (plan ARN)
 *   create → CreateBackupPlan (single 'daily' rule + BackupPlanTags)
 *   update → UpdateBackupPlan (new plan version — rule drift), TagResource
 *   delete → DeleteBackupPlan (by the name-resolved id)
 *
 * All plan projection keys (vaultName / scheduleExpression / retentionDays)
 * are MUTABLE via UpdateBackupPlan — no immutable keys, so replacement is
 * justified-N/A for both Backup target types (ADR-0006).
 */

import {
  CreateBackupPlanCommand,
  CreateBackupVaultCommand,
  DeleteBackupPlanCommand,
  DeleteBackupVaultCommand,
  DescribeBackupVaultCommand,
  GetBackupPlanCommand,
  ListBackupPlansCommand,
  ListTagsCommand,
  TagResourceCommand,
  UpdateBackupPlanCommand,
} from '@aws-sdk/client-backup';
import type { BackupClient, BackupPlanInput } from '@aws-sdk/client-backup';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

/**
 * A missing vault surfaces as `ResourceNotFoundException` (the Backup
 * service's actual error name); some principals see `AccessDeniedException`
 * for a vault that does not exist instead — both read as absent.
 */
const VAULT_NOT_FOUND = ['ResourceNotFoundException', 'AccessDeniedException'] as const;

export class BackupVaultHandler implements TargetHandler {
  static readonly targetType = 'aws:backup:BackupVault' as const;
  readonly targetType = BackupVaultHandler.targetType;

  constructor(private readonly client: BackupClient) {}

  /**
   * Empty beyond identity: the vault name is the only managed attribute and
   * it IS the resource id, so drift can never classify as update/replace.
   */
  desiredProjection(_resource: PlanResource): Record<string, string> {
    return {};
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const BackupVaultName = resourceIdOf(resource);
    let arn: string | undefined;
    try {
      const found = await this.client.send(new DescribeBackupVaultCommand({ BackupVaultName }));
      arn = found.BackupVaultArn;
    } catch (err) {
      if (nameMatches(err, VAULT_NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.client.send(new ListTagsCommand({ ResourceArn: arn }));
      tags = tagResult.Tags ?? {};
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
    const BackupVaultName = resourceIdOf(resource);
    const created = await this.client.send(
      new CreateBackupVaultCommand({ BackupVaultName, BackupVaultTags: tags }),
    );
    return created.BackupVaultArn ?? `backup:vault/${BackupVaultName}`;
  }

  /** Projection is identity-only, so this only ever reconciles tags. */
  async update(_resource: PlanResource, current: ResourceState): Promise<void> {
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagResourceCommand({ ResourceArn: current.identifier, Tags: current.tags }),
      );
    }
  }

  /**
   * DeleteBackupVault FAILS while recovery points remain — deliberately not
   * caught here so the executor records it as a per-object error (fail
   * closed). A live run that never executed a backup job leaves the vault
   * empty, so its teardown succeeds.
   */
  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(
      new DeleteBackupVaultCommand({ BackupVaultName: resourceIdOf(resource) }),
    );
  }
}

const RULE_NAME = 'daily';
const DEFAULT_SCHEDULE = 'cron(0 5 * * ? *)';
const DEFAULT_RETENTION_DAYS = '7';

export class BackupPlanHandler implements TargetHandler {
  static readonly targetType = 'aws:backup:BackupPlan' as const;
  readonly targetType = BackupPlanHandler.targetType;
  // All keys reconcile in place via UpdateBackupPlan — replacement is N/A.

  constructor(private readonly client: BackupClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      vaultName: scalarStr(a['vaultName']),
      scheduleExpression: scalarStr(a['scheduleExpression']) || DEFAULT_SCHEDULE,
      retentionDays: scalarStr(a['retentionDays']) || DEFAULT_RETENTION_DAYS,
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const resolved = await this.resolveByName(name);
    if (resolved === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const found = await this.client.send(
      new GetBackupPlanCommand({ BackupPlanId: resolved.id }),
    );
    const rule = found.BackupPlan?.Rules?.[0];
    const arn = resolved.arn ?? found.BackupPlanArn;

    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.client.send(new ListTagsCommand({ ResourceArn: arn }));
      tags = tagResult.Tags ?? {};
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        vaultName: rule?.TargetBackupVaultName ?? '',
        scheduleExpression: rule?.ScheduleExpression ?? '',
        retentionDays:
          rule?.Lifecycle?.DeleteAfterDays === undefined
            ? ''
            : String(rule.Lifecycle.DeleteAfterDays),
      },
    };
    if (arn !== undefined) state.identifier = arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const created = await this.client.send(
      new CreateBackupPlanCommand({
        BackupPlan: this.planInput(resource),
        BackupPlanTags: tags,
      }),
    );
    return created.BackupPlanArn ?? created.BackupPlanId ?? `backup:plan/${name}`;
  }

  /** Rule drift (vault/schedule/retention) → a new plan version, in place. */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const resolved = await this.resolveByName(name);
    if (resolved === undefined) {
      throw new Error(`backup plan ${name} disappeared between read and update`);
    }
    await this.client.send(
      new UpdateBackupPlanCommand({
        BackupPlanId: resolved.id,
        BackupPlan: this.planInput(resource),
      }),
    );
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagResourceCommand({ ResourceArn: current.identifier, Tags: current.tags }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    const name = resourceIdOf(resource);
    const resolved = await this.resolveByName(name);
    if (resolved === undefined) {
      throw new Error(`backup plan ${name} not found by name — refusing blind delete`);
    }
    await this.client.send(new DeleteBackupPlanCommand({ BackupPlanId: resolved.id }));
  }

  /**
   * Name → generated-id resolution: paginate ListBackupPlans until the page
   * carrying `BackupPlanName === name`. The id never leaves the handler.
   */
  private async resolveByName(name: string): Promise<{ id: string; arn?: string } | undefined> {
    let NextToken: string | undefined;
    do {
      const page = await this.client.send(new ListBackupPlansCommand({ NextToken }));
      const match = (page.BackupPlansList ?? []).find((p) => p.BackupPlanName === name);
      if (match?.BackupPlanId !== undefined) {
        return match.BackupPlanArn !== undefined
          ? { id: match.BackupPlanId, arn: match.BackupPlanArn }
          : { id: match.BackupPlanId };
      }
      NextToken = page.NextToken;
    } while (NextToken !== undefined);
    return undefined;
  }

  /** Single-rule plan; the target vault is mandatory context — fail closed. */
  private planInput(resource: PlanResource): BackupPlanInput {
    const desired = this.desiredProjection(resource);
    const vaultName = desired['vaultName'];
    if (!vaultName) {
      throw new Error(
        `backup plan ${resourceIdOf(resource)} needs a vaultName attribute (target vault)`,
      );
    }
    return {
      BackupPlanName: resourceIdOf(resource),
      Rules: [
        {
          RuleName: RULE_NAME,
          TargetBackupVaultName: vaultName,
          ScheduleExpression: desired['scheduleExpression'] ?? DEFAULT_SCHEDULE,
          Lifecycle: { DeleteAfterDays: Number(desired['retentionDays'] ?? DEFAULT_RETENTION_DAYS) },
        },
      ],
    };
  }
}
