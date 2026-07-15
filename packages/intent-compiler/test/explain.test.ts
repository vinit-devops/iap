/**
 * M3.3 semantic diff explanation (§3.5 "Explain what changes this request
 * will make"): deterministic prose over the canonical-projection diff with
 * per-field provenance, assumption/clarification status, and destructive
 * classification. Prose, never document bytes (OP-1 untouched).
 */
import { describe, expect, it } from 'vitest';
import { explainBatch } from '../src/index';
import { batch, fixtureDocument, op } from './helpers';

describe('explainBatch', () => {
  it('renders adds, changes, and removes with values and the writing operation', () => {
    const result = explainBatch(
      fixtureDocument(),
      batch(
        op(
          'op-cache',
          'CreateResource',
          { resourceId: 'session-cache' },
          { kind: 'Cache', spec: { engine: 'redis-compatible' } },
        ),
        op('op-size', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.size': 'l' } }),
        op('op-drop', 'RemoveResource', { resourceId: 'jobs' }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('Adds:');
    expect(result.text).toContain('resources.session-cache');
    expect(result.text).toContain('op-cache (explicit-user)');
    expect(result.text).toContain('Changes:');
    expect(result.text).toContain('resources.web.spec.size: "m" -> "l"');
    expect(result.text).toContain('op-size (explicit-user)');
    expect(result.text).toContain('Removes:');
    expect(result.text).toContain('resources.jobs');
    expect(result.diff.adds).toContain('resources.session-cache');
    expect(result.provenance.some((record) => record.operationId === 'op-cache')).toBe(true);
  });

  it('is deterministic: identical inputs produce byte-identical prose', () => {
    const build = () =>
      explainBatch(
        fixtureDocument(),
        batch(op('op-1', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.size': 'xl' } })),
      );
    const first = build();
    const second = build();
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.text).toBe(second.text);
  });

  it('flags destructive operations with the acknowledgment requirement', () => {
    const result = explainBatch(
      fixtureDocument(),
      batch(op('op-1', 'RemoveResource', { resourceId: 'orders-db' })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('DESTRUCTIVE');
    expect(result.text).toContain('stateful-remove on Database "orders-db"');
    expect(result.diff.destructive).toBe(true);
  });

  it('renders assumptions and open clarifications (the OP-3 status of the proposal)', () => {
    const result = explainBatch(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'web' },
          { set: { 'spec.size': 's' } },
          {
            assumptions: [{ field: 'spec.size', assumed: 's', reason: 'cost reduction implied' }],
            requiredClarifications: [{ id: 'q-1', question: 'Reduce how far?' }],
          },
        ),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('Assumed values requiring confirmation');
    expect(result.text).toContain('spec.size = "s" (cost reduction implied)');
    expect(result.text).toContain('Open clarifications blocking commit');
    expect(result.text).toContain('q-1 (blocks op-1): Reduce how far?');
  });

  it('reports a semantic no-op honestly (writing a materialized default changes nothing)', () => {
    const result = explainBatch(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'orders-db' },
          { set: { 'spec.exposure': 'private' } },
        ),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('No semantic changes');
  });

  it("an unexplainable proposal is refused with the gate's shapes, never partially narrated", () => {
    const structural = explainBatch(fixtureDocument(), { apiVersion: 'nope' });
    expect(structural.ok).toBe(false);
    if (!structural.ok) expect(structural.refusals[0]?.code).toBe('schema-violation');
    const dangling = explainBatch(
      fixtureDocument(),
      batch(op('op-1', 'UpdateResource', { resourceId: 'ghost' }, { set: { description: 'x' } })),
    );
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) expect(dangling.refusals[0]?.code).toBe('dangling-target');
  });

  it('never mutates the input document', () => {
    const document = fixtureDocument();
    const before = JSON.stringify(document);
    explainBatch(document, batch(op('op-1', 'RemoveResource', { resourceId: 'jobs' })));
    expect(JSON.stringify(document)).toBe(before);
  });
});
