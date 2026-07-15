// Hard-rename negative tests for the CLI (roadmap-v2 §5, §9, §17): the legacy
// `iis` binary, `.iis.yaml` auto-discovery, and `iis.dev/v1` documents are all
// gone — no compatibility.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli';
import { DEFAULT_FILE } from '../src/shared';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  bin?: Record<string, string>;
};

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iap-hardrename-'));
  dirs.push(d);
  return d;
}
async function exec(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await run(argv, {
    stdout: { write: (t: string) => void out.push(t) },
    stderr: { write: (t: string) => void out.push(t) },
  });
  return { code, out: out.join('') };
}

describe('CLI exposes only the canonical iap binary (no legacy iis alias)', () => {
  it('package.json bin has exactly { iap } and no iis', () => {
    expect(Object.keys(pkg.bin ?? {})).toEqual(['iap']);
    expect(pkg.bin).not.toHaveProperty('iis');
  });
});

describe('canonical default filename only (no .iis.yaml discovery)', () => {
  it('DEFAULT_FILE is infrastructure.iap.yaml', () => {
    expect(DEFAULT_FILE).toBe('infrastructure.iap.yaml');
    expect(DEFAULT_FILE).not.toContain('.iis.');
  });
});

describe('legacy iis.dev/v1 documents are rejected through the CLI', () => {
  it('validate fails on a document declaring the pre-release apiVersion', async () => {
    const dir = tmp();
    const file = join(dir, 'legacy.iap.yaml');
    writeFileSync(
      file,
      'apiVersion: iis.dev/v1\nmetadata: {name: x}\nresources: {a: {kind: Queue}}\n',
    );
    const { code, out } = await exec(['validate', '-f', file]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/IAP101|pre-release|apiVersion/);
  });
});
