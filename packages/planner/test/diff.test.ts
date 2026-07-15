import { describe, expect, it } from 'vitest';
import { diffAttributes, diffResources, isEmptyDiff } from '../src/index';
import { stateFromPlan, syntheticPlan } from './helpers';

describe('diffAttributes', () => {
  it('classifies added, removed, and changed paths, sorted', () => {
    const diff = diffAttributes(
      { b: 1, a: 'x', d: true, e: 'same' },
      { a: 'y', c: 2, d: true, e: 'same' },
    );
    expect(diff).toEqual({ added: ['b'], removed: ['c'], changed: ['a'] });
  });

  it('reports no differences for canonically equal maps', () => {
    const diff = diffAttributes({ a: 1, b: 'x' }, { b: 'x', a: 1 });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it('distinguishes a number from its string spelling (exact canonical equality)', () => {
    expect(diffAttributes({ v: 2 }, { v: '2' }).changed).toEqual(['v']);
    expect(diffAttributes({ v: false }, { v: true }).changed).toEqual(['v']);
  });
});

describe('diffResources', () => {
  const desired = syntheticPlan([
    { logicalId: 'a.mock:test:Thing', desiredAttributes: { size: 1 } },
    { logicalId: 'b.mock:test:Thing', desiredAttributes: { size: 2 } },
  ]);

  it('pairs by logical id over the union of both sides, sorted', () => {
    const state = stateFromPlan(desired, (objects) => {
      delete objects['a.mock:test:Thing'];
      objects['z.mock:test:Thing'] = { type: 'mock:test:Thing', attributes: {}, managed: true };
    });
    const entries = diffResources(desired, state);
    expect(entries.map((e) => e.logicalId)).toEqual([
      'a.mock:test:Thing',
      'b.mock:test:Thing',
      'z.mock:test:Thing',
    ]);
    expect(entries[0]?.actual).toBeNull(); // desired-only
    expect(entries[2]?.desired).toBeNull(); // state-only
  });

  it('flags a provider-type mismatch at the same logical id', () => {
    const state = stateFromPlan(desired, (objects) => {
      (objects['a.mock:test:Thing'] as { type: string }).type = 'mock:test:Other';
    });
    const entry = diffResources(desired, state).find((e) => e.logicalId === 'a.mock:test:Thing');
    expect(entry?.typeChanged).toBe(true);
  });

  it('computes per-attribute diffs against state objects', () => {
    const state = stateFromPlan(desired, (objects) => {
      (objects['b.mock:test:Thing'] as { attributes: Record<string, number> }).attributes = {
        size: 9,
        stale: 1,
      };
    });
    const entry = diffResources(desired, state).find((e) => e.logicalId === 'b.mock:test:Thing');
    expect(entry?.attributes).toEqual({ added: [], removed: ['stale'], changed: ['size'] });
  });
});
