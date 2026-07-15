import { describe, expect, it } from 'vitest';
import { REPLACE_ELIGIBLE_PATHS, STATEFUL_KINDS, apply } from '../src/index';
import { batch, confirm, fixtureDocument, op } from './helpers';

describe('destructive flagging (design decision 8, IEP-0009 rule 5)', () => {
  it('the stateful kind set is exactly the ch. 14 §14.2 six', () => {
    expect([...STATEFUL_KINDS]).toEqual([
      'Database',
      'Volume',
      'ObjectStore',
      'Queue',
      'Topic',
      'Secret',
    ]);
  });

  it('RemoveResource on every stateful fixture kind requires acknowledgment', async () => {
    for (const resourceId of ['orders-db', 'scratch', 'jobs', 'notes']) {
      const operations = batch(op('op-1', 'RemoveResource', { resourceId }));
      // orders-db is referenced by an edge; remove the edge first so the only
      // objection left is the missing acknowledgment.
      const full =
        resourceId === 'orders-db'
          ? batch(
              op('op-0', 'RemoveRelationship', {
                resourceId: 'web',
                relationship: { type: 'connectsTo', target: 'orders-db' },
              }),
              ...operations.operations,
            )
          : operations;
      const blocked = await apply(fixtureDocument(), full, {
        confirmations: [confirm('op-1')],
      });
      expect(blocked.ok, resourceId).toBe(false);
      if (!blocked.ok) expect(blocked.refusals[0]?.code).toBe('unacknowledged-destructive');

      const acknowledged = await apply(fixtureDocument(), full, {
        confirmations: [confirm('op-1', { acknowledgeDestructive: true })],
      });
      expect(acknowledged.ok, resourceId).toBe(true);
      if (acknowledged.ok) {
        expect(acknowledged.result.previewDiff.destructive).toBe(true);
        expect(acknowledged.result.previewDiff.destructiveOperations[0]).toMatchObject({
          operationId: 'op-1',
          resourceId,
          reason: 'stateful-remove',
          paths: [],
        });
      }
    }
  });

  it('an update touching a replacement-eligible path is destructive (Database engine)', async () => {
    expect(REPLACE_ELIGIBLE_PATHS.Database).toContain('spec.engine');
    const change = batch(
      op(
        'op-1',
        'UpdateResource',
        { resourceId: 'orders-db' },
        { set: { 'spec.engine': 'mysql' } },
      ),
    );
    const blocked = await apply(fixtureDocument(), change);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.refusals[0]?.code).toBe('unacknowledged-destructive');

    const acknowledged = await apply(fixtureDocument(), change, {
      confirmations: [confirm('op-1', { acknowledgeDestructive: true })],
    });
    expect(acknowledged.ok).toBe(true);
    if (acknowledged.ok) {
      expect(acknowledged.result.previewDiff.destructiveOperations[0]).toMatchObject({
        reason: 'replace-eligible-update',
        kind: 'Database',
        paths: ['spec.engine'],
      });
    }
  });

  it('a wholesale spec set overlapping a replacement-eligible path is conservatively destructive', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'orders-db' },
          {
            set: {
              spec: { class: 'relational', engine: 'postgresql', capacity: { storage: '20Gi' } },
            },
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals[0]?.code).toBe('unacknowledged-destructive');
  });

  it('engineVersion increases are in-place; decreases are destructive (ch. 3 Database lifecycle)', async () => {
    const upgrade = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'orders-db' },
          { set: { 'spec.engineVersion': '17' } },
        ),
      ),
    );
    expect(upgrade.ok).toBe(true);
    if (upgrade.ok) expect(upgrade.result.previewDiff.destructive).toBe(false);

    const downgrade = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'orders-db' },
          { set: { 'spec.engineVersion': '15' } },
        ),
      ),
    );
    expect(downgrade.ok).toBe(false);
    if (!downgrade.ok) expect(downgrade.refusals[0]?.code).toBe('unacknowledged-destructive');
  });

  it('unsetting a directional path fails toward the destructive extreme', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'orders-db' },
          { unset: ['spec.engineVersion'] },
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals[0]?.code).toBe('unacknowledged-destructive');
  });

  it('Volume capacity increases are in-place; decreases are destructive (ch. 3 Volume lifecycle)', async () => {
    const grow = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'scratch' },
          { set: { 'spec.capacity.storage': '20Gi' } },
        ),
      ),
    );
    expect(grow.ok).toBe(true);
    if (grow.ok) expect(grow.result.previewDiff.destructive).toBe(false);

    const shrink = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'scratch' },
          { set: { 'spec.capacity.storage': '5Gi' } },
        ),
      ),
    );
    expect(shrink.ok).toBe(false);
    if (!shrink.ok) expect(shrink.refusals[0]?.code).toBe('unacknowledged-destructive');
  });

  it('non-eligible updates on stateful kinds stay non-destructive', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'orders-db' },
          {
            set: { 'spec.availability': 'high', 'spec.observability.metrics': 'required' },
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.previewDiff.destructive).toBe(false);
  });
});

describe('the preview semantic diff (iap-semantic-diff/v1)', () => {
  it('reports adds/removes/changes as document paths over the canonical projection', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'CreateResource',
          { resourceId: 'cache' },
          {
            kind: 'Cache',
            spec: { engine: 'redis-compatible' },
          },
        ),
        // web is a stateless Service, so its removal needs no acknowledgment.
        op('op-2', 'RemoveResource', { resourceId: 'web' }),
        op(
          'op-3',
          'UpdateResource',
          { resourceId: 'orders-db' },
          { set: { 'spec.availability': 'high' } },
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { previewDiff } = outcome.result;
    expect(previewDiff.format).toBe('iap-semantic-diff/v1');
    // A whole added subtree reports its root path only (IEP-0009 example shape).
    expect(previewDiff.adds).toContain('resources.cache');
    expect(previewDiff.adds.some((path) => path.startsWith('resources.cache.'))).toBe(false);
    expect(previewDiff.removes).toContain('resources.web');
    expect(previewDiff.changes).toContain('resources.orders-db.spec.availability');
    expect(previewDiff.destructive).toBe(false);
  });

  it('authoring noise never reports: a set writing the identical value diffs empty', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'orders-db' },
          {
            set: { 'spec.engineVersion': '16' },
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.previewDiff.adds).toEqual([]);
    expect(outcome.result.previewDiff.removes).toEqual([]);
    expect(outcome.result.previewDiff.changes).toEqual([]);
  });
});
