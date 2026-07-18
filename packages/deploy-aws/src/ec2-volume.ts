/**
 * `aws:ec2:Volume` handler (@aws-sdk/client-ec2) — EBS block storage (M22.4).
 *
 * IDENTITY: EBS volumes have no caller-chosen names — volume ids are generated
 * by AWS. The handler therefore OWNS THE `iap:resourceId` TAG as the stable
 * identity: read filters DescribeVolumes on `tag:iap:resourceId=<logicalId>`
 * (the exact value buildTags stamps at creation) restricted to live states
 * (never deleting/deleted). MORE THAN ONE match is an ambiguous identity and
 * fails closed with a loud error — the handler never guesses which volume it
 * owns. A `Name` tag (= resourceId) is also set for console humans.
 *
 * read   → DescribeVolumes with the tag + status filters; 0 → absent,
 *          1 → present, >1 → fail closed (ambiguous identity).
 * create → CreateVolume: AvailabilityZone from the `availabilityZone`
 *          attribute when pinned, otherwise derived from the FIRST default
 *          subnet's AZ (ADR-0005 default-VPC idiom); Encrypted by default;
 *          TagSpecifications carry all tags at creation (incl. Name).
 * update → ModifyVolume for sizeGiB GROWTH and volumeType changes. EBS can
 *          NEVER shrink: a desired size below the live size throws an honest
 *          error so apply records the failure — it is not silently
 *          reconcilable and must not pretend to be.
 * delete → DeleteVolume (requires the volume to be available/unattached — an
 *          in-use volume's delete failure surfaces honestly from AWS).
 *
 * PROJECTION: `availabilityZone` and `encrypted` are immutable (ADR-0006 →
 * gated replace). `availabilityZone` participates in drift only when the plan
 * pins it — an unpinned AZ is derived at create time and never drifts.
 */

