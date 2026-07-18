/**
 * M23.4 — VPC + core network (Network kind) handlers (@aws-sdk/client-ec2).
 *
 * IDENTITY (all three): VPC / subnet / security-group ids are AWS-generated, so
 * each handler OWNS THE `iap:resourceId` TAG as its stable identity — read
 * filters DescribeXxx on `tag:iap:resourceId=<logicalId>` (the exact value
 * buildTags stamps at creation), TagSpecifications carry every tag at create,
 * and a `Name` tag (= resourceId) is set for console humans. MORE THAN ONE
 * match is an ambiguous identity and fails closed with a loud error — the
 * handler never guesses which resource it owns. A resource in a deleting/deleted
 * lifecycle state reads as ABSENT (never resurrected).
 *
 * VpcHandler ('aws:ec2:Vpc'):
 *   create → CreateVpc (CidrBlock, default 10.42.0.0/16) then ModifyVpcAttribute
 *            enableDnsSupport / enableDnsHostnames (both default true).
 *   read   → DescribeVpcs (tag + state filter) + DescribeVpcAttribute ×2.
 *   update → ModifyVpcAttribute for drifted DNS attrs.
 *   delete → DeleteVpc. outputs identifier = VpcId.
 *   IMMUTABLE: cidrBlock (→ gated replace). MUTABLE: enableDnsSupport,
 *   enableDnsHostnames.
 *
 * SubnetHandler ('aws:ec2:Subnet'):
 *   vpcId arrives as a desired attribute (cross-resource ref to the parent
 *   VPC's VpcId output) — fail closed when missing (timestream databaseName
 *   idiom). create → CreateSubnet (VpcId, CidrBlock, optional AvailabilityZone)
 *   then ModifySubnetAttribute mapPublicIpOnLaunch. read → DescribeSubnets.
 *   update → ModifySubnetAttribute. delete → DeleteSubnet. identifier = SubnetId.
 *   IMMUTABLE: vpcId, cidrBlock, availabilityZone (→ replace; AZ participates in
 *   drift only when the plan pins it). MUTABLE: mapPublicIpOnLaunch.
 *
 * SecurityGroupHandler ('aws:ec2:SecurityGroup'):
 *   vpcId arrives as a desired attribute — fail closed when missing. create →
 *   CreateSecurityGroup (GroupName = resourceId, Description default
 *   'iap-managed', VpcId) then Authorize ingress/egress from the compact rule
 *   spec. read → DescribeSecurityGroups. update → reconcile rules
 *   (revoke removed + authorize added) + CreateTags. delete →
 *   DeleteSecurityGroup. identifier = GroupId.
 *   IMMUTABLE: vpcId, description (AWS cannot change a SG description in place —
 *   both → replace). MUTABLE: ingress / egress rules.
 *
 * SECURITY-GROUP RULE SERIALIZATION — a compact, order-insensitive string:
 *   `<protocol>:<port>:<cidr>` rules joined by `;`, e.g.
 *     'tcp:443:0.0.0.0/0;tcp:80:0.0.0.0/0'
 *   `<port>` is a single port (`443`), an inclusive range (`80-443`), or `all`
 *   / `*` (used with protocol `-1`, all ports). Both the desired spec and the
 *   live rules are canonicalized (per-rule key `<proto>:<portToken>:<cidr>`,
 *   sorted, `;`-joined) before comparison, so ordering and port-range spelling
 *   never register as drift. Only IPv4 CIDR ranges are modelled in v1 (IPv6,
 *   security-group sources, and prefix lists are out of scope). A malformed
 *   rule (not exactly three `:`-separated fields) fails closed.
 *   Ingress default: no rules. Egress default: AWS's own allow-all
 *   (`-1:all:0.0.0.0/0`) — left untouched unless `egress` is pinned. Both
 *   `ingress` and `egress` are desired-gated: an unpinned attribute compares
 *   '' on both sides and never registers as drift (SQS managed-SSE idiom).
 */

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
  ModifySubnetAttributeCommand,
  ModifyVpcAttributeCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import type { EC2Client, IpPermission } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { RESOURCE_TAG_KEY, fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

/** VPC / subnet lifecycle states that count as "live" for identity resolution. */
const LIVE_STATES = ['pending', 'available'] as const;

const DEFAULT_VPC_CIDR = '10.42.0.0/16';

/** AWS's own default egress rule (all protocols, all destinations). */
const DEFAULT_EGRESS_CANONICAL = '-1:all:0.0.0.0/0';

export class VpcHandler implements TargetHandler {
  static readonly targetType = 'aws:ec2:Vpc' as const;
  readonly targetType = VpcHandler.targetType;
  /** A VPC's CIDR is fixed at creation (ADR-0006) — drift replaces. */
  readonly immutableProjectionKeys = ['cidrBlock'] as const;

  constructor(private readonly ec2: EC2Client) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      cidrBlock: scalarStr(a['cidrBlock']) || DEFAULT_VPC_CIDR,
      enableDnsSupport: scalarStr(a['enableDnsSupport']) || 'true',
      enableDnsHostnames: scalarStr(a['enableDnsHostnames']) || 'true',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const found = await this.ec2.send(
      new DescribeVpcsCommand({
        Filters: [
          { Name: `tag:${RESOURCE_TAG_KEY}`, Values: [resource.logicalId] },
          { Name: 'state', Values: [...LIVE_STATES] },
        ],
      }),
    );
    // Defensive client-side re-filter: a VPC in any non-live state reads absent.
    const vpcs = (found.Vpcs ?? []).filter((v) =>
      LIVE_STATES.some((s) => s === (v.State ?? '')),
    );
    if (vpcs.length > 1) {
      throw new Error(
        `ambiguous VPC identity: ${vpcs.length} VPCs carry ${RESOURCE_TAG_KEY}=` +
          `${resource.logicalId} (${vpcs.map((v) => v.VpcId ?? '?').join(', ')}) — ` +
          'refusing to guess; resolve the duplicate manually (fail closed)',
      );
    }
    const vpc = vpcs[0];
    if (vpc === undefined || vpc.VpcId === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    // DescribeVpcs never carries the DNS attributes — they need their own reads.
    const [dnsSupport, dnsHostnames] = await Promise.all([
      this.ec2.send(
        new DescribeVpcAttributeCommand({ VpcId: vpc.VpcId, Attribute: 'enableDnsSupport' }),
      ),
      this.ec2.send(
        new DescribeVpcAttributeCommand({ VpcId: vpc.VpcId, Attribute: 'enableDnsHostnames' }),
      ),
    ]);

    const tags = fromTagList(vpc.Tags ?? []);
    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: vpc.VpcId,
      projection: {
        cidrBlock: vpc.CidrBlock ?? '',
        enableDnsSupport: String(dnsSupport.EnableDnsSupport?.Value ?? false),
        enableDnsHostnames: String(dnsHostnames.EnableDnsHostnames?.Value ?? false),
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const d = this.desiredProjection(resource);
    const created = await this.ec2.send(
      new CreateVpcCommand({
        CidrBlock: d['cidrBlock'],
        TagSpecifications: [
          { ResourceType: 'vpc', Tags: toTagList({ Name: resourceIdOf(resource), ...tags }) },
        ],
      }),
    );
    const vpcId = created.Vpc?.VpcId;
    if (vpcId === undefined) {
      throw new Error(`CreateVpc for ${resource.logicalId} returned no VpcId (fail closed)`);
    }
    // DNS attributes can only be set one at a time, after the VPC exists.
    await this.ec2.send(
      new ModifyVpcAttributeCommand({
        VpcId: vpcId,
        EnableDnsSupport: { Value: d['enableDnsSupport'] !== 'false' },
      }),
    );
    await this.ec2.send(
      new ModifyVpcAttributeCommand({
        VpcId: vpcId,
        EnableDnsHostnames: { Value: d['enableDnsHostnames'] !== 'false' },
      }),
    );
    return vpcId;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const VpcId = this.idOf(resource, current, 'VPC');
    const d = this.desiredProjection(resource);
    const live = current.projection;
    if (d['enableDnsSupport'] !== (live['enableDnsSupport'] ?? '')) {
      await this.ec2.send(
        new ModifyVpcAttributeCommand({
          VpcId,
          EnableDnsSupport: { Value: d['enableDnsSupport'] !== 'false' },
        }),
      );
    }
    if (d['enableDnsHostnames'] !== (live['enableDnsHostnames'] ?? '')) {
      await this.ec2.send(
        new ModifyVpcAttributeCommand({
          VpcId,
          EnableDnsHostnames: { Value: d['enableDnsHostnames'] !== 'false' },
        }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    await this.ec2.send(new DeleteVpcCommand({ VpcId: this.idOf(resource, current, 'VPC') }));
  }

  private idOf(resource: PlanResource, current: ResourceState, what: string): string {
    if (current.identifier === undefined) {
      throw new Error(
        `no ${what} id resolved for ${resource.logicalId} — cannot mutate without its ` +
          'read-resolved identity (fail closed)',
      );
    }
    return current.identifier;
  }
}

export class SubnetHandler implements TargetHandler {
  static readonly targetType = 'aws:ec2:Subnet' as const;
  readonly targetType = SubnetHandler.targetType;
  /** Placement is fixed at creation (ADR-0006) — drift replaces. */
  readonly immutableProjectionKeys = ['vpcId', 'cidrBlock', 'availabilityZone'] as const;

  constructor(private readonly ec2: EC2Client) {}

  /** The parent VPC is a cross-resource reference — fail closed without it. */
  private vpcId(resource: PlanResource): string {
    const vpcId = scalarStr(resource.desiredAttributes['vpcId']);
    if (vpcId === '') {
      throw new Error(
        `aws:ec2:Subnet ${resource.logicalId} needs a vpcId attribute ` +
          '(the parent aws:ec2:Vpc VpcId) — refusing to guess (fail closed)',
      );
    }
    return vpcId;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    const az = scalarStr(a['availabilityZone']);
    return {
      vpcId: this.vpcId(resource),
      cidrBlock: scalarStr(a['cidrBlock']),
      mapPublicIpOnLaunch: scalarStr(a['mapPublicIpOnLaunch']) || 'false',
      // Only a PINNED AZ participates in drift; a derived one never drifts.
      ...(az !== '' ? { availabilityZone: az } : {}),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const found = await this.ec2.send(
      new DescribeSubnetsCommand({
        Filters: [
          { Name: `tag:${RESOURCE_TAG_KEY}`, Values: [resource.logicalId] },
          { Name: 'state', Values: [...LIVE_STATES] },
        ],
      }),
    );
    const subnets = (found.Subnets ?? []).filter((s) =>
      LIVE_STATES.some((st) => st === (s.State ?? '')),
    );
    if (subnets.length > 1) {
      throw new Error(
        `ambiguous subnet identity: ${subnets.length} subnets carry ${RESOURCE_TAG_KEY}=` +
          `${resource.logicalId} (${subnets.map((s) => s.SubnetId ?? '?').join(', ')}) — ` +
          'refusing to guess; resolve the duplicate manually (fail closed)',
      );
    }
    const subnet = subnets[0];
    if (subnet === undefined || subnet.SubnetId === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromTagList(subnet.Tags ?? []);
    const azPinned = scalarStr(resource.desiredAttributes['availabilityZone']) !== '';
    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: subnet.SubnetId,
      projection: {
        vpcId: subnet.VpcId ?? '',
        cidrBlock: subnet.CidrBlock ?? '',
        mapPublicIpOnLaunch: String(subnet.MapPublicIpOnLaunch ?? false),
        ...(azPinned ? { availabilityZone: subnet.AvailabilityZone ?? '' } : {}),
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const d = this.desiredProjection(resource);
    const cidrBlock = d['cidrBlock'] ?? '';
    if (cidrBlock === '') {
      throw new Error(
        `aws:ec2:Subnet ${resource.logicalId} needs a cidrBlock attribute ` +
          '(no default subnet CIDR is baked in) — refusing to guess (fail closed)',
      );
    }
    const az = d['availabilityZone'];
    const created = await this.ec2.send(
      new CreateSubnetCommand({
        VpcId: d['vpcId'],
        CidrBlock: cidrBlock,
        // AZ omitted entirely when unpinned — AWS picks one in the VPC's region.
        ...(az !== undefined && az !== '' ? { AvailabilityZone: az } : {}),
        TagSpecifications: [
          { ResourceType: 'subnet', Tags: toTagList({ Name: resourceIdOf(resource), ...tags }) },
        ],
      }),
    );
    const subnetId = created.Subnet?.SubnetId;
    if (subnetId === undefined) {
      throw new Error(`CreateSubnet for ${resource.logicalId} returned no SubnetId (fail closed)`);
    }
    // AWS subnets default MapPublicIpOnLaunch=false — only flip it when pinned true.
    if (d['mapPublicIpOnLaunch'] === 'true') {
      await this.ec2.send(
        new ModifySubnetAttributeCommand({
          SubnetId: subnetId,
          MapPublicIpOnLaunch: { Value: true },
        }),
      );
    }
    return subnetId;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const SubnetId = current.identifier;
    if (SubnetId === undefined) {
      throw new Error(
        `no subnet id resolved for ${resource.logicalId} — cannot mutate (fail closed)`,
      );
    }
    // mapPublicIpOnLaunch is the only mutable key the classifier routes here.
    const desired = this.desiredProjection(resource)['mapPublicIpOnLaunch'];
    await this.ec2.send(
      new ModifySubnetAttributeCommand({
        SubnetId,
        MapPublicIpOnLaunch: { Value: desired === 'true' },
      }),
    );
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    if (current.identifier === undefined) {
      throw new Error(
        `no subnet id resolved for ${resource.logicalId} — cannot delete (fail closed)`,
      );
    }
    await this.ec2.send(new DeleteSubnetCommand({ SubnetId: current.identifier }));
  }
}

/** A single parsed security-group rule (IPv4 CIDR source/destination). */
interface SgRule {
  protocol: string;
  /** Undefined for protocol -1 / `all` ports. */
  fromPort?: number;
  toPort?: number;
  cidr: string;
}

/** Parse ONE `<proto>:<port>:<cidr>` token; malformed → fail closed. */
function parseRule(token: string): SgRule {
  const parts = token.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `malformed security-group rule '${token}' — expected '<protocol>:<port>:<cidr>' ` +
        "(e.g. 'tcp:443:0.0.0.0/0'); refusing (fail closed)",
    );
  }
  const [protocol, portToken, cidr] = parts as [string, string, string];
  if (protocol === '-1' || portToken === 'all' || portToken === '*') {
    return { protocol, cidr };
  }
  if (portToken.includes('-')) {
    const [from, to] = portToken.split('-') as [string, string];
    return { protocol, fromPort: Number(from), toPort: Number(to), cidr };
  }
  const port = Number(portToken);
  return { protocol, fromPort: port, toPort: port, cidr };
}

/** The order-insensitive canonical key for a rule (drift-stable). */
function ruleKey(rule: SgRule): string {
  const portToken =
    rule.fromPort === undefined
      ? 'all'
      : rule.fromPort === rule.toPort
        ? String(rule.fromPort)
        : `${rule.fromPort}-${rule.toPort}`;
  return `${rule.protocol}:${portToken}:${rule.cidr}`;
}

/** Canonicalize a compact rule spec (sorted keys joined by `;`); '' → ''. */
function canonicalizeSpec(spec: string): string {
  const tokens = spec.split(';').map((t) => t.trim()).filter((t) => t !== '');
  return [...new Set(tokens.map((t) => ruleKey(parseRule(t))))].sort().join(';');
}

/** Flatten live IpPermissions to canonical keys (one per CIDR range). */
function canonicalizePermissions(perms: readonly IpPermission[]): string {
  const keys: string[] = [];
  for (const perm of perms) {
    const protocol = perm.IpProtocol ?? '-1';
    for (const range of perm.IpRanges ?? []) {
      if (range.CidrIp === undefined) continue;
      const rule: SgRule = { protocol, cidr: range.CidrIp };
      if (protocol !== '-1' && perm.FromPort !== undefined) {
        rule.fromPort = perm.FromPort;
        rule.toPort = perm.ToPort ?? perm.FromPort;
      }
      keys.push(ruleKey(rule));
    }
  }
  return [...new Set(keys)].sort().join(';');
}

/** Build the AWS IpPermission wire shape from a parsed rule. */
function toIpPermission(rule: SgRule): IpPermission {
  return {
    IpProtocol: rule.protocol,
    ...(rule.fromPort !== undefined ? { FromPort: rule.fromPort, ToPort: rule.toPort } : {}),
    IpRanges: [{ CidrIp: rule.cidr }],
  };
}

/** Parse a canonical/compact rule string into a keyed rule map. */
function ruleMap(spec: string): Map<string, SgRule> {
  const map = new Map<string, SgRule>();
  for (const token of spec.split(';').map((t) => t.trim()).filter((t) => t !== '')) {
    const rule = parseRule(token);
    map.set(ruleKey(rule), rule);
  }
  return map;
}

export class SecurityGroupHandler implements TargetHandler {
  static readonly targetType = 'aws:ec2:SecurityGroup' as const;
  readonly targetType = SecurityGroupHandler.targetType;
  /** A SG cannot change its VPC or (in AWS) its description — both replace. */
  readonly immutableProjectionKeys = ['vpcId', 'description'] as const;

  constructor(private readonly ec2: EC2Client) {}

  /** The parent VPC is a cross-resource reference — fail closed without it. */
  private vpcId(resource: PlanResource): string {
    const vpcId = scalarStr(resource.desiredAttributes['vpcId']);
    if (vpcId === '') {
      throw new Error(
        `aws:ec2:SecurityGroup ${resource.logicalId} needs a vpcId attribute ` +
          '(the parent aws:ec2:Vpc VpcId) — refusing to guess (fail closed)',
      );
    }
    return vpcId;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    const ingressPinned = a['ingress'] !== undefined;
    const egressPinned = a['egress'] !== undefined;
    return {
      vpcId: this.vpcId(resource),
      description: scalarStr(a['description']) || 'iap-managed',
      // Desired-gated: an unpinned ruleset compares '' both sides (no drift),
      // so the AWS default (no ingress / allow-all egress) is never reconciled.
      ...(ingressPinned ? { ingress: canonicalizeSpec(scalarStr(a['ingress'])) } : {}),
      ...(egressPinned ? { egress: canonicalizeSpec(scalarStr(a['egress'])) } : {}),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const found = await this.ec2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: `tag:${RESOURCE_TAG_KEY}`, Values: [resource.logicalId] }],
      }),
    );
    const groups = found.SecurityGroups ?? [];
    if (groups.length > 1) {
      throw new Error(
        `ambiguous security-group identity: ${groups.length} groups carry ${RESOURCE_TAG_KEY}=` +
          `${resource.logicalId} (${groups.map((g) => g.GroupId ?? '?').join(', ')}) — ` +
          'refusing to guess; resolve the duplicate manually (fail closed)',
      );
    }
    const group = groups[0];
    if (group === undefined || group.GroupId === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromTagList(group.Tags ?? []);
    const ingressPinned = resource.desiredAttributes['ingress'] !== undefined;
    const egressPinned = resource.desiredAttributes['egress'] !== undefined;
    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: group.GroupId,
      projection: {
        vpcId: group.VpcId ?? '',
        description: group.Description ?? '',
        ...(ingressPinned
          ? { ingress: canonicalizePermissions(group.IpPermissions ?? []) }
          : {}),
        ...(egressPinned
          ? { egress: canonicalizePermissions(group.IpPermissionsEgress ?? []) }
          : {}),
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const resourceId = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const created = await this.ec2.send(
      new CreateSecurityGroupCommand({
        GroupName: resourceId,
        Description: d['description'],
        VpcId: d['vpcId'],
        TagSpecifications: [
          {
            ResourceType: 'security-group',
            Tags: toTagList({ Name: resourceId, ...tags }),
          },
        ],
      }),
    );
    const groupId = created.GroupId;
    if (groupId === undefined) {
      throw new Error(
        `CreateSecurityGroup for ${resource.logicalId} returned no GroupId (fail closed)`,
      );
    }
    // Ingress starts empty; authorize exactly the desired ruleset when pinned.
    if (d['ingress'] !== undefined) {
      await this.reconcile(groupId, 'ingress', d['ingress'], '');
    }
    // Egress starts as AWS's allow-all default; reconcile to desired when pinned.
    if (d['egress'] !== undefined) {
      await this.reconcile(groupId, 'egress', d['egress'], DEFAULT_EGRESS_CANONICAL);
    }
    return groupId;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const groupId = current.identifier;
    if (groupId === undefined) {
      throw new Error(
        `no security-group id resolved for ${resource.logicalId} — cannot mutate (fail closed)`,
      );
    }
    const d = this.desiredProjection(resource);
    if (d['ingress'] !== undefined) {
      await this.reconcile(groupId, 'ingress', d['ingress'], current.projection['ingress'] ?? '');
    }
    if (d['egress'] !== undefined) {
      await this.reconcile(groupId, 'egress', d['egress'], current.projection['egress'] ?? '');
    }
    await this.ec2.send(
      new CreateTagsCommand({ Resources: [groupId], Tags: toTagList(current.tags) }),
    );
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    if (current.identifier === undefined) {
      throw new Error(
        `no security-group id resolved for ${resource.logicalId} — cannot delete (fail closed)`,
      );
    }
    await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: current.identifier }));
  }

  /** Revoke live-but-undesired rules, then authorize desired-but-absent ones. */
  private async reconcile(
    groupId: string,
    direction: 'ingress' | 'egress',
    desiredSpec: string,
    liveSpec: string,
  ): Promise<void> {
    const desired = ruleMap(desiredSpec);
    const live = ruleMap(liveSpec);
    const toRevoke = [...live].filter(([key]) => !desired.has(key)).map(([, rule]) => rule);
    const toAuthorize = [...desired].filter(([key]) => !live.has(key)).map(([, rule]) => rule);

    if (toRevoke.length > 0) {
      const IpPermissions = toRevoke.map(toIpPermission);
      if (direction === 'ingress') {
        await this.ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions }));
      } else {
        await this.ec2.send(new RevokeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions }));
      }
    }
    if (toAuthorize.length > 0) {
      const IpPermissions = toAuthorize.map(toIpPermission);
      if (direction === 'ingress') {
        await this.ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions }));
      } else {
        await this.ec2.send(new AuthorizeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions }));
      }
    }
  }
}
