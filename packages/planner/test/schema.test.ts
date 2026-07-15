import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createValidator } from '@iap/parser';
import { emptySnapshot, plan, planSchema, validatePlanArtifact } from '../src/index';
import type { PlanArtifact } from '../src/index';
import { repoRoot, webshopPlan } from './helpers';

const specCopy = () =>
  readFileSync(join(repoRoot, 'spec', 'schema', 'plan-v1.schema.json'), 'utf8');
const embeddedCopy = () =>
  readFileSync(join(__dirname, '..', 'schemas', 'plan-v1.schema.json'), 'utf8');

describe('schema drift guard (ADR-0002)', () => {
  it('embedded plan-v1.schema.json is byte-identical to spec/schema', () => {
    expect(embeddedCopy()).toBe(specCopy());
  });
});

describe('schema quality', () => {
  it('compiles under ajv 2020-12 strict mode with the x-iap vocabulary', () => {
    expect(() => createValidator(planSchema())).not.toThrow();
  });

  it('describes every declared property', () => {
    const undescribed: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}/${index}`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (typeof record.properties === 'object' && record.properties !== null) {
        for (const [name, child] of Object.entries(record.properties)) {
          if (
            typeof child === 'object' &&
            child !== null &&
            typeof (child as Record<string, unknown>).description !== 'string'
          ) {
            undescribed.push(`${path}/properties/${name}`);
          }
        }
      }
      for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`);
    };
    walk(planSchema(), '#');
    expect(undescribed).toEqual([]);
  });
});

describe('validatePlanArtifact', () => {
  const valid = (): PlanArtifact => structuredClone(plan(webshopPlan(), emptySnapshot()));

  it('accepts every plan the planner builds', () => {
    expect(validatePlanArtifact(valid()).ok).toBe(true);
  });

  it('reports instance paths on failure', () => {
    const artifact = valid() as unknown as Record<string, unknown>;
    artifact.planId = 'not-a-digest';
    const result = validatePlanArtifact(artifact);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('/planId');
  });

  const rejections: Array<[string, (artifact: Record<string, unknown>) => void]> = [
    ['a wrong apiVersion', (a) => (a.apiVersion = 'plan.iap.dev/v2')],
    [
      'a missing destructiveActions member',
      (a) => delete (a.content as Record<string, unknown>).destructiveActions,
    ],
    [
      'an undeclared content property (closed plan bytes)',
      (a) => ((a.content as Record<string, unknown>)['x-extra'] = true),
    ],
    [
      'an action outside the closed enum',
      (a) => {
        const waves = (a.content as { waves: Array<Array<{ action: string }>> }).waves;
        const entry = waves[0]?.[0];
        if (entry) entry.action = 'destroy';
      },
    ],
    [
      'a reversibility class outside the closed enum',
      (a) => {
        const waves = (a.content as { waves: Array<Array<{ reversibility: string }>> }).waves;
        const entry = waves[0]?.[0];
        if (entry) entry.reversibility = 'mostly-reversible';
      },
    ],
    [
      'a negative risk score',
      (a) => (((a.content as Record<string, unknown>).risk as { score: number }).score = -1),
    ],
    [
      'an unknownValues reason outside the closed enum',
      (a) => {
        const values = (a.content as { unknownValues: Array<{ reason: string }> }).unknownValues;
        const entry = values[0];
        if (entry) entry.reason = 'mystery';
      },
    ],
    [
      'an envelope without a signature',
      (a) =>
        (a.envelope = { createdAt: '2026-07-11T00:00:00Z', expiresAt: '2026-07-12T00:00:00Z' }),
    ],
    [
      'a non-RFC3339 envelope timestamp',
      (a) =>
        (a.envelope = {
          createdAt: 'yesterday',
          expiresAt: '2026-07-12T00:00:00Z',
          signature: { keyId: 'k', alg: 'ed25519', value: 'AAAA' },
        }),
    ],
    [
      'an inputs member missing an identity element',
      (a) =>
        delete ((a.content as Record<string, unknown>).inputs as Record<string, unknown>)
          .discoverySnapshot,
    ],
  ];

  it.each(rejections)('rejects %s', (_name, corrupt) => {
    const artifact = valid() as unknown as Record<string, unknown>;
    corrupt(artifact);
    expect(validatePlanArtifact(artifact).ok).toBe(false);
  });
});
