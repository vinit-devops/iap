/**
 * `aws:ssm:Parameter` handler (@aws-sdk/client-ssm) — the standalone Secret
 * kind (M22.1).
 *
 * read → GetParameter (metadata only — WithDecryption is never set; the VALUE
 *        is never read back) + ListTagsForResource
 * create → PutParameter (SecureString; generated value never logged)
 * update → AddTagsToResource (the value is write-only; type is immutable-ish
 *          but reconciled via replace)
 * delete → DeleteParameter
 */

import { randomBytes } from 'node:crypto';
import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  GetParameterCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import type { ParameterType, SSMClient } from '@aws-sdk/client-ssm';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ParameterNotFound'] as const;

export class SsmParameterHandler implements TargetHandler {
  static readonly targetType = 'aws:ssm:Parameter' as const;
  readonly targetType = SsmParameterHandler.targetType;
  /** String ↔ SecureString cannot silently convert — drift replaces. */
  readonly immutableProjectionKeys = ['parameterType'] as const;

  constructor(private readonly client: SSMClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    return {
      parameterType: scalarStr(resource.desiredAttributes['parameterType']) || 'SecureString',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const Name = resourceIdOf(resource);
    let parameter;
    try {
      // WithDecryption defaults false — the secret VALUE is never read back.
      const found = await this.client.send(new GetParameterCommand({ Name }));
      parameter = found.Parameter;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    const tagResult = await this.client.send(
      new ListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: Name }),
    );
    const tags = fromTagList(tagResult.TagList ?? []);

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: { parameterType: parameter?.Type ?? '' },
    };
    if (parameter?.ARN !== undefined) state.identifier = parameter.ARN;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const Name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const generate = scalarStr(resource.desiredAttributes['generateValue']) !== 'false';
    // Generated locally, passed once, never stored or logged.
    const Value = generate
      ? randomBytes(24).toString('base64url')
      : scalarStr(resource.desiredAttributes['value']);
    if (!Value) throw new Error('parameter needs generateValue=true or a value attribute');
    await this.client.send(
      new PutParameterCommand({
        Name,
        Type: d['parameterType'] as ParameterType,
        Value,
        Tags: toTagList(tags),
      }),
    );
    return `ssm:parameter/${Name}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    // The value is write-only and never compared; only tags reconcile.
    await this.client.send(
      new AddTagsToResourceCommand({
        ResourceType: 'Parameter',
        ResourceId: resourceIdOf(resource),
        Tags: toTagList(current.tags),
      }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(new DeleteParameterCommand({ Name: resourceIdOf(resource) }));
  }
}
