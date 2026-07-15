/**
 * End-to-end authoring pipeline (M3.2+M3.3+M3.4 over the M3.1 gate):
 * NL request → rules adapter → facet compiler → clarification engine →
 * confirmation → gate apply → a VALID document through the full ch. 8
 * pipeline — plus the §3.5 incremental commands against the official
 * basic-webapp example with minimal semantic diffs, and determinism of the
 * whole flow.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IaPDocument } from '@iap/model';
import { load, validateExtensions } from '@iap/sdk';
import {
  apply,
  applyClarificationAnswers,
  clarify,
  compileFacets,
  createAdapterSession,
  emptyDocument,
  explainBatch,
  requiredConfirmations,
  rulesAdapter,
} from '../src/index';
import type { ClarifyResult, CompileResult, ExtractionResult } from '../src/index';
import { repoRoot } from './helpers';

const IDENTITY = { actor: 'reviewer@example.com', timestamp: '2026-07-11T12:00:00Z' };
const EXAMPLE = join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml');

interface PipelineRun {
  extraction: ExtractionResult;
  compiled: CompileResult;
  clarified: ClarifyResult;
}

async function pipeline(
  input: string,
  document: IaPDocument,
  requestId = 'req-1',
): Promise<PipelineRun> {
  const session = createAdapterSession(rulesAdapter());
  const outcome = await session.extract({ requestId, input, document });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  const compiled = compileFacets(outcome.result.facets, document, {
    modelId: 'iap-rules@1',
    promptVersion: '1',
  });
  const clarified = await clarify({
    document,
    batch: compiled.batch,
    facets: outcome.result.facets,
    unresolved: compiled.unresolved,
    unparsed: outcome.result.unparsed,
  });
  return { extraction: outcome.result, compiled, clarified };
}

/** Blanket user-input confirmations for whatever still needs one (the human "yes"). */
const confirmAll = (
  run: PipelineRun,
  extra: ReturnType<typeof applyClarificationAnswers>['confirmations'] = [],
) => [
  ...extra,
  ...requiredConfirmations(run.clarified.batch as never)
    .filter((need) => !extra.some((record) => record.operationId === need.operationId))
    .map((need) => ({
      operationId: need.operationId,
      actor: IDENTITY.actor,
      channel: 'user-input' as const,
      timestamp: IDENTITY.timestamp,
    })),
];

const loadExample = async (): Promise<IaPDocument> => {
  const ws = await load({ path: EXAMPLE });
  return structuredClone(ws.document as IaPDocument);
};

describe('NL request → valid document (basic-webapp class)', () => {
  const INPUT =
    'We need a public web app running image registry.example.com/storefront:1.4.2 behind a gateway, ' +
    'with a highly available postgresql 16 database, a redis cache, and object storage for static assets. ' +
    'Production and development environments. Daily backups.';

  it('the full pipeline commits and the result passes the whole ch. 8 pipeline', async () => {
    const base = emptyDocument('basic-webapp');
    const run = await pipeline(INPUT, base);
    expect(run.extraction.unparsed).toEqual([]);
    expect(run.compiled.unsupported).toEqual([]);
    expect(run.clarified.questions).toEqual([]); // nothing ambiguous in the happy path

    const outcome = await apply(base, run.clarified.batch, { confirmations: confirmAll(run) });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    // The committed document reloads and re-validates green end to end.
    const ws = await load(outcome.result.serialize('yaml'));
    expect(ws.ok).toBe(true);
    const findings = [
      ...ws.validate().findings,
      ...ws.policies().findings,
      ...validateExtensions(ws.document as IaPDocument),
    ];
    expect(findings.filter((finding) => finding.severity === 'error')).toEqual([]);

    // The document carries what the request stated.
    const document = outcome.result.document;
    expect(Object.keys(document.resources).sort()).toEqual([
      'assets',
      'cache',
      'db',
      'edge',
      'web',
    ]);
    expect(Object.keys(document.profiles ?? {}).sort()).toEqual(['development', 'production']);

    // OP-4: every written field has provenance citing an operation id.
    expect(outcome.result.provenance.length).toBeGreaterThan(10);
    expect(outcome.result.provenance.every((record) => record.operationId.length > 0)).toBe(true);
  });

  it('the flow is deterministic: the same request twice yields identical batches and bytes', async () => {
    const first = await pipeline(INPUT, emptyDocument('basic-webapp'));
    const second = await pipeline(INPUT, emptyDocument('basic-webapp'));
    expect(JSON.stringify(first.clarified.batch)).toBe(JSON.stringify(second.clarified.batch));

    const outcomeA = await apply(emptyDocument('basic-webapp'), first.clarified.batch, {
      confirmations: confirmAll(first),
    });
    const outcomeB = await apply(emptyDocument('basic-webapp'), second.clarified.batch, {
      confirmations: confirmAll(second),
    });
    expect(outcomeA.ok && outcomeB.ok).toBe(true);
    if (outcomeA.ok && outcomeB.ok) {
      expect(outcomeA.result.serialize('yaml')).toBe(outcomeB.result.serialize('yaml'));
      expect(outcomeA.result.canonicalHash).toBe(outcomeB.result.canonicalHash);
    }
  });

  it('an ambiguous request needs its clarification answered before it commits', async () => {
    const base = emptyDocument('shop');
    const run = await pipeline('We need a web app', base);
    expect(run.clarified.questions.map((question) => question.id)).toEqual(['q-artifact-web']);
    const blocked = await apply(base, run.clarified.batch, { confirmations: confirmAll(run) });
    expect(blocked.ok).toBe(false); // no artifact — fail closed

    const answered = applyClarificationAnswers(
      run.clarified.batch,
      run.clarified.questions,
      [{ questionId: 'q-artifact-web', value: 'registry.example.com/web:1.0.0' }],
      IDENTITY,
    );
    const committed = await apply(base, answered.batch, {
      confirmations: confirmAll(
        { ...run, clarified: { ...run.clarified, batch: answered.batch } },
        answered.confirmations,
      ),
    });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
  });

  it('unsupported capabilities surface as findings and never silently become operations', async () => {
    const base = emptyDocument('shop');
    const run = await pipeline('We need a vpn and a dynamodb table', base);
    expect(run.extraction.unsupported.map((finding) => finding.capability).sort()).toEqual([
      'dynamodb',
      'vpn',
    ]);
    expect(run.compiled.batch).toBeNull();
  });
});

