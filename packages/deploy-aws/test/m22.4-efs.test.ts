/**
 * M22.4 `aws:efs:FileSystem` handler, mock-tested. Identity is EFS's native
 * CreationToken (= resourceId); the handler also owns one mount target in the
 * first default subnet with the default SG. performanceMode drift replaces
 * (ADR-0006); throughputMode reconciles in place. Teardown deletes mount
 * targets FIRST (bounded waiter), then the file system.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateFileSystemCommand,
  CreateMountTargetCommand,
  DeleteFileSystemCommand,
  DeleteMountTargetCommand,
  DescribeFileSystemsCommand,
  DescribeMountTargetsCommand,
  EFSClient,
  TagResourceCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-efs';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const efs = mockClient(EFSClient);
const ec2 = mockClient(EC2Client);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const FS_ID = 'fs-0123456789abcdef0';
const FS_ARN = `arn:aws:elasticfilesystem:eu-central-1:000000000000:file-system/${FS_ID}`;

const plan = (attrs: Record<string, string | boolean> = {}) =>
  providerPlan([planResource('shared-files', 'aws:efs:FileSystem', attrs)]);

beforeEach(() => {
  efs.reset();
  ec2.reset();
  // Default VPC + subnets + default SG (ADR-0005) for the mount target.
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
    ],
  });
  ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-default' }] });
});

/** A live, available, converged, managed file system behind the token. */
function mockLiveFs(overrides: Record<string, unknown> = {}): void {
  efs.on(DescribeFileSystemsCommand).resolves({
    FileSystems: [
      {
        FileSystemId: FS_ID,
        FileSystemArn: FS_ARN,
        CreationToken: 'shared-files',
        LifeCycleState: 'available',
        PerformanceMode: 'generalPurpose',
        ThroughputMode: 'elastic',
        Tags: [{ Key: 'iap:managed', Value: 'true' }],
        ...overrides,
      },
    ],
  });
}

