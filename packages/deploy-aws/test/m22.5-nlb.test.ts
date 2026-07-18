/**
 * M22.5 — NLB variant of `aws:elasticloadbalancing:LoadBalancer`, mock-tested
 * (aws-sdk-client-mock). Same target type as the live-proven ALB (M21.3);
 * `loadBalancerType: network` discriminates. Includes an ALB regression
 * canary so the application branch provably still behaves as in M21.3.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  ElasticLoadBalancingV2Client,
  ModifyLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const elbv2 = mockClient(ElasticLoadBalancingV2Client);
const ec2 = mockClient(EC2Client);

const MANAGED = [{ Key: 'iap:managed', Value: 'true' }];
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

function mockDefaultNetwork() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
    ],
  });
}

beforeEach(() => {
  elbv2.reset();
  ec2.reset();
});

describe('aws:elasticloadbalancing:LoadBalancer — network (NLB) variant', () => {
  const nlbPlan = providerPlan([
    planResource('edge-nlb', 'aws:elasticloadbalancing:LoadBalancer', {
      loadBalancerType: 'network',
      scheme: 'internal',
    }),
  ]);
  const liveNlb = {
    LoadBalancerArn: 'arn:lb/edge-nlb',
    LoadBalancerName: 'edge-nlb',
    Type: 'network' as const,
    Scheme: 'internal' as const,
  };

  it('absent → CreateLoadBalancer Type network + internal scheme + tags; no HTTP attribute calls', async () => {
    elbv2.on(DescribeLoadBalancersCommand).rejects(serviceError('LoadBalancerNotFoundException'));
    mockDefaultNetwork();
    elbv2.on(CreateLoadBalancerCommand).resolves({ LoadBalancers: [liveNlb] });

    const report = await executor().apply(nlbPlan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.identifier).toBe('arn:lb/edge-nlb');
    const input = elbv2.commandCalls(CreateLoadBalancerCommand)[0]?.args[0].input;
    expect(input?.Type).toBe('network');
    expect(input?.Scheme).toBe('internal');
    expect(input?.Subnets).toEqual(['subnet-a', 'subnet-b']);
    expect(input?.Tags).toContainEqual({ Key: 'iap:managed', Value: 'true' });
    // NLBs have no routing.http.* surface — the ALB attribute call must not fire.
    expect(elbv2.commandCalls(ModifyLoadBalancerAttributesCommand)).toHaveLength(0);
  });

  it('ALB-only attribute pinned on a network plan fails closed — recorded error, no create', async () => {
    const bad = providerPlan([
      planResource('edge-nlb', 'aws:elasticloadbalancing:LoadBalancer', {
        loadBalancerType: 'network',
        sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        dropInvalidHeaderFields: true,
      }),
    ]);
    elbv2.on(DescribeLoadBalancersCommand).rejects(serviceError('LoadBalancerNotFoundException'));
    mockDefaultNetwork();

    const report = await executor().apply(bad, { apply: true });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('ALB-only');
    expect(report.errors[0]).toContain('sslPolicy');
    expect(report.errors[0]).toContain('dropInvalidHeaderFields');
    expect(report.items[0]?.applied).toBe(false);
    expect(elbv2.commandCalls(CreateLoadBalancerCommand)).toHaveLength(0);
  });

  it('loadBalancerType drift application→network is IMMUTABLE → replace classification', async () => {
    elbv2.on(DescribeLoadBalancersCommand).resolves({
      LoadBalancers: [{ ...liveNlb, Type: 'application' }],
    });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: 'arn:lb/edge-nlb', Tags: MANAGED }],
    });
    elbv2.on(DescribeLoadBalancerAttributesCommand).resolves({ Attributes: [] });

    const report = await executor().plan(nlbPlan);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('replace refuses while the replacement gate is closed — no delete, no create', async () => {
    elbv2.on(DescribeLoadBalancersCommand).resolves({
      LoadBalancers: [{ ...liveNlb, Type: 'application' }],
    });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: 'arn:lb/edge-nlb', Tags: MANAGED }],
    });
    elbv2.on(DescribeLoadBalancerAttributesCommand).resolves({ Attributes: [] });

    const report = await executor().apply(nlbPlan, { apply: true }); // replace gate NOT open

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('refusing to replace');
    expect(elbv2.commandCalls(DeleteLoadBalancerCommand)).toHaveLength(0);
    expect(elbv2.commandCalls(CreateLoadBalancerCommand)).toHaveLength(0);
  });

  it('present + converged NLB → no-op (and no ALB attribute describe)', async () => {
    elbv2.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [liveNlb] });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: 'arn:lb/edge-nlb', Tags: MANAGED }],
    });

    const report = await executor().plan(nlbPlan);

    expect(report.items[0]?.action).toBe('no-op');
    expect(elbv2.commandCalls(DescribeLoadBalancerAttributesCommand)).toHaveLength(0);
  });

  it('destroy → DeleteLoadBalancer by ARN (managed)', async () => {
    elbv2.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [liveNlb] });
    elbv2.on(DescribeTagsCommand).resolves({
      TagDescriptions: [{ ResourceArn: 'arn:lb/edge-nlb', Tags: MANAGED }],
    });
    elbv2.on(DeleteLoadBalancerCommand).resolves({});

    const report = await executor().apply(nlbPlan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(elbv2.commandCalls(DeleteLoadBalancerCommand)[0]?.args[0].input?.LoadBalancerArn).toBe('arn:lb/edge-nlb');
  });

  it('ALB regression canary — application branch still creates with the HTTP attributes', async () => {
    const albPlan = providerPlan([
      planResource('edge', 'aws:elasticloadbalancing:LoadBalancer', {
        loadBalancerType: 'application',
        scheme: 'internal',
        dropInvalidHeaderFields: true,
        accessLogsEnabled: false,
      }),
    ]);
    elbv2.on(DescribeLoadBalancersCommand).rejects(serviceError('LoadBalancerNotFoundException'));
    mockDefaultNetwork();
    elbv2.on(CreateLoadBalancerCommand).resolves({
      LoadBalancers: [{ LoadBalancerArn: 'arn:lb/edge', Type: 'application', Scheme: 'internal' }],
    });
    elbv2.on(ModifyLoadBalancerAttributesCommand).resolves({});

    const report = await executor().apply(albPlan, { apply: true });

    expect(report.errors).toEqual([]);
    expect(elbv2.commandCalls(CreateLoadBalancerCommand)[0]?.args[0].input?.Type).toBe('application');
    const attrs = elbv2.commandCalls(ModifyLoadBalancerAttributesCommand)[0]?.args[0].input?.Attributes;
    expect(attrs).toContainEqual({
      Key: 'routing.http.drop_invalid_header_fields.enabled',
      Value: 'true',
    });
    expect(attrs).toContainEqual({ Key: 'access_logs.s3.enabled', Value: 'false' });
  });
});
