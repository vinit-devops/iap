/**
 * Replacement-update semantics (ADR-0006) and the derived handler registry
 * (ADR-0004).
 *
 * Replacement: drift on a handler-declared immutable projection key classifies
 * as `replace` (never `update`) and executes as delete+create ONLY behind the
 * explicit replacement gate (`replace: true`) — on managed resources only.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { PlanResource } from '@iap/provider-sdk';
import {
  AwsExecutor,
  HANDLER_REGISTRATIONS,
  SUPPORTED_TARGET_TYPES,
  buildHandlerRegistry,
  createClientBundle,
  isSupportedTargetType,
} from '../src/index.js';
import type { ResourceState, TargetHandler } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

/** Minimal injectable handler with one immutable ('shape') and one mutable ('color') key. */
class FakeWidgetHandler implements TargetHandler {
  static readonly targetType = 'aws:fake:Widget' as const;
  readonly targetType = FakeWidgetHandler.targetType;
  readonly immutableProjectionKeys = ['shape'] as const;
  readonly calls: string[] = [];
  live: ResourceState = { exists: false, managed: false, tags: {}, projection: {} };

  desiredProjection(resource: PlanResource): Record<string, string> {
    return {
      shape: String(resource.desiredAttributes['shape'] ?? ''),
      color: String(resource.desiredAttributes['color'] ?? ''),
    };
  }
  read(): Promise<ResourceState> {
    this.calls.push('read');
    return Promise.resolve(this.live);
  }
  create(): Promise<string> {
    this.calls.push('create');
    return Promise.resolve('arn:aws:fake:::widget/new');
  }
  update(): Promise<void> {
    this.calls.push('update');
    return Promise.resolve();
  }
  delete(): Promise<void> {
    this.calls.push('delete');
    return Promise.resolve();
  }
}

function widgetExecutor(handler: FakeWidgetHandler): AwsExecutor {
  return new AwsExecutor({ region: 'us-east-1', handlers: [handler] });
}

const widgetPlan = (attrs: Record<string, string>) =>
  providerPlan([planResource('widget', 'aws:fake:Widget', attrs)]);

const managedLive = (projection: Record<string, string>): ResourceState => ({
  exists: true,
  managed: true,
  tags: { 'iap:managed': 'true' },
  identifier: 'arn:aws:fake:::widget/old',
  projection,
});

describe('classification: immutable drift → replace', () => {
  it('drift on an immutable projection key plans replace, with an honest reason', async () => {
    const handler = new FakeWidgetHandler();
    handler.live = managedLive({ shape: 'round', color: 'red' });
    const report = await widgetExecutor(handler).plan(widgetPlan({ shape: 'square', color: 'red' }));

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.reason).toContain('immutable attribute drifted');
    expect(report.items[0]?.reason).toContain('delete+create');
  });

  it('drift on a mutable key only still plans update (regression)', async () => {
    const handler = new FakeWidgetHandler();
    handler.live = managedLive({ shape: 'round', color: 'red' });
    const report = await widgetExecutor(handler).plan(widgetPlan({ shape: 'round', color: 'blue' }));

    expect(report.items[0]?.action).toBe('update');
  });

  it('no drift still plans no-op', async () => {
    const handler = new FakeWidgetHandler();
    handler.live = managedLive({ shape: 'round', color: 'red' });
    const report = await widgetExecutor(handler).plan(widgetPlan({ shape: 'round', color: 'red' }));

    expect(report.items[0]?.action).toBe('no-op');
  });
});

