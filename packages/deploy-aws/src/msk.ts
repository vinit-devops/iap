/**
 * `aws:kafka:Cluster` handler (@aws-sdk/client-kafka) — the Stream kind's
 * managed-Kafka shape, realized as MSK SERVERLESS (M23.5). Serverless is the
 * cheapest/simplest MSK product: no broker sizing, no storage management, no
 * capacity planning — you pay per partition-hour + throughput and the service
 * owns the brokers. The mapping discriminates it from the Kinesis variant of
 * the Stream kind (see the yaml sketch in the M23.5 evidence).
 *
 * Identity: the CLUSTER NAME. MSK cluster ARNs are GENERATED (they embed a
 * random suffix), so identity is resolved by NAME via ListClustersV2
 * (paginated, ClusterName exact-match under a name-prefix filter); the
 * resolved clusterArn never leaves the handler (backup.ts idiom).
 *   read   → ListClustersV2 (paginate) → DescribeClusterV2 (state) +
 *            ListTagsForResource (cluster ARN). A cluster in DELETING state
 *            reads as absent (converging toward gone — recreate, don't
 *            reconcile); ACTIVE/CREATING exist. No name match → absent.
 *   create → CreateClusterV2 with a Serverless config: VpcConfigs over the
 *            default-VPC subnets (ADR-0005; MSK Serverless requires ≥2 subnets
 *            in DISTINCT AZs — fail closed below when fewer are available) +
 *            the default security group, and SASL/IAM client authentication
 *            (the only auth MSK Serverless supports). Tags applied at create.
 *   update → TagResource only. MSK Serverless exposes almost no mutable config
 *            in scope: the VPC/subnet/SG wiring and the auth mode are all
 *            create-time-fixed, so the managed projection is effectively
 *            identity + immutable network/auth. Any config drift is a REPLACE,
 *            never an in-place update (ADR-0006). Tags are the only thing that
 *            reconciles in place.
 *   delete → DeleteCluster by the name-resolved ARN.
 *
 * Projection / replacement (ADR-0006):
 *   - clusterType is the constant 'SERVERLESS' and is IMMUTABLE: a live
 *     PROVISIONED cluster under the same name is a DIFFERENT MSK product, so
 *     the flip classifies as replace (the natural replacement story here,
 *     analogous to the elasticache redis↔memcached engine flip).
 *   - subnetIds / securityGroupIds are IMMUTABLE and DESIRED-GATED: projected
 *     and compared only when the plan pins them (so a run that leaves the VPC
 *     wiring to the default-VPC resolver never reads its own choice as drift),
 *     and any change to a pinned value classifies as replace — MSK Serverless
 *     cannot re-home its VPC config in place.
 *   Beyond tags there is NO mutable surface: replacement is the whole story
 *     for any config drift.
 *
 * Outputs: identifier = clusterArn. The stream endpoint is the SASL/IAM
 * bootstrap-broker string, which is a SEPARATE GetBootstrapBrokers call and is
 * only populated once the cluster is ACTIVE — it is documentary here and not
 * fetched by the handler (create returns while the cluster is still CREATING).
 *
 * No in-handler waiter: MSK Serverless create/delete run many minutes; a live
 * driver would poll for terminal state out of band. This is a MOCK-PROVEN
 * handler (its LIVE evidence is deferred to a later sub-gate — MSK Serverless
 * is expensive and slow), so it just issues the calls.
 */

import {
  CreateClusterV2Command,
  DeleteClusterCommand,
  DescribeClusterV2Command,
  ListClustersV2Command,
  ListTagsForResourceCommand,
  TagResourceCommand,
} from '@aws-sdk/client-kafka';
import type { KafkaClient } from '@aws-sdk/client-kafka';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { Scalar } from '@iap/provider-sdk';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';
import { defaultSecurityGroupId, defaultSubnetIds } from './network.js';

const CLUSTER_TYPE = 'SERVERLESS' as const;

export class MskClusterHandler implements TargetHandler {
  static readonly targetType = 'aws:kafka:Cluster' as const;
  readonly targetType = MskClusterHandler.targetType;
  /**
   * MSK Serverless has no in-place config beyond tags: the Serverless↔
   * Provisioned product type and the VPC/subnet/SG wiring are all fixed at
   * create, so every projected config key is immutable → drift replaces.
   */
  readonly immutableProjectionKeys = ['clusterType', 'subnetIds', 'securityGroupIds'] as const;

  constructor(
    private readonly kafka: KafkaClient,
    private readonly ec2: EC2Client,
  ) {}

