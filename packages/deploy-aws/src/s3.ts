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
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
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
  static readonly targetType = 'aws:s3:Bucket' as const;
  readonly targetType = S3BucketHandler.targetType;

  constructor(
    private readonly client: S3Client,
    private readonly region: string,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      sseAlgorithm: scalarStr(a['sseAlgorithm']),
      versioningStatus: scalarStr(a['versioningStatus']),
      // Public-exposure posture (M22.1): compared only when the plan sets it,
      // so pre-M22.1 documents do not read as drifted.
      blockPublicAccess: scalarStr(a['blockPublicAccess']),
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

    // Public-access posture mirrors only when the plan pins it (see
    // desiredProjection) — absent-equals-empty keeps old documents converged.
    let blockPublicAccess = '';
    if (scalarStr(resource.desiredAttributes['blockPublicAccess']) !== '') {
      try {
        const pab = await this.client.send(new GetPublicAccessBlockCommand({ Bucket }));
        const c = pab.PublicAccessBlockConfiguration;
        blockPublicAccess =
          c?.BlockPublicAcls === true &&
          c?.BlockPublicPolicy === true &&
          c?.IgnorePublicAcls === true &&
          c?.RestrictPublicBuckets === true
            ? 'true'
            : 'false';
      } catch (err) {
        if (!nameMatches(err, ['NoSuchPublicAccessBlockConfiguration'])) throw err;
        blockPublicAccess = 'false';
      }
    }

    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: `arn:aws:s3:::${Bucket}`,
      projection: {
        sseAlgorithm,
        versioningStatus: versioning.Status ?? '',
        blockPublicAccess,
      },
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
    const blockPublic = scalarStr(resource.desiredAttributes['blockPublicAccess']);
    if (blockPublic !== '') {
      const block = blockPublic !== 'false';
      await this.client.send(
        new PutPublicAccessBlockCommand({
          Bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: block,
            BlockPublicPolicy: block,
            IgnorePublicAcls: block,
            RestrictPublicBuckets: block,
          },
        }),
      );
      // Public-read bucket policy only when the mapping's public branch asks.
      if (!block && scalarStr(resource.desiredAttributes['publicReadPolicy']) === 'true') {
        await this.client.send(
          new PutBucketPolicyCommand({
            Bucket,
            Policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Sid: 'PublicReadGetObject',
                  Effect: 'Allow',
                  Principal: '*',
                  Action: 's3:GetObject',
                  Resource: `arn:aws:s3:::${Bucket}/*`,
                },
              ],
            }),
          }),
        );
      }
    }
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
