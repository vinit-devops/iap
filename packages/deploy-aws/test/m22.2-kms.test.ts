/**
 * M22.2 `aws:kms:Key` handler, mock-tested. The handler owns an ALIAS
 * (`alias/<resourceId>`) as the stable identity because KMS key ids are
 * generated. PendingDeletion keys read as absent (never resurrected via
 * CancelKeyDeletion); delete is DeleteAlias + ScheduleKeyDeletion(7 days) —
 * the AWS-mandated minimum window.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CancelKeyDeletionCommand,
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  EnableKeyCommand,
  KMSClient,
  ListResourceTagsCommand,
  ScheduleKeyDeletionCommand,
  UpdateKeyDescriptionCommand,
} from '@aws-sdk/client-kms';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const kms = mockClient(KMSClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => kms.reset());

const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const KEY_ARN = `arn:aws:kms:eu-central-1:000000000000:key/${KEY_ID}`;

const plan = (attrs: Record<string, string | boolean> = {}) =>
  providerPlan([planResource('orders-data', 'aws:kms:Key', attrs)]);

/** A live, enabled, converged symmetric key behind alias/orders-data. */
function mockLiveKey(overrides: Record<string, unknown> = {}): void {
  kms.on(DescribeKeyCommand).resolves({
    KeyMetadata: {
      KeyId: KEY_ID,
      Arn: KEY_ARN,
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      KeyState: 'Enabled',
      Enabled: true,
      Description: '',
      ...overrides,
    },
  });
  kms.on(ListResourceTagsCommand).resolves({
    Tags: [{ TagKey: 'iap:managed', TagValue: 'true' }],
  });
}

describe('aws:kms:Key — create', () => {
  it('absent (alias NotFound) → CreateKey with mandatory iap tags, then CreateAlias', async () => {
    kms.on(DescribeKeyCommand).rejects(serviceError('NotFoundException'));
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: KEY_ID, Arn: KEY_ARN } });
    kms.on(CreateAliasCommand).resolves({});

    const report = await executor().apply(plan({ description: 'orders at rest' }), {
      apply: true,
    });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(KEY_ARN);
    expect(report.errors).toHaveLength(0);

    const create = kms.commandCalls(CreateKeyCommand)[0]?.args[0].input;
    expect(create?.KeySpec).toBe('SYMMETRIC_DEFAULT'); // default
    expect(create?.KeyUsage).toBe('ENCRYPT_DECRYPT'); // default
    expect(create?.Description).toBe('orders at rest');
    // Mandatory provenance tags ride creation (KMS TagKey/TagValue shape).
    const tagKeys = (create?.Tags ?? []).map((t) => `${t.TagKey}=${t.TagValue}`);
    expect(tagKeys).toContain('iap:managed=true');
    expect(tagKeys.some((t) => t.startsWith('iap:planId='))).toBe(true);
    expect(tagKeys.some((t) => t.startsWith('iap:resourceId='))).toBe(true);

    const alias = kms.commandCalls(CreateAliasCommand)[0]?.args[0].input;
    expect(alias?.AliasName).toBe('alias/orders-data'); // alias IS the identity
    expect(alias?.TargetKeyId).toBe(KEY_ID);
    // A clean create never touches an alias or a pending deletion.
    expect(kms.commandCalls(DeleteAliasCommand)).toHaveLength(0);
    expect(kms.commandCalls(CancelKeyDeletionCommand)).toHaveLength(0);
  });
});

