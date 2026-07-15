/**
 * M3.2 facet model: closed vocabularies, deterministic confidence tiers, and
 * the embedded intent-facets/v1 schema used for adapter structured-output
 * enforcement (strict ajv with the x-iap vocabulary via @iap/parser).
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_TIERS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  EXTRACTION_CHANNELS,
  FACET_TYPES,
  extractRules,
  intentFacetsSchema,
  validateExtractionStructure,
} from '../src/index';
import type { ExtractionResult, IntentFacet } from '../src/index';

const span = { input: 'req-1', start: 0, end: 5, text: 'hello' };

const facet = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  facet: 'availability',
  availability: 'high',
  sourceSpan: span,
  confidence: 0.95,
  channel: 'exact-keyword',
  ...overrides,
});

const result = (facets: unknown[] = [facet()]): ExtractionResult =>
  ({ facets, unparsed: [], unsupported: [] }) as unknown as ExtractionResult;

describe('closed facet vocabularies', () => {
  it('the facet type set is the twenty roadmap §3.2 targets plus removal', () => {
    expect(FACET_TYPES).toEqual([
      'environment',
      'workload',
      'application',
      'data-service',
      'messaging',
      'networking',
      'exposure',
      'identity',
      'secret',
      'availability',
      'scaling',
      'region',
      'backup',
      'recovery-objective',
      'security',
      'compliance',
      'budget',
      'operational',
      'provider-preference',
      'existing-resource',
      'removal',
    ]);
  });

  it('extraction channels are closed at three, with deterministic confidence tiers', () => {
    expect(EXTRACTION_CHANNELS).toEqual(['exact-keyword', 'pattern-match', 'inferred-association']);
    expect(CONFIDENCE_TIERS['exact-keyword']).toBe(0.95);
    expect(CONFIDENCE_TIERS['pattern-match']).toBe(0.85);
    expect(CONFIDENCE_TIERS['inferred-association']).toBe(0.7);
  });

  it('the inferred-association tier sits below the gate threshold: inferred structure always confirms', () => {
    expect(CONFIDENCE_TIERS['inferred-association']).toBeLessThan(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(CONFIDENCE_TIERS['exact-keyword']).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(CONFIDENCE_TIERS['pattern-match']).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_THRESHOLD);
  });
});

describe('intent-facets/v1 schema (structured-output enforcement)', () => {
  it('compiles and is embedded-only (not a spec companion)', () => {
    const schema = intentFacetsSchema() as { $id?: string };
    expect(schema.$id).toBe('https://iap.dev/schema/intent-facets-v1.schema.json');
  });

  it('accepts the rules extractor output for every corpus input', () => {
    const inputs = [
      'A public web app running image registry.example.com/web:1.0.0 behind a gateway with a postgresql database',
      'A messaging system and a monthly limit of $300 with high availability',
      'We need dynamodb and a vpn in eu-west-1',
      'Add PCI DSS controls and disaster recovery',
      'gibberish flurble womble',
    ];
    for (const input of inputs) {
      const extraction = extractRules(input, { inputId: 'req-1' });
      const outcome = validateExtractionStructure(extraction);
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    }
  });

  it('rejects an unknown facet type (the vocabulary is closed)', () => {
    const outcome = validateExtractionStructure(result([facet({ facet: 'vibes' })]));
    expect(outcome.ok).toBe(false);
  });

  it('rejects extra properties on a facet', () => {
    const outcome = validateExtractionStructure(result([facet({ smuggled: true })]));
    expect(outcome.ok).toBe(false);
  });

  it('rejects out-of-range confidence and unknown channels', () => {
    expect(validateExtractionStructure(result([facet({ confidence: 1.5 })])).ok).toBe(false);
    expect(validateExtractionStructure(result([facet({ channel: 'vibes' })])).ok).toBe(false);
  });

  it('rejects a facet without a source span', () => {
    const bad = facet();
    delete bad.sourceSpan;
    expect(validateExtractionStructure(result([bad])).ok).toBe(false);
  });

  it('rejects a subject reference with an out-of-vocabulary kind', () => {
    const bad = facet({ subject: { kind: 'Cluster' } });
    expect(validateExtractionStructure(result([bad])).ok).toBe(false);
  });

  it('rejects a result missing the explicit unparsed/unsupported reports', () => {
    expect(validateExtractionStructure({ facets: [] }).ok).toBe(false);
  });

  it('rejects non-integer usage counts (limits are integer arithmetic only)', () => {
    const value = { ...result(), usage: { inputTokens: 1.5, outputTokens: 2 } };
    expect(validateExtractionStructure(value).ok).toBe(false);
  });

  it('collects all issues with paths (the proposer sees every problem at once)', () => {
    const outcome = validateExtractionStructure(
      result([facet({ facet: 'vibes' }), facet({ confidence: 2 })]),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.length).toBeGreaterThan(1);
      expect(outcome.issues.every((issue) => issue.path.length > 0)).toBe(true);
    }
  });

  it('carries a proposal opaquely (validated separately via validateBatchStructure)', () => {
    const value = { ...result([]), proposal: { anything: 'goes here' } };
    expect(validateExtractionStructure(value).ok).toBe(true);
  });
});

describe('facet value typing', () => {
  it('budget amounts are integers (no floating point feeds a deterministic path)', () => {
    const good: IntentFacet = {
      facet: 'budget',
      amountUsd: 300,
      period: 'monthly',
      sourceSpan: span,
      confidence: 0.95,
      channel: 'exact-keyword',
    };
    expect(validateExtractionStructure(result([good])).ok).toBe(true);
    expect(
      validateExtractionStructure(
        result([facet({ facet: 'budget', period: 'monthly', amountUsd: 299.99 })]),
      ).ok,
    ).toBe(false);
  });

  it('recovery objectives must satisfy the duration grammar', () => {
    const bad = {
      facet: 'recovery-objective',
      rpo: '1 hour',
      sourceSpan: span,
      confidence: 0.95,
      channel: 'exact-keyword',
    };
    expect(validateExtractionStructure(result([bad])).ok).toBe(false);
  });
});
