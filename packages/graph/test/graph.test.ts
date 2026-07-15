import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { flattenEdges } from '@iap/model';
import type { IaPDocument } from '@iap/model';
import {
  EDGE_ATTRIBUTES_BY_VERB,
  VERB_TARGET_KINDS,
  attributeViolations,
  buildGraph,
  dependencies,
  dependents,
  deriveOrdering,
  detectCycles,
  executionWaves,
  pathExists,
  verbKindViolation,
} from '../src/index';
import type { IaPGraph } from '../src/index';

function doc(yamlText: string): IaPDocument {
  return parse(yamlText) as IaPDocument;
}

function graphOf(document: IaPDocument): IaPGraph {
  const flattened = flattenEdges(document);
  return buildGraph(
    document.resources as unknown as Record<string, { kind: string }>,
    flattened.edges,
  );
}

/** The ch. 9 §9.6 worked example (gateway → api → db/cache/identity, job → db). */
const checkout = doc(`
apiVersion: iap.dev/v1
metadata: { name: checkout }
resources:
  gateway:
    kind: Gateway
    spec: { exposure: public }
    relationships:
      - { type: routesTo, target: api, path: /, protocol: https }
  api:
    kind: Service
    spec: { artifact: { type: container-image, reference: registry.example.com/api:1.0.0 } }
    relationships:
      - { type: connectsTo, target: db, port: 5432, protocol: tcp, access: read-write }
      - { type: connectsTo, target: cache, port: 6379, protocol: tcp, access: read-write }
      - { type: authenticatedBy, target: identity }
  job:
    kind: Job
    spec: { artifact: { type: container-image, reference: registry.example.com/migrate:1.0.0 } }
    relationships:
      - { type: dependsOn, target: db }
  db:
    kind: Database
    spec: { class: relational, engine: postgresql }
  cache:
    kind: Cache
    spec: { engine: redis-compatible }
  identity:
    kind: Identity
`);

describe('buildGraph', () => {
  it('indexes nodes, outgoing, incoming, and edgesByType', () => {
    const graph = graphOf(checkout);
    expect(graph.nodes.get('db')).toBe('Database');
    expect(graph.nodes.size).toBe(6);
    expect(graph.edges).toHaveLength(5);
    expect(graph.outgoing.get('api')?.map((e) => e.target)).toEqual(['cache', 'db', 'identity']);
    expect(
      graph.incoming
        .get('db')
        ?.map((e) => e.source)
        .sort(),
    ).toEqual(['api', 'job']);
    expect(graph.edgesByType.get('connectsTo')).toHaveLength(2);
    expect(graph.edgesByType.get('routesTo')?.[0]?.target).toBe('api');
  });
});

