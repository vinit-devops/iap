/**
 * `aws:wafv2:WebACL` handler (@aws-sdk/client-wafv2) — edge posture (M22.5).
 *
 * IDENTITY — a WebACL is identified by Name+Scope, but every operation needs
 * the GENERATED Id plus a LockToken. The Id is resolved by NAME via
 * ListWebACLs (paginated; Scope from the `scope` attribute, default
 * REGIONAL). The LockToken is WAF's optimistic-concurrency token: it changes
 * on every mutation, so it is fetched FRESH via GetWebACL immediately before
 * EVERY mutation and never cached — a stale token raises
 * WAFOptimisticLockException, which surfaces honestly (no retry loop in v1).
 *
 * read   → ListWebACLs (name match; unmatched → absent) → GetWebACL
 *          + ListTagsForResource (WebACL ARN)
 * create → CreateWebACL: DefaultAction Allow (or Block when the
 *          `defaultAction` attribute is 'block'), VisibilityConfig
 *          (sampled requests + CloudWatch metrics on, MetricName =
 *          resourceId), Rules [] — ZERO RULES in v1; managed rule groups are
 *          later scope — and tags.
 * update → GetWebACL for the fresh LockToken AND the full current
 *          Rules/VisibilityConfig (UpdateWebACL is a full PUT: omitting them
 *          would erase live config), then UpdateWebACL + TagResource.
 * delete → GetWebACL for a fresh LockToken → DeleteWebACL. Service refusals
 *          (e.g. WAFAssociatedItemException while still bound to a resource)
 *          surface honestly — never swallowed.
 *
 * `scope` is IMMUTABLE (it is half the identity) — drift replaces (ADR-0006).
 * `defaultAction` and `description` reconcile in place via UpdateWebACL.
 * Association with an ALB (the "derived from a public Gateway" story) is
 * future mapping scope; this handler proves the standalone ACL.
 */

import {
  CreateWebACLCommand,
  DeleteWebACLCommand,
  GetWebACLCommand,
  ListTagsForResourceCommand,
  ListWebACLsCommand,
  TagResourceCommand,
  UpdateWebACLCommand,
} from '@aws-sdk/client-wafv2';
import type { Rule, Scope, VisibilityConfig, WAFV2Client } from '@aws-sdk/client-wafv2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

export class Wafv2WebAclHandler implements TargetHandler {
  static readonly targetType = 'aws:wafv2:WebACL' as const;
  readonly targetType = Wafv2WebAclHandler.targetType;
  /** Scope is half the WebACL's identity — it can never change in place. */
  readonly immutableProjectionKeys = ['scope'] as const;

