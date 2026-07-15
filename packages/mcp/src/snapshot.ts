/**
 * Knowledge snapshots — the citation and staleness model (spec ch. 20 §20.3
 * provenance, IEP-0013). A snapshot is the versioned, content-addressed record
 * of one knowledge retrieval: exactly the fields ch. 12 (roadmap "Knowledge
 * response handling") requires stored — source, retrieval time, version, query,
 * excerpt, confidence, expiry, and whether the user accepted a recommendation.
 * Snapshots are the ONLY form in which MCP knowledge reaches the deterministic
 * pipeline (§20.1); an accepted recommendation grounded in snapshots becomes
 * explicit intent before planning.
 */
import { sha256Hex } from '@iap/model';
import type { KnowledgeCategory, KnowledgeResult, KnowledgeSource, TrustTier } from './source.js';

export interface KnowledgeSnapshot {
  /** Content address over (source, query, version, excerpt) — stable and unforgeable. */
  id: string;
  sourceId: string;
  category: KnowledgeCategory;
  trust: TrustTier;
  query: string;
  /** RFC 3339 retrieval instant (injected). */
  retrievedAt: string;
  /** Publication date / version of the retrieved knowledge. */
  version: string;
  /** Relevant excerpt or structured fact. */
  excerpt: string;
  confidence: number;
  /** RFC 3339 expiry instant, derived from the source's ttl. */
  expiresAt: string;
  /** Whether a human accepted a recommendation grounded in this snapshot. */
  accepted: boolean;
}

/** Add `ttlDays` whole days to an RFC 3339 instant, deterministically. */
export function addDays(iso: string, days: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`invalid RFC 3339 instant: ${iso}`);
  return new Date(ms + days * 86_400_000).toISOString();
}

/** Build a snapshot from a source result. Pure — the clock is the injected `retrievedAt`. */
export function createSnapshot(
  source: KnowledgeSource,
  query: string,
  result: KnowledgeResult,
  retrievedAt: string,
): KnowledgeSnapshot {
  const id = `snap:${sha256Hex(JSON.stringify([source.id, query, result.version, result.excerpt]))}`;
  return {
    id,
    sourceId: source.id,
    category: source.category,
    trust: source.trust,
    query,
    retrievedAt,
    version: result.version,
    excerpt: result.excerpt,
    confidence: result.confidence,
    expiresAt: addDays(retrievedAt, result.ttlDays),
    accepted: false,
  };
}

/** True when a snapshot has passed its expiry as of `now` (§20.3 staleness). */
export function isStale(snapshot: KnowledgeSnapshot, now: string): boolean {
  const nowMs = Date.parse(now);
  const expiryMs = Date.parse(snapshot.expiresAt);
  return Number.isNaN(nowMs) || Number.isNaN(expiryMs) ? false : nowMs > expiryMs;
}

/** A human-readable citation for a snapshot (for reports, hovers, explanations). */
export function citation(snapshot: KnowledgeSnapshot): string {
  return `${snapshot.sourceId} (${snapshot.trust}, ${snapshot.category}) v${snapshot.version}, retrieved ${snapshot.retrievedAt} [${snapshot.id}]`;
}
