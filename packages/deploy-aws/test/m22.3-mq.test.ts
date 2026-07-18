/**
 * M22.3 Amazon MQ handler, mock-tested: `aws:mq:Broker`.
 *
 * Covers: create with the single-instance micro posture (never publicly
 * accessible, first default-VPC subnet, default SG) and a locally generated
 * admin password that NEVER appears in the projection or the report;
 * name → BrokerId resolution via paginated ListBrokers (match on page 2);
 * autoMinorVersionUpgrade / instanceType drift → UpdateBroker in place
 * (maintenance-window semantics, no immediacy claimed); engineType drift →
 * replace classification with a fail-closed refusal while the replacement
 * gate is shut; destroy by the resolved id; and a refusal to blind-delete
 * when the name does not resolve.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateBrokerCommand,
  CreateTagsCommand,
  DeleteBrokerCommand,
  DescribeBrokerCommand,
  ListBrokersCommand,
  MqClient,
  UpdateBrokerCommand,
} from '@aws-sdk/client-mq';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { AwsExecutor, MqBrokerHandler } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const mq = mockClient(MqClient);
const ec2 = mockClient(EC2Client);

const BROKER_ARN = 'arn:aws:mq:eu-central-1:000000000000:broker:jarvis-broker:b-1234';
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

function mockDefaultNetwork() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] });
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [
      { SubnetId: 'subnet-a', AvailabilityZone: 'eu-central-1a' },
      { SubnetId: 'subnet-b', AvailabilityZone: 'eu-central-1b' },
    ],
  });
  ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-default' }] });
}

beforeEach(() => {
  mq.reset();
  ec2.reset();
});

const plan = providerPlan([planResource('jarvis-broker', 'aws:mq:Broker')]);

const summary = {
  BrokerId: 'b-1234',
  BrokerArn: BROKER_ARN,
  BrokerName: 'jarvis-broker',
  BrokerState: 'RUNNING',
  DeploymentMode: 'SINGLE_INSTANCE',
} as const;

/**
 * Converged against the all-defaults plan. NOTE the engine casing: AWS returns
 * `ActiveMQ` from DescribeBroker (not the `ACTIVEMQ` enum that CreateBroker
 * takes). The M22.3 live run proved this — a mock that echoed the enum casing
 * hid a spurious `replace` on the immutable engineType key. Keeping the real
 * casing here guards the case-normalisation fix.
 */
const liveBroker = {
  BrokerId: 'b-1234',
  BrokerArn: BROKER_ARN,
  BrokerName: 'jarvis-broker',
  BrokerState: 'RUNNING',
  EngineType: 'ActiveMQ',
  DeploymentMode: 'SINGLE_INSTANCE',
  HostInstanceType: 'mq.t3.micro',
  AutoMinorVersionUpgrade: true,
  Tags: { 'iap:managed': 'true' },
} as const;