  constructor(private readonly wafv2: WAFV2Client) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      scope: this.desiredScope(resource),
      defaultAction: scalarStr(a['defaultAction']) === 'block' ? 'block' : 'allow',
      description: scalarStr(a['description']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const scope = this.desiredScope(resource) as Scope;
    const summary = await this.resolveByName(name, scope);
    if (summary === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const found = await this.wafv2.send(
      new GetWebACLCommand({ Name: name, Scope: scope, Id: summary.id }),
    );
    const acl = found.WebACL;
    const arn = acl?.ARN ?? summary.arn;

    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.wafv2.send(new ListTagsForResourceCommand({ ResourceARN: arn }));
      tags = fromTagList(tagResult.TagInfoForResource?.TagList ?? []);
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        // Scope is encoded in the ARN (…:regional/webacl/… vs …:global/webacl/…).
        scope: scopeFromArn(arn) ?? scope,
        defaultAction: acl?.DefaultAction?.Block !== undefined ? 'block' : 'allow',
        description: acl?.Description ?? '',
      },
    };
    if (arn !== undefined) state.identifier = arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const created = await this.wafv2.send(
      new CreateWebACLCommand({
        Name: name,
        Scope: d['scope'] as Scope,
        DefaultAction: d['defaultAction'] === 'block' ? { Block: {} } : { Allow: {} },
        ...(d['description'] ? { Description: d['description'] } : {}),
        // Zero rules in v1 — managed rule groups are later scope (documented).
        Rules: [],
        VisibilityConfig: this.defaultVisibilityConfig(name),
        Tags: toTagList(tags),
      }),
    );
    return created.Summary?.ARN ?? `wafv2:webacl/${name}`;
  }

  /**
   * defaultAction/description drift → UpdateWebACL. The LockToken is fetched
   * FRESH here (never reused from read — stale tokens raise
   * WAFOptimisticLockException), and the CURRENT Rules + VisibilityConfig from
   * that same fresh GetWebACL are passed back verbatim: UpdateWebACL replaces
   * the whole configuration, so omitting them would silently erase it.
   */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const scope = this.desiredScope(resource) as Scope;
    const d = this.desiredProjection(resource);
    const fresh = await this.freshAcl(name, scope);
    await this.wafv2.send(
      new UpdateWebACLCommand({
        Name: name,
        Scope: scope,
        Id: fresh.id,
        DefaultAction: d['defaultAction'] === 'block' ? { Block: {} } : { Allow: {} },
        ...(d['description'] ? { Description: d['description'] } : {}),
        Rules: fresh.rules,
        VisibilityConfig: fresh.visibilityConfig,
        LockToken: fresh.lockToken,
      }),
    );
    if (current.identifier !== undefined && Object.keys(current.tags).length > 0) {
      await this.wafv2.send(
        new TagResourceCommand({
          ResourceARN: current.identifier,
          Tags: toTagList(current.tags),
        }),
      );
    }
  }

  /** Fresh LockToken immediately before the delete; service errors surface. */
  async delete(resource: PlanResource): Promise<void> {
    const name = resourceIdOf(resource);
    const scope = this.desiredScope(resource) as Scope;
    const fresh = await this.freshAcl(name, scope);
    await this.wafv2.send(
      new DeleteWebACLCommand({
        Name: name,
        Scope: scope,
        Id: fresh.id,
        LockToken: fresh.lockToken,
      }),
    );
  }

  private desiredScope(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['scope']) || 'REGIONAL';
  }

  private defaultVisibilityConfig(name: string): VisibilityConfig {
    return {
      SampledRequestsEnabled: true,
      CloudWatchMetricsEnabled: true,
      MetricName: name,
    };
  }

  /**
   * Name → generated-id resolution: paginate ListWebACLs (for the given
   * scope) until the summary carrying `Name === name`.
   */
  private async resolveByName(
    name: string,
    scope: Scope,
  ): Promise<{ id: string; arn?: string } | undefined> {
    let NextMarker: string | undefined;
    do {
      const page = await this.wafv2.send(new ListWebACLsCommand({ Scope: scope, NextMarker }));
      const match = (page.WebACLs ?? []).find((acl) => acl.Name === name);
      if (match?.Id !== undefined) {
        return match.ARN !== undefined ? { id: match.Id, arn: match.ARN } : { id: match.Id };
      }
      NextMarker = page.NextMarker;
    } while (NextMarker !== undefined);
    return undefined;
  }

  /**
   * Resolve the Id and fetch a FRESH LockToken + the full current
   * configuration via GetWebACL, immediately before a mutation. Never cached:
   * WAF rotates the token on every change and a stale one fails the call.
   */
  private async freshAcl(
    name: string,
    scope: Scope,
  ): Promise<{ id: string; lockToken: string; rules: Rule[]; visibilityConfig: VisibilityConfig }> {
    const summary = await this.resolveByName(name, scope);
    if (summary === undefined) {
      throw new Error(`web ACL ${name} (${scope}) not found by name — refusing blind mutation`);
    }
    const found = await this.wafv2.send(
      new GetWebACLCommand({ Name: name, Scope: scope, Id: summary.id }),
    );
    if (found.LockToken === undefined) {
      throw new Error(`web ACL ${name} (${scope}) returned no LockToken — cannot mutate safely`);
    }
    return {
      id: summary.id,
      lockToken: found.LockToken,
      rules: found.WebACL?.Rules ?? [],
      visibilityConfig: found.WebACL?.VisibilityConfig ?? this.defaultVisibilityConfig(name),
    };
  }
}

/** REGIONAL vs CLOUDFRONT, decoded from the WebACL ARN's scope segment. */
function scopeFromArn(arn: string | undefined): string | undefined {
  if (arn === undefined) return undefined;
  if (arn.includes(':regional/webacl/')) return 'REGIONAL';
  if (arn.includes(':global/webacl/')) return 'CLOUDFRONT';
  return undefined;
}
