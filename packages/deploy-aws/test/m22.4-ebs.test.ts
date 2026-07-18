/**
 * M22.4 `aws:ec2:Volume` handler, mock-tested. EBS volumes have no names —
 * the handler owns the `iap:resourceId` tag as identity (DescribeVolumes tag
 * filter; >1 match fails closed as ambiguous). AZ derives from the first
 * default subnet unless pinned; pinned-AZ / encrypted drift replaces
 * (ADR-0006). sizeGiB is GROW-ONLY: a shrink throws an honest recorded error
 * (EBS cannot shrink), never a silent reconcile.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  EC2Client,
  ModifyVolumeCommand,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const ec2 = mockClient(EC2Client);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const LOGICAL_ID = 'data-vol.aws:ec2:Volume';
const VOLUME_ID = 'vol-0123456789abcdef0';

const plan = (attrs: Record<string, string | number | boolean> = {}) =>
  providerPlan([planResource('data-vol', 'aws:ec2:Volume', attrs)]);

beforeEach(() => {
  ec2.reset();
  // Default VPC + subnets (ADR-0005 idiom) for AZ derivation.
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
    ],
  });
});

/** A live, converged, managed gp3 volume behind the iap:resourceId tag. */
function mockLiveVolume(overrides: Record<string, unknown> = {}): void {
  ec2.on(DescribeVolumesCommand).resolves({
    Volumes: [
      {
        VolumeId: VOLUME_ID,
        Size: 8,
        VolumeType: 'gp3',
        Encrypted: true,
        AvailabilityZone: 'eu-central-1a',
        State: 'available',
        Tags: [
          { Key: 'iap:managed', Value: 'true' },
          { Key: 'iap:resourceId', Value: LOGICAL_ID },
          { Key: 'Name', Value: 'data-vol' },
        ],
        ...overrides,
      },
    ],
  });
}

describe('aws:ec2:Volume — create', () => {
  it('tag-filtered read absent → CreateVolume with AZ from the first default subnet + TagSpecifications', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [] });
    ec2.on(CreateVolumeCommand).resolves({ VolumeId: VOLUME_ID });

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(VOLUME_ID);
    expect(report.errors).toHaveLength(0);

    // Identity read: the tag filter carries buildTags' exact value (the
    // logicalId) and excludes deleting/deleted states.
    const describe = ec2.commandCalls(DescribeVolumesCommand)[0]?.args[0].input;
    expect(describe?.Filters).toContainEqual({
      Name: 'tag:iap:resourceId',
      Values: [LOGICAL_ID],
    });
    const statusFilter = describe?.Filters?.find((f) => f.Name === 'status');
    expect(statusFilter?.Values).not.toContain('deleting');
    expect(statusFilter?.Values).not.toContain('deleted');

    const create = ec2.commandCalls(CreateVolumeCommand)[0]?.args[0].input;
    expect(create?.AvailabilityZone).toBe('eu-central-1a'); // FIRST subnet by AZ order
    expect(create?.VolumeType).toBe('gp3'); // default
    expect(create?.Size).toBe(8); // default
    expect(create?.Encrypted).toBe(true); // encrypted by default
    // All tags ride creation as TagSpecifications (volumes cannot be renamed
    // into identity later — tags at create or never).
    const spec = create?.TagSpecifications?.[0];
    expect(spec?.ResourceType).toBe('volume');
    const tagPairs = (spec?.Tags ?? []).map((t) => `${t.Key}=${t.Value}`);
    expect(tagPairs).toContain('iap:managed=true');
    expect(tagPairs).toContain(`iap:resourceId=${LOGICAL_ID}`);
    expect(tagPairs).toContain('Name=data-vol'); // console-humans tag
  });
});

describe('aws:ec2:Volume — ambiguous identity fails closed', () => {
  it('two volumes carrying the identity tag → loud recorded error, zero mutations', async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        { VolumeId: 'vol-aaa', State: 'available' },
        { VolumeId: 'vol-bbb', State: 'available' },
      ],
    });

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('ambiguous EBS identity');
    expect(report.errors[0]).toContain('vol-aaa');
    expect(report.errors[0]).toContain('vol-bbb');
    // The handler never guesses: nothing created, modified, or deleted.
    expect(ec2.commandCalls(CreateVolumeCommand)).toHaveLength(0);
    expect(ec2.commandCalls(ModifyVolumeCommand)).toHaveLength(0);
    expect(ec2.commandCalls(DeleteVolumeCommand)).toHaveLength(0);
  });
});

