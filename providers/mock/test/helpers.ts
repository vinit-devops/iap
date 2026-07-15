/** Shared test helpers: corpus loading, canonicalization, and plan building. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { CanonicalModel, IaPDocument } from '@iap/model';
import { canonicalize } from '@iap/model';
import { loadDocument } from '@iap/parser';
import type { MappingArtifact, MappingInputs, ProviderPlan } from '@iap/provider-sdk';
import { applyMapping } from '@iap/provider-sdk';

export const packageDir = join(__dirname, '..');
export const corpusDir = join(packageDir, 'conformance');

export function mockMapping(): MappingArtifact {
  return parse(
    readFileSync(join(packageDir, 'mappings', 'core.iap-map.yaml'), 'utf8'),
  ) as MappingArtifact;
}

/** Load a corpus document (throws unless it is a Conforming Document). */
export function corpusDocument(name: string): IaPDocument {
  const text = readFileSync(join(corpusDir, 'corpus', name), 'utf8');
  const parsed = loadDocument(text, { filename: name });
  if (!parsed.ok || parsed.document === undefined) {
    throw new Error(`corpus document ${name} is not conforming`);
  }
  return parsed.document;
}

export interface WebshopPlanOptions {
  profile?: string | null;
  inputs?: MappingInputs;
  /** Mutate the parsed document before canonicalization (fresh copy per call). */
  mutate?: (document: IaPDocument) => void;
}

export function canonicalWebshop(options: WebshopPlanOptions = {}): CanonicalModel {
  const document = corpusDocument('webshop.iap.yaml');
  options.mutate?.(document);
  const profile = options.profile !== undefined ? options.profile : 'production';
  const canonical = canonicalize(document, { profile });
  const errors = canonical.findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`canonicalization failed: ${errors.map((f) => f.code).join(', ')}`);
  }
  return canonical.model;
}

/** Canonicalize + map the webshop corpus document into a provider plan. */
export function webshopPlan(options: WebshopPlanOptions = {}): ProviderPlan {
  const model = canonicalWebshop(options);
  const result = applyMapping(model, mockMapping(), {
    inputs: options.inputs ?? { deployRegion: 'mock-east-1' },
  });
  if (!result.ok) {
    throw new Error(
      `mapping failed: ${result.diagnostics.map((d) => `${d.reason} ${d.resourceId ?? ''}`).join('; ')}`,
    );
  }
  return result.plan;
}
