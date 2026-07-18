/**
 * `aws:cloudfront:Distribution` handler (@aws-sdk/client-cloudfront) — the Cdn
 * kind (M24.2). CloudFront is a global service; the runtime constructs the
 * client per-region like every other (harmless — the control plane is global).
 *
 * IDENTITY — distributions have GENERATED ids (e.g. `E1A2B3C4D5E6F7`), so the
 * name alone is not an identity. Identity is resolved by the `iap:resourceId`
 * tag (whose value is the plan logicalId, exactly what `buildTags` stamps),
 * disambiguated like route53.ts resolves a hosted zone: ListDistributions
 * (paginated via Marker/NextMarker) → for each candidate summary
 * ListTagsForResource(distribution ARN) → the distribution whose
 * `iap:resourceId` tag equals the plan logicalId is the one this plan owns. The
 * generated Id and the ETag stay internal to the handler. `CallerReference` is
 * set = logicalId at create so a replayed create is idempotent.
 *
 * ETag / IfMatch — every mutation (Update/Delete) requires the current ETag as
 * the `IfMatch` optimistic-concurrency token, exactly like wafv2.ts uses a
 * LockToken. The ETag rotates on every change, so it is fetched FRESH via
 * GetDistribution immediately before EVERY mutation and never cached from read;
 * a stale ETag raises `PreconditionFailed`, surfaced honestly (no retry in v1).
 *
 * read   → ListDistributions (+ ListTagsForResource, tag match) → GetDistribution
 *          (captures the live DistributionConfig + ETag). Status Deployed and
 *          InProgress both read as present; only a no tag-match reads as absent.
 * create → CreateDistributionWithTags: DistributionConfig { CallerReference =
 *          logicalId, ONE origin from the REQUIRED `originDomainName` attribute
 *          (fail closed — a bucket regional domain → S3 origin, a public domain
 *          → custom origin), DefaultCacheBehavior (ViewerProtocolPolicy
 *          redirect-to-https, MinTTL 0, ForwardedValues), Enabled true,
 *          PriceClass from `priceClass` (default PriceClass_100 — cheapest,
 *          NA+EU edges only), Comment 'iap-managed', optional DefaultRootObject
 *          } + the mandatory Tags. Returns the distribution ARN.
 * update → GetDistribution for a FRESH ETag + the full current config, overlay
 *          the mutable desired fields (priceClass / comment / enabled / origin /
 *          defaultRootObject) — UpdateDistribution is a full PUT, so the live
 *          config rides along untouched otherwise — then UpdateDistribution with
 *          IfMatch=ETag, plus TagResource to reconcile the mandatory tags.
 * delete → THE SLOW PART (disable-then-delete). A distribution must be
 *          Enabled=false AND fully Deployed before DeleteDistribution will
 *          succeed. So: GetDistribution → if Enabled, UpdateDistribution(
 *          Enabled=false, IfMatch=ETag) → then DeleteDistribution with the fresh
 *          post-disable ETag. BETWEEN the disable and the delete the resource
 *          must reach Status=Deployed: the live driver waits for that
 *          (create→Deployed ~5-15 min, disable→Deployed ~5-15 min — the longest
 *          wall-clock teardown in the roadmap). The handler issues disable then
 *          delete; if AWS rejects the delete because the distribution is still
 *          deploying, that surfaces honestly and the live driver retries.
 *
 * PROJECTION — priceClass, comment, enabled, originDomainName and (desired-
 * gated) defaultRootObject are ALL mutable via an in-place UpdateDistribution:
 * CloudFront reconfigures in place, an origin change included. There are NO
 * immutable projection keys, so replacement is justified-N/A (ADR-0006). Output
 * identifier = the distribution ARN; the endpoint an output binding surfaces is
 * the DomainName (`dxxxx.cloudfront.net`).
 */

