/**
 * M22.4 FSx handler, mock-tested: `aws:fsx:FileSystem` (FSx for OpenZFS,
 * single-AZ). Covers tag-based identity (unnamed resource, paginated
 * describe), the OPENZFS-only fail-closed posture, default-network placement,
 * grow-only storage, in-place throughput updates, immutable
 * deploymentType → gated replace (ADR-0006), managed-only destroy, and the
 * ambiguous-identity refusal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  FSxClient,
  TagResourceCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-fsx';
import type { FileSystem } from '@aws-sdk/client-fsx';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const fsx = mockClient(FSxClient);
const ec2 = mockClient(EC2Client);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

/** The identity tag value is the plan logicalId (`<resourceId>.<type>`). */
const LOGICAL_ID = 'share.aws:fsx:FileSystem';

const fsPlan = (attrs: Record<string, string | number> = {}) =>
  providerPlan([planResource('share', 'aws:fsx:FileSystem', attrs)]);

const IDENTITY_TAGS = [
  { Key: 'iap:managed', Value: 'true' },
  { Key: 'iap:resourceId', Value: LOGICAL_ID },
];

/** A live OpenZFS file system converged with the plan defaults. */
function liveFileSystem(overrides: Partial<FileSystem> = {}): FileSystem {
  return {
    FileSystemId: 'fs-0123456789abcdef0',
    ResourceARN: 'arn:aws:fsx:eu-central-1:000000000000:file-system/fs-0123456789abcdef0',
    FileSystemType: 'OPENZFS',
    Lifecycle: 'AVAILABLE',
    StorageCapacity: 64,
    StorageType: 'SSD',
    Tags: IDENTITY_TAGS,
    OpenZFSConfiguration: {
      DeploymentType: 'SINGLE_AZ_1',
      ThroughputCapacity: 64,
      AutomaticBackupRetentionDays: 0,
    },
    ...overrides,
  };
}

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

beforeEach(() => {
  fsx.reset();
  ec2.reset();
});

