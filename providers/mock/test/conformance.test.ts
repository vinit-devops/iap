/**
 * Conformance corpus: every committed case passes through the SDK evaluator
 * (PC-2), the corpus exercises every assertion-format feature (IEP-0012
 * "normative-by-example"), and the attestations demonstrably fail on
 * tampered plans (PC-4 — no vacuous attestations).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { DeriveSpec } from '@iap/provider-sdk';
import { evaluateConformanceCase } from '@iap/provider-sdk';
import { createAttestationRegistry } from '../src/index';
import { corpusDir, mockMapping } from './helpers';

const caseFiles = readdirSync(join(corpusDir, 'cases'))
  .filter((file) => file.endsWith('.case.yaml'))
  .sort();

const loadCase = (file: string): unknown =>
  parse(readFileSync(join(corpusDir, 'cases', file), 'utf8'));

describe('conformance corpus (PC-2)', () => {
  it('ships the expected case files', () => {
    expect(caseFiles).toEqual(['unsupported-kind.case.yaml', 'webshop-core.case.yaml']);
  });

  it.each(caseFiles)('%s passes end to end', (file) => {
    const result = evaluateConformanceCase(loadCase(file), {
      mapping: mockMapping(),
      attestations: createAttestationRegistry(),
      corpusDir,
    });
    expect(
      result.assertions.filter((a) => !a.pass).map((a) => `${a.id}: ${a.actual} (${a.detail})`),
    ).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('webshop-core exercises every verdict the format can expect', () => {
    const result = evaluateConformanceCase(loadCase('webshop-core.case.yaml'), {
      mapping: mockMapping(),
      attestations: createAttestationRegistry(),
      corpusDir,
    });
    expect(result.assertions.map((a) => `${a.id}:${a.actual}`)).toEqual([
      'storage-encrypted:satisfied',
      'db-private:satisfied',
      'db-multi-zone:satisfied',
      'region-pinned:satisfied',
      'jobs-fifo:satisfied',
      'emails-unordered:satisfied',
      'token-rotation:satisfied',
      'db-backup-unattested:unsupported',
      'availability-maximum-fails-closed:rejected',
    ]);
  });

  it('the rejected assertions carry the precise fail-closed diagnostics', () => {
    const webshop = evaluateConformanceCase(loadCase('webshop-core.case.yaml'), {
      mapping: mockMapping(),
      attestations: createAttestationRegistry(),
      corpusDir,
    });
    expect(
      webshop.assertions.find((a) => a.id === 'availability-maximum-fails-closed')?.detail,
    ).toContain('unsupported-value');

    const unsupportedKind = evaluateConformanceCase(loadCase('unsupported-kind.case.yaml'), {
      mapping: mockMapping(),
      attestations: createAttestationRegistry(),
      corpusDir,
    });
    expect(unsupportedKind.pass).toBe(true);
    expect(unsupportedKind.assertions[0]?.detail).toContain('unsupported-kind');
  });
});

describe('tampered plans (PC-4: attestations can fail)', () => {
  const tamper = (mutate: (derive: Record<string, DeriveSpec>) => void, kind: string) => {
    const mapping = mockMapping();
    const derive = mapping.mappings[kind]?.realize[0]?.derive;
    if (!derive) throw new Error(`no derive on ${kind}`);
    mutate(derive);
    return mapping;
  };

  it('a silently weakened encryption floor is caught by the attestation', () => {
    const mapping = tamper((derive) => {
      derive['mock:core:Store.encrypted'] = { constant: false };
    }, 'Database');
    const result = evaluateConformanceCase(loadCase('webshop-core.case.yaml'), {
      mapping,
      attestations: createAttestationRegistry(),
      corpusDir,
    });
    expect(result.pass).toBe(false);
    const encrypted = result.assertions.find((a) => a.id === 'storage-encrypted');
    expect(encrypted?.actual).toBe('violated');
    expect(encrypted?.detail).toMatch(/attestation failed.*mock:core:Store/s);
    // The failure is precise: untampered assertions still hold.
    expect(result.assertions.find((a) => a.id === 'db-private')?.pass).toBe(true);
    expect(result.assertions.find((a) => a.id === 'token-rotation')?.pass).toBe(true);
  });

  it('a fifo queue realized without ordering is caught by the attestation', () => {
    const mapping = tamper((derive) => {
      derive['fifo'] = { constant: false };
    }, 'Queue');
    const result = evaluateConformanceCase(loadCase('webshop-core.case.yaml'), {
      mapping,
      attestations: createAttestationRegistry(),
      corpusDir,
    });
    expect(result.pass).toBe(false);
    expect(result.assertions.find((a) => a.id === 'jobs-fifo')?.actual).toBe('violated');
    // The default rule's queues are untouched.
    expect(result.assertions.find((a) => a.id === 'emails-unordered')?.pass).toBe(true);
  });
});