describe('aws:efs:FileSystem — create', () => {
  it('absent (empty describe) → CreateFileSystem with CreationToken + handler-owned mount target', async () => {
    efs
      .on(DescribeFileSystemsCommand)
      // identity read: absent…
      .resolvesOnce({ FileSystems: [] })
      // …availability waiter poll after CreateFileSystem: available.
      .resolves({ FileSystems: [{ FileSystemId: FS_ID, LifeCycleState: 'available' }] });
    efs.on(CreateFileSystemCommand).resolves({ FileSystemId: FS_ID, FileSystemArn: FS_ARN });
    efs.on(CreateMountTargetCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(FS_ARN);
    expect(report.errors).toHaveLength(0);

    // Identity read resolves by CreationToken — EFS's native idempotent key.
    expect(efs.commandCalls(DescribeFileSystemsCommand)[0]?.args[0].input?.CreationToken).toBe(
      'shared-files',
    );

    const create = efs.commandCalls(CreateFileSystemCommand)[0]?.args[0].input;
    expect(create?.CreationToken).toBe('shared-files');
    expect(create?.ThroughputMode).toBe('elastic'); // default
    expect(create?.PerformanceMode).toBe('generalPurpose'); // default
    expect(create?.Encrypted).toBe(true);
    const tagPairs = (create?.Tags ?? []).map((t) => `${t.Key}=${t.Value}`);
    expect(tagPairs).toContain('iap:managed=true');
    expect(tagPairs.some((t) => t.startsWith('iap:planId='))).toBe(true);
    expect(tagPairs.some((t) => t.startsWith('iap:resourceId='))).toBe(true);

    // The '+MountTarget' scope: first default subnet, default security group.
    const mount = efs.commandCalls(CreateMountTargetCommand)[0]?.args[0].input;
    expect(mount?.FileSystemId).toBe(FS_ID);
    expect(mount?.SubnetId).toBe('subnet-a');
    expect(mount?.SecurityGroups).toEqual(['sg-default']);
  });

  it('waits for the fs to be available BEFORE CreateMountTarget (M22.4 live finding)', async () => {
    efs
      .on(DescribeFileSystemsCommand)
      // identity read: absent…
      .resolvesOnce({ FileSystems: [] })
      // …waiter poll 1: still creating (live: CreateMountTarget here fails)…
      .resolvesOnce({ FileSystems: [{ FileSystemId: FS_ID, LifeCycleState: 'creating' }] })
      // …waiter poll 2: available.
      .resolves({ FileSystems: [{ FileSystemId: FS_ID, LifeCycleState: 'available' }] });
    efs.on(CreateFileSystemCommand).resolves({ FileSystemId: FS_ID, FileSystemArn: FS_ARN });
    efs.on(CreateMountTargetCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);

    // CreateMountTarget lands strictly after a describe that saw 'available'
    // — never against a 'creating' file system.
    const order = efs.calls().map((c) => c.args[0].constructor.name);
    const createFs = order.indexOf('CreateFileSystemCommand');
    const createMt = order.indexOf('CreateMountTargetCommand');
    expect(createFs).toBeGreaterThan(-1);
    expect(createMt).toBeGreaterThan(-1);
    // At least two waiter polls (creating, then available) sit between them.
    const pollsBetween = order
      .slice(createFs + 1, createMt)
      .filter((name) => name === 'DescribeFileSystemsCommand');
    expect(pollsBetween.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('a deleting file system reads as absent → create, never converge onto it', async () => {
    mockLiveFs({ LifeCycleState: 'deleting' });
    const report = await executor().plan(plan());
    expect(report.items[0]?.action).toBe('create');
  });
});

describe('aws:efs:FileSystem — converged and drifted', () => {
  it('present + converged → no-op', async () => {
    mockLiveFs();
    const report = await executor().plan(plan());
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('throughputMode drift → UpdateFileSystem in place (no delete, no replace)', async () => {
    mockLiveFs({ ThroughputMode: 'bursting' });
    efs.on(UpdateFileSystemCommand).resolves({});
    efs.on(TagResourceCommand).resolves({});

    const planned = await executor().plan(plan());
    expect(planned.items[0]?.action).toBe('update');

    const report = await executor().apply(plan(), { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);

    const update = efs.commandCalls(UpdateFileSystemCommand)[0]?.args[0].input;
    expect(update?.FileSystemId).toBe(FS_ID); // mutations use the id, never the token
    expect(update?.ThroughputMode).toBe('elastic');
    expect(efs.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
    expect(efs.commandCalls(CreateFileSystemCommand)).toHaveLength(0);
  });

  it('performanceMode drift is IMMUTABLE (ADR-0006) → replace classification', async () => {
    mockLiveFs({ PerformanceMode: 'maxIO' });

    const report = await executor().plan(plan());
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');

    // And with the replacement gate closed, apply refuses — nothing torn down.
    const refused = await executor().apply(plan(), { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.errors[0]).toContain('refusing to replace');
    expect(efs.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
  });
});

describe('aws:efs:FileSystem — destroy', () => {
  it('managed → DeleteMountTarget(s) FIRST, then DeleteFileSystem (asserted order)', async () => {
    mockLiveFs();
    efs
      .on(DescribeMountTargetsCommand)
      // teardown listing: one mount target still attached…
      .resolvesOnce({
        MountTargets: [{ MountTargetId: 'fsmt-0a1b2c', FileSystemId: FS_ID, SubnetId: 'subnet-a' }],
      })
      // …waiter poll: gone (live: ~1 min; the waiter is bounded, fail closed).
      .resolves({ MountTargets: [] });
    efs.on(DeleteMountTargetCommand).resolves({});
    efs.on(DeleteFileSystemCommand).resolves({});

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.errors).toHaveLength(0);

    expect(efs.commandCalls(DeleteMountTargetCommand)[0]?.args[0].input?.MountTargetId).toBe(
      'fsmt-0a1b2c',
    );
    expect(efs.commandCalls(DeleteFileSystemCommand)[0]?.args[0].input?.FileSystemId).toBe(FS_ID);
    // Mount target teardown strictly precedes the file-system delete, with a
    // confirming (empty) mount-target poll in between.
    const order = efs.calls().map((c) => c.args[0].constructor.name);
    const deleteMt = order.indexOf('DeleteMountTargetCommand');
    const deleteFs = order.indexOf('DeleteFileSystemCommand');
    expect(deleteMt).toBeGreaterThan(-1);
    expect(deleteMt).toBeLessThan(deleteFs);
    expect(order.lastIndexOf('DescribeMountTargetsCommand')).toBeGreaterThan(deleteMt);
    expect(order.lastIndexOf('DescribeMountTargetsCommand')).toBeLessThan(deleteFs);
  });

  it('refuses to destroy a file system NOT tagged iap:managed', async () => {
    mockLiveFs({ Tags: [{ Key: 'team', Value: 'core' }] });

    const report = await executor().apply(plan(), { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(efs.commandCalls(DeleteMountTargetCommand)).toHaveLength(0);
    expect(efs.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
  });
});