describe('the replacement gate', () => {
  it('apply: true WITHOUT replace: true refuses — no delete, no create, recorded error', async () => {
    const handler = new FakeWidgetHandler();
    handler.live = managedLive({ shape: 'round', color: 'red' });
    const report = await widgetExecutor(handler).apply(widgetPlan({ shape: 'square', color: 'red' }), {
      apply: true,
    });

    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('refusing to replace');
    expect(report.errors).toHaveLength(1);
    expect(handler.calls).not.toContain('delete');
    expect(handler.calls).not.toContain('create');
  });

  it('apply: true + replace: true on a managed resource executes delete THEN create', async () => {
    const handler = new FakeWidgetHandler();
    handler.live = managedLive({ shape: 'round', color: 'red' });
    const report = await widgetExecutor(handler).apply(widgetPlan({ shape: 'square', color: 'red' }), {
      apply: true,
      replace: true,
    });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe('arn:aws:fake:::widget/new');
    expect(report.errors).toHaveLength(0);
    const mutations = handler.calls.filter((c) => c !== 'read');
    expect(mutations).toEqual(['delete', 'create']);
  });

  it('refuses to replace an unmanaged resource even with the gate open', async () => {
    const handler = new FakeWidgetHandler();
    handler.live = { ...managedLive({ shape: 'round', color: 'red' }), managed: false, tags: {} };
    const report = await widgetExecutor(handler).apply(widgetPlan({ shape: 'square', color: 'red' }), {
      apply: true,
      replace: true,
    });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only replace');
    expect(handler.calls).not.toContain('delete');
  });

  it('with the LIVE gate closed, a replace classification stays a dry run', async () => {
    const handler = new FakeWidgetHandler();
    handler.live = managedLive({ shape: 'round', color: 'red' });
    const report = await widgetExecutor(handler).apply(widgetPlan({ shape: 'square', color: 'red' }), {
      replace: true,
    });

    expect(report.mode).toBe('dry-run');
    expect(report.items[0]?.action).toBe('replace');
    expect(report.items[0]?.applied).toBe(false);
    expect(handler.calls.filter((c) => c !== 'read')).toHaveLength(0);
  });
});

describe('real handler: SQS FifoQueue is immutable', () => {
  const sqs = mockClient(SQSClient);
  beforeEach(() => sqs.reset());

  it('standard → fifo drift plans replace, not update', async () => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: 'https://sqs/q/jobs.fifo' });
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: {} }); // live: standard queue
    sqs.on(ListQueueTagsCommand).resolves({ Tags: { 'iap:managed': 'true' } });

    const plan = providerPlan([planResource('jobs', 'aws:sqs:Queue', { fifoQueue: true })]);
    const report = await new AwsExecutor({ region: 'us-east-1' }).plan(plan);

    expect(report.items[0]?.action).toBe('replace');
  });
});

describe('derived registry (ADR-0004)', () => {
  it('SUPPORTED_TARGET_TYPES is derived from registrations, never hand-maintained', () => {
    expect([...SUPPORTED_TARGET_TYPES].sort()).toEqual(
      HANDLER_REGISTRATIONS.map((r) => r.targetType).sort(),
    );
    for (const golden of ['aws:s3:Bucket', 'aws:sqs:Queue', 'aws:iam:Role']) {
      expect(isSupportedTargetType(golden)).toBe(true);
    }
    expect(isSupportedTargetType('aws:eks:Cluster')).toBe(false); // arrives M24.3 (deferred)
  });

  it('duplicate targetType registrations fail fast at registry build', () => {
    const reg = {
      targetType: 'aws:fake:Widget',
      create: () => new FakeWidgetHandler(),
    };
    expect(() => buildHandlerRegistry([reg, reg])).toThrow('duplicate handler registration');
  });
});

describe('lazy client bundle (ADR-0004)', () => {
  it('constructs a client on first access and caches it', () => {
    const bundle = createClientBundle({ region: 'us-east-1' });
    const first = bundle.sqs;
    expect(first).toBeInstanceOf(SQSClient);
    expect(bundle.sqs).toBe(first);
  });

  it('an injected override is returned as-is, nothing constructed for that service', () => {
    const fake = { fake: true } as unknown as SQSClient;
    const bundle = createClientBundle({ region: 'us-east-1' }, { sqs: fake });
    expect(bundle.sqs).toBe(fake);
  });
});
