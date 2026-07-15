/**
 * `aws:s3:Bucket` handler (@aws-sdk/client-s3).
 *
 * read → HeadBucket (+ GetBucketTagging / GetBucketEncryption / GetBucketVersioning)
 * create → CreateBucket, PutBucketEncryption, PutBucketVersioning, PutBucketTagging
 * update → PutBucketEncryption, PutBucketVersioning, PutBucketTagging
 * delete → DeleteBucket
 *
 * Idempotent: read decides create vs no-op vs update; the physical bucket name
 * is the plan resourceId.
 */

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';
import type {
  BucketLocationConstraint,
  BucketVersioningStatus,
  CreateBucketCommandInput,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { httpStatus, nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['NotFound', 'NoSuchBucket'] as const;
const NO_TAG_SET = ['NoSuchTagSet'] as const;
const NO_ENCRYPTION = ['ServerSideEncryptionConfigurationNotFoundError'] as const;

function isNotFound(err: unknown): boolean {
  return nameMatches(err, NOT_FOUND) || httpStatus(err) === 404;
}

export class S3BucketHandler implements TargetHandler {
  readonly targetType = 'aws:s3:Bucket' as const;

  constructor(
    private readonly client: S3Client,
    private readonly region: string,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      sseAlgorithm: scalarStr(a['sseAlgorithm']),
      versioningStatus: scalarStr(a['versioningStatus']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const Bucket = resourceIdOf(resource);
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch (err) {
      if (isNotFound(err)) return { exists: false, managed: false, tags: {}, projection: {} };
      throw err;
    }

    let tags: Record<string, string> = {};
    try {
      const tagging = await this.client.send(new GetBucketTaggingCommand({ Bucket }));
      tags = fromTagList(tagging.TagSet ?? []);
    } catch (err) {
      if (!nameMatches(err, NO_TAG_SET)) throw err;
    }

    let sseAlgorithm = '';
    try {
      const enc = await this.client.send(new GetBucketEncryptionCommand({ Bucket }));
      sseAlgorithm =
        enc.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault
          ?.SSEAlgorithm ?? '';
    } catch (err) {
      if (!nameMatches(err, NO_ENCRYPTION)) throw err;
    }

    const versioning = await this.client.send(new GetBucketVersioningCommand({ Bucket }));

    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: `arn:aws:s3:::${Bucket}`,
      projection: { sseAlgorithm, versioningStatus: versioning.Status ?? '' },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const Bucket = resourceIdOf(resource);
    const input: CreateBucketCommandInput = { Bucket };
    // us-east-1 must NOT carry a LocationConstraint (SDK/API constraint).
    if (this.region !== 'us-east-1') {
      input.CreateBucketConfiguration = {
        LocationConstraint: this.region as BucketLocationConstraint,
      };
    }
    await this.client.send(new CreateBucketCommand(input));
    await this.applyConfig(resource, Bucket);
    await this.client.send(
      new PutBucketTaggingCommand({ Bucket, Tagging: { TagSet: toTagList(tags) } }),
    );
    return `arn:aws:s3:::${Bucket}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const Bucket = resourceIdOf(resource);
    await this.applyConfig(resource, Bucket);
    await this.client.send(
      new PutBucketTaggingCommand({ Bucket, Tagging: { TagSet: toTagList(current.tags) } }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(new DeleteBucketCommand({ Bucket: resourceIdOf(resource) }));
  }

  private async applyConfig(resource: PlanResource, Bucket: string): Promise<void> {
    const sse = scalarStr(resource.desiredAttributes['sseAlgorithm']);
    if (sse) {
      await this.client.send(
        new PutBucketEncryptionCommand({
          Bucket,
          ServerSideEncryptionConfiguration: {
            Rules: [
              { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: sse as ServerSideEncryption } },
            ],
          },
        }),
      );
    }
    const status = scalarStr(resource.desiredAttributes['versioningStatus']);
    if (status) {
      await this.client.send(
        new PutBucketVersioningCommand({
          Bucket,
          VersioningConfiguration: { Status: status as BucketVersioningStatus },
        }),
      );
    }
  }
}