describe('aws:mq:Broker', () => {
  it('absent (name resolves nothing) → CreateBroker: single-instance micro, private, generated password', async () => {
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [] });
    mq.on(CreateBrokerCommand).resolves({ BrokerArn: BROKER_ARN, BrokerId: 'b-1234' });
    mockDefaultNetwork();

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(BROKER_ARN);

    const input = mq.commandCalls(CreateBrokerCommand)[0]?.args[0].input;
    expect(input?.BrokerName).toBe('jarvis-broker');
    expect(input?.EngineType).toBe('ACTIVEMQ');
    expect(input?.HostInstanceType).toBe('mq.t3.micro');
    expect(input?.DeploymentMode).toBe('SINGLE_INSTANCE');
    expect(input?.PubliclyAccessible).toBe(false);
    expect(input?.AutoMinorVersionUpgrade).toBe(true);
    expect(input?.SubnetIds).toEqual(['subnet-a']); // SINGLE_INSTANCE: exactly one subnet
    expect(input?.SecurityGroups).toEqual(['sg-default']);
    expect(input?.Tags?.['iap:managed']).toBe('true'); // CreateBroker takes a tag MAP
    expect(input?.Users).toHaveLength(1);
    expect(input?.Users?.[0]?.Username).toBe('iapadmin');

    // The password is locally generated, ≥12 chars — and NEVER leaves the
    // create call: not in the projection, not in the report.
    const password = input?.Users?.[0]?.Password ?? '';
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(JSON.stringify(report)).not.toContain(password);
    const handler = new MqBrokerHandler(
      new MqClient({ region: 'eu-central-1' }),
      new EC2Client({ region: 'eu-central-1' }),
    );
    const projection = handler.desiredProjection(plan.resources[0]!);
    expect(JSON.stringify(projection)).not.toContain(password);
    expect(Object.keys(projection).sort()).toEqual([
      'autoMinorVersionUpgrade',
      'deploymentMode',
      'engineType',
      'instanceType',
    ]);
  });

  it('name resolution paginates ListBrokers (match on page 2) → converged no-op', async () => {
    mq.on(ListBrokersCommand)
      .resolvesOnce({
        NextToken: 'page-2',
        BrokerSummaries: [
          {
            BrokerId: 'b-other',
            BrokerName: 'other-broker',
            BrokerState: 'RUNNING',
            DeploymentMode: 'SINGLE_INSTANCE',
          },
        ],
      })
      .resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves(liveBroker);

    const report = await executor().plan(plan);

    expect(report.items[0]?.action).toBe('no-op');
    const listCalls = mq.commandCalls(ListBrokersCommand);
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    expect(listCalls[1]?.args[0].input?.NextToken).toBe('page-2');
    expect(mq.commandCalls(DescribeBrokerCommand)[0]?.args[0].input?.BrokerId).toBe('b-1234');
  });

  it("engine casing is normalised: DescribeBroker's `ActiveMQ` vs the `ACTIVEMQ` enum → no-op, not a spurious replace (M22.3 live finding)", async () => {
    // Regression guard for the live bug: AWS returns `ActiveMQ` while the
    // desired/enum side is `ACTIVEMQ`. engineType is IMMUTABLE, so without
    // case-normalisation a converged broker classified `replace` (destructive
    // delete+create) on every run — idempotency broken.
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves({ ...liveBroker, EngineType: 'ActiveMQ' });

    const planned = await executor().plan(plan);
    expect(planned.items[0]?.action).toBe('no-op');

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('no-op');
    expect(report.errors).toHaveLength(0);
    expect(mq.commandCalls(DeleteBrokerCommand)).toHaveLength(0);
    expect(mq.commandCalls(CreateBrokerCommand)).toHaveLength(0);
    expect(mq.commandCalls(UpdateBrokerCommand)).toHaveLength(0);
  });

  it('a broker in DELETION_IN_PROGRESS reads as absent → create classification', async () => {
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves({
      ...liveBroker,
      BrokerState: 'DELETION_IN_PROGRESS',
    });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('create');
  });

  it('autoMinorVersionUpgrade drift → UpdateBroker in place (next maintenance window)', async () => {
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves({ ...liveBroker, AutoMinorVersionUpgrade: false });
    mq.on(UpdateBrokerCommand).resolves({ BrokerId: 'b-1234' });
    mq.on(CreateTagsCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = mq.commandCalls(UpdateBrokerCommand)[0]?.args[0].input;
    expect(input?.BrokerId).toBe('b-1234'); // the name-resolved generated id
    expect(input?.AutoMinorVersionUpgrade).toBe(true);
    // Tag reconciliation goes through the MQ tag API on the broker ARN.
    expect(mq.commandCalls(CreateTagsCommand)[0]?.args[0].input?.ResourceArn).toBe(BROKER_ARN);
    expect(mq.commandCalls(DeleteBrokerCommand)).toHaveLength(0);
    expect(mq.commandCalls(CreateBrokerCommand)).toHaveLength(0);
  });

  it('instanceType drift → UpdateBroker HostInstanceType (in place, no replacement)', async () => {
    const sized = providerPlan([
      planResource('jarvis-broker', 'aws:mq:Broker', { instanceType: 'mq.m5.large' }),
    ]);
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves(liveBroker);
    mq.on(UpdateBrokerCommand).resolves({ BrokerId: 'b-1234' });
    mq.on(CreateTagsCommand).resolves({});

    const report = await executor().apply(sized, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    const input = mq.commandCalls(UpdateBrokerCommand)[0]?.args[0].input;
    expect(input?.HostInstanceType).toBe('mq.m5.large');
    expect(mq.commandCalls(DeleteBrokerCommand)).toHaveLength(0);
  });

  it('an accepted instance-type update lands in PendingHostInstanceType → plan goes quiet, not a re-planned update (M22.3 live finding)', async () => {
    // Regression guard: after UpdateBroker accepts a HostInstanceType change,
    // DescribeBroker keeps the OLD HostInstanceType and surfaces the accepted
    // value under PendingHostInstanceType until the maintenance window. The
    // projection must read the pending (accepted) value so a converged plan is
    // no-op — otherwise it re-issues UpdateBroker on every run until the window.
    const sized = providerPlan([
      planResource('jarvis-broker', 'aws:mq:Broker', { instanceType: 'mq.m5.large' }),
    ]);
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves({
      ...liveBroker,
      HostInstanceType: 'mq.t3.micro', // still the old class live
      PendingHostInstanceType: 'mq.m5.large', // the accepted change
    });

    const planned = await executor().plan(sized);
    expect(planned.items[0]?.action).toBe('no-op');

    const report = await executor().apply(sized, { apply: true });
    expect(report.items[0]?.action).toBe('no-op');
    expect(mq.commandCalls(UpdateBrokerCommand)).toHaveLength(0);
  });

  it('engineType drift is IMMUTABLE → replace classification; closed gate refuses fail-closed', async () => {
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves({ ...liveBroker, EngineType: 'RABBITMQ' });

    const planned = await executor().plan(plan); // desired default: ACTIVEMQ
    expect(planned.items[0]?.action).toBe('replace');

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('refusing to replace');
    expect(report.errors).toHaveLength(1);
    expect(mq.commandCalls(DeleteBrokerCommand)).toHaveLength(0);
    expect(mq.commandCalls(CreateBrokerCommand)).toHaveLength(0);
  });

  it('destroy → DeleteBroker by the name-resolved id', async () => {
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [summary] });
    mq.on(DescribeBrokerCommand).resolves(liveBroker);
    mq.on(DeleteBrokerCommand).resolves({ BrokerId: 'b-1234' });

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    expect(mq.commandCalls(DeleteBrokerCommand)[0]?.args[0].input?.BrokerId).toBe('b-1234');
  });

  it('delete refuses when the name does not resolve — never a blind id guess', async () => {
    mq.on(ListBrokersCommand).resolves({ BrokerSummaries: [] });
    const handler = new MqBrokerHandler(
      new MqClient({ region: 'eu-central-1' }),
      new EC2Client({ region: 'eu-central-1' }),
    );

    await expect(
      handler.delete(planResource('jarvis-broker', 'aws:mq:Broker'), {
        exists: true,
        managed: true,
        tags: { 'iap:managed': 'true' },
        projection: {},
      }),
    ).rejects.toThrow('refusing blind delete');
    expect(mq.commandCalls(DeleteBrokerCommand)).toHaveLength(0);
  });
});
