# The IIS → IaP rename (historical record)

The project was renamed from **IIS ("Infrastructure Intent Specification")** to **IaP ("Infrastructure as Prompt")** as a **hard, pre-release rename with zero backward compatibility**. This document is the historical record of that change: what changed, why no compatibility was retained, and the one safety guarantee the rename preserves. It intentionally uses the old name throughout to describe the change.

- **`IaP`** is the brand name used in prose. **`IAP`** (all caps) appears only where an uppercase code acronym is required, e.g. the error-code prefix.
- The authoritative decision is [ADR-0003](../adr/ADR-0003-iap-naming-migration.md); the normative specification change is [IEP-0014](../../spec/ieps/IEP-0014-iap-naming-migration.md).

## TL;DR

- This was a **hard cut, not a migration path.** Every legacy `IIS`/`iis.dev`/`IIS<nnn>` form was removed at the rename. There is no compatibility window, no deprecation aliases, and no legacy-accepting code path.
- **Old documents and files are now simply invalid.** A document with `apiVersion: iis.dev/v1` is rejected with error `IAP101`; a `.iis.yaml` / `.iis-map.yaml` file is not discovered. The `iis` CLI, `iis_*` MCP tools, `IIS_*` env vars, `@iis/*` packages, and legacy schema `$id`s/filenames do not exist.
- **The 33 validation error codes were renamed** `IIS<nnn>` → `IAP<nnn>` with **no alias** ([table below](#error-code-mapping-all-33-codes)); the numeric suffix and meaning are preserved.
- **Infrastructure is safe:** the rename changes no meaning. Provider resource identity is unchanged, so state and plans keep their meaning and the rename alone never creates, replaces, or destroys a cloud resource.

## Why no backward compatibility

The name appeared in machine-readable contracts (the document `apiVersion`, schema `$id`s and filenames, error codes) as well as in tooling and prose, so the change is a specification change governed by the IEP process, not a cosmetic edit. Crucially, the project was **pre-release**: nothing was ever published, released, or externally consumed, the repository is not under version control, and there is no third party with a document declaring `iis.dev/v1`, an `@iis/*` import, or a script matching `IIS<nnn>`.

With no consumer to protect, a compatibility window would have meant building and maintaining legacy-accepting parsers, CLI/MCP aliases, env-var fallbacks, filename-discovery fallbacks, and schema stubs — real, testable code paths that serve no one and keep the old brand alive in the normative corpus. A single hard cut is both correct and the cheapest option: the repository's own documents, fixtures, schemas, and registry were converted to canonical form atomically, and after the cut a legacy form is not a deprecated input but an error. See [ADR-0003](../adr/ADR-0003-iap-naming-migration.md) for the full rationale and [IEP-0014](../../spec/ieps/IEP-0014-iap-naming-migration.md) for the normative mechanics.

## What changed — before / after

| Surface                 | Before (IIS)                                                                                                                        | After (IaP)                                                                           | Legacy form now                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Product name (prose)    | Infrastructure Intent Specification / IIS                                                                                           | Infrastructure as Prompt / IaP                                                        | n/a                                            |
| Document `apiVersion`   | `iis.dev/v1`                                                                                                                        | `iap.dev/v1`                                                                          | **Rejected** with `IAP101`                     |
| Typed `apiVersion`s     | `plan.iis.dev/v1`, `conformance.iis.dev/v1`, `plugin.iis.dev/v1`, `mapping.iis.dev/v1`, `operations.iis.dev/v1`, `state.iis.dev/v1` | `*.iap.dev/v1`                                                                        | **Rejected** with `IAP101`                     |
| Schema `$id` host       | `https://iis.dev/...`                                                                                                               | `https://iap.dev/...`                                                                 | Does not resolve (no compat stubs)             |
| Schema filenames        | `iis-v1.schema.json`, `iis-mapping-v1.schema.json`                                                                                  | `iap-v1.schema.json`, `iap-mapping-v1.schema.json`                                    | Do not exist                                   |
| Schema annotations      | `x-iis-*`                                                                                                                           | `x-iap-*`                                                                             | Not accepted                                   |
| Default filename        | `infrastructure.iis.yaml`                                                                                                           | `infrastructure.iap.yaml`                                                             | **Not discovered**                             |
| File suffixes           | `*.iis.yaml`, `*.iis-map.yaml`                                                                                                      | `*.iap.yaml`, `*.iap-map.yaml`                                                        | **Not discovered**                             |
| CLI bin                 | `iis`                                                                                                                               | `iap`                                                                                 | No `iis` alias (command not found)             |
| Language server         | `iis-language-server`; `iis/preview`, `iis/canonical`                                                                               | `iap-language-server`; `iap/*`                                                        | No legacy bin or `iis/*` methods               |
| MCP tools               | `iis_*` (e.g. `iis_validate`)                                                                                                       | `iap_*` (e.g. `iap_validate`)                                                         | `iis_*` returns unknown-tool                   |
| Env vars                | `IIS_TOOLS`, `IIS_ANNOTATION_KEYWORDS`, `IIS_SPEC_VERSION`, `IIS_DETERMINISM_PERTURBATION`                                          | `IAP_*`                                                                               | `IIS_*` ignored (no fallback)                  |
| Packages                | `@iis/*`, `iis-monorepo`                                                                                                            | `@iap/*`, `iap-monorepo`                                                              | **Removed** — no wrappers (nothing published)  |
| TypeScript types        | `IisDocument`, `IisError`, `IisGraph`, `IisMcpServer`, `IisWorkspaceResult`, `IISSDK`                                               | `IaPDocument`, `IaPError`, `IaPGraph`, `IaPMcpServer`, `IaPWorkspaceResult`, `IaPSDK` | Renamed outright                               |
| Provider bin convention | `iis-provider-*`                                                                                                                    | `iap-provider-*`                                                                      | No legacy alias                                |
| **Error codes**         | `IIS<nnn>` (33)                                                                                                                     | `IAP<nnn>`                                                                            | **Not recognized — no alias**                  |
| IEP process             | "IIS Enhancement Proposal", `IEP-####`                                                                                              | "IaP Enhancement Proposal", `IEP-####`                                                | Acronym & IDs **kept**; expansion only changed |

## Old documents and files are invalid now

Because the rename is a hard cut, legacy artifacts are not migrated — they are invalid input:

- **`apiVersion`.** A document declaring `iis.dev/v1` (or any legacy typed sub-namespace such as `plan.iis.dev/v1`) is **rejected with `IAP101`**. There is no normalization to the canonical value and no deprecation warning — the legacy string is not a valid `apiVersion`.
- **Filenames.** `infrastructure.iis.yaml`, `*.iis.yaml`, and `*.iis-map.yaml` are **not discovered**. A project still using a legacy filename is simply not found; only `infrastructure.iap.yaml` / `*.iap.yaml` / `*.iap-map.yaml` are recognized.
- **Schemas.** The legacy `$id` host `https://iis.dev/...` and the filenames `iis-v1.schema.json` / `iis-mapping-v1.schema.json` do not resolve; there is no `spec/schema/compatibility/` stub directory.
- **Tooling.** There is no `iis` CLI, no `iis-language-server`, no `iis_*` MCP tools (a legacy call returns unknown-tool), no `IIS_*` env-var fallback, and no `@iis/*` packages.

None of this affects any external party, because nothing was published.

## The breaking error-code rename

All 33 validation error codes were renamed from `IIS<nnn>` to `IAP<nnn>`. **There is no legacy alias:** `IIS<nnn>` is not recognized anywhere — not in diagnostics, the error-code registry, or conformance `# expected:` markers. The numeric suffix and its meaning are preserved (`IIS402` and `IAP402` mean the same thing).

This was a deliberate, **approver-authorized breaking specification change** (see [ADR-0003](../adr/ADR-0003-iap-naming-migration.md) and [IEP-0014](../../spec/ieps/IEP-0014-iap-naming-migration.md)), and — like every other surface in this rename — safe as a hard cut because nothing was published and there are no external consumers. The repository's own fixtures and registry were converted in the same change.

### Error-code mapping (all 33 codes)

| Legacy   | Canonical |     | Legacy   | Canonical |     | Legacy   | Canonical |
| -------- | --------- | --- | -------- | --------- | --- | -------- | --------- |
| `IIS101` | `IAP101`  |     | `IIS301` | `IAP301`  |     | `IIS503` | `IAP503`  |
| `IIS102` | `IAP102`  |     | `IIS302` | `IAP302`  |     | `IIS504` | `IAP504`  |
| `IIS103` | `IAP103`  |     | `IIS303` | `IAP303`  |     | `IIS505` | `IAP505`  |
| `IIS104` | `IAP104`  |     | `IIS401` | `IAP401`  |     | `IIS601` | `IAP601`  |
| `IIS105` | `IAP105`  |     | `IIS402` | `IAP402`  |     | `IIS602` | `IAP602`  |
| `IIS201` | `IAP201`  |     | `IIS403` | `IAP403`  |     | `IIS603` | `IAP603`  |
| `IIS202` | `IAP202`  |     | `IIS501` | `IAP501`  |     | `IIS604` | `IAP604`  |
| `IIS203` | `IAP203`  |     | `IIS502` | `IAP502`  |     | `IIS701` | `IAP701`  |
| `IIS204` | `IAP204`  |     |          |           |     | `IIS702` | `IAP702`  |
| `IIS205` | `IAP205`  |     |          |           |     | `IIS801` | `IAP801`  |
|          |           |     |          |           |     | `IIS802` | `IAP802`  |
|          |           |     |          |           |     | `IIS803` | `IAP803`  |
|          |           |     |          |           |     | `IIS804` | `IAP804`  |
|          |           |     |          |           |     | `IIS805` | `IAP805`  |
|          |           |     |          |           |     | `IIS806` | `IAP806`  |

The transform is exactly "replace the `IIS` prefix with `IAP`, keep the three digits" for all 33 codes. Chapter 8 (`spec/chapters/08-validation.md`) remains the authority for what each code means.

## State and plan safety guarantee

Although the rename is a hard cut on every naming surface, it is **semantically inert**. The specification requires ([IEP-0014](../../spec/ieps/IEP-0014-iap-naming-migration.md) §5, semantic-equivalence requirement) that the rename changes **none** of:

1. resource intent (which resources and their fields),
2. relationships and relationship verbs,
3. provider mapping selection and output,
4. **provider resource identity** (what a provider considers the "same" live resource),
5. execution actions in a plan.

Concretely:

- **State and plans keep their meaning.** First-party state and plan artifacts were rewritten to canonical form by the mechanical rename, and `planId` / `inputsHash` are unaffected because the rename does not alter plan content semantics.
- **No resource churn.** Re-running `iap plan` after the rename, with all other [determinism inputs](../../spec/ieps/IEP-0011-deterministic-planning-contract.md) unchanged, produces the same actions as before. **The rename alone never creates, replaces, or destroys a cloud resource.** If a plan shows resource changes attributable only to the rename, that is a bug, not expected behavior.

This guarantee is preserved because it is a property of how identity is derived — the literal brand string must never fold into a resource key, `planId`, or `inputsHash` — not a compatibility affordance for legacy names.

## What keeps the old name

Two things intentionally keep the old name forever: **this record** (it must describe the change) and **historical `CHANGELOG.md` entries** (they record the project under its former name and are never rewritten).

## References

- [ADR-0003 — IaP naming migration](../adr/ADR-0003-iap-naming-migration.md)
- [IEP-0014 — IaP naming migration](../../spec/ieps/IEP-0014-iap-naming-migration.md)
- [iis-to-iap-hard-rename-map.yaml](iis-to-iap-hard-rename-map.yaml) (exact rename map), [iis-to-iap-protected-occurrences.yaml](iis-to-iap-protected-occurrences.yaml) (allowlist gate)
- [iis-to-iap-inventory.md](../reports/iis-to-iap-hard-rename-inventory.md) (full inventory)
- Spec [Chapter 8 — Validation](../../spec/chapters/08-validation.md), [Chapter 10 — Versioning](../../spec/chapters/10-versioning.md)
