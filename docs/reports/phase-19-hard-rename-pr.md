# PR: refactor!: hard rename IIS to IaP before public release

> **Branch (logical):** `phase-19/hard-rename-iis-to-iap`
> **Status:** ready for approval — **do not merge without explicit approval**
> **Note on git:** this repository is not under version control, and the standing
> project directive is to not run `git init`/commit here without an explicit ask.
> The "branch/PR/merge" steps are therefore represented logically; this document
> is the reviewable PR artifact. Say the word and I will initialize git, create
> the branch, and open a real PR.

## Why backward compatibility is intentionally not retained

Nothing has been published, released, externally consumed, or integrated outside
this repository. A compatibility layer (CLI/package/MCP aliases, legacy
`iis.dev/v1` acceptance, `.iis.yaml` discovery, `IIS_*` fallback, dual-emitted
diagnostics) would add permanent surface area and drift risk to protect
consumers that do not exist. This is a **pre-release internal breaking migration**:
every legacy affordance is removed, not aliased.

## Confirmation nothing was previously published

No published `@iis/*` packages, no released `iis` CLI, no external `iis.dev/v1`
documents, no consumers of the `IIS<nnn>` diagnostic codes. Verified against the
inventory ([`docs/reports/iis-to-iap-hard-rename-inventory.md`](iis-to-iap-hard-rename-inventory.md)).

## Exact naming changes

Full machine-readable map: [`docs/migrations/iis-to-iap-hard-rename-map.yaml`](../migrations/iis-to-iap-hard-rename-map.yaml).

| Surface         | From                                                                     | To                                                        |
| --------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Product / prose | IIS / Infrastructure Intent Specification                                | IaP / Infrastructure as Prompt                            |
| apiVersion      | `iis.dev/v1` (+ typed sub-namespaces)                                    | `iap.dev/v1` (**legacy rejected, IAP101**)                |
| Filenames       | `infrastructure.iis.yaml`, `*.iis.yaml`, `*.iis-map.yaml`                | `.iap.yaml` / `.iap-map.yaml` (**legacy not discovered**) |
| Schemas         | `iis-v1.schema.json`, `iis-mapping-v1.schema.json`, `$id` host `iis.dev` | `iap-*` + host `iap.dev`                                  |
| Packages        | `@iis/*` (26) + `iis-monorepo`                                           | `@iap/*` + `iap-monorepo` (**no wrappers**)               |
| CLI             | `iis`                                                                    | `iap` (**no `iis` alias**)                                |
| LSP             | `iis-language-server`, `iis/preview`, `iis/canonical`                    | `iap-*`                                                   |
| MCP tools       | `iis_*` (5)                                                              | `iap_*` (**legacy names → unknown-tool error**)           |
| Env vars        | `IIS_*` (4)                                                              | `IAP_*` (**no fallback**)                                 |
| Types           | `IisDocument`, `IisError`, `IisMcpServer`, … `IISSDK`                    | `IaPDocument`, `IaPError`, `IaPMcpServer`, … `IaPSDK`     |
| Diagnostics     | `IIS101…IIS806` (33)                                                     | `IAP101…IAP806` (**no alias**)                            |

## Diagnostic-code mapping

All 33 codes, numeric suffix + severity + meaning unchanged — see the
`diagnosticMigration:` block in the map. Conformance `# expected:` markers, the
error-code registry, and SARIF rule IDs all use `IAP###`. No `IIS###` is
recognized or emitted anywhere.

## Files renamed / packages renamed

57 file renames (53 `*.iis(.map).yaml` examples/fixtures + 2 schema files ×2
copies), 26 workspace packages + root, ~480 content-edited files. Method: an
ordered, exact, token-scoped engine ([`tools/rename-iis-to-iap.mjs`](../../tools/rename-iis-to-iap.mjs) +
[`tools/rename-rules.mjs`](../../tools/rename-rules.mjs)) — never a blind `s/iis/iap/`.

## Tests run

`pnpm verify` (build · lint · unit · conformance · providers · determinism ·
eval · **check:names**) → **PASS**; `pnpm typecheck` → PASS; `pnpm format:check`
→ PASS. Unit: **1213 passed / 5 skipped** (rename returned the suite to the
pre-rename baseline of 1178; +35 hard-rename negative/safety tests added).

## Semantic-equivalence evidence

Regenerated golden plans, with the naming reversed (`iap→iis`, `IAP→IIS`) and
hashes stripped, are **byte-identical** to the pre-rename goldens. No resource
intent, relationship, provider mapping, provider resource identity, or execution
action changed. Provider packages were re-signed (content-digest change only);
their structural acceptance tests (resource realization, `dependsOn` derivation,
byte-identical double-run PC-3) pass. The rename introduces **no** infrastructure
create/replace/update/destroy operation.

## Negative safety

- `apiVersion: iis.dev/v1` → **rejected** (IAP101). `packages/parser/test/parser.test.ts`.
- `.iis.yaml` not auto-discovered; only `iap` bin. `packages/cli/test/hard-rename.test.ts`.
- Legacy `iis_*` MCP tools → **unknown-tool error**. `packages/mcp-server/test/server.test.ts`.
- Unrelated words (`this`, `missing`, `permissions`, `submission`, `Hawaii`) and hashes **unchanged**; external `Microsoft IIS` **unchanged**. `tests/rename-safety.test.ts`.

## Protected / remaining old-name occurrences

Enumerated in [`docs/migrations/iis-to-iap-protected-occurrences.yaml`](../migrations/iis-to-iap-protected-occurrences.yaml):
external Microsoft IIS (in `roadmap-v2`), the migration record itself, historical
changelog/plan/tracker docs, generated/lockfile content, and the rename tooling.
The `check:names` gate FAILS on any project-specific old-name occurrence outside
this list.

## Known limitations

- The repo is not under git, so no real branch/PR/merge exists (see note above).
- `spec/schema/compatibility/` was **not** created (hard cut — no compat schemas).
- `IEP-0014` is Status **Review** (not yet Accepted); ADR-0003 is Accepted.

## Reviewer findings (self-review + agent reviews)

- Fixed: mis-cased `IaP[` in two error-code regexes (`tests/conformance/run.mjs`,
  `packages/validator/test/validator.test.ts`) that would have silently skipped
  code cases — now `IAP[`, with a dedicated engine rule + regression test.
- Fixed: 6 source files using a raw NUL hash separator were initially skipped by
  the engine's binary guard — guard now processes text extensions regardless.
- Reverted: compat code (legacy apiVersion accept, `iis` CLI alias, `iis_*` MCP
  aliases) added before the hard-rename directive; replaced with rejection + tests.

## Next action

Begin **M19.1 Independent Implementation Audit** only after approval (and, if git
is initialized, merge) of this rename.
