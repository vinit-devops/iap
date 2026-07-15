/**
 * The mock provider's cost model (spec ch. 16 §16.1: a cost model is
 * distributed WITH a provider mapping). It prices the mock substrate's
 * realization: every managed resource runs as one uniform substrate node, and
 * stateful kinds add their declared storage. Distinct from the abstract
 * reference model (which does replica/availability math) — the SAME document
 * therefore costs differently per provider, exactly as ch. 16 intends, while
 * sharing the reference snapshot's SKU vocabulary. Pure; no clock, no network.
 */
import type { CanonicalResource } from '@iap/model';
import { parseQuantity } from '@iap/model';
import type { BillItem, CostModel, ResourceDecomposition } from '@iap/cost';

/** Kinds the mock realizes as a running substrate node. */
const NODE_KINDS = new Set(['Service', 'Job', 'Function', 'Gateway', 'Database', 'Cache']);
/** Kinds priced only for their declared storage. */
const STORAGE_KINDS = new Set(['ObjectStore', 'Volume']);
/** Kinds the mock treats as free control-plane objects. */
const FREE_KINDS = new Set([
  'Application',
  'Identity',
  'Secret',
  'Certificate',
  'DnsZone',
  'Network',
  'Queue',
  'Topic',
]);

function storageGiB(spec: Record<string, unknown>): number | null {
  const capacity = spec.capacity;
  if (typeof capacity !== 'object' || capacity === null) return null;
  const raw = (capacity as Record<string, unknown>).storage;
  if (typeof raw !== 'string') return null;
  const parsed = parseQuantity(raw);
  return parsed === null ? null : Number(parsed.milli) / 1000 / 1024 ** 3;
}

/**
 * The mock cost model (`mock-substrate@1.0.0`). Prices against the reference
 * snapshot's SKUs so it can be exercised with the bundled snapshot.
 */
export function mockCostModel(): CostModel {
  return {
    id: 'mock-substrate',
    version: '1.0.0',
    price(resource: CanonicalResource): ResourceDecomposition {
      const spec = resource.spec;
      if (NODE_KINDS.has(resource.kind)) {
        const items: BillItem[] = [{ sku: 'compute.size.m.hour', quantity: 1, period: 'hour' }];
        const assumptions = ['mock realizes this as one uniform m-sized substrate node'];
        const gib = storageGiB(spec);
        if (gib !== null) {
          items.push({ sku: 'storage.block.gib-month', quantity: gib, period: 'month' });
        }
        return { covered: true, confidence: 'estimate', items, assumptions };
      }
      if (STORAGE_KINDS.has(resource.kind)) {
        const gib = storageGiB(spec) ?? 10;
        return {
          covered: true,
          confidence: 'estimate',
          items: [{ sku: 'storage.block.gib-month', quantity: gib, period: 'month' }],
          assumptions: [
            gib === 10
              ? 'mock assumes 10Gi when capacity is unstated'
              : 'priced from declared capacity',
          ],
        };
      }
      if (FREE_KINDS.has(resource.kind)) {
        return {
          covered: true,
          confidence: 'exact',
          items: [],
          assumptions: ['mock control-plane object — no substrate charge'],
        };
      }
      return { covered: false, reason: `the mock cost model does not price kind ${resource.kind}` };
    },
  };
}
