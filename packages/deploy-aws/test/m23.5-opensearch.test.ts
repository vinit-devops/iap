/**
 * M23.5 OpenSearch domain handler (`aws:opensearch:Domain`, SearchIndex kind),
 * mock-tested: cheapest single-node create (t3.small.search, gp3, encryption at
 * rest + node-to-node + EnforceHTTPS + tags), converged no-op with an unpinned
 * KMS key reading no drift, in-place UpdateDomainConfig on instanceType/volume
 * drift, the immutable engineVersion → gated replace, a deleting/Deleted domain
 * reading as absent, managed-only destroy refusal, and the 3-28-lowercase
 * DomainName fail-close.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AddTagsCommand,
  CreateDomainCommand,
  DeleteDomainCommand,
  DescribeDomainCommand,
  ListTagsCommand,
  OpenSearchClient,
  UpdateDomainConfigCommand,
} from '@aws-sdk/client-opensearch';
import type { DomainStatus } from '@aws-sdk/client-opensearch';
import { AwsExecutor } from '../src/index.js';
import { validateDomainName } from '../src/opensearch.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const opensearch = mockClient(OpenSearchClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => opensearch.reset());

const ARN = 'arn:aws:es:eu-central-1:000000000000:domain/search-catalog';
const managedTagList = [{ Key: 'iap:managed', Value: 'true' }];

/** A live, active, single-node domain at the handler's default posture. */
function liveDomain(overrides: Partial<DomainStatus> = {}): DomainStatus {
  return {
    DomainId: '000000000000/search-catalog',
    DomainName: 'search-catalog',
    ARN,
    Created: true,
    Deleted: false,
    Processing: false,
    EngineVersion: 'OpenSearch_2.11',
    Endpoint: 'search-catalog.eu-central-1.es.amazonaws.com',
    ClusterConfig: { InstanceType: 't3.small.search', InstanceCount: 1, ZoneAwarenessEnabled: false },
    EBSOptions: { EBSEnabled: true, VolumeType: 'gp3', VolumeSize: 10 },
    // AWS always reports an at-rest KMS key — the AWS-owned aws/opensearch key
    // when none was pinned. An unpinned plan must not read this as drift.
    EncryptionAtRestOptions: {
      Enabled: true,
      KmsKeyId: 'arn:aws:kms:eu-central-1:000000000000:key/aws-owned-opensearch',
    },
    NodeToNodeEncryptionOptions: { Enabled: true },
    DomainEndpointOptions: { EnforceHTTPS: true },
    DomainProcessingStatus: 'Active',
    ...overrides,
  } as DomainStatus;
}

const plan = providerPlan([planResource('search-catalog', 'aws:opensearch:Domain')]);

