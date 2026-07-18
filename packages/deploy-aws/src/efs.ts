/**
 * `aws:efs:FileSystem` handler (@aws-sdk/client-efs) — elastic NFS storage
 * (M22.4), including the handler-owned mount target ('+MountTarget' scope).
 *
 * IDENTITY: EFS's native idempotent identity — CreationToken = resourceId.
 * read resolves DescribeFileSystems by CreationToken (empty list → absent;
 * LifeCycleState deleting/deleted → absent, the scheduled-for-deletion
 * idiom); tags ride the describe response.
 *
 * create → CreateFileSystem (CreationToken, ThroughputMode default elastic,
 *          PerformanceMode default generalPurpose, Encrypted, tags at
 *          creation), bounded waiter until the fs is 'available' (M22.4 live
 *          finding: CreateMountTarget issued while the fs is still 'creating'
 *          fails, and the partial create reads as converged on re-apply — so
 *          the handler owns the wait; EFS create is fast, seconds), then
 *          CreateMountTarget in the FIRST default-VPC subnet with the default
 *          security group (ADR-0005).
 * update → UpdateFileSystem (throughputMode drift) + TagResource.
 * delete → DescribeMountTargets → DeleteMountTarget(s) FIRST, bounded waiter
 *          until they are gone (mount targets take ~1 min to delete; EFS
 *          refuses DeleteFileSystem while any exist), then DeleteFileSystem.
 *          Waiter timeout fails closed (elasticache teardown-ordering idiom).
 *
 * PROJECTION: `performanceMode` is immutable (ADR-0006 → gated replace);
 * `throughputMode` reconciles in place.
 */

import {
  CreateFileSystemCommand,
  CreateMountTargetCommand,
  DeleteFileSystemCommand,
  DeleteMountTargetCommand,
  DescribeFileSystemsCommand,
  DescribeMountTargetsCommand,
  TagResourceCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-efs';
import type { EFSClient, PerformanceMode, ThroughputMode } from '@aws-sdk/client-efs';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSecurityGroupId, defaultSubnetIds } from './network.js';

const NOT_FOUND = ['FileSystemNotFound'] as const;

/** LifeCycleStates that mean "on its way out" — read as absent. */
const GONE_STATES = ['deleting', 'deleted'] as const;

export class EfsFileSystemHandler implements TargetHandler {
  static readonly targetType = 'aws:efs:FileSystem' as const;
  readonly targetType = EfsFileSystemHandler.targetType;
  /** Performance mode is fixed at creation (ADR-0006) — drift replaces. */
  readonly immutableProjectionKeys = ['performanceMode'] as const;

