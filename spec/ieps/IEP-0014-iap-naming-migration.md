# IEP-0014: IaP naming migration (IIS → IaP)

| Field | Value |
|---|---|
| **Title** | IIS → IaP naming migration: apiVersion, schema identity, filenames, and the error-code breaking rename |
| **Number** | IEP-0014 |
| **Status** | Review |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-12 |
| **Target version** | 1.x (IaP rename release); a hard, pre-release breaking rename on every surface — see Compatibility |

## Summary

This IEP is the normative specification change that renames the project from **IIS ("Infrastructure Intent Specification")** to **IaP ("Infrastructure as Prompt")** across every normative surface: the document `apiVersion`, the schema `$id` host, schema filenames, the default document filename, and the validation error codes. It is a **hard, pre-release breaking rename with zero backward compatibility**: on every surface the legacy `iis.dev`/`IIS<nnn>`/`iis` form is **removed**, not deprecated. A document declaring the legacy `iis.dev/*` `apiVersion` is **rejected**; there are no legacy schema stubs, no legacy filename discovery, and no legacy error-code aliases. It fixes a **semantic-equivalence requirement**: the mechanical rename of the project's own content must change no resource intent, relationship, provider mapping, provider resource identity, or execution action. The companion implementation decision is [ADR-0003](../../docs/adr/ADR-0003-iap-naming-migration.md).

## Motivation

The specification's machine-readable identity strings (`apiVersion`, schema `$id`, schema filenames, error codes) are normative — they are matched literally by parsers, validators, the conformance harness, and downstream tooling. A rebrand therefore cannot be done as prose search-and-replace; it is a specification change governed by [Chapter 10](../chapters/10-versioning.md) and must move through the IEP process (Phase 0.5 exit criterion, [ADR-0002](../../docs/adr/ADR-0002-json-schema-normative-contract.md) §4: schema changes are specification changes). Because the project is **pre-release** — nothing published, no VCS history binding third parties, no external document, package importer, or tool that matches the legacy forms — there is no compatibility obligation to discharge. The correct and cheapest change is a single hard cut that removes every legacy form outright rather than building deprecation paths that serve no consumer. The one property that must survive the cut is provider resource identity, so that persisted state and plans keep their meaning.

## Problem statement

This IEP resolves, for the hard rename: (a) that a document declaring the legacy `apiVersion` (`iis.dev/v1` and typed sub-namespaces) is **invalid input** after the rename, and that serializers emit only the canonical form; (b) how the schema `$id` host change is reconciled with the [ADR-0002](../../docs/adr/ADR-0002-json-schema-normative-contract.md) rule that generated schema copies must not drift from canonical source; (c) that legacy schema filenames and `$id`s **no longer resolve** (no compatibility stubs); (d) that the 33 `IIS<nnn>` error codes are renamed with **no legacy alias**; (e) that only the canonical default filename is discovered and legacy filenames are **not** found; (f) that the rename is semantically inert so persisted state and plans keep their meaning. Chapter 8 (validation / error codes), Chapter 2 (document layout / `apiVersion`), and Chapter 10 (versioning) are all touched.

## Goals

- Define canonical `iap.dev/v1` `apiVersion` and specify that legacy `iis.dev/*` values are **rejected** (validation error `IAP101`), with canonical-only serialization output.
- Change the schema `$id` host `https://iis.dev` → `https://iap.dev` for all `$id` values, and rename the two name-bearing schema files, with **no legacy-named stubs**.
- Hard-rename all 33 error codes `IIS<nnn>` → `IAP<nnn>` as a breaking change, with **no legacy alias**.
- Define canonical filename `infrastructure.iap.yaml` as the **only** discovered form; legacy `infrastructure.iis.yaml` is not discovered.
- Fix a **semantic-equivalence requirement**: the rename changes labels only, never meaning, relationships, provider mappings, provider resource identity, or execution actions.
- Remove the legacy `@iis/*` package scope, `iis` CLI, `iis_*` MCP tools, `IIS_*` env vars, and `x-iis-*` annotations outright — no aliases, no fallbacks.

