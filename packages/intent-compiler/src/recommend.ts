/**
 * The recommendation seam (M3.3, §3.4 provenance flow): deterministic
 * suggestions over the current document, OFFERED to the user and entering
 * the proposal only on explicit acceptance — with provenance source
 * `accepted-recommendation` and a confirmation record on the same channel
 * (IEP-0009 rule 3). Unaccepted recommendations never touch a batch.
 *
 * IEP-0013 acceptance rule: an accepted recommendation whose knowledge came
 * from MCP MUST cite at least one knowledge snapshot id (TB-3). The field is
 * modeled now; real MCP retrieval arrives in Phase 12 — the in-repo rules
 * below are `deterministic-rule` origin and cite nothing.
 */

import type { IaPDocument, ResourceEntry } from '@iap/model';
import type { ConfirmationRecord } from './gate.js';
import type { OperationBatch, OperationEnvelope, ProposalChannel } from './operations.js';
import { OPERATIONS_API_VERSION } from './operations.js';

/** The closed deterministic rule set shipped in-repo. */
export const RECOMMENDATION_RULES = [
  'explicit-backup-for-stateful',
  'gateway-tls-minimum',
] as const;

export type RecommendationRule = (typeof RECOMMENDATION_RULES)[number];

/** Where a recommendation's knowledge came from. */
export type RecommendationOrigin = 'deterministic-rule' | 'mcp';

/** One offered recommendation. Only ACCEPTED recommendations enter operations. */
export interface Recommendation {
  id: string;
  rule: RecommendationRule | string;
  title: string;
  rationale: string;
  origin: RecommendationOrigin;
  /**
   * Knowledge snapshot ids grounding an MCP-sourced recommendation
   * (IEP-0013). REQUIRED (non-empty) when `origin` is `mcp`; acceptance
   * fails closed without them.
   */
  knowledgeSnapshotIds?: string[];
  /** The operations acceptance would add (provenance source `accepted-recommendation`). */
  operations: OperationEnvelope[];
}

export interface RecommendOptions {
  /** Authoring surface stamped into the recommendation operations (default api). */
  channel?: ProposalChannel;
}

type JsonObject = Record<string, unknown>;

function recommendationOperation(
  operationId: string,
  resourceId: string,
  set: Record<string, unknown>,
  channel: ProposalChannel,
): OperationEnvelope {
  return {
    operationId,
    type: 'UpdateResource',
    target: { resourceId },
    change: { set },
    confidence: 0.95,
    assumptions: [],
    requiredClarifications: [],
    provenance: { source: 'accepted-recommendation', channel },
  };
}

/**
 * Deterministic recommendations over the current document. Closed rules:
 *
 * - `explicit-backup-for-stateful` — a stateful data resource whose backup
 *   posture is `none` (Database/Volume, violating the normative §3.2.6
 *   default) or not explicitly `required` (ObjectStore, whose default is
 *   only `preferred`) gets an explicit `resilience.backup: required`.
 * - `gateway-tls-minimum` — a Gateway without `tls.minimumVersion: "1.3"`
 *   gets the stricter floor.
 */
