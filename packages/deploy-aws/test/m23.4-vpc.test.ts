/**
 * M23.4 core-network handlers, mock-tested. All three (Vpc, Subnet,
 * SecurityGroup) use TAG-BASED identity: ids are AWS-generated, so
 * `iap:resourceId` (value = plan logicalId) is the stable handle. DescribeXxx
 * filters on it; ambiguous multi-matches fail closed. cidrBlock (VPC),
 * vpcId/cidrBlock/availabilityZone (subnet), and vpcId/description (SG) are
 * immutable (gated replace, ADR-0006); DNS attrs, mapPublicIpOnLaunch, and
 * ingress/egress rules reconcile in place. Cross-resource vpcId is fail-closed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateTagsCommand,
  CreateVpcCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcAttributeCommand,
  DescribeVpcsCommand,
  EC2Client,
  ModifySubnetAttributeCommand,
  ModifyVpcAttributeCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const ec2 = mockClient(EC2Client);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => ec2.reset());

const VPC_ID = 'net.aws:ec2:Vpc';
const SUBNET_ID = 'app.aws:ec2:Subnet';
const SG_ID = 'web.aws:ec2:SecurityGroup';

const vpcPlan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('net', 'aws:ec2:Vpc', attrs)]);
const subnetPlan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('app', 'aws:ec2:Subnet', attrs)]);
const sgPlan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('web', 'aws:ec2:SecurityGroup', attrs)]);

/** One live VPC carrying the iap identity tags, with the given DNS state. */
function mockLiveVpc(
  opts: {
    cidr?: string;
    dnsSupport?: boolean;
    dnsHostnames?: boolean;
    managed?: boolean;
    tags?: Array<{ Key: string; Value: string }>;
  } = {},
): void {
  const tags = opts.tags ?? [
    { Key: 'iap:resourceId', Value: VPC_ID },
    ...(opts.managed === false ? [] : [{ Key: 'iap:managed', Value: 'true' }]),
  ];
  ec2.on(DescribeVpcsCommand).resolves({
    Vpcs: [
      {
        VpcId: 'vpc-0live',
        CidrBlock: opts.cidr ?? '10.42.0.0/16',
        State: 'available',
        Tags: tags,
      },
    ],
  });
  ec2
    .on(DescribeVpcAttributeCommand, { Attribute: 'enableDnsSupport' })
    .resolves({ EnableDnsSupport: { Value: opts.dnsSupport ?? true } });
  ec2
    .on(DescribeVpcAttributeCommand, { Attribute: 'enableDnsHostnames' })
    .resolves({ EnableDnsHostnames: { Value: opts.dnsHostnames ?? true } });
}

/** One live subnet carrying the iap identity tags. */
function mockLiveSubnet(overrides: Record<string, unknown> = {}): void {
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      {
        SubnetId: 'subnet-0live',
        VpcId: 'vpc-parent',
        CidrBlock: '10.42.1.0/24',
        AvailabilityZone: 'eu-central-1a',
        MapPublicIpOnLaunch: false,
        State: 'available',
        Tags: [
          { Key: 'iap:managed', Value: 'true' },
          { Key: 'iap:resourceId', Value: SUBNET_ID },
        ],
        ...overrides,
      },
    ],
  });
}

/** One live security group carrying the iap identity tags. */
function mockLiveSg(overrides: Record<string, unknown> = {}): void {
  ec2.on(DescribeSecurityGroupsCommand).resolves({
    SecurityGroups: [
      {
        GroupId: 'sg-0live',
        GroupName: 'web',
        Description: 'iap-managed',
        VpcId: 'vpc-parent',
        IpPermissions: [],
        IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
        Tags: [
          { Key: 'iap:managed', Value: 'true' },
          { Key: 'iap:resourceId', Value: SG_ID },
        ],
        ...overrides,
      },
    ],
  });
}