  constructor(
    private readonly efs: EFSClient,
    private readonly ec2: EC2Client,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      throughputMode: scalarStr(a['throughputMode']) || 'elastic',
      performanceMode: scalarStr(a['performanceMode']) || 'generalPurpose',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    let fileSystem;
    try {
      const found = await this.efs.send(
        new DescribeFileSystemsCommand({ CreationToken: resourceIdOf(resource) }),
      );
      fileSystem = found.FileSystems?.[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (
      fileSystem === undefined ||
      GONE_STATES.some((state) => state === fileSystem?.LifeCycleState)
    ) {
      // Absent, or already tearing down — never converge onto a dying fs.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromTagList(fileSystem.Tags ?? []);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        throughputMode: fileSystem.ThroughputMode ?? '',
        performanceMode: fileSystem.PerformanceMode ?? '',
      },
    };
    const identifier = fileSystem.FileSystemArn ?? fileSystem.FileSystemId;
    if (identifier !== undefined) state.identifier = identifier;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const d = this.desiredProjection(resource);
    const created = await this.efs.send(
      new CreateFileSystemCommand({
        // CreationToken IS the identity — AWS makes re-creates idempotent.
        CreationToken: resourceIdOf(resource),
        ThroughputMode: d['throughputMode'] as ThroughputMode,
        PerformanceMode: d['performanceMode'] as PerformanceMode,
        Encrypted: true,
        Tags: toTagList({ Name: resourceIdOf(resource), ...tags }),
      }),
    );
    // Handler-owned mount target in the first default subnet + default SG
    // (ADR-0005). The fs MUST be 'available' first — CreateMountTarget on a
    // 'creating' fs fails, and the resulting partial create reads as
    // converged on re-apply (M22.4 live finding) — bounded waiter, fail
    // closed.
    const [subnetIds, securityGroup] = await Promise.all([
      defaultSubnetIds(this.ec2, 1),
      defaultSecurityGroupId(this.ec2),
    ]);
    await this.waitForFileSystemAvailable(created.FileSystemId);
    await this.efs.send(
      new CreateMountTargetCommand({
        FileSystemId: created.FileSystemId,
        SubnetId: subnetIds[0],
        SecurityGroups: [securityGroup],
      }),
    );
    return created.FileSystemArn ?? created.FileSystemId ?? `efs:${resourceIdOf(resource)}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const FileSystemId = await this.resolveFileSystemId(resource);
    const d = this.desiredProjection(resource);
    if ((d['throughputMode'] ?? '') !== (current.projection['throughputMode'] ?? '')) {
      await this.efs.send(
        new UpdateFileSystemCommand({
          FileSystemId,
          ThroughputMode: d['throughputMode'] as ThroughputMode,
        }),
      );
    }
    await this.efs.send(
      new TagResourceCommand({ ResourceId: FileSystemId, Tags: toTagList(current.tags) }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    const FileSystemId = await this.resolveFileSystemId(resource);
    // Mount targets FIRST — EFS refuses DeleteFileSystem while any exist.
    const found = await this.efs.send(new DescribeMountTargetsCommand({ FileSystemId }));
    const mountTargets = found.MountTargets ?? [];
    for (const target of mountTargets) {
      await this.efs.send(new DeleteMountTargetCommand({ MountTargetId: target.MountTargetId }));
    }
    if (mountTargets.length > 0) {
      // Mount target deletion is async (~1 min live) — bounded waiter before
      // the fs delete can succeed (elasticache teardown-ordering idiom).
      await this.waitForMountTargetsGone(FileSystemId);
    }
    await this.efs.send(new DeleteFileSystemCommand({ FileSystemId }));
  }

  /**
   * FileSystemId via the CreationToken identity — mutations need the id, and
   * ids are AWS-generated (never derivable from the name).
   */
  private async resolveFileSystemId(resource: PlanResource): Promise<string> {
    const found = await this.efs.send(
      new DescribeFileSystemsCommand({ CreationToken: resourceIdOf(resource) }),
    );
    const id = found.FileSystems?.[0]?.FileSystemId;
    if (id === undefined) {
      throw new Error(
        `no EFS file system resolved for CreationToken=${resourceIdOf(resource)} — ` +
          `cannot mutate without its identity (fail closed)`,
      );
    }
    return id;
  }

  /**
   * Bounded waiter: 2s interval, ≤60 attempts = 2-minute budget, fail closed.
   * A fresh file system is 'creating' for a few seconds; CreateMountTarget is
   * only legal once it is 'available' (M22.4 live finding).
   */
  private async waitForFileSystemAvailable(fileSystemId: string | undefined): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = await this.efs.send(
        new DescribeFileSystemsCommand({ FileSystemId: fileSystemId }),
      );
      if (found.FileSystems?.[0]?.LifeCycleState === 'available') return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(
      `file system ${fileSystemId} did not reach 'available' within the ` +
        `2-minute waiter budget — mount target NOT created (fail closed)`,
    );
  }

  /** Bounded waiter: 10s interval, ≤30 attempts = 5-minute budget, fail closed. */
  private async waitForMountTargetsGone(fileSystemId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const found = await this.efs.send(
          new DescribeMountTargetsCommand({ FileSystemId: fileSystemId }),
        );
        if ((found.MountTargets?.length ?? 0) === 0) return;
      } catch (err) {
        if (nameMatches(err, NOT_FOUND)) return;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error(
      `mount targets of ${fileSystemId} did not finish deleting within the ` +
        `5-minute waiter budget — file system NOT deleted (fail closed)`,
    );
  }
}
