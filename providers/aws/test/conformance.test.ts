/**
 * Conformance-case evaluation (IEP-0012 PC-2), the tampered-plan proof that
 * attestations are not vacuous (PC-4), and engine-level fail-closed behavior
 * on the package's deliberate rejection surface (ch. 12 §12.3).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { canonicalize } from '@iap/model';
import { loadDocument } from '@iap/parser';
import type { MappingArtifact, Scalar } from '@iap/provider-sdk';
import { applyMapping, evaluateConformanceCase } from '@iap/provider-sdk';
import { createAwsAttestations } from '../src/index';
import { canonicalModelFor, coreMapping, corpusDir } from './helpers';

const caseFiles = readdirSync(join(corpusDir, 'cases')).sort();

const runCase = (file: string, mapping: MappingArtifact = coreMapping()) =>
  evaluateConformanceCase(parse(readFileSync(join(corpusDir, 'cases', file), 'utf8')), {
    mapping,
    attestations: createAwsAttestations(),
    corpusDir,
  });

describe('conformance cases (PC-2)', () => {
  it('ships the three required cases', () => {
    expect(caseFiles).toEqual([
      'database-availability-maximum.case.yaml',
      'function-unsupported-kind.case.yaml',
      'webapp-core.case.yaml',
    ]);
  });

  it.each(caseFiles)('%s passes', (file) => {
    expect(runCase(file).pass).toBe(true);
  });

  it('webapp-core evaluates every assertion to its expected verdict', () => {
    const result = runCase('webapp-core.case.yaml');
    expect(result.assertions.map((a) => `${a.id}:${a.actual}`)).toEqual([
      'db-storage-encrypted:satisfied',
      'db-transit-encrypted:satisfied',
      'db-private-exposure:satisfied',
      'db-multi-az:satisfied',
      'cache-at-rest-encrypted:satisfied',
      'cache-transit-encrypted:satisfied',
      'queue-at-rest-encrypted:satisfied',
      'bucket-private-exposure:satisfied',
      'bucket-backup-unattested:unsupported',
    ]);
  });

  it('availability: maximum rejects with a diagnostic naming the field', () => {
    const result = runCase('database-availability-maximum.case.yaml');
    const outcome = result.assertions[0]!;
    expect(outcome.actual).toBe('rejected');
    expect(outcome.detail).toContain('unsupported-value');
    expect(outcome.detail).toContain('spec.availability');
  });

  it('an uncovered kind rejects with unsupported-kind, never a partial plan', () => {
    const result = runCase('function-unsupported-kind.case.yaml');
    const outcome = result.assertions[0]!;
    expect(outcome.actual).toBe('rejected');
    expect(outcome.detail).toContain('unsupported-kind');
  });
});

describe('tampered plans fail attestation (PC-4)', () => {
  it('a weakened storageEncrypted derivation flips db-storage-encrypted to violated', () => {
    const tampered = structuredClone(coreMapping());
    const derive = tampered.mappings.Database!.realize[0]!.derive!;
    derive['aws:rds:DBInstance.storageEncrypted']!.map = { required: false, preferred: false };
    const result = runCase('webapp-core.case.yaml', tampered);
    expect(result.pass).toBe(false);
    const outcomes = new Map(result.assertions.map((a) => [a.id, a]));
    expect(outcomes.get('db-storage-encrypted')!.actual).toBe('violated');
    expect(outcomes.get('db-storage-encrypted')!.detail).toContain('aws:rds:DBInstance');
    // Precise to the one weakened attribute — sibling assertions still hold.
    expect(outcomes.get('db-private-exposure')!.actual).toBe('satisfied');
    expect(outcomes.get('queue-at-rest-encrypted')!.actual).toBe('satisfied');
  });
});

describe('fail-closed engine diagnostics (ch. 12 §12.3)', () => {
  const diagnosticsFor = (model: Parameters<typeof applyMapping>[0]) => {
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.diagnostics;
  };

  it('rejects Database availability: maximum with unsupported-value', () => {
    const diagnostics = diagnosticsFor(
      canonicalModelFor(join(corpusDir, 'corpus', 'database-maximum.iap.yaml')),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        reason: 'unsupported-value',
        resourceId: 'analytics-db',
        field: 'spec.availability',
        value: 'maximum',
      }),
    );
  });

  it('rejects the Function kind with unsupported-kind', () => {
    const diagnostics = diagnosticsFor(
      canonicalModelFor(join(corpusDir, 'corpus', 'function-image-resizer.iap.yaml')),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        reason: 'unsupported-kind',
        resourceId: 'image-resizer',
        kind: 'Function',
      }),
    );
  });

  it('rejects dead-letter redrive intent this realization does not wire', () => {
    const text = [
      'apiVersion: iap.dev/v1',
      'metadata:',
      '  name: dlq-queue',
      'resources:',
      '  events:',
      '    kind: Queue',
      '    spec:',
      '      deadLetter:',
      '        enabled: true',
      '',
    ].join('\n');
    const parsed = loadDocument(text, { filename: 'inline-dlq.iap.yaml' });
    expect(parsed.ok).toBe(true);
    const canonical = canonicalize(parsed.document!, { profile: null });
    const diagnostics = diagnosticsFor(canonical.model);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        reason: 'unsupported-value',
        resourceId: 'events',
        field: 'spec.deadLetter.enabled',
        value: true as Scalar,
      }),
    );
  });
});
