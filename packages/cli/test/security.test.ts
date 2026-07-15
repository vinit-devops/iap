/**
 * `iap security` — the security report at the CLI (roadmap Phase 11, M11.1).
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
function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-sec-'));
  tempDirs.push(dir);
  const path = join(dir, 'infra.iap.yaml');
  writeFileSync(path, content);
  return path;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const PUBLIC_DB = `apiVersion: iap.dev/v1
metadata:
  name: leaky
resources:
  web:
    kind: Service
    spec:
      artifact: { type: container-image, reference: r/x:1 }
    relationships:
      - { type: storesDataIn, target: store, access: read-write }
  store:
    kind: ObjectStore
    spec:
      exposure: public
`;

describe('iap security', () => {
  it('renders grants, reachability, and findings for an example and exits 0', async () => {
    const r = await exec(['security', '--file', BASIC]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Security report for "basic-webapp"');
    expect(r.stdout).toContain('least-privilege grants');
    expect(r.stdout).toContain('reachability');
    expect(r.stdout).toContain('risk:');
  });

  it('emits a formatVersion:1 JSON report', async () => {
    const r = await exec(['security', '--file', BASIC, '-o', 'json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      formatVersion: number;
      reportVersion: string;
      grants: unknown[];
      risk: string;
    };
    expect(payload.formatVersion).toBe(1);
    expect(payload.reportVersion).toBe('1');
    expect(Array.isArray(payload.grants)).toBe(true);
  });

  it('exits 1 with IAP601 when a data store is publicly exposed', async () => {
    const r = await exec(['security', '--file', tempFile(PUBLIC_DB)]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('IAP601');
  });

  it('is no longer a stub; compliance stays gated', async () => {
    expect((await exec(['help'])).stdout).toContain('security');
    expect((await exec(['compliance'])).code).toBe(2);
  });
});
