/**
 * The cost estimation engine (spec ch. 16 §16.2/§16.3/§16.9). A pure function
 *
 *   (canonical model, cost model, price snapshot) → cost-report/v1
 *
 * Per resource: the cost model decomposes it into billable items; the engine
 * looks each item's SKU up in the snapshot and sums it. A resource the model
 * does not cover — OR one whose SKU is missing from the snapshot — is reported
 * `unknown` with NO numbers and a stated reason (§16.2: honest uncertainty,
 * missing price data visible). Roll-ups aggregate per Application and per label;
 * an aggregate that omits any unknown member is flagged as a lower bound with
 * the weakest member confidence. Deterministic: identical inputs → identical
 * bytes, so a report change is always attributable to the model, the cost
 * model version, or the snapshot.
 */
import type { CanonicalModel, CanonicalResource } from '@iap/model';
import type { CostModel } from './model.js';
import type { PriceSnapshot } from './snapshot.js';
import { snapshotContentAddress } from './snapshot.js';
import type { CostConfidence, CostReport, ResourceCost, Rollup } from './report.js';
import { suggestOptimizations } from './suggest.js';

const HOURS_PER_MONTH = 730;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // Round half away from zero deterministically; costs are non-negative here.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const CONFIDENCE_RANK: Record<CostConfidence, number> = { unknown: 0, estimate: 1, exact: 2 };

/** The weakest (lowest-rank) confidence across a set of members. */
function weakest(confidences: CostConfidence[]): CostConfidence {
  return confidences.reduce<CostConfidence>(
    (acc, c) => (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[acc] ? c : acc),
    'exact',
  );
}

export interface EstimateOptions {
  costModel: CostModel;
  snapshot: PriceSnapshot;
}

/** Price a single resource into a report entry (numbers omitted when unknown). */
function priceResource(
  resource: CanonicalResource,
  resourceId: string,
  costModel: CostModel,
  snapshot: PriceSnapshot,
): ResourceCost {
  const decomposition = costModel.price(resource, resourceId, { currency: snapshot.currency });
  if (!decomposition.covered) {
    return { kind: resource.kind, confidence: 'unknown', assumptions: [decomposition.reason] };
  }

  let hourly = 0;
  let monthly = 0;
  const missing: string[] = [];
  for (const item of decomposition.items) {
    const price = snapshot.prices[item.sku];
    if (price === undefined) {
      missing.push(item.sku);
      continue;
    }
    if (item.period === 'hour') {
      hourly += item.quantity * price.amount;
      monthly += item.quantity * price.amount * HOURS_PER_MONTH;
    } else {
      monthly += item.quantity * price.amount;
      hourly += (item.quantity * price.amount) / HOURS_PER_MONTH;
    }
  }

  // Missing price data is visible, never guessed: the resource degrades to unknown.
  if (missing.length > 0) {
    return {
      kind: resource.kind,
      confidence: 'unknown',
      assumptions: [
        ...decomposition.assumptions,
        `price missing from snapshot for SKU(s): ${[...missing].sort().join(', ')}`,
      ],
    };
  }

  return {
    kind: resource.kind,
    estimatedMonthly: round(monthly, 2),
    estimatedHourly: round(hourly, 4),
    confidence: decomposition.confidence,
    assumptions: decomposition.assumptions,
  };
}

/** Aggregate a set of resource entries into a roll-up (§16.3). */
function rollup(entries: ResourceCost[]): Rollup {
  if (entries.length === 0) {
    return { estimatedMonthly: 0, confidence: 'exact', lowerBound: false };
  }
  let sum = 0;
  const confidences: CostConfidence[] = [];
  let omitsUnknown = false;
  for (const entry of entries) {
    confidences.push(entry.confidence);
    if (entry.confidence === 'unknown' || entry.estimatedMonthly === undefined) {
      omitsUnknown = true;
      continue;
    }
    sum += entry.estimatedMonthly;
  }
  return {
    estimatedMonthly: round(sum, 2),
    confidence: weakest(confidences),
    lowerBound: omitsUnknown,
  };
}

function labelPairs(resource: CanonicalResource): string[] {
  return Object.entries(resource.labels).map(([k, v]) => `${k}=${String(v)}`);
}

/**
 * Estimate the cost of a canonical model. The report's `profile` mirrors the
 * model's active profile — one report per profile (§16.3); a per-profile
 * roll-up is produced by estimating each profile's merged model in turn.
 */
export function estimateCost(model: CanonicalModel, options: EstimateOptions): CostReport {
  const { costModel, snapshot } = options;

  // Resource entries, keyed by id, in sorted id order for determinism.
  const ids = Object.keys(model.resources).sort();
  const resources: Record<string, ResourceCost> = {};
  for (const id of ids) {
    resources[id] = priceResource(
      model.resources[id] as CanonicalResource,
      id,
      costModel,
      snapshot,
    );
  }

  // byApplication: over each Application's components (§16.3).
  const byApplication: Record<string, Rollup> = {};
  for (const id of ids) {
    const resource = model.resources[id] as CanonicalResource;
    if (resource.kind !== 'Application') continue;
    const components = resource.spec.components;
    const memberIds = Array.isArray(components)
      ? components.filter((c): c is string => typeof c === 'string')
      : [];
    const members = memberIds
      .filter((c) => resources[c] !== undefined)
      .map((c) => resources[c] as ResourceCost);
    byApplication[id] = rollup(members);
  }

  // byLabel: over every distinct label key=value pair, in sorted key order.
  const labelBuckets = new Map<string, ResourceCost[]>();
  for (const id of ids) {
    const resource = model.resources[id] as CanonicalResource;
    for (const pair of labelPairs(resource)) {
      const bucket = labelBuckets.get(pair) ?? [];
      bucket.push(resources[id] as ResourceCost);
      labelBuckets.set(pair, bucket);
    }
  }
  const byLabel: Record<string, Rollup> = {};
  for (const pair of [...labelBuckets.keys()].sort()) {
    byLabel[pair] = rollup(labelBuckets.get(pair) as ResourceCost[]);
  }

  const totals = rollup(ids.map((id) => resources[id] as ResourceCost));
  const suggestions = suggestOptimizations(model, resources, { costModel, snapshot });

  return {
    reportVersion: '1',
    formatVersion: 1,
    document: model.metadata.name,
    profile: model.profile,
    modelHash: model.hash,
    priceSnapshot: snapshotContentAddress(snapshot),
    costModel: `${costModel.id}@${costModel.version}`,
    currency: snapshot.currency,
    resources,
    rollups: { byApplication, byLabel },
    totals,
    suggestions,
  };
}
