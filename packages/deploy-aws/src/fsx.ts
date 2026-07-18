/**
 * `aws:fsx:FileSystem` handler (@aws-sdk/client-fsx) — FSx for OpenZFS
 * single-AZ, the cheapest FSx family (M22.4 posture). The `fileSystemType`
 * attribute keeps the door open for Lustre/ONTAP/Windows later, but only
 * OPENZFS is implemented: any other desired value fails closed with an honest
 * unsupported-value error — never a silent downgrade.
 *
 * IDENTITY: FSx file systems are unnamed — AWS generates the id. The handler
 * therefore identifies its file system by the mandatory `iap:resourceId` tag
 * (whose value is the plan logicalId, exactly what `buildTags` stamps at
 * create). A cosmetic `Name` tag is also set for the console.
 *
 * read   → DescribeFileSystems (paginated; FSx has no server-side tag filter)
 *          filtering client-side on `iap:resourceId`. Lifecycle DELETING or
 *          FAILED reads as ABSENT (deletes take minutes — the live driver
 *          polls to gone; no in-handler waiter). More than one live match
 *          fails closed as ambiguous.
 * create → CreateFileSystem: FileSystemType OPENZFS, SSD storage, first
 *          default-VPC subnet + default security group (ADR-0005 idiom),
 *          OpenZFSConfiguration { SINGLE_AZ_1, throughput, backup retention },
 *          tags at creation.
 * update → UpdateFileSystem: StorageCapacity is GROW-ONLY (FSx cannot shrink;
 *          a smaller desired size fails closed like EBS), ThroughputCapacity
 *          and AutomaticBackupRetentionDays reconcile in place (throughput
 *          changes park the file system in an optimizing state for minutes).
 *          Tags re-asserted via TagResource.
 * delete → DeleteFileSystem. OpenZFS single-AZ deletion takes minutes; the
 *          handler only issues the call (repo no-in-handler-waiter idiom).
 *
 * REPLACE (ADR-0006): `fileSystemType` and `deploymentType` are immutable —
 * drift on either classifies as gated delete+create.
 */

