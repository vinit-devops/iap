/**
 * `aws:rds:DBSubnetGroup` handler (@aws-sdk/client-rds) — the Database kind's
 * subnet placement (M21.3).
 *
 * read → DescribeDBSubnetGroups + ListTagsForResource
 * create → CreateDBSubnetGroup over the default VPC's subnets (ADR-0005)
 * update → ModifyDBSubnetGroup (re-assert subnets), AddTagsToResource
 * delete → DeleteDBSubnetGroup
 *
 * `subnetTier` is a mapping hint, not an AWS attribute — it rides as the
 * `iap:subnetTier` tag so desired and live projections round-trip.
 */

import {
  AddTagsToResourceCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBSubnetGroupsCommand,
  ListTagsForResourceCommand,
  ModifyDBSubnetGroupCommand,
} from '@aws-sdk/client-rds';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSubnetIds } from './network.js';

const NOT_FOUND = ['DBSubnetGroupNotFoundFault', 'DBSubnetGroupNotFound'] as const;
const TIER_TAG = 'iap:subnetTier';

export class RdsSubnetGroupHandler implements TargetHandler {
  static readonly targetType = 'aws:rds:DBSubnetGroup' as const;
  readonly targetType = RdsSubnetGroupHandler.targetType;

  constructor(
    private readonly client: RDSClient,
    private readonly ec2: EC2Client,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    return { subnetTier: scalarStr(resource.desiredAttributes['subnetTier']) };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    let arn: string | undefined;
    try {
      const found = await this.client.send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: name }),
      );
      arn = found.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let tags: Record<string, string> = {};
    if (arn !== undefined) {
      const tagResult = await this.client.send(
        new ListTagsForResourceCommand({ ResourceName: arn }),
      );
      tags = fromTagList(tagResult.TagList ?? []);
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: { subnetTier: tags[TIER_TAG] ?? '' },
    };
    if (arn !== undefined) state.identifier = arn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const tier = scalarStr(resource.desiredAttributes['subnetTier']);
    const SubnetIds = await defaultSubnetIds(this.ec2);
    const created = await this.client.send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: name,
        DBSubnetGroupDescription: `IaP-managed subnet group (${tier || 'default'} tier)`,
        SubnetIds,
        Tags: toTagList(tier ? { ...tags, [TIER_TAG]: tier } : tags),
      }),
    );
    return created.DBSubnetGroup?.DBSubnetGroupArn ?? `rds:subgrp:${name}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const tier = scalarStr(resource.desiredAttributes['subnetTier']);
    const SubnetIds = await defaultSubnetIds(this.ec2);
    await this.client.send(new ModifyDBSubnetGroupCommand({ DBSubnetGroupName: name, SubnetIds }));
    if (current.identifier !== undefined && tier) {
      await this.client.send(
        new AddTagsToResourceCommand({
          ResourceName: current.identifier,
          Tags: toTagList({ [TIER_TAG]: tier }),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(
      new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: resourceIdOf(resource) }),
    );
  }
}
