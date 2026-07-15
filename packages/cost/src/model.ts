/**
 * The cost-model contract and the bundled reference model (spec ch. 16 §16.1).
 *
 * A cost model is the "cost functions" input to the report: it DECOMPOSES a
 * canonical resource into billable line items that reference snapshot SKU keys,
 * plus the confidence and the usage assumptions behind an estimate. It never
 * holds prices (those live in the snapshot) and never reads a clock or the
 * network — decomposition is a pure function of the resource. Normatively a
 * cost model is distributed WITH a provider mapping (ch. 12); the reference
 * model here prices abstract kinds directly so the engine and the report format
 * can be exercised before provider-distributed models land (M10.2).
 */
import type { CanonicalResource } from '@iap/model';
import { parseQuantity } from '@iap/model';
import type { CostConfidence } from './report.js';

/** A billable line item referencing a snapshot SKU. `period` selects the amount's basis. */
export interface BillItem {
  sku: string;
  quantity: number;
  period: 'hour' | 'month';
  note?: string;
}

/** A resource priced into line items, or explicitly not covered (→ `unknown`). */
export type ResourceDecomposition =
  | { covered: false; reason: string }
  | {
      covered: true;
      confidence: Exclude<CostConfidence, 'unknown'>;
      items: BillItem[];
      assumptions: string[];
    };

export interface PricingContext {
  currency: string;
}

export interface CostModel {
  id: string;
  version: string;
  /** Decompose one canonical resource into billable items. Pure. */
  price(
    resource: CanonicalResource,
    resourceId: string,
    ctx: PricingContext,
  ): ResourceDecomposition;
}

/* ------------------------------------------------------------------ */
/* Reference-model constants (model logic, never prices)               */
/* ------------------------------------------------------------------ */

const SIZE_SKU: Record<string, string> = {
  xs: 'compute.size.xs.hour',
  s: 'compute.size.s.hour',
  m: 'compute.size.m.hour',
  l: 'compute.size.l.hour',
  xl: 'compute.size.xl.hour',
};
const DEFAULT_COMPUTE_SIZE = 'm';
const DEFAULT_FUNCTION_SIZE = 's';
/** Definite fallback SKUs (used when a size is unrecognized). */
const DEFAULT_COMPUTE_SKU = 'compute.size.m.hour';
const DEFAULT_FUNCTION_SKU = 'compute.size.s.hour';

/** Multi-zone / redundancy factor by availability tier (§16.2 usage-dependent). */
const AVAILABILITY_MULTIPLIER: Record<string, number> = { standard: 1, high: 2, maximum: 3 };
/** Relative price of a database engine class vs. relational. */
const DATABASE_CLASS_MULTIPLIER: Record<string, number> = {
  relational: 1,
  'key-value': 1.2,
  document: 1.1,
  'wide-column': 1.25,
  timeseries: 1.3,
  ledger: 1.5,
  search: 1.4,
  graph: 1.4,
};

const OBJECTSTORE_ASSUMED_GIB = 100;
const CACHE_ASSUMED_GIB = 1;
const MESSAGING_ASSUMED_MMSGS = 10;

/** Kinds that carry no direct compute/storage charge in the reference model. */
const LOGICAL_KINDS = new Set([
  'Application',
  'Identity',
  'Secret',
  'Certificate',
  'DnsZone',
  'Network',
]);

/* ------------------------------------------------------------------ */
/* Quantity helpers                                                    */
/* ------------------------------------------------------------------ */

/** Exact GiB of a storage/memory quantity string (`20Gi` → 20), or null if unparseable. */
export function quantityToGiB(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = parseQuantity(value);
  if (parsed === null) return null;
  // parseQuantity returns milli-bytes; bytes = milli / 1000; GiB = bytes / 1024^3.
  return Number(parsed.milli) / 1000 / 1024 ** 3;
}

/** Numeric magnitude of a throughput quantity (`2000rps` → { value: 2000, unit: 'rps' }). */
export function parseThroughput(value: unknown): { value: number; unit: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)(rps|iops)$/.exec(value);
  if (match === null) return null;
  return { value: Number(match[1]), unit: match[2] as string };
}

function meanReplicas(spec: Record<string, unknown>): number {
  const scaling = spec.scaling;
  if (typeof scaling === 'object' && scaling !== null) {
    const s = scaling as { min?: unknown; max?: unknown };
    if (typeof s.min === 'number' && typeof s.max === 'number') return (s.min + s.max) / 2;
  }
  return 1;
}

function availabilityMultiplier(spec: Record<string, unknown>): number {
  const availability = spec.availability;
  return typeof availability === 'string' ? (AVAILABILITY_MULTIPLIER[availability] ?? 1) : 1;
}

function capacityField(spec: Record<string, unknown>, field: string): unknown {
  const capacity = spec.capacity;
  return typeof capacity === 'object' && capacity !== null
    ? (capacity as Record<string, unknown>)[field]
    : undefined;
}

/* ------------------------------------------------------------------ */
/* The reference cost model                                            */
/* ------------------------------------------------------------------ */

/**
 * The bundled reference cost model (`reference-abstract@1.0.0`). Prices abstract
 * kinds against the reference snapshot's SKUs with transparent, deterministic
 * formulas; illustrative, not real vendor economics. Provider-distributed cost
 * models (M10.2) replace it per target.
 */
