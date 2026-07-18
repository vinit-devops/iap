/**
 * M24.2 — `aws:cloudfront:Distribution` (the Cdn kind), mock-tested
 * (aws-sdk-client-mock). Generated-Id identity resolved by the iap:resourceId
 * tag; ETag/IfMatch optimistic concurrency on every mutation; and the
 * disable-then-delete teardown (Enabled=false BEFORE DeleteDistribution) that
 * makes CloudFront the longest wall-clock resource in the roadmap.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudFrontClient,
  CreateDistributionWithTagsCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  ListDistributionsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import { AwsExecutor } from '../src/index.js';
import { CloudFrontDistributionHandler } from '../src/cloudfront.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const cf = mockClient(CloudFrontClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const LOGICAL_ID = 'edge-cdn.aws:cloudfront:Distribution';
const ID = 'E1A2B3C4D5E6F7';
const ARN = 'arn:aws:cloudfront::111122223333:distribution/E1A2B3C4D5E6F7';
const DOMAIN = 'd111111abcdef8.cloudfront.net';
const ORIGIN = 'assets-bucket.s3.eu-central-1.amazonaws.com';

const summary = { Id: ID, ARN, DomainName: DOMAIN };

const managedTags = {
  Tags: {
    Items: [
      { Key: 'iap:managed', Value: 'true' },
      { Key: 'iap:resourceId', Value: LOGICAL_ID },
    ],
  },
};

/** A live DistributionConfig echoing what create would have written. */
const liveConfig = (over: Record<string, unknown> = {}) => ({
  CallerReference: LOGICAL_ID,
  Comment: 'iap-managed',
  Enabled: true,
  PriceClass: 'PriceClass_100',
  Origins: {
    Quantity: 1,
    Items: [{ Id: 'iap-origin', DomainName: ORIGIN, S3OriginConfig: { OriginAccessIdentity: '' } }],
  },
  DefaultCacheBehavior: {
    TargetOriginId: 'iap-origin',
    ViewerProtocolPolicy: 'redirect-to-https',
    MinTTL: 0,
    ForwardedValues: { QueryString: false, Cookies: { Forward: 'none' } },
  },
  ...over,
});

const plan = (attrs: Record<string, string> = {}) =>
  providerPlan([
    planResource('edge-cdn', 'aws:cloudfront:Distribution', {
      originDomainName: ORIGIN,
      ...attrs,
    }),
  ]);

beforeEach(() => {
  cf.reset();
});

