# Cycle 4 Report (roadmap §17)

**Phases:** 2 (completed), 9 (completed), 8 (completed), 4 (completed), 5 (partial — gated), and cycle 3's wave-1 work folded in.

**Implemented (cycles 3–4 combined):**

- **Phase 2 — Canonical Model and Reference SDK (completed):** `@iap/parser` source maps + alias-bomb limits + file/stream input (M2.1); CIM types + exact-rational BigInt quantity engine + full C1–C6 canonicalization with schema-driven default materialization, golden hash vectors, and provenance (M2.2/M2.3); `@iap/graph` (verb/kind + attribute constraint tables, ordering derivation, Tarjan cycles, Kahn waves) and `@iap/validator` (phases 1–4, all registry codes) making 13 semantic conformance cases executable (M2.4/M2.5); `@iap/sdk` facade with round-trip serializer, extension registration, API-surface snapshot (M2.6). All six exit criteria pass (`docs/reports/phase-2-completion.md`).
- **Phase 9 — Policy Engine (completed):** `@iap/policy` — full ch. 7 evaluation (exact quantity/duration comparisons, effect polarity, IAP501–504), require-autofix merge patches, exception workflow with injected clock, six schema-validated built-in packs; cases 17/18 now executed. Found and fixed a real self-violating policy in the enterprise-pci example.
- **Phase 8 — Architecture Engine (completed):** `@iap/architecture` — five ch. 18 views, Mermaid/DOT exporters, before/after diff overlays, zero layout data in semantic output; byte-identical determinism; integrated into CLI (`iap diagram`) and LSP (`iap/preview`) closing M8.4.
- **Phase 4 — Language Server (completed):** `@iap/language-server` — pure provider core (diagnostics/completion/hover/navigation/rename/symbols/code-actions/previews) + thin LSP stdio binding; diagnostics share the exact SDK path with the CLI; measured 16.6 ms on the largest example, 31 ms on a 110-resource document (target: 200 ms); live JSON-RPC smoke test green.
- **Phase 5 — Reference CLI (partial by design):** `@iap/cli` — 12 analysis commands (validate with human/JSON/SARIF, graph, diagram, policy, normalize, fmt, explain with provenance, diff, doctor, init) with ch. 22 exit codes and `formatVersion`-stamped JSON; 15 deployment/authoring commands correctly stubbed with phase gates. Exit criterion "natural-language creation" awaits Phase 3 (M5.3 pending) — phase stays in-progress per the roadmap's own gating rule.

**Verification:** `pnpm run verify` green — 9 packages build, lint clean, **407 unit tests passed (+5 skipped)**, **59/59 harness checks**, format clean. Runtime dependency closure remains provider-free (workspace + ajv + yaml + the two LSP libraries).

**Specification gaps found by implementation:** ch. 4 §4.2 dangling-target code typo (fixed IAP302→IAP201); ch. 18 §18.3 label-template omits `host` (resolved per §18.2.3, noted); candidate IAP806 for invalid registered-extension content (currently IAP802-as-error, documented); enterprise-pci example policy defect (fixed).

**Next milestone:** Phase 6 — provider mapping framework, mock provider, AWS reference mappings; then Phase 7 — deterministic planner.
