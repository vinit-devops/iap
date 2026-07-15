import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { canonicalize, compareCodePoints } from '@iap/model';
import type { CanonicalModel, IaPDocument } from '@iap/model';
import { deriveView, diffViews, toDot, toMermaid } from '../src/index';
import type { ViewGraph, ViewName } from '../src/index';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../spec/examples/', import.meta.url));

function loadExample(name: string): IaPDocument {
  return parse(readFileSync(`${EXAMPLES_DIR}${name}`, 'utf8')) as IaPDocument;
}

function modelOf(doc: IaPDocument, profile: string | null = null): CanonicalModel {
  return canonicalize(doc, { profile }).model;
}

const GLOBAL_VIEWS: ViewName[] = ['architecture', 'dependency', 'network', 'security'];

function applicationIds(model: CanonicalModel): string[] {
  return Object.keys(model.resources)
    .filter((id) => model.resources[id]?.kind === 'Application')
    .sort(compareCodePoints);
}

/** Every derivable view of a model: the four global views plus one per Application. */
function allViews(model: CanonicalModel): Array<{ name: string; graph: ViewGraph }> {
  const views = GLOBAL_VIEWS.map((view) => ({ name: view, graph: deriveView(model, view) }));
  for (const appId of applicationIds(model)) {
    views.push({
      name: `application:${appId}`,
      graph: deriveView(model, 'application', { application: appId }),
    });
  }
  return views;
}

const FORBIDDEN_LAYOUT_KEYS = new Set([
  'x',
  'y',
  'position',
  'layout',
  'coordinates',
  'width',
  'height',
]);

function collectKeys(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
}

const basicWebapp = loadExample('basic-webapp.iap.yaml');
const base = modelOf(basicWebapp);

describe('all official examples × all applicable views', () => {
  const exampleFiles = readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.iap.yaml'))
    .sort();

  it('the corpus contains the 9 official examples', () => {
    expect(exampleFiles).toHaveLength(9);
  });

  for (const file of exampleFiles) {
    it(`${file}: every view is a valid, non-empty, deterministic ViewGraph`, () => {
      const model = modelOf(loadExample(file));
      const views = allViews(model);
      expect(views.length).toBeGreaterThanOrEqual(5); // 4 global + ≥1 application
      for (const { name, graph } of views) {
        // Non-empty, well-formed.
        expect(graph.nodes.length, `${name} nodes`).toBeGreaterThan(0);
        // Nodes sorted lexicographically by id; ids unique.
        const ids = graph.nodes.map((n) => n.id);
        expect(ids).toEqual([...ids].sort(compareCodePoints));
        expect(new Set(ids).size).toBe(ids.length);
        // Stable, unique edge ids; endpoints resolve to emitted nodes.
        const edgeIds = graph.edges.map((e) => e.id);
        expect(new Set(edgeIds).size).toBe(edgeIds.length);
        const nodeIdSet = new Set(ids);
        for (const edge of graph.edges) {
          expect(nodeIdSet.has(edge.source), `${name} edge source ${edge.source}`).toBe(true);
          expect(nodeIdSet.has(edge.target), `${name} edge target ${edge.target}`).toBe(true);
        }
        // Clickable provenance on every node.
        for (const node of graph.nodes) {
          expect(node.sourcePointer).toBe(`/resources/${node.id}`);
        }
        // Textual exporters produce the required formats.
        expect(toMermaid(graph).startsWith('flowchart TD')).toBe(true);
        expect(toDot(graph).startsWith('digraph')).toBe(true);
        // No layout data anywhere in the semantic output.
        const keys = new Set<string>();
        collectKeys(graph, keys);
        for (const forbidden of FORBIDDEN_LAYOUT_KEYS) {
          expect(keys.has(forbidden), `${name} leaks layout key "${forbidden}"`).toBe(false);
        }
      }
    });
  }
});

