/**
 * M3.3 recommendation seam: deterministic suggestions are OFFERED, and only
 * accepted recommendations enter operations — with provenance source
 * accepted-recommendation, a confirmation on the same channel, and the
 * IEP-0013 knowledge-snapshot citation obligation for MCP-sourced
 * recommendations (modeled now; real MCP arrives Phase 12).
 */
import { describe, expect, it } from 'vitest';
import { acceptRecommendations, apply, recommend, RECOMMENDATION_RULES } from '../src/index';
import type { Recommendation } from '../src/index';
import { fixtureDocument } from './helpers';

const ACCEPTANCE = { actor: 'reviewer@example.com', timestamp: '2026-07-11T12:00:00Z' };

describe('deterministic recommendation rules', () => {
  it('the rule set is closed', () => {
    expect(RECOMMENDATION_RULES).toEqual(['explicit-backup-for-stateful', 'gateway-tls-minimum']);
  });

  it('an ObjectStore without required backups gets the backup recommendation', () => {
    const recommendations = recommend(fixtureDocument());
    const backup = recommendations.find((entry) => entry.id === 'rec-backup-notes');
    expect(backup).toMatchObject({
      rule: 'explicit-backup-for-stateful',
      origin: 'deterministic-rule',
    });
    expect(backup?.operations[0]).toMatchObject({
      type: 'UpdateResource',
      target: { resourceId: 'notes' },
      change: { set: { 'spec.resilience.backup': 'required' } },
      provenance: { source: 'accepted-recommendation', channel: 'api' },
    });
  });

  it('a Database that explicitly disables backups is flagged; the normative default is not', () => {
    const document = fixtureDocument();
    const spec = (document.resources['orders-db'] as { spec: Record<string, unknown> }).spec;
    // Default (absent resilience) is already `required` — no recommendation.
    expect(recommend(document).some((entry) => entry.id === 'rec-backup-orders-db')).toBe(false);
    spec.resilience = { backup: 'none' };
    expect(recommend(document).some((entry) => entry.id === 'rec-backup-orders-db')).toBe(true);
  });

  it('a Gateway below TLS 1.3 gets the TLS recommendation; one at 1.3 does not', () => {
    const document = fixtureDocument();
    (document.resources as Record<string, unknown>)['edge'] = { kind: 'Gateway', spec: {} };
    expect(recommend(document).some((entry) => entry.id === 'rec-tls-edge')).toBe(true);
    (document.resources as Record<string, { spec: Record<string, unknown> }>)['edge'].spec = {
      tls: { minimumVersion: '1.3' },
    };
    expect(recommend(document).some((entry) => entry.id === 'rec-tls-edge')).toBe(false);
  });

  it('recommendations are deterministic and sorted by resource', () => {
    const first = recommend(fixtureDocument());
    const second = recommend(fixtureDocument());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('acceptance: the only path from recommendation to operations (IEP-0013)', () => {
  it('accepted operations enter the batch with accepted-recommendation provenance and confirmations', async () => {
    const document = fixtureDocument();
    const recommendations = recommend(document);
    const { batch, confirmations } = acceptRecommendations(null, recommendations, ACCEPTANCE);
    expect(batch.operations.length).toBeGreaterThan(0);
    for (const op of batch.operations) {
      expect(op.provenance.source).toBe('accepted-recommendation');
    }
    expect(confirmations).toHaveLength(batch.operations.length);
    for (const record of confirmations) {
      expect(record.channel).toBe('accepted-recommendation');
      expect(record.actor).toBe(ACCEPTANCE.actor);
    }

    const outcome = await apply(document, batch, { confirmations });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok) {
      const record = outcome.result.provenance.find(
        (entry) => entry.path === 'resources.notes.spec.resilience.backup',
      );
      expect(record?.source).toBe('accepted-recommendation');
      expect(outcome.result.logEntries[0]?.confirmation?.channel).toBe('accepted-recommendation');
    }
  });

  it('unaccepted recommendations never touch a batch (recommend returns data only)', () => {
    const document = fixtureDocument();
    const before = JSON.stringify(document);
    recommend(document);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('an MCP-sourced recommendation without a knowledge snapshot citation fails closed (TB-3)', () => {
    const mcp: Recommendation = {
      id: 'rec-mcp-1',
      rule: 'vendor-docs-suggestion',
      title: 'x',
      rationale: 'x',
      origin: 'mcp',
      operations: [],
    };
    expect(() => acceptRecommendations(null, [mcp], ACCEPTANCE)).toThrow(/knowledge snapshot/);
    mcp.knowledgeSnapshotIds = [];
    expect(() => acceptRecommendations(null, [mcp], ACCEPTANCE)).toThrow(TypeError);
    mcp.knowledgeSnapshotIds = ['ks-2026-07-10-0042'];
    expect(() => acceptRecommendations(null, [mcp], ACCEPTANCE)).not.toThrow();
  });

  it('acceptance requires a real identity with an injected timestamp', () => {
    expect(() =>
      acceptRecommendations(null, recommend(fixtureDocument()), { actor: '', timestamp: 'x' }),
    ).toThrow(TypeError);
  });

  it('operation-id collisions with the existing batch resolve deterministically', () => {
    const recommendations = recommend(fixtureDocument());
    const once = acceptRecommendations(null, recommendations, ACCEPTANCE);
    const twice = acceptRecommendations(once.batch, recommendations, ACCEPTANCE);
    const ids = twice.batch.operations.map((op) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('op-rec-backup-notes');
    expect(ids).toContain('op-rec-backup-notes-2');
  });
});
