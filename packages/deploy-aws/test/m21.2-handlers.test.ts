/**
 * M21.2 handlers, mock-tested (aws-sdk-client-mock): Resource Groups,
 * Secrets Manager, ACM certificate, ALB TargetGroup. Each handler is driven
 * through the executor end-to-end: create, no-op, safe update, immutable
 * replace (where the service has immutable settings), delete.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  GetGroupQueryCommand,
  GetTagsCommand,
  ResourceGroupsClient,
  UpdateGroupQueryCommand,
} from '@aws-sdk/client-resource-groups';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetRandomPasswordCommand,
  SecretsManagerClient,
  UpdateSecretCommand,
  TagResourceCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
  ModifyTargetGroupCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const rg = mockClient(ResourceGroupsClient);
const sm = mockClient(SecretsManagerClient);
const acm = mockClient(ACMClient);
const elbv2 = mockClient(ElasticLoadBalancingV2Client);
const ec2 = mockClient(EC2Client);

const MANAGED = [{ Key: 'iap:managed', Value: 'true' }];

beforeEach(() => {
  rg.reset();
  sm.reset();
  acm.reset();
  elbv2.reset();
  ec2.reset();
});

const executor = () => new AwsExecutor({ region: 'eu-west-1' });

describe('aws:resourcegroups:Group', () => {
  const plan = providerPlan([
    planResource('app', 'aws:resourcegroups:Group', {
      resourceQueryType: 'TAG_FILTERS_1_0',
      applicationVersionTag: '1.2.0',
    }),
  ]);

  it('absent → create with tag-filter query + version tag', async () => {
    rg.on(GetGroupCommand).rejects(serviceError('NotFoundException', 404));
    rg.on(CreateGroupCommand).resolves({
      Group: { GroupArn: 'arn:aws:resource-groups:eu-west-1:REDACTED:group/app', Name: 'app' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    const input = rg.commandCalls(CreateGroupCommand)[0]?.args[0].input;
    expect(input?.Name).toBe('app');
    expect(input?.ResourceQuery?.Type).toBe('TAG_FILTERS_1_0');
    expect(input?.ResourceQuery?.Query).toContain('iap:application');
    expect(input?.Tags?.['iap:managed']).toBe('true');
    expect(input?.Tags?.['iap:applicationVersion']).toBe('1.2.0');
  });

  it('present + converged → no-op', async () => {
    rg.on(GetGroupCommand).resolves({
      Group: { GroupArn: 'arn:g', Name: 'app' },
    });
    rg.on(GetGroupQueryCommand).resolves({
      GroupQuery: { GroupName: 'app', ResourceQuery: { Type: 'TAG_FILTERS_1_0', Query: '{}' } },
    });
    rg.on(GetTagsCommand).resolves({
      Tags: { 'iap:managed': 'true', 'iap:applicationVersion': '1.2.0' },
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('version-tag drift → update (UpdateGroupQuery + Tag)', async () => {
    rg.on(GetGroupCommand).resolves({ Group: { GroupArn: 'arn:g', Name: 'app' } });
    rg.on(GetGroupQueryCommand).resolves({
      GroupQuery: { GroupName: 'app', ResourceQuery: { Type: 'TAG_FILTERS_1_0', Query: '{}' } },
    });
    rg.on(GetTagsCommand).resolves({
      Tags: { 'iap:managed': 'true', 'iap:applicationVersion': '1.1.0' }, // drift
    });
    rg.on(UpdateGroupQueryCommand).resolves({});
    rg.on(GetTagsCommand).resolves({
      Tags: { 'iap:managed': 'true', 'iap:applicationVersion': '1.1.0' },
    });

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    expect(rg.commandCalls(UpdateGroupQueryCommand)).toHaveLength(1);
  });

  it('destroy → DeleteGroup (managed-only)', async () => {
    rg.on(GetGroupCommand).resolves({ Group: { GroupArn: 'arn:g', Name: 'app' } });
    rg.on(GetGroupQueryCommand).resolves({
      GroupQuery: { GroupName: 'app', ResourceQuery: { Type: 'TAG_FILTERS_1_0', Query: '{}' } },
    });
    rg.on(GetTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });
    rg.on(DeleteGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(rg.commandCalls(DeleteGroupCommand)[0]?.args[0].input?.Group).toBe('app');
  });
});

describe('aws:secretsmanager:Secret', () => {
  const plan = providerPlan([
    planResource('db-conn', 'aws:secretsmanager:Secret', { generateSecretString: true }),
  ]);

  it('absent → generates a random password and creates the secret', async () => {
    sm.on(DescribeSecretCommand).rejects(serviceError('ResourceNotFoundException', 404));
    sm.on(GetRandomPasswordCommand).resolves({ RandomPassword: 'r4nd0m-mock-value-32-chars-xxxx' });
    sm.on(CreateSecretCommand).resolves({ ARN: 'arn:aws:secretsmanager:eu-west-1:REDACTED:secret:db-conn' });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    const input = sm.commandCalls(CreateSecretCommand)[0]?.args[0].input;
    expect(input?.Name).toBe('db-conn');
    expect(input?.SecretString).toBe('r4nd0m-mock-value-32-chars-xxxx');
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('a secret scheduled for deletion reads as absent (create, never resurrect)', async () => {
    sm.on(DescribeSecretCommand).resolves({
      ARN: 'arn:s',
      DeletedDate: new Date('2026-07-16T00:00:00Z'),
      Tags: MANAGED,
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create');
  });

  it('description drift → update; the secret VALUE is never read', async () => {
    const drifted = providerPlan([
      planResource('db-conn', 'aws:secretsmanager:Secret', {
        generateSecretString: true,
        description: 'primary connection secret',
      }),
    ]);
    sm.on(DescribeSecretCommand).resolves({ ARN: 'arn:s', Description: 'old', Tags: MANAGED });
    sm.on(UpdateSecretCommand).resolves({});
    sm.on(TagResourceCommand).resolves({});

    const report = await executor().apply(drifted, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    expect(sm.commandCalls(UpdateSecretCommand)[0]?.args[0].input?.Description).toBe(
      'primary connection secret',
    );
  });

  it('destroy → DeleteSecret with ForceDeleteWithoutRecovery (zero-orphan teardown)', async () => {
    sm.on(DescribeSecretCommand).resolves({ ARN: 'arn:s', Tags: MANAGED });
    sm.on(DeleteSecretCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(
      sm.commandCalls(DeleteSecretCommand)[0]?.args[0].input?.ForceDeleteWithoutRecovery,
    ).toBe(true);
  });
});

describe('aws:acm:Certificate', () => {
  const plan = providerPlan([
    planResource('api.example.test', 'aws:acm:Certificate', { validationMethod: 'DNS' }),
  ]);
  const ARN = 'arn:aws:acm:eu-west-1:REDACTED:certificate/mock';

  it('absent → RequestCertificate with DNS validation (PENDING_VALIDATION honest scope)', async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: ARN });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe(ARN);
    const input = acm.commandCalls(RequestCertificateCommand)[0]?.args[0].input;
    expect(input?.DomainName).toBe('api.example.test');
    expect(input?.ValidationMethod).toBe('DNS');
  });

  it('present + converged → no-op', async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [{ CertificateArn: ARN, DomainName: 'api.example.test' }],
    });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'api.example.test',
        DomainValidationOptions: [{ DomainName: 'api.example.test', ValidationMethod: 'DNS' }],
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: MANAGED });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('validation-method drift is IMMUTABLE → replace, gated', async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [{ CertificateArn: ARN, DomainName: 'api.example.test' }],
    });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'api.example.test',
        DomainValidationOptions: [{ DomainName: 'api.example.test', ValidationMethod: 'EMAIL' }],
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: MANAGED });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('replace');

    // Gate closed → refusal, nothing deleted or requested.
    const refused = await executor().apply(plan, { apply: true });
    expect(refused.items[0]?.error).toContain('refusing to replace');
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(0);

    // Gate open → delete then re-request.
    acm.on(DeleteCertificateCommand).resolves({});
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: 'arn:new' });
    const replaced = await executor().apply(plan, { apply: true, replace: true });
    expect(replaced.items[0]?.applied).toBe(true);
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(1);
    expect(acm.commandCalls(RequestCertificateCommand)).toHaveLength(1);
  });

  it('destroy → DeleteCertificate by ARN (managed-only)', async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [{ CertificateArn: ARN, DomainName: 'api.example.test' }],
    });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: { CertificateArn: ARN, DomainName: 'api.example.test' },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: MANAGED });
    acm.on(DeleteCertificateCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(acm.commandCalls(DeleteCertificateCommand)[0]?.args[0].input?.CertificateArn).toBe(ARN);
  });
});

describe('aws:elasticloadbalancing:TargetGroup', () => {
  const plan = providerPlan([
    planResource('web-tg', 'aws:elasticloadbalancing:TargetGroup', {
      targetType: 'ip',
      healthCheckPath: '/healthz',
      healthCheckInterval: '30s',
    }),
  ]);
  const ARN = 'arn:aws:elasticloadbalancing:eu-west-1:REDACTED:targetgroup/web-tg/mock';
  const liveGroup = {
    TargetGroupArn: ARN,
    TargetGroupName: 'web-tg',
    TargetType: 'ip' as const,
    Protocol: 'HTTP' as const,
    Port: 80,
    VpcId: 'vpc-default123',
    HealthCheckPath: '/healthz',
    HealthCheckIntervalSeconds: 30,
  };

  it('absent → resolves the DEFAULT VPC (ADR-0005) and creates', async () => {
    elbv2.on(DescribeTargetGroupsCommand).rejects(serviceError('TargetGroupNotFoundException'));
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default123', IsDefault: true }] });
    elbv2.on(CreateTargetGroupCommand).resolves({ TargetGroups: [liveGroup] });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe(ARN);
    const input = elbv2.commandCalls(CreateTargetGroupCommand)[0]?.args[0].input;
    expect(input?.VpcId).toBe('vpc-default123');
    expect(input?.TargetType).toBe('ip');
    expect(input?.Protocol).toBe('HTTP');
    expect(input?.Port).toBe(80);
    expect(input?.HealthCheckPath).toBe('/healthz');
    expect(input?.HealthCheckIntervalSeconds).toBe(30); // '30s' coerced
  });

  it('no default VPC and no vpcId attribute → fail-closed with the ADR-0005 message', async () => {
    elbv2.on(DescribeTargetGroupsCommand).rejects(serviceError('TargetGroupNotFoundException'));
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [] });

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('no default VPC');
  });

  it('present + converged → no-op (default-VPC deployments do not read as drifted)', async () => {
    elbv2.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [liveGroup] });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: ARN, Tags: MANAGED }],
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('health-check drift → ModifyTargetGroup (safe update)', async () => {
    elbv2.on(DescribeTargetGroupsCommand).resolves({
      TargetGroups: [{ ...liveGroup, HealthCheckPath: '/', HealthCheckIntervalSeconds: 60 }],
    });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: ARN, Tags: MANAGED }],
    });
    elbv2.on(ModifyTargetGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    const input = elbv2.commandCalls(ModifyTargetGroupCommand)[0]?.args[0].input;
    expect(input?.HealthCheckPath).toBe('/healthz');
    expect(input?.HealthCheckIntervalSeconds).toBe(30);
  });

  it('port drift is IMMUTABLE → replace', async () => {
    const drifted = providerPlan([
      planResource('web-tg', 'aws:elasticloadbalancing:TargetGroup', {
        targetType: 'ip',
        port: 8080, // live is 80
        healthCheckPath: '/healthz',
        healthCheckInterval: '30s',
      }),
    ]);
    elbv2.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [liveGroup] });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: ARN, Tags: MANAGED }],
    });

    const report = await executor().plan(drifted);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy → DeleteTargetGroup by ARN (managed-only)', async () => {
    elbv2.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [liveGroup] });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: ARN, Tags: MANAGED }],
    });
    elbv2.on(DeleteTargetGroupCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(elbv2.commandCalls(DeleteTargetGroupCommand)[0]?.args[0].input?.TargetGroupArn).toBe(ARN);
  });
});
