/**
 * `aws:secretsmanager:Secret` handler (@aws-sdk/client-secrets-manager) —
 * connection secrets derived from Database/Cache (M21.2).
 *
 * read → DescribeSecret (metadata ONLY — the secret VALUE is never read)
 * create → GetRandomPassword (when generateSecretString), CreateSecret
 * update → UpdateSecret (description), TagResource
 * delete → DeleteSecret with ForceDeleteWithoutRecovery (live-run teardown
 *          must leave zero orphans; a recovery-window secret still exists)
 *
 * The physical secret name is the plan resourceId. A secret scheduled for
 * deletion (DeletedDate set) reads as absent — it is on its way out and must
 * not be updated.
 */

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetRandomPasswordCommand,
  TagResourceCommand,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;

export class SecretsManagerSecretHandler implements TargetHandler {
  static readonly targetType = 'aws:secretsmanager:Secret' as const;
  readonly targetType = SecretsManagerSecretHandler.targetType;

  constructor(private readonly client: SecretsManagerClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    // generateSecretString is create-time only (not stored on AWS) and the
    // secret VALUE is never read back — description is the drift surface.
    return { description: scalarStr(resource.desiredAttributes['description']) };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const SecretId = resourceIdOf(resource);
    try {
      const found = await this.client.send(new DescribeSecretCommand({ SecretId }));
      if (found.DeletedDate !== undefined) {
        // Scheduled for deletion — treat as absent; never resurrect via update.
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      const tags = fromTagList(found.Tags ?? []);
      const state: ResourceState = {
        exists: true,
        managed: isManaged(tags),
        tags,
        projection: { description: found.Description ?? '' },
      };
      if (found.ARN !== undefined) state.identifier = found.ARN;
      return state;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const Name = resourceIdOf(resource);
    const a = resource.desiredAttributes;
    let SecretString: string | undefined;
    if (scalarStr(a['generateSecretString']) === 'true') {
      const generated = await this.client.send(
        new GetRandomPasswordCommand({ PasswordLength: 32, ExcludePunctuation: true }),
      );
      SecretString = generated.RandomPassword ?? '';
    }
    const description = scalarStr(a['description']);
    const created = await this.client.send(
      new CreateSecretCommand({
        Name,
        ...(description ? { Description: description } : {}),
        ...(SecretString !== undefined ? { SecretString } : {}),
        Tags: toTagList(tags),
      }),
    );
    return created.ARN ?? `secretsmanager:${Name}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const SecretId = resourceIdOf(resource);
    const description = scalarStr(resource.desiredAttributes['description']);
    await this.client.send(new UpdateSecretCommand({ SecretId, Description: description }));
    if (current.identifier !== undefined) {
      await this.client.send(new TagResourceCommand({ SecretId, Tags: toTagList(current.tags) }));
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.client.send(
      new DeleteSecretCommand({
        SecretId: resourceIdOf(resource),
        ForceDeleteWithoutRecovery: true,
      }),
    );
  }
}
