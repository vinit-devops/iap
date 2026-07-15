/**
 * `aws:iam:Role` handler (@aws-sdk/client-iam).
 *
 * read → GetRole
 * create → CreateRole (with mandatory Tags), PutRolePolicy (inline policy, if any)
 * update → PutRolePolicy (inline policy, if any), TagRole
 * delete → DeleteRole
 *
 * The physical role name is the plan resourceId. The trust policy is derived
 * from the `assumeRoleService` attribute emitted by the mapping.
 */

import {
  CreateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
} from '@aws-sdk/client-iam';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { httpStatus, nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['NoSuchEntity'] as const;

function assumeRolePolicyDocument(service: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }],
  });
}

function serviceFromDocument(document: string | undefined): string {
  if (!document) return '';
  try {
    const parsed = JSON.parse(decodeURIComponent(document)) as {
      Statement?: Array<{ Principal?: { Service?: string } }>;
    };
    return parsed.Statement?.[0]?.Principal?.Service ?? '';
  } catch {
    return '';
  }
}

export class IamRoleHandler implements TargetHandler {
  readonly targetType = 'aws:iam:Role' as const;

  constructor(private readonly client: IAMClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      assumeRoleService: scalarStr(a['assumeRoleService']),
      inlinePolicy: scalarStr(a['inlinePolicy']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const RoleName = resourceIdOf(resource);
    try {
      const found = await this.client.send(new GetRoleCommand({ RoleName }));
      const role = found.Role;
      const tags = fromTagList(role?.Tags ?? []);
      const state: ResourceState = {
        exists: true,
        managed: isManaged(tags),
        tags,
        // Inline policies are not enumerated on read; drift on a desired inline
        // policy therefore always reconciles (PutRolePolicy is idempotent).
        projection: {
          assumeRoleService: serviceFromDocument(role?.AssumeRolePolicyDocument),
          inlinePolicy: '',
        },
      };
      if (role?.Arn !== undefined) state.identifier = role.Arn;
      return state;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND) || httpStatus(err) === 404) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const RoleName = resourceIdOf(resource);
    const service = scalarStr(resource.desiredAttributes['assumeRoleService']);
    const created = await this.client.send(
      new CreateRoleCommand({
        RoleName,
        AssumeRolePolicyDocument: assumeRolePolicyDocument(service),
        Tags: toTagList(tags),
      }),
    );
    await this.putInlinePolicy(resource, RoleName);
    return created.Role?.Arn ?? `arn:aws:iam::000000000000:role/${RoleName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const RoleName = resourceIdOf(resource);
    await this.putInlinePolicy(resource, RoleName);
    await this.client.send(new TagRoleCommand({ RoleName, Tags: toTagList(current.tags) }));
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(new DeleteRoleCommand({ RoleName: resourceIdOf(resource) }));
  }

  private async putInlinePolicy(resource: PlanResource, RoleName: string): Promise<void> {
    const policy = scalarStr(resource.desiredAttributes['inlinePolicy']);
    if (!policy) return;
    await this.client.send(
      new PutRolePolicyCommand({
        RoleName,
        PolicyName: `${RoleName}-inline`,
        PolicyDocument: policy,
      }),
    );
  }
}