describe('aws:fsx:FileSystem', () => {
  it('tag-identity read absent → CreateFileSystem with OPENZFS config, first default subnet + SG, tags', async () => {
    fsx.on(DescribeFileSystemsCommand).resolves({ FileSystems: [] });
    fsx.on(CreateFileSystemCommand).resolves({ FileSystem: { FileSystemId: 'fs-new0001' } });
    mockDefaultNetwork();

    const report = await executor().apply(fsPlan(), { apply: true });

    expect(report.errors).toHaveLength(0);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('fs-new0001');

    const input = fsx.commandCalls(CreateFileSystemCommand)[0]?.args[0].input;
    expect(input?.FileSystemType).toBe('OPENZFS');
    expect(input?.StorageCapacity).toBe(64); // storageGiB default
    expect(input?.StorageType).toBe('SSD');
    expect(input?.SubnetIds).toEqual(['subnet-a']); // FIRST default subnet only (single-AZ)
    expect(input?.SecurityGroupIds).toEqual(['sg-default']);
    expect(input?.OpenZFSConfiguration?.DeploymentType).toBe('SINGLE_AZ_1');
    expect(input?.OpenZFSConfiguration?.ThroughputCapacity).toBe(64); // throughputMBps default
    expect(input?.OpenZFSConfiguration?.AutomaticBackupRetentionDays).toBe(0);

    const tags = input?.Tags ?? [];
    expect(tags.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(tags.some((t) => t.Key === 'iap:resourceId' && t.Value === LOGICAL_ID)).toBe(true);
    expect(tags.some((t) => t.Key === 'iap:planId')).toBe(true);
    expect(tags.some((t) => t.Key === 'Name' && t.Value === 'share')).toBe(true);
  });

  it("unsupported fileSystemType 'LUSTRE' fails closed — recorded error, zero calls", async () => {
    const report = await executor().apply(fsPlan({ fileSystemType: 'LUSTRE' }), { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain("unsupported fileSystemType 'LUSTRE'");
    expect(report.errors[0]).toContain('only OPENZFS');
    // Fails before ANY call — no describe, no create, no silent downgrade.
    expect(fsx.commandCalls(DescribeFileSystemsCommand)).toHaveLength(0);
    expect(fsx.commandCalls(CreateFileSystemCommand)).toHaveLength(0);
  });

  it('present + converged reads no-op across DescribeFileSystems pages (client-side tag match)', async () => {
    // Page 1 holds only a foreign file system; ours is on page 2 — the
    // handler must paginate and filter on iap:resourceId client-side.
    fsx.on(DescribeFileSystemsCommand).callsFake((input: { NextToken?: string }) =>
      input.NextToken === 'page-2'
        ? { FileSystems: [liveFileSystem()] }
        : {
            FileSystems: [
              liveFileSystem({
                FileSystemId: 'fs-other',
                Tags: [{ Key: 'iap:resourceId', Value: 'other.aws:fsx:FileSystem' }],
              }),
            ],
            NextToken: 'page-2',
          },
    );

    const report = await executor().plan(fsPlan());
    expect(report.items[0]?.action).toBe('no-op');
    expect(fsx.commandCalls(DescribeFileSystemsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('throughputMBps drift → UpdateFileSystem in place (no delete, no storage change)', async () => {
    fsx.on(DescribeFileSystemsCommand).resolves({ FileSystems: [liveFileSystem()] });
    fsx.on(UpdateFileSystemCommand).resolves({});
    fsx.on(TagResourceCommand).resolves({});

    const report = await executor().apply(fsPlan({ throughputMBps: 128 }), { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = fsx.commandCalls(UpdateFileSystemCommand)[0]?.args[0].input;
    expect(input?.FileSystemId).toBe('fs-0123456789abcdef0');
    expect(input?.OpenZFSConfiguration?.ThroughputCapacity).toBe(128);
    expect(input?.StorageCapacity).toBeUndefined(); // unchanged — not resent
    expect(fsx.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
  });

  it('storageGiB grows in place; shrink fails closed with an honest grow-only error', async () => {
    // Grow 64 → 128: UpdateFileSystem with the new capacity.
    fsx.on(DescribeFileSystemsCommand).resolves({ FileSystems: [liveFileSystem()] });
    fsx.on(UpdateFileSystemCommand).resolves({});
    fsx.on(TagResourceCommand).resolves({});

    const grown = await executor().apply(fsPlan({ storageGiB: 128 }), { apply: true });
    expect(grown.items[0]?.action).toBe('update');
    expect(grown.items[0]?.applied).toBe(true);
    expect(fsx.commandCalls(UpdateFileSystemCommand)[0]?.args[0].input?.StorageCapacity).toBe(128);

    // Shrink 128 → 64 (the default): refuse before ANY mutating call.
    fsx.reset();
    fsx.on(DescribeFileSystemsCommand).resolves({
      FileSystems: [liveFileSystem({ StorageCapacity: 128 })],
    });

    const refused = await executor().apply(fsPlan(), { apply: true });
    expect(refused.items[0]?.action).toBe('update'); // storageGiB is mutable…
    expect(refused.items[0]?.applied).toBe(false); // …but only in the grow direction
    expect(refused.errors[0]).toContain('grow-only');
    expect(fsx.commandCalls(UpdateFileSystemCommand)).toHaveLength(0);
    expect(fsx.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
  });

  it('deploymentType drift is IMMUTABLE → replace, executed only behind the replacement gate', async () => {
    fsx.on(DescribeFileSystemsCommand).resolves({
      FileSystems: [
        liveFileSystem({
          OpenZFSConfiguration: {
            DeploymentType: 'SINGLE_AZ_2', // desired default is SINGLE_AZ_1
            ThroughputCapacity: 64,
            AutomaticBackupRetentionDays: 0,
          },
        }),
      ],
    });

    const planned = await executor().plan(fsPlan());
    expect(planned.items[0]?.action).toBe('replace');
    expect(planned.items[0]?.reason).toContain('delete+create');

    // Replacement gate CLOSED: refuse — destructive delete+create needs replace: true.
    const refused = await executor().apply(fsPlan(), { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(fsx.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
    expect(fsx.commandCalls(CreateFileSystemCommand)).toHaveLength(0);

    // Gate OPEN: DeleteFileSystem (old id) THEN CreateFileSystem (desired shape).
    fsx.on(DeleteFileSystemCommand).resolves({});
    fsx.on(CreateFileSystemCommand).resolves({ FileSystem: { FileSystemId: 'fs-replacement' } });
    mockDefaultNetwork();

    const replaced = await executor().apply(fsPlan(), { apply: true, replace: true });
    expect(replaced.errors).toHaveLength(0);
    expect(replaced.items[0]?.applied).toBe(true);
    expect(replaced.items[0]?.identifier).toBe('fs-replacement');
    const del = fsx.commandCalls(DeleteFileSystemCommand)[0]?.args[0].input;
    expect(del?.FileSystemId).toBe('fs-0123456789abcdef0');
    const created = fsx.commandCalls(CreateFileSystemCommand)[0]?.args[0].input;
    expect(created?.OpenZFSConfiguration?.DeploymentType).toBe('SINGLE_AZ_1');
  });

  it('destroy → DeleteFileSystem when managed; refuses unmanaged (managed-only gate)', async () => {
    fsx.on(DescribeFileSystemsCommand).resolves({ FileSystems: [liveFileSystem()] });
    fsx.on(DeleteFileSystemCommand).resolves({});

    const report = await executor().apply(fsPlan(), { apply: true, destroy: true });
    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    const input = fsx.commandCalls(DeleteFileSystemCommand)[0]?.args[0].input;
    expect(input?.FileSystemId).toBe('fs-0123456789abcdef0');

    // Same file system without iap:managed=true → the delete is refused.
    fsx.reset();
    fsx.on(DescribeFileSystemsCommand).resolves({
      FileSystems: [liveFileSystem({ Tags: [{ Key: 'iap:resourceId', Value: LOGICAL_ID }] })],
    });

    const refused = await executor().apply(fsPlan(), { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('managed-only destroy');
    expect(fsx.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
  });

  it('two file systems carrying the same iap:resourceId tag fail closed as ambiguous', async () => {
    fsx.on(DescribeFileSystemsCommand).resolves({
      FileSystems: [liveFileSystem(), liveFileSystem({ FileSystemId: 'fs-duplicate' })],
    });

    const report = await executor().apply(fsPlan(), { apply: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('ambiguous');
    expect(fsx.commandCalls(CreateFileSystemCommand)).toHaveLength(0);
    expect(fsx.commandCalls(UpdateFileSystemCommand)).toHaveLength(0);
    expect(fsx.commandCalls(DeleteFileSystemCommand)).toHaveLength(0);
  });

  it('a DELETING file system reads absent → converges via create (no resurrection wait in handler)', async () => {
    fsx.on(DescribeFileSystemsCommand).resolves({
      FileSystems: [liveFileSystem({ Lifecycle: 'DELETING' })],
    });

    const report = await executor().plan(fsPlan());
    expect(report.items[0]?.action).toBe('create');
  });
});
