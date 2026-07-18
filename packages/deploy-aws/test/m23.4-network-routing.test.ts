/**
 * M23.4 network routing/egress handlers, mock-tested (no live AWS). Tag-identity
 * (iap:resourceId = plan logicalId) for InternetGateway / RouteTable /
 * NatGateway; TagSpecifications at create; cross-resource id references
 * (vpcId / subnetId / route targets) fail closed when a required one is absent.
 *
 * Coverage: IGW create+attach ordering + missing-vpcId fail-closed; IGW destroy
 * detaches BEFORE delete; IGW vpcId drift → replace; RouteTable create parses
 * routes → CreateRoute + associates; route drift → CreateRoute/DeleteRoute diff
 * (no replace); RouteTable vpcId drift → replace; NAT create allocates EIP THEN
 * CreateNatGateway + missing-subnetId fail-closed; NAT destroy deletes gateway
 * THEN releases EIP (bounded wait); NAT subnetId drift → replace; managed-only
 * destroy refusal for each; ambiguous tag-match fails closed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AllocateAddressCommand,
  AssociateRouteTableCommand,
  AttachInternetGatewayCommand,
  CreateInternetGatewayCommand,
  CreateNatGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  DeleteInternetGatewayCommand,
  DeleteNatGatewayCommand,
  DeleteRouteCommand,
  DeleteRouteTableCommand,
  DescribeAddressesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeRouteTablesCommand,
  DetachInternetGatewayCommand,
  DisassociateRouteTableCommand,
  EC2Client,
  ReleaseAddressCommand,
  ReplaceRouteCommand,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const ec2 = mockClient(EC2Client);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => ec2.reset());

const MANAGED = { Key: 'iap:managed', Value: 'true' };

// --------------------------------------------------------------------------
// InternetGateway
// --------------------------------------------------------------------------

const IGW_LOGICAL = 'egress-igw.aws:ec2:InternetGateway';
const igwPlan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('egress-igw', 'aws:ec2:InternetGateway', attrs)]);

describe('aws:ec2:InternetGateway', () => {
  it('absent → CreateInternetGateway (tagged) THEN AttachInternetGateway (order asserted)', async () => {
    ec2.on(DescribeInternetGatewaysCommand).resolves({ InternetGateways: [] });
    ec2.on(CreateInternetGatewayCommand).resolves({
      InternetGateway: { InternetGatewayId: 'igw-0new' },
    });
    ec2.on(AttachInternetGatewayCommand).resolves({});

    const report = await executor().apply(igwPlan({ vpcId: 'vpc-123' }), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe('igw-0new');

    // Identity read is tag-scoped to the plan logicalId.
    const filters =
      ec2.commandCalls(DescribeInternetGatewaysCommand)[0]?.args[0].input?.Filters ?? [];
    expect(filters).toContainEqual({ Name: 'tag:iap:resourceId', Values: [IGW_LOGICAL] });

    // Tags ride creation as TagSpecifications (incl. console Name).
    const spec = ec2.commandCalls(CreateInternetGatewayCommand)[0]?.args[0].input
      ?.TagSpecifications?.[0];
    expect(spec?.ResourceType).toBe('internet-gateway');
    const tagPairs = (spec?.Tags ?? []).map((t) => `${t.Key}=${t.Value}`);
    expect(tagPairs).toContain('iap:managed=true');
    expect(tagPairs).toContain(`iap:resourceId=${IGW_LOGICAL}`);
    expect(tagPairs).toContain('Name=egress-igw');

    const attach = ec2.commandCalls(AttachInternetGatewayCommand)[0]?.args[0].input;
    expect(attach?.InternetGatewayId).toBe('igw-0new');
    expect(attach?.VpcId).toBe('vpc-123');

    const order = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('CreateInternetGatewayCommand')).toBeLessThan(
      order.indexOf('AttachInternetGatewayCommand'),
    );
  });

  it('missing vpcId → fail closed: honest error, ZERO CreateInternetGateway', async () => {
    ec2.on(DescribeInternetGatewaysCommand).resolves({ InternetGateways: [] });

    const report = await executor().apply(igwPlan(), { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain("requires attribute 'vpcId'");
    expect(ec2.commandCalls(CreateInternetGatewayCommand)).toHaveLength(0);
  });

  it('destroy DETACHES from its attached vpc BEFORE delete (order asserted)', async () => {
    ec2.on(DescribeInternetGatewaysCommand).resolves({
      InternetGateways: [
        {
          InternetGatewayId: 'igw-0live',
          Attachments: [{ State: 'available', VpcId: 'vpc-123' }],
          Tags: [MANAGED, { Key: 'iap:resourceId', Value: IGW_LOGICAL }],
        },
      ],
    });
    ec2.on(DetachInternetGatewayCommand).resolves({});
    ec2.on(DeleteInternetGatewayCommand).resolves({});

    const report = await executor().apply(igwPlan({ vpcId: 'vpc-123' }), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    const detach = ec2.commandCalls(DetachInternetGatewayCommand)[0]?.args[0].input;
    expect(detach?.InternetGatewayId).toBe('igw-0live');
    expect(detach?.VpcId).toBe('vpc-123'); // the vpc read from LIVE state
    const order = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('DetachInternetGatewayCommand')).toBeLessThan(
      order.indexOf('DeleteInternetGatewayCommand'),
    );
  });

  it('vpcId drift (attached to a different VPC) → replace, never update', async () => {
    ec2.on(DescribeInternetGatewaysCommand).resolves({
      InternetGateways: [
        {
          InternetGatewayId: 'igw-0live',
          Attachments: [{ State: 'available', VpcId: 'vpc-OLD' }],
          Tags: [MANAGED, { Key: 'iap:resourceId', Value: IGW_LOGICAL }],
        },
      ],
    });

    const report = await executor().plan(igwPlan({ vpcId: 'vpc-NEW' }));

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
  });

  it('refuses to destroy an IGW NOT tagged iap:managed', async () => {
    ec2.on(DescribeInternetGatewaysCommand).resolves({
      InternetGateways: [
        {
          InternetGatewayId: 'igw-0live',
          Attachments: [{ State: 'available', VpcId: 'vpc-123' }],
          Tags: [{ Key: 'iap:resourceId', Value: IGW_LOGICAL }],
        },
      ],
    });

    const report = await executor().apply(igwPlan({ vpcId: 'vpc-123' }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(ec2.commandCalls(DetachInternetGatewayCommand)).toHaveLength(0);
    expect(ec2.commandCalls(DeleteInternetGatewayCommand)).toHaveLength(0);
  });

  it('two gateways carrying the identity tag → ambiguous, fails closed', async () => {
    ec2.on(DescribeInternetGatewaysCommand).resolves({
      InternetGateways: [{ InternetGatewayId: 'igw-a' }, { InternetGatewayId: 'igw-b' }],
    });

    await expect(executor().plan(igwPlan({ vpcId: 'vpc-123' }))).rejects.toThrow(
      /ambiguous internet-gateway identity/,
    );
  });
});

// --------------------------------------------------------------------------
// RouteTable
// --------------------------------------------------------------------------

const RT_LOGICAL = 'public-rt.aws:ec2:RouteTable';
const rtPlan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('public-rt', 'aws:ec2:RouteTable', attrs)]);

describe('aws:ec2:RouteTable', () => {
  it('absent → CreateRouteTable, routes serialization parsed into CreateRoute, then AssociateRouteTable', async () => {
    ec2.on(DescribeRouteTablesCommand).resolves({ RouteTables: [] });
    ec2.on(CreateRouteTableCommand).resolves({ RouteTable: { RouteTableId: 'rtb-0new' } });
    ec2.on(CreateRouteCommand).resolves({ Return: true });
    ec2.on(AssociateRouteTableCommand).resolves({ AssociationId: 'rtbassoc-0new' });

    const report = await executor().apply(
      rtPlan({
        vpcId: 'vpc-123',
        routes: '0.0.0.0/0:igw:igw-abc,10.1.0.0/16:nat:nat-xyz',
        subnetId: 'subnet-pub',
      }),
      { apply: true },
    );

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.identifier).toBe('rtb-0new');

    const create = ec2.commandCalls(CreateRouteTableCommand)[0]?.args[0].input;
    expect(create?.VpcId).toBe('vpc-123');
    expect(create?.TagSpecifications?.[0]?.ResourceType).toBe('route-table');

    // Each serialized entry → one CreateRoute with the right target kind.
    const routeInputs = ec2.commandCalls(CreateRouteCommand).map((c) => c.args[0].input);
    const igwRoute = routeInputs.find((r) => r?.DestinationCidrBlock === '0.0.0.0/0');
    expect(igwRoute?.GatewayId).toBe('igw-abc');
    expect(igwRoute?.NatGatewayId).toBeUndefined();
    const natRoute = routeInputs.find((r) => r?.DestinationCidrBlock === '10.1.0.0/16');
    expect(natRoute?.NatGatewayId).toBe('nat-xyz');
    expect(natRoute?.GatewayId).toBeUndefined();
    routeInputs.forEach((r) => expect(r?.RouteTableId).toBe('rtb-0new'));

    const assoc = ec2.commandCalls(AssociateRouteTableCommand)[0]?.args[0].input;
    expect(assoc?.RouteTableId).toBe('rtb-0new');
    expect(assoc?.SubnetId).toBe('subnet-pub');
  });

  it('route drift → CreateRoute (added) + DeleteRoute (removed), classified update (no replace)', async () => {
    // Live carries the OLD route; desired swaps it for a new CIDR — the local
    // route is AWS-managed and never touched.
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [
        {
          RouteTableId: 'rtb-0live',
          VpcId: 'vpc-123',
          Routes: [
            { DestinationCidrBlock: '172.16.0.0/12', GatewayId: 'local' },
            { DestinationCidrBlock: '10.9.0.0/16', GatewayId: 'igw-abc' },
          ],
          Associations: [],
          Tags: [MANAGED, { Key: 'iap:resourceId', Value: RT_LOGICAL }],
        },
      ],
    });
    ec2.on(CreateRouteCommand).resolves({ Return: true });
    ec2.on(DeleteRouteCommand).resolves({});

    const desired = rtPlan({ vpcId: 'vpc-123', routes: '0.0.0.0/0:igw:igw-abc' });

    const planned = await executor().plan(desired);
    expect(planned.items[0]?.action).toBe('update'); // routes are mutable

    const report = await executor().apply(desired, { apply: true });
    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);

    // The removed route is deleted, the new one created; the local route is untouched.
    const deleted = ec2
      .commandCalls(DeleteRouteCommand)
      .map((c) => c.args[0].input?.DestinationCidrBlock);
    expect(deleted).toEqual(['10.9.0.0/16']);
    const created = ec2
      .commandCalls(CreateRouteCommand)
      .map((c) => c.args[0].input?.DestinationCidrBlock);
    expect(created).toEqual(['0.0.0.0/0']);
    expect(ec2.commandCalls(ReplaceRouteCommand)).toHaveLength(0);
  });

  it('same CIDR, re-targeted gateway → ReplaceRoute (in-place update)', async () => {
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [
        {
          RouteTableId: 'rtb-0live',
          VpcId: 'vpc-123',
          Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-old' }],
          Associations: [],
          Tags: [MANAGED, { Key: 'iap:resourceId', Value: RT_LOGICAL }],
        },
      ],
    });
    ec2.on(ReplaceRouteCommand).resolves({});

    const report = await executor().apply(
      rtPlan({ vpcId: 'vpc-123', routes: '0.0.0.0/0:nat:nat-new' }),
      { apply: true },
    );

    expect(report.items[0]?.action).toBe('update');
    const replace = ec2.commandCalls(ReplaceRouteCommand)[0]?.args[0].input;
    expect(replace?.DestinationCidrBlock).toBe('0.0.0.0/0');
    expect(replace?.NatGatewayId).toBe('nat-new');
    expect(ec2.commandCalls(CreateRouteCommand)).toHaveLength(0);
    expect(ec2.commandCalls(DeleteRouteCommand)).toHaveLength(0);
  });

  it('vpcId drift → replace, never update', async () => {
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [
        {
          RouteTableId: 'rtb-0live',
          VpcId: 'vpc-OLD',
          Routes: [],
          Associations: [],
          Tags: [MANAGED, { Key: 'iap:resourceId', Value: RT_LOGICAL }],
        },
      ],
    });

    const report = await executor().plan(rtPlan({ vpcId: 'vpc-NEW' }));

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
  });

  it('destroy disassociates the subnet then DeleteRouteTable (order asserted)', async () => {
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [
        {
          RouteTableId: 'rtb-0live',
          VpcId: 'vpc-123',
          Routes: [],
          Associations: [
            { Main: true, RouteTableAssociationId: 'rtbassoc-main' },
            { Main: false, SubnetId: 'subnet-pub', RouteTableAssociationId: 'rtbassoc-sub' },
          ],
          Tags: [MANAGED, { Key: 'iap:resourceId', Value: RT_LOGICAL }],
        },
      ],
    });
    ec2.on(DisassociateRouteTableCommand).resolves({});
    ec2.on(DeleteRouteTableCommand).resolves({});

    const report = await executor().apply(rtPlan({ vpcId: 'vpc-123', subnetId: 'subnet-pub' }), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    // Only the non-main association is disassociated.
    const dis = ec2.commandCalls(DisassociateRouteTableCommand);
    expect(dis).toHaveLength(1);
    expect(dis[0]?.args[0].input?.AssociationId).toBe('rtbassoc-sub');
    const order = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('DisassociateRouteTableCommand')).toBeLessThan(
      order.indexOf('DeleteRouteTableCommand'),
    );
  });

  it('refuses to destroy a route table NOT tagged iap:managed', async () => {
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [
        {
          RouteTableId: 'rtb-0live',
          VpcId: 'vpc-123',
          Routes: [],
          Associations: [],
          Tags: [{ Key: 'iap:resourceId', Value: RT_LOGICAL }],
        },
      ],
    });

    const report = await executor().apply(rtPlan({ vpcId: 'vpc-123' }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(ec2.commandCalls(DeleteRouteTableCommand)).toHaveLength(0);
  });

  it('two route tables carrying the identity tag → ambiguous, fails closed', async () => {
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [{ RouteTableId: 'rtb-a' }, { RouteTableId: 'rtb-b' }],
    });

    await expect(executor().plan(rtPlan({ vpcId: 'vpc-123' }))).rejects.toThrow(
      /ambiguous route-table identity/,
    );
  });
});

// --------------------------------------------------------------------------
// NatGateway
// --------------------------------------------------------------------------

const NAT_LOGICAL = 'egress-nat.aws:ec2:NatGateway';
const natPlan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('egress-nat', 'aws:ec2:NatGateway', attrs)]);

describe('aws:ec2:NatGateway', () => {
  it('absent → AllocateAddress (EIP) THEN CreateNatGateway (order asserted), both tagged', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [] });
    ec2
      .on(AllocateAddressCommand)
      .resolves({ AllocationId: 'eipalloc-0new', PublicIp: '52.1.2.3' });
    ec2.on(CreateNatGatewayCommand).resolves({ NatGateway: { NatGatewayId: 'nat-0new' } });

    const report = await executor().apply(natPlan({ subnetId: 'subnet-pub' }), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.identifier).toBe('nat-0new');

    // NAT read uses `Filter` (not `Filters`), tag-scoped.
    const filter = ec2.commandCalls(DescribeNatGatewaysCommand)[0]?.args[0].input?.Filter ?? [];
    expect(filter).toContainEqual({ Name: 'tag:iap:resourceId', Values: [NAT_LOGICAL] });

    const alloc = ec2.commandCalls(AllocateAddressCommand)[0]?.args[0].input;
    expect(alloc?.Domain).toBe('vpc');
    expect(alloc?.TagSpecifications?.[0]?.ResourceType).toBe('elastic-ip');

    const create = ec2.commandCalls(CreateNatGatewayCommand)[0]?.args[0].input;
    expect(create?.SubnetId).toBe('subnet-pub');
    expect(create?.AllocationId).toBe('eipalloc-0new'); // the handler-owned EIP
    expect(create?.ConnectivityType).toBe('public');
    expect(create?.TagSpecifications?.[0]?.ResourceType).toBe('natgateway');

    const order = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('AllocateAddressCommand')).toBeLessThan(
      order.indexOf('CreateNatGatewayCommand'),
    );
  });

  it('missing subnetId → fail closed: honest error, ZERO AllocateAddress / CreateNatGateway', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [] });

    const report = await executor().apply(natPlan(), { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain("requires attribute 'subnetId'");
    expect(ec2.commandCalls(AllocateAddressCommand)).toHaveLength(0);
    expect(ec2.commandCalls(CreateNatGatewayCommand)).toHaveLength(0);
  });

  it('create failure releases the just-allocated EIP (no orphan billing) then fails closed', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [] });
    ec2.on(AllocateAddressCommand).resolves({ AllocationId: 'eipalloc-0new' });
    ec2
      .on(CreateNatGatewayCommand)
      .rejects(Object.assign(new Error('subnet not found'), { name: 'InvalidSubnetID.NotFound' }));
    ec2.on(ReleaseAddressCommand).resolves({});

    const report = await executor().apply(natPlan({ subnetId: 'subnet-pub' }), { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('subnet not found');
    // The orphaned EIP was released.
    expect(ec2.commandCalls(ReleaseAddressCommand)[0]?.args[0].input?.AllocationId).toBe(
      'eipalloc-0new',
    );
  });

  it('destroy DeleteNatGateway THEN (bounded wait) ReleaseAddress (order asserted)', async () => {
    // Identity read → live NAT; the waiter re-describe returns 'deleted' so it
    // completes on the first poll without sleeping.
    ec2
      .on(DescribeNatGatewaysCommand)
      .resolvesOnce({
        NatGateways: [
          {
            NatGatewayId: 'nat-0live',
            State: 'available',
            SubnetId: 'subnet-pub',
            ConnectivityType: 'public',
            NatGatewayAddresses: [{ AllocationId: 'eipalloc-0live' }],
            Tags: [MANAGED, { Key: 'iap:resourceId', Value: NAT_LOGICAL }],
          },
        ],
      })
      .resolves({ NatGateways: [{ NatGatewayId: 'nat-0live', State: 'deleted' }] });
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [
        { AllocationId: 'eipalloc-0live', Tags: [{ Key: 'iap:resourceId', Value: NAT_LOGICAL }] },
      ],
    });
    ec2.on(DeleteNatGatewayCommand).resolves({ NatGatewayId: 'nat-0live' });
    ec2.on(ReleaseAddressCommand).resolves({});

    const report = await executor().apply(natPlan({ subnetId: 'subnet-pub' }), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(ec2.commandCalls(DeleteNatGatewayCommand)[0]?.args[0].input?.NatGatewayId).toBe(
      'nat-0live',
    );
    // The handler-owned EIP MUST be released, or it bills once orphaned.
    expect(ec2.commandCalls(ReleaseAddressCommand)[0]?.args[0].input?.AllocationId).toBe(
      'eipalloc-0live',
    );
    const order = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('DeleteNatGatewayCommand')).toBeLessThan(
      order.indexOf('ReleaseAddressCommand'),
    );
    // The bounded waiter re-described the NAT between delete and release.
    expect(ec2.commandCalls(DescribeNatGatewaysCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('waiter treats `deleting` as EIP-bound: releases the EIP only after `deleted` (M23.4 live-bug regression)', async () => {
    // Live finding: a NAT in `deleting` STILL holds its EIP, so ReleaseAddress
    // there races AWS and fails. The waiter must poll `deleting` out (not merely
    // `pending`/`available`) before releasing.
    ec2
      .on(DescribeNatGatewaysCommand)
      // Identity read → live NAT.
      .resolvesOnce({
        NatGateways: [
          {
            NatGatewayId: 'nat-0live',
            State: 'available',
            SubnetId: 'subnet-pub',
            ConnectivityType: 'public',
            NatGatewayAddresses: [{ AllocationId: 'eipalloc-0live' }],
            Tags: [MANAGED, { Key: 'iap:resourceId', Value: NAT_LOGICAL }],
          },
        ],
      })
      // First waiter poll: still `deleting` → EIP bound → must keep waiting.
      .resolvesOnce({ NatGateways: [{ NatGatewayId: 'nat-0live', State: 'deleting' }] })
      // Second waiter poll: `deleted` → EIP freed → release now.
      .resolves({ NatGateways: [{ NatGatewayId: 'nat-0live', State: 'deleted' }] });
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [
        { AllocationId: 'eipalloc-0live', Tags: [{ Key: 'iap:resourceId', Value: NAT_LOGICAL }] },
      ],
    });
    ec2.on(DeleteNatGatewayCommand).resolves({ NatGatewayId: 'nat-0live' });
    ec2.on(ReleaseAddressCommand).resolves({});

    vi.useFakeTimers();
    try {
      const pending = executor().apply(natPlan({ subnetId: 'subnet-pub' }), {
        apply: true,
        destroy: true,
      });
      // Advance past the 10s inter-poll sleeps so the waiter reaches `deleted`.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      const report = await pending;

      expect(report.errors).toEqual([]);
      expect(report.items[0]?.applied).toBe(true);
      // The waiter re-described through `deleting` → `deleted` (identity read + ≥2 polls).
      expect(ec2.commandCalls(DescribeNatGatewaysCommand).length).toBeGreaterThanOrEqual(3);
      // The EIP was released exactly once, AFTER the gateway was fully deleted.
      expect(ec2.commandCalls(ReleaseAddressCommand)).toHaveLength(1);
      expect(ec2.commandCalls(ReleaseAddressCommand)[0]?.args[0].input?.AllocationId).toBe(
        'eipalloc-0live',
      );
      const order = ec2.calls().map((c) => c.args[0].constructor.name);
      expect(order.indexOf('DeleteNatGatewayCommand')).toBeLessThan(
        order.lastIndexOf('DescribeNatGatewaysCommand'),
      );
      expect(order.lastIndexOf('DescribeNatGatewaysCommand')).toBeLessThan(
        order.indexOf('ReleaseAddressCommand'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('subnetId drift → replace (NAT has no mutable attributes)', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({
      NatGateways: [
        {
          NatGatewayId: 'nat-0live',
          State: 'available',
          SubnetId: 'subnet-OLD',
          ConnectivityType: 'public',
          Tags: [MANAGED, { Key: 'iap:resourceId', Value: NAT_LOGICAL }],
        },
      ],
    });

    const report = await executor().plan(natPlan({ subnetId: 'subnet-NEW' }));

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
  });

  it('a deleting/deleted NAT reads absent → plan is create (never resurrected)', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({
      NatGateways: [{ NatGatewayId: 'nat-0dying', State: 'deleting', SubnetId: 'subnet-pub' }],
    });

    const report = await executor().plan(natPlan({ subnetId: 'subnet-pub' }));
    expect(report.items[0]?.action).toBe('create');
  });

  it('refuses to destroy a NAT NOT tagged iap:managed', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({
      NatGateways: [
        {
          NatGatewayId: 'nat-0live',
          State: 'available',
          SubnetId: 'subnet-pub',
          ConnectivityType: 'public',
          Tags: [{ Key: 'iap:resourceId', Value: NAT_LOGICAL }],
        },
      ],
    });

    const report = await executor().apply(natPlan({ subnetId: 'subnet-pub' }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(ec2.commandCalls(DeleteNatGatewayCommand)).toHaveLength(0);
    expect(ec2.commandCalls(ReleaseAddressCommand)).toHaveLength(0);
  });

  it('two live NATs carrying the identity tag → ambiguous, fails closed', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({
      NatGateways: [
        { NatGatewayId: 'nat-a', State: 'available' },
        { NatGatewayId: 'nat-b', State: 'available' },
      ],
    });

    await expect(executor().plan(natPlan({ subnetId: 'subnet-pub' }))).rejects.toThrow(
      /ambiguous NAT-gateway identity/,
    );
  });
});
