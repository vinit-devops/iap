/**
 * `@iap/mcp` — the MCP and authoritative-knowledge framework (spec ch. 20,
 * IEP-0013). Pins trust classification, snapshot provenance + content
 * addressing, staleness, the pinned-retrieval / explicit-refresh discipline
 * (§20.1), graceful degradation (§20.3), and the authoring integration: a
 * grounded MCP recommendation is accepted only with its snapshot citations
 * (TB-3), and becomes explicit intent through the operation gate.
 */
import { describe, expect, it } from 'vitest';
import {
  KnowledgeClient,
  SourceRegistry,
  addDays,
  citation,
  createSnapshot,
  fixtureSource,
  groundRecommendation,
  isStale,
  unavailableSource,
} from '../src/index';
import { acceptRecommendations } from '@iap/intent-compiler';
import type { OperationEnvelope } from '@iap/intent-compiler';

const T0 = '2026-07-01T00:00:00Z';

function registry(): SourceRegistry {
  return new SourceRegistry()
    .register(
      fixtureSource('aws-docs', 'provider-documentation', 'authoritative', {
        'gateway tls': {
          version: '2026-06-01',
          excerpt: 'Gateways should require TLS 1.3.',
          confidence: 0.9,
          ttlDays: 30,
        },
      }),
    )
    .register(
      fixtureSource('org-standards', 'enterprise', 'internal', {
        'gateway tls': {
          version: 'v4',
          excerpt: 'Company standard: TLS 1.3 minimum.',
          confidence: 1,
          ttlDays: 7,
        },
      }),
    );
}

describe('source registry and trust classification (§20.2)', () => {
  it('registers sources, rejects duplicates, and filters by category', () => {
    const reg = registry();
    expect(reg.all().map((s) => s.id)).toEqual(['aws-docs', 'org-standards']);
    expect(reg.byCategory('enterprise').map((s) => s.id)).toEqual(['org-standards']);
    expect(reg.get('aws-docs')?.trust).toBe('authoritative');
    expect(() => reg.register(fixtureSource('aws-docs', 'pricing', 'community', {}))).toThrow();
  });
});

