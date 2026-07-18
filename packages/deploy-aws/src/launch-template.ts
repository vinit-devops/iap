/**
 * `aws:ec2:LaunchTemplate` handler (@aws-sdk/client-ec2) — the instance
 * blueprint an Auto Scaling group launches from (M22.5).
 *
 * IDENTITY: native named resource — LaunchTemplateName = resourceId.
 *
 * read   → DescribeLaunchTemplates by name (the real error code is
 *          'InvalidLaunchTemplateName.NotFoundException'; matched via
 *          nameMatches on the 'NotFoundException' token) + a second call,
 *          DescribeLaunchTemplateVersions Versions=['$Default'], for the data
 *          projection — the template shell carries the tags, the DEFAULT
 *          VERSION carries the launch data.
 * create → CreateLaunchTemplate with LaunchTemplateData { ImageId from
 *          `imageId` (REQUIRED, fail-closed — the live driver resolves the
 *          AL2023 arm64 AMI via SSM out-of-band), InstanceType from
 *          `instanceType` (default t4g.nano) }, tags via TagSpecifications
 *          (resource type 'launch-template') at creation.
 * update → launch templates are VERSIONED: drift never edits a version in
 *          place — CreateLaunchTemplateVersion mints a new version with the
 *          desired data, then ModifyLaunchTemplate promotes it to $Default
 *          (so '$Default' consumers, e.g. the sibling ASG, pick it up on the
 *          next launch). Tags re-asserted via CreateTags.
 * delete → DeleteLaunchTemplate (all versions go with the template).
 *
 * REPLACEMENT: justified-N/A. Both projection keys (imageId, instanceType)
 * are MUTABLE through the new-default-version flow above, so this handler
 * declares NO immutableProjectionKeys — no drift ever classifies as the gated
 * delete+create replace (ADR-0006 simply has nothing to gate here).
 */

import {
  CreateLaunchTemplateCommand,
  CreateLaunchTemplateVersionCommand,
  CreateTagsCommand,
  DeleteLaunchTemplateCommand,
  DescribeLaunchTemplatesCommand,
  DescribeLaunchTemplateVersionsCommand,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
import type { EC2Client, _InstanceType } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

/** Real code: 'InvalidLaunchTemplateName.NotFoundException' (token-matched). */
const NOT_FOUND = ['NotFoundException'] as const;
const DEFAULT_INSTANCE_TYPE = 't4g.nano';

export class LaunchTemplateHandler implements TargetHandler {
  static readonly targetType = 'aws:ec2:LaunchTemplate' as const;
  readonly targetType = LaunchTemplateHandler.targetType;
  // No immutableProjectionKeys — replacement is justified-N/A (see header):
  // every projected attribute converges via a new default version.

  constructor(private readonly ec2: EC2Client) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      imageId: scalarStr(a['imageId']),
      instanceType: scalarStr(a['instanceType']) || DEFAULT_INSTANCE_TYPE,
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const LaunchTemplateName = resourceIdOf(resource);
    let template;
    try {
      const found = await this.ec2.send(
        new DescribeLaunchTemplatesCommand({ LaunchTemplateNames: [LaunchTemplateName] }),
      );
      template = found.LaunchTemplates?.[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (template === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    // The template shell has the tags; the DEFAULT version has the data.
    const versions = await this.ec2.send(
      new DescribeLaunchTemplateVersionsCommand({
        LaunchTemplateName,
        Versions: ['$Default'],
      }),
    );
    const data = versions.LaunchTemplateVersions?.[0]?.LaunchTemplateData;

    const tags = fromTagList(template.Tags ?? []);
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        imageId: data?.ImageId ?? '',
        instanceType: data?.InstanceType ?? '',
      },
    };
    if (template.LaunchTemplateId !== undefined) state.identifier = template.LaunchTemplateId;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const LaunchTemplateName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const imageId = d['imageId'] ?? '';
    if (imageId === '') {
      throw new Error(
        `aws:ec2:LaunchTemplate '${LaunchTemplateName}' requires attribute 'imageId' — no AMI ` +
          'default is baked into the runtime (the live driver resolves the AL2023 arm64 AMI ' +
          'via SSM out-of-band); refusing to guess (fail closed)',
      );
    }
    const created = await this.ec2.send(
      new CreateLaunchTemplateCommand({
        LaunchTemplateName,
        LaunchTemplateData: {
          ImageId: imageId,
          InstanceType: d['instanceType'] as _InstanceType,
        },
        TagSpecifications: [{ ResourceType: 'launch-template', Tags: toTagList(tags) }],
      }),
    );
    return created.LaunchTemplate?.LaunchTemplateId ?? `ec2:launch-template/${LaunchTemplateName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const LaunchTemplateName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const imageId = d['imageId'] ?? '';
    if (imageId === '') {
      throw new Error(
        `aws:ec2:LaunchTemplate '${LaunchTemplateName}' requires attribute 'imageId' to ` +
          'converge — refusing to mint a version without an AMI (fail closed)',
      );
    }
    // Versioned convergence: mint a new version with the full desired data…
    const minted = await this.ec2.send(
      new CreateLaunchTemplateVersionCommand({
        LaunchTemplateName,
        LaunchTemplateData: {
          ImageId: imageId,
          InstanceType: d['instanceType'] as _InstanceType,
        },
      }),
    );
    // …then promote it to $Default so '$Default' consumers pick it up.
    const versionNumber = minted.LaunchTemplateVersion?.VersionNumber;
    await this.ec2.send(
      new ModifyLaunchTemplateCommand({
        LaunchTemplateName,
        DefaultVersion: versionNumber !== undefined ? String(versionNumber) : '$Latest',
      }),
    );
    // Reconcile tags on the template shell (repo idiom: re-assert ownership).
    if (current.identifier !== undefined) {
      await this.ec2.send(
        new CreateTagsCommand({
          Resources: [current.identifier],
          Tags: toTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource, _current: ResourceState): Promise<void> {
    await this.ec2.send(
      new DeleteLaunchTemplateCommand({ LaunchTemplateName: resourceIdOf(resource) }),
    );
  }
}
