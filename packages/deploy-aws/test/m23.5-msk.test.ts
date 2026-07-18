/**
 * M23.5 MSK Serverless handler, mock-tested: `aws:kafka:Cluster`.
 *
 * This handler ships MOCK-PROVEN; its LIVE evidence is DEFERRED to a later
 * roadmap sub-gate (MSK Serverless is expensive + slow to stand up), so these
 * mock tests are the correctness bar for the handler.
 *
 * Covers: serverless create (CreateClusterV2 Serverless config) with SASL/IAM
 * auth, default-VPC subnets (≥2 across AZs) + default SG, and the mandatory
 * tags; name → generated-ARN resolution across a paginated ListClustersV2
 * (match on page 2); converged no-op; clusterType flip (SERVERLESS↔PROVISIONED)
 * and pinned-VPC drift both classifying as REPLACE behind the replacement gate;
 * a DELETING cluster reading as absent; managed-only destroy refusal; destroy
 * by the name-resolved ARN; and the tags-only update (the sole mutable surface).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateClusterV2Command,
  DeleteClusterCommand,
  DescribeClusterV2Command,
  KafkaClient,
  ListClustersV2Command,
  ListTagsForResourceCommand,
  TagResourceCommand,
} from '@aws-sdk/client-kafka';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { MskClusterHandler } from '../src/msk.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const kafka = mockClient(KafkaClient);
const ec2 = mockClient(EC2Client);

const MANAGED = { 'iap:managed': 'true' };
const CLUSTER_ARN =
  'arn:aws:kafka:eu-central-1:000000000000:cluster/jarvis-events/8f1a2b3c-4d5e-6789-abcd-1234567890ab-s2';
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

function mockDefaultNetwork() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
      { SubnetId: 'subnet-c', AvailabilityZone: 'eu-central-1c' },
    ],
  });
  ec2
    .on(DescribeSecurityGroupsCommand)
    .resolves({ SecurityGroups: [{ GroupId: 'sg-default' }] });
}

beforeEach(() => {
  kafka.reset();
  ec2.reset();
});

const plan = providerPlan([planResource('jarvis-events', 'aws:kafka:Cluster')]);

/** Converged against the all-defaults plan (VPC wiring left to the resolver). */
const liveServerless = {
  ClusterName: 'jarvis-events',
  ClusterArn: CLUSTER_ARN,
  ClusterType: 'SERVERLESS',
  State: 'ACTIVE',
  Serverless: {
    VpcConfigs: [{ SubnetIds: ['subnet-a', 'subnet-b'], SecurityGroupIds: ['sg-default'] }],
    ClientAuthentication: { Sasl: { Iam: { Enabled: true } } },
  },
};

