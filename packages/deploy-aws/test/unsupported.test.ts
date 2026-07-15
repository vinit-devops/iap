import { describe, expect, it } from 'vitest';
import { AwsExecutor, UnsupportedTargetTypeError } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

describe('unsupported target type → fail-closed', () => {
  const plan = providerPlan([planResource('cluster', 'aws:ecs:Service', { desiredCount: 2 })]);

  it('plan() throws UnsupportedTargetTypeError before issuing any call', async () => {
    const executor = new AwsExecutor({ region: 'us-east-1' });
    await expect(executor.plan(plan)).rejects.toBeInstanceOf(UnsupportedTargetTypeError);
    await expect(executor.plan(plan)).rejects.toThrow('unsupported target type in v0.1 executor');
  });

  it('apply() records the failure without throwing across the boundary', async () => {
    const executor = new AwsExecutor({ region: 'us-east-1' });
    const report = await executor.apply(plan, { apply: true });

    expect(report.items).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('aws:ecs:Service');
  });
});