export function recommend(document: IaPDocument, options: RecommendOptions = {}): Recommendation[] {
  const channel = options.channel ?? 'api';
  const recommendations: Recommendation[] = [];
  const resources = document.resources ?? {};
  for (const id of Object.keys(resources).sort()) {
    const entry = resources[id] as ResourceEntry;
    const spec = (entry.spec ?? {}) as JsonObject;
    const backup = (spec.resilience as JsonObject | undefined)?.backup;
    const needsBackup =
      ((entry.kind === 'Database' || entry.kind === 'Volume') && backup === 'none') ||
      (entry.kind === 'ObjectStore' && backup !== 'required');
    if (needsBackup) {
      recommendations.push({
        id: `rec-backup-${id}`,
        rule: 'explicit-backup-for-stateful',
        title: `Require backups for ${entry.kind} "${id}"`,
        rationale:
          entry.kind === 'ObjectStore'
            ? 'ObjectStore backup defaults to preferred only (ch. 3 §3.2.6); stateful data should require backups'
            : `${entry.kind} "${id}" explicitly disables backups, violating the normative required default (ch. 3 §3.2.6)`,
        origin: 'deterministic-rule',
        operations: [
          recommendationOperation(
            `op-rec-backup-${id}`,
            id,
            { 'spec.resilience.backup': 'required' },
            channel,
          ),
        ],
      });
    }
    if (entry.kind === 'Gateway') {
      const minimum = ((spec.tls as JsonObject | undefined) ?? {}).minimumVersion;
      if (minimum !== '1.3') {
        recommendations.push({
          id: `rec-tls-${id}`,
          rule: 'gateway-tls-minimum',
          title: `Raise the TLS floor of Gateway "${id}" to 1.3`,
          rationale:
            'the Gateway TLS minimum defaults to 1.2 (ch. 3 §3.8); 1.3 removes legacy cipher exposure',
          origin: 'deterministic-rule',
          operations: [
            recommendationOperation(
              `op-rec-tls-${id}`,
              id,
              { 'spec.tls.minimumVersion': '1.3' },
              channel,
            ),
          ],
        });
      }
    }
  }
  return recommendations;
}

/** Who accepted and when; the timestamp is INJECTED by the caller — never read from a clock. */
export interface RecommendationAcceptance {
  actor: string;
  timestamp: string;
}

export interface AcceptedRecommendations {
  batch: OperationBatch;
  /** Confirmations (channel `accepted-recommendation`) for the added operations. */
  confirmations: ConfirmationRecord[];
}

/**
 * Accept recommendations into a proposal batch. The ONLY path from a
 * recommendation into operations (IEP-0013 acceptance rule): the added
 * envelopes carry provenance source `accepted-recommendation`, and each gets
 * a confirmation record on the `accepted-recommendation` channel citing the
 * human actor. Fails closed (`TypeError`) when an MCP-sourced recommendation
 * cites no knowledge snapshot (TB-3), or the acceptance identity is empty.
 */
export function acceptRecommendations(
  batch: OperationBatch | null,
  recommendations: Recommendation[],
  acceptance: RecommendationAcceptance,
): AcceptedRecommendations {
  if (acceptance.actor.length === 0 || acceptance.timestamp.length === 0) {
    throw new TypeError('acceptance requires a non-empty actor and an injected timestamp');
  }
  const working: OperationBatch = structuredClone(
    batch ?? { apiVersion: OPERATIONS_API_VERSION, operations: [] },
  );
  const opIds = new Set(working.operations.map((op) => op.operationId));
  const confirmations: ConfirmationRecord[] = [];
  for (const recommendation of recommendations) {
    if (
      recommendation.origin === 'mcp' &&
      (recommendation.knowledgeSnapshotIds === undefined ||
        recommendation.knowledgeSnapshotIds.length === 0)
    ) {
      throw new TypeError(
        `recommendation "${recommendation.id}" is MCP-sourced but cites no knowledge snapshot (IEP-0013 TB-3)`,
      );
    }
    for (const op of recommendation.operations) {
      const clone = structuredClone(op);
      clone.provenance = { ...clone.provenance, source: 'accepted-recommendation' };
      let candidate = clone.operationId;
      let counter = 2;
      while (opIds.has(candidate)) {
        candidate = `${clone.operationId}-${counter}`;
        counter += 1;
      }
      clone.operationId = candidate;
      opIds.add(candidate);
      working.operations.push(clone);
      confirmations.push({
        operationId: clone.operationId,
        actor: acceptance.actor,
        channel: 'accepted-recommendation',
        timestamp: acceptance.timestamp,
      });
    }
  }
  return { batch: working, confirmations };
}
