/**
 * `aws:lambda:Function` handler (@aws-sdk/client-lambda) — the Function/Job
 * kinds' compute (M22.1).
 *
 * read → GetFunction (config + tags)
 * create → CreateFunction (Image or Zip package; execution role resolved by
 *          name convention — the mapping emits a sibling aws:iam:Role with the
 *          SAME resourceId, ordered before the function by logicalId sort)
 * update → UpdateFunctionConfiguration / UpdateFunctionCode on drift
 * delete → DeleteFunction
 *
 * Package type is immutable (Image ↔ Zip cannot convert) — drift replaces
 * (ADR-0006). `codeReference` is `<image-uri>` for Image or `s3://bucket/key`
 * for Zip; Zip functions run the nodejs22.x runtime with handler
 * `index.handler` (mapping constants for archive artifacts).
 */

import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  TagResourceCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import type { LambdaClient, PackageType } from '@aws-sdk/client-lambda';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { durationToSeconds, nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;
const ZIP_DEFAULTS = { runtime: 'nodejs22.x', handler: 'index.handler' } as const;

function parseS3Reference(reference: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(reference);
  if (match === null) {
    throw new Error(
      `archive artifact reference must be s3://bucket/key (got "${reference}") — fail-closed`,
    );
  }
  return { bucket: match[1] as string, key: match[2] as string };
}

export class LambdaFunctionHandler implements TargetHandler {
  static readonly targetType = 'aws:lambda:Function' as const;
  readonly targetType = LambdaFunctionHandler.targetType;
  /** Image ↔ Zip cannot convert in place (ADR-0006). */
  readonly immutableProjectionKeys = ['packageType'] as const;

  constructor(
    private readonly client: LambdaClient,
    private readonly iam: IAMClient,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      packageType: scalarStr(a['packageType']) || 'Image',
      codeReference: scalarStr(a['codeReference']),
      memorySize: scalarStr(a['memorySize']) || '128',
      timeout: durationToSeconds(scalarStr(a['timeout']) || '30'),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const FunctionName = resourceIdOf(resource);
    let found;
    try {
      found = await this.client.send(new GetFunctionCommand({ FunctionName }));
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    const config = found.Configuration;
    const tags = found.Tags ?? {};
    const packageType = config?.PackageType ?? 'Zip';
    const liveReference =
      packageType === 'Image'
        ? (found.Code?.ImageUri ?? '')
        : // Zip code location is a presigned URL, not the source reference —
          // code drift for Zip is deployed via the reference attribute change
          // and mirrored (absent-equals-desired) to avoid false drift.
          scalarStr(resource.desiredAttributes['codeReference']);

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        packageType,
        codeReference: liveReference,
        memorySize: config?.MemorySize === undefined ? '' : String(config.MemorySize),
        timeout: config?.Timeout === undefined ? '' : String(config.Timeout),
      },
    };
    if (config?.FunctionArn !== undefined) state.identifier = config.FunctionArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const FunctionName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    // Name-convention resolution: the mapping emits the execution role with
    // the same resourceId; logicalId sort creates it before the function.
    const role = await this.iam.send(new GetRoleCommand({ RoleName: FunctionName }));
    const Role = role.Role?.Arn;
    if (Role === undefined) throw new Error(`execution role ${FunctionName} has no ARN`);

    const isImage = d['packageType'] === 'Image';
    const reference = d['codeReference'] ?? '';
    const Code = isImage
      ? { ImageUri: reference }
      : (() => {
          const { bucket, key } = parseS3Reference(reference);
          return { S3Bucket: bucket, S3Key: key };
        })();

    const created = await this.client.send(
      new CreateFunctionCommand({
        FunctionName,
        PackageType: d['packageType'] as PackageType,
        Code,
        Role,
        MemorySize: Number(d['memorySize']),
        Timeout: Number(d['timeout']),
        ...(isImage ? {} : { Runtime: ZIP_DEFAULTS.runtime, Handler: ZIP_DEFAULTS.handler }),
        Tags: tags,
      }),
    );
    return created.FunctionArn ?? `lambda:${FunctionName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const FunctionName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;
    if (d['memorySize'] !== live['memorySize'] || d['timeout'] !== live['timeout']) {
      await this.client.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName,
          MemorySize: Number(d['memorySize']),
          Timeout: Number(d['timeout']),
        }),
      );
    }
    if (d['codeReference'] !== live['codeReference'] && d['packageType'] === 'Image') {
      await this.client.send(
        new UpdateFunctionCodeCommand({ FunctionName, ImageUri: d['codeReference'] }),
      );
    }
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagResourceCommand({ Resource: current.identifier, Tags: current.tags }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(new DeleteFunctionCommand({ FunctionName: resourceIdOf(resource) }));
  }
}
