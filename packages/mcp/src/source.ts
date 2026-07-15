/**
 * Knowledge sources and the trust-classified source registry (spec ch. 20
 * §20.2, IEP-0013). A knowledge source is READ-ONLY with respect to the world
 * (§20.1): it retrieves documentation/pricing/advisory/enterprise knowledge and
 * returns it as data — it is never granted mutation capability and never
 * participates in planning or execution. Sources are network-free by
 * construction here (in-repo fixtures); a real MCP-backed source implements the
 * same interface out of tree.
 */

/** The knowledge categories an IaP toolchain consumes (§20.2 rows). Closed set. */
export const KNOWLEDGE_CATEGORIES = [
  'provider-documentation',
  'pricing',
  'best-practice',
  'security-advisory',
  'enterprise',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** Trust classification of a source (§20.2.5 / IEP-0013). Closed set. */
export const TRUST_TIERS = ['authoritative', 'community', 'internal'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Context injected into a retrieval — the clock lives with the caller, never the source. */
export interface RetrieveContext {
  /** RFC 3339 retrieval instant, injected (never read from a clock inside a source). */
  retrievedAt: string;
}

/** The raw knowledge a source returns for a query (before it becomes a snapshot). */
export interface KnowledgeResult {
  /** Publication date or version id of the retrieved knowledge. */
  version: string;
  /** The relevant excerpt or structured fact. */
  excerpt: string;
  /** Source confidence in [0, 1]. */
  confidence: number;
  /** Time-to-live in days; the snapshot's expiry is derived from it. */
  ttlDays: number;
}

/** A knowledge source. `retrieve` returns null when the source is unavailable (§20.3 graceful degradation). */
export interface KnowledgeSource {
  id: string;
  category: KnowledgeCategory;
  trust: TrustTier;
  retrieve(query: string, ctx: RetrieveContext): KnowledgeResult | null;
}

/**
 * An in-repo fixture source that replays recorded results by exact query — the
 * network-free workhorse for tests and offline authoring. Missing queries
 * return null (unavailable), exercising graceful degradation.
 */
export function fixtureSource(
  id: string,
  category: KnowledgeCategory,
  trust: TrustTier,
  responses: Record<string, KnowledgeResult>,
): KnowledgeSource {
  return {
    id,
    category,
    trust,
    retrieve(query: string): KnowledgeResult | null {
      return Object.prototype.hasOwnProperty.call(responses, query)
        ? (responses[query] ?? null)
        : null;
    },
  };
}

/** A source that is always down — for degradation tests. */
export function unavailableSource(
  id: string,
  category: KnowledgeCategory,
  trust: TrustTier,
): KnowledgeSource {
  return { id, category, trust, retrieve: () => null };
}

/* ------------------------------------------------------------------ */
/* Source registry                                                     */
/* ------------------------------------------------------------------ */

/** A trust-classified registry of knowledge sources. */
export class SourceRegistry {
  private readonly sources = new Map<string, KnowledgeSource>();

  register(source: KnowledgeSource): this {
    if (this.sources.has(source.id)) {
      throw new Error(`knowledge source "${source.id}" is already registered`);
    }
    this.sources.set(source.id, source);
    return this;
  }

  get(id: string): KnowledgeSource | undefined {
    return this.sources.get(id);
  }

  /** All registered sources, sorted by id (deterministic). */
  all(): KnowledgeSource[] {
    return [...this.sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Sources in one category, sorted by id. */
  byCategory(category: KnowledgeCategory): KnowledgeSource[] {
    return this.all().filter((s) => s.category === category);
  }
}