describe('snapshots: provenance, content address, staleness (§20.3)', () => {
  it('createSnapshot records the full citation and a content-addressed id', () => {
    const source = registry().get('aws-docs')!;
    const snap = createSnapshot(
      source,
      'gateway tls',
      source.retrieve('gateway tls', { retrievedAt: T0 })!,
      T0,
    );
    expect(snap.id).toMatch(/^snap:[0-9a-f]{64}$/);
    expect(snap).toMatchObject({
      sourceId: 'aws-docs',
      trust: 'authoritative',
      version: '2026-06-01',
      retrievedAt: T0,
      accepted: false,
    });
    expect(snap.expiresAt).toBe(addDays(T0, 30));
    expect(citation(snap)).toContain('aws-docs');
  });

  it('the content address changes with the knowledge and is stable otherwise', () => {
    const source = registry().get('aws-docs')!;
    const a = createSnapshot(
      source,
      'q',
      { version: '1', excerpt: 'x', confidence: 1, ttlDays: 1 },
      T0,
    );
    const b = createSnapshot(
      source,
      'q',
      { version: '1', excerpt: 'x', confidence: 1, ttlDays: 1 },
      T0,
    );
    const c = createSnapshot(
      source,
      'q',
      { version: '2', excerpt: 'x', confidence: 1, ttlDays: 1 },
      T0,
    );
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it('isStale is false before expiry and true after', () => {
    const source = registry().get('org-standards')!;
    const snap = createSnapshot(
      source,
      'gateway tls',
      source.retrieve('gateway tls', { retrievedAt: T0 })!,
      T0,
    ); // ttl 7d
    expect(isStale(snap, addDays(T0, 3))).toBe(false);
    expect(isStale(snap, addDays(T0, 10))).toBe(true);
  });
});

describe('the client: pinned retrieval, refresh, graceful degradation (§20.1/§20.3)', () => {
  it('retrieves snapshots from every source and pins them', () => {
    const client = new KnowledgeClient(registry());
    const outcome = client.retrieve('gateway tls', { retrievedAt: T0 });
    expect(outcome.available).toBe(true);
    expect(outcome.snapshots).toHaveLength(2);
    expect(client.pinned()).toHaveLength(2);
  });

  it('a second retrieval returns the pinned snapshots (reproducible; no live call)', () => {
    const client = new KnowledgeClient(registry());
    const first = client.retrieve('gateway tls', { retrievedAt: T0 });
    // A later wall-clock does not change the pinned snapshots without refresh.
    const second = client.retrieve('gateway tls', { retrievedAt: addDays(T0, 5) });
    expect(second.snapshots.map((s) => s.retrievedAt)).toEqual(
      first.snapshots.map((s) => s.retrievedAt),
    );
  });

  it('refresh re-retrieves and updates the pins', () => {
    const client = new KnowledgeClient(registry());
    client.retrieve('gateway tls', { retrievedAt: T0 });
    const refreshed = client.retrieve('gateway tls', {
      retrievedAt: addDays(T0, 5),
      refresh: true,
    });
    expect(refreshed.snapshots.every((s) => s.retrievedAt === addDays(T0, 5))).toBe(true);
  });

  it('unavailable sources degrade gracefully — reported, never thrown', () => {
    const reg = registry().register(
      unavailableSource('down', 'security-advisory', 'authoritative'),
    );
    const client = new KnowledgeClient(reg);
    const outcome = client.retrieve('gateway tls', { retrievedAt: T0 });
    expect(outcome.available).toBe(true); // the two fixtures still answered
    expect(outcome.unavailableSources).toContain('down');

    // A query nothing answers is available:false, not an error.
    const miss = client.retrieve('nonexistent query', { retrievedAt: T0 });
    expect(miss.available).toBe(false);
    expect(miss.snapshots).toEqual([]);
  });
});

describe('authoring integration: grounded, cited recommendations (§20.2.3, TB-3)', () => {
  const op: OperationEnvelope = {
    operationId: 'op-set-tls',
    type: 'UpdateResource',
    target: { resourceId: 'edge' },
    change: { set: { 'spec.tls.minimumVersion': '1.3' } },
    confidence: 0.95,
    assumptions: [],
    requiredClarifications: [],
    provenance: { source: 'accepted-recommendation', channel: 'api' },
  } as unknown as OperationEnvelope;

  it('groundRecommendation stamps origin mcp and the snapshot ids; refuses with none', () => {
    const client = new KnowledgeClient(registry());
    const snaps = client.retrieve('gateway tls', { retrievedAt: T0 }).snapshots;
    const rec = groundRecommendation(
      {
        id: 'rec-tls',
        title: 'Require TLS 1.3',
        rationale: 'per authoritative guidance',
        operations: [op],
      },
      snaps,
    );
    expect(rec.origin).toBe('mcp');
    expect(rec.knowledgeSnapshotIds).toEqual(snaps.map((s) => s.id));
    expect(() =>
      groundRecommendation({ id: 'x', title: 't', rationale: 'r', operations: [op] }, []),
    ).toThrow(/TB-3/);
  });

  it('an accepted grounded recommendation passes the TB-3 citation gate', () => {
    const client = new KnowledgeClient(registry());
    const snaps = client.retrieve('gateway tls', { retrievedAt: T0 }).snapshots;
    const rec = groundRecommendation(
      { id: 'rec-tls', title: 'Require TLS 1.3', rationale: 'guidance', operations: [op] },
      snaps,
    );
    // acceptRecommendations validates TB-3 (non-empty snapshot ids) before building the batch.
    const accepted = acceptRecommendations(null, [rec], { actor: 'reviewer', timestamp: T0 });
    expect(accepted.batch.operations.map((o) => o.operationId)).toContain('op-set-tls');
  });
});
