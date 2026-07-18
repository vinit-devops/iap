/**
 * M24.2 EventBridge eventing handlers, mock-tested (never touches real AWS):
 * `aws:events:EventBus` (identity-only, empty projection — BackupVault idiom)
 * and `aws:events:Rule` (lives ON a bus; eventBusName immutable → replace;
 * targets removed BEFORE the rule is deleted). Ordering mirrors ordering.test.ts
 * via report.items: bus-before-rule on create, rule-before-bus on destroy.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DeleteRuleCommand,
  DescribeEventBusCommand,
  DescribeRuleCommand,
  EventBridgeClient,
  ListTagsForResourceCommand,
  ListTargetsByRuleCommand,
  PutRuleCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const eventbridge = mockClient(EventBridgeClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => {
  eventbridge.reset();
});

describe('aws:events:EventBus', () => {
  const plan = providerPlan([planResource('app-bus', 'aws:events:EventBus', {})]);

  it('absent → CreateEventBus with the mandatory tags; identifier is the bus ARN', async () => {
    eventbridge.on(DescribeEventBusCommand).rejects(serviceError('ResourceNotFoundException'));
    eventbridge.on(CreateEventBusCommand).resolves({ EventBusArn: 'arn:aws:events:bus/app-bus' });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:events:bus/app-bus');
    const input = eventbridge.commandCalls(CreateEventBusCommand)[0]?.args[0].input;
    expect(input?.Name).toBe('app-bus');
    expect(input?.EventSourceName).toBeUndefined(); // custom bus, not a partner source
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('present bus reads converged — empty projection → no-op (no mutation)', async () => {
    eventbridge
      .on(DescribeEventBusCommand)
      .resolves({ Name: 'app-bus', Arn: 'arn:aws:events:bus/app-bus' });
    eventbridge
      .on(ListTagsForResourceCommand)
      .resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('no-op');
  });

  it('destroy deletes a managed bus; refuses one lacking iap:managed', async () => {
    // Managed → DeleteEventBus.
    eventbridge.on(DescribeEventBusCommand).resolves({ Arn: 'arn:aws:events:bus/app-bus' });
    eventbridge
      .on(ListTagsForResourceCommand)
      .resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });
    eventbridge.on(DeleteEventBusCommand).resolves({});

    const del = await executor().apply(plan, { apply: true, destroy: true });
    expect(del.items[0]?.applied).toBe(true);
    expect(eventbridge.commandCalls(DeleteEventBusCommand)).toHaveLength(1);

    // Unmanaged → refuse, issue no delete.
    eventbridge.reset();
    eventbridge.on(DescribeEventBusCommand).resolves({ Arn: 'arn:aws:events:bus/app-bus' });
    eventbridge.on(ListTagsForResourceCommand).resolves({ Tags: [] });
    eventbridge.on(DeleteEventBusCommand).resolves({});

    const refused = await executor().apply(plan, { apply: true, destroy: true });
    expect(refused.items[0]?.applied).toBe(false);
    expect(refused.errors[0]).toContain('managed-only destroy');
    expect(eventbridge.commandCalls(DeleteEventBusCommand)).toHaveLength(0);
  });
});

describe('aws:events:Rule', () => {
  it('absent → PutRule with eventPattern + eventBusName + ENABLED + tags', async () => {
    const plan = providerPlan([
      planResource('on-object', 'aws:events:Rule', {
        eventBusName: 'app-bus',
        eventPattern: '{"source":["aws.s3"]}',
      }),
    ]);
    eventbridge.on(DescribeRuleCommand).rejects(serviceError('ResourceNotFoundException'));
    eventbridge.on(PutRuleCommand).resolves({ RuleArn: 'arn:aws:events:rule/app-bus/on-object' });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:events:rule/app-bus/on-object');
    const input = eventbridge.commandCalls(PutRuleCommand)[0]?.args[0].input;
    expect(input?.Name).toBe('on-object');
    expect(input?.EventBusName).toBe('app-bus');
    expect(input?.EventPattern).toBe('{"source":["aws.s3"]}');
    expect(input?.ScheduleExpression).toBeUndefined();
    expect(input?.State).toBe('ENABLED');
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
  });

  it('neither eventPattern nor scheduleExpression fails closed (no PutRule)', async () => {
    const plan = providerPlan([
      planResource('empty-rule', 'aws:events:Rule', { eventBusName: 'app-bus' }),
    ]);
    eventbridge.on(DescribeRuleCommand).rejects(serviceError('ResourceNotFoundException'));

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.errors[0]).toContain('eventPattern or a scheduleExpression');
    expect(eventbridge.commandCalls(PutRuleCommand)).toHaveLength(0);
  });

  it('state/pattern drift reconciles in place → update (no replace)', async () => {
    const plan = providerPlan([
      planResource('on-object', 'aws:events:Rule', {
        eventBusName: 'app-bus',
        eventPattern: '{"source":["aws.s3"]}',
        enabled: false,
      }),
    ]);
    eventbridge.on(DescribeRuleCommand).resolves({
      Arn: 'arn:aws:events:rule/app-bus/on-object',
      EventBusName: 'app-bus',
      EventPattern: '{"source":["aws.ec2"]}', // drifted pattern
      State: 'ENABLED', // drifted state (desired DISABLED)
    });
    eventbridge
      .on(ListTagsForResourceCommand)
      .resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('update');
  });

  it('eventBusName drift is IMMUTABLE → replace (a rule cannot move buses)', async () => {
    const plan = providerPlan([
      planResource('on-object', 'aws:events:Rule', {
        eventBusName: 'app-bus',
        eventPattern: '{"source":["aws.s3"]}',
      }),
    ]);
    eventbridge.on(DescribeRuleCommand).resolves({
      Arn: 'arn:aws:events:rule/other-bus/on-object',
      EventBusName: 'other-bus', // lives on a different bus than desired
      EventPattern: '{"source":["aws.s3"]}',
      State: 'ENABLED',
    });
    eventbridge
      .on(ListTagsForResourceCommand)
      .resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('replace');
  });

  it('destroy removes targets BEFORE DeleteRule (order matters)', async () => {
    const plan = providerPlan([
      planResource('on-object', 'aws:events:Rule', {
        eventBusName: 'app-bus',
        eventPattern: '{"source":["aws.s3"]}',
      }),
    ]);
    eventbridge.on(DescribeRuleCommand).resolves({
      Arn: 'arn:aws:events:rule/app-bus/on-object',
      EventBusName: 'app-bus',
      EventPattern: '{"source":["aws.s3"]}',
      State: 'ENABLED',
    });
    eventbridge
      .on(ListTagsForResourceCommand)
      .resolves({ Tags: [{ Key: 'iap:managed', Value: 'true' }] });
    eventbridge
      .on(ListTargetsByRuleCommand)
      .resolves({ Targets: [{ Id: 'on-object-target', Arn: 'arn:aws:lambda:fn' }] });
    eventbridge.on(RemoveTargetsCommand).resolves({});
    eventbridge.on(DeleteRuleCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);

    const remove = eventbridge.commandCalls(RemoveTargetsCommand)[0];
    expect(remove?.args[0].input?.Ids).toEqual(['on-object-target']);
    const calls = eventbridge.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('RemoveTargetsCommand')).toBeLessThan(calls.indexOf('DeleteRuleCommand'));
  });
});

describe('aws:events dependsOn ordering (bus ↔ rule)', () => {
  // 'a-rule' sorts BEFORE 'z-bus' alphabetically — only dependsOn can order the
  // bus first on create and the rule first on destroy (mirror ordering.test.ts).
  function busAndRule() {
    const bus = planResource('z-bus', 'aws:events:EventBus', {});
    const rule = planResource('a-rule', 'aws:events:Rule', {
      eventBusName: 'z-bus',
      eventPattern: '{"source":["aws.s3"]}',
    });
    rule.dependsOn = [bus.logicalId];
    return { bus, rule };
  }

  it('create: the bus is created BEFORE the rule that depends on it', async () => {
    const { bus, rule } = busAndRule();
    eventbridge.on(DescribeEventBusCommand).rejects(serviceError('ResourceNotFoundException'));
    eventbridge.on(CreateEventBusCommand).resolves({ EventBusArn: 'arn:aws:events:bus/z-bus' });
    eventbridge.on(DescribeRuleCommand).rejects(serviceError('ResourceNotFoundException'));
    eventbridge.on(PutRuleCommand).resolves({ RuleArn: 'arn:aws:events:rule/z-bus/a-rule' });

    const report = await executor().apply(providerPlan([rule, bus]), { apply: true });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([bus.logicalId, rule.logicalId]);
    const calls = eventbridge.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('CreateEventBusCommand')).toBeLessThan(calls.indexOf('PutRuleCommand'));
  });

  it('destroy: reverses topology — the rule is deleted BEFORE its bus', async () => {
    const { bus, rule } = busAndRule();
    const managed = { Tags: [{ Key: 'iap:managed', Value: 'true' }] };
    eventbridge.on(DescribeEventBusCommand).resolves({ Arn: 'arn:aws:events:bus/z-bus' });
    eventbridge.on(DescribeRuleCommand).resolves({
      Arn: 'arn:aws:events:rule/z-bus/a-rule',
      EventBusName: 'z-bus',
      EventPattern: '{"source":["aws.s3"]}',
      State: 'ENABLED',
    });
    eventbridge.on(ListTagsForResourceCommand).resolves(managed);
    eventbridge.on(ListTargetsByRuleCommand).resolves({ Targets: [] });
    eventbridge.on(DeleteRuleCommand).resolves({});
    eventbridge.on(DeleteEventBusCommand).resolves({});

    const report = await executor().apply(providerPlan([rule, bus]), {
      apply: true,
      destroy: true,
    });

    expect(report.errors).toEqual([]);
    expect(report.items.map((i) => i.logicalId)).toEqual([rule.logicalId, bus.logicalId]);
    const calls = eventbridge.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('DeleteRuleCommand')).toBeLessThan(calls.indexOf('DeleteEventBusCommand'));
  });
});