describe('aws:kms:Key — converged and drifted', () => {
  it('present + converged → no-op', async () => {
    mockLiveKey({ Description: 'orders at rest' });

    const report = await executor().plan(plan({ description: 'orders at rest' }));

    expect(report.items[0]?.action).toBe('no-op');
    // Read resolves through the alias, tags through the key id.
    expect(kms.commandCalls(DescribeKeyCommand)[0]?.args[0].input?.KeyId).toBe(
      'alias/orders-data',
    );
    expect(kms.commandCalls(ListResourceTagsCommand)[0]?.args[0].input?.KeyId).toBe(KEY_ID);
  });

  it('description drift → UpdateKeyDescription in place (no delete, no replace)', async () => {
    mockLiveKey({ Description: 'stale words' });
    kms.on(UpdateKeyDescriptionCommand).resolves({});

    const planned = await executor().plan(plan({ description: 'orders at rest' }));
    expect(planned.items[0]?.action).toBe('update');

    const report = await executor().apply(plan({ description: 'orders at rest' }), {
      apply: true,
    });
    expect(report.items[0]?.applied).toBe(true);

    const update = kms.commandCalls(UpdateKeyDescriptionCommand)[0]?.args[0].input;
    expect(update?.KeyId).toBe(KEY_ARN); // mutations use the ARN, never the alias
    expect(update?.Description).toBe('orders at rest');
    expect(kms.commandCalls(ScheduleKeyDeletionCommand)).toHaveLength(0);
    expect(kms.commandCalls(DeleteAliasCommand)).toHaveLength(0);
    // enabled converged → neither toggle fires
    expect(kms.commandCalls(EnableKeyCommand)).toHaveLength(0);
    expect(kms.commandCalls(DisableKeyCommand)).toHaveLength(0);
  });

  it('enabled drift (disabled out-of-band) → EnableKey, update-in-place', async () => {
    mockLiveKey({ Enabled: false, KeyState: 'Disabled' });
    kms.on(EnableKeyCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    expect(kms.commandCalls(EnableKeyCommand)[0]?.args[0].input?.KeyId).toBe(KEY_ARN);
  });
});

describe('aws:kms:Key — keySpec drift is IMMUTABLE (ADR-0006)', () => {
  const desired = plan({ keySpec: 'SYMMETRIC_DEFAULT' });

  it('classifies replace, never update', async () => {
    mockLiveKey({ KeySpec: 'RSA_2048' });
    const report = await executor().plan(desired);
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
  });

  it('without the replacement gate: refused — nothing destroyed, nothing created', async () => {
    mockLiveKey({ KeySpec: 'RSA_2048' });

    const refused = await executor().apply(desired, { apply: true });

    expect(refused.items[0]?.action).toBe('replace');
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.errors[0]).toContain('refusing to replace');
    expect(kms.commandCalls(ScheduleKeyDeletionCommand)).toHaveLength(0);
    expect(kms.commandCalls(DeleteAliasCommand)).toHaveLength(0);
    expect(kms.commandCalls(CreateKeyCommand)).toHaveLength(0);
  });

  it('gated replace executes DeleteAlias+ScheduleKeyDeletion then CreateKey+CreateAlias', async () => {
    kms
      .on(DescribeKeyCommand)
      // read: live key with the wrong spec
      .resolvesOnce({
        KeyMetadata: {
          KeyId: KEY_ID,
          Arn: KEY_ARN,
          KeySpec: 'RSA_2048',
          KeyUsage: 'ENCRYPT_DECRYPT',
          KeyState: 'Enabled',
          Enabled: true,
          Description: '',
        },
      })
      // create's stale-alias probe: delete already removed the alias
      .rejects(serviceError('NotFoundException'));
    kms.on(ListResourceTagsCommand).resolves({
      Tags: [{ TagKey: 'iap:managed', TagValue: 'true' }],
    });
    kms.on(DeleteAliasCommand).resolves({});
    kms.on(ScheduleKeyDeletionCommand).resolves({});
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'new-key-id', Arn: 'arn:kms:key/new' } });
    kms.on(CreateAliasCommand).resolves({});

    const report = await executor().apply(desired, { apply: true, replace: true });
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);

    // Old identity torn down first…
    expect(kms.commandCalls(DeleteAliasCommand)[0]?.args[0].input?.AliasName).toBe(
      'alias/orders-data',
    );
    const schedule = kms.commandCalls(ScheduleKeyDeletionCommand)[0]?.args[0].input;
    expect(schedule?.KeyId).toBe(KEY_ARN);
    expect(schedule?.PendingWindowInDays).toBe(7);
    // …then a fresh key takes over the alias.
    expect(kms.commandCalls(CreateKeyCommand)[0]?.args[0].input?.KeySpec).toBe(
      'SYMMETRIC_DEFAULT',
    );
    expect(kms.commandCalls(CreateAliasCommand)[0]?.args[0].input?.TargetKeyId).toBe(
      'new-key-id',
    );
  });
});

describe('aws:kms:Key — PendingDeletion semantics', () => {
  it('a PendingDeletion key reads as absent; create drops the stale alias, NEVER CancelKeyDeletion', async () => {
    kms.on(DescribeKeyCommand).resolves({
      KeyMetadata: {
        KeyId: KEY_ID,
        Arn: KEY_ARN,
        KeySpec: 'SYMMETRIC_DEFAULT',
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeyState: 'PendingDeletion',
        Enabled: false,
      },
    });
    kms.on(DeleteAliasCommand).resolves({});
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'fresh-key', Arn: 'arn:kms:key/fresh' } });
    kms.on(CreateAliasCommand).resolves({});

    const planned = await executor().plan(plan());
    expect(planned.items[0]?.action).toBe('create'); // scheduled-for-deletion == absent
    expect(kms.commandCalls(ListResourceTagsCommand)).toHaveLength(0); // not even tag-read

    const report = await executor().apply(plan(), { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);

    // The stale alias (still pointing at the dying key) is removed first,
    // then a FRESH key takes the identity.
    const order = kms
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n !== 'DescribeKeyCommand');
    expect(order).toEqual(['DeleteAliasCommand', 'CreateKeyCommand', 'CreateAliasCommand']);
    expect(kms.commandCalls(DeleteAliasCommand)[0]?.args[0].input?.AliasName).toBe(
      'alias/orders-data',
    );
    expect(kms.commandCalls(CreateAliasCommand)[0]?.args[0].input?.TargetKeyId).toBe('fresh-key');
    // The dying key is left to die — resurrection is forbidden.
    expect(kms.commandCalls(CancelKeyDeletionCommand)).toHaveLength(0);
  });
});

describe('aws:kms:Key — destroy', () => {
  it('managed → DeleteAlias then ScheduleKeyDeletion with the 7-day AWS minimum', async () => {
    mockLiveKey();
    kms.on(DeleteAliasCommand).resolves({});
    kms.on(ScheduleKeyDeletionCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(kms.commandCalls(DeleteAliasCommand)[0]?.args[0].input?.AliasName).toBe(
      'alias/orders-data',
    );
    const schedule = kms.commandCalls(ScheduleKeyDeletionCommand)[0]?.args[0].input;
    expect(schedule?.KeyId).toBe(KEY_ARN);
    expect(schedule?.PendingWindowInDays).toBe(7);
    // Alias resolution happened BEFORE the alias went away (ordering).
    const order = kms.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('DeleteAliasCommand')).toBeLessThan(
      order.indexOf('ScheduleKeyDeletionCommand'),
    );
  });

  it('refuses to destroy a key NOT tagged iap:managed', async () => {
    mockLiveKey();
    kms.on(ListResourceTagsCommand).resolves({ Tags: [{ TagKey: 'team', TagValue: 'core' }] });

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(kms.commandCalls(DeleteAliasCommand)).toHaveLength(0);
    expect(kms.commandCalls(ScheduleKeyDeletionCommand)).toHaveLength(0);
  });
});
