/**
 * M24.2 — Cognito (Identity user-directory) handlers
 * (@aws-sdk/client-cognito-identity-provider).
 *
 * CognitoUserPoolHandler (`aws:cognito-idp:UserPool`):
 *   Identity — user pools have GENERATED ids (`<region>_XXXX`), so identity is
 *   resolved by NAME: ListUserPools is paginated (MaxResults 60) until
 *   `Name === resourceIdOf(...)` and the resolved pool Id stays internal to the
 *   handler (backup.ts name→generated-id idiom).
 *     read   → ListUserPools (paginate) → DescribeUserPool + ListTagsForResource
 *              (pool ARN); absent when no name match.
 *     create → CreateUserPool (PoolName, Policies.PasswordPolicy with sane
 *              defaults, AutoVerifiedAttributes, MfaConfiguration, optional
 *              UsernameAttributes, DeletionProtection INACTIVE by default so
 *              teardown works, UserPoolTags).
 *     update → DescribeUserPool then re-send the FULL config to UpdateUserPool
 *              (UpdateUserPool resets omitted settings) with the mutable fields
 *              taken from desired; tag reconcile via TagResource.
 *     delete → when DeletionProtection is ACTIVE, UpdateUserPool it to INACTIVE
 *              first (fail-closed), then DeleteUserPool (pools delete
 *              synchronously).
 *   Replacement — usernameAttributes is IMMUTABLE (Cognito cannot change the
 *   sign-in alias after create), so drift on it classifies as replace
 *   (gated delete+create, ADR-0006). mfaConfiguration / passwordPolicy /
 *   autoVerifiedAttributes / deletionProtection are all mutable in place.
 *   Outputs — identifier is the pool ARN; the provider endpoint is
 *   `cognito-idp.<region>.amazonaws.com/<poolId>`, derived from the pool Id
 *   (whose `<region>_` prefix carries the region) at the mapping layer.
 *
 * CognitoUserPoolClientHandler (`aws:cognito-idp:UserPoolClient`):
 *   Lives INSIDE a pool — `userPoolId` arrives as a desired attribute
 *   (cross-resource reference to the parent pool) and is IMMUTABLE: a client
 *   cannot move pools, so drift on it classifies as replace. Clients have a
 *   GENERATED ClientId, resolved by NAME via ListUserPoolClients(UserPoolId)
 *   matching `ClientName === resourceIdOf(...)`.
 *     read   → ListUserPoolClients → DescribeUserPoolClient; absent when no
 *              match or the parent pool is gone (ResourceNotFoundException).
 *     create → CreateUserPoolClient (GenerateSecret, ExplicitAuthFlows sane
 *              default, optional CallbackURLs / AllowedOAuthFlows).
 *     update → UpdateUserPoolClient (full config re-send).
 *     delete → DeleteUserPoolClient.
 *   The client SECRET is write-only and sensitive — it is NEVER read into the
 *   projection, the identifier, or any log. generateSecret is IMMUTABLE (a
 *   client secret cannot be toggled after create → replace). authFlows /
 *   callbackUrls are mutable in place.
 *   Clients are UNTAGGABLE — ownership is inherited from the parent pool's
 *   tags (route53 record-set idiom): a client is managed iff its pool carries
 *   `iap:managed=true`. Outputs — identifier is the ClientId (the id is not the
 *   secret).
 */

