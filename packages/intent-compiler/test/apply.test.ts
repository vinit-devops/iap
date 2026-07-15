import { describe, expect, it } from 'vitest';
import type { IaPDocument, Policy } from '@iap/model';
import { apply, emptyDocument } from '../src/index';
import { batch, confirm, fixtureDocument, op } from './helpers';

async function committed(document: IaPDocument, ...args: Parameters<typeof batch>) {
  const outcome = await apply(document, batch(...args));
  expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.result;
}

describe('happy path: a valid document built from an empty skeleton', () => {
  it('creates resources, an edge, a profile, a policy, metadata, and extension values', async () => {
    const base = emptyDocument('storefront');
    const outcome = await apply(
      base,
      batch(
        op(
          'op-web',
          'CreateResource',
          { resourceId: 'web' },
          {
            kind: 'Service',
            spec: {
              artifact: { type: 'container-image', reference: 'registry.example.com/web:1.4.2' },
              exposure: 'internal',
            },
          },
        ),
        op(
          'op-edge',
          'CreateResource',
          { resourceId: 'edge' },
          {
            kind: 'Gateway',
            spec: { domains: ['shop.example.com'] },
          },
        ),
        op(
          'op-route',
          'CreateRelationship',
          { resourceId: 'edge' },
          {
            type: 'routesTo',
            target: 'web',
            protocol: 'https',
          },
        ),
        op('op-meta', 'SetMetadata', {}, { set: { owner: 'team-web' } }),
        op(
          'op-profile',
          'ApplyProfile',
          { profile: 'production' },
          {
            overrides: { resources: { web: { spec: { availability: 'high' } } } },
          },
        ),
        op(
          'op-policy',
          'AddPolicy',
          { policyId: 'no-public-web' },
          {
            // deny describes the FORBIDDEN state (ch. 7 §7.5).
            target: { kinds: ['Service'] },
            rule: { field: 'spec.exposure', operator: 'equals', value: 'public' },
            effect: 'deny',
          },
        ),
        op('op-ext', 'SetExtensionValue', { namespace: 'aws' }, { set: { version: '1.4.0' } }),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { result } = outcome;
    expect(result.document.resources.web?.kind).toBe('Service');
    expect(result.document.metadata.owner).toBe('team-web');
    expect(result.document.profiles?.production).toBeDefined();
    expect(result.document.policies?.[0]?.id).toBe('no-public-web');
    expect(result.document.extensions?.aws).toEqual({ version: '1.4.0' });
    expect(result.previewDiff.adds).toContain('resources.web');
    expect(result.previewDiff.adds).toContain('resources.edge');
    expect(result.previewDiff.destructive).toBe(false);
    expect(result.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.logEntries).toHaveLength(7);
    expect(result.logEntries.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // The round-trip serialization re-loads to the same document shape.
    expect(result.serialize('yaml')).toContain('routesTo');
    expect(JSON.parse(result.serialize('canonical-json'))).toHaveProperty('edges');
    // The base skeleton was never mutated (copy-on-write).
    expect(base).toEqual(emptyDocument('storefront'));
  });
});

describe('each operation type applies correctly', () => {
  it('UpdateResource: explicit set and unset on the entry', async () => {
    const result = await committed(
      fixtureDocument(),
      op(
        'op-1',
        'UpdateResource',
        { resourceId: 'orders-db' },
        {
          set: { 'spec.availability': 'high', description: 'Primary store' },
          unset: ['spec.capacity'],
        },
      ),
    );
    const entry = result.document.resources['orders-db'];
    expect(entry?.spec?.availability).toBe('high');
    expect(entry?.description).toBe('Primary store');
    expect(entry?.spec?.capacity).toBeUndefined();
    expect(result.previewDiff.changes).toContain('resources.orders-db.spec.availability');
  });

  it('UpdateResource: unset of an absent path is an idempotent no-op', async () => {
    const result = await committed(
      fixtureDocument(),
      op('op-1', 'UpdateResource', { resourceId: 'orders-db' }, { unset: ['spec.observability'] }),
    );
    expect(result.previewDiff.removes).toEqual([]);
  });

  it('RemoveResource: removes a stateless entry without acknowledgment', async () => {
    // web declares only outgoing edges, so its removal dangles nothing.
    const result = await committed(
      fixtureDocument(),
      op('op-1', 'RemoveResource', { resourceId: 'web' }),
    );
    expect(result.document.resources.web).toBeUndefined();
    expect(result.previewDiff.removes).toContain('resources.web');
    expect(result.previewDiff.destructive).toBe(false);
  });

  it('CreateRelationship: appends an ordered edge', async () => {
    const result = await committed(
      fixtureDocument(),
      op(
        'op-1',
        'CreateRelationship',
        { resourceId: 'web' },
        {
          target: 'notes',
          access: 'read-write',
          type: 'storesDataIn',
        },
      ),
    );
    const edges = result.document.resources.web?.relationships ?? [];
    expect(edges).toHaveLength(2);
    // Member order is normalized (type, target, attributes) regardless of proposal key order.
    expect(Object.keys(edges[1] as object)).toEqual(['type', 'target', 'access']);
  });

  it('UpdateRelationship: set/unset on the (verb, target)-addressed edge', async () => {
    const result = await committed(
      fixtureDocument(),
      op(
        'op-1',
        'UpdateRelationship',
        { resourceId: 'web', relationship: { type: 'connectsTo', target: 'orders-db' } },
        { set: { port: 5433 }, unset: ['access'] },
      ),
    );
    const edge = result.document.resources.web?.relationships?.[0];
    expect(edge?.port).toBe(5433);
    expect(edge?.access).toBeUndefined();
  });

  it('RemoveRelationship: removes the edge and drops an emptied array', async () => {
    const result = await committed(
      fixtureDocument(),
      op('op-1', 'RemoveRelationship', {
        resourceId: 'web',
        relationship: { type: 'connectsTo', target: 'orders-db' },
      }),
    );
    expect(result.document.resources.web?.relationships).toBeUndefined();
  });

  it('ApplyProfile: upserts the complete definition; RemoveProfile removes it', async () => {
    const result = await committed(
      fixtureDocument(),
      op(
        'op-1',
        'ApplyProfile',
        { profile: 'production' },
        {
          description: 'Replaced wholesale',
          overrides: { resources: { web: { spec: { size: 'l' } } } },
        },
      ),
      op(
        'op-2',
        'ApplyProfile',
        { profile: 'staging' },
        {
          overrides: { resources: { web: { spec: { size: 'xs' } } } },
        },
      ),
      op('op-3', 'RemoveProfile', { profile: 'staging' }),
    );
    expect(result.document.profiles?.production).toEqual({
      description: 'Replaced wholesale',
      overrides: { resources: { web: { spec: { size: 'l' } } } },
    });
    expect(result.document.profiles?.staging).toBeUndefined();
  });

  it('AddPolicy: appends with the id from the target; ChangeConstraint edits it', async () => {
    const result = await committed(
      fixtureDocument(),
      op(
        'op-1',
        'AddPolicy',
        { policyId: 'backup-required' },
        {
          target: { kinds: ['Database'] },
          rule: { field: 'spec.resilience.backup', operator: 'equals', value: 'required' },
          effect: 'warn',
        },
      ),
      op(
        'op-2',
        'ChangeConstraint',
        { policyId: 'backup-required' },
        {
          set: { effect: 'require', description: 'Escalated' },
        },
      ),
      op(
        'op-3',
        'ChangeConstraint',
        { policyId: 'encryption-at-rest' },
        {
          unset: ['description'],
        },
      ),
    );
    const added = result.document.policies?.find(
      (policy: Policy) => policy.id === 'backup-required',
    );
    expect(added?.effect).toBe('require');
    expect(added?.description).toBe('Escalated');
    expect(Object.keys(added as object)[0]).toBe('id');
  });

  it('SetMetadata: set/unset relative to the metadata block', async () => {
    const result = await committed(
      fixtureDocument(),
      op(
        'op-1',
        'SetMetadata',
        {},
        {
          set: { 'annotations.reviewedBy': 'alice', description: 'Fixture system' },
          unset: ['owner'],
        },
      ),
    );
    expect(result.document.metadata.annotations?.reviewedBy).toBe('alice');
    expect(result.document.metadata.description).toBe('Fixture system');
    expect(result.document.metadata.owner).toBeUndefined();
  });

  it('SetExtensionValue: document-level registration and resource-level refinement', async () => {
    const result = await committed(
      fixtureDocument(),
      op('op-1', 'SetExtensionValue', { namespace: 'aws' }, { set: { version: '1.4.0' } }),
      op(
        'op-2',
        'SetExtensionValue',
        { namespace: 'aws', resourceId: 'orders-db' },
        {
          set: { 'database.instanceFamily': 'memory-optimized' },
        },
      ),
    );
    expect(result.document.extensions?.aws).toEqual({ version: '1.4.0' });
    expect(result.document.resources['orders-db']?.extensions?.aws).toEqual({
      database: { instanceFamily: 'memory-optimized' },
    });
    // Unregistered namespaces warn (IAP802) and never fail (ch. 11 §11.4).
    expect(result.findings.some((finding) => finding.code === 'IAP802')).toBe(true);
    expect(result.findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('set creates missing intermediate containers, arrays included', async () => {
    const result = await committed(
      fixtureDocument(),
      op(
        'op-1',
        'UpdateResource',
        { resourceId: 'web' },
        {
          set: {
            'spec.ports.0.port': 8080,
            'spec.ports.0.name': 'http',
            'spec.ports.0.protocol': 'http',
          },
        },
      ),
    );
    expect(result.document.resources.web?.spec?.ports).toEqual([
      { port: 8080, name: 'http', protocol: 'http' },
    ]);
  });
});

describe('atomicity (IEP-0009 rule 1)', () => {
  it('a failing later operation aborts the whole batch and leaves the document untouched', async () => {
    const base = fixtureDocument();
    const snapshot = structuredClone(base);
    const outcome = await apply(
      base,
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
        op('op-2', 'UpdateResource', { resourceId: 'missing' }, { set: { description: 'x' } }),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0]?.code).toBe('dangling-target');
    expect(base).toEqual(snapshot);
  });

  it('a dry-run validation failure also aborts atomically', async () => {
    const base = fixtureDocument();
    const snapshot = structuredClone(base);
    const outcome = await apply(
      base,
      batch(
        op(
          'op-1',
          'CreateResource',
          { resourceId: 'cache' },
          {
            kind: 'Cache',
            spec: { engine: 'redis-compatible', bogus: true },
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(base).toEqual(snapshot);
  });
});

describe('determinism', () => {
  it('the same batch against the same document yields identical bytes and hash', async () => {
    const operations = () =>
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
        op('op-2', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.size': 'l' } }),
      );
    const first = await apply(fixtureDocument(), operations());
    const second = await apply(fixtureDocument(), operations());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.serialize('yaml')).toBe(second.result.serialize('yaml'));
    expect(first.result.serialize('canonical-json')).toBe(
      second.result.serialize('canonical-json'),
    );
    expect(first.result.canonicalHash).toBe(second.result.canonicalHash);
  });

  it('validation is profile-relative when requested', async () => {
    // The production profile raises availability; the dry run and hash follow it.
    const base = await apply(
      fixtureDocument(),
      batch(op('op-1', 'SetMetadata', {}, { set: { description: 'profiled' } })),
      { profile: 'production' },
    );
    const unprofiled = await apply(
      fixtureDocument(),
      batch(op('op-1', 'SetMetadata', {}, { set: { description: 'profiled' } })),
    );
    expect(base.ok && unprofiled.ok).toBe(true);
    if (!base.ok || !unprofiled.ok) return;
    expect(base.result.canonicalHash).not.toBe(unprofiled.result.canonicalHash);
  });

  it('sub-threshold confirmed commits record the confirmation in the log', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'web' },
          { set: { 'spec.size': 'l' } },
          {
            confidence: 0.5,
          },
        ),
      ),
      { confirmations: [confirm('op-1')] },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.logEntries[0]?.confirmation).toEqual(confirm('op-1'));
  });
});