describe('verb/target-kind constraint table (ch. 4 §4.3.1)', () => {
  it('encodes the normative closed lists', () => {
    expect(VERB_TARGET_KINDS.routesTo).toEqual(['Service', 'Function', 'Gateway']);
    expect(VERB_TARGET_KINDS.publishesTo).toEqual(['Topic', 'Queue']);
    expect(VERB_TARGET_KINDS.consumesFrom).toEqual(['Queue', 'Topic', 'Stream']);
    expect(VERB_TARGET_KINDS.storesDataIn).toEqual(['ObjectStore', 'Volume', 'Database']);
    expect(VERB_TARGET_KINDS.authenticatedBy).toEqual(['Identity']);
    expect(VERB_TARGET_KINDS.monitoredBy).toEqual(['Dashboard', 'Alert']);
  });

  it('accepts the legal combinations of the checkout example', () => {
    const graph = graphOf(checkout);
    for (const edge of graph.edges) {
      expect(
        verbKindViolation(edge.type, graph.nodes.get(edge.source), graph.nodes.get(edge.target)),
      ).toBeNull();
    }
  });

  it('rejects routesTo to a Volume and storesDataIn to a Service', () => {
    expect(verbKindViolation('routesTo', 'Gateway', 'Volume')).toMatch(/routesTo target/);
    expect(verbKindViolation('storesDataIn', 'Service', 'Service')).toMatch(/storesDataIn target/);
  });

  it('requires replicatesTo endpoints to share a kind', () => {
    expect(verbKindViolation('replicatesTo', 'Database', 'Database')).toBeNull();
    expect(verbKindViolation('replicatesTo', 'Database', 'ObjectStore')).toMatch(/same kind/);
  });

  it('excludes Application, Identity, and Secret as connectsTo targets', () => {
    expect(verbKindViolation('connectsTo', 'Service', 'Identity')).toMatch(/network-addressable/);
    expect(verbKindViolation('connectsTo', 'Service', 'Secret')).toMatch(/network-addressable/);
    expect(verbKindViolation('connectsTo', 'Service', 'Database')).toBeNull();
  });

  it('allows Application endpoints only on dependsOn', () => {
    expect(verbKindViolation('dependsOn', 'Application', 'Service')).toBeNull();
    expect(verbKindViolation('dependsOn', 'Service', 'Application')).toBeNull();
    expect(verbKindViolation('monitoredBy', 'Application', 'Alert')).toMatch(/Application/);
    expect(verbKindViolation('protectedBy', 'Service', 'Application')).toMatch(/Application/);
  });

  it('never reports dangling (unknown-kind) endpoints — that is phase 2', () => {
    expect(verbKindViolation('routesTo', 'Gateway', undefined)).toBeNull();
    expect(verbKindViolation('routesTo', undefined, 'Volume')).toBeNull();
  });
});

describe('attribute/verb validity table (ch. 4 §4.4)', () => {
  it('encodes the normative matrix', () => {
    expect(EDGE_ATTRIBUTES_BY_VERB.connectsTo).toEqual(['port', 'protocol', 'access']);
    expect(EDGE_ATTRIBUTES_BY_VERB.routesTo).toEqual(['port', 'protocol', 'path', 'host']);
    expect(EDGE_ATTRIBUTES_BY_VERB.storesDataIn).toEqual(['access']);
    expect(EDGE_ATTRIBUTES_BY_VERB.dependsOn).toEqual([]);
    expect(EDGE_ATTRIBUTES_BY_VERB.publishesTo).toEqual([]);
    expect(EDGE_ATTRIBUTES_BY_VERB.consumesFrom).toEqual([]);
  });

  it('flags path/host outside routesTo and access outside connectsTo/storesDataIn', () => {
    expect(
      attributeViolations({
        source: 'api',
        type: 'connectsTo',
        target: 'db',
        attributes: { port: 5432, path: '/orders', host: 'db.internal' },
      }),
    ).toEqual(['host', 'path']);
    expect(
      attributeViolations({
        source: 'a',
        type: 'dependsOn',
        target: 'b',
        attributes: { access: 'read' },
      }),
    ).toEqual(['access']);
  });

  it('accepts the full legal attribute sets', () => {
    expect(
      attributeViolations({
        source: 'gw',
        type: 'routesTo',
        target: 'api',
        attributes: { port: 443, protocol: 'https', path: '/', host: 'shop.example.com' },
      }),
    ).toEqual([]);
    expect(
      attributeViolations({
        source: 'api',
        type: 'storesDataIn',
        target: 'bucket',
        attributes: { access: 'read-write' },
      }),
    ).toEqual([]);
  });
});

