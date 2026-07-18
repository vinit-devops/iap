/**
 * M23.2 CloudWatch handlers, mock-tested.
 *
 * Alarm (aws:cloudwatch:Alarm): PutMetricAlarm upsert on create (with tags),
 * PutMetricAlarm re-issue on drift, replacement-N/A (no immutable keys),
 * DeleteAlarms teardown, and the managed-only destroy gate.
 *
 * Dashboard (aws:cloudwatch:Dashboard): PutDashboard with the embedded
 * provenance MARKER widget (the tag-less managed gate), managed-ness derived
 * from that marker on read (no marker → destroy refused), body-drift reconcile,
 * and DeleteDashboards teardown.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DeleteDashboardsCommand,
  DescribeAlarmsCommand,
  GetDashboardCommand,
  ListTagsForResourceCommand,
  PutDashboardCommand,
  PutMetricAlarmCommand,
  TagResourceCommand,
} from '@aws-sdk/client-cloudwatch';
import type { MetricAlarm } from '@aws-sdk/client-cloudwatch';
import { AwsExecutor, CloudWatchAlarmHandler } from '../src/index.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const cw = mockClient(CloudWatchClient);
const executor = () => new AwsExecutor({ region: 'eu-central-1' });

beforeEach(() => cw.reset());

const managedTags = { Tags: [{ Key: 'iap:managed', Value: 'true' }] };

/** A live alarm matching the placeholder defaults. */
function liveAlarm(overrides: Partial<MetricAlarm> = {}): MetricAlarm {
  return {
    AlarmName: 'errors-alarm',
    AlarmArn: 'arn:aws:cloudwatch:eu-central-1:000000000000:alarm:errors-alarm',
    MetricName: 'Heartbeat',
    Namespace: 'IaP/Placeholder',
    Statistic: 'Average',
    ComparisonOperator: 'GreaterThanThreshold',
    Threshold: 1,
    EvaluationPeriods: 1,
    Period: 300,
    ...overrides,
  };
}

describe('aws:cloudwatch:Alarm', () => {
  const plan = providerPlan([planResource('errors-alarm', 'aws:cloudwatch:Alarm')]);

  it('absent → PutMetricAlarm upsert with metric surface and iap tags', async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });
    cw.on(PutMetricAlarmCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('cloudwatch:alarm:errors-alarm');
    const input = cw.commandCalls(PutMetricAlarmCommand)[0]?.args[0].input;
    expect(input?.AlarmName).toBe('errors-alarm');
    expect(input?.MetricName).toBe('Heartbeat');
    expect(input?.Namespace).toBe('IaP/Placeholder');
    expect(input?.ComparisonOperator).toBe('GreaterThanThreshold');
    expect(input?.Threshold).toBe(1);
    expect(input?.EvaluationPeriods).toBe(1);
    expect(input?.Period).toBe(300);
    expect(input?.Tags?.some((t) => t.Key === 'iap:managed' && t.Value === 'true')).toBe(true);
    expect(input?.Tags?.some((t) => t.Key === 'iap:planId')).toBe(true);
  });

  it('present + converged → no-op, nothing mutated', async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [liveAlarm()] });
    cw.on(ListTagsForResourceCommand).resolves(managedTags);

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('no-op');
    expect(cw.commandCalls(PutMetricAlarmCommand)).toHaveLength(0);
  });

  it('metric drift → PutMetricAlarm re-issued (update-in-place) + TagResource', async () => {
    const drifted = providerPlan([
      planResource('errors-alarm', 'aws:cloudwatch:Alarm', { threshold: 5 }),
    ]);
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [liveAlarm()] }); // live threshold 1
    cw.on(ListTagsForResourceCommand).resolves(managedTags);
    cw.on(PutMetricAlarmCommand).resolves({});
    cw.on(TagResourceCommand).resolves({});

    const report = await executor().apply(drifted, { apply: true });
    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = cw.commandCalls(PutMetricAlarmCommand)[0]?.args[0].input;
    expect(input?.Threshold).toBe(5);
    expect(cw.commandCalls(TagResourceCommand)).toHaveLength(1);
  });

  it('replacement is N/A — the alarm handler declares no immutable projection keys', () => {
    const handler = new CloudWatchAlarmHandler(new CloudWatchClient({ region: 'eu-central-1' }));
    expect(handler.immutableProjectionKeys).toBeUndefined();
  });

  it('destroy → DeleteAlarms on a managed alarm', async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [liveAlarm()] });
    cw.on(ListTagsForResourceCommand).resolves(managedTags);
    cw.on(DeleteAlarmsCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(cw.commandCalls(DeleteAlarmsCommand)[0]?.args[0].input?.AlarmNames).toEqual([
      'errors-alarm',
    ]);
  });

  it('destroy refuses an unmanaged alarm (managed-only gate)', async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [liveAlarm()] });
    cw.on(ListTagsForResourceCommand).resolves({ Tags: [] }); // not ours

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(cw.commandCalls(DeleteAlarmsCommand)).toHaveLength(0);
  });
});

