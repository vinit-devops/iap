/**
 * M23.2 Route 53 handlers, mock-tested (aws-sdk-client-mock): hosted zones
 * (the DnsZone kind) and record sets. Each handler is driven through the
 * executor end-to-end.
 *
 * Covers: zone create (CallerReference + separate ChangeTagsForResource with
 * mandatory tags), name+tag identity resolution across duplicate names,
 * visibility→PrivateZone, visibility drift→replace (immutable), record UPSERT
 * on create and update, record type-change→replace (immutable), zone destroy
 * emptying non-apex records before DeleteHostedZone, and the managed-only
 * refusal gate for a record whose parent zone is unmanaged.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ChangeResourceRecordSetsCommand,
  ChangeTagsForResourceCommand,
  CreateHostedZoneCommand,
  DeleteHostedZoneCommand,
  GetHostedZoneCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  ListTagsForResourceCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const r53 = mockClient(Route53Client);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const ZONE_LOGICAL = 'infraasprompt.internal.aws:route53:HostedZone';

beforeEach(() => {
  r53.reset();
});

describe('aws:route53:HostedZone', () => {
  const zonePlan = (attrs: Record<string, string | number | boolean> = {}) =>
    providerPlan([planResource('infraasprompt.internal', 'aws:route53:HostedZone', attrs)]);

  it('absent → CreateHostedZone (CallerReference=logicalId) then ChangeTagsForResource', async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [], IsTruncated: false });
    r53.on(CreateHostedZoneCommand).resolves({
      HostedZone: { Id: '/hostedzone/Z123', Name: 'infraasprompt.internal.' },
    });
    r53.on(ChangeTagsForResourceCommand).resolves({});

    const report = await executor().apply(zonePlan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('/hostedzone/Z123');

    const create = r53.commandCalls(CreateHostedZoneCommand)[0]?.args[0].input;
    expect(create?.Name).toBe('infraasprompt.internal');
    expect(create?.CallerReference).toBe(ZONE_LOGICAL);
    expect(create?.HostedZoneConfig?.PrivateZone).toBe(false);

    // Tags land in a SECOND call — CreateHostedZone takes no inline tags.
    const tag = r53.commandCalls(ChangeTagsForResourceCommand)[0]?.args[0].input;
    expect(tag?.ResourceType).toBe('hostedzone');
    expect(tag?.ResourceId).toBe('Z123'); // bare id, no /hostedzone/ prefix
    const addTags = Object.fromEntries((tag?.AddTags ?? []).map((t) => [t.Key, t.Value]));
    expect(addTags['iap:managed']).toBe('true');
    expect(addTags['iap:resourceId']).toBe(ZONE_LOGICAL);
  });

  it('resolves identity by name AND iap:resourceId tag (duplicate-name disambiguation)', async () => {
    // Two zones share the name; only one carries THIS plan's resourceId tag.
    r53.on(ListHostedZonesByNameCommand).resolves({
      HostedZones: [
        { Id: '/hostedzone/ZONEA', Name: 'infraasprompt.internal.' },
        { Id: '/hostedzone/ZONEB', Name: 'infraasprompt.internal.' },
      ],
      IsTruncated: false,
    });
    r53.on(ListTagsForResourceCommand, { ResourceId: 'ZONEA' }).resolves({
      ResourceTagSet: { Tags: [{ Key: 'iap:resourceId', Value: 'someone-else' }] },
    });
    r53.on(ListTagsForResourceCommand, { ResourceId: 'ZONEB' }).resolves({
      ResourceTagSet: {
        Tags: [
          { Key: 'iap:managed', Value: 'true' },
          { Key: 'iap:resourceId', Value: ZONE_LOGICAL },
        ],
      },
    });
    r53.on(GetHostedZoneCommand).resolves({
      HostedZone: {
        Id: '/hostedzone/ZONEB',
        Name: 'infraasprompt.internal.',
        Config: { PrivateZone: false },
      },
    });

    // Dry-run apply (gate closed) still resolves identity + populates identifier.
    const report = await executor().apply(zonePlan(), {});

    expect(report.items[0]?.action).toBe('no-op');
    expect(report.items[0]?.identifier).toBe('/hostedzone/ZONEB');
  });

  it('visibility private → CreateHostedZone with PrivateZone=true', async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [], IsTruncated: false });
    r53.on(CreateHostedZoneCommand).resolves({
      HostedZone: { Id: '/hostedzone/Z9', Name: 'infraasprompt.internal.' },
    });
    r53.on(ChangeTagsForResourceCommand).resolves({});

    await executor().apply(zonePlan({ visibility: 'private' }), { apply: true });

    const create = r53.commandCalls(CreateHostedZoneCommand)[0]?.args[0].input;
    expect(create?.HostedZoneConfig?.PrivateZone).toBe(true);
  });

  it('visibility drift is IMMUTABLE → replace', async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({
      HostedZones: [{ Id: '/hostedzone/Z1', Name: 'infraasprompt.internal.' }],
      IsTruncated: false,
    });
    r53.on(ListTagsForResourceCommand).resolves({
      ResourceTagSet: {
        Tags: [
          { Key: 'iap:managed', Value: 'true' },
          { Key: 'iap:resourceId', Value: ZONE_LOGICAL },
        ],
      },
    });
    // Live zone is PUBLIC; desired is private → immutable drift.
    r53.on(GetHostedZoneCommand).resolves({
      HostedZone: {
        Id: '/hostedzone/Z1',
        Name: 'infraasprompt.internal.',
        Config: { PrivateZone: false },
      },
    });

    const report = await executor().plan(zonePlan({ visibility: 'private' }));
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy empties non-apex records THEN DeleteHostedZone (apex SOA/NS preserved)', async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({
      HostedZones: [{ Id: '/hostedzone/Z1', Name: 'infraasprompt.internal.' }],
      IsTruncated: false,
    });
    r53.on(ListTagsForResourceCommand).resolves({
      ResourceTagSet: {
        Tags: [
          { Key: 'iap:managed', Value: 'true' },
          { Key: 'iap:resourceId', Value: ZONE_LOGICAL },
        ],
      },
    });
    r53.on(GetHostedZoneCommand).resolves({
      HostedZone: {
        Id: '/hostedzone/Z1',
        Name: 'infraasprompt.internal.',
        Config: { PrivateZone: false },
      },
    });
    r53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        {
          Name: 'infraasprompt.internal.',
          Type: 'SOA',
          TTL: 900,
          ResourceRecords: [{ Value: 'ns.x. a.x. 1 7200 900 1209600 86400' }],
        },
        {
          Name: 'infraasprompt.internal.',
          Type: 'NS',
          TTL: 172800,
          ResourceRecords: [{ Value: 'ns-1.awsdns.' }],
        },
        {
          Name: 'api.infraasprompt.internal.',
          Type: 'A',
          TTL: 60,
          ResourceRecords: [{ Value: '10.0.0.1' }],
        },
      ],
      IsTruncated: false,
    });
    r53
      .on(ChangeResourceRecordSetsCommand)
      .resolves({ ChangeInfo: { Id: '/change/C1', Status: 'PENDING' } });
    r53.on(DeleteHostedZoneCommand).resolves({});

    const report = await executor().apply(zonePlan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);

    const change = r53.commandCalls(ChangeResourceRecordSetsCommand)[0]?.args[0].input;
    const changes = change?.ChangeBatch?.Changes ?? [];
    // Only the non-apex A record is deleted; the apex SOA + NS are preserved.
    expect(changes).toHaveLength(1);
    expect(changes[0]?.Action).toBe('DELETE');
    expect(changes[0]?.ResourceRecordSet?.Name).toBe('api.infraasprompt.internal.');

    expect(r53.commandCalls(DeleteHostedZoneCommand)[0]?.args[0].input?.Id).toBe('/hostedzone/Z1');
  });
});

describe('aws:route53:RecordSet', () => {
  const recordPlan = (attrs: Record<string, string | number | boolean> = {}) =>
    providerPlan([
      planResource('api-record', 'aws:route53:RecordSet', {
        hostedZoneId: '/hostedzone/Z1',
        recordName: 'api.infraasprompt.internal',
        recordType: 'A',
        ttl: 60,
        records: '10.0.0.1',
        ...attrs,
      }),
    ]);

  const managedZoneTags = {
    ResourceTagSet: {
      Tags: [
        { Key: 'iap:managed', Value: 'true' },
        { Key: 'iap:resourceId', Value: 'z' },
      ],
    },
  };

  it('absent → ChangeResourceRecordSets UPSERT', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [] });
    r53
      .on(ChangeResourceRecordSetsCommand)
      .resolves({ ChangeInfo: { Id: '/change/C1', Status: 'PENDING' } });

    const report = await executor().apply(recordPlan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);

    const change = r53.commandCalls(ChangeResourceRecordSetsCommand)[0]?.args[0].input;
    const rrs = change?.ChangeBatch?.Changes?.[0];
    expect(change?.HostedZoneId).toBe('/hostedzone/Z1');
    expect(rrs?.Action).toBe('UPSERT');
    expect(rrs?.ResourceRecordSet?.Name).toBe('api.infraasprompt.internal.');
    expect(rrs?.ResourceRecordSet?.Type).toBe('A');
    expect(rrs?.ResourceRecordSet?.TTL).toBe(60);
    expect(rrs?.ResourceRecordSet?.ResourceRecords).toEqual([{ Value: '10.0.0.1' }]);
  });

  it('value drift → ChangeResourceRecordSets UPSERT (update in place)', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        {
          Name: 'api.infraasprompt.internal.',
          Type: 'A',
          TTL: 60,
          ResourceRecords: [{ Value: '10.0.0.1' }],
        },
      ],
    });
    r53.on(ListTagsForResourceCommand).resolves(managedZoneTags);
    r53
      .on(ChangeResourceRecordSetsCommand)
      .resolves({ ChangeInfo: { Id: '/change/C2', Status: 'PENDING' } });

    const report = await executor().apply(recordPlan({ records: '10.0.0.2' }), { apply: true });

    expect(report.items[0]?.action).toBe('update');
    const rrs = r53.commandCalls(ChangeResourceRecordSetsCommand)[0]?.args[0].input?.ChangeBatch
      ?.Changes?.[0];
    expect(rrs?.Action).toBe('UPSERT');
    expect(rrs?.ResourceRecordSet?.ResourceRecords).toEqual([{ Value: '10.0.0.2' }]);
  });

  it('record TYPE change is IMMUTABLE → replace', async () => {
    // Live record is an A at the name; desired is a CNAME → identity drift.
    r53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        {
          Name: 'api.infraasprompt.internal.',
          Type: 'A',
          TTL: 60,
          ResourceRecords: [{ Value: '10.0.0.1' }],
        },
      ],
    });
    r53.on(ListTagsForResourceCommand).resolves(managedZoneTags);

    const report = await executor().plan(
      recordPlan({ recordType: 'CNAME', records: 'target.example.com' }),
    );
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy refuses a record whose parent zone is unmanaged (managed-only gate)', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        {
          Name: 'api.infraasprompt.internal.',
          Type: 'A',
          TTL: 60,
          ResourceRecords: [{ Value: '10.0.0.1' }],
        },
      ],
    });
    // Parent zone carries no iap:managed tag → the record is not ours to delete.
    r53.on(ListTagsForResourceCommand).resolves({ ResourceTagSet: { Tags: [] } });

    const report = await executor().apply(recordPlan(), { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
  });
});
