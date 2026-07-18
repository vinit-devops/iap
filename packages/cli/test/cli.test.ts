import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { emptySnapshot } from '@iap/planner';
import { load } from '@iap/sdk';
import { run } from '../src/cli';

const repoRoot = join(__dirname, '..', '..', '..');
const example = (name: string): string => join(repoRoot, 'spec', 'examples', name);
const invalidCase = (name: string): string =>
  join(repoRoot, 'spec', 'conformance', 'cases', 'invalid', name);

const BASIC = example('basic-webapp.iap.yaml');
const SERVERLESS = example('serverless-api.iap.yaml');
const UNKNOWN_KIND = invalidCase('01-unknown-kind.iap.yaml');

interface Execution {
  code: number;
  stdout: string;
  stderr: string;
}

/** Invoke the command layer in-process with captured writers. */
async function exec(argv: string[]): Promise<Execution> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-cli-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('embedded error-code registry', () => {
  it('is byte-identical to spec/conformance/error-codes.yaml (drift guard)', () => {
    const embedded = readFileSync(join(__dirname, '..', 'registry', 'error-codes.yaml'), 'utf8');
    const authority = readFileSync(
      join(repoRoot, 'spec', 'conformance', 'error-codes.yaml'),
      'utf8',
    );
    expect(embedded).toBe(authority);
  });
});

