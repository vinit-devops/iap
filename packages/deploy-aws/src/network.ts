/**
 * Default-VPC resolution (ADR-0005): early live waves place VPC-resident
 * resources into the account's default VPC. Fail-closed when no default VPC
 * exists — the M23.4 Network handlers replace this pragmatism.
 */

import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import type { EC2Client } from '@aws-sdk/client-ec2';

export async function defaultVpcId(ec2: EC2Client): Promise<string> {
  const vpcs = await ec2.send(
    new DescribeVpcsCommand({ Filters: [{ Name: 'is-default', Values: ['true'] }] }),
  );
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (vpcId === undefined) {
    throw new Error(
      'no default VPC in this account/region and no vpcId attribute given ' +
        '(ADR-0005 pre-flight: early live runs require a default VPC)',
    );
  }
  return vpcId;
}

/** Default-VPC subnet ids across distinct AZs (deterministic order), first `count`. */
export async function defaultSubnetIds(ec2: EC2Client, count?: number): Promise<string[]> {
  const vpcId = await defaultVpcId(ec2);
  const subnets = await ec2.send(
    new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }] }),
  );
  const byAz = [...(subnets.Subnets ?? [])].sort((a, b) =>
    (a.AvailabilityZone ?? '') < (b.AvailabilityZone ?? '') ? -1 : 1,
  );
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const subnet of byAz) {
    const az = subnet.AvailabilityZone ?? '';
    if (subnet.SubnetId !== undefined && !seen.has(az)) {
      seen.add(az);
      ids.push(subnet.SubnetId);
    }
  }
  if (ids.length === 0) throw new Error('default VPC has no subnets (ADR-0005 pre-flight)');
  return count !== undefined ? ids.slice(0, Math.max(1, count)) : ids;
}

/** The default security group of the default VPC. */
export async function defaultSecurityGroupId(ec2: EC2Client): Promise<string> {
  const vpcId = await defaultVpcId(ec2);
  const groups = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'group-name', Values: ['default'] },
      ],
    }),
  );
  const groupId = groups.SecurityGroups?.[0]?.GroupId;
  if (groupId === undefined) throw new Error('default VPC has no default security group');
  return groupId;
}
