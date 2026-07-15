/**
 * Deterministic optimization suggestions (spec ch. 16 §16.4, IEP-0005). Every
 * suggestion comes from a rule over the document — NEVER model inference (ch.
 * 19) — and is advisory: tools must not modify the document. Each carries a
 * rule id, the resource path, and the projected monthly delta. Rules that need
 * observed utilization (oversizing) are deferred until a versioned utilization
 * input exists; the rules here need only the declared model.
 */
import type { CanonicalModel, CanonicalResource } from '@iap/model';
import type { CostModel } from './model.js';
import type { PriceSnapshot } from './snapshot.js';
import type { CostSuggestion, ResourceCost } from './report.js';

/** Data/messaging kinds whose value depends on an inbound workload edge. */
const STATE_KINDS = new Set(['Database', 'Cache', 'ObjectStore', 'Volume', 'Queue', 'Topic']);

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Re-price a resource as if its availability were `standard`, for savings math. */
function monthlyAtStandard(
  resource: CanonicalResource,
  costModel: CostModel,
  snapshot: PriceSnapshot,
): number | null {
  const downgraded: CanonicalResource = {
    ...resource,
    spec: { ...resource.spec, availability: 'standard' },
  };
  const decomposition = costModel.price(downgraded, '', { currency: snapshot.currency });
  if (!decomposition.covered) return null;
  let monthly = 0;
  for (const item of decomposition.items) {
    const price = snapshot.prices[item.sku];
    if (price === undefined) return null;
    monthly +=
      item.period === 'month' ? item.quantity * price.amount : item.quantity * price.amount * 730;
  }
  return monthly;
}

export interface SuggestContext {
  costModel: CostModel;
  snapshot: PriceSnapshot;
}

/** Produce every suggestion, sorted by (rule, resource) for determinism. */
export function suggestOptimizations(
  model: CanonicalModel,
  resources: Record<string, ResourceCost>,
  ctx: SuggestContext,
): CostSuggestion[] {
  const suggestions: CostSuggestion[] = [];
  const ids = Object.keys(model.resources).sort();

  // Resources that are the target of any edge (inbound reachability).
  const hasInbound = new Set<string>(model.edges.map((edge) => edge.target));

  for (const id of ids) {
    const resource = model.resources[id] as CanonicalResource;
    const entry = resources[id] as ResourceCost;

    // excess-availability: a resource priced above the standard tier.
    const availability = resource.spec.availability;
    if (
      (availability === 'high' || availability === 'maximum') &&
      entry.estimatedMonthly !== undefined
    ) {
      const standard = monthlyAtStandard(resource, ctx.costModel, ctx.snapshot);
      if (standard !== null) {
        const savings = round2(entry.estimatedMonthly - standard);
        if (savings > 0) {
          suggestions.push({
            rule: 'excess-availability',
            resource: id,
            detail: `availability: ${availability} costs ${savings} ${ctx.snapshot.currency}/month more than standard — confirm the redundancy is required`,
            estimatedMonthlySavings: savings,
          });
        }
      }
    }

    // orphaned-resource: a stateful/messaging resource no workload connects to.
    if (
      STATE_KINDS.has(resource.kind) &&
      !hasInbound.has(id) &&
      entry.estimatedMonthly !== undefined
    ) {
      if (entry.estimatedMonthly > 0) {
        suggestions.push({
          rule: 'orphaned-resource',
          resource: id,
          detail: `${resource.kind} "${id}" has no inbound edge from any workload — it may be unused`,
          estimatedMonthlySavings: round2(entry.estimatedMonthly),
        });
      }
    }
  }

  suggestions.sort((a, b) =>
    a.rule === b.rule ? a.resource.localeCompare(b.resource) : a.rule.localeCompare(b.rule),
  );
  return suggestions;
}
