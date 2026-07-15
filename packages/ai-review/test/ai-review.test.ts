/**
 * `@iap/ai-review` — the AI review engine and guardrails (spec ch. 19, roadmap
 * Phase 17). Pins explainability (every item has an explanation), source
 * citation (every item cites its basis), the advisory-only guardrail (never
 * blocking), determinism, and that the review never mutates the model.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from '@iap/sdk';
import type { CanonicalModel } from '@iap/model';
import { assertGuardrails, reviewDocument } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
async function modelOf(name: string): Promise<CanonicalModel> {
  return (await load({ path: join(repoRoot, 'spec', 'examples', name) })).canonical().model;
}

function model(
  resources: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): CanonicalModel {
  return {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 't' },
    resources,
    edges: [],
    policies: [],
    profile: null,
    hash: '0'.repeat(64),
    provenance: {},
    diagnostics: [],
    ...extra,
  } as unknown as CanonicalModel;
}

describe('review engine — explainability and citations', () => {
  it('every official example produces explainable, cited, advisory items', async () => {
    for (const name of [
      'basic-webapp.iap.yaml',
      'enterprise-pci.iap.yaml',
      'data-processing.iap.yaml',
    ]) {
      const items = reviewDocument(await modelOf(name));
      for (const item of items) {
        expect(item.severity).toBe('advisory');
        expect(item.explanation.length).toBeGreaterThan(0);
        expect(item.citations.length).toBeGreaterThan(0);
      }
      // Guardrails hold on real corpus output.
      expect(() => assertGuardrails(items)).not.toThrow();
    }
  });

  it('flags maximum availability without a backup, with a suggestion and a citation', () => {
    const m = model({
      db: {
        kind: 'Database',
        labels: {},
        spec: { availability: 'maximum', class: 'relational' },
        extensions: {},
      },
    });
    const item = reviewDocument(m).find((i) => i.rule === 'max-availability-without-backup');
    expect(item).toBeDefined();
    expect(item?.suggestion).toContain('backup');
    expect(item?.citations.length).toBeGreaterThan(0);
  });

  it('folds a security finding into an advisory review item with a citation', () => {
    const m = model({
      web: {
        kind: 'Service',
        labels: {},
        spec: { configuration: { API_TOKEN: 'ghp_012345678901234567890123456789012345' } },
        extensions: {},
      },
    });
    const item = reviewDocument(m).find((i) => i.rule === 'security:IAP602');
    expect(item).toBeDefined();
    expect(item?.citations).toContain('ch15:IAP602');
  });
});

describe('guardrails (ch. 19 / §20.2.3)', () => {
  it('rejects a non-advisory item', () => {
    expect(() =>
      assertGuardrails([
        {
          rule: 'x',
          severity: 'blocking' as never,
          resource: null,
          explanation: 'e',
          citations: ['c'],
        },
      ]),
    ).toThrow(/non-advisory/);
  });

  it('rejects an uncited item (recommendations must cite sources)', () => {
    expect(() =>
      assertGuardrails([
        { rule: 'x', severity: 'advisory', resource: null, explanation: 'e', citations: [] },
      ]),
    ).toThrow(/cites no source/);
  });

  it('extra knowledge snapshot ids are added as citations on security items', () => {
    const m = model({
      store: { kind: 'ObjectStore', labels: {}, spec: { exposure: 'public' }, extensions: {} },
    });
    const items = reviewDocument(m, { knowledgeSnapshotIds: ['snap:abc'] });
    const sec = items.find((i) => i.rule.startsWith('security:'));
    expect(sec?.citations).toContain('snap:abc');
  });
});

describe('determinism and non-mutation', () => {
  it('is deterministic and never mutates the model', async () => {
    const m = await modelOf('enterprise-pci.iap.yaml');
    const before = JSON.stringify(m);
    const a = JSON.stringify(reviewDocument(m));
    const b = JSON.stringify(reviewDocument(m));
    expect(a).toBe(b);
    expect(JSON.stringify(m)).toBe(before);
  });
});