import {
  CreateDistributionWithTagsCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  ListDistributionsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import type {
  CloudFrontClient,
  DistributionConfig,
  Origin,
  PriceClass,
} from '@aws-sdk/client-cloudfront';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { RESOURCE_TAG_KEY, fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

/** Cheapest tier — North America + Europe edge locations only. */
const DEFAULT_PRICE_CLASS = 'PriceClass_100';
const DEFAULT_COMMENT = 'iap-managed';
/** Stable origin id; DefaultCacheBehavior.TargetOriginId references it. */
const ORIGIN_ID = 'iap-origin';

interface Resolved {
  id: string;
  arn: string;
  tags: Record<string, string>;
}

interface Fresh {
  etag: string;
  config: DistributionConfig;
}

export class CloudFrontDistributionHandler implements TargetHandler {
  static readonly targetType = 'aws:cloudfront:Distribution' as const;
  readonly targetType = CloudFrontDistributionHandler.targetType;
  // priceClass / comment / enabled / originDomainName / defaultRootObject all
  // reconcile in place via UpdateDistribution — no immutable keys, replace N/A.

  constructor(private readonly cloudfront: CloudFrontClient) {}

  /** The origin the CDN fronts — REQUIRED, fail closed like a cross-resource ref. */
  private originDomainName(resource: PlanResource): string {
    const domain = scalarStr(resource.desiredAttributes['originDomainName']);
    if (domain === '') {
      throw new Error(
        `aws:cloudfront:Distribution ${resource.logicalId} needs an originDomainName ` +
          `attribute (the origin the CDN fronts — a bucket regional domain or a public domain)`,
      );
    }
    return domain;
  }

  /** A DefaultRootObject is only compared/applied when the plan pins it. */
  private rootObjectPinned(resource: PlanResource): boolean {
    return resource.desiredAttributes['defaultRootObject'] !== undefined;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      priceClass: scalarStr(a['priceClass']) || DEFAULT_PRICE_CLASS,
      comment: scalarStr(a['comment']) || DEFAULT_COMMENT,
      enabled: scalarStr(a['enabled']) === 'false' ? 'false' : 'true',
      originDomainName: this.originDomainName(resource),
      // Desired-gated: an unpinned root object compares '' on both sides.
      ...(this.rootObjectPinned(resource)
        ? { defaultRootObject: scalarStr(a['defaultRootObject']) }
        : {}),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const resolved = await this.resolveByTag(resource.logicalId);
    if (resolved === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const got = await this.cloudfront.send(new GetDistributionCommand({ Id: resolved.id }));
    const config = got.Distribution?.DistributionConfig;
    const arn = got.Distribution?.ARN ?? resolved.arn;

    const projection: Record<string, string> = {
      priceClass: config?.PriceClass ?? '',
      comment: config?.Comment ?? '',
      enabled: config?.Enabled === true ? 'true' : 'false',
      originDomainName: config?.Origins?.Items?.[0]?.DomainName ?? '',
      ...(this.rootObjectPinned(resource)
        ? { defaultRootObject: config?.DefaultRootObject ?? '' }
        : {}),
    };

    return {
      exists: true,
      managed: isManaged(resolved.tags),
      tags: resolved.tags,
      identifier: arn,
      projection,
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const created = await this.cloudfront.send(
      new CreateDistributionWithTagsCommand({
        DistributionConfigWithTags: {
          DistributionConfig: this.buildConfig(resource, resource.logicalId),
          Tags: { Items: toTagList(tags) },
        },
      }),
    );
    return created.Distribution?.ARN ?? `cloudfront:distribution/${resourceIdOf(resource)}`;
  }

  /**
   * priceClass / comment / enabled / origin / defaultRootObject drift →
   * UpdateDistribution. The ETag is fetched FRESH here (never reused from read —
   * a stale one raises PreconditionFailed), and the CURRENT config from that
   * same GetDistribution is the base of a full PUT so nothing outside the
   * mutable projection is silently erased.
   */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const resolved = await this.resolveByTag(resource.logicalId);
    if (resolved === undefined) {
      throw new Error(
        `cloudfront distribution ${resource.logicalId} disappeared between read and update`,
      );
    }
    const fresh = await this.getFresh(resolved.id);
    await this.cloudfront.send(
      new UpdateDistributionCommand({
        Id: resolved.id,
        IfMatch: fresh.etag,
        DistributionConfig: this.mergeConfig(fresh.config, resource),
      }),
    );
    if (Object.keys(current.tags).length > 0) {
      await this.cloudfront.send(
        new TagResourceCommand({
          Resource: resolved.arn,
          Tags: { Items: toTagList(current.tags) },
        }),
      );
    }
  }

  /**
   * DISABLE-THEN-DELETE. GetDistribution → if still Enabled, UpdateDistribution(
   * Enabled=false, IfMatch=ETag) FIRST, then DeleteDistribution with the fresh
   * post-disable ETag. The live driver must wait for Status=Deployed between the
   * two — a rejected delete (still deploying) surfaces honestly for it to retry.
   */
  async delete(resource: PlanResource): Promise<void> {
    const resolved = await this.resolveByTag(resource.logicalId);
    if (resolved === undefined) {
      throw new Error(
        `cloudfront distribution ${resource.logicalId} not found by tag — refusing blind delete`,
      );
    }
    const fresh = await this.getFresh(resolved.id);

    let deleteEtag = fresh.etag;
    if (fresh.config.Enabled === true) {
      // Must be disabled AND redeployed before it can be deleted (documented).
      const disabled = await this.cloudfront.send(
        new UpdateDistributionCommand({
          Id: resolved.id,
          IfMatch: fresh.etag,
          DistributionConfig: { ...fresh.config, Enabled: false },
        }),
      );
      deleteEtag = disabled.ETag ?? fresh.etag;
    }

    await this.cloudfront.send(
      new DeleteDistributionCommand({ Id: resolved.id, IfMatch: deleteEtag }),
    );
  }

  /** Build a fresh create config from the desired projection + required origin. */
  private buildConfig(resource: PlanResource, callerReference: string): DistributionConfig {
    const d = this.desiredProjection(resource);
    const config: DistributionConfig = {
      CallerReference: callerReference,
      Comment: d['comment'] ?? DEFAULT_COMMENT,
      Enabled: d['enabled'] !== 'false',
      PriceClass: (d['priceClass'] ?? DEFAULT_PRICE_CLASS) as PriceClass,
      Origins: { Quantity: 1, Items: [this.origin(ORIGIN_ID, this.originDomainName(resource))] },
      DefaultCacheBehavior: {
        TargetOriginId: ORIGIN_ID,
        ViewerProtocolPolicy: 'redirect-to-https',
        MinTTL: 0,
        ForwardedValues: { QueryString: false, Cookies: { Forward: 'none' } },
      },
    };
    if (this.rootObjectPinned(resource)) config.DefaultRootObject = d['defaultRootObject'] ?? '';
    return config;
  }

  /**
   * Overlay the mutable desired fields onto the live config (full-PUT base), so
   * an in-place UpdateDistribution reconfigures without erasing untouched
   * settings. The existing origin's Id is preserved so TargetOriginId still
   * resolves after an origin-domain change.
   */
  private mergeConfig(live: DistributionConfig, resource: PlanResource): DistributionConfig {
    const d = this.desiredProjection(resource);
    const originId = live.Origins?.Items?.[0]?.Id ?? ORIGIN_ID;
    const config: DistributionConfig = {
      ...live,
      Comment: d['comment'] ?? DEFAULT_COMMENT,
      Enabled: d['enabled'] !== 'false',
      PriceClass: (d['priceClass'] ?? DEFAULT_PRICE_CLASS) as PriceClass,
      Origins: { Quantity: 1, Items: [this.origin(originId, this.originDomainName(resource))] },
    };
    if (this.rootObjectPinned(resource)) config.DefaultRootObject = d['defaultRootObject'] ?? '';
    return config;
  }

  /** One origin: an S3 regional/website domain → S3 origin, else a custom origin. */
  private origin(id: string, domainName: string): Origin {
    if (isS3Domain(domainName)) {
      return { Id: id, DomainName: domainName, S3OriginConfig: { OriginAccessIdentity: '' } };
    }
    return {
      Id: id,
      DomainName: domainName,
      CustomOriginConfig: {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: 'https-only',
      },
    };
  }

  /**
   * Resolve the generated Id by the iap:resourceId tag: paginate
   * ListDistributions, and for each candidate ListTagsForResource(ARN) until the
   * one whose iap:resourceId equals the plan logicalId. The Id/ETag stay internal.
   */
  private async resolveByTag(logicalId: string): Promise<Resolved | undefined> {
    let Marker: string | undefined;
    do {
      const page = await this.cloudfront.send(new ListDistributionsCommand({ Marker }));
      for (const summary of page.DistributionList?.Items ?? []) {
        if (summary.Id === undefined || summary.ARN === undefined) continue;
        const tagResult = await this.cloudfront.send(
          new ListTagsForResourceCommand({ Resource: summary.ARN }),
        );
        const tags = fromTagList(tagResult.Tags?.Items ?? []);
        if (tags[RESOURCE_TAG_KEY] === logicalId) {
          return { id: summary.Id, arn: summary.ARN, tags };
        }
      }
      Marker = page.DistributionList?.IsTruncated ? page.DistributionList.NextMarker : undefined;
    } while (Marker !== undefined);
    return undefined;
  }

  /**
   * Fresh ETag + full config immediately before a mutation. Never cached:
   * CloudFront rotates the ETag on every change and a stale one fails IfMatch.
   */
  private async getFresh(id: string): Promise<Fresh> {
    const got = await this.cloudfront.send(new GetDistributionCommand({ Id: id }));
    const config = got.Distribution?.DistributionConfig;
    if (got.ETag === undefined || config === undefined) {
      throw new Error(
        `cloudfront distribution ${id} returned no ETag/config — cannot mutate safely`,
      );
    }
    return { etag: got.ETag, config };
  }
}

/** True for an S3 bucket regional / website endpoint domain. */
function isS3Domain(domain: string): boolean {
  return /\.s3(\.|-)/i.test(domain) || /\.s3-website[.-]/i.test(domain);
}