describe('aws:opensearch:Domain', () => {
  it('absent → CreateDomain at the cheapest single-node posture: t3.small.search, gp3, encryption at rest + node-to-node, EnforceHTTPS, tags', async () => {
    opensearch.on(DescribeDomainCommand).rejects(serviceError('ResourceNotFoundException'));
    opensearch.on(CreateDomainCommand).resolves({ DomainStatus: liveDomain() });

    const report = await executor().apply(plan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(ARN);
    const input = opensearch.commandCalls(CreateDomainCommand)[0]?.args[0].input;
    expect(input?.DomainName).toBe('search-catalog');
    expect(input?.EngineVersion).toBe('OpenSearch_2.11');
    // Cheapest posture: one node, no zone awareness.
    expect(input?.ClusterConfig?.InstanceType).toBe('t3.small.search');
    expect(input?.ClusterConfig?.InstanceCount).toBe(1);
    expect(input?.ClusterConfig?.ZoneAwarenessEnabled).toBe(false);
    // gp3 EBS at the small default footprint.
    expect(input?.EBSOptions?.EBSEnabled).toBe(true);
    expect(input?.EBSOptions?.VolumeType).toBe('gp3');
    expect(input?.EBSOptions?.VolumeSize).toBe(10);
    // Secure-by-default: encryption at rest, node-to-node, HTTPS enforced.
    expect(input?.EncryptionAtRestOptions?.Enabled).toBe(true);
    expect(input?.EncryptionAtRestOptions?.KmsKeyId).toBeUndefined(); // unpinned → AWS-owned key
    expect(input?.NodeToNodeEncryptionOptions?.Enabled).toBe(true);
    expect(input?.DomainEndpointOptions?.EnforceHTTPS).toBe(true);
    // Restrictive default access policy (deny anonymous es:*).
    expect(input?.AccessPolicies).toContain('"Effect":"Deny"');
    expect(input?.TagList?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(input?.TagList?.some((t) => t.Key === 'iap:planId')).toBe(true);
  });

  it('a pinned kmsKeyId flows through to EncryptionAtRestOptions on create', async () => {
    const pinned = providerPlan([
      planResource('search-catalog', 'aws:opensearch:Domain', {
        kmsKeyId: 'arn:aws:kms:eu-central-1:000000000000:key/customer-managed',
      }),
    ]);
    opensearch.on(DescribeDomainCommand).rejects(serviceError('ResourceNotFoundException'));
    opensearch.on(CreateDomainCommand).resolves({ DomainStatus: liveDomain() });

    await executor().apply(pinned, { apply: true });
    const input = opensearch.commandCalls(CreateDomainCommand)[0]?.args[0].input;
    expect(input?.EncryptionAtRestOptions?.KmsKeyId).toBe(
      'arn:aws:kms:eu-central-1:000000000000:key/customer-managed',
    );
  });

  it('present + converged → no-op; an unpinned KMS key is NOT drift', async () => {
    opensearch.on(DescribeDomainCommand).resolves({ DomainStatus: liveDomain() });
    opensearch.on(ListTagsCommand).resolves({ TagList: managedTagList });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(opensearch.commandCalls(CreateDomainCommand)).toHaveLength(0);
    expect(opensearch.commandCalls(UpdateDomainConfigCommand)).toHaveLength(0);
    expect(opensearch.commandCalls(DeleteDomainCommand)).toHaveLength(0);
  });

  it('instanceType + volumeSize drift → single UpdateDomainConfig in place (no replace) + AddTags', async () => {
    const scaled = providerPlan([
      planResource('search-catalog', 'aws:opensearch:Domain', {
        instanceType: 'm6g.large.search',
        volumeSizeGiB: 20,
      }),
    ]);
    opensearch.on(DescribeDomainCommand).resolves({ DomainStatus: liveDomain() }); // live: t3.small / 10
    opensearch.on(ListTagsCommand).resolves({ TagList: managedTagList });
    opensearch.on(UpdateDomainConfigCommand).resolves({});
    opensearch.on(AddTagsCommand).resolves({});

    const report = await executor().apply(scaled, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    expect(opensearch.commandCalls(UpdateDomainConfigCommand)).toHaveLength(1);
    const input = opensearch.commandCalls(UpdateDomainConfigCommand)[0]?.args[0].input;
    expect(input?.DomainName).toBe('search-catalog');
    expect(input?.ClusterConfig?.InstanceType).toBe('m6g.large.search');
    expect(input?.ClusterConfig?.InstanceCount).toBeUndefined(); // count not drifted
    expect(input?.EBSOptions?.VolumeSize).toBe(20);
    // Ownership tags re-asserted; nothing deleted (in-place, not a replace).
    expect(opensearch.commandCalls(AddTagsCommand)).toHaveLength(1);
    expect(opensearch.commandCalls(DeleteDomainCommand)).toHaveLength(0);
  });

  it('engineVersion drift is IMMUTABLE → plans replace; gate closed refuses; gate open deletes THEN creates', async () => {
    const bumped = providerPlan([
      planResource('search-catalog', 'aws:opensearch:Domain', { engineVersion: 'OpenSearch_2.13' }),
    ]);
    opensearch.on(DescribeDomainCommand).resolves({ DomainStatus: liveDomain() }); // live: 2.11
    opensearch.on(ListTagsCommand).resolves({ TagList: managedTagList });
    opensearch.on(DeleteDomainCommand).resolves({});
    opensearch.on(CreateDomainCommand).resolves({
      DomainStatus: liveDomain({ ARN: `${ARN}-new` }),
    });

    const planned = await executor().plan(bumped);
    expect(planned.items[0]?.action).toBe('replace');

    // Gate closed → refusal recorded, nothing destroyed.
    const refused = await executor().apply(bumped, { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(opensearch.commandCalls(DeleteDomainCommand)).toHaveLength(0);

    // Gate open → delete THEN create, in that order.
    const report = await executor().apply(bumped, { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(`${ARN}-new`);
    const mutations = opensearch
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'DeleteDomainCommand' || n === 'CreateDomainCommand');
    expect(mutations).toEqual(['DeleteDomainCommand', 'CreateDomainCommand']);
  });

  it('a domain with the Deleted flag set reads as absent (never updated, never resurrected)', async () => {
    opensearch.on(DescribeDomainCommand).resolves({ DomainStatus: liveDomain({ Deleted: true }) });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create'); // absent-in-progress
    expect(opensearch.commandCalls(ListTagsCommand)).toHaveLength(0); // not even a tag read
  });

  it('a domain in DomainProcessingStatus=Deleting reads as absent', async () => {
    opensearch
      .on(DescribeDomainCommand)
      .resolves({ DomainStatus: liveDomain({ DomainProcessingStatus: 'Deleting' }) });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create');
  });

  it('destroy → DeleteDomain on a managed domain', async () => {
    opensearch.on(DescribeDomainCommand).resolves({ DomainStatus: liveDomain() });
    opensearch.on(ListTagsCommand).resolves({ TagList: managedTagList });
    opensearch.on(DeleteDomainCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    const input = opensearch.commandCalls(DeleteDomainCommand)[0]?.args[0].input;
    expect(input?.DomainName).toBe('search-catalog');
  });

  it('destroy refuses an UNMANAGED domain: recorded refusal, zero DeleteDomain calls', async () => {
    opensearch.on(DescribeDomainCommand).resolves({ DomainStatus: liveDomain() });
    // No iap:managed tag → not ours → must not be deleted.
    opensearch.on(ListTagsCommand).resolves({ TagList: [{ Key: 'team', Value: 'search' }] });

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('refusing to delete');
    expect(opensearch.commandCalls(DeleteDomainCommand)).toHaveLength(0);
  });

  it('a resourceId that violates the 3-28 lowercase DomainName rule fails CLOSED: recorded error, zero CreateDomain', async () => {
    // 'SearchCatalogIndex' has uppercase letters — invalid DomainName.
    const invalid = providerPlan([planResource('SearchCatalogIndex', 'aws:opensearch:Domain')]);
    opensearch.on(DescribeDomainCommand).rejects(serviceError('ResourceNotFoundException'));

    const report = await executor().apply(invalid, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('invalid OpenSearch domain name');
    expect(opensearch.commandCalls(CreateDomainCommand)).toHaveLength(0);
    // The only call issued was the read — nothing mutated.
    expect(opensearch.calls().map((c) => c.args[0].constructor.name)).toEqual([
      'DescribeDomainCommand',
    ]);
  });

  it('validateDomainName accepts compliant names and rejects the shape violations', () => {
    expect(validateDomainName('search-catalog')).toBe('search-catalog');
    expect(() => validateDomainName('ab')).toThrow(/3-28/); // too short
    expect(() => validateDomainName('1search')).toThrow(); // must start with a letter
    expect(() => validateDomainName('Search')).toThrow(); // no uppercase
    expect(() => validateDomainName('search_catalog')).toThrow(); // no underscores
    expect(() => validateDomainName('a'.repeat(29))).toThrow(); // too long
  });
});
