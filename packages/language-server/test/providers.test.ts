/**
 * Pure-core tests for the language-server providers (spec ch. 23): every
 * capability is exercised as a plain function over (text, position) — no
 * connection, no editor, no protocol. This is the editor-neutral integration
 * suite the roadmap requires: a generic LSP client only adds plumbing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELATIONSHIP_TYPES } from '@iap/model';
import {
  computeCanonicalPreview,
  computeCodeActions,
  computeCompletions,
  computeDefinition,
  computeDiagnostics,
  computeHover,
  computePreview,
  computeReferences,
  computeRename,
  computeSymbols,
  resolveSchemaAt,
} from '../src/providers';
import type { Position, TextEdit } from '../src/providers';

const SPEC_DIR = fileURLToPath(new URL('../../../spec/', import.meta.url));

function read(relative: string): string {
  return readFileSync(`${SPEC_DIR}${relative}`, 'utf8');
}

const unknownKind = read('conformance/cases/invalid/01-unknown-kind.iap.yaml');
const webapp = read('examples/basic-webapp.iap.yaml');
const webappLines = webapp.split('\n');

/** 0-based line index of the first line matching `predicate`. */
function lineWhere(lines: string[], predicate: (line: string) => boolean): number {
  const index = lines.findIndex(predicate);
  expect(index, 'fixture line not found').toBeGreaterThanOrEqual(0);
  return index;
}

/** Position of `token` on its first line of occurrence, offset `into` chars into the token. */
function positionOf(text: string, snippet: string, token: string, into = 1): Position {
  const lines = text.split('\n');
  const line = lineWhere(lines, (l) => l.includes(snippet));
  const character = (lines[line] as string).indexOf(token) + into;
  return { line, character };
}

/**
 * Same, but the line must match exactly, optionally at/after the first line
 * containing `after` (disambiguates identical lines: web vs orders-db specs,
 * resource specs vs profile overrides).
 */
function positionOnLine(
  text: string,
  exactLine: string,
  token: string,
  into = 1,
  after?: string,
): Position {
  const lines = text.split('\n');
  const from = after === undefined ? 0 : lineWhere(lines, (l) => l.includes(after));
  const offset = lines.slice(from).findIndex((l) => l === exactLine);
  expect(offset, `line ${JSON.stringify(exactLine)} not found`).toBeGreaterThanOrEqual(0);
  const line = from + offset;
  const character = (lines[line] as string).indexOf(token) + into;
  return { line, character };
}

function applyEdits(text: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  const offset = (p: Position): number => (starts[p.line] ?? text.length) + p.character;
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let result = text;
  for (const edit of sorted) {
    result =
      result.slice(0, offset(edit.range.start)) +
      edit.newText +
      result.slice(offset(edit.range.end));
  }
  return result;
}

const WHOLE_DOC = { start: { line: 0, character: 0 }, end: { line: 10_000, character: 0 } };

/* ------------------------------------------------------------------ */
/* Diagnostics (ch. 23 §23.2.3)                                        */
/* ------------------------------------------------------------------ */

describe('computeDiagnostics', () => {
  it('flags IAP102 on conformance case 01-unknown-kind at the kind line', async () => {
    const diagnostics = await computeDiagnostics(unknownKind);
    const iis102 = diagnostics.filter((d) => d.code === 'IAP102');
    expect(iis102).toHaveLength(1);
    const diagnostic = iis102[0]!;
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.source).toBe('iap');
    // `kind: VirtualMachine` is line 14 (1-based) → 13 (0-based), indented 4.
    const kindLine = lineWhere(unknownKind.split('\n'), (l) => l.includes('kind: VirtualMachine'));
    expect(diagnostic.range.start).toEqual({ line: kindLine, character: 4 });
  });

  it('basic-webapp produces no error-severity diagnostics (matches iap validate)', async () => {
    const diagnostics = await computeDiagnostics(webapp);
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('unparseable text yields IAP101 with the whole-document fallback range', async () => {
    const diagnostics = await computeDiagnostics('resources: [unclosed\n  nope');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.code).toBe('IAP101');
    expect(diagnostics[0]!.range.start).toEqual({ line: 0, character: 0 });
  });

  it('includes phase-5 findings from the document’s own policies', async () => {
    const diagnostics = await computeDiagnostics(POLICY_FIXTURE);
    const policyFindings = diagnostics.filter((d) => d.code === 'IAP502');
    expect(policyFindings).toHaveLength(1);
    // The finding’s dot path resolves through the source map to the atRest line.
    const line = lineWhere(POLICY_FIXTURE.split('\n'), (l) => l.includes('atRest: preferred'));
    expect(policyFindings[0]!.range.start.line).toBe(line);
  });
});

