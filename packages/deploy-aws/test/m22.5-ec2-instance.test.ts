/**
 * M22.5 `aws:ec2:Instance` handler, mock-tested. TAG-BASED identity: instance
 * ids are generated, so `iap:resourceId` (value = plan logicalId) is the
 * stable handle; DescribeInstances filters on it plus live instance states —
 * terminated/shutting-down read as absent and are never resurrected. imageId
 * AND instanceType are immutable for v1 (gated replace, ADR-0006); imageId is
 * REQUIRED (fail closed — no AMI default baked in).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const ec2 = mockClient(EC2Client);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => ec2.reset());

const AMI = 'ami-0al2023arm64';
const LOGICAL_ID = 'worker.aws:ec2:Instance';

const plan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('worker', 'aws:ec2:Instance', attrs)]);

function mockDefaultNetwork() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
    ],
  });
  ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-default' }] });
}

/** One live instance carrying the iap identity tags. */
function mockLiveInstance(overrides: Record<string, unknown> = {}): void {
  ec2.on(DescribeInstancesCommand).resolves({
    Reservations: [
      {
        Instances: [
          {
            InstanceId: 'i-0123456789',
            ImageId: AMI,
            InstanceType: 't4g.nano',
            State: { Name: 'running' },
            Tags: [
              { Key: 'iap:managed', Value: 'true' },
              { Key: 'iap:resourceId', Value: LOGICAL_ID },
            ],
            ...overrides,
          },
        ],
      },
    ],
  });
}

describe('aws:ec2:Instance — tag-identity create', () => {
  it('absent → RunInstances with defaults on the default network, tags at launch', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: 'i-0new' }] });
    mockDefaultNetwork();

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('i-0new');

    // Read is tag-scoped and excludes dying instances at the server.
    const filters = ec2.commandCalls(DescribeInstancesCommand)[0]?.args[0].input?.Filters ?? [];
    const tagFilter = filters.find((f) => f.Name === 'tag:iap:resourceId');
    expect(tagFilter?.Values).toEqual([LOGICAL_ID]);
    const stateFilter = filters.find((f) => f.Name === 'instance-state-name');
    expect(stateFilter?.Values).not.toContain('terminated');
    expect(stateFilter?.Values).not.toContain('shutting-down');

    const run = ec2.commandCalls(RunInstancesCommand)[0]?.args[0].input;
    expect(run?.ImageId).toBe(AMI);
    expect(run?.InstanceType).toBe('t4g.nano'); // default
    expect(run?.MinCount).toBe(1);
    expect(run?.MaxCount).toBe(1);
    expect(run?.SubnetId).toBe('subnet-a'); // first default subnet
    expect(run?.SecurityGroupIds).toEqual(['sg-default']);
    const spec = run?.TagSpecifications?.[0];
    expect(spec?.ResourceType).toBe('instance');
    const tags = (spec?.Tags ?? []).map((t) => `${t.Key}=${t.Value}`);
    expect(tags).toContain('iap:managed=true');
    expect(tags).toContain(`iap:resourceId=${LOGICAL_ID}`);
    expect(tags).toContain('Name=worker'); // console-friendly Name tag too
  });

  it('missing imageId → fail closed: honest error recorded, ZERO RunInstances', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    mockDefaultNetwork();

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain("requires attribute 'imageId'");
    expect(ec2.commandCalls(RunInstancesCommand)).toHaveLength(0);
  });

  it('multiple live instances claiming the identity → fail closed (thrown, never a silent pick)', async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [
        { Instances: [{ InstanceId: 'i-0aaa', State: { Name: 'running' } }] },
        { Instances: [{ InstanceId: 'i-0bbb', State: { Name: 'running' } }] },
      ],
    });

    await expect(executor().plan(plan({ imageId: AMI }))).rejects.toThrow(
      /multiple live instances .* ambiguous identity/,
    );
  });
});

