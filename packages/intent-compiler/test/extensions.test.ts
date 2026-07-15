/**
 * SetExtensionValue is the sole path into `extensions:` and is
 * namespace-scoped (IEP-0009; ch. 11 Extension Non-Interference Rule).
 */
import { describe, expect, it } from 'vitest';
import { canonicalize } from '@iap/model';
import type { IaPDocument } from '@iap/model';
import { apply } from '../src/index';
import { batch, fixtureDocument, op } from './helpers';

function stripExtensions(document: IaPDocument): IaPDocument {
  const stripped = structuredClone(document);
  delete stripped.extensions;
  for (const entry of Object.values(stripped.resources)) {
    delete entry.extensions;
  }
  return stripped;
}

describe('namespace scoping', () => {
  it('all written paths land under extensions.<namespace> — escape is impossible by construction', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op('op-1', 'SetExtensionValue', { namespace: 'aws' }, { set: { version: '1.4.0' } }),
        op(
          'op-2',
          'SetExtensionValue',
          { namespace: 'aws', resourceId: 'orders-db' },
          {
            set: {
              'database.instanceFamily': 'memory-optimized',
              'database.performanceInsights': 'enabled',
            },
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const extensionWrites = outcome.result.provenance.filter(
      (record) => record.operationId === 'op-1' || record.operationId === 'op-2',
    );
    expect(extensionWrites.length).toBeGreaterThan(0);
    expect(
      extensionWrites.every(
        (record) =>
          record.path.startsWith('extensions.aws.') ||
          record.path.startsWith('resources.orders-db.extensions.aws.'),
      ),
    ).toBe(true);
  });

  it('two namespaces stay isolated', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'SetExtensionValue',
          { namespace: 'aws', resourceId: 'web' },
          {
            set: { instanceHint: 'memory-optimized' },
          },
        ),
        op(
          'op-2',
          'SetExtensionValue',
          { namespace: 'kubernetes', resourceId: 'web' },
          {
            set: { 'pod.priorityClass': 'high' },
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.document.resources.web?.extensions).toEqual({
      aws: { instanceHint: 'memory-optimized' },
      kubernetes: { pod: { priorityClass: 'high' } },
    });
  });

  it('unsetting the last key drops the namespace block (authored absence round-trips)', async () => {
    const withValue = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'SetExtensionValue',
          { namespace: 'aws', resourceId: 'web' },
          {
            set: { instanceHint: 'memory-optimized' },
          },
        ),
      ),
    );
    expect(withValue.ok).toBe(true);
    if (!withValue.ok) return;
    const cleared = await apply(
      withValue.result.document,
      batch(
        op(
          'op-2',
          'SetExtensionValue',
          { namespace: 'aws', resourceId: 'web' },
          {
            unset: ['instanceHint'],
          },
        ),
      ),
    );
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.result.document.resources.web?.extensions).toBeUndefined();
    expect(cleared.result.canonicalHash).toBe(canonicalize(fixtureDocument()).hash);
  });
});

describe('non-interference (ch. 11 §11.3)', () => {
  it('deleting every extensions block from the committed document restores the base semantics', async () => {
    const base = fixtureDocument();
    const outcome = await apply(
      base,
      batch(
        op('op-1', 'SetExtensionValue', { namespace: 'aws' }, { set: { version: '1.4.0' } }),
        op(
          'op-2',
          'SetExtensionValue',
          { namespace: 'aws', resourceId: 'orders-db' },
          {
            set: { 'database.instanceFamily': 'memory-optimized' },
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The deletion test: stripping extensions yields the identical canonical
    // core — the operations refined realization without touching semantics.
    const strippedHash = canonicalize(stripExtensions(outcome.result.document)).hash;
    expect(strippedHash).toBe(canonicalize(base).hash);
  });

  it('core operations cannot write extensions, and extension operations cannot write core', async () => {
    const coreIntoExtensions = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'web' },
          { set: { 'extensions.aws.hint': 'x' } },
        ),
      ),
    );
    expect(coreIntoExtensions.ok).toBe(false);
    if (!coreIntoExtensions.ok) {
      expect(coreIntoExtensions.refusals[0]?.code).toBe('extension-namespace-violation');
    }

    // The extension operation writes ONLY under its namespace: a "spec.size"
    // path lands at extensions.aws.spec.size, not at the core spec.
    const extensionIntoCore = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'SetExtensionValue',
          { namespace: 'aws', resourceId: 'web' },
          {
            set: { 'spec.size': 'xl' },
          },
        ),
      ),
    );
    expect(extensionIntoCore.ok).toBe(true);
    if (extensionIntoCore.ok) {
      expect(extensionIntoCore.result.document.resources.web?.spec?.size).toBeUndefined();
      expect(extensionIntoCore.result.document.resources.web?.extensions?.aws).toEqual({
        spec: { size: 'xl' },
      });
    }
  });

  it('unknown namespaces warn (IAP802) and never fail (ch. 11 §11.4)', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op('op-1', 'SetExtensionValue', { namespace: 'somevendor' }, { set: { version: '0.1.0' } }),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const warning = outcome.result.findings.find((finding) => finding.code === 'IAP802');
    expect(warning?.severity).toBe('warning');
  });
});
