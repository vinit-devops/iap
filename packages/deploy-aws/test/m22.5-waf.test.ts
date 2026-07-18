/**
 * M22.5 — `aws:wafv2:WebACL`, mock-tested (aws-sdk-client-mock).
 * Name+Scope identity with generated Id + LockToken resolution; the
 * LockToken is fetched FRESH via GetWebACL before every mutation (stale →
 * WAFOptimisticLockException, surfaced honestly — no retry loop in v1).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateWebACLCommand,
  DeleteWebACLCommand,
  GetWebACLCommand,
  ListTagsForResourceCommand,
  ListWebACLsCommand,
  TagResourceCommand,
  UpdateWebACLCommand,
  WAFV2Client,
} from '@aws-sdk/client-wafv2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const waf = mockClient(WAFV2Client);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const ARN = 'arn:aws:wafv2:eu-central-1:111122223333:regional/webacl/edge-acl/wacl-id-1';
const summary = { Name: 'edge-acl', Id: 'wacl-id-1', ARN, LockToken: 'list-lock' };
const liveAcl = {
  Name: 'edge-acl',
  Id: 'wacl-id-1',
  ARN,
  DefaultAction: { Allow: {} },
  Rules: [],
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: 'edge-acl',
  },
};
const MANAGED_TAGS = {
  TagInfoForResource: { TagList: [{ Key: 'iap:managed', Value: 'true' }] },
};

const plan = providerPlan([
  planResource('edge-acl', 'aws:wafv2:WebACL', {
    scope: 'REGIONAL',
    defaultAction: 'allow',
  }),
]);

beforeEach(() => {
  waf.reset();
});

describe('aws:wafv2:WebACL', () => {
  it('resolves Name+Scope → generated Id via ListWebACLs, then GetWebACL (converged → no-op)', async () => {
    waf.on(ListWebACLsCommand).resolves({
      WebACLs: [{ Name: 'other-acl', Id: 'wacl-other' }, summary],
    });
    waf.on(GetWebACLCommand).resolves({ WebACL: liveAcl, LockToken: 'lock-0' });
    waf.on(ListTagsForResourceCommand).resolves(MANAGED_TAGS);

    const report = await executor().plan(plan);

    expect(report.items[0]?.action).toBe('no-op');
    const get = waf.commandCalls(GetWebACLCommand)[0]?.args[0].input;
    expect(get?.Name).toBe('edge-acl');
    expect(get?.Scope).toBe('REGIONAL');
    expect(get?.Id).toBe('wacl-id-1'); // the name-resolved generated id
    expect(waf.commandCalls(ListTagsForResourceCommand)[0]?.args[0].input?.ResourceARN).toBe(ARN);
  });

  it('absent → CreateWebACL: zero rules, Allow default, VisibilityConfig + tags', async () => {
    waf.on(ListWebACLsCommand).resolves({ WebACLs: [] });
    waf.on(CreateWebACLCommand).resolves({ Summary: summary });

    const report = await executor().apply(plan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe(ARN);
    const input = waf.commandCalls(CreateWebACLCommand)[0]?.args[0].input;
    expect(input?.Name).toBe('edge-acl');
    expect(input?.Scope).toBe('REGIONAL');
    expect(input?.DefaultAction).toEqual({ Allow: {} });
    expect(input?.Rules).toEqual([]); // zero rules in v1 — managed rule groups are later scope
    expect(input?.VisibilityConfig).toEqual({
      SampledRequestsEnabled: true,
      CloudWatchMetricsEnabled: true,
      MetricName: 'edge-acl',
    });
    expect(input?.Tags).toContainEqual({ Key: 'iap:managed', Value: 'true' });
  });

  it('defaultAction drift → UpdateWebACL carries a FRESH LockToken and the full live config', async () => {
    const blockPlan = providerPlan([
      planResource('edge-acl', 'aws:wafv2:WebACL', {
        scope: 'REGIONAL',
        defaultAction: 'block',
      }),
    ]);
    waf.on(ListWebACLsCommand).resolves({ WebACLs: [summary] });
    waf
      .on(GetWebACLCommand)
      // First GetWebACL (read) hands out one token…
      .resolvesOnce({ WebACL: liveAcl, LockToken: 'lock-read' })
      // …the pre-mutation fetch gets the CURRENT one — this must be the one sent.
      .resolves({ WebACL: liveAcl, LockToken: 'lock-fresh' });
    waf.on(ListTagsForResourceCommand).resolves(MANAGED_TAGS);
    waf.on(UpdateWebACLCommand).resolves({ NextLockToken: 'lock-next' });
    waf.on(TagResourceCommand).resolves({});

    const report = await executor().apply(blockPlan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('update');
    const input = waf.commandCalls(UpdateWebACLCommand)[0]?.args[0].input;
    expect(input?.LockToken).toBe('lock-fresh'); // fresh, not the read-time token
    expect(input?.Id).toBe('wacl-id-1');
    expect(input?.DefaultAction).toEqual({ Block: {} });
    // UpdateWebACL is a full PUT: the live Rules + VisibilityConfig ride along.
    expect(input?.Rules).toEqual(liveAcl.Rules);
    expect(input?.VisibilityConfig).toEqual(liveAcl.VisibilityConfig);
  });

  it('stale LockToken → WAFOptimisticLockException surfaces honestly, no retry', async () => {
    const blockPlan = providerPlan([
      planResource('edge-acl', 'aws:wafv2:WebACL', {
        scope: 'REGIONAL',
        defaultAction: 'block',
      }),
    ]);
    waf.on(ListWebACLsCommand).resolves({ WebACLs: [summary] });
    waf.on(GetWebACLCommand).resolves({ WebACL: liveAcl, LockToken: 'lock-stale' });
    waf.on(ListTagsForResourceCommand).resolves(MANAGED_TAGS);
    waf.on(UpdateWebACLCommand).rejects(serviceError('WAFOptimisticLockException'));

    const report = await executor().apply(blockPlan, { apply: true });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('WAFOptimisticLockException');
    expect(report.items[0]?.applied).toBe(false);
    // No stale-lock retry is implemented in v1 — exactly one attempt.
    expect(waf.commandCalls(UpdateWebACLCommand)).toHaveLength(1);
  });

  it('destroy → fresh GetWebACL LockToken, then DeleteWebACL by Name/Scope/Id', async () => {
    waf.on(ListWebACLsCommand).resolves({ WebACLs: [summary] });
    waf
      .on(GetWebACLCommand)
      .resolvesOnce({ WebACL: liveAcl, LockToken: 'lock-read' })
      .resolves({ WebACL: liveAcl, LockToken: 'lock-del' });
    waf.on(ListTagsForResourceCommand).resolves(MANAGED_TAGS);
    waf.on(DeleteWebACLCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    const input = waf.commandCalls(DeleteWebACLCommand)[0]?.args[0].input;
    expect(input?.Name).toBe('edge-acl');
    expect(input?.Scope).toBe('REGIONAL');
    expect(input?.Id).toBe('wacl-id-1');
    expect(input?.LockToken).toBe('lock-del'); // the pre-delete fetch, not the read-time token
  });

  it('destroy refuses an unmanaged web ACL (managed-only gate) — no delete call', async () => {
    waf.on(ListWebACLsCommand).resolves({ WebACLs: [summary] });
    waf.on(GetWebACLCommand).resolves({ WebACL: liveAcl, LockToken: 'lock-read' });
    waf.on(ListTagsForResourceCommand).resolves({
      TagInfoForResource: { TagList: [{ Key: 'team', Value: 'edge' }] }, // no iap:managed
    });

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('refusing to delete');
    expect(waf.commandCalls(DeleteWebACLCommand)).toHaveLength(0);
  });

  it('scope drift is IMMUTABLE → replace classification', async () => {
    const cloudfrontPlan = providerPlan([
      planResource('edge-acl', 'aws:wafv2:WebACL', {
        scope: 'CLOUDFRONT',
        defaultAction: 'allow',
      }),
    ]);
    // The live ACL's ARN says :regional/ — desired CLOUDFRONT drifts on scope.
    waf.on(ListWebACLsCommand).resolves({ WebACLs: [summary] });
    waf.on(GetWebACLCommand).resolves({ WebACL: liveAcl, LockToken: 'lock-0' });
    waf.on(ListTagsForResourceCommand).resolves(MANAGED_TAGS);

    const report = await executor().plan(cloudfrontPlan);
    expect(report.items[0]?.action).toBe('replace');
  });
});
