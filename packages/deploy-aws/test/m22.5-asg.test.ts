/**
 * M22.5 `aws:autoscaling:AutoScalingGroup` handler, mock-tested. Native named
 * resource; launches from the sibling launch template at Version '$Default'
 * (wired via dependsOn). Zero-cost posture: min/desired default to 0 (ZERO
 * instances). Everything — including launchTemplateName — is mutable via
 * UpdateAutoScalingGroup (replacement justified-N/A); delete uses
 * ForceDelete=true (a desired>0 group terminates its instances with it).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
  CreateOrUpdateTagsCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  CreateLaunchTemplateCommand,
  DeleteLaunchTemplateCommand,
  DescribeLaunchTemplatesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { AutoScalingGroupHandler } from '../src/autoscaling.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const autoscaling = mockClient(AutoScalingClient);
const ec2 = mockClient(EC2Client);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => {
  autoscaling.reset();
  ec2.reset();
});

const AMI = 'ami-0al2023arm64';

const plan = (attrs: Record<string, string | number> = {}) =>
  providerPlan([planResource('a-fleet', 'aws:autoscaling:AutoScalingGroup', attrs)]);

function mockDefaultNetwork() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
      { SubnetId: 'subnet-c', AvailabilityZone: 'eu-central-1c' },
    ],
  });
  ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-default' }] });
}

/** A live zero-capacity group launched from b-tmpl, tagged managed. */
function mockLiveGroup(overrides: Record<string, unknown> = {}): void {
  autoscaling.on(DescribeAutoScalingGroupsCommand).resolves({
    AutoScalingGroups: [
      {
        AutoScalingGroupName: 'a-fleet',
        AutoScalingGroupARN: 'arn:aws:autoscaling:eu-central-1:0:autoScalingGroup:x:autoScalingGroupName/a-fleet',
        LaunchTemplate: { LaunchTemplateName: 'b-tmpl', Version: '$Default' },
        MinSize: 0,
        MaxSize: 1,
        DesiredCapacity: 0,
        VPCZoneIdentifier: 'subnet-a,subnet-b,subnet-c',
        AvailabilityZones: ['eu-central-1a'],
        CreatedTime: new Date(0),
        DefaultCooldown: 300,
        HealthCheckType: 'EC2',
        Instances: [],
        Tags: [
          { Key: 'iap:managed', Value: 'true', PropagateAtLaunch: true },
        ],
        ...overrides,
      },
    ],
  });
}

describe('aws:autoscaling:AutoScalingGroup — create (zero-capacity posture)', () => {
  it('absent → CreateAutoScalingGroup at desired 0 (ZERO instances), $Default template version', async () => {
    autoscaling.on(DescribeAutoScalingGroupsCommand).resolves({ AutoScalingGroups: [] });
    autoscaling.on(CreateAutoScalingGroupCommand).resolves({});
    mockDefaultNetwork();

    const report = await executor().apply(plan({ launchTemplateName: 'b-tmpl' }), {
      apply: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);

    const create = autoscaling.commandCalls(CreateAutoScalingGroupCommand)[0]?.args[0].input;
    expect(create?.AutoScalingGroupName).toBe('a-fleet');
    expect(create?.LaunchTemplate).toEqual({
      LaunchTemplateName: 'b-tmpl',
      Version: '$Default',
    });
    // Zero-cost defaults: min 0 / max 1 / desired 0 — no instance launches.
    expect(create?.MinSize).toBe(0);
    expect(create?.MaxSize).toBe(1);
    expect(create?.DesiredCapacity).toBe(0);
    expect(create?.VPCZoneIdentifier).toBe('subnet-a,subnet-b,subnet-c');
    // ASG-style tags propagate to launched instances.
    const tags = create?.Tags ?? [];
    expect(tags.every((t) => t.PropagateAtLaunch === true)).toBe(true);
    const flat = tags.map((t) => `${t.Key}=${t.Value}`);
    expect(flat).toContain('iap:managed=true');
    expect(flat.some((t) => t.startsWith('iap:planId='))).toBe(true);
    expect(flat.some((t) => t.startsWith('iap:resourceId='))).toBe(true);
  });

  it('missing launchTemplateName → fail closed: honest error, ZERO CreateAutoScalingGroup', async () => {
    autoscaling.on(DescribeAutoScalingGroupsCommand).resolves({ AutoScalingGroups: [] });
    mockDefaultNetwork();

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain("requires attribute 'launchTemplateName'");
    expect(autoscaling.commandCalls(CreateAutoScalingGroupCommand)).toHaveLength(0);
  });
});

describe('aws:autoscaling:AutoScalingGroup — mutable drift → UpdateAutoScalingGroup', () => {
  it('min/max/desired drift → update in place (0→1 safe-update exercise)', async () => {
    mockLiveGroup();
    autoscaling.on(UpdateAutoScalingGroupCommand).resolves({});
    autoscaling.on(CreateOrUpdateTagsCommand).resolves({});

    const desired = plan({ launchTemplateName: 'b-tmpl', min: 0, max: 2, desired: 1 });
    const planned = await executor().plan(desired);
    expect(planned.items[0]?.action).toBe('update'); // mutable, never replace

    const report = await executor().apply(desired, { apply: true });
    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);

    const update = autoscaling.commandCalls(UpdateAutoScalingGroupCommand)[0]?.args[0].input;
    expect(update?.AutoScalingGroupName).toBe('a-fleet');
    expect(update?.MaxSize).toBe(2);
    expect(update?.DesiredCapacity).toBe(1);
    expect(update?.MinSize).toBeUndefined(); // converged — not resent
    // Ownership tags re-asserted alongside.
    expect(autoscaling.commandCalls(CreateOrUpdateTagsCommand)).toHaveLength(1);
    expect(autoscaling.commandCalls(DeleteAutoScalingGroupCommand)).toHaveLength(0);
  });

  it('launchTemplateName drift is MUTABLE too — update repoints the group, no replace', async () => {
    mockLiveGroup({ LaunchTemplate: { LaunchTemplateName: 'old-tmpl', Version: '$Default' } });
    autoscaling.on(UpdateAutoScalingGroupCommand).resolves({});
    autoscaling.on(CreateOrUpdateTagsCommand).resolves({});

    const desired = plan({ launchTemplateName: 'b-tmpl' });
    const planned = await executor().plan(desired);
    expect(planned.items[0]?.action).toBe('update');

    await executor().apply(desired, { apply: true });
    const update = autoscaling.commandCalls(UpdateAutoScalingGroupCommand)[0]?.args[0].input;
    expect(update?.LaunchTemplate).toEqual({
      LaunchTemplateName: 'b-tmpl',
      Version: '$Default',
    });
  });

  it('replacement is justified-N/A: the handler declares NO immutableProjectionKeys', () => {
    const handler = new AutoScalingGroupHandler(
      new AutoScalingClient({ region: 'eu-central-1' }),
      new EC2Client({ region: 'eu-central-1' }),
    );
    expect(handler.immutableProjectionKeys).toBeUndefined();
  });
});