describe('aws:cloudfront:Distribution', () => {
  it('absent → CreateDistributionWithTags: required origin, PriceClass_100, CallerReference=logicalId, tags', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [] } });
    cf.on(CreateDistributionWithTagsCommand).resolves({ Distribution: { ARN } });

    const report = await executor().apply(plan(), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe(ARN);

    const input = cf.commandCalls(CreateDistributionWithTagsCommand)[0]?.args[0].input;
    const config = input?.DistributionConfigWithTags?.DistributionConfig;
    expect(config?.CallerReference).toBe(LOGICAL_ID); // idempotency token = logicalId
    expect(config?.PriceClass).toBe('PriceClass_100'); // cheapest default (NA+EU)
    expect(config?.Enabled).toBe(true);
    expect(config?.Comment).toBe('iap-managed');
    expect(config?.Origins?.Quantity).toBe(1);
    expect(config?.Origins?.Items?.[0]?.DomainName).toBe(ORIGIN);
    // S3 regional domain → an S3 origin (custom origins are for public domains).
    expect(config?.Origins?.Items?.[0]?.S3OriginConfig).toBeDefined();
    expect(config?.DefaultCacheBehavior?.ViewerProtocolPolicy).toBe('redirect-to-https');
    const tagItems = input?.DistributionConfigWithTags?.Tags?.Items ?? [];
    expect(tagItems).toContainEqual({ Key: 'iap:managed', Value: 'true' });
    expect(tagItems).toContainEqual({ Key: 'iap:resourceId', Value: LOGICAL_ID });
  });

  it('fails closed when originDomainName is missing — no CreateDistributionWithTags call', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [] } });

    const noOrigin = providerPlan([planResource('edge-cdn', 'aws:cloudfront:Distribution', {})]);
    const report = await executor().apply(noOrigin, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('originDomainName');
    expect(cf.commandCalls(CreateDistributionWithTagsCommand)).toHaveLength(0);
  });

  it('public origin domain → a custom origin (not S3)', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [] } });
    cf.on(CreateDistributionWithTagsCommand).resolves({ Distribution: { ARN } });

    await executor().apply(plan({ originDomainName: 'origin.example.com' }), { apply: true });

    const config = cf.commandCalls(CreateDistributionWithTagsCommand)[0]?.args[0].input
      ?.DistributionConfigWithTags?.DistributionConfig;
    expect(config?.Origins?.Items?.[0]?.CustomOriginConfig).toBeDefined();
    expect(config?.Origins?.Items?.[0]?.S3OriginConfig).toBeUndefined();
  });

  it('resolves the generated Id by the iap:resourceId tag via ListDistributions (converged → no-op)', async () => {
    cf.on(ListDistributionsCommand).resolves({
      DistributionList: {
        Items: [
          { Id: 'E-OTHER', ARN: 'arn:aws:cloudfront::111122223333:distribution/E-OTHER' },
          summary,
        ],
      },
    });
    cf.on(ListTagsForResourceCommand)
      // The first (other) distribution carries a different iap:resourceId.
      .resolvesOnce({ Tags: { Items: [{ Key: 'iap:resourceId', Value: 'someone-else' }] } })
      .resolves(managedTags);
    cf.on(GetDistributionCommand).resolves({ Distribution: { ARN, DistributionConfig: liveConfig() }, ETag: 'etag-0' });

    const report = await executor().plan(plan());

    expect(report.items[0]?.action).toBe('no-op');
    // The name-resolved generated id drives GetDistribution.
    expect(cf.commandCalls(GetDistributionCommand)[0]?.args[0].input?.Id).toBe(ID);
  });

  it('no tag match → absent → create (never a phantom no-op)', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } });
    cf.on(ListTagsForResourceCommand).resolves({
      Tags: { Items: [{ Key: 'iap:resourceId', Value: 'not-us' }] },
    });

    const report = await executor().plan(plan());
    expect(report.items[0]?.action).toBe('create');
  });

  it('priceClass/comment drift → UpdateDistribution carries a FRESH ETag as IfMatch', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } });
    cf.on(ListTagsForResourceCommand).resolves(managedTags);
    cf.on(GetDistributionCommand)
      // read hands out one ETag…
      .resolvesOnce({ Distribution: { ARN, DistributionConfig: liveConfig() }, ETag: 'etag-read' })
      // …the pre-mutation fetch gets the CURRENT one — this is what must be sent.
      .resolves({ Distribution: { ARN, DistributionConfig: liveConfig() }, ETag: 'etag-fresh' });
    cf.on(UpdateDistributionCommand).resolves({ Distribution: { ARN }, ETag: 'etag-next' });
    cf.on(TagResourceCommand).resolves({});

    const report = await executor().apply(plan({ priceClass: 'PriceClass_All', comment: 'edge v2' }), {
      apply: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('update');
    const input = cf.commandCalls(UpdateDistributionCommand)[0]?.args[0].input;
    expect(input?.Id).toBe(ID);
    expect(input?.IfMatch).toBe('etag-fresh'); // fresh, not the read-time ETag
    expect(input?.DistributionConfig?.PriceClass).toBe('PriceClass_All');
    expect(input?.DistributionConfig?.Comment).toBe('edge v2');
    // Full PUT: CallerReference from the live config rides along untouched.
    expect(input?.DistributionConfig?.CallerReference).toBe(LOGICAL_ID);
  });

  it('origin drift → UpdateDistribution rewrites the origin domain in place', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } });
    cf.on(ListTagsForResourceCommand).resolves(managedTags);
    cf.on(GetDistributionCommand).resolves({
      Distribution: { ARN, DistributionConfig: liveConfig() },
      ETag: 'etag-1',
    });
    cf.on(UpdateDistributionCommand).resolves({ Distribution: { ARN }, ETag: 'etag-2' });
    cf.on(TagResourceCommand).resolves({});

    const report = await executor().apply(plan({ originDomainName: 'new-origin.example.com' }), {
      apply: true,
    });

    expect(report.items[0]?.action).toBe('update');
    const config = cf.commandCalls(UpdateDistributionCommand)[0]?.args[0].input?.DistributionConfig;
    expect(config?.Origins?.Items?.[0]?.DomainName).toBe('new-origin.example.com');
    // The origin Id is preserved so TargetOriginId still resolves.
    expect(config?.Origins?.Items?.[0]?.Id).toBe('iap-origin');
    expect(config?.DefaultCacheBehavior?.TargetOriginId).toBe('iap-origin');
  });

  it('stale ETag → PreconditionFailed surfaces honestly, no retry', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } });
    cf.on(ListTagsForResourceCommand).resolves(managedTags);
    cf.on(GetDistributionCommand).resolves({
      Distribution: { ARN, DistributionConfig: liveConfig() },
      ETag: 'etag-stale',
    });
    cf.on(UpdateDistributionCommand).rejects(serviceError('PreconditionFailed'));

    const report = await executor().apply(plan({ comment: 'drift' }), { apply: true });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('PreconditionFailed');
    expect(report.items[0]?.applied).toBe(false);
    expect(cf.commandCalls(UpdateDistributionCommand)).toHaveLength(1); // one attempt, no retry
  });

  it('destroy → disable (Enabled=false) BEFORE DeleteDistribution, both with the right IfMatch ETag', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } });
    cf.on(ListTagsForResourceCommand).resolves(managedTags);
    cf.on(GetDistributionCommand)
      .resolvesOnce({ Distribution: { ARN, DistributionConfig: liveConfig() }, ETag: 'etag-read' })
      // pre-delete fetch: the distribution is still Enabled → must be disabled first.
      .resolves({ Distribution: { ARN, DistributionConfig: liveConfig() }, ETag: 'etag-live' });
    cf.on(UpdateDistributionCommand).resolves({ Distribution: { ARN }, ETag: 'etag-disabled' });
    cf.on(DeleteDistributionCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);

    // Ordering: the disabling UpdateDistribution must precede DeleteDistribution.
    const order = cf.calls().map((c) => c.args[0].constructor.name);
    const updateAt = order.indexOf('UpdateDistributionCommand');
    const deleteAt = order.indexOf('DeleteDistributionCommand');
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(updateAt);

    // The disable sets Enabled=false with the live ETag as IfMatch…
    const upd = cf.commandCalls(UpdateDistributionCommand)[0]?.args[0].input;
    expect(upd?.DistributionConfig?.Enabled).toBe(false);
    expect(upd?.IfMatch).toBe('etag-live');
    // …and the delete uses the FRESH post-disable ETag.
    const del = cf.commandCalls(DeleteDistributionCommand)[0]?.args[0].input;
    expect(del?.Id).toBe(ID);
    expect(del?.IfMatch).toBe('etag-disabled');
  });

  it('destroy of an already-disabled distribution deletes without a redundant disable', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } });
    cf.on(ListTagsForResourceCommand).resolves(managedTags);
    cf.on(GetDistributionCommand).resolves({
      Distribution: { ARN, DistributionConfig: liveConfig({ Enabled: false }) },
      ETag: 'etag-off',
    });
    cf.on(DeleteDistributionCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.errors).toEqual([]);
    expect(cf.commandCalls(UpdateDistributionCommand)).toHaveLength(0); // no redundant disable
    expect(cf.commandCalls(DeleteDistributionCommand)[0]?.args[0].input?.IfMatch).toBe('etag-off');
  });

  it('destroy refuses an unmanaged distribution (managed-only gate) — no delete call', async () => {
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } });
    cf.on(ListTagsForResourceCommand).resolves({
      // iap:resourceId matches (identity) but iap:managed is absent.
      Tags: { Items: [{ Key: 'iap:resourceId', Value: LOGICAL_ID }, { Key: 'team', Value: 'edge' }] },
    });
    cf.on(GetDistributionCommand).resolves({
      Distribution: { ARN, DistributionConfig: liveConfig() },
      ETag: 'etag-0',
    });

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('refusing to delete');
    expect(cf.commandCalls(DeleteDistributionCommand)).toHaveLength(0);
    expect(cf.commandCalls(UpdateDistributionCommand)).toHaveLength(0);
  });

  it('declares NO immutable projection keys — replacement is justified-N/A', () => {
    // No immutableProjectionKeys → drift is always update, never replace
    // (CloudFront reconfigures in place, an origin change included).
    const instance = new CloudFrontDistributionHandler({} as never);
    expect(instance.immutableProjectionKeys).toBeUndefined();
    expect(instance.targetType).toBe('aws:cloudfront:Distribution');
  });
});