describe('determinism (ch. 18 §18.3)', () => {
  /** Recursively reverse object key order — a semantically identical, shuffled document. */
  function reverseKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeysDeep);
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value).reverse();
      return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeysDeep(v)]));
    }
    return value;
  }

  it('a shuffled-key variant of basic-webapp yields byte-identical Mermaid for every view', () => {
    const shuffled = modelOf(reverseKeysDeep(basicWebapp) as IaPDocument);
    expect(shuffled.hash).toBe(base.hash);
    for (const view of GLOBAL_VIEWS) {
      expect(toMermaid(deriveView(shuffled, view))).toBe(toMermaid(deriveView(base, view)));
      expect(toDot(deriveView(shuffled, view))).toBe(toDot(deriveView(base, view)));
    }
    const options = { application: 'storefront-app' };
    expect(toMermaid(deriveView(shuffled, 'application', options))).toBe(
      toMermaid(deriveView(base, 'application', options)),
    );
  });

  it('repeated derivation of the same model is byte-identical', () => {
    for (const view of GLOBAL_VIEWS) {
      expect(toMermaid(deriveView(base, view))).toBe(toMermaid(deriveView(base, view)));
    }
  });
});

describe('architecture view semantics (§18.2.1)', () => {
  const graph = deriveView(base, 'architecture');

  it('contains no dependsOn edges', () => {
    expect(graph.edges.some((e) => e.type === 'dependsOn')).toBe(false);
    // enterprise-pci authors an explicit dependsOn edge — it must not survive.
    const pci = deriveView(modelOf(loadExample('enterprise-pci.iap.yaml')), 'architecture');
    expect(pci.edges.some((e) => e.type === 'dependsOn')).toBe(false);
  });

  it('renders storefront-app as a group (container), never as a node', () => {
    expect(graph.nodes.some((n) => n.id === 'storefront-app')).toBe(false);
    const group = graph.groups?.find((g) => g.id === 'storefront-app');
    expect(group).toBeDefined();
    expect(group?.members).toEqual(['assets', 'edge', 'orders-db', 'session-cache', 'web']);
    expect(graph.nodes.find((n) => n.id === 'web')?.group).toBe('storefront-app');
    expect(graph.nodes.find((n) => n.id === 'web-identity')?.group).toBeUndefined();
  });

  it('labels edges with the §18.3 template (verb, protocol/port, path, access)', () => {
    const connects = graph.edges.find((e) => e.id === 'web--connectsTo--orders-db');
    expect(connects?.label).toBe('connectsTo tcp/5432 (read-write)');
    const routes = graph.edges.find((e) => e.id === 'edge--routesTo--web');
    expect(routes?.label).toBe('routesTo https /');
  });

  it('filters by kind and by labels, dropping edges with a removed endpoint', () => {
    const dbOnly = deriveView(base, 'architecture', { filter: { kinds: ['Database'] } });
    expect(dbOnly.nodes.map((n) => n.id)).toEqual(['orders-db']);
    expect(dbOnly.edges).toEqual([]);
    const dataTier = deriveView(base, 'architecture', { filter: { labels: { tier: 'data' } } });
    expect(dataTier.nodes.map((n) => n.id)).toEqual(['assets', 'orders-db', 'session-cache']);
    expect(dataTier.edges).toEqual([]);
    expect(dataTier.groups?.find((g) => g.id === 'storefront-app')?.members).toEqual([
      'assets',
      'orders-db',
      'session-cache',
    ]);
  });
});

describe('dependency view semantics (§18.2.2)', () => {
  const graph = deriveView(base, 'dependency');

  it('draws the ordering DAG in provisioning direction: orders-db before web', () => {
    const arc = graph.edges.find((e) => e.id === 'orders-db--ordering--web');
    expect(arc).toBeDefined();
    expect(arc?.source).toBe('orders-db');
    expect(arc?.target).toBe('web');
  });

  it('uses no edge labels and no containers', () => {
    expect(graph.edges.every((e) => e.label === undefined)).toBe(true);
    expect(graph.groups).toBeUndefined();
  });

  it('only resources participating in ordering appear', () => {
    for (const node of graph.nodes) {
      const participates = graph.edges.some((e) => e.source === node.id || e.target === node.id);
      expect(participates, `${node.id} participates in ordering`).toBe(true);
    }
  });
});

