# ADR-0003: IIS → IaP naming migration and the error-code breaking rename

**Status:** Accepted
**Date:** 2026-07-12

## Context

The project is being rebranded from **IIS ("Infrastructure Intent Specification")** to **IaP ("Infrastructure as Prompt")** (Phase 19). The legacy name is woven through 427 files and ~3,299 matching lines: the document `apiVersion` (`iis.dev/v1` and nine typed sub-namespaces), schema `$id` hosts (`https://iis.dev/...`), schema filenames (`iis-v1`, `iis-mapping-v1`), the default input filename (`infrastructure.iis.yaml`), the CLI/LSP bin names (`iis`, `iis-language-server`), MCP tool names (`iis_*`), environment variables (`IIS_*`), public TypeScript types (`IisDocument`, `IisError`, …), 33 validation error codes (`IIS<nnn>`), and prose across the spec, IEPs, ADRs, and governance docs. The complete machine-readable rename map is [`docs/migrations/iis-to-iap-hard-rename-map.yaml`](../migrations/iis-to-iap-hard-rename-map.yaml); the inventory is [`docs/reports/iis-to-iap-hard-rename-inventory.md`](../reports/iis-to-iap-hard-rename-inventory.md).

A rename of this reach touches every machine-readable identity string at once: `apiVersion`, filenames, schema `$id`s, error codes, package scopes, CLI/LSP bins, MCP tool names, and environment variables. Because the project is **pre-release**, this is done as a **single hard cut** — the legacy `IIS`/`iis.dev`/`IIS<nnn>` forms are removed outright at the rename, with no compatibility window, no deprecation aliases, and no legacy-accepting parsers. The one invariant that must survive the cut is **provider resource identity**: existing state and plan artifacts must keep loading and the rename alone must never create, replace, or destroy a cloud resource. That is a property of how identity is derived, not a compatibility affordance for legacy names.

The repo is **not under version control and nothing has been published, released, or externally consumed**. That fact removes the entire compatibility obligation: there are no external consumers of `@iis/*` packages, no third-party documents declaring `iis.dev/v1`, and no downstream tooling matching `IIS<nnn>` to protect. A hard cut is therefore both correct and the cheapest option — retaining legacy affordances would build and maintain code paths that no consumer needs. This decision needs to be made now, ahead of the mechanical rename milestones (M19.0.3–M19.0.6), because those milestones remove the legacy forms rather than dual-supporting them.

The normative mechanics live in [IEP-0014](../../spec/ieps/IEP-0014-iap-naming-migration.md); this ADR records the implementation-level decision and, in particular, authorizes the one deliberately breaking part of the change.

## Decision

We will migrate the project name to **IaP** and adopt the following canonical names as a **hard, pre-release breaking rename with zero backward compatibility**. `IaP` is the brand form used in prose; `IAP` (all caps) is used only where an uppercase code acronym is required (e.g. error-code prefix, some type identifiers). On every surface below the legacy `IIS`/`iis.dev`/`IIS<nnn>` form is **removed**, not deprecated: there is no compatibility window, no alias, and no legacy-accepting code path.

1. **`apiVersion`.** Canonical is `iap.dev/v1` (and `plan.iap.dev/v1`, `conformance.iap.dev/v1`, `plugin.iap.dev/v1`, `mapping.iap.dev/v1`, `operations.iap.dev/v1`, `state.iap.dev/v1`, and the `v2` forward variants). The legacy `iis.dev/*` values are **NOT accepted**: a document declaring `iis.dev/v1` (or any legacy typed sub-namespace) is **rejected with validation error `IAP101`**. There is no normalization, no deprecation warning, and no compatibility window. This is not a version bump — `v1` semantics are unchanged.

2. **Schema `$id` and filenames.** The `$id` host changes `https://iis.dev/...` → `https://iap.dev/...` for all 12 `$id` values. The two name-bearing schema files rename `iis-v1.schema.json` → `iap-v1.schema.json` and `iis-mapping-v1.schema.json` → `iap-mapping-v1.schema.json`. There is **no `spec/schema/compatibility/` directory and no legacy-named schema stubs**: the legacy `$id`s and filenames simply do not resolve. Generated schema copies are regenerated from the canonical source, never hand-edited.

3. **Filename discovery.** The only discovered input filename is `infrastructure.iap.yaml` (suffixes `*.iap.yaml` / `*.iap-map.yaml`). Legacy `infrastructure.iis.yaml` / `*.iis.yaml` / `*.iis-map.yaml` names are **not discovered** — a project that still uses them is simply not found. No legacy discovery means no ambiguity case to resolve.

4. **CLI.** The only bin is `iap`. There is **no `iis` alias**; invoking `iis` is a command-not-found. `iap-language-server` is the only language-server bin; the LSP request methods are `iap/preview` and `iap/canonical`, with no legacy `iis/*` methods.

5. **Packages.** Canonical scope is `@iap/*` (26 packages) and the root `iap-monorepo`. The legacy `@iis/*` names are **removed** — **no `@iis/*` compatibility wrapper packages exist and no second source tree is maintained**.

6. **MCP tools.** The only prefix is `iap_*`. There are **no `iis_*` aliases**; a call to a legacy `iis_*` tool name returns an **unknown-tool error**.

7. **Environment variables.** The only variables read are `IAP_TOOLS`, `IAP_ANNOTATION_KEYWORDS`, `IAP_SPEC_VERSION`, `IAP_DETERMINISM_PERTURBATION`. There is **no `IIS_*` fallback**; a legacy `IIS_*` variable is ignored.

8. **Error codes — BREAKING.** All 33 codes are hard-renamed `IIS<nnn>` → `IAP<nnn>` (e.g. `IIS402` → `IAP402`), preserving the numeric suffix and its meaning. **There is no legacy alias**: `IIS<nnn>` is not a recognized code anywhere. (This was already the decision and is unchanged.)

