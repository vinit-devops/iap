/**
 * `@iap/mcp-server` — the IaP MCP server (roadmap Phase 13, M13.2). Pins the
 * ch. 19 trust boundary (authoring/analysis only; no mutation tool exists),
 * that authoring runs through the gate and returns provenance, that analysis
 * tools reuse the reference engines, and that the server fails closed if a
 * mutation tool is ever introduced.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IAP_TOOLS, IaPMcpServer, assertReadOnly } from '../src/index';
import type { ToolDefinition } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const BASIC = readFileSync(join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml'), 'utf8');
const PCI = readFileSync(join(repoRoot, 'spec', 'examples', 'enterprise-pci.iap.yaml'), 'utf8');

describe('the trust boundary (ch. 19)', () => {
  it('exposes only authoring and analysis tools — no deployment/mutation tool exists', () => {
    const server = new IaPMcpServer();
    const tools = server.manifest().tools;
    expect(tools.every((t) => t.kind === 'authoring' || t.kind === 'analysis')).toBe(true);
    for (const forbidden of ['iap_deploy', 'iap_destroy', 'iap_apply', 'iap_rollback']) {
      expect(server.has(forbidden)).toBe(false);
    }
    expect(server.manifest().trustBoundary).toContain('cannot deploy');
  });

  it('fails closed at construction if a mutation tool is introduced', () => {
    const rogue: ToolDefinition = {
      name: 'iap_deploy',
      kind: 'authoring',
      description: 'x',
      handler: async () => null,
    };
    expect(() => new IaPMcpServer([...IAP_TOOLS, rogue])).toThrow(/forbidden mutation verb/);
    expect(() => assertReadOnly([rogue])).toThrow();
  });

  it('a non-read-only tool kind is rejected', () => {
    const bad = {
      name: 'iap_thing',
      kind: 'execution',
      description: 'x',
      handler: async () => null,
    } as unknown as ToolDefinition;
    expect(() => assertReadOnly([bad])).toThrow(/non-read-only/);
  });
});

describe('authoring tool (through the gate)', () => {
  it('iap_author commits a document and returns per-field provenance', async () => {
    const server = new IaPMcpServer();
    const res = await server.call('iap_author', {
      request: 'A web app image registry.example.com/app:1.0.0',
      timestamp: '2026-07-11T12:00:00Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as { outcome: string; document: string | null; provenance: unknown[] };
    expect(r.outcome).toBe('committed');
    expect(r.document).toContain('apiVersion: iap.dev/v1');
    expect(r.provenance.length).toBeGreaterThan(0);
  });

  it('iap_author surfaces clarifications instead of guessing', async () => {
    const server = new IaPMcpServer();
    const res = await server.call('iap_author', {
      request: 'We need a web app',
      timestamp: '2026-07-11T12:00:00Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as { outcome: string; clarifications: { id: string }[] };
    expect(r.outcome).toBe('needs-input');
    expect(r.clarifications.map((c) => c.id)).toContain('q-artifact-web');
  });
});

describe('analysis tools (same engines as the CLI)', () => {
  it('iap_validate returns findings and an ok flag', async () => {
    const res = await new IaPMcpServer().call('iap_validate', { document: BASIC });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { ok: boolean }).ok).toBe(true);
  });

  it('iap_security, iap_cost, iap_compliance run their engines', async () => {
    const server = new IaPMcpServer();
    const sec = await server.call('iap_security', { document: BASIC });
    expect(sec.ok && (sec.result as { risk: string }).risk).toBeDefined();
    const cost = await server.call('iap_cost', { document: BASIC });
    expect(cost.ok && (cost.result as { report: unknown }).report).toBeDefined();
    const comp = await server.call('iap_compliance', { document: PCI });
    expect(comp.ok && (comp.result as { frameworks: string[] }).frameworks).toContain(
      'pci-dss-4.0',
    );
  });

  it('a bad input is returned as an error, never thrown', async () => {
    const res = await new IaPMcpServer().call('iap_security', {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('document');
    expect((await new IaPMcpServer().call('iap_nonexistent', {})).ok).toBe(false);
  });
});

describe('hard rename: legacy iis_* tool names are rejected (ADR-0003, no aliases)', () => {
  it('every legacy iis_* tool name returns an unknown-tool error', async () => {
    const server = new IaPMcpServer();
    for (const legacy of [
      'iis_author',
      'iis_validate',
      'iis_cost',
      'iis_security',
      'iis_compliance',
    ]) {
      const res = await server.call(legacy, { document: BASIC });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain(`unknown tool "${legacy}"`);
    }
  });

  it('the canonical iap_* names dispatch normally', async () => {
    const server = new IaPMcpServer();
    const res = await server.call('iap_validate', { document: BASIC });
    expect(res.ok).toBe(true);
  });

  it('an entirely unknown tool name still errors as before', async () => {
    const server = new IaPMcpServer();
    for (const bogus of ['iis_bogus', 'iap_bogus']) {
      const res = await server.call(bogus, {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain(`unknown tool "${bogus}"`);
    }
  });

  it('the manifest advertises only the canonical iap_* names', () => {
    const names = new IaPMcpServer().manifest().tools.map((t) => t.name);
    expect(names).toEqual([
      'iap_author',
      'iap_compliance',
      'iap_cost',
      'iap_security',
      'iap_validate',
    ]);
    expect(names.some((n) => n.startsWith('iis_'))).toBe(false);
  });
});