describe('network view semantics (§18.2.3)', () => {
  const graph = deriveView(base, 'network');

  it('places nodes in their materialized exposure zone (default private)', () => {
    expect(graph.nodes.find((n) => n.id === 'edge')?.zone).toBe('public');
    expect(graph.nodes.find((n) => n.id === 'web')?.zone).toBe('internal');
    expect(graph.nodes.find((n) => n.id === 'orders-db')?.zone).toBe('private');
  });

  it('always emits the three nested zone containers, outermost to innermost', () => {
    expect(graph.groups?.map((g) => g.id)).toEqual([
      'zone-public',
      'zone-internal',
      'zone-private',
    ]);
    const mermaid = toMermaid(graph);
    const publicAt = mermaid.indexOf('subgraph zone-public["zone: public"]');
    const internalAt = mermaid.indexOf('subgraph zone-internal["zone: internal"]');
    const privateAt = mermaid.indexOf('subgraph zone-private["zone: private"]');
    expect(publicAt).toBeGreaterThanOrEqual(0);
    expect(internalAt).toBeGreaterThan(publicAt);
    expect(privateAt).toBeGreaterThan(internalAt);
    expect(graph.groups?.find((g) => g.id === 'zone-internal')?.members).toContain('web');
    expect(graph.groups?.find((g) => g.id === 'zone-private')?.members).toContain('orders-db');
  });

  it('carries only connectsTo/routesTo edges, labeled protocol/port without the verb', () => {
    expect(graph.edges.every((e) => e.type === 'connectsTo' || e.type === 'routesTo')).toBe(true);
    expect(graph.edges.find((e) => e.id === 'web--connectsTo--orders-db')?.label).toBe('tcp/5432');
    // Application, Identity, and Secret are never network nodes.
    expect(graph.nodes.some((n) => n.kind === 'Application' || n.kind === 'Identity')).toBe(false);
    // storesDataIn/authenticatedBy edges never appear.
    expect(graph.edges.some((e) => e.type === 'storesDataIn')).toBe(false);
  });
});

describe('security view semantics (§18.2.4)', () => {
  const graph = deriveView(base, 'security');

  it('labels access-carrying edges with the derived access level', () => {
    const connects = graph.edges.find((e) => e.id === 'web--connectsTo--orders-db');
    expect(connects?.label).toBe('connectsTo (read-write)');
    const auth = graph.edges.find((e) => e.id === 'web--authenticatedBy--web-identity');
    expect(auth?.label).toBe('authenticatedBy');
  });

  it('derives «atRest:required» encryption badges from the materialized spec', () => {
    const db = graph.nodes.find((n) => n.id === 'orders-db');
    expect(db?.badges).toContain('atRest:required');
    expect(db?.badges).toContain('inTransit:required');
    expect(toMermaid(graph)).toContain('«atRest:required»');
  });

  it('includes identities and every endpoint of a protection or access edge', () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('web-identity'); // Identity kind, always included
    expect(ids).toContain('web'); // endpoint of access + authenticatedBy edges
    expect(ids).toContain('orders-db'); // endpoint of an access-carrying edge
    expect(ids).not.toContain('edge'); // routesTo carries no access attribute
  });
});

describe('application view semantics (§18.2.5)', () => {
  const graph = deriveView(base, 'application', { application: 'storefront-app' });

  it('contains exactly the Application components as grouped nodes', () => {
    const componentNodes = graph.nodes.filter((n) => n.group === 'storefront-app');
    expect(componentNodes.map((n) => n.id)).toEqual([
      'assets',
      'edge',
      'orders-db',
      'session-cache',
      'web',
    ]);
    expect(graph.groups).toEqual([
      {
        id: 'storefront-app',
        label: 'storefront-app (Application)',
        members: ['assets', 'edge', 'orders-db', 'session-cache', 'web'],
      },
    ]);
  });

  it('renders boundary-crossing endpoints as dashed external nodes', () => {
    const external = graph.nodes.find((n) => n.id === 'web-identity');
    expect(external?.style).toBe('external');
    expect(external?.group).toBeUndefined();
    expect(toMermaid(graph)).toContain('classDef external');
    expect(toDot(graph)).toContain('style=dashed');
  });

  it('keeps every semantic edge touching a component', () => {
    const ids = graph.edges.map((e) => e.id);
    expect(ids).toContain('edge--routesTo--web');
    expect(ids).toContain('web--connectsTo--orders-db');
    expect(ids).toContain('web--authenticatedBy--web-identity');
    expect(graph.edges.some((e) => e.type === 'dependsOn')).toBe(false);
  });

  it('requires options.application and a real Application resource', () => {
    expect(() => deriveView(base, 'application')).toThrow(/options\.application/);
    expect(() => deriveView(base, 'application', { application: 'web' })).toThrow(
      /not an Application/,
    );
  });
});