## Non-goals

- Renaming the `IEP` acronym or any `IEP-####` identifier — kept; only the prose expansion changes to "IaP Enhancement Proposal."
- Publishing `@iis/*` compatibility wrapper packages — out of scope and explicitly not done (nothing published, no external consumers; legacy scope removed outright).
- Any change to `v1` document semantics, the resource/relationship model, the planning contract, or provider behavior. This IEP renames; it does not redesign.
- The mechanical code/prose rename itself (milestones M19.0.3–M19.0.6) — this IEP is the normative contract those milestones implement against.

## Terminology

- **Canonical name** — the `IaP`/`iap.dev`/`IAP<nnn>` form the toolchain emits and treats as current. After the rename it is the only recognized form.
- **Legacy name** — the `IIS`/`iis.dev`/`IIS<nnn>` form. After the rename it is not recognized on any surface: as input it is an error or is not discovered.
- **Semantic equivalence** — the property that a document, once renamed, denotes the identical infrastructure intent, relationships, provider mappings, resource identity, and execution actions as before.

## Detailed design

### 1. apiVersion migration (canonical only; legacy rejected)

Canonical document `apiVersion` is **`iap.dev/v1`**. The typed sub-namespaces migrate in lockstep: `plan.iap.dev/v1`, `conformance.iap.dev/v1`, `plugin.iap.dev/v1`, `mapping.iap.dev/v1`, `operations.iap.dev/v1`, `state.iap.dev/v1`, and the forward `*.iap.dev/v2` variants.

- **Input:** a parser MUST reject a document whose `apiVersion` is a legacy `iis.dev/*` value (or any legacy typed sub-namespace) with validation error **`IAP101`** (unrecognized/unsupported `apiVersion`). There is no normalization to the canonical value, no deprecation warning, and no compatibility acceptance — the legacy string is simply not a valid `apiVersion`.
- **Output:** the canonical serializer MUST always emit `iap.dev/*`. There is no code path that reads a legacy `apiVersion`.
- This is **not** a version bump. `v1` remains `v1`; only the host label changes. Meaning is identical, but the legacy host string is not accepted.

### 2. Schema `$id` host change and file renames

- All 12 `$id` values change host `https://iis.dev/...` → `https://iap.dev/...` (schemas, provider extension schemas, fixture schemas).
- The two name-bearing schema files rename: `iis-v1.schema.json` → `iap-v1.schema.json`, `iis-mapping-v1.schema.json` → `iap-mapping-v1.schema.json`. Schema files whose names are not brand-specific (`plan-v1`, `plugin-manifest-v1`, `conformance-case-v1`, `compiler-operations-v1`, `price-snapshot-v1`, `cost-report-v1`) keep their filename but still take the new `$id` host.
- There is **no `spec/schema/compatibility/` directory and no legacy-named schema stubs.** Legacy `$id`s (`https://iis.dev/...`) and legacy filenames (`iis-v1.schema.json`, `iis-mapping-v1.schema.json`) do not resolve after the rename.
- Per [ADR-0002](../../docs/adr/ADR-0002-json-schema-normative-contract.md) §2, the generated schema copies under `packages/*/schemas/` are **regenerated** from the renamed canonical source via `tools/schema-generation/sync-schemas.mjs`; they are never hand-edited, and byte-equality tests continue to guard drift.

### 3. Error-code hard rename (BREAKING)