describe('deriveOrdering (ch. 9 §9.2)', () => {
  it('derives target-before-source for every verb except replicatesTo', () => {
    const ordering = deriveOrdering(graphOf(checkout));
    const arcs = ordering.edges.map((a) => `${a.before}->${a.after}`);
    expect(arcs).toEqual(['api->gateway', 'cache->api', 'db->api', 'db->job', 'identity->api']);
  });

  it('excludes replicatesTo — symmetric replication is not an ordering cycle', () => {
    const replicated = doc(`
apiVersion: iap.dev/v1
metadata: { name: replication }
resources:
  db-east:
    kind: Database
    spec: { class: relational, engine: postgresql }
    relationships: [{ type: replicatesTo, target: db-west }]
  db-west:
    kind: Database
    spec: { class: relational, engine: postgresql }
    relationships: [{ type: replicatesTo, target: db-east }]
`);
    const graph = graphOf(replicated);
    expect(graph.edges).toHaveLength(2);
    expect(deriveOrdering(graph).edges).toEqual([]);
    expect(detectCycles(deriveOrdering(graph))).toEqual([]);
  });

  it('collapses multiple constraints between the same pair to one arc (rule 4)', () => {
    const multi = doc(`
apiVersion: iap.dev/v1
metadata: { name: multi }
resources:
  api:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/a:1 } }
    relationships:
      - { type: dependsOn, target: db }
      - { type: connectsTo, target: db, port: 5432, protocol: tcp }
  db:
    kind: Database
    spec: { class: relational, engine: postgresql }
`);
    const ordering = deriveOrdering(graphOf(multi));
    expect(ordering.edges).toHaveLength(1);
    expect(ordering.edges[0]).toMatchObject({ before: 'db', after: 'api' });
  });
});

describe('detectCycles', () => {
  it('finds a 2-cycle with its full path', () => {
    const cyclic = doc(`
apiVersion: iap.dev/v1
metadata: { name: cyclic }
resources:
  frontend:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/f:1 } }
    relationships: [{ type: dependsOn, target: backend }]
  backend:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/b:1 } }
    relationships: [{ type: dependsOn, target: frontend }]
`);
    expect(detectCycles(deriveOrdering(graphOf(cyclic)))).toEqual([['backend', 'frontend']]);
  });

  it('finds a self-loop as a one-node cycle', () => {
    const selfLoop = doc(`
apiVersion: iap.dev/v1
metadata: { name: self }
resources:
  api:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/a:1 } }
    relationships: [{ type: dependsOn, target: api }]
`);
    expect(detectCycles(deriveOrdering(graphOf(selfLoop)))).toEqual([['api']]);
  });

  it('returns nothing for a DAG', () => {
    expect(detectCycles(deriveOrdering(graphOf(checkout)))).toEqual([]);
  });
});

describe('executionWaves (ch. 9 §9.4)', () => {
  it('layers the checkout example into the specified waves', () => {
    expect(executionWaves(graphOf(checkout))).toEqual([
      ['cache', 'db', 'identity'],
      ['api', 'job'],
      ['gateway'],
    ]);
  });

  it('is independent of resource-map insertion order', () => {
    const reversed = structuredClone(checkout) as unknown as IaPDocument;
    reversed.resources = Object.fromEntries(Object.entries(checkout.resources).reverse());
    expect(Object.keys(reversed.resources)).toEqual(Object.keys(checkout.resources).reverse());
    expect(executionWaves(graphOf(reversed))).toEqual(executionWaves(graphOf(checkout)));
  });

  it('throws on a cyclic ordering relation', () => {
    const cyclic = doc(`
apiVersion: iap.dev/v1
metadata: { name: cyclic }
resources:
  a:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/a:1 } }
    relationships: [{ type: dependsOn, target: b }]
  b:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/b:1 } }
    relationships: [{ type: dependsOn, target: a }]
`);
    expect(() => executionWaves(graphOf(cyclic))).toThrow(/cycle/);
  });
});

describe('impact queries', () => {
  it('dependents is the transitive impact set', () => {
    const graph = graphOf(checkout);
    expect(dependents(graph, 'db')).toEqual(['api', 'gateway', 'job']);
    expect(dependents(graph, 'gateway')).toEqual([]);
  });

  it('dependencies is everything that must exist first', () => {
    const graph = graphOf(checkout);
    expect(dependencies(graph, 'gateway')).toEqual(['api', 'cache', 'db', 'identity']);
    expect(dependencies(graph, 'db')).toEqual([]);
  });

  it('pathExists follows ordering arcs only', () => {
    const graph = graphOf(checkout);
    expect(pathExists(graph, 'db', 'gateway')).toBe(true);
    expect(pathExists(graph, 'cache', 'job')).toBe(false);
    expect(pathExists(graph, 'api', 'api')).toBe(true);
  });
});
