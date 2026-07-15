# Milestone M12.1+M12.2 — MCP and Authoritative Knowledge Framework

**Phase:** 12 — MCP and Authoritative Knowledge Framework
**Milestones:** M12.1 (MCP client framework + source registry + trust classification), M12.2 (snapshot/citation/staleness model + authoring integration)
**Status:** Completed
**Date:** 2026-07-11

## Implemented

`@iap/mcp` 0.1.0 — the MCP and authoritative-knowledge framework per spec ch. 20 and
IEP-0013. Its invariant is ch. 20's: **knowledge in, nothing out**. MCP-backed sources
enrich authoring and validation and NEVER participate in planning or execution; knowledge
reaches the deterministic pipeline only as versioned, content-addressed snapshots; live
source calls happen at an explicit refresh, never inside validate/plan/deploy; and source
unavailability degrades gracefully. Pure and clock-free (the retrieval instant is injected).

### M12.1 — client framework, source registry, trust classification

- **`KnowledgeSource`** — the read-only source interface (`retrieve(query, ctx) → KnowledgeResult | null`);
  `null` is unavailability, not an error (§20.3). Network-free in-repo `fixtureSource` /
  `unavailableSource` implement it; a real MCP-backed source is any out-of-tree implementation.
- **Closed vocabularies** — `KNOWLEDGE_CATEGORIES` (provider-documentation, pricing,
  best-practice, security-advisory, enterprise — the §20.2 rows) and `TRUST_TIERS`
  (authoritative, community, internal).
- **`SourceRegistry`** — a trust-classified registry (register with duplicate rejection,
  lookup by id, filter by category), returning sources in deterministic order.
- **`KnowledgeClient`** — retrieves knowledge as **pinned** snapshots: a query hits the
  cache first, so repeated retrievals are reproducible; a live call happens only on the
  first retrieval or an explicit `refresh` (the §20.1 refresh point). Unavailable sources
  are reported in `unavailableSources`, never thrown — knowledge scarcity can never block
  the pipeline.

### M12.2 — snapshot/citation/staleness + authoring integration

- **`KnowledgeSnapshot`** — the citation model, storing exactly the roadmap §12 "knowledge
  response handling" fields: source, retrieval time, version/publication date, query,
  excerpt/fact, confidence, expiry, and `accepted`. `createSnapshot` derives a
  content-addressed id (`snap:<sha256>` over source+query+version+excerpt) and an `expiresAt`
  from the source's ttl; `citation` renders a human-readable reference.
- **Staleness** — `isStale(snapshot, now)` reports whether a snapshot has passed expiry
  (§20.3); the client keeps a stale snapshot as a caveat rather than a failure.
- **Authoring integration** — `groundRecommendation(input, snapshots)` builds an
  intent-compiler `Recommendation` with `origin: 'mcp'` and the snapshot ids, refusing at
  build time if no snapshot is cited. The existing `acceptRecommendations` gate enforces
  IEP-0013 **TB-3** (an MCP recommendation with no citation fails closed), and any accepted
  recommendation becomes explicit intent through the operation gate before planning — so no
  uncited value ever reaches a deterministic plan (§20.3 plan invariance).

## Design decisions taken

1. **Snapshots are the only ingress; the client enforces it.** The `KnowledgeClient` exposes
   no method that returns a plan value — only snapshots (data + provenance). Live lookups are
   confined to `refresh`, structurally separating the §20.1 refresh point from the
   deterministic pipeline.
2. **Graceful degradation is the default, not a mode.** `retrieve` never throws on
   unavailability; `available: false` with an empty snapshot set is a normal outcome, so a
   caller that ignores enrichment still completes.
3. **The clock is injected.** `retrievedAt` is a parameter; `createSnapshot`/`isStale`/`addDays`
   are pure, so snapshot ids and staleness are reproducible.
4. **Integration reuses the existing TB-3 gate.** Rather than a second citation mechanism,
   `groundRecommendation` produces the intent-compiler `Recommendation` shape the gate
   already validates — one enforcement point for "accepted MCP knowledge becomes cited,
   explicit intent."

## Specification references

Ch. 20 §20.1 (position; pinned artifacts; refresh-only live calls), §20.2 (integration
points + trust), §20.3 (plan invariance, graceful degradation, no mutation, provenance);
IEP-0013 (trust boundaries, TB-3 citation requirement); ch. 16 (price snapshots — the same
pinned-artifact discipline); roadmap Phase 12 "knowledge response handling".

## Tests added

`packages/mcp/test/mcp.test.ts` (10): registry registration/dedup/category filtering + trust;
snapshot provenance, content-addressed id (stable + knowledge-sensitive), citation, and
ttl-derived expiry; staleness before/after expiry; client pinned retrieval (reproducible
without refresh), explicit refresh updating pins, and graceful degradation (unavailable
sources reported, a fully-unanswered query → `available: false`, never thrown); and the
authoring integration — `groundRecommendation` stamps origin/citations and refuses with
none, and an accepted grounded recommendation passes the TB-3 gate into an operation batch.

## Conformance status

Green end to end: `pnpm run verify` and `pnpm run format:check` both pass. Phase 12 is
complete; see `docs/reports/phase-12-completion.md`.
