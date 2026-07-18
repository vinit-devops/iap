/**
 * M24.2 Cognito (Identity user-directory) handlers, mock-tested:
 * `aws:cognito-idp:UserPool` + `aws:cognito-idp:UserPoolClient`.
 *
 * Covers: pool create (password policy + mandatory tags + name→Id resolution),
 * converged no-op, mfa/password drift → UpdateUserPool, immutable
 * usernameAttributes drift → replace, deletion-protection disable-before-delete;
 * client create (userPoolId cross-ref + name→ClientId resolution, inherited
 * managed-ness), missing-userPoolId fail-closed, immutable generateSecret drift
 * → replace (secret never projected/logged), authFlow drift → UpdateUserPoolClient;
 * managed-only destroy refusal for each; and pool-before-client create /
 * client-before-pool destroy dependsOn ordering.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolClientCommand,
  DeleteUserPoolCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  ListTagsForResourceCommand,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
  TagResourceCommand,
  UpdateUserPoolClientCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const cognito = mockClient(CognitoIdentityProviderClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const POOL_ID = 'eu-central-1_aBcD1234';
const POOL_ARN = `arn:aws:cognito-idp:eu-central-1:000000000000:userpool/${POOL_ID}`;
const MANAGED_TAGS = { 'iap:managed': 'true' };

beforeEach(() => cognito.reset());

describe('aws:cognito-idp:UserPool', () => {
  const poolPlan = (attrs: Record<string, string> = {}) =>
    providerPlan([planResource('infraasprompt-users', 'aws:cognito-idp:UserPool', attrs)]);

  it('absent → CreateUserPool with password policy, defaults, and mandatory iap tags', async () => {
    cognito.on(ListUserPoolsCommand).resolves({ UserPools: [] });
    cognito.on(CreateUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Arn: POOL_ARN } });

    const report = await executor().apply(poolPlan({ passwordMinimumLength: '12' }), {
      apply: true,
    });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(POOL_ARN);
    const input = cognito.commandCalls(CreateUserPoolCommand)[0]?.args[0].input;
    expect(input?.PoolName).toBe('infraasprompt-users');
    expect(input?.Policies?.PasswordPolicy?.MinimumLength).toBe(12);
    expect(input?.Policies?.PasswordPolicy?.RequireUppercase).toBe(true);
    expect(input?.Policies?.PasswordPolicy?.RequireLowercase).toBe(true);
    expect(input?.Policies?.PasswordPolicy?.RequireNumbers).toBe(true);
    // autoVerifyEmail defaults on; mfa OFF; deletion-protection INACTIVE so teardown works.
    expect(input?.AutoVerifiedAttributes).toEqual(['email']);
    expect(input?.MfaConfiguration).toBe('OFF');
    expect(input?.DeletionProtection).toBe('INACTIVE');
    // usernameAttributes is opt-in (immutable) — never set implicitly.
    expect(input?.UsernameAttributes).toBeUndefined();
    expect(input?.UserPoolTags?.['iap:managed']).toBe('true');
    expect(input?.UserPoolTags?.['iap:resourceId']).toBe('infraasprompt-users.aws:cognito-idp:UserPool');
    expect(input?.UserPoolTags?.['iap:planId']).toBe('plan-hash-0001');
  });

  it('present + converged: no-op (name→Id resolved, live policy matches desired)', async () => {
    cognito.on(ListUserPoolsCommand).resolves({
      UserPools: [{ Id: POOL_ID, Name: 'infraasprompt-users' }],
    });
    cognito.on(DescribeUserPoolCommand).resolves({
      UserPool: {
        Id: POOL_ID,
        Name: 'infraasprompt-users',
        Arn: POOL_ARN,
        Policies: {
          PasswordPolicy: {
            MinimumLength: 8,
            RequireUppercase: true,
            RequireLowercase: true,
            RequireNumbers: true,
            RequireSymbols: false,
          },
        },
        MfaConfiguration: 'OFF',
        AutoVerifiedAttributes: ['email'],
        DeletionProtection: 'INACTIVE',
      },
    });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });

    const report = await executor().plan(poolPlan());
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('mfa + password drift → UpdateUserPool in place (never delete)', async () => {
    cognito.on(ListUserPoolsCommand).resolves({
      UserPools: [{ Id: POOL_ID, Name: 'infraasprompt-users' }],
    });
    cognito.on(DescribeUserPoolCommand).resolves({
      UserPool: {
        Id: POOL_ID,
        Name: 'infraasprompt-users',
        Arn: POOL_ARN,
        Policies: {
          PasswordPolicy: {
            MinimumLength: 8,
            RequireUppercase: true,
            RequireLowercase: true,
            RequireNumbers: true,
            RequireSymbols: false,
          },
        },
        MfaConfiguration: 'OFF',
        AutoVerifiedAttributes: ['email'],
        DeletionProtection: 'INACTIVE',
      },
    });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    cognito.on(UpdateUserPoolCommand).resolves({});
    cognito.on(TagResourceCommand).resolves({});

    const report = await executor().apply(
      poolPlan({ mfa: 'OPTIONAL', passwordMinimumLength: '16' }),
      { apply: true },
    );

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = cognito.commandCalls(UpdateUserPoolCommand)[0]?.args[0].input;
    expect(input?.UserPoolId).toBe(POOL_ID);
    expect(input?.MfaConfiguration).toBe('OPTIONAL');
    expect(input?.Policies?.PasswordPolicy?.MinimumLength).toBe(16);
    // Full-config update re-sends tags so they are never cleared.
    expect(input?.UserPoolTags?.['iap:managed']).toBe('true');
    expect(cognito.commandCalls(DeleteUserPoolCommand)).toHaveLength(0);
    expect(cognito.commandCalls(TagResourceCommand)).toHaveLength(1);
  });

  it('usernameAttributes drift is IMMUTABLE → replace, behind the gate', async () => {
    // Live pool has NO username alias; desired opts in → immutable drift.
    cognito.on(ListUserPoolsCommand).resolves({
      UserPools: [{ Id: POOL_ID, Name: 'infraasprompt-users' }],
    });
    cognito.on(DescribeUserPoolCommand).resolves({
      UserPool: {
        Id: POOL_ID,
        Name: 'infraasprompt-users',
        Arn: POOL_ARN,
        Policies: {
          PasswordPolicy: {
            MinimumLength: 8,
            RequireUppercase: true,
            RequireLowercase: true,
            RequireNumbers: true,
            RequireSymbols: false,
          },
        },
        MfaConfiguration: 'OFF',
        AutoVerifiedAttributes: ['email'],
        UsernameAttributes: [],
        DeletionProtection: 'INACTIVE',
      },
    });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });

    const planned = await executor().plan(poolPlan({ usernameEmail: 'true' }));
    expect(planned.items[0]?.action).toBe('replace');
    expect(planned.items[0]?.reason).toContain('delete+create');

    // Gate CLOSED → refuse.
    const refused = await executor().apply(poolPlan({ usernameEmail: 'true' }), { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(cognito.commandCalls(DeleteUserPoolCommand)).toHaveLength(0);
    expect(cognito.commandCalls(CreateUserPoolCommand)).toHaveLength(0);

    // Gate OPEN → delete then create with the new sign-in alias.
    cognito.on(DeleteUserPoolCommand).resolves({});
    cognito.on(CreateUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Arn: POOL_ARN } });
    const replaced = await executor().apply(poolPlan({ usernameEmail: 'true' }), {
      apply: true,
      replace: true,
    });
    expect(replaced.items[0]?.applied).toBe(true);
    expect(replaced.errors).toHaveLength(0);
    expect(cognito.commandCalls(DeleteUserPoolCommand)[0]?.args[0].input?.UserPoolId).toBe(POOL_ID);
    expect(cognito.commandCalls(CreateUserPoolCommand)[0]?.args[0].input?.UsernameAttributes).toEqual([
      'email',
    ]);
  });

  it('destroy with DeletionProtection ACTIVE → UpdateUserPool INACTIVE before DeleteUserPool', async () => {
    cognito.on(ListUserPoolsCommand).resolves({
      UserPools: [{ Id: POOL_ID, Name: 'infraasprompt-users' }],
    });
    cognito.on(DescribeUserPoolCommand).resolves({
      UserPool: { Id: POOL_ID, Name: 'infraasprompt-users', Arn: POOL_ARN, DeletionProtection: 'ACTIVE' },
    });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    cognito.on(UpdateUserPoolCommand).resolves({});
    cognito.on(DeleteUserPoolCommand).resolves({});

    const report = await executor().apply(poolPlan({ deletionProtection: 'ACTIVE' }), {
      apply: true,
      destroy: true,
    });
    expect(report.items[0]?.applied).toBe(true);
    const disable = cognito.commandCalls(UpdateUserPoolCommand)[0]?.args[0].input;
    expect(disable?.DeletionProtection).toBe('INACTIVE');
    expect(cognito.commandCalls(DeleteUserPoolCommand)[0]?.args[0].input?.UserPoolId).toBe(POOL_ID);
    // Disable must precede the delete.
    const calls = cognito.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('UpdateUserPoolCommand')).toBeLessThan(
      calls.indexOf('DeleteUserPoolCommand'),
    );
  });

  it('destroy refuses an unmanaged pool (managed-only gate)', async () => {
    cognito.on(ListUserPoolsCommand).resolves({
      UserPools: [{ Id: POOL_ID, Name: 'infraasprompt-users' }],
    });
    cognito.on(DescribeUserPoolCommand).resolves({
      UserPool: { Id: POOL_ID, Name: 'infraasprompt-users', Arn: POOL_ARN },
    });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: {} });

    const report = await executor().apply(poolPlan(), { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(cognito.commandCalls(DeleteUserPoolCommand)).toHaveLength(0);
  });
});

describe('aws:cognito-idp:UserPoolClient', () => {
  const CLIENT_ID = 'abcd1234efgh5678ijkl';
  const clientPlan = (attrs: Record<string, string> = {}) =>
    providerPlan([
      planResource('infraasprompt-web', 'aws:cognito-idp:UserPoolClient', {
        userPoolId: POOL_ID,
        ...attrs,
      }),
    ]);

  it('absent → CreateUserPoolClient in the parent pool; identifier is the ClientId', async () => {
    cognito.on(ListUserPoolClientsCommand).resolves({ UserPoolClients: [] });
    cognito.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: CLIENT_ID, ClientName: 'infraasprompt-web' },
    });

    const report = await executor().apply(clientPlan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(CLIENT_ID);
    const input = cognito.commandCalls(CreateUserPoolClientCommand)[0]?.args[0].input;
    expect(input?.UserPoolId).toBe(POOL_ID);
    expect(input?.ClientName).toBe('infraasprompt-web');
    expect(input?.GenerateSecret).toBe(false);
    // Sane default auth flows.
    expect(input?.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH');
    expect(input?.ExplicitAuthFlows).toContain('ALLOW_REFRESH_TOKEN_AUTH');
  });

  it('missing userPoolId fails closed — no describe issued', async () => {
    const orphan = providerPlan([planResource('infraasprompt-web', 'aws:cognito-idp:UserPoolClient')]);

    const report = await executor().apply(orphan, { apply: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('userPoolId');
    expect(cognito.commandCalls(ListUserPoolClientsCommand)).toHaveLength(0);
    expect(cognito.commandCalls(DescribeUserPoolClientCommand)).toHaveLength(0);
  });

  it('generateSecret drift is IMMUTABLE → replace; the secret never reaches projection or report', async () => {
    // Live client HAS a secret; desired keeps generateSecret false → immutable drift.
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [{ ClientId: CLIENT_ID, ClientName: 'infraasprompt-web' }],
    });
    cognito.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: {
        ClientId: CLIENT_ID,
        ClientName: 'infraasprompt-web',
        UserPoolId: POOL_ID,
        ClientSecret: 'super-secret-value-do-not-leak',
        ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'],
      },
    });
    // Inherited managed-ness: parent pool describe + tags.
    cognito.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Arn: POOL_ARN } });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });

    const planned = await executor().plan(clientPlan());
    expect(planned.items[0]?.action).toBe('replace');
    expect(planned.items[0]?.reason).toContain('delete+create');

    // The secret value must never surface anywhere in the plan report.
    const serialized = JSON.stringify(planned);
    expect(serialized).not.toContain('super-secret-value-do-not-leak');
  });

  it('authFlow drift → UpdateUserPoolClient in place (no delete)', async () => {
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [{ ClientId: CLIENT_ID, ClientName: 'infraasprompt-web' }],
    });
    cognito.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: {
        ClientId: CLIENT_ID,
        ClientName: 'infraasprompt-web',
        UserPoolId: POOL_ID,
        ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'],
      },
    });
    cognito.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Arn: POOL_ARN } });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    cognito.on(UpdateUserPoolClientCommand).resolves({});

    const report = await executor().apply(
      clientPlan({ authFlows: 'ALLOW_USER_PASSWORD_AUTH,ALLOW_REFRESH_TOKEN_AUTH' }),
      { apply: true },
    );

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = cognito.commandCalls(UpdateUserPoolClientCommand)[0]?.args[0].input;
    expect(input?.UserPoolId).toBe(POOL_ID);
    expect(input?.ClientId).toBe(CLIENT_ID);
    expect(input?.ExplicitAuthFlows).toContain('ALLOW_USER_PASSWORD_AUTH');
    expect(cognito.commandCalls(DeleteUserPoolClientCommand)).toHaveLength(0);
  });

  it('destroy → DeleteUserPoolClient when the pool is managed; refuses when unmanaged', async () => {
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [{ ClientId: CLIENT_ID, ClientName: 'infraasprompt-web' }],
    });
    cognito.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: CLIENT_ID, ClientName: 'infraasprompt-web', UserPoolId: POOL_ID },
    });
    cognito.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Arn: POOL_ARN } });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    cognito.on(DeleteUserPoolClientCommand).resolves({});

    const report = await executor().apply(clientPlan(), { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = cognito.commandCalls(DeleteUserPoolClientCommand)[0]?.args[0].input;
    expect(input?.UserPoolId).toBe(POOL_ID);
    expect(input?.ClientId).toBe(CLIENT_ID);

    // Parent pool NOT managed → the client destroy is refused (inherited gate).
    cognito.reset();
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [{ ClientId: CLIENT_ID, ClientName: 'infraasprompt-web' }],
    });
    cognito.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: CLIENT_ID, ClientName: 'infraasprompt-web', UserPoolId: POOL_ID },
    });
    cognito.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Arn: POOL_ARN } });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: {} });

    const refused = await executor().apply(clientPlan(), { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('managed-only destroy');
    expect(cognito.commandCalls(DeleteUserPoolClientCommand)).toHaveLength(0);
  });

  it('parent pool gone → client reads absent (ResourceNotFoundException on the pool)', async () => {
    cognito.on(ListUserPoolClientsCommand).rejects(serviceError('ResourceNotFoundException', 400));

    const report = await executor().plan(clientPlan());
    expect(report.items[0]?.action).toBe('create');
  });
});

describe('Cognito dependsOn ordering (pool before client / client before pool destroy)', () => {
  const CLIENT_ID = 'abcd1234efgh5678ijkl';

  /** pool + client where alphabetical order alone would create the client first. */
  function poolAndClient() {
    const pool = planResource('a-pool', 'aws:cognito-idp:UserPool', {});
    // 'a-client' sorts BEFORE 'a-pool' — only dependsOn orders it correctly.
    const client = planResource('a-client', 'aws:cognito-idp:UserPoolClient', {
      userPoolId: POOL_ID,
    });
    client.dependsOn = [pool.logicalId];
    return { pool, client };
  }

  it('create: the client runs AFTER the pool despite sorting first', async () => {
    const { pool, client } = poolAndClient();
    cognito.on(ListUserPoolsCommand).resolves({ UserPools: [] });
    cognito.on(ListUserPoolClientsCommand).resolves({ UserPoolClients: [] });
    cognito.on(CreateUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Arn: POOL_ARN } });
    cognito.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: CLIENT_ID, ClientName: 'a-client' },
    });

    const report = await executor().apply(providerPlan([client, pool]), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([pool.logicalId, client.logicalId]);
    const calls = cognito.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('CreateUserPoolCommand')).toBeLessThan(
      calls.indexOf('CreateUserPoolClientCommand'),
    );
  });

  it('destroy: reverses topology — client deleted BEFORE the pool', async () => {
    const { pool, client } = poolAndClient();
    cognito.on(ListUserPoolsCommand).resolves({ UserPools: [{ Id: POOL_ID, Name: 'a-pool' }] });
    cognito.on(DescribeUserPoolCommand).resolves({
      UserPool: { Id: POOL_ID, Name: 'a-pool', Arn: POOL_ARN },
    });
    cognito.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [{ ClientId: CLIENT_ID, ClientName: 'a-client' }],
    });
    cognito.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: CLIENT_ID, ClientName: 'a-client', UserPoolId: POOL_ID },
    });
    cognito.on(DeleteUserPoolClientCommand).resolves({});
    cognito.on(DeleteUserPoolCommand).resolves({});

    const report = await executor().apply(providerPlan([client, pool]), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([client.logicalId, pool.logicalId]);
    const calls = cognito.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('DeleteUserPoolClientCommand')).toBeLessThan(
      calls.indexOf('DeleteUserPoolCommand'),
    );
  });
});
