/**
 * `aws:opensearch:Domain` handler (@aws-sdk/client-opensearch) — the
 * SearchIndex kind's managed Amazon OpenSearch Service domain (M23.5).
 *
 * read → DescribeDomain (ResourceNotFoundException → absent; a domain with the
 *        Deleted flag set, or DomainProcessingStatus=Deleting, is on its way
 *        out and reads as absent — never updated, never resurrected) + ListTags
 *        against the domain ARN.
 * create → CreateDomain at the CHEAPEST safe posture: a single-node
 *        t3.small.search on gp3 EBS, encryption at rest ON, node-to-node
 *        encryption ON, HTTPS enforced, and a restrictive default access
 *        policy. No dedicated masters, no zone awareness (single-AZ).
 * update → UpdateDomainConfig for the mutable knobs (instance type/count,
 *        volume size) + AddTags. The domain enters Processing while the change
 *        rolls out — slow, but in place (no replacement).
 * delete → DeleteDomain.
 *
 * NO in-handler waiter. A domain takes ~10-15 minutes to create and ~10-15
 * minutes to delete; the live-run driver polls DescribeDomain
 * (Processing → active with an Endpoint, then gone) out of band. This is the
 * priciest and slowest M23.5 resource — the live driver must budget ~30 min
 * round-trip and keep the domain lifetime as short as possible.
 *
 * DOMAIN NAME CONSTRAINT — AWS requires the DomainName to be 3-28 characters,
 * start with a lowercase letter, and contain only lowercase letters, numbers,
 * and hyphens. `DomainName = resourceIdOf(resource)`, so a plan whose
 * resourceId violates that shape must fail CLOSED at create/update rather than
 * hand AWS an invalid request — see `validateDomainName`. The live plan must
 * therefore use a compliant resourceId (e.g. `search-catalog`, not
 * `SearchCatalogIndex`).
 *
 * ENGINE VERSION is treated as IMMUTABLE for v1 (drift → gated replace,
 * ADR-0006). A version bump is really a separate control-plane operation
 * (UpgradeDomain / blue-green), not an UpdateDomainConfig field; wiring that
 * managed upgrade path is a later refinement (honest gap, noted in evidence).
 *
 * ENCRYPTION-AT-REST KMS key is desired-gated (DynamoDB SSE lesson): every
 * domain is encrypted at rest and reports a KmsKeyId on read (the AWS-owned
 * `aws/opensearch` key when none was pinned). A plan that does not pin
 * `kmsKeyId` must not read that default as drift, so the key projects as '' on
 * both sides unless the plan sets it.
 *
 * OUTPUTS — identifier is the domain ARN; the search endpoint is
 * DomainStatus.Endpoint (only present once the domain is active, which is why
 * the live driver polls for it). There is no connection secret: OpenSearch
 * domains authenticate via IAM / the resource access policy, not a
 * username/password pair.
 */

import {
  AddTagsCommand,
  CreateDomainCommand,
  DeleteDomainCommand,
  DescribeDomainCommand,
  ListTagsCommand,
  UpdateDomainConfigCommand,
} from '@aws-sdk/client-opensearch';
import type {
  ClusterConfig,
  EBSOptions,
  EncryptionAtRestOptions,
  OpenSearchClient,
} from '@aws-sdk/client-opensearch';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;

const DEFAULTS = {
  // OpenSearch (not legacy Elasticsearch); a current, cheap-eligible line.
  engineVersion: 'OpenSearch_2.11',
  // t3.small.search is the cheapest general-purpose instance type (~$0.036/hr).
  instanceType: 't3.small.search',
  instanceCount: '1',
  // gp3 minimum footprint for this instance family.
  volumeSizeGiB: '10',
} as const;

/**
 * A deliberately restrictive default access policy: deny anonymous es:*.
 * OpenSearch domains authenticate via IAM SigV4 governed by IAM identity
 * policies; this default simply refuses unauthenticated access. A real plan
 * supplies an account/role-scoped `accessPolicies` string (the mapping injects
 * it), which wins over this default.
 */
