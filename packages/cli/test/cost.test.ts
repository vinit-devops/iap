/**
 * `iap cost` — cost estimation and budget validation at the CLI (roadmap Phase
 * 10, M10.2). Drives the command in-process, asserting the report rendering, the
 * JSON contract, budget enforcement (IAP505 → exit 1), and the cost-diff.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli';

const repoRoot = join(__dirname, '..', '..', '..');
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

const tempDirs: string[] = [];
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-cost-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const OVER_BUDGET = `apiVersion: iap.dev/v1
metadata:
  name: budgeted
resources:
  web:
    kind: Service
    spec:
      artifact: { type: container-image, reference: registry.example.com/app:1.0.0 }
      size: m
      scaling: { min: 1, max: 4 }
policies:
  - id: web-budget
    target: { kinds: [Service] }
    rule: { field: x-iap-cost.estimatedMonthly, operator: greater-than, value: 50 }
    effect: deny
    params: { maxMonthly: 50, currency: USD }
`;

describe('iap cost', () => {
  it('renders a report for an example and exits 0', async () => {
    const r = await exec(['cost', '--file', BASIC]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Cost report for "basic-webapp"');
    expect(r.stdout).toContain('reference-abstract@1.0.0');
    expect(r.stdout).toContain('TOTAL');
    expect(r.stdout).toContain('by application:');
  });

  it('emits a formatVersion:1 JSON payload with the report and budgets', async () => {
    const r = await exec(['cost', '--file', BASIC, '-o', 'json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      formatVersion: number;
      report: { reportVersion: string; currency: string; totals: { estimatedMonthly: number } };
      budgets: unknown[];
    };
    expect(payload.formatVersion).toBe(1);
    expect(payload.report.reportVersion).toBe('1');
    expect(payload.report.currency).toBe('USD');
    expect(payload.report.totals.estimatedMonthly).toBeGreaterThan(0);
    expect(payload.budgets).toEqual([]);
  });

  it('fails with IAP505 and exit 1 when a deny budget is exceeded', async () => {
    const path = tempFile('budget.iap.yaml', OVER_BUDGET);
    const r = await exec(['cost', '--file', path]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('IAP505');
    expect(r.stdout).toContain('web-budget');
  });

  it('is deterministic across runs', async () => {
    const a = await exec(['cost', '--file', BASIC, '-o', 'json']);
    const b = await exec(['cost', '--file', BASIC, '-o', 'json']);
    expect(a.stdout).toBe(b.stdout);
  });

  it('reports a cost diff against another document', async () => {
    const r = await exec(['cost', '--file', BASIC, '--against', BASIC, '-o', 'json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { diff?: { totalDelta: number } };
    expect(payload.diff).toBeDefined();
    expect(payload.diff?.totalDelta).toBe(0); // same document → no delta
  });

  it('is no longer a phase-gated stub', async () => {
    const help = await exec(['help']);
    expect(help.stdout).toContain('cost');
    // security/compliance remain gated.
    expect((await exec(['security'])).code).toBe(2);
  });
});