describe('aws:ec2:Vpc — tag-identity create', () => {
  it('absent → CreateVpc (default cidr) + ModifyVpcAttribute DNS + identity tags', async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [] });
    ec2.on(CreateVpcCommand).resolves({ Vpc: { VpcId: 'vpc-0new' } });
    ec2.on(ModifyVpcAttributeCommand).resolves({});

    const report = await executor().apply(vpcPlan(), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe('vpc-0new');

    const filters = ec2.commandCalls(DescribeVpcsCommand)[0]?.args[0].input?.Filters ?? [];
    expect(filters.find((f) => f.Name === 'tag:iap:resourceId')?.Values).toEqual([VPC_ID]);

    const create = ec2.commandCalls(CreateVpcCommand)[0]?.args[0].input;
    expect(create?.CidrBlock).toBe('10.42.0.0/16'); // default
    const tags = (create?.TagSpecifications?.[0]?.Tags ?? []).map((t) => `${t.Key}=${t.Value}`);
    expect(tags).toContain('iap:managed=true');
    expect(tags).toContain(`iap:resourceId=${VPC_ID}`);
    expect(tags).toContain('Name=net');

    // Both DNS attributes are enabled (default true), one ModifyVpcAttribute each.
    const mods = ec2.commandCalls(ModifyVpcAttributeCommand).map((c) => c.args[0].input);
    expect(mods.find((m) => m?.EnableDnsSupport)?.EnableDnsSupport?.Value).toBe(true);
    expect(mods.find((m) => m?.EnableDnsHostnames)?.EnableDnsHostnames?.Value).toBe(true);
  });

  it('cidrBlock drift classifies replace, never update (ADR-0006)', async () => {
    mockLiveVpc({ cidr: '10.0.0.0/16' });

    const report = await executor().plan(vpcPlan({ cidrBlock: '10.42.0.0/16' }));

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
  });

  it('DNS attribute drift reconciles in place via ModifyVpcAttribute (update)', async () => {
    mockLiveVpc({ dnsHostnames: false }); // live hostnames off, desired default on
    ec2.on(ModifyVpcAttributeCommand).resolves({});

    const planned = await executor().plan(vpcPlan());
    expect(planned.items[0]?.action).toBe('update');

    const report = await executor().apply(vpcPlan(), { apply: true });
    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    const mods = ec2.commandCalls(ModifyVpcAttributeCommand).map((c) => c.args[0].input);
    // Only the drifted attribute (hostnames) is modified; support already matches.
    expect(mods.some((m) => m?.EnableDnsHostnames?.Value === true)).toBe(true);
    expect(mods.some((m) => m?.EnableDnsSupport !== undefined)).toBe(false);
  });

  it('destroy refuses a VPC NOT tagged iap:managed (managed-only)', async () => {
    mockLiveVpc({ tags: [{ Key: 'iap:resourceId', Value: VPC_ID }] });

    const report = await executor().apply(vpcPlan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(ec2.commandCalls(DeleteVpcCommand)).toHaveLength(0);
  });

  it('destroy managed → DeleteVpc with the live id', async () => {
    mockLiveVpc();
    ec2.on(DeleteVpcCommand).resolves({});

    const report = await executor().apply(vpcPlan(), { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(ec2.commandCalls(DeleteVpcCommand)[0]?.args[0].input?.VpcId).toBe('vpc-0live');
  });

  it('multiple VPCs claiming one identity → fail closed (ambiguous)', async () => {
    ec2.on(DescribeVpcsCommand).resolves({
      Vpcs: [
        { VpcId: 'vpc-a', State: 'available' },
        { VpcId: 'vpc-b', State: 'available' },
      ],
    });

    await expect(executor().plan(vpcPlan())).rejects.toThrow(/ambiguous VPC identity/);
  });
});

describe('aws:ec2:Subnet — tag-identity create + cross-resource vpcId', () => {
  it('absent → CreateSubnet with vpcId/cidr, then ModifySubnetAttribute when public', async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [] });
    ec2.on(CreateSubnetCommand).resolves({ Subnet: { SubnetId: 'subnet-0new' } });
    ec2.on(ModifySubnetAttributeCommand).resolves({});

    const report = await executor().apply(
      subnetPlan({
        vpcId: 'vpc-parent',
        cidrBlock: '10.42.1.0/24',
        availabilityZone: 'eu-central-1a',
        mapPublicIpOnLaunch: 'true',
      }),
      { apply: true },
    );

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.identifier).toBe('subnet-0new');
    const create = ec2.commandCalls(CreateSubnetCommand)[0]?.args[0].input;
    expect(create?.VpcId).toBe('vpc-parent');
    expect(create?.CidrBlock).toBe('10.42.1.0/24');
    expect(create?.AvailabilityZone).toBe('eu-central-1a');
    const modify = ec2.commandCalls(ModifySubnetAttributeCommand)[0]?.args[0].input;
    expect(modify?.MapPublicIpOnLaunch?.Value).toBe(true);
  });

  it('missing vpcId → fail closed: honest error, ZERO CreateSubnet', async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [] });

    const report = await executor().apply(subnetPlan({ cidrBlock: '10.42.1.0/24' }), {
      apply: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('needs a vpcId attribute');
    expect(ec2.commandCalls(CreateSubnetCommand)).toHaveLength(0);
  });

  it('mapPublicIpOnLaunch drift reconciles in place (update)', async () => {
    mockLiveSubnet({ MapPublicIpOnLaunch: false });
    ec2.on(ModifySubnetAttributeCommand).resolves({});

    const attrs = { vpcId: 'vpc-parent', cidrBlock: '10.42.1.0/24', mapPublicIpOnLaunch: 'true' };
    const planned = await executor().plan(subnetPlan(attrs));
    expect(planned.items[0]?.action).toBe('update');

    const report = await executor().apply(subnetPlan(attrs), { apply: true });
    expect(report.errors).toEqual([]);
    expect(
      ec2.commandCalls(ModifySubnetAttributeCommand)[0]?.args[0].input?.MapPublicIpOnLaunch?.Value,
    ).toBe(true);
  });

  it('cidrBlock drift classifies replace (ADR-0006)', async () => {
    mockLiveSubnet({ CidrBlock: '10.42.9.0/24' });

    const report = await executor().plan(
      subnetPlan({ vpcId: 'vpc-parent', cidrBlock: '10.42.1.0/24' }),
    );
    expect(report.items[0]?.action).toBe('replace');
  });

  it('availabilityZone drift classifies replace when pinned (ADR-0006)', async () => {
    mockLiveSubnet({ AvailabilityZone: 'eu-central-1b' });

    const report = await executor().plan(
      subnetPlan({
        vpcId: 'vpc-parent',
        cidrBlock: '10.42.1.0/24',
        availabilityZone: 'eu-central-1a',
      }),
    );
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy managed → DeleteSubnet; refuses unmanaged', async () => {
    mockLiveSubnet();
    ec2.on(DeleteSubnetCommand).resolves({});
    const attrs = { vpcId: 'vpc-parent', cidrBlock: '10.42.1.0/24' };

    const ok = await executor().apply(subnetPlan(attrs), { apply: true, destroy: true });
    expect(ok.items[0]?.applied).toBe(true);
    expect(ec2.commandCalls(DeleteSubnetCommand)[0]?.args[0].input?.SubnetId).toBe('subnet-0live');

    ec2.reset();
    mockLiveSubnet({ Tags: [{ Key: 'iap:resourceId', Value: SUBNET_ID }] });
    const refused = await executor().apply(subnetPlan(attrs), { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.errors[0]).toContain('managed-only destroy');
  });

  it('multiple subnets claiming one identity → fail closed (ambiguous)', async () => {
    ec2.on(DescribeSubnetsCommand).resolves({
      Subnets: [
        { SubnetId: 'subnet-a', State: 'available' },
        { SubnetId: 'subnet-b', State: 'available' },
      ],
    });

    await expect(
      executor().plan(subnetPlan({ vpcId: 'vpc-parent', cidrBlock: '10.42.1.0/24' })),
    ).rejects.toThrow(/ambiguous subnet identity/);
  });
});

