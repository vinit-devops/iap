/**
 * CloudWatch handlers (@aws-sdk/client-cloudwatch) — the Alert and Dashboard
 * kinds (M23.2).
 *
 * ── aws:cloudwatch:Alarm (from the abstract Alert kind) ────────────────────
 * read → DescribeAlarms(AlarmNames) + ListTagsForResource
 * create/update → PutMetricAlarm (an idempotent upsert; update re-issues it) +
 *                 TagResource
 * delete → DeleteAlarms
 *
 * The AlarmName is the plan resourceId. PutMetricAlarm is a full upsert, so
 * create and update issue the same call. NO immutable projection keys →
 * replacement is N/A for alarms (any drift reconciles in place). The abstract
 * Alert kind carries no metric vocabulary yet, so the metric surface
 * (metricName/namespace/statistic/comparisonOperator/threshold/period/
 * evaluationPeriods) comes from plan attributes with sensible placeholder
 * defaults; a placeholder metric is a valid, harmless alarm.
 *
 * OUTPUTS: identifier = AlarmArn. PutMetricAlarm returns no ARN, so create
 * returns a synthetic `cloudwatch:alarm:<name>` identifier; read surfaces the
 * real AlarmArn.
 *
 * ── aws:cloudwatch:Dashboard (from the Dashboard kind) ─────────────────────
 * read → GetDashboard (DashboardNotFoundError/ResourceNotFound → absent)
 * create/update → PutDashboard
 * delete → DeleteDashboards
 *
 * TAG-LESS MANAGED GATE — classic CloudWatch dashboards do NOT support tags on
 * PutDashboard (Tags there are ignored on update and the classic body has no
 * tag surface), so the usual `iap:managed=true` tag gate cannot be used. This
 * handler instead embeds a PROVENANCE MARKER WIDGET inside the DashboardBody: a
 * small text widget whose markdown carries `iap:managed=true` and
 * `iap:resourceId=<id>`. On read the body is parsed and managed-ness is derived
 * from the presence of that marker — so destroy still refuses any dashboard the
 * runtime did not create (no marker → managed:false → managed-only gate fires).
 * The marker widget is stripped before drift comparison so it never counts as
 * body drift. NO immutable projection keys → replacement is N/A.
 *
 * OUTPUTS: identifier = DashboardArn (from GetDashboard) or, when unavailable
 * (PutDashboard returns none), the region-derived console URL, which is also
 * the human endpoint for the dashboard.
 */

import {
  DeleteAlarmsCommand,
  DeleteDashboardsCommand,
  DescribeAlarmsCommand,
  GetDashboardCommand,
  ListTagsForResourceCommand,
  PutDashboardCommand,
  PutMetricAlarmCommand,
  TagResourceCommand,
} from '@aws-sdk/client-cloudwatch';
import type {
  CloudWatchClient,
  ComparisonOperator,
  Statistic,
} from '@aws-sdk/client-cloudwatch';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const ALARM_DEFAULTS = {
  metricName: 'Heartbeat',
  namespace: 'IaP/Placeholder',
  statistic: 'Average',
  comparisonOperator: 'GreaterThanThreshold',
  threshold: '1',
  evaluationPeriods: '1',
  period: '300',
} as const;

export class CloudWatchAlarmHandler implements TargetHandler {
  static readonly targetType = 'aws:cloudwatch:Alarm' as const;
  readonly targetType = CloudWatchAlarmHandler.targetType;
  // No immutable projection keys — every metric attribute reconciles in place
  // via a PutMetricAlarm upsert, so replacement is N/A for alarms (ADR-0006).

  constructor(private readonly cloudwatch: CloudWatchClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      metricName: scalarStr(a['metricName']) || ALARM_DEFAULTS.metricName,
      namespace: scalarStr(a['namespace']) || ALARM_DEFAULTS.namespace,
      statistic: scalarStr(a['statistic']) || ALARM_DEFAULTS.statistic,
      comparisonOperator:
        scalarStr(a['comparisonOperator']) || ALARM_DEFAULTS.comparisonOperator,
      threshold: scalarStr(a['threshold']) || ALARM_DEFAULTS.threshold,
      evaluationPeriods:
        scalarStr(a['evaluationPeriods']) || ALARM_DEFAULTS.evaluationPeriods,
      period: scalarStr(a['period']) || ALARM_DEFAULTS.period,
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const AlarmName = resourceIdOf(resource);
    const found = await this.cloudwatch.send(
      new DescribeAlarmsCommand({ AlarmNames: [AlarmName] }),
    );
    const alarm = (found.MetricAlarms ?? [])[0];
    if (alarm === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (alarm.AlarmArn !== undefined) {
      const tagResult = await this.cloudwatch.send(
        new ListTagsForResourceCommand({ ResourceARN: alarm.AlarmArn }),
      );
      tags = fromTagList(tagResult.Tags ?? []);
    }

    const projection: Record<string, string> = {
      metricName: alarm.MetricName ?? '',
      namespace: alarm.Namespace ?? '',
      statistic: alarm.Statistic ?? '',
      comparisonOperator: alarm.ComparisonOperator ?? '',
      threshold: alarm.Threshold === undefined ? '' : String(alarm.Threshold),
      evaluationPeriods:
        alarm.EvaluationPeriods === undefined ? '' : String(alarm.EvaluationPeriods),
      period: alarm.Period === undefined ? '' : String(alarm.Period),
    };

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection,
    };
    if (alarm.AlarmArn !== undefined) state.identifier = alarm.AlarmArn;
    return state;
  }

