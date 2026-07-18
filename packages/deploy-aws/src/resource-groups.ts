/**
 * `aws:resourcegroups:Group` handler (@aws-sdk/client-resource-groups) — the
 * Application kind's logical grouping (M21.2).
 *
 * read → GetGroup (+ GetGroupQuery / GetTags)
 * create → CreateGroup (tag-filter query over iap:application=<name>)
 * update → UpdateGroupQuery, Tag
 * delete → DeleteGroup
 *
 * The physical group name is the plan resourceId. The group's version rides as
 * the `iap:applicationVersion` tag (mapping attribute `applicationVersionTag`).
 */

import {
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  GetGroupQueryCommand,
  GetTagsCommand,
  TagCommand,
  UpdateGroupQueryCommand,
} from '@aws-sdk/client-resource-groups';
import type { QueryType, ResourceGroupsClient } from '@aws-sdk/client-resource-groups';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['NotFoundException'] as const;
const VERSION_TAG = 'iap:applicationVersion';
const DEFAULT_QUERY_TYPE = 'TAG_FILTERS_1_0';

/** Deterministic tag-filter query: everything tagged iap:application=<name>. */
function groupQuery(name: string): string {
  return JSON.stringify({
    ResourceTypeFilters: ['AWS::AllSupported'],
    TagFilters: [{ Key: 'iap:application', Values: [name] }],
  });
}

export class ResourceGroupHandler implements TargetHandler {
  static readonly targetType = 'aws:resourcegroups:Group' as const;
  readonly targetType = ResourceGroupHandler.targetType;

  constructor(private readonly client: ResourceGroupsClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      resourceQueryType: scalarStr(a['resourceQueryType']) || DEFAULT_QUERY_TYPE,
      applicationVersionTag: scalarStr(a['applicationVersionTag']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    let arn: string | undefined;
    try {
      const found = await this.client.send(new GetGroupCommand({ Group: name }));
      arn = found.Group?.GroupArn;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    const query = await this.client.send(new GetGroupQueryCommand({ Group: name }));
    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.client.send(new GetTagsCommand({ Arn: arn }));
      tags = tagResult.Tags ?? {};
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        resourceQueryType: query.GroupQuery?.ResourceQuery?.Type ?? '',
        applicationVersionTag: tags[VERSION_TAG] ?? '',
      },
    };
    if (arn !== undefined) state.identifier = arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const desired = this.desiredProjection(resource);
    const created = await this.client.send(
      new CreateGroupCommand({
        Name: name,
        ResourceQuery: {
          Type: desired['resourceQueryType'] as QueryType,
          Query: groupQuery(name),
        },
        Tags: this.withVersionTag(desired, tags),
      }),
    );
    return created.Group?.GroupArn ?? `resource-groups:${name}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const desired = this.desiredProjection(resource);
    await this.client.send(
      new UpdateGroupQueryCommand({
        Group: name,
        ResourceQuery: {
          Type: desired['resourceQueryType'] as QueryType,
          Query: groupQuery(name),
        },
      }),
    );
    if (current.identifier !== undefined) {
      await this.client.send(
        new TagCommand({
          Arn: current.identifier,
          Tags: this.withVersionTag(desired, current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(new DeleteGroupCommand({ Group: resourceIdOf(resource) }));
  }

  private withVersionTag(
    desired: Record<string, string>,
    tags: Record<string, string>,
  ): Record<string, string> {
    const version = desired['applicationVersionTag'];
    return version ? { ...tags, [VERSION_TAG]: version } : { ...tags };
  }
}