9. **Type identifiers.** `IisDocument` → `IaPDocument`, `IisError` → `IaPError`, `IisGraph` → `IaPGraph`, `IisMcpServer` → `IaPMcpServer`, `IisWorkspaceResult` → `IaPWorkspaceResult`, `IISSDK` → `IaPSDK`, using the `IaP` brand casing uniformly.

10. **IEP process.** The acronym **`IEP` and all `IEP-####` identifiers are kept**; only the expansion changes in prose from "IIS Enhancement Proposal" to "IaP Enhancement Proposal."

11. **State and plans — identity-preserving.** The rename is semantically inert. **Provider resource identity MUST NOT change because of the rename**, and the rename alone MUST never create, replace, or destroy a cloud resource. This is the one invariant preserved across the hard cut, because it is a property of how identity is derived — not a compatibility affordance for legacy names. (Existing artifacts are migrated to canonical form by the mechanical rename; they are not read through any legacy-accepting parser, since none exists.)

### Rationale for the hard cut

Because the project is **pre-release** — nothing published, no VCS history binding third parties, no external consumer of any legacy form — there is no compatibility obligation to discharge. Every legacy affordance (a legacy-accepting `apiVersion` parser, an `iis` CLI alias, `iis_*` MCP aliases, `IIS_*` env fallbacks, legacy filename discovery, and `spec/schema/compatibility/` schema stubs) would be a real, testable code path that exists only to serve consumers who do not exist. It would also leave the legacy brand embedded in the normative surface — most acutely for error codes, whose `# expected: IIS<nnn>` markers and registry entries would otherwise be a permanent "lone survivor" of the old name. A hard cut removes all of this at once: the repository's own documents, fixtures, schemas, and registry are converted atomically across M19.0.3–M19.0.6, and after the cut a legacy form is not a deprecated input but an error. The maintainer/approver has authorized the rename as a **breaking specification change** on every surface, tracked through IEP-0014; it is not reversible via any compatibility alias.

## Consequences

- **One clear brand, immediately.** After the rename there is a single canonical name everywhere and no legacy form to reason about; the allowlist gate (`docs/migrations/iis-to-iap-protected-occurrences.yaml`) can fail any new legacy occurrence outright.
- **No compatibility code to build or maintain.** There is no apiVersion legacy-accepting parser, no filename fallback discovery, no CLI/MCP aliases, no env-var fallback, and no `spec/schema/compatibility/` stubs. The surface is smaller and there are no deprecation code paths to test or eventually remove.
- **Breaking on every surface (negative, accepted).** Any legacy artifact — a document with `apiVersion: iis.dev/v1`, an `infrastructure.iis.yaml` file, a script calling `iis`, an `iis_*` MCP call, an `IIS_*` env var, or anything matching a literal `IIS<nnn>` code — stops working after the rename. This is acceptable because the project is pre-release and no such artifact exists outside this repository, whose own content is converted atomically across M19.0.3–M19.0.6.
- **No dual source tree.** Removing `@iis/*` outright avoids the maintenance and drift burden of wrapper packages — viable because nothing was published.
- **State/plan safety is a hard invariant.** Reconciliation, plan `inputsHash`, `planId`, and provider resource identity are unaffected by the rename; a re-plan after the rename must show no resource churn attributable to the name change. This constrains how identity is derived (it must not fold in the literal brand string in a way the rename would perturb).

## Alternatives considered

- **Retain a compatibility window (legacy-accepting `apiVersion` parser, `iis` CLI alias, `iis_*` MCP aliases, `IIS_*` env fallback, legacy filename discovery, and `spec/schema/compatibility/` stubs).** Rejected: with nothing published and no external consumer, every such affordance is a code path that serves no one while enlarging the surface, keeping the legacy brand alive in the normative corpus, and eventually needing its own removal. A hard cut is cheaper and cleaner.
- **Dual-accept error codes (`IIS<nnn>` recognized as aliases of `IAP<nnn>`).** Rejected: it leaves the legacy name permanently embedded in the normative conformance surface and doubles the match burden for every consumer, for compatibility nobody needs.
- **Publish `@iis/*` wrapper packages that re-export `@iap/*`.** Rejected: nothing was ever published and the repo is not under version control, so there are no external importers; wrappers would add a second name surface and drift risk for zero benefit.
- **Bump `apiVersion` to `v2` as part of the rename.** Rejected: the rename changes no semantics, so a major version bump would falsely signal an incompatible format and force a migration transform where none is warranted; the host changes, the version does not.
- **Rebrand the `IEP` acronym.** Rejected: the letters contain no `iis`, `IEP-####` identifiers are widely cross-referenced, and only the prose expansion needs updating.

## References

- [IEP-0014 — IaP naming migration](../../spec/ieps/IEP-0014-iap-naming-migration.md) (normative mechanics)
- [docs/migrations/iis-to-iap.md](../migrations/iis-to-iap.md) (hard-rename record + full error-code mapping)
- [docs/migrations/iis-to-iap-hard-rename-map.yaml](../migrations/iis-to-iap-hard-rename-map.yaml) (exact rename map), [iis-to-iap-protected-occurrences.yaml](../migrations/iis-to-iap-protected-occurrences.yaml) (allowlist gate)
- [docs/reports/iis-to-iap-hard-rename-inventory.md](../reports/iis-to-iap-hard-rename-inventory.md) (inventory)
- [ADR-0002](ADR-0002-json-schema-normative-contract.md) (schema is the normative contract), Spec [Chapter 8](../../spec/chapters/08-validation.md) (error codes), [Chapter 10](../../spec/chapters/10-versioning.md) (versioning/compatibility)
