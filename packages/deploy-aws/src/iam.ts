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
  DeleteRolePolicyCommand,
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

/** Normalize a (possibly comma-separated) service list: sorted, deduped. */
function normalizeServices(value: string): string {
  return [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))].sort().join(',');
}

function assumeRolePolicyDocument(services: string): string {
  const list = normalizeServices(services).split(',').filter(Boolean);
  // One role can serve several trust surfaces (e.g. lambda + scheduler, M22.1).
  const Service: string | string[] = list.length === 1 ? (list[0] as string) : list;
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service }, Action: 'sts:AssumeRole' }],
  });
}

function serviceFromDocument(document: string | undefined): string {
  if (!document) return '';
  try {
    const parsed = JSON.parse(decodeURIComponent(document)) as {
      Statement?: Array<{ Principal?: { Service?: string | string[] } }>;
    };
    const service = parsed.Statement?.[0]?.Principal?.Service ?? '';
    return normalizeServices(Array.isArray(service) ? service.join(',') : service);
  } catch {
    return '';
  }
}

export class IamRoleHandler implements TargetHandler {
  static readonly targetType = 'aws:iam:Role' as const;
  readonly targetType = IamRoleHandler.targetType;

  constructor(private readonly client: IAMClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      assumeRoleService: normalizeServices(scalarStr(a['assumeRoleService'])),
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
    const RoleName = resourceIdOf(resource);
    // A role with an inline policy refuses DeleteRole — remove it first.
    try {
      await this.client.send(
        new DeleteRolePolicyCommand({ RoleName, PolicyName: `${RoleName}-inline` }),
      );
    } catch (err) {
      if (!nameMatches(err, NOT_FOUND)) throw err;
    }
    await this.client.send(new DeleteRoleCommand({ RoleName }));
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