describe('§3.5 incremental commands against the official basic-webapp example', () => {
  const commit = async (command: string) => {
    const base = await loadExample();
    const run = await pipeline(command, base, 'cmd-1');
    expect(run.compiled.batch, `${command} derived no operations`).not.toBeNull();
    const outcome = await apply(base, run.clarified.batch, { confirmations: confirmAll(run) });
    expect(outcome.ok, `${command}: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    return outcome.result;
  };

  it('"Add a cache for the API" adds one cache and wires it to the web service', async () => {
    const result = await commit('Add a cache for the API');
    expect(result.previewDiff.adds).toContain('resources.cache');
    expect(result.previewDiff.removes).not.toContain('resources.web');
    expect(result.previewDiff.destructive).toBe(false);
    const edge = (result.document.resources.web as { relationships: { target: string }[] })
      .relationships;
    expect(edge.some((entry) => entry.target === 'cache')).toBe(true);
  });

  it('"Make the database private" is a semantic no-op (private is the materialized default)', async () => {
    const result = await commit('Make the database private');
    expect(result.previewDiff.adds).toEqual([]);
    expect(result.previewDiff.changes).toEqual([]);
    expect(result.previewDiff.removes).toEqual([]);
  });

  it('"Remove public access" flips exactly the gateway exposure', async () => {
    const result = await commit('Remove public access');
    expect(result.previewDiff.changes).toEqual(['resources.edge.spec.exposure']);
    expect((result.document.resources.edge as { spec: { exposure: string } }).spec.exposure).toBe(
      'internal',
    );
  });

  it('"Move to maximum availability" updates exactly the availability-capable resources', async () => {
    const result = await commit('Move to maximum availability');
    expect(result.previewDiff.changes).toEqual([
      'resources.orders-db.spec.availability',
      'resources.session-cache.spec.availability',
      'resources.web.spec.availability',
    ]);
  });

  it('"Add PCI DSS controls" adds the deterministic policy set and stays valid', async () => {
    const result = await commit('Add PCI DSS controls');
    expect(result.previewDiff.adds).toEqual(['policies']);
    expect((result.document.policies ?? []).map((policy) => policy.id)).toEqual([
      'pci-dss-encryption-at-rest',
      'pci-dss-encryption-in-transit',
      'pci-dss-no-public-data-stores',
      'pci-dss-backup-required',
    ]);
  });

  it('"Add disaster recovery" touches only the resilience of data resources', async () => {
    const result = await commit('Add disaster recovery');
    expect(result.previewDiff.adds).toEqual([
      'resources.assets.spec.resilience.recoveryPointObjective',
      'resources.assets.spec.resilience.recoveryTimeObjective',
    ]);
    expect(result.previewDiff.changes).toEqual(['resources.assets.spec.resilience.backup']);
  });

  it('"Remove the session-cache" removes the resource, its edge, and its application membership', async () => {
    const result = await commit('Remove the session-cache');
    expect(result.previewDiff.removes).toContain('resources.session-cache');
    expect(result.previewDiff.destructive).toBe(false); // Cache is not a stateful kind
    expect(result.document.resources['session-cache']).toBeUndefined();
    const components = (
      result.document.resources['storefront-app'] as { spec: { components: string[] } }
    ).spec.components;
    expect(components).not.toContain('session-cache');
  });

  it('"Explain what changes this request will make" renders prose instead of operations', async () => {
    const base = await loadExample();
    const run = await pipeline('Explain what changes this request will make', base, 'cmd-1');
    expect(run.extraction.explain).toBe(true);
    expect(run.compiled.batch).toBeNull();

    // The explain rendering of a real edit, per §3.5: generated BEFORE saving.
    const edit = await pipeline('Move to maximum availability', base, 'cmd-2');
    const explanation = explainBatch(base, edit.clarified.batch);
    expect(explanation.ok).toBe(true);
    if (explanation.ok) {
      expect(explanation.text).toContain(
        'resources.web.spec.availability: "standard" -> "maximum"',
      );
    }
  });
});