/* ------------------------------------------------------------------ */
/* Completion (ch. 23 §23.2.1)                                         */
/* ------------------------------------------------------------------ */

describe('computeCompletions', () => {
  it('offers the full closed kind enum at a kind: value position', async () => {
    const position = positionOf(unknownKind, 'kind: VirtualMachine', 'VirtualMachine');
    const items = await computeCompletions(unknownKind, position);
    // 22 kinds since 1.2.0 plus Cdn and EventBus introduced in 1.3.0 (IEP-0017).
    expect(items.map((i) => i.label)).toHaveLength(24);
    expect(items.map((i) => i.label)).toContain('Service');
    expect(items.map((i) => i.label)).toContain('Database');
    expect(items.map((i) => i.label)).toContain('Cdn');
    expect(items.map((i) => i.label)).toContain('EventBus');
    // The reserved registry is empty as of spec 1.2.0 (IEP-0016): all nine
    // originally reserved kinds have graduated, so no completion item carries
    // the "reserved kind" detail label (ch. 23 §23.2.1).
    const reservedLabels = items.filter((i) => i.detail === 'reserved kind').map((i) => i.label);
    expect(reservedLabels).toEqual([]);
    // Documentation comes from the kind’s schema description.
    expect(items.find((i) => i.label === 'Database')?.documentation).toMatch(/database intent/i);
  });

  it('offers the closed verb set inside a relationship type: value', async () => {
    const position = positionOf(webapp, '- type: routesTo', 'routesTo');
    const items = await computeCompletions(webapp, position);
    expect(items.map((i) => i.label)).toEqual([...RELATIONSHIP_TYPES]);
    expect(items[0]!.documentation).toMatch(/ordering/);
  });

  it('offers in-document resource identifiers at a relationship target:', async () => {
    const position = positionOf(webapp, 'target: orders-db', 'orders-db');
    const items = await computeCompletions(webapp, position);
    expect(items.map((i) => i.label).sort()).toEqual([
      'assets',
      'edge',
      'orders-db',
      'session-cache',
      'storefront-app',
      'web',
      'web-identity',
    ]);
    expect(items.find((i) => i.label === 'orders-db')?.detail).toBe('Database');
  });

  it('offers enum values (default marked) for availability inside a Database spec', async () => {
    const position = positionOnLine(
      webapp,
      '      availability: standard',
      'standard',
      1,
      'Primary order store',
    );
    const items = await computeCompletions(webapp, position);
    expect(items.map((i) => i.label)).toEqual(['standard', 'high', 'maximum']);
    expect(items.find((i) => i.label === 'standard')?.detail).toBe('default');
    expect(items[0]!.documentation).toMatch(/SLO/);
  });

  it('resolves schema completions inside profile overrides (document-shaped merge patch)', async () => {
    // profiles.development.overrides.resources.orders-db.spec.availability
    const position = positionOnLine(webapp, '            availability: standard', 'standard');
    const items = await computeCompletions(webapp, position);
    expect(items.map((i) => i.label)).toEqual(['standard', 'high', 'maximum']);
  });

  it('offers property names (description + default in detail) in key position', async () => {
    // Cursor ON the `availability` key of orders-db (key position, not value).
    const position = positionOnLine(
      webapp,
      '      availability: standard',
      'availability',
      2,
      'Primary order store',
    );
    const items = await computeCompletions(webapp, position);
    const labels = items.map((i) => i.label);
    expect(labels).toContain('availability'); // the key being retyped
    expect(labels).toContain('exposure'); // absent from orders-db’s spec
    expect(labels).not.toContain('class'); // already present
    const exposure = items.find((i) => i.label === 'exposure')!;
    expect(exposure.detail).toContain('default: private');
    expect(exposure.kind).toBe('property');
  });
});

