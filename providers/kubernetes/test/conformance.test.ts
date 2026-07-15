/**
 * Conformance-case evaluation (PC-2) and the tampered-plan demonstration
 * (PC-4): every case in `conformance/cases/` passes through the SDK's
 * shared evaluator with this package's attestation registry, and weakening
 * the mapping makes the relevant attestations fail — proving the predicates
 * are not vacuous.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { evaluateConformanceCase } from '@iap/provider-sdk';
import type { DeriveSpec, MappingArtifact } from '@iap/provider-sdk';
import { TARGETS, createAttestationRegistry } from '../src/index';
import { coreMapping, corpusDir } from './helpers';

const casesDir = join(corpusDir, 'cases');

function loadCase(file: string): unknown {
  return parse(readFileSync(join(casesDir, file), 'utf8'));
}

function evaluate(caseInput: unknown, mapping: MappingArtifact = coreMapping()) {
  return evaluateConformanceCase(caseInput, {
    mapping,
    attestations: createAttestationRegistry(),
    corpusDir,
  });
}

describe('conformance corpus (PC-2)', () => {
  const caseFiles = readdirSync(casesDir)
    .filter((file) => file.endsWith('.case.yaml'))
    .sort();

  it('ships the four documented cases', () => {
    expect(caseFiles).toEqual([
      'fail-closed.case.yaml',
      'function-uncovered.case.yaml',
      'queue-fifo.case.yaml',
      'webapp-core.case.yaml',
    ]);
  });

  it.each(caseFiles)('%s passes', (file) => {
    const result = evaluate(loadCase(file));
    const failures = result.assertions
      .filter((a) => !a.pass)
      .map(
        (a) => `${a.id}: expected ${a.expect}, got ${a.actual}${a.detail ? ` — ${a.detail}` : ''}`,
      );
    expect(failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('webapp-core exercises satisfied and unsupported verdicts', () => {
    const result = evaluate(loadCase('webapp-core.case.yaml'));
    expect(result.assertions.map((a) => `${a.id}:${a.actual}`)).toEqual([
      'storage-encrypted:satisfied',
      'transit-encrypted:satisfied',
      'private-exposure:satisfied',
      'assets-private-exposure:satisfied',
      'ha-instances:satisfied',
      'backup-unattested:unsupported',
    ]);
  });

  it('rejected cases carry the fail-closed diagnostic detail', () => {
    const result = evaluate(loadCase('fail-closed.case.yaml'));
    const byId = new Map(result.assertions.map((a) => [a.id, a]));
    expect(byId.get('mysql-engine-fails-closed')?.detail).toContain('unsupported-value');
    expect(byId.get('mysql-engine-fails-closed')?.detail).toContain('spec.engine');
    expect(byId.get('exactly-once-fails-closed')?.detail).toContain('spec.delivery');
  });

  it('the uncovered-kind case is rejected via unsupported-kind', () => {
    const result = evaluate(loadCase('function-uncovered.case.yaml'));
    expect(result.assertions[0]?.actual).toBe('rejected');
    expect(result.assertions[0]?.detail).toContain('unsupported-kind');
  });
});

function weakenedMapping(kind: string, deriveKey: string, weakened: DeriveSpec): MappingArtifact {
  const mapping = structuredClone(coreMapping());
  const rule = mapping.mappings[kind]?.realize[0];
  if (!rule?.derive?.[deriveKey]) {
    throw new Error(`test fixture error: no derive "${deriveKey}" on ${kind} rule 0`);
  }
  rule.derive[deriveKey] = weakened;
  return mapping;
}

describe('tampered plans make attestations fail (PC-4)', () => {
  it('an unencrypted PostgresCluster storage demand is caught as violated', () => {
    const tampered = weakenedMapping(
      'Database',
      `${TARGETS.postgresCluster}.storageClassEncrypted`,
      { constant: false },
    );
    const result = evaluate(loadCase('webapp-core.case.yaml'), tampered);
    expect(result.pass).toBe(false);
    const byId = new Map(result.assertions.map((a) => [a.id, a]));
    expect(byId.get('storage-encrypted')?.actual).toBe('violated');
    expect(byId.get('storage-encrypted')?.detail).toContain(TARGETS.postgresCluster);
    // Precision: only the tampered capability trips; the rest still hold.
    expect(byId.get('transit-encrypted')?.actual).toBe('satisfied');
    expect(byId.get('private-exposure')?.actual).toBe('satisfied');
    expect(byId.get('ha-instances')?.actual).toBe('satisfied');
  });

  it('a NetworkPolicy without default-deny is caught as violated', () => {
    const tampered = weakenedMapping('Database', `${TARGETS.networkPolicy}.defaultDenyIngress`, {
      from: 'spec.exposure',
      map: { private: false },
    });
    const result = evaluate(loadCase('webapp-core.case.yaml'), tampered);
    expect(result.pass).toBe(false);
    const byId = new Map(result.assertions.map((a) => [a.id, a]));
    expect(byId.get('private-exposure')?.actual).toBe('violated');
    // The assets policy was not tampered with — same predicate still holds.
    expect(byId.get('assets-private-exposure')?.actual).toBe('satisfied');
  });

  it('an under-replicated HA database is caught as violated', () => {
    const tampered = weakenedMapping('Database', `${TARGETS.postgresCluster}.instances`, {
      from: 'spec.availability',
      map: { standard: 1, high: 1 },
    });
    const result = evaluate(loadCase('webapp-core.case.yaml'), tampered);
    const byId = new Map(result.assertions.map((a) => [a.id, a]));
    expect(byId.get('ha-instances')?.actual).toBe('violated');
  });
});

describe('attestation registry hygiene', () => {
  it('rejects duplicate registration for the same (capability, target)', () => {
    const registry = createAttestationRegistry();
    expect(() => registry.register('exposure.private', TARGETS.networkPolicy, () => true)).toThrow(
      TypeError,
    );
  });
});
