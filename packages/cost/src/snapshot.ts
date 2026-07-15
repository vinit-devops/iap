/**
 * Price snapshots — the ONLY pricing input at computation time (spec ch. 16
 * §16.1/§16.9, IEP-0005). A snapshot is a versioned, content-addressed capture
 * of provider list prices; the engine never performs live lookups, so a report
 * is byte-reproducible from a snapshot's content address. Snapshots are
 * produced/refreshed out of band (e.g. via MCP pricing sources) and vendored.
 */
import { readFileSync } from 'node:fs';
import { canonicalJsonStringify, sha256Hex } from '@iap/model';
import type { JsonSchema } from '@iap/model';
import { createValidator } from '@iap/parser';
import type { ValidateFunction } from 'ajv';

/** One SKU's list price. `unit` is the billing unit `amount` is expressed per. */
export interface PriceEntry {
  unit: string;
  amount: number;
  note?: string;
}

/** A versioned capture of provider list prices (`price-snapshot-v1`). */
export interface PriceSnapshot {
  formatVersion: 1;
  id: string;
  provider: string;
  /** ISO 4217 currency; one per snapshot. */
  currency: string;
  region: string;
  /** RFC 3339 pricing timestamp. */
  asOf: string;
  source: string;
  /** SKU key → list price. Opaque to the engine; a cost model references keys. */
  prices: Record<string, PriceEntry>;
}

let cachedSchema: JsonSchema | undefined;
/** The embedded price-snapshot-v1 schema (parsed, cached; drift-tested vs spec/schema). */
export function priceSnapshotSchema(): JsonSchema {
  cachedSchema ??= JSON.parse(
    readFileSync(new URL('../schemas/price-snapshot-v1.schema.json', import.meta.url), 'utf8'),
  ) as JsonSchema;
  return cachedSchema;
}

let cachedValidator: ValidateFunction | undefined;

export interface SnapshotValidation {
  ok: boolean;
  errors: string[];
}

/** Structurally validate a candidate snapshot against the companion schema. */
export function validateSnapshot(candidate: unknown): SnapshotValidation {
  cachedValidator ??= createValidator(priceSnapshotSchema());
  const ok = cachedValidator(candidate) as boolean;
  const errors = ok
    ? []
    : (cachedValidator.errors ?? []).map((e) =>
        `${e.instancePath || '/'} ${e.message ?? ''}`.trim(),
      );
  return { ok, errors };
}

/**
 * The snapshot's content address: `<id>#sha256:<hex>` over the canonical JSON
 * of the snapshot bytes. This is the reference a cost report records so every
 * amount is attributable to an exact, unforgeable pricing input (§16.9).
 */
export function snapshotContentAddress(snapshot: PriceSnapshot): string {
  return `${snapshot.id}#sha256:${sha256Hex(canonicalJsonStringify(snapshot))}`;
}

/** Load and validate a snapshot from a JSON file; throws on structural invalidity. */
export function loadSnapshot(path: string): PriceSnapshot {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const validation = validateSnapshot(parsed);
  if (!validation.ok) {
    throw new TypeError(`invalid price snapshot ${path}: ${validation.errors.join('; ')}`);
  }
  return parsed as PriceSnapshot;
}

/** The bundled reference (illustrative) price snapshot, for demonstration and tests. */
export function referenceSnapshot(): PriceSnapshot {
  return JSON.parse(
    readFileSync(new URL('../snapshots/reference-cloud.snapshot.json', import.meta.url), 'utf8'),
  ) as PriceSnapshot;
}