  /** Split a pinned comma/space-separated id list into a sorted id array. */
  private idList(value: Scalar | undefined): string[] {
    return scalarStr(value)
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
  }

  private csv(ids: readonly string[]): string {
    return [...ids].sort().join(',');
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    // Desired-gated: '' when the plan leaves the VPC wiring to the default-VPC
    // resolver, so the handler's own choice never reads back as drift.
    return {
      clusterType: CLUSTER_TYPE,
      subnetIds: this.csv(this.idList(a['subnetIds'])),
      securityGroupIds: this.csv(this.idList(a['securityGroupIds'])),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const arn = await this.resolveByName(name);
    if (arn === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const described = await this.kafka.send(new DescribeClusterV2Command({ ClusterArn: arn }));
    const info = described.ClusterInfo;
    // A cluster mid-teardown is on its way to absent; treating it as present
    // would produce calls the service rejects.
    if (info === undefined || info.State === 'DELETING') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tagResult = await this.kafka.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
    const tags = tagResult.Tags ?? {};

    const subnetsPinned = this.idList(resource.desiredAttributes['subnetIds']).length > 0;
    const sgsPinned = this.idList(resource.desiredAttributes['securityGroupIds']).length > 0;
    const vpc = info.Serverless?.VpcConfigs?.[0];

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        clusterType: info.ClusterType ?? CLUSTER_TYPE,
        subnetIds: subnetsPinned ? this.csv(vpc?.SubnetIds ?? []) : '',
        securityGroupIds: sgsPinned ? this.csv(vpc?.SecurityGroupIds ?? []) : '',
      },
    };
    state.identifier = arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const a = resource.desiredAttributes;

    // VPC wiring: pinned ids win, else the default-VPC subnets/SG (ADR-0005).
    const pinnedSubnets = this.idList(a['subnetIds']);
    const SubnetIds = pinnedSubnets.length > 0 ? pinnedSubnets : await defaultSubnetIds(this.ec2);
    // MSK Serverless demands ≥2 subnets across DISTINCT AZs — fail closed
    // rather than let the service reject a half-formed request.
    if (SubnetIds.length < 2) {
      throw new Error(
        `MSK Serverless cluster ${name} needs at least 2 subnets in different AZs ` +
          `(got ${SubnetIds.length}); the default VPC must span ≥2 AZs (ADR-0005)`,
      );
    }
    const pinnedSgs = this.idList(a['securityGroupIds']);
    const SecurityGroupIds =
      pinnedSgs.length > 0 ? pinnedSgs : [await defaultSecurityGroupId(this.ec2)];

    const created = await this.kafka.send(
      new CreateClusterV2Command({
        ClusterName: name,
        Serverless: {
          VpcConfigs: [{ SubnetIds, SecurityGroupIds }],
          // IAM is the only client-auth MSK Serverless supports.
          ClientAuthentication: { Sasl: { Iam: { Enabled: true } } },
        },
        Tags: tags,
      }),
    );
    return created.ClusterArn ?? `kafka:cluster/${name}`;
  }

  /**
   * MSK Serverless has no mutable config beyond tags (network + auth are
   * create-time-fixed, config drift replaces), so update only reconciles tags.
   */
  async update(_resource: PlanResource, current: ResourceState): Promise<void> {
    if (current.identifier !== undefined && Object.keys(current.tags).length > 0) {
      await this.kafka.send(
        new TagResourceCommand({ ResourceArn: current.identifier, Tags: current.tags }),
      );
    }
  }

  /** Delete by the name-resolved ARN (never a blind delete). */
  async delete(resource: PlanResource, current?: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const arn = current?.identifier ?? (await this.resolveByName(name));
    if (arn === undefined) {
      throw new Error(`msk cluster ${name} not found by name — refusing blind delete`);
    }
    await this.kafka.send(new DeleteClusterCommand({ ClusterArn: arn }));
  }

  /**
   * Name → generated-ARN resolution: paginate ListClustersV2 (narrowed by the
   * name prefix) until the page carrying an exact `ClusterName === name`. The
   * ARN never leaves the handler.
   */
  private async resolveByName(name: string): Promise<string | undefined> {
    let NextToken: string | undefined;
    do {
      const page = await this.kafka.send(
        new ListClustersV2Command({ ClusterNameFilter: name, NextToken }),
      );
      const match = (page.ClusterInfoList ?? []).find((c) => c.ClusterName === name);
      if (match?.ClusterArn !== undefined) return match.ClusterArn;
      NextToken = page.NextToken;
    } while (NextToken !== undefined);
    return undefined;
  }
}