const DEFAULT_ACCESS_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Deny', Principal: { AWS: '*' }, Action: 'es:*', Resource: '*' }],
});

/** AWS DomainName rule: 3-28 chars, start lowercase letter, [a-z0-9-] only. */
const DOMAIN_NAME_RE = /^[a-z][a-z0-9-]{2,27}$/;

/**
 * Fail-closed guard for the derived DomainName. Throwing here (rather than
 * letting AWS reject the CreateDomain) surfaces the misconfigured resourceId
 * as a recorded per-resource error, mutating nothing.
 */
export function validateDomainName(name: string): string {
  if (!DOMAIN_NAME_RE.test(name)) {
    throw new Error(
      `invalid OpenSearch domain name '${name}': must be 3-28 characters, start with a ` +
        `lowercase letter, and contain only lowercase letters, numbers, and hyphens`,
    );
  }
  return name;
}

export class OpenSearchDomainHandler implements TargetHandler {
  static readonly targetType = 'aws:opensearch:Domain' as const;
  readonly targetType = OpenSearchDomainHandler.targetType;
  /**
   * Engine version cannot change in place in v1 — a version bump is a separate
   * UpgradeDomain / blue-green operation, so drift classifies as gated replace
   * (ADR-0006), never an UpdateDomainConfig.
   */
  readonly immutableProjectionKeys = ['engineVersion'] as const;

  constructor(private readonly opensearch: OpenSearchClient) {}

