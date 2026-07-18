/**
 * `aws:ecr:Repository` handler (@aws-sdk/client-ecr) — the container Registry
 * kind (M23.2).
 *
 * read → DescribeRepositories (RepositoryNotFoundException → absent)
 *        + ListTagsForResource
 * create → CreateRepository (imageTagMutability, encryptionConfiguration,
 *          imageScanningConfiguration, tags inline)
 * update → PutImageTagMutability / PutImageScanningConfiguration (drifted
 *          mutable attrs only) + TagResource (re-assert ownership tags)
 * delete → DeleteRepository force:true — zero-orphan teardown even when images
 *          have been pushed (an un-forced delete fails on a non-empty repo).
 *
 * IDENTITY — the physical repository name is the plan resourceId.
 *
 * PROJECTION / REPLACEMENT (ADR-0006):
 *   - encryptionType + encryptionKmsKey are CREATE-ONLY on AWS (the encryption
 *     posture cannot change after CreateRepository) → IMMUTABLE; drift on them
 *     classifies as gated replace (delete+create), never update.
 *   - imageTagMutability and scanOnPush are mutable in place.
 *
 * DESIRED-GATING (M22.1 SQS / M22.2 DynamoDB lesson): a KMS repository reports
 * an AWS-assigned kmsKey ARN even when the plan pinned none, so the kmsKey is
 * compared only when the plan pins `kmsKey` — an unpinned plan must not read
 * the AWS default as drift.
 *
 * OUTPUTS: identifier = repositoryArn. The repository's push/pull endpoint is
 * repositoryUri (surfaced in comments; the handler contract carries a single
 * identifier field, so repositoryArn is the canonical output).
 */

import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeRepositoriesCommand,
  ListTagsForResourceCommand,
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  TagResourceCommand,
} from '@aws-sdk/client-ecr';
import type { ECRClient, EncryptionType, ImageTagMutability } from '@aws-sdk/client-ecr';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['RepositoryNotFoundException'] as const;
const DEFAULT_MUTABILITY = 'MUTABLE';
const DEFAULT_ENCRYPTION = 'AES256';

export class EcrRepositoryHandler implements TargetHandler {
  static readonly targetType = 'aws:ecr:Repository' as const;
  readonly targetType = EcrRepositoryHandler.targetType;
  /** Encryption posture is create-only on AWS — drift replaces (ADR-0006). */
  readonly immutableProjectionKeys = ['encryptionType', 'encryptionKmsKey'] as const;

  constructor(private readonly ecr: ECRClient) {}

  /** True when the plan pins a specific KMS key (desired-gated comparison). */
  private kmsPinned(resource: PlanResource): boolean {
    return scalarStr(resource.desiredAttributes['kmsKey']) !== '';
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      imageTagMutability: scalarStr(a['imageTagMutability']) || DEFAULT_MUTABILITY,
      // scanOnPush defaults to true (common posture); only explicit false opts out.
      scanOnPush: scalarStr(a['scanOnPush']) === 'false' ? 'false' : 'true',
      encryptionType: scalarStr(a['encryptionType']) || DEFAULT_ENCRYPTION,
      // Compare the KMS key only when the plan pins one (AWS assigns a managed
      // key otherwise, which an unpinned plan must not read as drift).
      encryptionKmsKey: scalarStr(a['kmsKey']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const repositoryName = resourceIdOf(resource);
    let repo;
    try {
      const found = await this.ecr.send(
        new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }),
      );
      repo = (found.repositories ?? [])[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (repo === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (repo.repositoryArn !== undefined) {
      const tagResult = await this.ecr.send(
        new ListTagsForResourceCommand({ resourceArn: repo.repositoryArn }),
      );
      tags = fromTagList(tagResult.tags ?? []);
    }

    const projection: Record<string, string> = {
      imageTagMutability: repo.imageTagMutability ?? DEFAULT_MUTABILITY,
      scanOnPush: repo.imageScanningConfiguration?.scanOnPush === true ? 'true' : 'false',
      encryptionType: repo.encryptionConfiguration?.encryptionType ?? DEFAULT_ENCRYPTION,
      encryptionKmsKey: this.kmsPinned(resource)
        ? (repo.encryptionConfiguration?.kmsKey ?? '')
        : '',
    };

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection,
    };
    if (repo.repositoryArn !== undefined) state.identifier = repo.repositoryArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const repositoryName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const encryptionType = d['encryptionType'] as EncryptionType;
    const kmsKey = d['encryptionKmsKey'];
    const created = await this.ecr.send(
      new CreateRepositoryCommand({
        repositoryName,
        imageTagMutability: d['imageTagMutability'] as ImageTagMutability,
        imageScanningConfiguration: { scanOnPush: d['scanOnPush'] === 'true' },
        encryptionConfiguration: {
          encryptionType,
          ...(kmsKey !== '' ? { kmsKey } : {}),
        },
        tags: toTagList(tags),
      }),
    );
    // repositoryUri is the push/pull endpoint; repositoryArn is the identifier.
    return created.repository?.repositoryArn ?? `ecr:repository/${repositoryName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const repositoryName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;

    if (d['imageTagMutability'] !== live['imageTagMutability']) {
      await this.ecr.send(
        new PutImageTagMutabilityCommand({
          repositoryName,
          imageTagMutability: d['imageTagMutability'] as ImageTagMutability,
        }),
      );
    }
    if (d['scanOnPush'] !== live['scanOnPush']) {
      await this.ecr.send(
        new PutImageScanningConfigurationCommand({
          repositoryName,
          imageScanningConfiguration: { scanOnPush: d['scanOnPush'] === 'true' },
        }),
      );
    }
    // Re-assert ownership tags (repo idiom).
    if (current.identifier !== undefined) {
      await this.ecr.send(
        new TagResourceCommand({
          resourceArn: current.identifier,
          tags: toTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    // force:true so a repository with pushed images still deletes — managed
    // teardown must leave zero orphans (an un-forced delete errors on content).
    await this.ecr.send(
      new DeleteRepositoryCommand({ repositoryName: resourceIdOf(resource), force: true }),
    );
  }
}
