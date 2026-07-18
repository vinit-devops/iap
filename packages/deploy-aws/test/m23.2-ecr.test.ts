/**
 * M23.2 `aws:ecr:Repository` handler, mock-tested: create with encryption /
 * scan / mutability + iap tags, converged no-op, mutable imageTagMutability
 * update-in-place (no delete), the immutable encryption-posture replace (gated
 * delete+create), force teardown, and the managed-only destroy gate.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  ListTagsForResourceCommand,
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  TagResourceCommand,
} from '@aws-sdk/client-ecr';
import type { Repository } from '@aws-sdk/client-ecr';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const ecr = mockClient(ECRClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => ecr.reset());

/** A live, iap-managed default-posture repository (MUTABLE, scan-on-push, AES256). */
function liveRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    repositoryName: 'app-images',
    repositoryArn: 'arn:aws:ecr:eu-central-1:000000000000:repository/app-images',
    repositoryUri: '000000000000.dkr.ecr.eu-central-1.amazonaws.com/app-images',
    imageTagMutability: 'MUTABLE',
    imageScanningConfiguration: { scanOnPush: true },
    encryptionConfiguration: { encryptionType: 'AES256' },
    ...overrides,
  };
}

const managedTags = { tags: [{ Key: 'iap:managed', Value: 'true' }] };

describe('aws:ecr:Repository', () => {
  const plan = providerPlan([planResource('app-images', 'aws:ecr:Repository')]);

  it('absent → CreateRepository with mutability, scan, encryption, and iap tags', async () => {
    const encrypted = providerPlan([
      planResource('app-images', 'aws:ecr:Repository', {
        imageTagMutability: 'IMMUTABLE',
        scanOnPush: false,
        encryptionType: 'KMS',
        kmsKey: 'arn:aws:kms:eu-central-1:000000000000:key/cmk',
      }),
    ]);
    ecr.on(DescribeRepositoriesCommand).rejects(serviceError('RepositoryNotFoundException'));
    ecr.on(CreateRepositoryCommand).resolves({
      repository: { repositoryArn: 'arn:aws:ecr:::repository/app-images' },
    });

    const report = await executor().apply(encrypted, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:ecr:::repository/app-images');
    const input = ecr.commandCalls(CreateRepositoryCommand)[0]?.args[0].input;
    expect(input?.repositoryName).toBe('app-images');
    expect(input?.imageTagMutability).toBe('IMMUTABLE');
    expect(input?.imageScanningConfiguration?.scanOnPush).toBe(false);
    expect(input?.encryptionConfiguration?.encryptionType).toBe('KMS');
    expect(input?.encryptionConfiguration?.kmsKey).toBe(
      'arn:aws:kms:eu-central-1:000000000000:key/cmk',
    );
    expect(input?.tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(input?.tags?.some((t) => t.Key === 'iap:planId')).toBe(true);
    expect(input?.tags?.some((t) => t.Key === 'iap:resourceId')).toBe(true);
  });

  it('create defaults: MUTABLE, scanOnPush true, AES256 (no KMS key)', async () => {
    ecr.on(DescribeRepositoriesCommand).rejects(serviceError('RepositoryNotFoundException'));
    ecr.on(CreateRepositoryCommand).resolves({ repository: liveRepo() });

    await executor().apply(plan, { apply: true });
    const input = ecr.commandCalls(CreateRepositoryCommand)[0]?.args[0].input;
    expect(input?.imageTagMutability).toBe('MUTABLE');
    expect(input?.imageScanningConfiguration?.scanOnPush).toBe(true);
    expect(input?.encryptionConfiguration?.encryptionType).toBe('AES256');
    expect(input?.encryptionConfiguration?.kmsKey).toBeUndefined();
  });

  it('present + converged → no-op, nothing mutated', async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [liveRepo()] });
    ecr.on(ListTagsForResourceCommand).resolves(managedTags);

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');

    const applied = await executor().apply(plan, { apply: true });
    expect(applied.items[0]?.action).toBe('no-op');
    expect(ecr.commandCalls(CreateRepositoryCommand)).toHaveLength(0);
    expect(ecr.commandCalls(PutImageTagMutabilityCommand)).toHaveLength(0);
    expect(ecr.commandCalls(DeleteRepositoryCommand)).toHaveLength(0);
  });

  it('imageTagMutability drift → PutImageTagMutability update-in-place (no delete)', async () => {
    const immutablePlan = providerPlan([
      planResource('app-images', 'aws:ecr:Repository', { imageTagMutability: 'IMMUTABLE' }),
    ]);
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [liveRepo()] }); // live: MUTABLE
    ecr.on(ListTagsForResourceCommand).resolves(managedTags);
    ecr.on(PutImageTagMutabilityCommand).resolves({});
    ecr.on(TagResourceCommand).resolves({});

    const report = await executor().apply(immutablePlan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = ecr.commandCalls(PutImageTagMutabilityCommand)[0]?.args[0].input;
    expect(input?.repositoryName).toBe('app-images');
    expect(input?.imageTagMutability).toBe('IMMUTABLE');
    // only the drifted mutable attr — scanning untouched, and never a delete
    expect(ecr.commandCalls(PutImageScanningConfigurationCommand)).toHaveLength(0);
    expect(ecr.commandCalls(DeleteRepositoryCommand)).toHaveLength(0);
  });

  it('encryption drift is IMMUTABLE → plans replace; gate open executes delete THEN create', async () => {
    const kmsPlan = providerPlan([
      planResource('app-images', 'aws:ecr:Repository', {
        encryptionType: 'KMS',
        kmsKey: 'arn:aws:kms:eu-central-1:000000000000:key/cmk',
      }),
    ]);
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [liveRepo()] }); // live: AES256
    ecr.on(ListTagsForResourceCommand).resolves(managedTags);
    ecr.on(DeleteRepositoryCommand).resolves({});
    ecr.on(CreateRepositoryCommand).resolves({
      repository: { repositoryArn: 'arn:aws:ecr:::repository/app-images-new' },
    });

    const planned = await executor().plan(kmsPlan);
    expect(planned.items[0]?.action).toBe('replace');

    // Replacement gate closed → refuses, nothing destroyed.
    const refused = await executor().apply(kmsPlan, { apply: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(ecr.commandCalls(DeleteRepositoryCommand)).toHaveLength(0);

    // Gate open → delete THEN create, in that order.
    const report = await executor().apply(kmsPlan, { apply: true, replace: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:ecr:::repository/app-images-new');
    const mutations = ecr
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((name) => name === 'DeleteRepositoryCommand' || name === 'CreateRepositoryCommand');
    expect(mutations).toEqual(['DeleteRepositoryCommand', 'CreateRepositoryCommand']);
  });

  it('destroy → DeleteRepository force:true on a managed repository', async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [liveRepo()] });
    ecr.on(ListTagsForResourceCommand).resolves(managedTags);
    ecr.on(DeleteRepositoryCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    const input = ecr.commandCalls(DeleteRepositoryCommand)[0]?.args[0].input;
    expect(input?.repositoryName).toBe('app-images');
    expect(input?.force).toBe(true); // zero-orphan even with images pushed
  });

  it('destroy refuses an unmanaged repository (managed-only gate)', async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [liveRepo()] });
    ecr.on(ListTagsForResourceCommand).resolves({ tags: [] }); // not ours

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(ecr.commandCalls(DeleteRepositoryCommand)).toHaveLength(0);
  });
});
