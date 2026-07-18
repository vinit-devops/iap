/**
 * `aws:autoscaling:AutoScalingGroup` handler (@aws-sdk/client-auto-scaling +
 * EC2 for default-VPC placement) — the elastic fleet around a launch template
 * (M22.5).
 *
 * IDENTITY: native named resource — AutoScalingGroupName = resourceId.
 *
 * read   → DescribeAutoScalingGroups by name (empty list → absent; Status
 *          'Delete in progress' → absent — a dying group is never updated or
 *          resurrected). Tags ride the group description.
 * create → CreateAutoScalingGroup: LaunchTemplate { LaunchTemplateName from
 *          `launchTemplateName` — REQUIRED, fail-closed (the sibling
 *          aws:ec2:LaunchTemplate resource; plans wire it via dependsOn),
 *          Version '$Default' }, MinSize from `min` (default 0), MaxSize from
 *          `max` (default 1), DesiredCapacity from `desired` (default 0 —
 *          ZERO instances by default, the zero-cost posture), VPCZoneIdentifier
 *          = comma-joined default-VPC subnets (ADR-0005), ASG-style tags with
 *          PropagateAtLaunch=true so launched instances inherit provenance.
 * update → UpdateAutoScalingGroup (drifted fields only) + CreateOrUpdateTags.
 * delete → DeleteAutoScalingGroup with ForceDelete=true — HONEST NOTE: on a
 *          group with desired>0 this terminates the in-flight instances along
 *          with the group; that is the intended managed-teardown semantic
 *          (without ForceDelete a non-empty group refuses to die and teardown
 *          wedges).
 *
 * REPLACEMENT: justified-N/A. Every projected attribute — INCLUDING
 * `launchTemplateName` — is mutable via UpdateAutoScalingGroup, so this
 * handler declares NO immutableProjectionKeys and no drift ever classifies as
 * the gated delete+create replace (ADR-0006 has nothing to gate here).
 */

import {
  CreateAutoScalingGroupCommand,
  CreateOrUpdateTagsCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import type { AutoScalingClient, Tag } from '@aws-sdk/client-auto-scaling';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';
import { defaultSubnetIds } from './network.js';

const DELETE_IN_PROGRESS = 'Delete in progress';

/**
 * ASG-style tag list: PropagateAtLaunch=true so instances the group launches
 * inherit the provenance tags. `forGroup` adds the ResourceId/ResourceType
 * pair CreateOrUpdateTags requires (CreateAutoScalingGroup infers them).
 */
function toAsgTagList(tags: Record<string, string>, forGroup?: string): Tag[] {
  return Object.keys(tags)
    .sort()
    .map((key) => ({
      Key: key,
      Value: tags[key] ?? '',
      PropagateAtLaunch: true,
      ...(forGroup !== undefined
        ? { ResourceId: forGroup, ResourceType: 'auto-scaling-group' }
        : {}),
    }));
}

export class AutoScalingGroupHandler implements TargetHandler {
  static readonly targetType = 'aws:autoscaling:AutoScalingGroup' as const;
  readonly targetType = AutoScalingGroupHandler.targetType;
  // No immutableProjectionKeys — replacement is justified-N/A (see header):
  // launchTemplateName and min/max/desired all converge in place.

  constructor(
    private readonly autoscaling: AutoScalingClient,
    private readonly ec2: EC2Client,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      launchTemplateName: scalarStr(a['launchTemplateName']),
      min: scalarStr(a['min']) || '0',
      max: scalarStr(a['max']) || '1',
      // desired defaults to ZERO instances — the zero-cost posture.
      desired: scalarStr(a['desired']) || '0',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const found = await this.autoscaling.send(
      new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [name] }),
    );
    const group = found.AutoScalingGroups?.[0];
    if (group === undefined || group.Status === DELETE_IN_PROGRESS) {
      // Absent, or on its way out — never update/resurrect a dying group.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }
    const tags = fromTagList(group.Tags ?? []);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        launchTemplateName: group.LaunchTemplate?.LaunchTemplateName ?? '',
        min: String(group.MinSize ?? ''),
        max: String(group.MaxSize ?? ''),
        desired: String(group.DesiredCapacity ?? ''),
      },
    };
    if (group.AutoScalingGroupARN !== undefined) state.identifier = group.AutoScalingGroupARN;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const AutoScalingGroupName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const launchTemplateName = d['launchTemplateName'] ?? '';
    if (launchTemplateName === '') {
      throw new Error(
        `aws:autoscaling:AutoScalingGroup '${AutoScalingGroupName}' requires attribute ` +
          "'launchTemplateName' (the sibling aws:ec2:LaunchTemplate resource, wired via " +
          'dependsOn in the plan) — refusing to guess (fail closed)',
      );
    }
    const subnetIds = await defaultSubnetIds(this.ec2);
    await this.autoscaling.send(
      new CreateAutoScalingGroupCommand({
        AutoScalingGroupName,
        LaunchTemplate: { LaunchTemplateName: launchTemplateName, Version: '$Default' },
        MinSize: Number(d['min']),
        MaxSize: Number(d['max']),
        DesiredCapacity: Number(d['desired']),
        VPCZoneIdentifier: subnetIds.join(','),
        Tags: toAsgTagList(tags),
      }),
    );
    // CreateAutoScalingGroup returns no ARN — the name IS the identity.
    return `autoscaling:group/${AutoScalingGroupName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const AutoScalingGroupName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: Record<string, unknown> = {};
    if ((d['launchTemplateName'] ?? '') !== '' && d['launchTemplateName'] !== live['launchTemplateName']) {
      changes['LaunchTemplate'] = {
        LaunchTemplateName: d['launchTemplateName'],
        Version: '$Default',
      };
    }
    if (d['min'] !== live['min']) changes['MinSize'] = Number(d['min']);
    if (d['max'] !== live['max']) changes['MaxSize'] = Number(d['max']);
    if (d['desired'] !== live['desired']) changes['DesiredCapacity'] = Number(d['desired']);
    if (Object.keys(changes).length > 0) {
      await this.autoscaling.send(
        new UpdateAutoScalingGroupCommand({ AutoScalingGroupName, ...changes }),
      );
    }
    // Reconcile tags on the live group (repo idiom: re-assert ownership tags).
    await this.autoscaling.send(
      new CreateOrUpdateTagsCommand({
        Tags: toAsgTagList(current.tags, AutoScalingGroupName),
      }),
    );
  }

  async delete(resource: PlanResource, _current: ResourceState): Promise<void> {
    // ForceDelete: a desired>0 group terminates its instances with it — the
    // intended managed-teardown semantic (a non-empty group otherwise refuses
    // to die and wedges the destroy).
    await this.autoscaling.send(
      new DeleteAutoScalingGroupCommand({
        AutoScalingGroupName: resourceIdOf(resource),
        ForceDelete: true,
      }),
    );
  }
}