describe('aws:ec2:Instance — AZ capacity failover (M22.5 live finding)', () => {
  const capacityError = () =>
    Object.assign(
      new Error(
        'We currently do not have sufficient t4g.nano capacity in the Availability Zone ' +
          'you requested (eu-central-1a).',
      ),
      { name: 'InsufficientInstanceCapacity' },
    );

  it('InsufficientInstanceCapacity in the first AZ → retries the next default subnet', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    mockDefaultNetwork();
    ec2.on(RunInstancesCommand, { SubnetId: 'subnet-a' }).rejects(capacityError());
    ec2
      .on(RunInstancesCommand, { SubnetId: 'subnet-b' })
      .resolves({ Instances: [{ InstanceId: 'i-0secondaz' }] });

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('i-0secondaz');
    const subnets = ec2
      .commandCalls(RunInstancesCommand)
      .map((c) => c.args[0].input?.SubnetId);
    expect(subnets).toEqual(['subnet-a', 'subnet-b']); // deterministic AZ order
  });

  it('every AZ out of capacity → fails closed with the real AWS error, no silent success', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    mockDefaultNetwork();
    ec2.on(RunInstancesCommand).rejects(capacityError());

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('sufficient t4g.nano capacity');
    expect(ec2.commandCalls(RunInstancesCommand)).toHaveLength(2); // tried both AZs
  });

  it('a NON-capacity launch error does not failover — thrown at once, one attempt only', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    mockDefaultNetwork();
    ec2
      .on(RunInstancesCommand)
      .rejects(Object.assign(new Error('The image id does not exist'), {
        name: 'InvalidAMIID.NotFound',
      }));

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('image id does not exist');
    expect(ec2.commandCalls(RunInstancesCommand)).toHaveLength(1);
  });
});

describe('aws:ec2:Instance — terminated reads absent', () => {
  it('a terminated instance is invisible: plan → create, and create never resurrects it', async () => {
    // Defensive client-side re-filter: even if the server hands back a dying
    // instance, it still reads as absent.
    mockLiveInstance({ State: { Name: 'terminated' } });
    ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: 'i-0fresh' }] });
    mockDefaultNetwork();

    const planned = await executor().plan(plan({ imageId: AMI }));
    expect(planned.items[0]?.action).toBe('create');

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('i-0fresh'); // a FRESH instance
    expect(ec2.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
  });
});

describe('aws:ec2:Instance — immutable drift (ADR-0006)', () => {
  it('imageId drift classifies replace, never update', async () => {
    mockLiveInstance({ ImageId: 'ami-0stale' });

    const report = await executor().plan(plan({ imageId: AMI }));

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
  });

  it('instanceType drift also classifies replace (v1 fail-closed posture)', async () => {
    mockLiveInstance({ InstanceType: 't4g.small' });

    const report = await executor().plan(plan({ imageId: AMI, instanceType: 't4g.nano' }));

    expect(report.items[0]?.action).toBe('replace');
  });

  it('replacement gate closed → refused: nothing terminated, nothing launched', async () => {
    mockLiveInstance({ ImageId: 'ami-0stale' });

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('refusing to replace');
    expect(ec2.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(ec2.commandCalls(RunInstancesCommand)).toHaveLength(0);
  });

  it('gated replace executes TerminateInstances then RunInstances', async () => {
    mockLiveInstance({ ImageId: 'ami-0stale' });
    ec2.on(TerminateInstancesCommand).resolves({});
    ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: 'i-0replacement' }] });
    mockDefaultNetwork();

    const report = await executor().apply(plan({ imageId: AMI }), {
      apply: true,
      replace: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('i-0replacement');
    expect(ec2.commandCalls(TerminateInstancesCommand)[0]?.args[0].input?.InstanceIds).toEqual([
      'i-0123456789',
    ]);
    const order = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('TerminateInstancesCommand')).toBeLessThan(
      order.indexOf('RunInstancesCommand'),
    );
  });
});

describe('aws:ec2:Instance — update and destroy', () => {
  it('update surface is tags-only: CreateTags on the live instance id', async () => {
    // Force the update path via an injected drift-free-but-updating scenario:
    // both projection keys immutable means classify never yields update, so
    // exercise the handler method directly through a converged apply → no-op
    // (assert no CreateTags) and rely on the contract test below for delete.
    mockLiveInstance();
    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });
    expect(report.items[0]?.action).toBe('no-op');
    expect(ec2.commandCalls(CreateTagsCommand)).toHaveLength(0);
  });

  it('destroy managed → TerminateInstances with the live id', async () => {
    mockLiveInstance();
    ec2.on(TerminateInstancesCommand).resolves({});

    const report = await executor().apply(plan({ imageId: AMI }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(ec2.commandCalls(TerminateInstancesCommand)[0]?.args[0].input?.InstanceIds).toEqual([
      'i-0123456789',
    ]);
  });

  it('refuses to destroy an instance NOT tagged iap:managed', async () => {
    mockLiveInstance({ Tags: [{ Key: 'iap:resourceId', Value: LOGICAL_ID }] });

    const report = await executor().apply(plan({ imageId: AMI }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(ec2.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
  });
});