describe('iap validate', () => {
  it('basic-webapp: human output exits 0 with the per-phase table', async () => {
    const result = await exec(['validate', '--file', BASIC]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('✔ schema');
    expect(result.stdout).toContain('✔ dependency');
    expect(result.stdout).toContain('✔ policy');
    expect(result.stdout).toContain('0 errors, 0 warnings');
    expect(result.stderr).toBe('');
  });

  it('basic-webapp: json output exits 0 and carries formatVersion + phases', async () => {
    const result = await exec(['validate', '-f', BASIC, '-o', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      formatVersion: number;
      ok: boolean;
      findings: unknown[];
      phases: Record<string, { skipped: boolean }>;
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.findings).toEqual([]);
    expect(Object.keys(parsed.phases)).toEqual([
      'schema',
      'reference',
      'relationship',
      'dependency',
      'policy',
    ]);
    expect(parsed.phases['policy']?.skipped).toBe(false);
  });

  it('basic-webapp: sarif output parses as SARIF 2.1.0 with registry rules', async () => {
    const result = await exec(['validate', '-f', BASIC, '-o', 'sarif']);
    expect(result.code).toBe(0);
    const sarif = JSON.parse(result.stdout) as {
      version: string;
      runs: { tool: { driver: { rules: { id: string }[] } }; results: unknown[] }[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(Array.isArray(sarif.runs[0]?.results)).toBe(true);
    expect(sarif.runs[0]?.results).toEqual([]);
    const ruleIds = sarif.runs[0]?.tool.driver.rules.map((rule) => rule.id) ?? [];
    expect(ruleIds).toContain('IAP102');
    expect(ruleIds).toContain('IAP501');
  });

  it('unknown kind: exits 1 with IAP102 in json findings', async () => {
    const result = await exec(['validate', '-f', UNKNOWN_KIND, '-o', 'json']);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      findings: { code: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.findings.map((f) => f.code)).toContain('IAP102');
  });

  it('unknown kind: sarif result resolves a source location', async () => {
    const result = await exec(['validate', '-f', UNKNOWN_KIND, '-o', 'sarif']);
    expect(result.code).toBe(1);
    const sarif = JSON.parse(result.stdout) as {
      runs: {
        results: {
          ruleId: string;
          locations?: { physicalLocation: { region?: { startLine: number } } }[];
        }[];
      }[];
    };
    const finding = sarif.runs[0]?.results.find((r) => r.ruleId === 'IAP102');
    expect(finding).toBeDefined();
    expect(finding?.locations?.[0]?.physicalLocation.region?.startLine).toBeGreaterThan(0);
  });

  it('json output is deterministic across runs', async () => {
    const first = await exec(['validate', '-f', BASIC, '-o', 'json']);
    const second = await exec(['validate', '-f', BASIC, '-o', 'json']);
    expect(first.stdout).toBe(second.stdout);
  });

  it('unreadable file is a usage error (exit 2)', async () => {
    const result = await exec(['validate', '-f', join(tempDir(), 'missing.iap.yaml')]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cannot read');
  });
});

describe('iap plan', () => {
  const MOCK_PACKAGE = join(repoRoot, 'providers', 'mock');
  const MOCK_ARTIFACT = join(MOCK_PACKAGE, 'mappings', 'core.iap-map.yaml');
  const MULTI_REGION = example('multi-region.iap.yaml');
  const goldenPlanId = (
    JSON.parse(
      readFileSync(
        join(repoRoot, 'tests', 'determinism', 'golden-plans', 'basic-webapp.plan.json'),
        'utf8',
      ),
    ) as { planId: string }
  ).planId;

  it('requires --mapping (usage error)', async () => {
    const result = await exec(['plan', '-f', BASIC, '--profile', 'production']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--mapping');
  });

  it('requires --profile when the document declares profiles (§22.1)', async () => {
    const result = await exec(['plan', '-f', BASIC, '--mapping', MOCK_PACKAGE]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--profile is required');
  });

  it('plans basic-webapp through the verified mock package (human rendering)', async () => {
    const result = await exec([
      'plan',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--mapping',
      MOCK_PACKAGE,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Plan: 9 to create, 0 to update-in-place');
    expect(result.stdout).toContain('wave 1');
    expect(result.stdout).toContain('image ← from:spec.artifact.reference');
    expect(result.stdout).toContain('changedBy documentHash');
    expect(result.stdout).toContain('Destructive: none');
    expect(result.stdout).toContain('Rollback: re-plan-to-revision; limitations: none');
    expect(result.stdout).toContain(`planId: ${goldenPlanId}`);
    expect(result.stderr).toBe('');
  });

  it('json output is the artifact verbatim, byte-agreeing with the golden planId', async () => {
    const result = await exec([
      'plan',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--mapping',
      MOCK_PACKAGE,
      '-o',
      'json',
    ]);
    expect(result.code).toBe(0);
    const artifact = JSON.parse(result.stdout) as {
      apiVersion: string;
      planId: string;
      envelope?: unknown;
      content: { waves: unknown[][]; approvalsRequired: unknown[] };
    };
    expect(artifact.apiVersion).toBe('plan.iap.dev/v1');
    expect(artifact.planId).toBe(goldenPlanId);
    expect(artifact.envelope).toBeUndefined();
    expect(artifact.content.waves.length).toBeGreaterThan(0);
  });

  it('a bare *.iap-map.yaml artifact yields the identical planId', async () => {
    const result = await exec([
      'plan',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--mapping',
      MOCK_ARTIFACT,
      '-o',
      'json',
    ]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { planId: string }).planId).toBe(goldenPlanId);
  });

  it('--out writes the canonical machine artifact', async () => {
    const out = join(tempDir(), 'plan.json');
    const result = await exec([
      'plan',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--mapping',
      MOCK_PACKAGE,
      '--out',
      out,
      '--quiet',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const bytes = readFileSync(out, 'utf8');
    expect(bytes).toBe(
      readFileSync(
        join(repoRoot, 'tests', 'determinism', 'golden-plans', 'basic-webapp.plan.json'),
        'utf8',
      ),
    );
  });

  it('--state consumes an IEP-0010 snapshot; a corrupt one is an operation failure', async () => {
    const dir = tempDir();
    const empty = join(dir, 'empty-state.json');
    writeFileSync(empty, JSON.stringify(emptySnapshot()));
    const ok = await exec([
      'plan',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--mapping',
      MOCK_PACKAGE,
      '--state',
      empty,
      '-o',
      'json',
    ]);
    expect(ok.code).toBe(0);
    expect((JSON.parse(ok.stdout) as { planId: string }).planId).toBe(goldenPlanId);

    const corrupt = join(dir, 'corrupt-state.json');
    writeFileSync(
      corrupt,
      JSON.stringify({ ...emptySnapshot(), integrity: `sha256:${'0'.repeat(64)}` }),
    );
    const refused = await exec([
      'plan',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--mapping',
      MOCK_PACKAGE,
      '--state',
      corrupt,
    ]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('integrity');
  });

  it('mapping diagnostics exit 1 and are never silently dropped (CP-4)', async () => {
    const result = await exec(['plan', '-f', MULTI_REGION, '--mapping', MOCK_PACKAGE]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unsupported-value');
    expect(result.stderr).toContain('users-db-primary');
  });

  it('refuses to plan a non-conforming document (CP-4)', async () => {
    const result = await exec(['plan', '-f', UNKNOWN_KIND, '--mapping', MOCK_PACKAGE]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing to plan a non-conforming document');
  });

  it('an unverifiable mapping package is a usage error', async () => {
    const result = await exec([
      'plan',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--mapping',
      MOCK_PACKAGE,
      '--keys',
      tempDir(), // no trust material → signature cannot verify
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('provider package refused');
  });
});

describe('iap normalize', () => {
  it('--profile production changes the canonical hash', async () => {
    const base = await exec(['normalize', '-f', BASIC, '-o', 'json']);
    const production = await exec([
      'normalize',
      '-f',
      BASIC,
      '--profile',
      'production',
      '-o',
      'json',
    ]);
    expect(base.code).toBe(0);
    expect(production.code).toBe(0);
    const baseParsed = JSON.parse(base.stdout) as { formatVersion: number; hash: string };
    const prodParsed = JSON.parse(production.stdout) as { formatVersion: number; hash: string };
    expect(baseParsed.formatVersion).toBe(1);
    expect(baseParsed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prodParsed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prodParsed.hash).not.toBe(baseParsed.hash);
  });

  it('default output is the canonical byte projection', async () => {
    const result = await exec(['normalize', '-f', BASIC]);
    expect(result.code).toBe(0);
    const ws = await load({ path: BASIC });
    expect(result.stdout).toBe(ws.serialize('canonical-json') + '\n');
  });
});

describe('iap diagram', () => {
  const views: [string, string[]][] = [
    ['architecture', []],
    ['dependency', []],
    ['network', []],
    ['security', []],
    ['application', ['--application', 'storefront-app']],
  ];

  for (const [view, extra] of views) {
    it(`${view} view renders Mermaid starting with "flowchart TD"`, async () => {
      const result = await exec(['diagram', '-f', BASIC, '--view', view, ...extra]);
      expect(result.code).toBe(0);
      expect(result.stdout.startsWith('flowchart TD')).toBe(true);
    });
  }

  it('json format carries formatVersion and the view graph', async () => {
    const result = await exec(['diagram', '-f', BASIC, '--view', 'network', '--format', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      formatVersion: number;
      view: string;
      nodes: unknown[];
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.view).toBe('network');
    expect(parsed.nodes.length).toBeGreaterThan(0);
  });

  it('dot format emits Graphviz source', async () => {
    const result = await exec(['diagram', '-f', BASIC, '--view', 'dependency', '--format', 'dot']);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('digraph')).toBe(true);
  });

  it('missing --view and application view without --application are usage errors', async () => {
    expect((await exec(['diagram', '-f', BASIC])).code).toBe(2);
    expect((await exec(['diagram', '-f', BASIC, '--view', 'application'])).code).toBe(2);
  });
});

describe('iap graph', () => {
  it('human output lists edges and execution waves', async () => {
    const result = await exec(['graph', '-f', BASIC]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('connectsTo');
    expect(result.stdout).toContain('execution waves:');
  });

  it('json output has formatVersion, edges, and wave ordering', async () => {
    const result = await exec(['graph', '-f', BASIC, '-o', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      formatVersion: number;
      edges: { source: string; type: string; target: string }[];
      ordering: { waves: string[][] };
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.edges.length).toBeGreaterThan(0);
    expect(parsed.ordering.waves.length).toBeGreaterThan(1);
  });

  it('dot output renders the dependency view', async () => {
    const result = await exec(['graph', '-f', BASIC, '--format', 'dot']);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('digraph "dependency"')).toBe(true);
  });
});

describe('iap policy', () => {
  it('--pack private-only on serverless-api exits 1 (public gateway)', async () => {
    const result = await exec(['policy', '-f', SERVERLESS, '--pack', 'private-only', '-o', 'json']);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      formatVersion: number;
      ok: boolean;
      findings: { code: string; path: string }[];
      autofixes: unknown[];
      evaluations: unknown[];
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.ok).toBe(false);
    const denial = parsed.findings.find((f) => f.code === 'IAP501');
    expect(denial).toBeDefined();
    expect(denial?.path).toContain('resources.edge');
    expect(parsed.evaluations.length).toBeGreaterThan(0);
  });

  it('document policies alone pass on serverless-api (exit 0)', async () => {
    const result = await exec(['policy', '-f', SERVERLESS]);
    expect(result.code).toBe(0);
  });

  it('unknown pack is a usage error listing available packs', async () => {
    const result = await exec(['policy', '-f', SERVERLESS, '--pack', 'nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown pack');
    expect(result.stderr).toContain('private-only');
  });
});

describe('iap diff', () => {
  it('base vs itself under --profile-b production reports changed resources', async () => {
    const result = await exec([
      'diff',
      '-f',
      BASIC,
      BASIC,
      '--profile-b',
      'production',
      '-o',
      'json',
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      formatVersion: number;
      identical: boolean;
      added: string[];
      removed: string[];
      changed: { id: string; paths: { pointer: string }[] }[];
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.identical).toBe(false);
    expect(parsed.added).toEqual([]);
    expect(parsed.removed).toEqual([]);
    const changedIds = parsed.changed.map((entry) => entry.id);
    expect(changedIds).toContain('web');
    expect(changedIds).toContain('orders-db');
    const ordersDb = parsed.changed.find((entry) => entry.id === 'orders-db');
    expect(ordersDb?.paths.map((p) => p.pointer)).toContain('/spec/availability');
  });

  it('identical inputs report identical models', async () => {
    const result = await exec(['diff', '-f', BASIC, BASIC, '-o', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { identical: boolean; changed: unknown[] };
    expect(parsed.identical).toBe(true);
    expect(parsed.changed).toEqual([]);
  });
});

describe('iap fmt', () => {
  it('round-trip preserves the canonical hash', async () => {
    const result = await exec(['fmt', '-f', BASIC]);
    expect(result.code).toBe(0);
    const original = await load({ path: BASIC });
    const reloaded = await load(result.stdout);
    expect(reloaded.canonical().hash).toBe(original.canonical().hash);
  });

  it('--write rewrites the file in place, hash-neutrally', async () => {
    const dir = tempDir();
    const copy = join(dir, 'doc.iap.yaml');
    copyFileSync(BASIC, copy);
    const before = (await load({ path: copy })).canonical().hash;
    const result = await exec(['fmt', '-f', copy, '--write']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`formatted ${copy}`);
    const after = (await load({ path: copy })).canonical().hash;
    expect(after).toBe(before);
  });
});

describe('iap explain', () => {
  it('summarizes kind, provenance, edges, and wave position', async () => {
    const result = await exec(['explain', 'web', '-f', BASIC, '-o', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      formatVersion: number;
      kind: string;
      provenance: Record<string, { source: string }>;
      edgesOut: unknown[];
      edgesIn: unknown[];
      wave: { index: number; of: number };
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.kind).toBe('Service');
    expect(Object.keys(parsed.provenance).length).toBeGreaterThan(0);
    const sources = new Set(Object.values(parsed.provenance).map((r) => r.source));
    expect(sources.has('explicit')).toBe(true);
    expect(parsed.edgesOut).toHaveLength(4);
    expect(parsed.edgesIn).toHaveLength(1);
    expect(parsed.wave.index).toBeGreaterThan(0);
    expect(parsed.wave.of).toBeGreaterThanOrEqual(parsed.wave.index);
  });

  it('profile overrides surface as profile-sourced provenance', async () => {
    const result = await exec([
      'explain',
      'web',
      '-f',
      BASIC,
      '--profile',
      'production',
      '-o',
      'json',
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      provenance: Record<string, { source: string }>;
    };
    expect(parsed.provenance['/spec/size']?.source).toBe('profile');
  });

  it('unknown resource id is a usage error', async () => {
    const result = await exec(['explain', 'nope', '-f', BASIC]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not found');
  });
});

describe('iap doctor', () => {
  it('reports versions and validates the document', async () => {
    const result = await exec(['doctor', '-f', BASIC, '-o', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      formatVersion: number;
      versions: Record<string, string>;
      document: { present: boolean; ok: boolean; hash: string };
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.versions['cli']).toBe('1.0.0');
    expect(parsed.versions['specApiVersion']).toBe('iap.dev/v1');
    expect(parsed.document.present).toBe(true);
    expect(parsed.document.ok).toBe(true);
    expect(parsed.document.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('iap init', () => {
  it('creates a starter file that validates, then refuses a second run', async () => {
    const file = join(tempDir(), 'infrastructure.iap.yaml');

    const first = await exec(['init', '--file', file]);
    expect(first.code).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect((await exec(['validate', '-f', file])).code).toBe(0);

    const second = await exec(['init', '--file', file]);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain('already exists');

    const forced = await exec(['init', '--file', file, '--force']);
    expect(forced.code).toBe(0);
  });
});

describe('usage and stubs', () => {
  it('unknown command exits 2 with usage on stderr', async () => {
    const result = await exec(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command "frobnicate"');
    expect(result.stderr).toContain('Usage: iap');
  });

  it('unknown flag exits 2', async () => {
    const result = await exec(['validate', '--bogus']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown flag "--bogus"');
  });

  it('stub commands exit 2 naming the gating phase', async () => {
    const rollback = await exec(['rollback']);
    expect(rollback.code).toBe(2);
    expect(rollback.stderr).toContain(
      'iap rollback: not yet available — requires Phase 14 (Deployment, State, Verification and Drift) engines; planned for a future release',
    );
    // `create` shipped in M5.3; `edit` (incremental authoring) stays gated on Phase 3.
    const edit = await exec(['edit']);
    expect(edit.code).toBe(2);
    expect(edit.stderr).toContain('requires Phase 3 (Intent Authoring Engine and Intent Compiler)');
  });

  it('deploy is no longer a stub (Phase 19, M19.3)', async () => {
    // Without a document it is a usage/operation error — but never the stub line.
    const deploy = await exec(['deploy', '--mapping', 'nope']);
    expect(deploy.stderr).not.toContain('not yet available');
  });

  it('help exits 0; bare invocation exits 2', async () => {
    const help = await exec(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: iap');
    expect((await exec([])).code).toBe(2);
  });

  it('version prints the package version', async () => {
    const human = await exec(['version']);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe('iap 1.0.0\n');
    const json = await exec(['version', '-o', 'json']);
    const parsed = JSON.parse(json.stdout) as { formatVersion: number; version: string };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.version).toBe('1.0.0');
  });

  it('--quiet suppresses human output but keeps the exit code', async () => {
    const result = await exec(['validate', '-f', UNKNOWN_KIND, '--quiet']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });
});
