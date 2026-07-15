/**
 * `iap compliance` — the evidence report at the CLI (roadmap Phase 11, M11.2).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli';

const repoRoot = join(__dirname, '..', '..', '..');
const PCI = join(repoRoot, 'spec', 'examples', 'enterprise-pci.iap.yaml');
const BASIC = join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml');

interface Execution {
  code: number;
  stdout: string;
  stderr: string;
}
async function exec(argv: string[]): Promise<Execution> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    stdout: { write: (t: string) => void out.push(t) },
    stderr: { write: (t: string) => void err.push(t) },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

describe('iap compliance', () => {
  it('renders per-control dispositions and the certification disclaimer', async () => {
    const r = await exec(['compliance', '--file', PCI]);
    expect(r.stdout).toContain('Compliance report for');
    expect(r.stdout).toContain('pci-dss-4.0@');
    expect(r.stdout).toMatch(/satisfied|violated|not-applicable/);
    expect(r.stdout).toContain('NOT a claim of formal certification');
  });

  it('emits a formatVersion:1 JSON evidence report', async () => {
    const r = await exec(['compliance', '--file', PCI, '-o', 'json']);
    const payload = JSON.parse(r.stdout) as {
      formatVersion: number;
      reportVersion: string;
      evidence: { disposition: string }[];
      summary: { satisfied: number; violated: number; notApplicable: number };
    };
    expect(payload.formatVersion).toBe(1);
    expect(payload.reportVersion).toBe('1');
    expect(payload.evidence.length).toBeGreaterThan(0);
  });

  it('exits 1 when a control is violated (IAP701)', async () => {
    const r = await exec(['compliance', '--file', PCI]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('IAP701');
  });

  it('a document with no frameworks exits 0 with nothing to evaluate', async () => {
    const r = await exec(['compliance', '--file', BASIC]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no frameworks declared');
  });

  it('is no longer a stub', async () => {
    expect((await exec(['help'])).stdout).toContain('compliance');
  });
});
