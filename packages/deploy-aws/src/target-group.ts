/**
 * `aws:elasticloadbalancing:TargetGroup` handler
 * (@aws-sdk/client-elastic-load-balancing-v2) — the Service kind's ALB target
 * group (M21.2).
 *
 * read → DescribeTargetGroups (by name) + DescribeTags
 * create → CreateTargetGroup (default-VPC resolution via EC2 when no vpcId
 *          attribute is given — ADR-0005)
 * update → ModifyTargetGroup (health-check settings), AddTags
 * delete → DeleteTargetGroup
 *
 * Target type, protocol, port and VPC are create-only in ELBv2 — drift on any
 * of them replaces the target group (ADR-0006). Health-check path/interval
 * reconcile in place.
 */

import {
  AddTagsCommand,
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  ModifyTargetGroupCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type {
  ElasticLoadBalancingV2Client,
  ProtocolEnum,
  TargetTypeEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { defaultVpcId } from './network.js';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { durationToSeconds, nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['TargetGroupNotFound'] as const;
const DEFAULTS = { targetType: 'ip', protocol: 'HTTP', port: '80' } as const;

export class TargetGroupHandler implements TargetHandler {
  static readonly targetType = 'aws:elasticloadbalancing:TargetGroup' as const;
  readonly targetType = TargetGroupHandler.targetType;
  /** ELBv2 create-only settings — drift on any of these means replace. */
  readonly immutableProjectionKeys = ['targetType', 'protocol', 'port', 'vpcId'] as const;

  constructor(
    private readonly client: ElasticLoadBalancingV2Client,
    private readonly ec2: EC2Client,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      targetType: scalarStr(a['targetType']) || DEFAULTS.targetType,
      protocol: (scalarStr(a['protocol']) || DEFAULTS.protocol).toUpperCase(),
      port: scalarStr(a['port']) || DEFAULTS.port,
      // vpcId compares only when explicitly desired; '' matches the live value
      // via the executor's absent-equals-empty rule, so default-VPC deployments
      // (ADR-0005) do not read as drifted.
      vpcId: scalarStr(a['vpcId']),
      healthCheckPath: scalarStr(a['healthCheckPath']) || '/',
      healthCheckInterval: durationToSeconds(scalarStr(a['healthCheckInterval']) || '30'),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    let group;
    try {
      const found = await this.client.send(new DescribeTargetGroupsCommand({ Names: [name] }));
      group = found.TargetGroups?.[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (group?.TargetGroupArn === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const arn = group.TargetGroupArn;
    const tagResult = await this.client.send(new DescribeTagsCommand({ ResourceArns: [arn] }));
    const tags = fromTagList(tagResult.TagDescriptions?.[0]?.Tags ?? []);
    const desiredVpc = scalarStr(resource.desiredAttributes['vpcId']);

    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: arn,
      projection: {
        targetType: group.TargetType ?? '',
        protocol: group.Protocol ?? '',
        port: group.Port === undefined ? '' : String(group.Port),
        // Compare the live VPC only when the plan pins one (ADR-0005).
        vpcId: desiredVpc === '' ? '' : (group.VpcId ?? ''),
        healthCheckPath: group.HealthCheckPath ?? '',
        healthCheckInterval:
          group.HealthCheckIntervalSeconds === undefined
            ? ''
            : String(group.HealthCheckIntervalSeconds),
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const desired = this.desiredProjection(resource);
    const VpcId = desired['vpcId'] || (await defaultVpcId(this.ec2));
    const created = await this.client.send(
      new CreateTargetGroupCommand({
        Name: name,
        TargetType: desired['targetType'] as TargetTypeEnum,
        Protocol: desired['protocol'] as ProtocolEnum,
        Port: Number(desired['port']),
        VpcId,
        HealthCheckPath: desired['healthCheckPath'],
        HealthCheckIntervalSeconds: Number(desired['healthCheckInterval']),
        Tags: toTagList(tags),
      }),
    );
    return created.TargetGroups?.[0]?.TargetGroupArn ?? `elbv2:target-group/${name}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const desired = this.desiredProjection(resource);
    const TargetGroupArn = current.identifier ?? '';
    await this.client.send(
      new ModifyTargetGroupCommand({
        TargetGroupArn,
        HealthCheckPath: desired['healthCheckPath'],
        HealthCheckIntervalSeconds: Number(desired['healthCheckInterval']),
      }),
    );
    await this.client.send(
      new AddTagsCommand({ ResourceArns: [TargetGroupArn], Tags: toTagList(current.tags) }),
    );
  }

  async delete(_resource: PlanResource, current: ResourceState): Promise<void> {
    await this.client.send(
      new DeleteTargetGroupCommand({ TargetGroupArn: current.identifier ?? '' }),
    );
  }
}