describe('aws:ec2:Volume — sizeGiB is grow-only', () => {
  it('grow 8 → 16 GiB classifies update and issues ModifyVolume', async () => {
    mockLiveVolume({ Size: 8 });
    ec2.on(ModifyVolumeCommand).resolves({});

    const planned = await executor().plan(plan({ sizeGiB: 16 }));
    expect(planned.items[0]?.action).toBe('update');

    const report = await executor().apply(plan({ sizeGiB: 16 }), { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);

    const modify = ec2.commandCalls(ModifyVolumeCommand)[0]?.args[0].input;
    expect(modify?.VolumeId).toBe(VOLUME_ID);
    expect(modify?.Size).toBe(16);
  });

  it('SHRINK 16 → 8 GiB fails closed with an honest recorded error — no ModifyVolume', async () => {
    mockLiveVolume({ Size: 16 }); // desired default is 8 GiB

    const report = await executor().apply(plan({ sizeGiB: 8 }), { apply: true });

    // Classified update (size IS mutable), but update() refuses the shrink.
    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('EBS volumes cannot shrink');
    expect(report.errors[0]).toContain('16 GiB');
    expect(ec2.commandCalls(ModifyVolumeCommand)).toHaveLength(0);
    expect(ec2.commandCalls(DeleteVolumeCommand)).toHaveLength(0);
  });

  it('volumeType drift reconciles in place via ModifyVolume', async () => {
    mockLiveVolume({ VolumeType: 'gp2' });
    ec2.on(ModifyVolumeCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const modify = ec2.commandCalls(ModifyVolumeCommand)[0]?.args[0].input;
    expect(modify?.VolumeId).toBe(VOLUME_ID);
    expect(modify?.VolumeType).toBe('gp3');
    expect(modify?.Size).toBeUndefined(); // size converged — not re-sent
  });
});

describe('aws:ec2:Volume — pinned AZ drift is IMMUTABLE (ADR-0006)', () => {
  const desired = plan({ availabilityZone: 'eu-central-1b' });

  it('classifies replace, never update', async () => {
    mockLiveVolume({ AvailabilityZone: 'eu-central-1a' });
    const report = await executor().plan(desired);
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
  });

  it('without the replacement gate: refused — nothing destroyed, nothing created', async () => {
    mockLiveVolume({ AvailabilityZone: 'eu-central-1a' });

    const refused = await executor().apply(desired, { apply: true });

    expect(refused.items[0]?.action).toBe('replace');
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.errors[0]).toContain('refusing to replace');
    expect(ec2.commandCalls(DeleteVolumeCommand)).toHaveLength(0);
    expect(ec2.commandCalls(CreateVolumeCommand)).toHaveLength(0);
  });

  it('gated replace executes DeleteVolume then CreateVolume in the pinned AZ', async () => {
    mockLiveVolume({ AvailabilityZone: 'eu-central-1a' });
    ec2.on(DeleteVolumeCommand).resolves({});
    ec2.on(CreateVolumeCommand).resolves({ VolumeId: 'vol-fresh' });

    const report = await executor().apply(desired, { apply: true, replace: true });

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);
    // Old volume torn down first, then the replacement lands in the new AZ.
    expect(ec2.commandCalls(DeleteVolumeCommand)[0]?.args[0].input?.VolumeId).toBe(VOLUME_ID);
    const create = ec2.commandCalls(CreateVolumeCommand)[0]?.args[0].input;
    expect(create?.AvailabilityZone).toBe('eu-central-1b');
    const order = ec2
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n === 'DeleteVolumeCommand' || n === 'CreateVolumeCommand');
    expect(order).toEqual(['DeleteVolumeCommand', 'CreateVolumeCommand']);
  });
});

describe('aws:ec2:Volume — destroy', () => {
  it('managed → DeleteVolume by the read-resolved volume id', async () => {
    mockLiveVolume();
    ec2.on(DeleteVolumeCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(ec2.commandCalls(DeleteVolumeCommand)[0]?.args[0].input?.VolumeId).toBe(VOLUME_ID);
  });

  it('refuses to destroy a volume NOT tagged iap:managed', async () => {
    mockLiveVolume({ Tags: [{ Key: 'team', Value: 'core' }] });

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(ec2.commandCalls(DeleteVolumeCommand)).toHaveLength(0);
  });
});