  /** True when the plan pins a specific at-rest KMS key (desired-gated compare). */
  private kmsPinned(resource: PlanResource): boolean {
    return resource.desiredAttributes['kmsKeyId'] !== undefined;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      engineVersion: scalarStr(a['engineVersion']) || DEFAULTS.engineVersion,
      instanceType: scalarStr(a['instanceType']) || DEFAULTS.instanceType,
      instanceCount: scalarStr(a['instanceCount']) || DEFAULTS.instanceCount,
      volumeSizeGiB: scalarStr(a['volumeSizeGiB']) || DEFAULTS.volumeSizeGiB,
      // Encryption is always on; only the KMS key compares, and only when pinned.
      encryptionKmsKeyId: this.kmsPinned(resource) ? scalarStr(a['kmsKeyId']) : '',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const DomainName = resourceIdOf(resource);
    let domain;
    try {
      const found = await this.opensearch.send(new DescribeDomainCommand({ DomainName }));
      domain = found.DomainStatus;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    // A domain being torn down is absent for convergence purposes — never
    // update or resurrect it (a create racing the deletion is the honest retry
    // signal once teardown completes).
    if (
      domain === undefined ||
      domain.Deleted === true ||
      domain.DomainProcessingStatus === 'Deleting'
    ) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = await this.readTags(domain.ARN);
    const projection: Record<string, string> = {
      engineVersion: domain.EngineVersion ?? '',
      instanceType: domain.ClusterConfig?.InstanceType ?? '',
      instanceCount:
        domain.ClusterConfig?.InstanceCount === undefined
          ? ''
          : String(domain.ClusterConfig.InstanceCount),
      volumeSizeGiB:
        domain.EBSOptions?.VolumeSize === undefined ? '' : String(domain.EBSOptions.VolumeSize),
      // Compare the AWS-owned/default key only when the plan pins a specific one.
      encryptionKmsKeyId: this.kmsPinned(resource)
        ? (domain.EncryptionAtRestOptions?.KmsKeyId ?? '')
        : '',
    };

    const state: ResourceState = { exists: true, managed: isManaged(tags), tags, projection };
    if (domain.ARN !== undefined) state.identifier = domain.ARN;
    return state;
  }

  private async readTags(arn: string | undefined): Promise<Record<string, string>> {
    if (arn === undefined) return {};
    const tagResult = await this.opensearch.send(new ListTagsCommand({ ARN: arn }));
    return fromTagList(tagResult.TagList ?? []);
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const DomainName = validateDomainName(resourceIdOf(resource));
    const d = this.desiredProjection(resource);
    const kmsKeyId = scalarStr(resource.desiredAttributes['kmsKeyId']);
    const accessPolicies =
      scalarStr(resource.desiredAttributes['accessPolicies']) || DEFAULT_ACCESS_POLICY;

    const encryption: EncryptionAtRestOptions = {
      Enabled: true,
      ...(kmsKeyId !== '' ? { KmsKeyId: kmsKeyId } : {}),
    };

    const created = await this.opensearch.send(
      new CreateDomainCommand({
        DomainName,
        EngineVersion: d['engineVersion'],
        ClusterConfig: {
          InstanceType: d['instanceType'] as ClusterConfig['InstanceType'],
          InstanceCount: Number(d['instanceCount']),
          // Single-AZ: cheapest posture; zone awareness needs ≥2 nodes.
          ZoneAwarenessEnabled: false,
        },
        EBSOptions: {
          EBSEnabled: true,
          VolumeType: 'gp3',
          VolumeSize: Number(d['volumeSizeGiB']),
        },
        EncryptionAtRestOptions: encryption,
        NodeToNodeEncryptionOptions: { Enabled: true },
        DomainEndpointOptions: { EnforceHTTPS: true },
        AccessPolicies: accessPolicies,
        TagList: toTagList(tags),
      }),
    );
    // No ACTIVE waiter — a domain takes ~10-15 min to come up; the live driver
    // polls DescribeDomain (Processing → active + Endpoint) out of band.
    return created.DomainStatus?.ARN ?? `opensearch:domain/${DomainName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const DomainName = validateDomainName(resourceIdOf(resource));
    const d = this.desiredProjection(resource);
    const live = current.projection;

    const cluster: ClusterConfig = {};
    if (d['instanceType'] !== live['instanceType']) {
      cluster.InstanceType = d['instanceType'] as ClusterConfig['InstanceType'];
    }
    if (d['instanceCount'] !== live['instanceCount']) {
      cluster.InstanceCount = Number(d['instanceCount']);
    }

    const changes: {
      ClusterConfig?: ClusterConfig;
      EBSOptions?: EBSOptions;
      EncryptionAtRestOptions?: EncryptionAtRestOptions;
    } = {};
    if (Object.keys(cluster).length > 0) changes.ClusterConfig = cluster;
    if (d['volumeSizeGiB'] !== live['volumeSizeGiB']) {
      changes.EBSOptions = {
        EBSEnabled: true,
        VolumeType: 'gp3',
        VolumeSize: Number(d['volumeSizeGiB']),
      };
    }
    if (this.kmsPinned(resource) && d['encryptionKmsKeyId'] !== live['encryptionKmsKeyId']) {
      changes.EncryptionAtRestOptions = { Enabled: true, KmsKeyId: d['encryptionKmsKeyId'] };
    }

    if (Object.keys(changes).length > 0) {
      // UpdateDomainConfig is in-place but slow — the domain enters Processing
      // while the change rolls out. No waiter here (matching repo idiom).
      await this.opensearch.send(new UpdateDomainConfigCommand({ DomainName, ...changes }));
    }
    // Re-assert ownership tags on the live domain (repo idiom).
    if (current.identifier !== undefined) {
      await this.opensearch.send(
        new AddTagsCommand({ ARN: current.identifier, TagList: toTagList(current.tags) }),
      );
    }
  }

  async delete(resource: PlanResource, _current: ResourceState): Promise<void> {
    const DomainName = resourceIdOf(resource);
    // No waiter — a domain takes ~10-15 min to delete; the live driver polls
    // DescribeDomain until it is gone.
    await this.opensearch.send(new DeleteDomainCommand({ DomainName }));
  }
}
