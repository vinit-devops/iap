/**
 * `@iap/designer` — the headless visual-designer session (roadmap Phase 15).
 * Pins the architectural invariant: the canvas is a view and the IaP document
 * is the single source of truth — every edit commits through the gate, a
 * rejected edit leaves the document unchanged, the produced IaP is valid and
 * deterministic, and every field is provenance-inspectable.
 */
import { describe, expect, it } from 'vitest';
import { load, validateExtensions } from '@iap/sdk';
import type { IaPDocument } from '@iap/model';
import { DesignerSession } from '../src/index';

async function buildWebApp(): Promise<DesignerSession> {
  const s = new DesignerSession('shop');
  expect(
    (
      await s.addResource('Service', 'web', {
        artifact: { type: 'container-image', reference: 'registry.example.com/app:1.0.0' },
      })
    ).ok,
  ).toBe(true);
  expect(
    (await s.addResource('Database', 'db', { class: 'relational', engine: 'postgresql' })).ok,
  ).toBe(true);
  expect((await s.connect('web', 'db', 'connectsTo', 'read-write')).ok).toBe(true);
  return s;
}

describe('the canvas is a view; the document is the source of truth', () => {
  it('each edit commits through the gate and updates the document', async () => {
    const s = await buildWebApp();
    expect(Object.keys(s.document.resources).sort()).toEqual(['db', 'web']);
    const rel = (s.document.resources.web as { relationships?: { target: string }[] })
      .relationships;
    expect(rel?.some((r) => r.target === 'db')).toBe(true);
  });

  it('a rejected edit leaves the document unchanged (UI never a second source of truth)', async () => {
    const s = await buildWebApp();
    const before = JSON.stringify(s.document);
    const bad = await s.addResource('NotAKind' as never, 'x');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toContain('schema-violation');
    expect(JSON.stringify(s.document)).toBe(before);
  });

  it('setting a property commits a minimal update', async () => {
    const s = await buildWebApp();
    expect((await s.setProperty('web', 'spec.availability', 'high')).ok).toBe(true);
    expect((s.document.resources.web as { spec: { availability: string } }).spec.availability).toBe(
      'high',
    );
  });

  it('removing a resource commits the removal', async () => {
    const s = new DesignerSession('shop');
    await s.addResource('Service', 'web', {
      artifact: { type: 'container-image', reference: 'r/x:1' },
    });
    expect((await s.addResource('Cache', 'cache', { engine: 'redis-compatible' })).ok).toBe(true);
    expect((await s.remove('cache')).ok).toBe(true);
    expect(Object.keys(s.document.resources)).toEqual(['web']);
  });
});

describe('the produced IaP is valid, deterministic, and provenance-inspectable', () => {
  it('the designed document re-validates green end to end', async () => {
    const s = await buildWebApp();
    const ws = await load(s.yaml());
    expect(ws.ok).toBe(true);
    const findings = [
      ...ws.validate().findings,
      ...ws.policies().findings,
      ...validateExtensions(ws.document as IaPDocument),
    ];
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('the same sequence of edits produces byte-identical IaP', async () => {
    const a = await buildWebApp();
    const b = await buildWebApp();
    expect(a.yaml()).toBe(b.yaml());
  });

  it('the property inspector surfaces a resource spec and its field provenance', async () => {
    const s = await buildWebApp();
    const inspected = s.inspect('web');
    expect(inspected.kind).toBe('Service');
    expect(inspected.provenance.length).toBeGreaterThan(0);
    expect(inspected.provenance.every((p) => p.path.startsWith('resources.web'))).toBe(true);
  });
});
