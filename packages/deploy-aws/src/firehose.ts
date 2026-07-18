/**
 * `aws:firehose:DeliveryStream` handler (@aws-sdk/client-firehose) — the Stream
 * kind's delivery variant, an Amazon Data Firehose delivery stream (M23.5).
 *
 *   read   → DescribeDeliveryStream (by DeliveryStreamName) +
 *            ListTagsForDeliveryStream. ResourceNotFoundException → absent; a
 *            stream in DELETING status reads as absent (async teardown — never
 *            update or resurrect it).
 *   create → CreateDeliveryStream with DeliveryStreamType `DirectPut` (default —
 *            producers PutRecord straight in) and an S3DestinationConfiguration
 *            { BucketARN from attr `destinationBucketArn`, RoleARN from attr
 *            `roleArn` }, plus Tags. Both the bucket ARN and the role ARN are
 *            REQUIRED — a missing one fails closed (no partial delivery stream);
 *            the mapping wires a sibling aws:s3:Bucket and an aws:iam:Role with a
 *            firehose.amazonaws.com trust policy and s3 write permissions.
 *   update → UpdateDestination (destination drift — bucket ARN / role ARN
 *            reconcile in place; needs the live VersionId + DestinationId, so it
 *            re-describes first) + TagDeliveryStream.
 *   delete → DeleteDeliveryStream.
 *
 * REPLACEMENT (ADR-0006): `deliveryStreamType` is IMMUTABLE — DirectPut cannot
 * convert to KinesisStreamAsSource in place (the source is fixed at creation),
 * so type drift classifies as `replace` (gated delete+create). The S3
 * destination (bucket ARN, role ARN) reconciles in place via UpdateDestination.
 */

import {
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  ListTagsForDeliveryStreamCommand,
  TagDeliveryStreamCommand,
  UpdateDestinationCommand,
} from '@aws-sdk/client-firehose';
import type { DeliveryStreamType, FirehoseClient } from '@aws-sdk/client-firehose';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;
const DEFAULT_STREAM_TYPE = 'DirectPut';

export class FirehoseDeliveryStreamHandler implements TargetHandler {
  static readonly targetType = 'aws:firehose:DeliveryStream' as const;
  readonly targetType = FirehoseDeliveryStreamHandler.targetType;
  /** DirectPut ↔ KinesisStreamAsSource cannot convert in place (ADR-0006). */
  readonly immutableProjectionKeys = ['deliveryStreamType'] as const;

  constructor(private readonly firehose: FirehoseClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      deliveryStreamType: scalarStr(a['deliveryStreamType']) || DEFAULT_STREAM_TYPE,
      destinationBucketArn: scalarStr(a['destinationBucketArn']),
      roleArn: scalarStr(a['roleArn']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const DeliveryStreamName = resourceIdOf(resource);
    let description;
    try {
      const found = await this.firehose.send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName }),
      );
      description = found.DeliveryStreamDescription;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (description === undefined || description.DeliveryStreamStatus === 'DELETING') {
      // Deletion in progress — treat as absent; never update a dying stream.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tagResult = await this.firehose.send(
      new ListTagsForDeliveryStreamCommand({ DeliveryStreamName }),
    );
    const tags: Record<string, string> = {};
    for (const entry of tagResult.Tags ?? []) {
      if (entry.Key !== undefined) tags[entry.Key] = entry.Value ?? '';
    }

    // The S3 destination lives under either S3DestinationDescription or, when a
    // plan later graduates to the extended form, ExtendedS3DestinationDescription.
    const dest = (description.Destinations ?? [])[0];
    const s3 = dest?.S3DestinationDescription ?? dest?.ExtendedS3DestinationDescription;

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        deliveryStreamType: description.DeliveryStreamType ?? '',
        destinationBucketArn: s3?.BucketARN ?? '',
        roleArn: s3?.RoleARN ?? '',
      },
    };
    if (description.DeliveryStreamARN !== undefined) {
      state.identifier = description.DeliveryStreamARN;
    }
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const DeliveryStreamName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const { bucketArn, roleArn } = this.requireDestination(resource, d);
    const created = await this.firehose.send(
      new CreateDeliveryStreamCommand({
        DeliveryStreamName,
        DeliveryStreamType: d['deliveryStreamType'] as DeliveryStreamType,
        S3DestinationConfiguration: { BucketARN: bucketArn, RoleARN: roleArn },
        Tags: toTagList(tags),
      }),
    );
    return created.DeliveryStreamARN ?? `firehose:deliverystream/${DeliveryStreamName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const DeliveryStreamName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const { bucketArn, roleArn } = this.requireDestination(resource, d);

    // UpdateDestination is version-fenced: it needs the CURRENT VersionId and the
    // existing DestinationId, both only available from a fresh describe.
    const found = await this.firehose.send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName }),
    );
    const description = found.DeliveryStreamDescription;
    const DestinationId = (description?.Destinations ?? [])[0]?.DestinationId;
    if (description?.VersionId === undefined || DestinationId === undefined) {
      throw new Error(
        `delivery stream ${DeliveryStreamName} missing VersionId/DestinationId — refusing blind update`,
      );
    }
    await this.firehose.send(
      new UpdateDestinationCommand({
        DeliveryStreamName,
        CurrentDeliveryStreamVersionId: description.VersionId,
        DestinationId,
        S3DestinationUpdate: { BucketARN: bucketArn, RoleARN: roleArn },
      }),
    );
    await this.firehose.send(
      new TagDeliveryStreamCommand({ DeliveryStreamName, Tags: toTagList(current.tags) }),
    );
  }

  async delete(resource: PlanResource, _current: ResourceState): Promise<void> {
    await this.firehose.send(
      new DeleteDeliveryStreamCommand({ DeliveryStreamName: resourceIdOf(resource) }),
    );
  }

  /**
   * The S3 destination needs both a target bucket and a delivery role — Firehose
   * writes into a caller-owned bucket under an assumed role, so a plan missing
   * either fails closed rather than creating a broken delivery stream. The
   * mapping wires a sibling bucket + firehose.amazonaws.com role.
   */
  private requireDestination(
    resource: PlanResource,
    desired: Record<string, string>,
  ): { bucketArn: string; roleArn: string } {
    const bucketArn = desired['destinationBucketArn'] ?? '';
    const roleArn = desired['roleArn'] ?? '';
    if (bucketArn === '') {
      throw new Error(
        `delivery stream ${resourceIdOf(resource)} needs a destinationBucketArn attribute ` +
          `(sibling aws:s3:Bucket) — fail closed`,
      );
    }
    if (roleArn === '') {
      throw new Error(
        `delivery stream ${resourceIdOf(resource)} needs a roleArn attribute ` +
          `(firehose.amazonaws.com delivery role) — fail closed`,
      );
    }
    return { bucketArn, roleArn };
  }
}