describe('aws:ec2:SecurityGroup — tag-identity create + rule serialization', () => {
  it('absent → CreateSecurityGroup + Authorize ingress from the compact rule spec', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    ec2.on(CreateSecurityGroupCommand).resolves({ GroupId: 'sg-0new' });
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});

    const report = await executor().apply(
      sgPlan({ vpcId: 'vpc-parent', ingress: 'tcp:443:0.0.0.0/0;tcp:80:0.0.0.0/0' }),
      { apply: true },
    );

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.identifier).toBe('sg-0new');
    const create = ec2.commandCalls(CreateSecurityGroupCommand)[0]?.args[0].input;
    expect(create?.GroupName).toBe('web');
    expect(create?.Description).toBe('iap-managed'); // default
    expect(create?.VpcId).toBe('vpc-parent');

    const authIn = ec2.commandCalls(AuthorizeSecurityGroupIngressCommand)[0]?.args[0].input;
    const perms = authIn?.IpPermissions ?? [];
    const ports = perms.map((p) => p.FromPort).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ports).toEqual([80, 443]);
    expect(perms.every((p) => p.IpRanges?.[0]?.CidrIp === '0.0.0.0/0')).toBe(true);
  });

  it('missing vpcId → fail closed: honest error, ZERO CreateSecurityGroup', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });

    const report = await executor().apply(sgPlan({ ingress: 'tcp:443:0.0.0.0/0' }), {
      apply: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('needs a vpcId attribute');
    expect(ec2.commandCalls(CreateSecurityGroupCommand)).toHaveLength(0);
  });

  it('ingress rule drift reconciles via revoke(removed)+authorize(added)', async () => {
    // Live has 80; desired has 443 only → revoke 80, authorize 443.
    mockLiveSg({
      IpPermissions: [
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      ],
    });
    ec2.on(RevokeSecurityGroupIngressCommand).resolves({});
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    ec2.on(CreateTagsCommand).resolves({});

    const attrs = { vpcId: 'vpc-parent', ingress: 'tcp:443:0.0.0.0/0' };
    const planned = await executor().plan(sgPlan(attrs));
    expect(planned.items[0]?.action).toBe('update');

    const report = await executor().apply(sgPlan(attrs), { apply: true });
    expect(report.errors).toEqual([]);
    expect(
      ec2.commandCalls(RevokeSecurityGroupIngressCommand)[0]?.args[0].input?.IpPermissions?.[0]
        ?.FromPort,
    ).toBe(80);
    expect(
      ec2.commandCalls(AuthorizeSecurityGroupIngressCommand)[0]?.args[0].input?.IpPermissions?.[0]
        ?.FromPort,
    ).toBe(443);
  });

  it('vpcId drift classifies replace (ADR-0006)', async () => {
    mockLiveSg({ VpcId: 'vpc-other' });

    const report = await executor().plan(sgPlan({ vpcId: 'vpc-parent' }));
    expect(report.items[0]?.action).toBe('replace');
  });

  it('unpinned ingress/egress → converged no-op (defaults never read as drift)', async () => {
    mockLiveSg();

    const report = await executor().plan(sgPlan({ vpcId: 'vpc-parent' }));
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('destroy managed → DeleteSecurityGroup; refuses unmanaged', async () => {
    mockLiveSg();
    ec2.on(DeleteSecurityGroupCommand).resolves({});

    const ok = await executor().apply(sgPlan({ vpcId: 'vpc-parent' }), {
      apply: true,
      destroy: true,
    });
    expect(ok.items[0]?.applied).toBe(true);
    expect(ec2.commandCalls(DeleteSecurityGroupCommand)[0]?.args[0].input?.GroupId).toBe(
      'sg-0live',
    );

    ec2.reset();
    mockLiveSg({ Tags: [{ Key: 'iap:resourceId', Value: SG_ID }] });
    const refused = await executor().apply(sgPlan({ vpcId: 'vpc-parent' }), {
      apply: true,
      destroy: true,
    });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.errors[0]).toContain('managed-only destroy');
  });

  it('multiple groups claiming one identity → fail closed (ambiguous)', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({
      SecurityGroups: [{ GroupId: 'sg-a' }, { GroupId: 'sg-b' }],
    });

    await expect(executor().plan(sgPlan({ vpcId: 'vpc-parent' }))).rejects.toThrow(
      /ambiguous security-group identity/,
    );
  });

  it('egress pinned to a specific rule → revokes AWS default allow-all at create', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    ec2.on(CreateSecurityGroupCommand).resolves({ GroupId: 'sg-0egress' });
    ec2.on(AuthorizeSecurityGroupEgressCommand).resolves({});
    ec2.on(RevokeSecurityGroupIngressCommand).resolves({});
    const { RevokeSecurityGroupEgressCommand } = await import('@aws-sdk/client-ec2');
    ec2.on(RevokeSecurityGroupEgressCommand).resolves({});

    const report = await executor().apply(
      sgPlan({ vpcId: 'vpc-parent', egress: 'tcp:443:10.0.0.0/8' }),
      { apply: true },
    );

    expect(report.errors).toEqual([]);
    // Desired egress authorized...
    expect(
      ec2.commandCalls(AuthorizeSecurityGroupEgressCommand)[0]?.args[0].input?.IpPermissions?.[0]
        ?.FromPort,
    ).toBe(443);
    // ...and the default allow-all (-1) revoked.
    const revoke = ec2.commandCalls(RevokeSecurityGroupEgressCommand)[0]?.args[0].input;
    expect(revoke?.IpPermissions?.[0]?.IpProtocol).toBe('-1');
  });
});
