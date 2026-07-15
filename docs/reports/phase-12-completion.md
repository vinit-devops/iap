# Phase 12 Completion Report — MCP and Authoritative Knowledge Framework

**Date:** 2026-07-11 · **Milestones:** M12.1, M12.2 (`docs/milestones/M12-mcp-knowledge.md`)

Phase 12 delivers `@iap/mcp`: knowledge sources with trust classification, a source registry,
a caching client, content-addressed knowledge snapshots (citation + staleness), and
authoring-engine integration — all under ch. 20's invariant: **knowledge in, nothing out**.
MCP enriches authoring and validation; the deterministic core stays exactly as reproducible
as ch. 1 requires.

## Exit-criteria verification

| Exit criterion                                         | Status   | Evidence                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP outages do not affect execution of finalized plans | **Pass** | The pipeline consumes MCP knowledge only as pinned snapshots; the `KnowledgeClient` never sits in validate/plan/deploy. `retrieve` never throws on source unavailability — it returns `available: false` / `unavailableSources`, so scarcity degrades gracefully (§20.3). There is no client method that returns a plan value. |
| Recommendations are source-attributed                  | **Pass** | Every snapshot carries source, trust, version, query, retrieval time, confidence, and expiry with a content-addressed id; `citation` renders it. `groundRecommendation` stamps `origin: 'mcp'` and the snapshot ids onto the recommendation.                                                                                   |
| MCP content cannot bypass validation                   | **Pass** | Knowledge reaches the deterministic pipeline only as versioned snapshots; an accepted recommendation becomes explicit operations that pass the intent-compiler gate (schema + full ch. 8 dry-run) like any other authoring input — no direct document mutation.                                                                |
| Accepted recommendations become explicit model changes | **Pass** | `groundRecommendation` refuses a citation-less recommendation at build time; `acceptRecommendations` enforces IEP-0013 TB-3 (MCP origin requires non-empty snapshot ids) and converts acceptance into operations with `accepted-recommendation` provenance — verified end to end (`packages/mcp/test`).                        |

## Deliverables checklist (roadmap Phase 12)

- **MCP client framework** ✓ — `KnowledgeClient` (pinned retrieval, explicit refresh).
- **Source registry** ✓ — `SourceRegistry` (register/lookup/by-category).
- **Trust classification** ✓ — `TRUST_TIERS` + per-source category/trust.
- **Caching** ✓ — pinned snapshots per (source, query); refresh is the only live-call point.
- **Citation model** ✓ — `KnowledgeSnapshot` + `citation`.
- **Staleness handling** ✓ — `isStale` over ttl-derived expiry.
- **Authoring-engine integration** ✓ — `groundRecommendation` → the TB-3-gated `acceptRecommendations`.

## Verification state

Full `pnpm run verify` green (build incl. `@iap/mcp`, lint, unit tests incl. 10 new, spec
harness, provider conformance, determinism, evaluation benchmark). `pnpm run format:check`
clean.

## Notes and follow-ons

- Real MCP-server-backed sources (AWS docs, pricing, advisory, enterprise) implement the same
  `KnowledgeSource` interface out of tree; the in-repo fixtures keep `verify` network-free.
- Price snapshots (ch. 16) and security rule bundles (ch. 15) already follow the same
  pinned-artifact discipline; wiring MCP refresh to produce them is an operational integration.
- LSP hover/completion enrichment from documentation sources (§20.2.1) lands with the IDE work
  (Phase 13).