export function referenceCostModel(): CostModel {
  return {
    id: 'reference-abstract',
    version: '1.0.0',
    price(resource: CanonicalResource): ResourceDecomposition {
      const spec = resource.spec;
      switch (resource.kind) {
        case 'Service': {
          const size = typeof spec.size === 'string' ? spec.size : DEFAULT_COMPUTE_SIZE;
          const replicas = meanReplicas(spec);
          const avail = availabilityMultiplier(spec);
          const assumptions = [
            `priced size ${size} at ${replicas} mean replica(s)${spec.scaling ? ' across the declared scaling range' : ' (no scaling declared → 1)'}`,
          ];
          if (avail > 1)
            assumptions.push(
              `availability ${String(spec.availability)} priced as ${avail}x redundancy`,
            );
          if (spec.size === undefined)
            assumptions.push(`size unstated → assumed ${DEFAULT_COMPUTE_SIZE}`);
          return {
            covered: true,
            confidence: 'estimate',
            items: [
              {
                sku: SIZE_SKU[size] ?? DEFAULT_COMPUTE_SKU,
                quantity: replicas * avail,
                period: 'hour',
              },
            ],
            assumptions,
          };
        }
        case 'Job': {
          const size = typeof spec.size === 'string' ? spec.size : DEFAULT_COMPUTE_SIZE;
          return {
            covered: true,
            confidence: 'estimate',
            items: [{ sku: SIZE_SKU[size] ?? DEFAULT_COMPUTE_SKU, quantity: 1, period: 'hour' }],
            assumptions: [
              'priced as one continuously-running instance; batch run duration not modeled',
            ],
          };
        }
        case 'Function': {
          const size = typeof spec.size === 'string' ? spec.size : DEFAULT_FUNCTION_SIZE;
          return {
            covered: true,
            confidence: 'estimate',
            items: [{ sku: SIZE_SKU[size] ?? DEFAULT_FUNCTION_SKU, quantity: 1, period: 'hour' }],
            assumptions: [
              'priced as one always-warm baseline instance; per-invocation charges excluded',
            ],
          };
        }
        case 'Gateway':
          return {
            covered: true,
            confidence: 'exact',
            items: [{ sku: 'gateway.hour', quantity: 1, period: 'hour' }],
            assumptions: [],
          };
        case 'Database': {
          const size = typeof spec.size === 'string' ? spec.size : DEFAULT_COMPUTE_SIZE;
          const dbClass = typeof spec.class === 'string' ? spec.class : 'relational';
          const classMult = DATABASE_CLASS_MULTIPLIER[dbClass] ?? 1;
          const avail = availabilityMultiplier(spec);
          const items: BillItem[] = [
            {
              sku: SIZE_SKU[size] ?? DEFAULT_COMPUTE_SKU,
              quantity: classMult * avail,
              period: 'hour',
            },
          ];
          const assumptions = [`instance priced size ${size}, class ${dbClass} (${classMult}x)`];
          if (avail > 1)
            assumptions.push(
              `availability ${String(spec.availability)} priced as ${avail}x redundancy`,
            );
          const storageGiB = quantityToGiB(capacityField(spec, 'storage'));
          if (storageGiB !== null) {
            items.push({
              sku: 'storage.database.gib-month',
              quantity: storageGiB,
              period: 'month',
            });
          }
          const throughput = parseThroughput(capacityField(spec, 'throughput'));
          if (throughput !== null) {
            items.push({
              sku: `throughput.${throughput.unit}.unit-month`,
              quantity: throughput.value,
              period: 'month',
            });
          }
          return { covered: true, confidence: 'estimate', items, assumptions };
        }
        case 'Cache': {
          const avail = availabilityMultiplier(spec);
          const memGiB = quantityToGiB(capacityField(spec, 'memory'));
          const gib = memGiB ?? CACHE_ASSUMED_GIB;
          const assumptions =
            memGiB === null
              ? [`memory unstated → assumed ${CACHE_ASSUMED_GIB}Gi`]
              : [`priced ${gib}Gi in-memory`];
          if (avail > 1)
            assumptions.push(
              `availability ${String(spec.availability)} priced as ${avail}x redundancy`,
            );
          return {
            covered: true,
            confidence: 'estimate',
            items: [{ sku: 'memory.cache.gib-month', quantity: gib * avail, period: 'month' }],
            assumptions,
          };
        }
        case 'ObjectStore':
          return {
            covered: true,
            confidence: 'estimate',
            items: [
              {
                sku: 'storage.object.gib-month',
                quantity: OBJECTSTORE_ASSUMED_GIB,
                period: 'month',
              },
            ],
            assumptions: [
              `assumed ${OBJECTSTORE_ASSUMED_GIB}Gi stored; request and egress charges excluded`,
            ],
          };
        case 'Volume': {
          const storageGiB = quantityToGiB(capacityField(spec, 'storage'));
          if (storageGiB === null) {
            return { covered: false, reason: 'Volume has no declared capacity.storage to price' };
          }
          return {
            covered: true,
            confidence: 'exact',
            items: [{ sku: 'storage.block.gib-month', quantity: storageGiB, period: 'month' }],
            assumptions: [],
          };
        }
        case 'Queue':
        case 'Topic':
          return {
            covered: true,
            confidence: 'estimate',
            items: [
              {
                sku: 'messaging.million-messages',
                quantity: MESSAGING_ASSUMED_MMSGS,
                period: 'month',
              },
            ],
            assumptions: [`assumed ${MESSAGING_ASSUMED_MMSGS} million messages/month`],
          };
        default:
          if (LOGICAL_KINDS.has(resource.kind)) {
            return {
              covered: true,
              confidence: 'exact',
              items: [],
              assumptions: [
                'logical / control-plane resource — no direct compute or storage charge',
              ],
            };
          }
          return {
            covered: false,
            reason: `the reference cost model does not price kind ${resource.kind}`,
          };
      }
    },
  };
}