All 33 codes are renamed `IIS<nnn>` → `IAP<nnn>`, preserving the numeric suffix and its exact meaning (e.g. `IIS402` → `IAP402`, `IIS805` → `IAP805`). The full mapping is normative and enumerated in [`docs/migrations/iis-to-iap.md`](../../docs/migrations/iis-to-iap.md#error-code-mapping-all-33-codes).

- **No legacy alias.** After the rename, `IIS<nnn>` is **not** a recognized error code anywhere: not in the registry (`spec/conformance/error-codes.yaml`, `packages/cli/registry/error-codes.yaml`), not in emitted diagnostics, not in conformance `# expected:` markers.
- Every conformance fixture marker `# expected: IIS<nnn>` and every registry entry is rewritten to `IAP<nnn>` **atomically in the same change** (M19.0.4), so the registry cross-check harness stays green.
- This is a **breaking specification change**, deliberately not softened by an alias, **authorized by the approver** (see Decision). It is one of several breaking surfaces in this hard, pre-release rename; see Compatibility.

### 4. Filename discovery (canonical only)

- Canonical default input filename: **`infrastructure.iap.yaml`**. Canonical suffixes: `*.iap.yaml`, `*.iap-map.yaml`. These are the **only** discovered forms.
- Legacy `infrastructure.iis.yaml` (and `*.iis.yaml` / `*.iis-map.yaml`) are **not discovered**. A project that still uses a legacy filename is simply not found; there is no legacy discovery and therefore no "both filenames present" ambiguity case.

### 5. Semantic-equivalence requirement (normative)

The rename is a relabeling of identity strings and identifiers only. A conforming implementation MUST guarantee that renaming a document — via the mechanical rename of first-party content — changes **none** of the following:

1. resource intent (which resources, their kinds, and their fields);
2. relationships and relationship verbs between resources;
3. provider mapping selection and output;
4. **provider resource identity** (the identity a provider assigns to a live resource);
5. execution actions in a plan (create/update/replace/delete waves).

Concretely: re-running `plan` before and after the rename, with all other determinism inputs fixed ([IEP-0011](IEP-0011-deterministic-planning-contract.md)), MUST yield a plan whose `destructiveActions` and wave actions are unchanged — **the rename alone MUST NOT create, replace, or destroy any resource.** Any identity derivation that would fold the literal brand string into a resource key, `planId`, or `inputsHash` in a way the rename perturbs is a defect and MUST be corrected so identity is stable across the rename.

## Schema impact

- `iis-v1.schema.json` → `iap-v1.schema.json`; `iis-mapping-v1.schema.json` → `iap-mapping-v1.schema.json` (canonical files in `spec/schema/`).
- All `$id` hosts change `https://iis.dev` → `https://iap.dev` (12 values).
- No `spec/schema/compatibility/` directory: legacy `$id`s and filenames do not resolve.
- The `x-iis-*` annotation vocabulary ([ADR-0002](../../docs/adr/ADR-0002-json-schema-normative-contract.md) §3) is renamed to `x-iap-*`; validators remain annotation-tolerant (`strict: false` / explicit keyword registration). Legacy `x-iis-*` keys are **not** accepted.
- Generated copies regenerated via `sync-schemas.mjs`; byte-equality tests unchanged.

## Runtime-model impact

Public types rename to the `IaP` brand casing: `IisDocument` → `IaPDocument`, `IisError` → `IaPError`, `IisGraph` → `IaPGraph`, `IisMcpServer` → `IaPMcpServer`, `IisWorkspaceResult` → `IaPWorkspaceResult`, `IISSDK` → `IaPSDK`. The Canonical Infrastructure Model ([IEP-0008](IEP-0008-canonical-infrastructure-model.md)) is structurally unchanged; only identifier spellings change.

## Validation impact

- A legacy `apiVersion` (`iis.dev/*`) is rejected with `IAP101`. There is no deprecation diagnostic, because there is no accepted-but-deprecated legacy affordance to warn about.
- The 33 error codes are renamed `IAP<nnn>` (Chapter 8). The registry and every conformance `# expected:` marker move to `IAP<nnn>` in the same change; the registry cross-check harness continues to require exactly one registry entry per emitted code.
- After the rename, an emitted or expected `IIS<nnn>` code is itself a defect (the legacy code does not exist).

## Provider impact

None to provider behavior or mapping semantics. Provider extension schema `$id`s change host (`https://iap.dev/providers/...`); the provider bin convention `iis-provider-*` → `iap-provider-*` (canonical only; no legacy alias). **Provider resource identity MUST NOT change** (semantic-equivalence requirement §5, item 4): a provider MUST assign the same identity to the same resource before and after the rename.

## Security impact

There is no `IIS_*` → `IAP_*` env-var fallback: only `IAP_*` variables are read, so no legacy variable is consumed and none is echoed in any diagnostic. Plan signing, `planId`, and `inputsHash` ([IEP-0011](IEP-0011-deterministic-planning-contract.md)) are unaffected because the rename is semantically inert; no secret handling or trust boundary changes.

## Cost impact

None. Cost annotations, estimation, pricing snapshots, and budgets are unaffected; the `cost.iap.dev`/`price-snapshot`/`cost-report` schema `$id`s change host only.

## Compatibility

- **No backward compatibility, by design.** This is a hard, pre-release rename. On every surface — `apiVersion`, filenames, schema `$id`/filenames, error codes, packages, CLI, LSP, MCP, env vars, annotations, and types — the legacy form is removed at the rename. A legacy `iis.dev/*` `apiVersion` is rejected (`IAP101`); a legacy `infrastructure.iis.yaml` is not discovered; the `iis` CLI, `iis_*` MCP tools, `IIS_*` env vars, `x-iis-*` annotations, `@iis/*` packages, and legacy schema `$id`s/filenames do not exist.
- **Nothing was published, so nothing breaks externally.** There is no VCS history binding third parties and no external consumer of any legacy form. The only artifacts affected are inside this repository, and they are converted to canonical form atomically across M19.0.3–M19.0.6.
- **Error codes** and every other legacy surface are breaking under Chapter 10; because the change is pre-release and authorized as breaking, it lands with the IaP rename release and is not reversible via any compatibility alias.

## Migration

- **First-party content:** the mechanical rename (M19.0.3–M19.0.6) rewrites this repository's own `apiVersion` values, filenames, annotation keys, error codes, schema `$id`s, and identifiers to canonical form. The rewrite is semantically inert (§5): provider resource identity is preserved, so persisted state and plan artifacts keep their meaning and a re-plan shows no resource churn attributable to the rename.
- **No external migration path.** Because nothing was published, there is no external document, package, or tool to migrate. An old `iis.dev/v1` document or `.iis.yaml` file is simply invalid input now; it is not read through any legacy-accepting parser (none exists). The migration record and historical `CHANGELOG.md` retain the legacy name permanently by design, purely as a historical record.

## Alternatives considered

1. **Retain a compatibility window** (legacy-accepting `apiVersion` parser, `iis` CLI alias, `iis_*` MCP aliases, `IIS_*` env fallback, legacy filename discovery, and `spec/schema/compatibility/` stubs). Rejected: with nothing published and no external consumer, every affordance is a code path that serves no one, enlarges the surface, keeps the legacy brand in the normative corpus, and eventually needs its own removal.
2. **Dual-accept error codes** (`IIS<nnn>` recognized as aliases). Rejected: leaves the legacy brand permanently in the normative conformance surface and doubles every consumer's match burden, for compatibility no external consumer needs.
3. **Bump `apiVersion` to `v2`** as part of the rename. Rejected: semantics are identical; a major bump would falsely signal format incompatibility and demand a migration transform where none is warranted.
4. **Duplicate legacy schemas** under their old names, or keep `$ref` stubs. Rejected: nothing consumes the legacy `$id`s/filenames, so resolving them is pure surface with drift risk; they are removed outright.
5. **Rebrand the `IEP` acronym.** Rejected: no `iis` in the letters; `IEP-####` identifiers are widely cross-referenced; prose expansion suffices.

## Implementation plan

1. **M19.0.3** — packages `@iis/*` → `@iap/*` (removed outright, no wrappers), TS types → `IaP*`, env vars `IIS_*` → `IAP_*` (no legacy fallback).
2. **M19.0.4** — canonical schema renames + `$id` host change (no compatibility stubs); regenerate generated copies and golden plans; `apiVersion` `*.iis.dev/*` → `*.iap.dev/*` with a parser that **rejects** legacy `iis.dev/*` (`IAP101`); rename `*.iis.yaml`/`*.iis-map.yaml` to canonical; **error-code hard rename gate** (registry + all `# expected:` markers).
3. **M19.0.5** — CLI bin `iap` only (no `iis` alias); default filename `infrastructure.iap.yaml` (no legacy discovery); LSP bin/requests `iap/*` only; MCP `iap_*` only (legacy `iis_*` returns unknown-tool).
4. **M19.0.6** — prose across spec/IEPs/ADRs/governance; redefine "IEP" expansion; protect the six Microsoft IIS references.

## Conformance requirements

- **NM-1 (legacy apiVersion rejected):** A document declaring a legacy `iis.dev/*` `apiVersion` (or any legacy typed sub-namespace) is **rejected** with `IAP101`; no legacy value validates and none is normalized to canonical.
- **NM-2 (canonical-only serialization):** The canonical serializer emits only `iap.dev/*`; there is no code path that reads or round-trips a legacy `apiVersion`.
- **NM-3 (semantic equivalence):** For every official example, a `plan` over fixed determinism inputs is byte-identical before and after the mechanical rename; `destructiveActions` and wave actions are unchanged (no create/replace/destroy attributable to the rename).
- **NM-4 (breaking, negative):** After the rename, no emitted diagnostic or `# expected:` marker uses `IIS<nnn>`; every code is `IAP<nnn>`; the registry contains exactly one entry per code with no `IIS<nnn>` survivor.
- **NM-5 (no legacy affordance):** No legacy surface is accepted — `infrastructure.iis.yaml` and `*.iis.yaml`/`*.iis-map.yaml` are not discovered; the `iis` CLI/LSP bins, `iis_*` MCP tools, and `IIS_*` env vars do not exist (a legacy `iis_*` call returns unknown-tool); and legacy schema `$id`s (`https://iis.dev/...`) and filenames (`iis-v1.schema.json`, `iis-mapping-v1.schema.json`) do not resolve.

## Open questions

None. The direction is fixed and there is no compatibility window whose parameters need resolving.

## Decision

Direction and canonical names authorized by the maintainer/approver on 2026-07-12 (the locked decisions recorded in [ADR-0003](../../docs/adr/ADR-0003-iap-naming-migration.md)), including explicit authorization of the **hard, pre-release breaking rename on every surface with no legacy aliases** — the legacy `apiVersion` is rejected, and legacy filenames, CLI, MCP tools, env vars, schema stubs, and error codes do not exist. Status remains **Review** per house convention pending formal Accepted status; the normative direction is fixed.

## References

- [ADR-0003 — IaP naming migration](../../docs/adr/ADR-0003-iap-naming-migration.md), [ADR-0002 — JSON Schema normative contract](../../docs/adr/ADR-0002-json-schema-normative-contract.md)
- [docs/migrations/iis-to-iap.md](../../docs/migrations/iis-to-iap.md) (hard-rename record + full error-code mapping), [iis-to-iap-hard-rename-map.yaml](../../docs/migrations/iis-to-iap-hard-rename-map.yaml), [iis-to-iap-protected-occurrences.yaml](../../docs/migrations/iis-to-iap-protected-occurrences.yaml)
- Spec [Chapter 2 — Document layout](../chapters/02-document-layout.md), [Chapter 8 — Validation](../chapters/08-validation.md), [Chapter 10 — Versioning](../chapters/10-versioning.md)
- [IEP-0008](IEP-0008-canonical-infrastructure-model.md) (CIM), [IEP-0011](IEP-0011-deterministic-planning-contract.md) (determinism inputs / plan identity)
