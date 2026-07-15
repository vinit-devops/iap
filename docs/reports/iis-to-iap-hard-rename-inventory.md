# IIS → IaP Hard-Rename Inventory (Phase 19, M19.0)

**Status:** complete · **Date:** 2026-07-12 · **Kind:** pre-release breaking rename, **no backward compatibility**

This report records the inventory and execution of the hard rename from **IIS —
Infrastructure Intent Specification** to **IaP — Infrastructure as Prompt**.
Nothing was published, released, or externally consumed, so no compatibility
layer is retained: legacy CLI, packages, `iis.dev/*` documents, `.iis.yaml`
files, diagnostic codes, and MCP tool names are **removed**, not aliased.

Machine-readable companions:

- [`docs/migrations/iis-to-iap-hard-rename-map.yaml`](../migrations/iis-to-iap-hard-rename-map.yaml) — exact from→to map + the 33-code diagnostic migration
- [`docs/migrations/iis-to-iap-protected-occurrences.yaml`](../migrations/iis-to-iap-protected-occurrences.yaml) — allowed remaining occurrences (the gate fails on anything else)
- [`docs/adr/ADR-0003-iap-naming-migration.md`](../adr/ADR-0003-iap-naming-migration.md) · [`spec/ieps/IEP-0014-iap-naming-migration.md`](../../spec/ieps/IEP-0014-iap-naming-migration.md)

## Scope

| Metric                                                        | Value                      |
| ------------------------------------------------------------- | -------------------------- |
| Files containing the old name (pre-rename)                    | 427                        |
| Content-changed files (ordered-rule passes)                   | 480                        |
| File renames (`*.iis.yaml`, `*.iis-map.yaml`, 2 schema files) | 57                         |
| Distinct `@iis/*` packages renamed                            | 26 (+ root `iis-monorepo`) |
| Diagnostic codes renamed `IIS###`→`IAP###`                    | 33                         |
| MCP tools renamed                                             | 5                          |
| Environment variables renamed                                 | 4                          |
| Schema files renamed                                          | 2 (+ `$id` host on all 12) |

## Classification (A–E)

- **A — project-specific, renamed (~3,216 lines).** apiVersion, `$id` hosts, schema/example/fixture filenames, package scope, CLI/LSP bins, MCP tools, env vars, public types, all 33 diagnostic codes, prose.
- **B — legacy compatibility: 0.** Deliberately none — this is a hard cut.
- **C — external / unrelated: 6.** Microsoft IIS references, all inside `roadmap-v2` (the plan doc). Protected.
- **D — incidental substring: 0 real.** No English word in the tree contains the `iis` sequence; a permanent guard documents the risk of a naive case-insensitive replace.
- **E — generated / vendored: 77 across 13 files.** Regenerated from canonical source (schema copies, lockfile, golden plans, signed manifests) rather than string-edited.

## Method — ordered, exact, token-scoped (never a blind global replace)

The rename was applied by `tools/rename-iis-to-iap.mjs`, which walks an
allowlisted set of roots and applies **ordered exact rules** (most-specific
first), never a loose `s/iis/iap/`:

1. `\bIIS[1-8]` and `IIS\[` → `IAP…` (diagnostic codes, range refs, regex char classes) — before any generic rule, so codes get `IAP` not `IaP`.
2. `iis.dev` → `iap.dev`; `@iis/` → `@iap/`.
3. Compound names (`iis-language-server`, `iis-provider-`, `iis-monorepo`, schema filenames).
4. File-extension refs (`.iis.yaml`, `.iis.yml`, `.iis-map.yaml`).
5. LSP methods (`iis/preview`, `iis/canonical`); snake_case `\biis_` → `iap_`; env `\bIIS_` → `IAP_`.
6. Types `\bIis` → `IaP` (and `IISSDK` → `IaPSDK`).
7. Prose product name (`Infrastructure Intent Specification` → `Infrastructure as Prompt`), then standalone `\bIIS\b`/`\biis\b`.

Files that legitimately retain the old name (historical/plan/migration docs, the
tooling, external Microsoft IIS) are excluded from the engine and enumerated in
the protected-occurrences file.

### Edge cases found and handled

- **Diagnostic **_range_** references** (`IIS1xx`, `IIS6xx`) and **live regex matchers** (`/^IIS5/`, `/^IIS5[0-9]{2}$/`, `IIS[1-4]`, ch08's `^IIS[1-8][0-9]{2}$`) were caught by dedicated code-family rules so they became `IAP…`/`IAP[` — never mis-cased to `IaP[`.
- **Six source files use a raw NUL byte** as a hash-field join separator (`.join('\0')`); the engine processes text extensions regardless of NUL so those files were renamed while preserving the separator.

## Diagnostic migration

All 33 codes `IAP101…IAP806` (see the map's `diagnosticMigration:` block). The
numeric suffix, severity, and message meaning are unchanged; only the prefix
changed. No `IIS###` code is recognized or emitted anywhere after the rename
(the conformance `# expected:` markers, the error-code registry, and SARIF rule
IDs all use `IAP###`).

## Verification (post-rename, from the renamed tree)

`build`, `typecheck`, `lint`, `format:check`, unit (**1213 passed / 5 skipped**;
the rename itself returned the suite to the exact pre-rename baseline of 1178,
and +35 hard-rename negative/safety tests were then added), spec/conformance
(65), providers (45, re-signed), determinism (29), eval — all green. The
allowlist gate (`pnpm check:names`) passes. **Semantic equivalence** was proven:
reversing the naming on the regenerated golden plans reproduces the pre-rename
bytes exactly, so no resource intent, relationship, provider mapping, resource
identity, or execution action changed — the rename introduces no infrastructure
operation.

## Negative-safety evidence

Legacy is rejected, not silently handled:

- A document with `apiVersion: iis.dev/v1` is **rejected** (IAP101).
- `.iis.yaml` / `.iis-map.yaml` are **not** auto-discovered.
- The `iis` CLI bin and `@iis/*` packages **do not exist**.
- Legacy `iis_*` MCP tool names return an **unknown-tool** error.
- Unrelated words (`this`, `missing`, `permissions`, `submission`) and external `Microsoft IIS` are **unchanged**.
