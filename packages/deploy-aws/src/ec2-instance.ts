/**
 * `aws:ec2:Instance` handler (@aws-sdk/client-ec2) — a single EC2 instance
 * (M22.5).
 *
 * IDENTITY: tag-based. EC2 instance ids are generated, so the handler owns the
 * `iap:resourceId` tag as the stable identity. read → DescribeInstances with
 * Filters [`tag:iap:resourceId` = the plan logicalId — that is the exact value
 * `buildTags` stamps at creation — and `instance-state-name` restricted to the
 * live states (pending/running/stopping/stopped), i.e. NOT terminated or
 * shutting-down]. A terminated instance therefore reads as ABSENT and create
 * mints a fresh instance — a dying instance is never resurrected. MULTIPLE
 * live matches are an ambiguous identity and fail closed (thrown error), never
 * a silent pick.
 *
 * create → RunInstances: ImageId from `imageId` — REQUIRED, fail-closed when
 *          missing (no AMI default is baked into the runtime; the live driver
 *          resolves the current AL2023 arm64 AMI via SSM out-of-band),
 *          InstanceType from `instanceType` (default t4g.nano — the cheapest
 *          current-gen arm64 instance), default-VPC subnets + default SG
 *          (ADR-0005), MinCount/MaxCount 1, tags (incl. Name=<resourceId>) as
 *          TagSpecifications at launch. AZ FAILOVER (M22.5 live finding): an
 *          AZ can genuinely lack capacity for an instance type
 *          (InsufficientInstanceCapacity in eu-central-1a for t4g.nano) — the
 *          launch tries each default subnet's AZ in deterministic order and
 *          advances ONLY on capacity errors; every other failure (and
 *          exhaustion of all AZs) still fails closed with the real AWS error.
 * update → tags only (CreateTags). Both projection keys are immutable, so the
 *          classifier never routes attribute drift here.
 * delete → TerminateInstances.
 *
 * IMMUTABILITY (ADR-0006): `imageId` is genuinely immutable — a new AMI is a
 * new instance (gated replace). `instanceType` is classified IMMUTABLE for v1
 * even though AWS allows an in-place ModifyInstanceAttribute — but ONLY while
 * the instance is stopped; orchestrating stop→modify→start is out of scope for
 * v1, and classifying the drift as gated replace is the fail-closed posture
 * (an explicit, gated delete+create instead of an implicit outage).
 */

import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import type { EC2Client, _InstanceType } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { RESOURCE_TAG_KEY, fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSecurityGroupId, defaultSubnetIds } from './network.js';

const DEFAULT_INSTANCE_TYPE = 't4g.nano';

/** States a live instance can be in — terminated/shutting-down read as absent. */
const LIVE_STATES = ['pending', 'running', 'stopping', 'stopped'] as const;

/**
 * Error tokens that mean "this AZ cannot host the instance type right now" —
 * the launch may retry in the next default-subnet AZ (M22.5 live finding).
 */
const AZ_CAPACITY_ERRORS = ['InsufficientInstanceCapacity', 'Unsupported'] as const;

export class Ec2InstanceHandler implements TargetHandler {
  static readonly targetType = 'aws:ec2:Instance' as const;
  readonly targetType = Ec2InstanceHandler.targetType;
  /**
   * imageId: a new AMI is a new instance. instanceType: mutable on AWS only
   * while stopped — v1 takes the fail-closed gated-replace posture instead of
   * orchestrating a stop/start window (see file header).
   */
  readonly immutableProjectionKeys = ['imageId', 'instanceType'] as const;

  constructor(private readonly ec2: EC2Client) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      imageId: scalarStr(a['imageId']),
      instanceType: scalarStr(a['instanceType']) || DEFAULT_INSTANCE_TYPE,
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const found = await this.ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          // The tag VALUE is the plan logicalId — exactly what buildTags stamps.
          { Name: `tag:${RESOURCE_TAG_KEY}`, Values: [resource.logicalId] },
          { Name: 'instance-state-name', Values: [...LIVE_STATES] },
        ],
      }),
    );
    // Defensive client-side re-filter: even if the server returns a dying
    // instance, terminated/shutting-down still reads as absent.
    const instances = (found.Reservations ?? [])
      .flatMap((reservation) => reservation.Instances ?? [])
      .filter((instance) => LIVE_STATES.some((s) => s === instance.State?.Name));
    if (instances.length === 0) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }
    if (instances.length > 1) {
      // Two live instances claiming one identity — never pick silently.
      throw new Error(
        `multiple live instances tagged ${RESOURCE_TAG_KEY}=${resource.logicalId} ` +
          `(${instances.map((i) => i.InstanceId).join(', ')}) — ambiguous identity, ` +
          'refusing to proceed (fail closed)',
      );
    }
    const instance = instances[0];
    if (instance === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }
    const tags = fromTagList(instance.Tags ?? []);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        imageId: instance.ImageId ?? '',
        instanceType: instance.InstanceType ?? '',
      },
    };
    if (instance.InstanceId !== undefined) state.identifier = instance.InstanceId;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const resourceId = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const imageId = d['imageId'] ?? '';
    if (imageId === '') {
      throw new Error(
        `aws:ec2:Instance '${resourceId}' requires attribute 'imageId' — no AMI default ` +
          'is baked into the runtime (the live driver resolves the AL2023 arm64 AMI via ' +
          'SSM out-of-band); refusing to guess (fail closed)',
      );
    }
    const [subnetIds, securityGroupId] = await Promise.all([
      defaultSubnetIds(this.ec2),
      defaultSecurityGroupId(this.ec2),
    ]);
    // AZ failover (M22.5 live finding): an AZ can lack capacity for the
    // instance type — try each default subnet's AZ in deterministic order,
    // advancing ONLY on capacity errors; anything else fails closed at once.
    let lastCapacityError: unknown;
    for (const subnetId of subnetIds) {
      try {
        const created = await this.ec2.send(
          new RunInstancesCommand({
            ImageId: imageId,
            InstanceType: d['instanceType'] as _InstanceType,
            MinCount: 1,
            MaxCount: 1,
            SubnetId: subnetId,
            SecurityGroupIds: [securityGroupId],
            TagSpecifications: [
              {
                ResourceType: 'instance',
                // Name is cosmetic (console); mandatory iap tags still win.
                Tags: toTagList({ Name: resourceId, ...tags }),
              },
            ],
          }),
        );
        return created.Instances?.[0]?.InstanceId ?? `ec2:instance/${resourceId}`;
      } catch (err) {
        if (!nameMatches(err, AZ_CAPACITY_ERRORS)) throw err;
        lastCapacityError = err; // this AZ is out of capacity — try the next one
      }
    }
    // Every default-subnet AZ refused for capacity — surface the real AWS error.
    throw lastCapacityError;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    // Both projection keys are immutable (drift → gated replace), so the only
    // reconcilable surface is the tag set.
    if (current.identifier === undefined) {
      throw new Error(
        `aws:ec2:Instance '${resourceIdOf(resource)}': no live instance id to tag (fail closed)`,
      );
    }
    await this.ec2.send(
      new CreateTagsCommand({
        Resources: [current.identifier],
        Tags: toTagList(current.tags),
      }),
    );
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    if (current.identifier === undefined) {
      throw new Error(
        `aws:ec2:Instance '${resourceIdOf(resource)}': no live instance id to terminate (fail closed)`,
      );
    }
    // Termination is asynchronous; a terminated instance reads as absent, so a
    // later create never resurrects it.
    await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [current.identifier] }));
  }
}