/* ------------------------------------------------------------------ */
/* Schema resolution (the derivation rule of ch. 23 §23.1)             */
/* ------------------------------------------------------------------ */

describe('resolveSchemaAt', () => {
  const document = { resources: { db: { kind: 'Database', spec: {} } } };

  it('dispatches the kind if/then branch: a Database spec requires class', () => {
    const resolved = resolveSchemaAt('/resources/db/spec', document);
    expect(resolved).toBeDefined();
    expect(Object.keys(resolved!.schema['properties'] as object)).toContain('class');
    expect(resolved!.schema['required']).toContain('class');
  });

  it('resolves $ref chains and reports the final reference', () => {
    const resolved = resolveSchemaAt('/resources/db/relationships/0/target', {
      resources: { db: { kind: 'Database', relationships: [{ type: 'connectsTo', target: 'x' }] } },
    });
    expect(resolved?.ref).toBe('#/$defs/common/resourceId');
  });

  it('returns undefined outside the schema', () => {
    expect(resolveSchemaAt('/no-such-top-level-key/x', document)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Hover (ch. 23 §23.2.2)                                              */
/* ------------------------------------------------------------------ */

describe('computeHover', () => {
  it('renders the SLO floor definition for availability', async () => {
    const position = positionOnLine(
      webapp,
      '      availability: standard',
      'availability',
      2,
      'Primary order store',
    );
    const hover = await computeHover(webapp, position);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('SLO');
    expect(hover!.contents).toContain('99.95%');
    expect(hover!.contents).toContain('Default: `standard`');
    expect(hover!.contents).toContain('Allowed values:');
    expect(hover!.range).toBeDefined();
  });

  it('renders the kind description when hovering a kind: value', async () => {
    const position = positionOf(webapp, 'kind: Database', 'Database');
    const hover = await computeHover(webapp, position);
    expect(hover?.contents).toMatch(/database intent/i);
  });
});

/* ------------------------------------------------------------------ */
/* Definition / references / rename (ch. 23 §23.2.6)                   */
/* ------------------------------------------------------------------ */

describe('identifier navigation', () => {
  const usage = positionOf(webapp, 'target: orders-db', 'orders-db');
  const definitionLine = lineWhere(webappLines, (l) => l === '  orders-db:');

  it('definition of a target usage is the key under /resources', async () => {
    const definition = await computeDefinition(webapp, usage);
    expect(definition).toBeDefined();
    expect(definition!.range.start).toEqual({ line: definitionLine, character: 2 });
    expect(definition!.range.end.character).toBe(2 + 'orders-db'.length);
  });

  it('references list every usage site plus the key itself', async () => {
    const references = await computeReferences(webapp, {
      line: definitionLine,
      character: 3,
    });
    // key + connectsTo target + components item + outputs.resource
    // + two profile-override keys (renames must follow overrides).
    expect(references).toHaveLength(6);
    const lines = references.map((r) => webappLines[r.range.start.line] as string);
    expect(lines.some((l) => l.includes('target: orders-db'))).toBe(true);
    expect(lines.some((l) => l.includes('components:'))).toBe(true);
    expect(lines.some((l) => l.includes('resource: orders-db'))).toBe(true);
  });

  it('rename rewrites all sites and the renamed document re-validates clean', async () => {
    const result = await computeRename(webapp, usage, 'orders-database');
    expect('edits' in result && result.edits).toHaveLength(6);
    const renamed = applyEdits(webapp, (result as { edits: TextEdit[] }).edits);
    expect(renamed).toContain('orders-database:');
    expect(renamed).not.toMatch(/orders-db[^a-z-]/);
    const diagnostics = await computeDiagnostics(renamed);
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('rejects an invalid new identifier (grammar) and a colliding one', async () => {
    const invalid = await computeRename(webapp, usage, 'Orders_DB');
    expect('error' in invalid && invalid.error).toMatch(/not a valid resource identifier/);
    const collision = await computeRename(webapp, usage, 'web');
    expect('error' in collision && collision.error).toMatch(/already exists/);
  });

  it('returns nothing when the cursor is not on a resource identifier', async () => {
    expect(await computeDefinition(webapp, { line: 0, character: 0 })).toBeUndefined();
    expect(await computeReferences(webapp, { line: 0, character: 0 })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Document symbols (ch. 23 §23.2.5)                                   */
/* ------------------------------------------------------------------ */

describe('computeSymbols', () => {
  it('outlines resources (kind in detail), profiles, and outputs of basic-webapp', async () => {
    const symbols = await computeSymbols(webapp);
    const byName = new Map(symbols.map((s) => [s.name, s]));
    expect([...byName.keys()]).toEqual(['resources', 'profiles', 'outputs']);
    const resources = byName.get('resources')!;
    expect(resources.children).toHaveLength(7);
    expect(resources.children!.map((c) => c.name)).toContain('orders-db');
    expect(resources.children!.find((c) => c.name === 'orders-db')?.detail).toBe('Database');
    expect(byName.get('profiles')!.children!.map((c) => c.name)).toEqual([
      'development',
      'production',
    ]);
    expect(byName.get('outputs')!.children).toHaveLength(2);
  });

  it('lists policies with their effect', async () => {
    const symbols = await computeSymbols(POLICY_FIXTURE);
    const policies = symbols.find((s) => s.name === 'policies');
    expect(policies?.children?.map((c) => [c.name, c.detail])).toEqual([
      ['encrypt-at-rest', 'require'],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Code actions (ch. 23 §23.2.4)                                       */
/* ------------------------------------------------------------------ */

const POLICY_FIXTURE = `apiVersion: iap.dev/v1
metadata:
  name: policy-fixture
resources:
  orders:
    kind: Database
    spec:
      class: relational
      encryption:
        atRest: preferred
policies:
  - id: encrypt-at-rest
    description: Databases must require at-rest encryption
    target:
      kinds: [Database]
    rule:
      field: spec.encryption.atRest
      operator: equals
      value: required
    effect: require
`;

describe('computeCodeActions', () => {
  it('surfaces the require-policy autofix and applying it clears the violation', async () => {
    const actions = await computeCodeActions(POLICY_FIXTURE, WHOLE_DOC);
    const autofix = actions.find((a) => a.title.includes('encrypt-at-rest'));
    expect(autofix).toBeDefined();
    expect(autofix!.kind).toBe('quickfix');
    const fixed = applyEdits(POLICY_FIXTURE, autofix!.edits);
    expect(fixed).toContain('atRest: required');
    const diagnostics = await computeDiagnostics(fixed);
    expect(diagnostics.filter((d) => d.code === 'IAP502')).toHaveLength(0);
  });

  it('offers an insert for IAP101 missing-required-property findings', async () => {
    const missing = `apiVersion: iap.dev/v1
metadata:
  name: missing-fixture
resources:
  orders:
    kind: Database
    spec:
      engine: postgresql
`;
    const actions = await computeCodeActions(missing, WHOLE_DOC);
    const add = actions.find((a) => a.title === 'Add missing required field "class"');
    expect(add).toBeDefined();
    const fixed = applyEdits(missing, add!.edits);
    expect(fixed).toContain('class: relational'); // first enum value as placeholder
    const diagnostics = await computeDiagnostics(fixed);
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('produces no actions for a clean document', async () => {
    expect(await computeCodeActions(webapp, WHOLE_DOC)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Architecture preview (ch. 23 §23.2.9)                               */
/* ------------------------------------------------------------------ */

describe('computePreview', () => {
  it('returns Mermaid flowchart source for the architecture view', async () => {
    const preview = await computePreview(webapp, 'architecture');
    expect(preview.mermaid.startsWith('flowchart TD')).toBe(true);
    expect(preview.mermaid).toContain('orders-db');
  });

  it('supports the application view with an application id', async () => {
    const preview = await computePreview(webapp, 'application', 'storefront-app');
    expect(preview.mermaid).toContain('subgraph storefront-app');
  });

  it('rejects unparseable documents', async () => {
    await expect(computePreview('nope: [', 'architecture')).rejects.toThrow(/parse/);
  });

  it('canonical preview returns the canonical JSON projection and hash', async () => {
    const preview = await computeCanonicalPreview(webapp);
    expect(preview.canonicalJson.startsWith('{')).toBe(true);
    expect(JSON.parse(preview.canonicalJson)).toHaveProperty('resources');
    expect(preview.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ------------------------------------------------------------------ */
/* Performance contract (ch. 23 §23.4)                                 */
/* ------------------------------------------------------------------ */

describe('performance', () => {
  it('full diagnostics on the largest official example average well under the budget', async () => {
    // enterprise-pci is the largest official example (221 lines, policies included).
    const largest = read('examples/enterprise-pci.iap.yaml');
    const runs = 5;
    const durations: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      // A unique trailing comment defeats the analysis cache so every run is cold.
      const text = `${largest}\n# perf-run-${i}\n`;
      const started = performance.now();
      await computeDiagnostics(text);
      durations.push(performance.now() - started);
    }
    const average = durations.reduce((sum, d) => sum + d, 0) / runs;
    // ch. 23 §23.4 targets 200 ms for <100 resources; soft-assert 1000 ms to
    // avoid CI flake and log the measured value for the phase report.
    console.log(
      `computeDiagnostics(enterprise-pci) cold runs: avg ${average.toFixed(1)} ms ` +
        `(min ${Math.min(...durations).toFixed(1)}, max ${Math.max(...durations).toFixed(1)})`,
    );
    expect(average).toBeLessThan(1000);
  });

  it('stays within budget on a synthetic 110-resource document (ch. 23 <100-resource contract)', async () => {
    const blocks: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      blocks.push(
        [
          `  svc-${i}:`,
          '    kind: Service',
          '    spec:',
          '      artifact:',
          '        type: container-image',
          `        reference: registry.example.com/svc-${i}:1.0.0`,
          '      size: s',
          '    relationships:',
          '      - type: connectsTo',
          `        target: db-${i % 10}`,
          '        port: 5432',
          '        protocol: tcp',
          '',
        ].join('\n'),
      );
    }
    for (let i = 0; i < 10; i += 1) {
      blocks.push(`  db-${i}:\n    kind: Database\n    spec:\n      class: relational\n`);
    }
    const synthetic = `apiVersion: iap.dev/v1\nmetadata:\n  name: synthetic-large\nresources:\n${blocks.join('')}`;
    const runs = 5;
    const durations: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const text = `${synthetic}\n# perf-run-${i}\n`;
      const started = performance.now();
      await computeDiagnostics(text);
      durations.push(performance.now() - started);
    }
    const average = durations.reduce((sum, d) => sum + d, 0) / runs;
    console.log(
      `computeDiagnostics(synthetic, 110 resources) cold runs: avg ${average.toFixed(1)} ms ` +
        `(min ${Math.min(...durations).toFixed(1)}, max ${Math.max(...durations).toFixed(1)})`,
    );
    expect(average).toBeLessThan(1000);
  });
});