import {
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
import type {
  CognitoIdentityProviderClient,
  DeletionProtectionType,
  ExplicitAuthFlowsType,
  OAuthFlowType,
  PasswordPolicyType,
  UsernameAttributeType,
  UserPoolMfaType,
  VerifiedAttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;

/** ListUserPools caps MaxResults at 60. */
const LIST_POOLS_PAGE = 60;

/** Password-policy defaults when the plan does not pin them. */
const DEFAULT_PASSWORD_MINIMUM_LENGTH = '8';

/** Sign-in auth flows when the plan does not pin them (sorted, csv). */
const DEFAULT_AUTH_FLOWS = 'ALLOW_REFRESH_TOKEN_AUTH,ALLOW_USER_SRP_AUTH';

/** '' / 'true' / 'false' → normalized boolean string with a default. */
function boolStr(value: string, dflt: boolean): string {
  if (value === '') return dflt ? 'true' : 'false';
  return value === 'true' ? 'true' : 'false';
}

/** Sorted comma-join of a value list (order-insensitive drift comparison). */
function sortedCsv(values: readonly (string | undefined)[] | undefined): string {
  return [...(values ?? [])].filter((v): v is string => v !== undefined && v !== '').sort().join(',');
}

/** Parse a sorted-csv projection value back into a trimmed, non-empty list. */
function parseCsv(value: string): string[] {
  return value === '' ? [] : value.split(',').map((v) => v.trim()).filter((v) => v !== '');
}

export class CognitoUserPoolHandler implements TargetHandler {
  static readonly targetType = 'aws:cognito-idp:UserPool' as const;
  readonly targetType = CognitoUserPoolHandler.targetType;
  /** The sign-in alias cannot change after create → usernameAttributes replaces. */
  readonly immutableProjectionKeys = ['usernameAttributes'] as const;

  constructor(private readonly cognito: CognitoIdentityProviderClient) {}

  /** Auto-verified attributes: 'email' by default (autoVerifyEmail defaults on). */
  private autoVerified(resource: PlanResource): string {
    const raw = scalarStr(resource.desiredAttributes['autoVerifyEmail']);
    const on = raw === '' ? true : raw === 'true';
    return on ? 'email' : '';
  }

  /** Optional username sign-in alias: 'email' when usernameEmail is set. */
  private usernameAlias(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['usernameEmail']) === 'true' ? 'email' : '';
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      passwordMinimumLength:
        scalarStr(a['passwordMinimumLength']) || DEFAULT_PASSWORD_MINIMUM_LENGTH,
      passwordRequireUppercase: boolStr(scalarStr(a['passwordRequireUppercase']), true),
      passwordRequireLowercase: boolStr(scalarStr(a['passwordRequireLowercase']), true),
      passwordRequireNumbers: boolStr(scalarStr(a['passwordRequireNumbers']), true),
      passwordRequireSymbols: boolStr(scalarStr(a['passwordRequireSymbols']), false),
      mfaConfiguration: scalarStr(a['mfa']) || 'OFF',
      autoVerifiedAttributes: this.autoVerified(resource),
      usernameAttributes: this.usernameAlias(resource),
      deletionProtection: scalarStr(a['deletionProtection']) || 'INACTIVE',
    };
  }

  /** Desired password policy in the AWS shape (defaults applied). */
  private passwordPolicy(resource: PlanResource): PasswordPolicyType {
    const d = this.desiredProjection(resource);
    return {
      MinimumLength: Number(d['passwordMinimumLength']),
      RequireUppercase: d['passwordRequireUppercase'] === 'true',
      RequireLowercase: d['passwordRequireLowercase'] === 'true',
      RequireNumbers: d['passwordRequireNumbers'] === 'true',
      RequireSymbols: d['passwordRequireSymbols'] === 'true',
    };
  }

  private autoVerifiedList(resource: PlanResource): VerifiedAttributeType[] {
    return parseCsv(this.autoVerified(resource)) as VerifiedAttributeType[];
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const poolId = await this.resolveIdByName(name);
    if (poolId === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const found = await this.cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
    const pool = found.UserPool;
    if (pool === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (pool.Arn !== undefined) {
      const tagResult = await this.cognito.send(
        new ListTagsForResourceCommand({ ResourceArn: pool.Arn }),
      );
      tags = tagResult.Tags ?? {};
    }

    const pp = pool.Policies?.PasswordPolicy;
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        passwordMinimumLength:
          pp?.MinimumLength === undefined ? '' : String(pp.MinimumLength),
        passwordRequireUppercase: pp?.RequireUppercase ? 'true' : 'false',
        passwordRequireLowercase: pp?.RequireLowercase ? 'true' : 'false',
        passwordRequireNumbers: pp?.RequireNumbers ? 'true' : 'false',
        passwordRequireSymbols: pp?.RequireSymbols ? 'true' : 'false',
        mfaConfiguration: pool.MfaConfiguration ?? 'OFF',
        autoVerifiedAttributes: sortedCsv(pool.AutoVerifiedAttributes),
        usernameAttributes: sortedCsv(pool.UsernameAttributes),
        deletionProtection: pool.DeletionProtection ?? 'INACTIVE',
      },
    };
    if (pool.Arn !== undefined) state.identifier = pool.Arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const PoolName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const usernameAlias = parseCsv(d['usernameAttributes'] ?? '') as UsernameAttributeType[];
    const created = await this.cognito.send(
      new CreateUserPoolCommand({
        PoolName,
        Policies: { PasswordPolicy: this.passwordPolicy(resource) },
        AutoVerifiedAttributes: this.autoVerifiedList(resource),
        MfaConfiguration: d['mfaConfiguration'] as UserPoolMfaType,
        // Omitted entirely unless the plan opts in — the sign-in alias is
        // immutable, so we never set it implicitly.
        ...(usernameAlias.length > 0 ? { UsernameAttributes: usernameAlias } : {}),
        // Default INACTIVE so managed teardown is never blocked by deletion
        // protection the plan did not ask for.
        DeletionProtection: d['deletionProtection'] as DeletionProtectionType,
        UserPoolTags: tags,
      }),
    );
    return created.UserPool?.Arn ?? `cognito-idp:userpool/${PoolName}`;
  }

  /**
   * UpdateUserPool RESETS every setting it is not given, so the full managed
   * config is re-sent (with mutable fields from desired). usernameAttributes is
   * absent from UpdateUserPool entirely — it is immutable and reconciled via
   * replace, never here.
   */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const poolId = await this.requireId(name);
    const d = this.desiredProjection(resource);
    await this.cognito.send(
      new UpdateUserPoolCommand({
        UserPoolId: poolId,
        Policies: { PasswordPolicy: this.passwordPolicy(resource) },
        AutoVerifiedAttributes: this.autoVerifiedList(resource),
        MfaConfiguration: d['mfaConfiguration'] as UserPoolMfaType,
        DeletionProtection: d['deletionProtection'] as DeletionProtectionType,
        // Re-send tags so the full-config update never clears them.
        UserPoolTags: current.tags,
      }),
    );
    if (current.identifier !== undefined) {
      await this.cognito.send(
        new TagResourceCommand({ ResourceArn: current.identifier, Tags: current.tags }),
      );
    }
  }

  /**
   * Deletion protection is fail-closed: an ACTIVE pool is flipped to INACTIVE
   * (UpdateUserPool) before DeleteUserPool, otherwise Cognito rejects the
   * delete. Pools delete synchronously.
   */
  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const poolId = await this.requireId(name);
    if (current.projection['deletionProtection'] === 'ACTIVE') {
      await this.cognito.send(
        new UpdateUserPoolCommand({ UserPoolId: poolId, DeletionProtection: 'INACTIVE' }),
      );
    }
    await this.cognito.send(new DeleteUserPoolCommand({ UserPoolId: poolId }));
  }

  private async requireId(name: string): Promise<string> {
    const poolId = await this.resolveIdByName(name);
    if (poolId === undefined) {
      throw new Error(`Cognito user pool ${name} not found by name — refusing blind operation`);
    }
    return poolId;
  }

  /**
   * Name → generated-id resolution: paginate ListUserPools (MaxResults 60)
   * until `Name === name`. The pool Id never leaves the handler.
   */
  private async resolveIdByName(name: string): Promise<string | undefined> {
    let NextToken: string | undefined;
    do {
      const page = await this.cognito.send(
        new ListUserPoolsCommand({ MaxResults: LIST_POOLS_PAGE, NextToken }),
      );
      const match = (page.UserPools ?? []).find((p) => p.Name === name);
      if (match?.Id !== undefined) return match.Id;
      NextToken = page.NextToken;
    } while (NextToken !== undefined);
    return undefined;
  }
}