const widgetA = {
  type: 'metric',
  x: 0,
  y: 1,
  width: 12,
  height: 6,
  properties: { metrics: [['AWS/Lambda', 'Errors']], title: 'A' },
};
const widgetB = {
  type: 'metric',
  x: 0,
  y: 1,
  width: 12,
  height: 6,
  properties: { metrics: [['AWS/Lambda', 'Errors']], title: 'B' },
};

/** Serialize a stored dashboard body with the iap provenance marker widget. */
function bodyWithMarker(resourceId: string, ...widgets: object[]): string {
  return JSON.stringify({
    widgets: [
      {
        type: 'text',
        x: 0,
        y: 0,
        width: 24,
        height: 1,
        properties: { markdown: `iap:managed=true iap:resourceId=${resourceId}` },
      },
      ...widgets,
    ],
  });
}

describe('aws:cloudwatch:Dashboard', () => {
  const plan = providerPlan([
    planResource('ops-dash', 'aws:cloudwatch:Dashboard', {
      body: JSON.stringify([widgetA]),
    }),
  ]);

  it('absent → PutDashboard embedding the iap:managed marker widget', async () => {
    cw.on(GetDashboardCommand).rejects(serviceError('DashboardNotFoundError'));
    cw.on(PutDashboardCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toContain('console.aws.amazon.com');

    const input = cw.commandCalls(PutDashboardCommand)[0]?.args[0].input;
    expect(input?.DashboardName).toBe('ops-dash');
    const parsed = JSON.parse(input?.DashboardBody ?? '{}') as {
      widgets: Array<{ type?: string; properties?: { markdown?: string; title?: string } }>;
    };
    const marker = parsed.widgets.find((w) =>
      w.properties?.markdown?.includes('iap:managed=true'),
    );
    expect(marker).toBeDefined();
    expect(marker?.properties?.markdown).toContain('iap:resourceId=ops-dash');
    // user widgets are preserved alongside the marker
    expect(parsed.widgets.some((w) => w.properties?.title === 'A')).toBe(true);
  });

  it('present + converged (marker + same widgets) → no-op', async () => {
    cw.on(GetDashboardCommand).resolves({
      DashboardBody: bodyWithMarker('ops-dash', widgetA),
      DashboardArn: 'arn:aws:cloudwatch::000000000000:dashboard/ops-dash',
    });

    const report = await executor().apply(plan, { apply: true });
    expect(report.items[0]?.action).toBe('no-op');
    expect(cw.commandCalls(PutDashboardCommand)).toHaveLength(0);
  });

  it('body drift → PutDashboard re-put with the marker preserved', async () => {
    cw.on(GetDashboardCommand).resolves({
      DashboardBody: bodyWithMarker('ops-dash', widgetB), // live has widget B
      DashboardArn: 'arn:aws:cloudwatch::000000000000:dashboard/ops-dash',
    });
    cw.on(PutDashboardCommand).resolves({});

    const report = await executor().apply(plan, { apply: true }); // plan wants widget A
    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const parsed = JSON.parse(
      cw.commandCalls(PutDashboardCommand)[0]?.args[0].input?.DashboardBody ?? '{}',
    ) as { widgets: Array<{ properties?: { markdown?: string; title?: string } }> };
    expect(parsed.widgets.some((w) => w.properties?.markdown?.includes('iap:managed=true'))).toBe(
      true,
    );
    expect(parsed.widgets.some((w) => w.properties?.title === 'A')).toBe(true);
  });

  it('destroy → DeleteDashboards on a marker-managed dashboard', async () => {
    cw.on(GetDashboardCommand).resolves({
      DashboardBody: bodyWithMarker('ops-dash', widgetA),
      DashboardArn: 'arn:aws:cloudwatch::000000000000:dashboard/ops-dash',
    });
    cw.on(DeleteDashboardsCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(true);
    expect(cw.commandCalls(DeleteDashboardsCommand)[0]?.args[0].input?.DashboardNames).toEqual([
      'ops-dash',
    ]);
  });

  it('managed gate via marker: a dashboard with NO marker refuses destroy', async () => {
    // Same name, but the live body has no iap marker — not created by us.
    cw.on(GetDashboardCommand).resolves({
      DashboardBody: JSON.stringify({ widgets: [widgetA] }),
      DashboardArn: 'arn:aws:cloudwatch::000000000000:dashboard/ops-dash',
    });

    const report = await executor().apply(plan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(cw.commandCalls(DeleteDashboardsCommand)).toHaveLength(0);
  });
});
