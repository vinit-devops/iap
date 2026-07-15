/**
 * Authoring-engine integration (spec ch. 20 §20.2.3, IEP-0013 TB-3). MCP-sourced
 * knowledge feeds the recommendation engine as ADVISORY suggestions only: a
 * grounded recommendation carries `origin: 'mcp'` and the ids of the knowledge
 * snapshots it is grounded in. The intent-compiler's `acceptRecommendations`
 * fails closed unless those snapshot ids are present (TB-3), and any accepted
 * recommendation becomes explicit structured intent through the operation gate
 * before planning — no uncited value ever reaches a deterministic plan (§20.3).
 */
import type { OperationEnvelope, Recommendation } from '@iap/intent-compiler';
import type { KnowledgeSnapshot } from './snapshot.js';

export interface KnowledgeRecommendationInput {
  id: string;
  title: string;
  rationale: string;
  /** The operations acceptance would add (built by the caller from the knowledge). */
  operations: OperationEnvelope[];
}

/**
 * Ground an advisory recommendation in knowledge snapshots. Throws if no
 * snapshot is supplied — an MCP recommendation with no citation is
 * unacceptable by construction (TB-3), so it is refused at build time rather
 * than producing an object the gate would later reject.
 */
export function groundRecommendation(
  input: KnowledgeRecommendationInput,
  snapshots: KnowledgeSnapshot[],
): Recommendation {
  if (snapshots.length === 0) {
    throw new TypeError(
      `MCP recommendation "${input.id}" must cite at least one knowledge snapshot (IEP-0013 TB-3)`,
    );
  }
  return {
    id: input.id,
    rule: input.id,
    title: input.title,
    rationale: input.rationale,
    origin: 'mcp',
    knowledgeSnapshotIds: snapshots.map((s) => s.id),
    operations: input.operations,
  };
}
