/**
 * Shared test helpers: real desired models via the mock provider's mapping
 * (canonicalize → applyMapping, exactly the ch. 14 §14.1 pipeline the
 * planner sits behind), synthetic provider plans, and state fixtures.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { canonicalJsonStringify, canonicalize, sha256Hex } from '@iap/model';
import type { IaPDocument } from '@iap/model';
import { loadDocument } from '@iap/parser';
import { applyMapping } from '@iap/provider-sdk';
import type { MappingArtifact, PlanResource, ProviderPlan } from '@iap/provider-sdk';
import { PLANNER_VERSION, computeStateIntegrity } from '../src/index';
import type { DeterminismInputs, StateObject, StateSnapshot } from '../src/index';

export const repoRoot = join(__dirname, '..', '..', '..');
const mockDir = join(repoRoot, 'providers', 'mock');

export function mockMapping(): MappingArtifact {
  return parse(
    readFileSync(join(mockDir, 'mappings', 'core.iap-map.yaml'), 'utf8'),
  ) as MappingArtifact;
}

/** Load the mock provider's webshop corpus document (must be conforming). */
export function webshopDocument(): IaPDocument {
  const text = readFileSync(join(mockDir, 'conformance', 'corpus', 'webshop.iap.yaml'), 'utf8');
  const parsed = loadDocument(text, { filename: 'webshop.iap.yaml' });
  if (!parsed.ok || parsed.document === undefined) {
    throw new Error('webshop corpus document is not conforming');
  }
  return parsed.document;
}

export interface WebshopPlanOptions {
  /** Active profile; defaults to production (the corpus profile). */
  profile?: string | null;
  /** Mutate the parsed document before canonicalization (fresh copy per call). */
  mutateDocument?: (document: IaPDocument) => void;
  /** Mutate the mapped provider plan; the planHash is recomputed afterwards. */
  mutatePlan?: (plan: ProviderPlan) => void;
}

/** Canonicalize + map the webshop document into a real provider plan. */
export function webshopPlan(options: WebshopPlanOptions = {}): ProviderPlan {
  const document = webshopDocument();
  options.mutateDocument?.(document);
  const profile = options.profile !== undefined ? options.profile : 'production';
  const canonical = canonicalize(document, { profile });
  const errors = canonical.findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`canonicalization failed: ${errors.map((f) => f.code).join(', ')}`);
  }
  const result = applyMapping(canonical.model, mockMapping());
  if (!result.ok) {
    throw new Error(
      `mapping failed: ${result.diagnostics.map((d) => `${d.reason} ${d.resourceId ?? ''}`).join('; ')}`,
    );
  }
  if (options.mutatePlan === undefined) return result.plan;
  const mutable = structuredClone(result.plan);
  options.mutatePlan(mutable);
  return rehash(mutable);
}

/** Recompute a provider plan's planHash after a test mutation. */
export function rehash(plan: ProviderPlan): ProviderPlan {
  const unhashed: Record<string, unknown> = { ...plan };
  delete unhashed.planHash;
  return { ...plan, planHash: sha256Hex(canonicalJsonStringify(unhashed)) };
}

/** A minimal synthetic provider plan over explicit resources. */
export function syntheticPlan(
  resources: Array<Partial<PlanResource> & { logicalId: string }>,
  outputBindings: ProviderPlan['outputBindings'] = {},
): ProviderPlan {
  const full: PlanResource[] = resources.map((resource) => ({
    type: resource.type ?? 'mock:test:Thing',
    logicalId: resource.logicalId,
    desiredAttributes: resource.desiredAttributes ?? {},
    dependsOn: resource.dependsOn ?? [],
    lifecycle: resource.lifecycle ?? { createOnly: [], replaceOn: [], updateInPlace: [] },
    sensitiveFields: resource.sensitiveFields ?? [],
    provenance: resource.provenance ?? {},
  }));
  return rehash({
    formatVersion: 1,
    provider: 'mock',
    mappingVersion: '1.0.0',
    specVersion: '1.0.0',
    profile: null,
    documentHash: sha256Hex('synthetic-document'),
    inputs: {},
    resources: full,
    outputBindings,
    planHash: '',
  });
}

/**
 * A managed snapshot mirroring the desired plan exactly (every action would
 * be a no-op), with deployed-time dependsOn recorded per object. `mutate`
 * adjusts objects before the integrity hash is computed.
 */
export function stateFromPlan(
  plan: ProviderPlan,
  mutate?: (objects: Record<string, StateObject>) => void,
): StateSnapshot {
  const objects: Record<string, StateObject> = {};
  for (const resource of plan.resources) {
    objects[resource.logicalId] = {
      type: resource.type,
      attributes: { ...resource.desiredAttributes },
      managed: true,
      dependsOn: [...resource.dependsOn],
    };
  }
  mutate?.(objects);
  return { revision: 1, integrity: computeStateIntegrity(objects), objects };
}

/** A fully populated synthetic determinism input vector. */
export function baseInputs(): DeterminismInputs {
  return {
    documentHash: `sha256:${'a'.repeat(64)}`,
    target: { provider: 'mock', profile: 'production' },
    profileHashes: { production: `sha256:${'b'.repeat(64)}` },
    policyBundles: { 'org-baseline': '1.4.0' },
    extensionVersions: { mock: '1.0.0' },
    mappingVersions: { mock: '1.0.0' },
    discoverySnapshot: 'disc-2026-07-09-01',
    pricingSnapshot: 'price-2026-07-01',
    stateRevision: 14,
    stateIntegrity: `sha256:${'c'.repeat(64)}`,
    plannerVersion: PLANNER_VERSION,
  };
}

/** Remove a resource and any profile override for it (document mutation). */
export function removeResource(document: IaPDocument, id: string): void {
  const doc = document as unknown as {
    resources: Record<string, unknown>;
    profiles?: Record<string, { overrides?: { resources?: Record<string, unknown> } }>;
  };
  delete doc.resources[id];
  for (const profile of Object.values(doc.profiles ?? {})) {
    delete profile.overrides?.resources?.[id];
  }
}

/** Recursively rebuild a JSON value with object keys in reverse-sorted order. */
export function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => reverseKeys(item)) as unknown as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort().reverse()) {
      out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}
