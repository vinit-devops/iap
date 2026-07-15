/**
 * `iap create` — natural-language authoring at the CLI (roadmap Phase 5, M5.3).
 * Drives the command layer in-process over captured writers (and injectable
 * stdin), asserting the normative exit-code contract, the write/overwrite
 * behavior, the non-interactive answer plumbing, deterministic machine output,
 * and that a created document is actually valid.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { load, validateExtensions } from '@iap/sdk';
import type { IaPDocument } from '@iap/model';
import { run } from '../src/cli';

const TS = '2026-07-11T12:00:00Z';
const CLEAR =
  'A public web app running image registry.example.com/app:1.0.0 behind a gateway with a ' +
  'postgresql database and a redis cache';

interface Execution {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(argv: string[], stdin?: string): Promise<Execution> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
    ...(stdin === undefined ? {} : { readStdin: () => Promise.resolve(stdin) }),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-create-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('iap create — committing a document', () => {
  it('a clear request writes a valid infrastructure.iap.yaml and exits 0', async () => {
    const out = join(tempDir(), 'infra.iap.yaml');
    const result = await exec(['create', CLEAR, '--out', out, '--timestamp', TS]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(out)).toBe(true);
    expect(result.stdout).toContain('created');

    // The written document re-loads and re-validates green end to end.
    const ws = await load(readFileSync(out, 'utf8'));
    expect(ws.ok).toBe(true);
    const findings = [
      ...ws.validate().findings,
      ...ws.policies().findings,
      ...validateExtensions(ws.document as IaPDocument),
    ];
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(Object.keys((ws.document as IaPDocument).resources).sort()).toEqual([
      'cache',
      'db',
      'edge',
      'web',
    ]);
  });

  it('--stdout prints the document and never touches the filesystem', async () => {
    const out = join(tempDir(), 'unused.iap.yaml');
    const result = await exec(['create', CLEAR, '--stdout', '--out', out, '--timestamp', TS]);
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(result.stdout).toContain('apiVersion: iap.dev/v1');
    expect(result.stdout).toContain('kind: Service');
  });

  it('refuses to overwrite an existing file without --force (exit 2), then overwrites with it', async () => {
    const out = join(tempDir(), 'infra.iap.yaml');
    writeFileSync(out, 'pre-existing\n');
    const blocked = await exec(['create', CLEAR, '--out', out, '--timestamp', TS]);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('already exists');
    expect(readFileSync(out, 'utf8')).toBe('pre-existing\n');

    const forced = await exec(['create', CLEAR, '--out', out, '--force', '--timestamp', TS]);
    expect(forced.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('apiVersion: iap.dev/v1');
  });

  it('reads the request from stdin when none is given on the command line', async () => {
    const result = await exec(
      ['create', '--stdout', '--timestamp', TS],
      'A serverless function running image registry.example.com/fn:1.0.0',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind: Function');
  });
});

describe('iap create — clarifications and the answer plumbing', () => {
  it('a missing required field needs input: exits 1, writes nothing, shows the question', async () => {
    const out = join(tempDir(), 'infra.iap.yaml');
    const result = await exec(['create', 'We need a web app', '--out', out, '--timestamp', TS]);
    expect(result.code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(result.stdout).toContain('clarifications:');
    expect(result.stdout).toContain('q-artifact-web');
    expect(result.stdout).toContain('not written');
  });

  it('--answers supplies the missing value and the request commits', async () => {
    const out = join(tempDir(), 'infra.iap.yaml');
    const result = await exec([
      'create',
      'We need a web app',
      '--out',
      out,
      '--answers',
      '[{"questionId":"q-artifact-web","value":"registry.example.com/web:1.0.0"}]',
      '--timestamp',
      TS,
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it('malformed --answers is a usage error (exit 2)', async () => {
    const result = await exec([
      'create',
      'We need a web app',
      '--answers',
      '{not json',
      '--timestamp',
      TS,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--answers');
  });
});

describe('iap create — unsupported and refused requests write nothing', () => {
  it('a wholly unsupported request reports capabilities and exits 1', async () => {
    const out = join(tempDir(), 'infra.iap.yaml');
    const result = await exec([
      'create',
      'We need a vpn and a dynamodb table',
      '--out',
      out,
      '--timestamp',
      TS,
    ]);
    expect(result.code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(result.stdout).toContain('unsupported:');
    expect(result.stdout).toContain('dynamodb');
    expect(result.stdout).toContain('vpn');
  });
});

describe('iap create — machine output (-o json)', () => {
  it('a committed request emits a deterministic formatVersion:1 payload', async () => {
    const result = await exec(['create', CLEAR, '--stdout', '-o', 'json', '--timestamp', TS]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      formatVersion: number;
      outcome: string;
      resources: string[];
      canonicalHash: string;
      provenanceCount: number;
      document: string | null;
    };
    expect(payload.formatVersion).toBe(1);
    expect(payload.outcome).toBe('committed');
    expect(payload.resources).toEqual(['cache', 'db', 'edge', 'web']);
    expect(payload.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.provenanceCount).toBeGreaterThan(0);
    expect(payload.document).toContain('apiVersion: iap.dev/v1');
  });

  it('a needs-input request emits the clarifications and unanswered ids', async () => {
    const result = await exec(['create', 'We need a web app', '-o', 'json', '--timestamp', TS]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      outcome: string;
      clarifications: { id: string; blocking: boolean }[];
      unanswered: string[];
    };
    expect(payload.outcome).toBe('needs-input');
    expect(payload.clarifications.map((q) => q.id)).toContain('q-artifact-web');
    expect(payload.unanswered).toContain('q-artifact-web');
  });

  it('json output is byte-identical across runs (determinism)', async () => {
    const a = await exec(['create', CLEAR, '--stdout', '-o', 'json', '--timestamp', TS]);
    const b = await exec(['create', CLEAR, '--stdout', '-o', 'json', '--timestamp', TS]);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe('iap create — usage and surface', () => {
  it('no request anywhere is a usage error (exit 2)', async () => {
    const result = await exec(['create', '--timestamp', TS], '');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no request');
  });

  it('is a real command, not a phase-gated stub; iap edit stays stubbed', async () => {
    const help = await exec(['help']);
    expect(help.stdout).toContain('create');
    // `edit` is still gated and exits 2 naming its phase.
    const edit = await exec(['edit']);
    expect(edit.code).toBe(2);
    expect(edit.stderr).toContain('Phase 3');
  });
});