import {
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  ModifyVolumeCommand,
} from '@aws-sdk/client-ec2';
import type { EC2Client, VolumeType } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { RESOURCE_TAG_KEY, fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';
import { defaultVpcId } from './network.js';

/** Volume states that count as "live" for identity resolution. */
const LIVE_VOLUME_STATES = ['creating', 'available', 'in-use', 'error'] as const;

export class Ec2VolumeHandler implements TargetHandler {
  static readonly targetType = 'aws:ec2:Volume' as const;
  readonly targetType = Ec2VolumeHandler.targetType;
  /** Placement and encryption are fixed at creation (ADR-0006) — drift replaces. */
  readonly immutableProjectionKeys = ['availabilityZone', 'encrypted'] as const;

  constructor(private readonly ec2: EC2Client) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    const az = scalarStr(a['availabilityZone']);
    return {
      volumeType: scalarStr(a['volumeType']) || 'gp3',
      sizeGiB: scalarStr(a['sizeGiB']) || '8',
      encrypted: scalarStr(a['encrypted']) || 'true',
      // Only a PINNED AZ participates in drift; a derived one never drifts.
      ...(az !== '' ? { availabilityZone: az } : {}),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    // The iap:resourceId tag value IS buildTags' value: the full logicalId.
    const identityTag = resource.logicalId;
    const found = await this.ec2.send(
      new DescribeVolumesCommand({
        Filters: [
          { Name: `tag:${RESOURCE_TAG_KEY}`, Values: [identityTag] },
          { Name: 'status', Values: [...LIVE_VOLUME_STATES] },
        ],
      }),
    );
    const volumes = found.Volumes ?? [];
    if (volumes.length > 1) {
      // Two volumes claiming one identity — the handler refuses to guess
      // which it owns (a wrong guess deletes or resizes the wrong disk).
      throw new Error(
        `ambiguous EBS identity: ${volumes.length} volumes carry ` +
          `${RESOURCE_TAG_KEY}=${identityTag} (${volumes
            .map((v) => v.VolumeId ?? '?')
            .join(', ')}) — refusing to guess; resolve the duplicate manually (fail closed)`,
      );
    }
    const volume = volumes[0];
    if (volume === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromTagList(volume.Tags ?? []);
    const azPinned = scalarStr(resource.desiredAttributes['availabilityZone']) !== '';
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        volumeType: volume.VolumeType ?? '',
        sizeGiB: String(volume.Size ?? 0),
        encrypted: String(volume.Encrypted ?? false),
        ...(azPinned ? { availabilityZone: volume.AvailabilityZone ?? '' } : {}),
      },
    };
    if (volume.VolumeId !== undefined) state.identifier = volume.VolumeId;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const d = this.desiredProjection(resource);
    const AvailabilityZone = d['availabilityZone'] ?? (await this.firstDefaultSubnetAz());
    const created = await this.ec2.send(
      new CreateVolumeCommand({
        AvailabilityZone,
        VolumeType: d['volumeType'] as VolumeType,
        Size: Number(d['sizeGiB']),
        Encrypted: d['encrypted'] !== 'false',
        TagSpecifications: [
          {
            ResourceType: 'volume',
            // Name = resourceId for console humans; mandatory iap tags win.
            Tags: toTagList({ Name: resourceIdOf(resource), ...tags }),
          },
        ],
      }),
    );
    return created.VolumeId ?? `ebs:${resourceIdOf(resource)}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const VolumeId = this.volumeIdOf(resource, current);
    const d = this.desiredProjection(resource);
    const live = current.projection;

    const desiredSize = Number(d['sizeGiB']);
    const liveSize = Number(live['sizeGiB'] || '0');
    if (desiredSize < liveSize) {
      // EBS volumes can NEVER shrink — pretending this reconciles would lie.
      // Throw so apply records the honest failure (fail closed).
      throw new Error(
        `EBS volumes cannot shrink: ${resource.logicalId} is ${liveSize} GiB live but ` +
          `${desiredSize} GiB desired — refusing (raise sizeGiB or replace the volume ` +
          `and migrate the data manually)`,
      );
    }

    const grow = desiredSize > liveSize;
    const retype = (d['volumeType'] ?? '') !== (live['volumeType'] ?? '');
    if (!grow && !retype) return;
    await this.ec2.send(
      new ModifyVolumeCommand({
        VolumeId,
        ...(grow ? { Size: desiredSize } : {}),
        ...(retype ? { VolumeType: d['volumeType'] as VolumeType } : {}),
      }),
    );
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    // DeleteVolume requires the volume to be available (unattached) — an
    // in-use volume's failure surfaces honestly from AWS, never masked.
    await this.ec2.send(new DeleteVolumeCommand({ VolumeId: this.volumeIdOf(resource, current) }));
  }

  /** The volume id resolved by read — the only handle mutations may use. */
  private volumeIdOf(resource: PlanResource, current: ResourceState): string {
    if (current.identifier === undefined) {
      throw new Error(
        `no volume id resolved for ${resource.logicalId} — cannot mutate an EBS volume ` +
          `without its read-resolved identity (fail closed)`,
      );
    }
    return current.identifier;
  }

  /**
   * AZ of the FIRST default-VPC subnet (deterministic: sorted by AZ) — the
   * ADR-0005 placement for volumes whose plan does not pin an AZ.
   */
  private async firstDefaultSubnetAz(): Promise<string> {
    const vpcId = await defaultVpcId(this.ec2);
    const subnets = await this.ec2.send(
      new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }] }),
    );
    const byAz = [...(subnets.Subnets ?? [])].sort((a, b) =>
      (a.AvailabilityZone ?? '') < (b.AvailabilityZone ?? '') ? -1 : 1,
    );
    const az = byAz[0]?.AvailabilityZone;
    if (az === undefined) {
      throw new Error(
        'default VPC has no subnets to derive an availability zone from ' +
          '(ADR-0005 pre-flight) — pin the availabilityZone attribute',
      );
    }
    return az;
  }
}
