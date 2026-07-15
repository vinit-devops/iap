/**
 * `@iap/control-plane` — the enterprise control-plane core (roadmap Phase 16).
 * Pins RBAC, the separation-of-duties approval engine, multi-tenant project
 * isolation + audit, and the intent/cost/security/compliance PR checks.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from '@iap/sdk';
import type { CanonicalModel } from '@iap/model';
import { ControlPlane, approve, can, prChecks } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
async function modelOf(name: string): Promise<CanonicalModel> {
  return (await load({ path: join(repoRoot, 'spec', 'examples', name) })).canonical().model;
}
const T0 = '2026-07-11T12:00:00Z';

describe('RBAC', () => {
  it('grants actions by role', () => {
    expect(can('viewer', 'view')).toBe(true);
    expect(can('viewer', 'author')).toBe(false);
    expect(can('author', 'approve')).toBe(false);
    expect(can('approver', 'approve')).toBe(true);
    expect(can('admin', 'deploy')).toBe(true);
  });
});

describe('approval engine (separation of duties)', () => {
  const request = { changeId: 'c1', author: 'alice', summary: 'add a cache' };

  it('refuses self-approval', () => {
    const out = approve(request, { id: 'alice', role: 'approver' }, 'approved', T0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('self-approval');
  });

  it('refuses an approver without the approve role', () => {
    const out = approve(request, { id: 'bob', role: 'author' }, 'approved', T0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('insufficient-role');
  });

  it('records approval evidence for a distinct approver with the role', () => {
    const out = approve(request, { id: 'carol', role: 'approver' }, 'approved', T0);
    expect(out.ok).toBe(true);
    if (out.ok)
      expect(out.approval).toMatchObject({
        changeId: 'c1',
        approver: 'carol',
        decision: 'approved',
        timestamp: T0,
      });
  });
});

describe('multi-tenant projects + audit', () => {
  it('isolates projects by tenant and audits every decision', () => {
    const cp = new ControlPlane();
    cp.createProject({ tenant: 'acme', project: 'web' }, ['org-baseline']);
    cp.addMember({ tenant: 'acme', project: 'web' }, 'alice', 'author');

    expect(cp.authorize({ tenant: 'acme', project: 'web' }, 'alice', 'author', T0)).toBe(true);
    // Not a member's action.
    expect(cp.authorize({ tenant: 'acme', project: 'web' }, 'alice', 'deploy', T0)).toBe(false);
    // Cross-tenant isolation: a different tenant's project is unreachable.
    expect(cp.authorize({ tenant: 'other', project: 'web' }, 'alice', 'view', T0)).toBe(false);

    expect(cp.policyPacks({ tenant: 'acme', project: 'web' })).toEqual(['org-baseline']);
    const log = cp.auditLog({ tenant: 'acme', project: 'web' });
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.actor === 'alice')).toBe(true);
  });
});

describe('PR checks (intent/cost/security/compliance deltas)', () => {
  it('a no-op change passes every dimension', async () => {
    const model = await modelOf('basic-webapp.iap.yaml');
    const checks = prChecks(model, model);
    expect(checks.pass).toBe(true);
    expect(checks.intent).toMatchObject({ added: [], removed: [], changed: [] });
    expect(checks.cost.monthlyDelta).toBe(0);
  });

  it('reports the intent and cost deltas of an added resource', async () => {
    const base = await modelOf('basic-webapp.iap.yaml');
    const head = await modelOf('data-processing.iap.yaml');
    const checks = prChecks(base, head);
    expect(checks.intent.added.length).toBeGreaterThan(0);
    expect(typeof checks.cost.monthlyDelta).toBe('number');
    expect(['none', 'low', 'medium', 'high', 'critical']).toContain(checks.security.headRisk);
  });

  it('fails the security dimension when the head introduces a new error finding', async () => {
    const base = await modelOf('basic-webapp.iap.yaml');
    // Head: make a data store public (IAP601 error).
    const head = JSON.parse(JSON.stringify(base)) as CanonicalModel;
    (head.resources['assets'] as { spec: Record<string, unknown> }).spec.exposure = 'public';
    // Ensure it is a storesDataIn target so IAP601 is an error.
    head.edges.push({
      source: 'web',
      type: 'storesDataIn',
      target: 'assets',
      attributes: { access: 'read-write' },
    });
    const checks = prChecks(base, head);
    expect(checks.security.pass).toBe(false);
    expect(checks.pass).toBe(false);
    expect(checks.security.newFindings.some((f) => f.startsWith('IAP601'))).toBe(true);
  });
});