describe('diffViews (plan-as-architecture-change; drift overlay mechanism)', () => {
  it('marks profile-driven spec changes as changed, untouched resources as unchanged', () => {
    const production = modelOf(basicWebapp, 'production');
    const diff = diffViews(
      deriveView(base, 'architecture'),
      deriveView(production, 'architecture'),
    );
    const styleOf = (id: string): string | undefined => diff.nodes.find((n) => n.id === id)?.style;
    expect(styleOf('web')).toBe('changed'); // size/scaling/availability overridden
    expect(styleOf('orders-db')).toBe('changed'); // availability overridden
    expect(styleOf('session-cache')).toBe('unchanged');
    expect(styleOf('assets')).toBe('unchanged');
    expect(diff.edges.every((e) => e.style === 'unchanged')).toBe(true);
  });

  it('marks synthetic additions as added and reverse diffs as removed', () => {
    const extended = structuredClone(basicWebapp);
    extended.resources['audit-log'] = { kind: 'ObjectStore', spec: {} };
    extended.resources['web']?.relationships?.push({
      type: 'storesDataIn',
      target: 'audit-log',
      access: 'read',
    });
    const after = modelOf(extended);
    const forward = diffViews(deriveView(base, 'architecture'), deriveView(after, 'architecture'));
    expect(forward.nodes.find((n) => n.id === 'audit-log')?.style).toBe('added');
    expect(forward.edges.find((e) => e.id === 'web--storesDataIn--audit-log')?.style).toBe('added');
    expect(forward.nodes.find((n) => n.id === 'web')?.style).toBe('unchanged');

    const backward = diffViews(deriveView(after, 'architecture'), deriveView(base, 'architecture'));
    expect(backward.nodes.find((n) => n.id === 'audit-log')?.style).toBe('removed');
    expect(backward.edges.find((e) => e.id === 'web--storesDataIn--audit-log')?.style).toBe(
      'removed',
    );

    const mermaid = toMermaid(forward);
    expect(mermaid).toContain(':::added');
    expect(mermaid).toContain('classDef added');
    expect(mermaid).toContain('[added]');
    const backwardMermaid = toMermaid(backward);
    expect(backwardMermaid).toContain(':::removed');
    expect(backwardMermaid).toContain('classDef removed');
  });

  it('refuses to diff mismatched views', () => {
    expect(() => diffViews(deriveView(base, 'network'), deriveView(base, 'security'))).toThrow(
      /cannot diff/,
    );
  });
});

describe('golden snapshots (byte-exact rendering contract)', () => {
  const tiny = parse(`
apiVersion: iap.dev/v1
metadata: { name: tiny }
resources:
  api:
    kind: Service
    spec: { artifact: { type: container-image, reference: registry.example.com/api:1.0.0 } }
    relationships:
      - { type: connectsTo, target: db, port: 5432, protocol: tcp, access: read-write }
  db:
    kind: Database
    spec: { class: relational, engine: postgresql }
`) as IaPDocument;
  const model = modelOf(tiny);

  it('pins the full architecture-view Mermaid source', () => {
    expect(toMermaid(deriveView(model, 'architecture'))).toBe(
      'flowchart TD\n' +
        '  api["api (Service)"]\n' +
        '  db["db (Database)"]\n' +
        '  api -- "connectsTo tcp/5432 (read-write)" --> db\n',
    );
  });

  it('pins the full network-view Mermaid source (nested zones)', () => {
    expect(toMermaid(deriveView(model, 'network'))).toBe(
      'flowchart TD\n' +
        '  subgraph zone-public["zone: public"]\n' +
        '    subgraph zone-internal["zone: internal"]\n' +
        '      subgraph zone-private["zone: private"]\n' +
        '        api["api (Service)"]\n' +
        '        db["db (Database)"]\n' +
        '      end\n' +
        '    end\n' +
        '  end\n' +
        '  api -- "tcp/5432" --> db\n',
    );
  });

  it('pins the full architecture-view DOT source', () => {
    expect(toDot(deriveView(model, 'architecture'))).toBe(
      'digraph "architecture" {\n' +
        '  rankdir=TB;\n' +
        '  node [shape=box];\n' +
        '  "api" [label="api (Service)"];\n' +
        '  "db" [label="db (Database)"];\n' +
        '  "api" -> "db" [label="connectsTo tcp/5432 (read-write)"];\n' +
        '}\n',
    );
  });
});