export class CognitoUserPoolClientHandler implements TargetHandler {
  static readonly targetType = 'aws:cognito-idp:UserPoolClient' as const;
  readonly targetType = CognitoUserPoolClientHandler.targetType;
  /**
   * userPoolId — a client cannot move pools; generateSecret — a client secret
   * cannot be toggled after create. Both drift as replace (ADR-0006).
   */
  readonly immutableProjectionKeys = ['userPoolId', 'generateSecret'] as const;

  constructor(private readonly cognito: CognitoIdentityProviderClient) {}

  /** The parent pool is a cross-resource reference — fail closed without it. */
  private userPoolId(resource: PlanResource): string {
    const id = scalarStr(resource.desiredAttributes['userPoolId']);
    if (id === '') {
      throw new Error(
        `aws:cognito-idp:UserPoolClient ${resource.logicalId} needs a userPoolId attribute ` +
          `(the parent aws:cognito-idp:UserPool id)`,
      );
    }
    return id;
  }

  private authFlows(resource: PlanResource): string {
    const raw = scalarStr(resource.desiredAttributes['authFlows']);
    return raw === '' ? DEFAULT_AUTH_FLOWS : sortedCsv(parseCsv(raw));
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      userPoolId: this.userPoolId(resource),
      generateSecret: boolStr(scalarStr(a['generateSecret']), false),
      authFlows: this.authFlows(resource),
      callbackUrls: sortedCsv(parseCsv(scalarStr(a['callbackUrls']))),
      allowedOAuthFlows: sortedCsv(parseCsv(scalarStr(a['allowedOAuthFlows']))),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const UserPoolId = this.userPoolId(resource);
    const name = resourceIdOf(resource);

    let clientId: string | undefined;
    try {
      clientId = await this.resolveClientIdByName(UserPoolId, name);
    } catch (err) {
      // A missing parent pool surfaces here — the client is absent and
      // converges via create once the sibling pool handler has created it.
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (clientId === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const found = await this.cognito.send(
      new DescribeUserPoolClientCommand({ UserPoolId, ClientId: clientId }),
    );
    const client = found.UserPoolClient;
    if (client === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    // Clients are untaggable — ownership is inherited from the parent pool.
    const managed = await this.poolIsManaged(UserPoolId);

    // The client SECRET (client.ClientSecret) is deliberately NEVER read into
    // the projection, identifier, or any log — it is write-only and sensitive.
    return {
      exists: true,
      managed,
      tags: {},
      identifier: client.ClientId ?? clientId,
      projection: {
        userPoolId: client.UserPoolId ?? UserPoolId,
        // GenerateSecret is create-only and not echoed back; its live presence
        // is inferred from whether a secret exists (never the value itself).
        generateSecret:
          client.ClientSecret !== undefined && client.ClientSecret !== '' ? 'true' : 'false',
        authFlows: sortedCsv(client.ExplicitAuthFlows),
        callbackUrls: sortedCsv(client.CallbackURLs),
        allowedOAuthFlows: sortedCsv(client.AllowedOAuthFlows),
      },
    };
  }

  async create(resource: PlanResource, _tags: Record<string, string>): Promise<string> {
    const UserPoolId = this.userPoolId(resource);
    const ClientName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const callbackUrls = parseCsv(d['callbackUrls'] ?? '');
    const oauthFlows = parseCsv(d['allowedOAuthFlows'] ?? '') as OAuthFlowType[];
    const created = await this.cognito.send(
      new CreateUserPoolClientCommand({
        UserPoolId,
        ClientName,
        GenerateSecret: d['generateSecret'] === 'true',
        ExplicitAuthFlows: parseCsv(d['authFlows'] ?? '') as ExplicitAuthFlowsType[],
        ...(callbackUrls.length > 0 ? { CallbackURLs: callbackUrls } : {}),
        ...(oauthFlows.length > 0
          ? { AllowedOAuthFlows: oauthFlows, AllowedOAuthFlowsUserPoolClient: true }
          : {}),
      }),
    );
    // Return the ClientId (NOT the secret) as the identifier — untaggable
    // clients are matched by name, and the id is safe to surface.
    return created.UserPoolClient?.ClientId ?? `cognito-idp:client/${UserPoolId}/${ClientName}`;
  }

  /** All mutable drift reconciles in place; the secret is never touched. */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const UserPoolId = this.userPoolId(resource);
    const name = resourceIdOf(resource);
    const clientId = await this.requireClientId(UserPoolId, name, current);
    const d = this.desiredProjection(resource);
    const callbackUrls = parseCsv(d['callbackUrls'] ?? '');
    const oauthFlows = parseCsv(d['allowedOAuthFlows'] ?? '') as OAuthFlowType[];
    await this.cognito.send(
      new UpdateUserPoolClientCommand({
        UserPoolId,
        ClientId: clientId,
        ClientName: name,
        ExplicitAuthFlows: parseCsv(d['authFlows'] ?? '') as ExplicitAuthFlowsType[],
        ...(callbackUrls.length > 0 ? { CallbackURLs: callbackUrls } : {}),
        ...(oauthFlows.length > 0
          ? { AllowedOAuthFlows: oauthFlows, AllowedOAuthFlowsUserPoolClient: true }
          : {}),
      }),
    );
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const UserPoolId = this.userPoolId(resource);
    const name = resourceIdOf(resource);
    const clientId = await this.requireClientId(UserPoolId, name, current);
    await this.cognito.send(
      new DeleteUserPoolClientCommand({ UserPoolId, ClientId: clientId }),
    );
  }

  private async requireClientId(
    UserPoolId: string,
    name: string,
    current: ResourceState,
  ): Promise<string> {
    const clientId = current.identifier ?? (await this.resolveClientIdByName(UserPoolId, name));
    if (clientId === undefined) {
      throw new Error(
        `Cognito user pool client ${name} not found by name — refusing blind operation`,
      );
    }
    return clientId;
  }

  /**
   * Name → generated ClientId resolution: paginate ListUserPoolClients for the
   * parent pool until `ClientName === name`. The ClientId is the only piece
   * that leaves this method — the secret is never fetched here.
   */
  private async resolveClientIdByName(
    UserPoolId: string,
    name: string,
  ): Promise<string | undefined> {
    let NextToken: string | undefined;
    do {
      const page = await this.cognito.send(
        new ListUserPoolClientsCommand({ UserPoolId, MaxResults: 60, NextToken }),
      );
      const match = (page.UserPoolClients ?? []).find((c) => c.ClientName === name);
      if (match?.ClientId !== undefined) return match.ClientId;
      NextToken = page.NextToken;
    } while (NextToken !== undefined);
    return undefined;
  }

  /** A client is managed iff its parent pool carries iap:managed=true. */
  private async poolIsManaged(UserPoolId: string): Promise<boolean> {
    const found = await this.cognito.send(new DescribeUserPoolCommand({ UserPoolId }));
    const arn = found.UserPool?.Arn;
    if (arn === undefined) return false;
    const tagResult = await this.cognito.send(
      new ListTagsForResourceCommand({ ResourceArn: arn }),
    );
    return isManaged(tagResult.Tags ?? {});
  }
}