import {
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  TagResourceCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-fsx';
import type { FSxClient, FileSystem, OpenZFSDeploymentType } from '@aws-sdk/client-fsx';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { defaultSecurityGroupId, defaultSubnetIds } from './network.js';
import { RESOURCE_TAG_KEY, fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

/** Lifecycles that mean "gone or on its way out" — read as absent. */
const GONE_LIFECYCLES: readonly string[] = ['DELETING', 'FAILED'];

export class FsxFileSystemHandler implements TargetHandler {
  static readonly targetType = 'aws:fsx:FileSystem' as const;
  readonly targetType = FsxFileSystemHandler.targetType;
  /** Family and AZ topology are fixed at creation (ADR-0006) — drift replaces. */
  readonly immutableProjectionKeys = ['fileSystemType', 'deploymentType'] as const;

  constructor(private readonly fsx: FSxClient, private readonly ec2: EC2Client) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    this.requireOpenZfs(resource);
    const a = resource.desiredAttributes;
    return {
      fileSystemType: scalarStr(a['fileSystemType']) || 'OPENZFS',
      deploymentType: scalarStr(a['deploymentType']) || 'SINGLE_AZ_1',
      storageGiB: scalarStr(a['storageGiB']) || '64',
      throughputMBps: scalarStr(a['throughputMBps']) || '64',
      backupRetentionDays: scalarStr(a['backupRetentionDays']) || '0',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    // Fail closed BEFORE any call: an unsupported family must never be
    // half-managed (no describe, no create — an honest recorded error).
    this.requireOpenZfs(resource);

    const found = await this.findByTag(resource);
    if (found === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromTagList(found.Tags ?? []);
    const zfs = found.OpenZFSConfiguration;
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        fileSystemType: found.FileSystemType ?? '',
        deploymentType: zfs?.DeploymentType ?? '',
        storageGiB: found.StorageCapacity === undefined ? '' : String(found.StorageCapacity),
        throughputMBps:
          zfs?.ThroughputCapacity === undefined ? '' : String(zfs.ThroughputCapacity),
        backupRetentionDays: String(zfs?.AutomaticBackupRetentionDays ?? 0),
      },
    };
    if (found.FileSystemId !== undefined) state.identifier = found.FileSystemId;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const d = this.desiredProjection(resource);
    // ADR-0005 placement: first default-VPC subnet (single-AZ) + default SG.
    const [subnetIds, securityGroupId] = await Promise.all([
      defaultSubnetIds(this.ec2, 1),
      defaultSecurityGroupId(this.ec2),
    ]);

    const created = await this.fsx.send(
      new CreateFileSystemCommand({
        FileSystemType: 'OPENZFS',
        StorageCapacity: Number(d['storageGiB']),
        StorageType: 'SSD',
        SubnetIds: subnetIds,
        SecurityGroupIds: [securityGroupId],
        OpenZFSConfiguration: {
          DeploymentType: (d['deploymentType'] ?? 'SINGLE_AZ_1') as OpenZFSDeploymentType,
          ThroughputCapacity: Number(d['throughputMBps']),
          AutomaticBackupRetentionDays: Number(d['backupRetentionDays']),
        },
        // Cosmetic Name first so the mandatory iap tags can never be shadowed.
        Tags: toTagList({ Name: resourceIdOf(resource), ...tags }),
      }),
    );
    return created.FileSystem?.FileSystemId ?? `fsx:${resourceIdOf(resource)}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    const live = current.projection;

    // GROW-ONLY storage, validated before ANY call: FSx cannot shrink a file
    // system — like EBS, a smaller desired size is an honest hard error.
    const desiredGiB = Number(d['storageGiB']);
    const liveGiB = Number(live['storageGiB'] || '0');
    if (desiredGiB < liveGiB) {
      throw new Error(
        `refusing to shrink ${resource.logicalId}: FSx storage is grow-only ` +
          `(live ${liveGiB} GiB > desired ${desiredGiB} GiB); ` +
          `restoring to a smaller file system requires manual migration`,
      );
    }

    const found = await this.requireByTag(resource, current);

    const zfs: { ThroughputCapacity?: number; AutomaticBackupRetentionDays?: number } = {};
    if ((d['throughputMBps'] ?? '') !== (live['throughputMBps'] ?? '')) {
      // In-place, but the file system parks in an optimizing state for minutes.
      zfs.ThroughputCapacity = Number(d['throughputMBps']);
    }
    if ((d['backupRetentionDays'] ?? '') !== (live['backupRetentionDays'] ?? '')) {
      zfs.AutomaticBackupRetentionDays = Number(d['backupRetentionDays']);
    }
    const grow = desiredGiB > liveGiB;
    if (grow || Object.keys(zfs).length > 0) {
      await this.fsx.send(
        new UpdateFileSystemCommand({
          FileSystemId: found.FileSystemId,
          ...(grow ? { StorageCapacity: desiredGiB } : {}),
          ...(Object.keys(zfs).length > 0 ? { OpenZFSConfiguration: zfs } : {}),
        }),
      );
    }
    if (found.ResourceARN !== undefined) {
      await this.fsx.send(
        new TagResourceCommand({ ResourceARN: found.ResourceARN, Tags: toTagList(current.tags) }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const FileSystemId =
      current.identifier ?? (await this.requireByTag(resource, current)).FileSystemId;
    // Deletion takes minutes (DELETING lifecycle, which read treats as
    // absent); the live driver polls to gone — no in-handler waiter.
    await this.fsx.send(new DeleteFileSystemCommand({ FileSystemId }));
  }

  /** Fail closed on any FSx family other than the implemented OPENZFS. */
  private requireOpenZfs(resource: PlanResource): void {
    const family = scalarStr(resource.desiredAttributes['fileSystemType']) || 'OPENZFS';
    if (family !== 'OPENZFS') {
      throw new Error(
        `unsupported fileSystemType '${family}' for ${this.targetType}: only OPENZFS ` +
          `(single-AZ) is implemented in M22.4 — LUSTRE/ONTAP/WINDOWS are not supported yet`,
      );
    }
  }

  /**
   * Tag-based identity: paginate DescribeFileSystems and match client-side on
   * `iap:resourceId` (FSx has no server-side tag filter). DELETING/FAILED
   * file systems are skipped (absent). >1 live match fails closed: the tag is
   * the identity, and an ambiguous identity must never be converged blindly.
   */
  private async findByTag(resource: PlanResource): Promise<FileSystem | undefined> {
    const wanted = resource.logicalId;
    const matches: FileSystem[] = [];
    let NextToken: string | undefined;
    do {
      const page = await this.fsx.send(
        new DescribeFileSystemsCommand(NextToken === undefined ? {} : { NextToken }),
      );
      for (const fs of page.FileSystems ?? []) {
        if (fromTagList(fs.Tags ?? [])[RESOURCE_TAG_KEY] !== wanted) continue;
        if (GONE_LIFECYCLES.includes(fs.Lifecycle ?? '')) continue;
        matches.push(fs);
      }
      NextToken = page.NextToken;
    } while (NextToken !== undefined);

    if (matches.length > 1) {
      const ids = matches.map((fs) => fs.FileSystemId ?? '?').join(', ');
      throw new Error(
        `ambiguous ${this.targetType} identity: ${matches.length} file systems tagged ` +
          `${RESOURCE_TAG_KEY}=${wanted} (${ids}) — refusing to converge; ` +
          `delete the stray file system(s) manually`,
      );
    }
    return matches[0];
  }

  /** Locate for mutation — prefers a fresh describe (id + ARN); must exist. */
  private async requireByTag(
    resource: PlanResource,
    current: ResourceState,
  ): Promise<FileSystem> {
    const found = await this.findByTag(resource);
    if (found === undefined) {
      // Fall back to what read saw — enough for id-only operations.
      if (current.identifier !== undefined) return { FileSystemId: current.identifier };
      throw new Error(`${resource.logicalId}: file system vanished between read and mutation`);
    }
    return found;
  }
}
