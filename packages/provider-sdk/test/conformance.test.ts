import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { AttestationInput, MappingArtifact } from '../src/index';
import { AttestationRegistry, evaluateConformanceCase } from '../src/index';

const fixtures = join(__dirname, 'fixtures');
const packageDir = join(fixtures, 'tiny-provider');
const corpusDir = join(packageDir, 'conformance');

const mapping = parse(
  readFileSync(join(packageDir, 'mappings', 'core.iap-map.yaml'), 'utf8'),
) as MappingArtifact;

const fixtureCase = (): unknown =>
  parse(readFileSync(join(corpusDir, 'cases', 'database-core.case.yaml'), 'utf8'));

/** The tiny package's attestations: pure predicates per (capability, target type). */
function tinyAttestations(): AttestationRegistry {
  return new AttestationRegistry()
    .register(
      'encryption.atRest',
      'tiny:sql:Instance',
      ({ resource }: AttestationInput) => resource.desiredAttributes.encrypted === true,
    )
    .register(
      'exposure.private',
      'tiny:sql:Instance',
      ({ resource }: AttestationInput) => resource.desiredAttributes.public === false,
    )
    .register(
      'availability.zonesMinimum',
      'tiny:sql:Instance',
      ({ resource, params }: AttestationInput) =>
        resource.desiredAttributes.multiZone === true && Number(params.min) <= 2,
    );
}

describe('evaluateConformanceCase — fixture case (PC-2)', () => {
  it('evaluates satisfied, unsupported, and rejected assertions correctly', () => {
    const result = evaluateConformanceCase(fixtureCase(), {
      mapping,
      attestations: tinyAttestations(),
      corpusDir,
    });
    expect(result.case).toBe('database-core');
    expect(result.pass).toBe(true);
    expect(result.assertions.map((a) => `${a.id}:${a.actual}`)).toEqual([
      'storage-encrypted:satisfied',
      'private-exposure:satisfied',
      'multi-zone:satisfied',
      'backup-unattested:unsupported',
      'exactly-once-fails-closed:rejected',
    ]);
  });

  it('the rejected assertion carries the fail-closed diagnostic detail', () => {
    const result = evaluateConformanceCase(fixtureCase(), {
      mapping,
      attestations: tinyAttestations(),
      corpusDir,
    });
    const rejected = result.assertions.find((a) => a.id === 'exactly-once-fails-closed');
    expect(rejected?.detail).toContain('unsupported-value');
  });

  it('mappingInputs flow into the generated plan', () => {
    const seen: unknown[] = [];
    const registry = new AttestationRegistry().register(
      'encryption.atRest',
      'tiny:sql:Instance',
      ({ plan }) => {
        seen.push(plan.inputs);
        return true;
      },
    );
    const caseDoc = {
      apiVersion: 'conformance.iap.dev/v1',
      case: 'inputs-flow',
      document: 'corpus/orders.iap.yaml',
      mappingInputs: { discoverySnapshot: 'disc-fixture-01' },
      assertions: [
        {
          id: 'encrypted',
          select: { resource: 'orders-db' },
          capability: 'encryption.atRest',
          expect: 'satisfied',
        },
      ],
    };
    const result = evaluateConformanceCase(caseDoc, { mapping, attestations: registry, corpusDir });
    expect(result.pass).toBe(true);
    expect(seen).toEqual([{ discoverySnapshot: 'disc-fixture-01' }]);
  });
});

describe('evaluateConformanceCase — tampered plans (PC-4: attestations can fail)', () => {
  it('an attestation fails on a plan whose encryption attribute was weakened', () => {
    const tampered = structuredClone(mapping);
    tampered.mappings.Database!.realize[0]!.derive!['tiny:sql:Instance.encrypted'] = {
      constant: false, // silently weakened floor — the attestation must catch it
    };
    const result = evaluateConformanceCase(fixtureCase(), {
      mapping: tampered,
      attestations: tinyAttestations(),
      corpusDir,
    });
    expect(result.pass).toBe(false);
    const encrypted = result.assertions.find((a) => a.id === 'storage-encrypted');
    expect(encrypted?.actual).toBe('violated');
    expect(encrypted?.pass).toBe(false);
    expect(encrypted?.detail).toMatch(/attestation failed.*tiny:sql:Instance/s);
    // The untampered assertions still hold — the failure is precise.
    expect(result.assertions.find((a) => a.id === 'private-exposure')?.pass).toBe(true);
  });
});

describe('evaluateConformanceCase — harness misuse throws', () => {
  it('rejects a case that violates the case schema', () => {
    expect(() =>
      evaluateConformanceCase(
        { apiVersion: 'conformance.iap.dev/v1', case: 'broken' },
        { mapping, attestations: tinyAttestations(), corpusDir },
      ),
    ).toThrow(/conformance-case-v1/);
  });

  it('rejects a select naming a resource the document does not declare', () => {
    const caseDoc = {
      apiVersion: 'conformance.iap.dev/v1',
      case: 'bad-select',
      document: 'corpus/orders.iap.yaml',
      assertions: [
        {
          id: 'a',
          select: { resource: 'missing-db' },
          capability: 'encryption.atRest',
          expect: 'satisfied',
        },
      ],
    };
    expect(() =>
      evaluateConformanceCase(caseDoc, { mapping, attestations: tinyAttestations(), corpusDir }),
    ).toThrow(/does not declare/);
  });

  it('rejects a select whose kind guard mismatches', () => {
    const caseDoc = {
      apiVersion: 'conformance.iap.dev/v1',
      case: 'bad-kind',
      document: 'corpus/orders.iap.yaml',
      assertions: [
        {
          id: 'a',
          select: { resource: 'orders-db', kind: 'Queue' },
          capability: 'encryption.atRest',
          expect: 'satisfied',
        },
      ],
    };
    expect(() =>
      evaluateConformanceCase(caseDoc, { mapping, attestations: tinyAttestations(), corpusDir }),
    ).toThrow(/but it is Database/);
  });

  it('rejects duplicate attestation registration', () => {
    const registry = tinyAttestations();
    expect(() => registry.register('encryption.atRest', 'tiny:sql:Instance', () => true)).toThrow(
      TypeError,
    );
  });
});