describe('aws:autoscaling:AutoScalingGroup — dependsOn ordering with the launch template', () => {
  /**
   * ASG 'a-fleet' sorts alphabetically BEFORE template 'b-tmpl' — only
   * dependsOn can order the pair correctly (mirrors ordering.test.ts).
   */
  function fleetAndTemplate() {
    const template = planResource('b-tmpl', 'aws:ec2:LaunchTemplate', { imageId: AMI });
    const group = planResource('a-fleet', 'aws:autoscaling:AutoScalingGroup', {
      launchTemplateName: 'b-tmpl',
    });
    group.dependsOn = [template.logicalId];
    return { group, template };
  }

  it('create: launch template lands BEFORE the group that launches from it', async () => {
    const { group, template } = fleetAndTemplate();
    ec2
      .on(DescribeLaunchTemplatesCommand)
      .rejects(serviceError('InvalidLaunchTemplateName.NotFoundException'));
    ec2.on(CreateLaunchTemplateCommand).resolves({
      LaunchTemplate: { LaunchTemplateId: 'lt-0new' },
    });
    autoscaling.on(DescribeAutoScalingGroupsCommand).resolves({ AutoScalingGroups: [] });
    autoscaling.on(CreateAutoScalingGroupCommand).resolves({});
    mockDefaultNetwork();

    const report = await executor().apply(providerPlan([group, template]), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([template.logicalId, group.logicalId]);
    expect(ec2.commandCalls(CreateLaunchTemplateCommand)).toHaveLength(1);
    expect(autoscaling.commandCalls(CreateAutoScalingGroupCommand)).toHaveLength(1);
  });

  it('destroy: reverses — the group dies BEFORE the template it launches from', async () => {
    const { group, template } = fleetAndTemplate();
    ec2.on(DescribeLaunchTemplatesCommand).resolves({
      LaunchTemplates: [
        {
          LaunchTemplateId: 'lt-0123',
          LaunchTemplateName: 'b-tmpl',
          Tags: [{ Key: 'iap:managed', Value: 'true' }],
        },
      ],
    });
    ec2.on(DescribeLaunchTemplateVersionsCommand).resolves({
      LaunchTemplateVersions: [
        { VersionNumber: 1, LaunchTemplateData: { ImageId: AMI, InstanceType: 't4g.nano' } },
      ],
    });
    ec2.on(DeleteLaunchTemplateCommand).resolves({});
    mockLiveGroup();
    autoscaling.on(DeleteAutoScalingGroupCommand).resolves({});

    const report = await executor().apply(providerPlan([group, template]), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([group.logicalId, template.logicalId]);
    expect(autoscaling.commandCalls(DeleteAutoScalingGroupCommand)).toHaveLength(1);
    expect(ec2.commandCalls(DeleteLaunchTemplateCommand)).toHaveLength(1);
  });
});

describe('aws:autoscaling:AutoScalingGroup — destroy', () => {
  it('managed → DeleteAutoScalingGroup with ForceDelete=true (in-flight instances go with it)', async () => {
    mockLiveGroup();
    autoscaling.on(DeleteAutoScalingGroupCommand).resolves({});

    const report = await executor().apply(plan({ launchTemplateName: 'b-tmpl' }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    const del = autoscaling.commandCalls(DeleteAutoScalingGroupCommand)[0]?.args[0].input;
    expect(del?.AutoScalingGroupName).toBe('a-fleet');
    expect(del?.ForceDelete).toBe(true);
  });

  it('refuses to destroy a group NOT tagged iap:managed', async () => {
    mockLiveGroup({ Tags: [{ Key: 'team', Value: 'core', PropagateAtLaunch: true }] });

    const report = await executor().apply(plan({ launchTemplateName: 'b-tmpl' }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(autoscaling.commandCalls(DeleteAutoScalingGroupCommand)).toHaveLength(0);
  });

  it("Status 'Delete in progress' reads as absent → destroy is a no-op, never a second delete", async () => {
    mockLiveGroup({ Status: 'Delete in progress' });

    const report = await executor().apply(plan({ launchTemplateName: 'b-tmpl' }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.action).toBe('no-op');
    expect(autoscaling.commandCalls(DeleteAutoScalingGroupCommand)).toHaveLength(0);
  });
});
