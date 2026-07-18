/**
 * M22.5 `aws:ec2:LaunchTemplate` handler, mock-tested. Native named resource
 * (LaunchTemplateName = resourceId; the real not-found code is
 * 'InvalidLaunchTemplateName.NotFoundException'). Launch templates are
 * VERSIONED: update mints a NEW version (CreateLaunchTemplateVersion) and
 * promotes it to $Default (ModifyLaunchTemplate) — never a delete, never a
 * replace. Replacement is justified-N/A: no immutableProjectionKeys.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateLaunchTemplateCommand,
  CreateLaunchTemplateVersionCommand,
  DeleteLaunchTemplateCommand,
  DescribeLaunchTemplatesCommand,
  DescribeLaunchTemplateVersionsCommand,
  EC2Client,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { LaunchTemplateHandler } from '../src/launch-template.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const ec2 = mockClient(EC2Client);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => ec2.reset());

const AMI = 'ami-0al2023arm64';

const plan = (attrs: Record<string, string> = {}) =>
  providerPlan([planResource('fleet-tmpl', 'aws:ec2:LaunchTemplate', attrs)]);

/** Live template shell + a $Default version carrying the launch data. */
function mockLiveTemplate(data: Record<string, string> = {}): void {
  ec2.on(DescribeLaunchTemplatesCommand).resolves({
    LaunchTemplates: [
      {
        LaunchTemplateId: 'lt-0123456789',
        LaunchTemplateName: 'fleet-tmpl',
        DefaultVersionNumber: 1,
        Tags: [{ Key: 'iap:managed', Value: 'true' }],
      },
    ],
  });
  ec2.on(DescribeLaunchTemplateVersionsCommand).resolves({
    LaunchTemplateVersions: [
      {
        VersionNumber: 1,
        LaunchTemplateData: { ImageId: AMI, InstanceType: 't4g.nano', ...data },
      },
    ],
  });
}

describe('aws:ec2:LaunchTemplate — create', () => {
  it('absent (InvalidLaunchTemplateName.NotFoundException) → CreateLaunchTemplate with data + tags', async () => {
    ec2
      .on(DescribeLaunchTemplatesCommand)
      .rejects(serviceError('InvalidLaunchTemplateName.NotFoundException'));
    ec2.on(CreateLaunchTemplateCommand).resolves({
      LaunchTemplate: { LaunchTemplateId: 'lt-0new', LaunchTemplateName: 'fleet-tmpl' },
    });

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('lt-0new');

    const create = ec2.commandCalls(CreateLaunchTemplateCommand)[0]?.args[0].input;
    expect(create?.LaunchTemplateName).toBe('fleet-tmpl'); // name IS the identity
    expect(create?.LaunchTemplateData?.ImageId).toBe(AMI);
    expect(create?.LaunchTemplateData?.InstanceType).toBe('t4g.nano'); // default
    const spec = create?.TagSpecifications?.[0];
    expect(spec?.ResourceType).toBe('launch-template');
    const tags = (spec?.Tags ?? []).map((t) => `${t.Key}=${t.Value}`);
    expect(tags).toContain('iap:managed=true');
    expect(tags.some((t) => t.startsWith('iap:planId='))).toBe(true);
    expect(tags.some((t) => t.startsWith('iap:resourceId='))).toBe(true);
  });

  it('missing imageId → fail closed: honest error, ZERO CreateLaunchTemplate', async () => {
    ec2
      .on(DescribeLaunchTemplatesCommand)
      .rejects(serviceError('InvalidLaunchTemplateName.NotFoundException'));

    const report = await executor().apply(plan(), { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain("requires attribute 'imageId'");
    expect(ec2.commandCalls(CreateLaunchTemplateCommand)).toHaveLength(0);
  });
});

describe('aws:ec2:LaunchTemplate — converged', () => {
  it('present + converged → no-op; data read from the $Default version', async () => {
    mockLiveTemplate();

    const report = await executor().plan(plan({ imageId: AMI }));

    expect(report.items[0]?.action).toBe('no-op');
    const versions = ec2.commandCalls(DescribeLaunchTemplateVersionsCommand)[0]?.args[0].input;
    expect(versions?.LaunchTemplateName).toBe('fleet-tmpl');
    expect(versions?.Versions).toEqual(['$Default']); // the default version IS the projection
  });
});

describe('aws:ec2:LaunchTemplate — versioned update (new default version, never delete)', () => {
  it('imageId drift → update (MUTABLE): CreateLaunchTemplateVersion + promote to $Default', async () => {
    mockLiveTemplate({ ImageId: 'ami-0stale' });
    ec2.on(CreateLaunchTemplateVersionCommand).resolves({
      LaunchTemplateVersion: { VersionNumber: 2 },
    });
    ec2.on(ModifyLaunchTemplateCommand).resolves({});

    const planned = await executor().plan(plan({ imageId: AMI }));
    expect(planned.items[0]?.action).toBe('update'); // never replace

    const report = await executor().apply(plan({ imageId: AMI }), { apply: true });
    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);

    const minted = ec2.commandCalls(CreateLaunchTemplateVersionCommand)[0]?.args[0].input;
    expect(minted?.LaunchTemplateName).toBe('fleet-tmpl');
    expect(minted?.LaunchTemplateData?.ImageId).toBe(AMI);
    const modify = ec2.commandCalls(ModifyLaunchTemplateCommand)[0]?.args[0].input;
    expect(modify?.LaunchTemplateName).toBe('fleet-tmpl');
    expect(modify?.DefaultVersion).toBe('2'); // the freshly minted version
    // Versioned convergence never destroys the template.
    expect(ec2.commandCalls(DeleteLaunchTemplateCommand)).toHaveLength(0);
    // Mint before promote (ordering).
    const order = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('CreateLaunchTemplateVersionCommand')).toBeLessThan(
      order.indexOf('ModifyLaunchTemplateCommand'),
    );
  });

  it('instanceType drift is also update-in-place via a new version', async () => {
    mockLiveTemplate({ InstanceType: 't4g.small' });

    const report = await executor().plan(plan({ imageId: AMI, instanceType: 't4g.nano' }));

    expect(report.items[0]?.action).toBe('update');
  });

  it('replacement is justified-N/A: the handler declares NO immutableProjectionKeys', () => {
    const handler = new LaunchTemplateHandler(new EC2Client({ region: 'eu-central-1' }));
    expect(handler.immutableProjectionKeys).toBeUndefined();
  });
});

describe('aws:ec2:LaunchTemplate — destroy', () => {
  it('managed → DeleteLaunchTemplate by name', async () => {
    mockLiveTemplate();
    ec2.on(DeleteLaunchTemplateCommand).resolves({});

    const report = await executor().apply(plan({ imageId: AMI }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(
      ec2.commandCalls(DeleteLaunchTemplateCommand)[0]?.args[0].input?.LaunchTemplateName,
    ).toBe('fleet-tmpl');
  });

  it('refuses to destroy a template NOT tagged iap:managed', async () => {
    mockLiveTemplate();
    ec2.on(DescribeLaunchTemplatesCommand).resolves({
      LaunchTemplates: [
        {
          LaunchTemplateId: 'lt-0123456789',
          LaunchTemplateName: 'fleet-tmpl',
          Tags: [{ Key: 'team', Value: 'core' }],
        },
      ],
    });

    const report = await executor().apply(plan({ imageId: AMI }), {
      apply: true,
      destroy: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('managed-only destroy');
    expect(ec2.commandCalls(DeleteLaunchTemplateCommand)).toHaveLength(0);
  });
});