  /** Issue the full PutMetricAlarm upsert (shared by create and update). */
  private async putAlarm(
    resource: PlanResource,
    tags?: Record<string, string>,
  ): Promise<void> {
    const d = this.desiredProjection(resource);
    await this.cloudwatch.send(
      new PutMetricAlarmCommand({
        AlarmName: resourceIdOf(resource),
        MetricName: d['metricName'],
        Namespace: d['namespace'],
        Statistic: d['statistic'] as Statistic,
        ComparisonOperator: d['comparisonOperator'] as ComparisonOperator,
        Threshold: Number(d['threshold']),
        EvaluationPeriods: Number(d['evaluationPeriods']),
        Period: Number(d['period']),
        ...(tags !== undefined ? { Tags: toTagList(tags) } : {}),
      }),
    );
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    await this.putAlarm(resource, tags);
    // PutMetricAlarm returns no ARN; read surfaces the real AlarmArn later.
    return `cloudwatch:alarm:${resourceIdOf(resource)}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    // Re-issue the full alarm definition (idempotent upsert).
    await this.putAlarm(resource);
    if (current.identifier !== undefined) {
      await this.cloudwatch.send(
        new TagResourceCommand({
          ResourceARN: current.identifier,
          Tags: toTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.cloudwatch.send(
      new DeleteAlarmsCommand({ AlarmNames: [resourceIdOf(resource)] }),
    );
  }
}

const DASHBOARD_NOT_FOUND = ['DashboardNotFoundError', 'ResourceNotFound'] as const;
/** The provenance marker embedded in the dashboard body (tag-less gate). */
const MARKER_MANAGED = 'iap:managed=true';

interface Widget {
  type?: string;
  properties?: { markdown?: string };
  [key: string]: unknown;
}

/** True when a widget is the iap provenance marker (managed-gate signal). */
function isMarkerWidget(widget: Widget): boolean {
  return (
    widget.type === 'text' &&
    typeof widget.properties?.markdown === 'string' &&
    widget.properties.markdown.includes(MARKER_MANAGED)
  );
}

export class CloudWatchDashboardHandler implements TargetHandler {
  static readonly targetType = 'aws:cloudwatch:Dashboard' as const;
  readonly targetType = CloudWatchDashboardHandler.targetType;
  // No immutable projection keys — the body reconciles in place via
  // PutDashboard, so replacement is N/A for dashboards (ADR-0006).

  constructor(private readonly cloudwatch: CloudWatchClient) {}

  /** Parse the plan's `body` attr into a widget array (object or bare array). */
  private desiredWidgets(resource: PlanResource): Widget[] {
    const raw = scalarStr(resource.desiredAttributes['body']);
    if (raw === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (Array.isArray(parsed)) return parsed as Widget[];
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { widgets?: unknown }).widgets)) {
      return (parsed as { widgets: Widget[] }).widgets;
    }
    return [];
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    // Drift surface is the user widget set (the marker is stripped from both
    // sides so provenance never counts as drift). Parse-then-stringify
    // normalizes both desired and live to the same canonical form.
    return { body: JSON.stringify(this.desiredWidgets(resource)) };
  }

  /** The provenance marker widget carrying managed-ness + resourceId. */
  private markerWidget(resource: PlanResource): Widget {
    return {
      type: 'text',
      x: 0,
      y: 0,
      width: 24,
      height: 1,
      properties: { markdown: `${MARKER_MANAGED} iap:resourceId=${resourceIdOf(resource)}` },
    };
  }

  /** Region-derived console URL — the human endpoint for the dashboard. */
  private async consoleUrl(name: string): Promise<string> {
    const configured = this.cloudwatch.config.region;
    const region = typeof configured === 'function' ? await configured() : String(configured);
    return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${name}`;
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const DashboardName = resourceIdOf(resource);
    let body;
    let arn: string | undefined;
    try {
      const found = await this.cloudwatch.send(
        new GetDashboardCommand({ DashboardName }),
      );
      body = found.DashboardBody;
      arn = found.DashboardArn;
    } catch (err) {
      if (nameMatches(err, DASHBOARD_NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }

    let widgets: Widget[] = [];
    if (body !== undefined && body !== '') {
      try {
        const parsed = JSON.parse(body) as { widgets?: Widget[] };
        widgets = Array.isArray(parsed.widgets) ? parsed.widgets : [];
      } catch {
        widgets = [];
      }
    }
    // Managed-ness derives from the embedded marker — dashboards have no tags.
    const managed = widgets.some((w) => isMarkerWidget(w));
    const userWidgets = widgets.filter((w) => !isMarkerWidget(w));

    const state: ResourceState = {
      exists: true,
      managed,
      tags: {}, // classic dashboards carry no tags; gate is the marker widget
      projection: { body: JSON.stringify(userWidgets) },
    };
    state.identifier = arn ?? (await this.consoleUrl(DashboardName));
    return state;
  }

  /** Build the full body JSON: marker widget first, then the user widgets. */
  private buildBody(resource: PlanResource): string {
    return JSON.stringify({
      widgets: [this.markerWidget(resource), ...this.desiredWidgets(resource)],
    });
  }

  async create(resource: PlanResource, _tags: Record<string, string>): Promise<string> {
    // Tags are intentionally ignored — classic dashboards do not support them;
    // ownership is asserted via the marker widget baked into the body.
    const DashboardName = resourceIdOf(resource);
    await this.cloudwatch.send(
      new PutDashboardCommand({ DashboardName, DashboardBody: this.buildBody(resource) }),
    );
    return this.consoleUrl(DashboardName);
  }

  async update(resource: PlanResource, _current: ResourceState): Promise<void> {
    const DashboardName = resourceIdOf(resource);
    await this.cloudwatch.send(
      new PutDashboardCommand({ DashboardName, DashboardBody: this.buildBody(resource) }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.cloudwatch.send(
      new DeleteDashboardsCommand({ DashboardNames: [resourceIdOf(resource)] }),
    );
  }
}
