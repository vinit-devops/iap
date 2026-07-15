/**
 * `@iap/mcp` — the MCP and authoritative-knowledge framework (spec ch. 20,
 * IEP-0013; roadmap Phase 12). Knowledge in, nothing out: MCP-backed sources
 * enrich authoring and validation and NEVER participate in planning or
 * execution. Knowledge reaches the deterministic pipeline only as versioned,
 * content-addressed snapshots; live source calls happen at explicit refresh,
 * never inside validate/plan/deploy; and unavailability degrades gracefully.
 *
 * M12.1 — the client framework, the trust-classified source registry, and trust
 * classification. M12.2 — the snapshot/citation/staleness model and the
 * authoring-engine integration (grounded, cited recommendations that become
 * explicit intent through the operation gate before planning).
 */
export {
  KNOWLEDGE_CATEGORIES,
  SourceRegistry,
  TRUST_TIERS,
  fixtureSource,
  unavailableSource,
} from './source.js';
export type {
  KnowledgeCategory,
  KnowledgeResult,
  KnowledgeSource,
  RetrieveContext,
  TrustTier,
} from './source.js';

export { addDays, citation, createSnapshot, isStale } from './snapshot.js';
export type { KnowledgeSnapshot } from './snapshot.js';

export { KnowledgeClient } from './client.js';
export type { RetrieveOptions, RetrieveOutcome } from './client.js';

export { groundRecommendation } from './recommend.js';
export type { KnowledgeRecommendationInput } from './recommend.js';