describe('aws:kafka:Cluster (MSK Serverless)', () => {
  it('absent → CreateClusterV2 Serverless with IAM auth, default-VPC subnets/SG, tags', async () => {
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [] });
    kafka.on(CreateClusterV2Command).resolves({ ClusterArn: CLUSTER_ARN });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(CLUSTER_ARN);

    const input = kafka.commandCalls(CreateClusterV2Command)[0]?.args[0].input;
    expect(input?.ClusterName).toBe('jarvis-events');
    // No Provisioned block — this is the SERVERLESS product.
    expect(input?.Provisioned).toBeUndefined();
    expect(input?.Serverless?.VpcConfigs?.[0]?.SubnetIds).toEqual([
      'subnet-a',
      'subnet-b',
      'subnet-c',
    ]);
    expect(input?.Serverless?.VpcConfigs?.[0]?.SecurityGroupIds).toEqual(['sg-default']);
    // IAM is the only client-auth MSK Serverless supports.
    expect(input?.Serverless?.ClientAuthentication?.Sasl?.Iam?.Enabled).toBe(true);
    expect(input?.Tags?.['iap:managed']).toBe('true');
  });

  it('name → generated-ARN resolution: matches on PAGE 2 of ListClustersV2 → converged no-op', async () => {
    kafka
      .on(ListClustersV2Command)
      .resolvesOnce({
        ClusterInfoList: [{ ClusterName: 'jarvis-other', ClusterArn: 'arn:other' }],
        NextToken: 'page-2',
      })
      .resolves({ ClusterInfoList: [liveServerless] });
    kafka.on(DescribeClusterV2Command).resolves({ ClusterInfo: liveServerless });
    kafka.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED });

    const report = await executor().plan(plan);

    expect(report.items[0]?.action).toBe('no-op');
    // The resolved ARN (page 2) is what DescribeClusterV2 is asked about.
    const described = kafka.commandCalls(DescribeClusterV2Command)[0]?.args[0].input;
    expect(described?.ClusterArn).toBe(CLUSTER_ARN);
    // Two ListClustersV2 pages were walked to reach the match.
    expect(kafka.commandCalls(ListClustersV2Command)).toHaveLength(2);
  });

  it('present + converged (single page) → no-op; unpinned VPC wiring never reads as drift', async () => {
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [liveServerless] });
    kafka.on(DescribeClusterV2Command).resolves({ ClusterInfo: liveServerless });
    kafka.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('clusterType flip (live PROVISIONED) is IMMUTABLE → replace; gate closed refuses', async () => {
    const provisioned = {
      ClusterName: 'jarvis-events',
      ClusterArn: CLUSTER_ARN,
      ClusterType: 'PROVISIONED',
      State: 'ACTIVE',
    };
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [provisioned] });
    kafka.on(DescribeClusterV2Command).resolves({ ClusterInfo: provisioned });
    kafka.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('replace');

    // apply: true WITHOUT replace: true → recorded refusal, zero mutations.
    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('refusing to replace');
    expect(kafka.commandCalls(DeleteClusterCommand)).toHaveLength(0);
    expect(kafka.commandCalls(CreateClusterV2Command)).toHaveLength(0);
  });

  it('pinned subnet drift is IMMUTABLE → replace; gate open → delete (resolved ARN) THEN create', async () => {
    const rehomed = providerPlan([
      planResource('jarvis-events', 'aws:kafka:Cluster', {
        subnetIds: 'subnet-x,subnet-y',
      }),
    ]);
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [liveServerless] });
    kafka.on(DescribeClusterV2Command).resolves({ ClusterInfo: liveServerless });
    kafka.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED });
    kafka.on(DeleteClusterCommand).resolves({});
    kafka.on(CreateClusterV2Command).resolves({ ClusterArn: CLUSTER_ARN });
    // Subnets are pinned; the recreate still resolves the default SG.
    mockDefaultNetwork();

    const planned = await executor().plan(rehomed);
    expect(planned.items[0]?.action).toBe('replace');

    const report = await executor().apply(rehomed, { apply: true, replace: true });
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);

    // Delete targets the name-resolved ARN, and happens BEFORE the recreate.
    expect(kafka.commandCalls(DeleteClusterCommand)[0]?.args[0].input?.ClusterArn).toBe(
      CLUSTER_ARN,
    );
    const order = kafka.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('DeleteClusterCommand')).toBeLessThan(
      order.indexOf('CreateClusterV2Command'),
    );
    // Recreate pins the new subnets.
    expect(
      kafka.commandCalls(CreateClusterV2Command)[0]?.args[0].input?.Serverless?.VpcConfigs?.[0]
        ?.SubnetIds,
    ).toEqual(['subnet-x', 'subnet-y']);
  });

  it("a cluster in DELETING state reads as absent → create classification", async () => {
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [liveServerless] });
    kafka
      .on(DescribeClusterV2Command)
      .resolves({ ClusterInfo: { ...liveServerless, State: 'DELETING' } });
    kafka.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create');
  });

  it('destroy refuses an unmanaged cluster (managed-only gate)', async () => {
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [liveServerless] });
    kafka.on(DescribeClusterV2Command).resolves({ ClusterInfo: liveServerless });
    kafka.on(ListTagsForResourceCommand).resolves({ Tags: {} });

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(kafka.commandCalls(DeleteClusterCommand)).toHaveLength(0);
  });

  it('destroy → DeleteCluster by the name-resolved ARN', async () => {
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [liveServerless] });
    kafka.on(DescribeClusterV2Command).resolves({ ClusterInfo: liveServerless });
    kafka.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED });
    kafka.on(DeleteClusterCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(kafka.commandCalls(DeleteClusterCommand)[0]?.args[0].input?.ClusterArn).toBe(
      CLUSTER_ARN,
    );
  });

  it('update reconciles tags in place via TagResource (the only mutable surface)', async () => {
    kafka.on(TagResourceCommand).resolves({});
    const handler = new MskClusterHandler(
      new KafkaClient({ region: 'eu-central-1' }),
      new EC2Client({ region: 'eu-central-1' }),
    );

    await handler.update(planResource('jarvis-events', 'aws:kafka:Cluster'), {
      exists: true,
      managed: true,
      tags: MANAGED,
      identifier: CLUSTER_ARN,
      projection: {},
    });

    const input = kafka.commandCalls(TagResourceCommand)[0]?.args[0].input;
    expect(input?.ResourceArn).toBe(CLUSTER_ARN);
    expect(input?.Tags).toEqual(MANAGED);
  });

  it('create fails closed when the default VPC spans fewer than 2 AZs', async () => {
    kafka.on(ListClustersV2Command).resolves({ ClusterInfoList: [] });
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
    ec2.on(DescribeSubnetsCommand).resolves({
      Subnets: [{ SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' }],
    });
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-default' }] });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('at least 2 subnets');
    expect(kafka.commandCalls(CreateClusterV2Command)).toHaveLength(0);
  });
});
