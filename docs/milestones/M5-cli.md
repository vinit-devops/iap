# Milestone M5.1 + M5.2 + M5.4 — Reference CLI (`@iap/cli`)

**Phase:** 5 — Reference CLI
**Milestones:** M5.1 (skeleton + validate/format/normalize/explain/diff/graph), M5.2 (analysis commands), M5.4 (automation contracts)
**Status:** Completed (M5.3 `iap create` remains pending — gated on Phase 3)
**Date:** 2026-07-10

## Implemented

`packages/cli` (`@iap/cli` 0.1.0, bin `iap`) — a thin shell over `@iap/sdk` and `@iap/architecture` per ch. 22: every command invokes SDK components and formats their artifacts; the CLI adds no semantics of its own. Runtime dependencies are the two workspace engines plus `yaml` (already in the workspace set); `@iap/model`/`@iap/parser` appear as dependencies for **type-only** imports of the canonical-model types. Argv parsing is hand-rolled (`src/shared.ts`) — no new external dependencies.

Global conventions (ch. 22 §22.1): default input `infrastructure.iap.yaml`, `--file`/`-f` override; `--profile` selects the merged view (inspecting commands default to the unmerged base document); `--output`/`-o` `human|json` (+`sarif` for validate, `dot` for graph, `mermaid|dot|json` for diagram); `--quiet`; `--no-color` accepted (output is never colored); exit codes **0** success / **1** error-severity findings / **2** usage error (unknown flag/command, unreadable file) / **3** operation failure. Machine outputs are deterministic — stable ordering, no timestamps — and every JSON payload carries **`formatVersion: 1`**.

### Command status vs ch. 22 and the roadmap Phase 5 list

| Command                                           | Source               | Status  | Notes                                                                                                                                                           |
| ------------------------------------------------- | -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`                                        | §22.2.1 / roadmap    | ✅      | Executable phases 1–5: validator phases 1–4 + policy (IAP5xx) via `policies()`; per-phase ✔/✖/⚠/– table, `--strict`, JSON, SARIF 2.1.0                          |
| `graph`                                           | §22.2.3 / roadmap    | ✅      | Canonical edge set + execution waves; `-o human\|json\|dot` (DOT = ch. 18 dependency view)                                                                      |
| `diagram`                                         | §22.2.4 / roadmap    | ✅      | All five ch. 18 views via `@iap/architecture` (`--view`, `--application`); Mermaid (default), DOT, JSON                                                         |
| `policy`                                          | roadmap              | ✅      | Document policies + repeatable `--pack` from the six built-in `POLICY_PACKS`; findings, evaluation trace, RFC 7386 autofix patches                              |
| `normalize`                                       | roadmap              | ✅      | Canonical byte projection (C5+C6) to stdout; `-o json` wraps it with the canonical hash                                                                         |
| `fmt` (alias `format`)                            | §22.2.12 / roadmap   | ✅      | Round-trip YAML re-serialization per the SDK contract (hash-neutral, test-pinned); stdout or `--write`. Canonical-form rewrite + `--check` deferred (see below) |
| `explain`                                         | roadmap              | ✅      | Kind, effective values with per-leaf provenance (explicit/default/profile, IEP-0008), edges in/out, wave position                                               |
| `diff`                                            | roadmap              | ✅      | Semantic diff of two canonical models (`--profile` base, `--profile-b` other): added/removed/changed resources with changed leaf pointers                       |
| `doctor`                                          | roadmap              | ✅      | Loaded package versions, spec apiVersion, registry version + end-to-end run over the target document (validate 1–5, hash, waves)                                |
| `init`                                            | roadmap              | ✅      | Schema-valid starter document; refuses to overwrite without `--force`                                                                                           |
| `version`, `help`                                 | —                    | ✅      | Convenience; bare `iap` is a usage error (exit 2) with usage on stderr                                                                                          |
| `create`, `edit`                                  | roadmap              | ⏳ stub | Phase 3 (Intent Authoring Engine and Intent Compiler) — **M5.3 pending**                                                                                        |
| `provider`, `extension`                           | roadmap              | ⏳ stub | Phase 6 (Provider Mapping and Plugin Framework)                                                                                                                 |
| `plan`                                            | §22.2.2 / roadmap    | ⏳ stub | Phase 7 (Deterministic Planner)                                                                                                                                 |
| `cost`                                            | §22.2.5 / roadmap    | ⏳ stub | Phase 10 (Cost Engine)                                                                                                                                          |
| `security`, `compliance`                          | §22.2.6–7 / roadmap  | ⏳ stub | Phase 11 (Security and Compliance Engines)                                                                                                                      |
| `deploy`, `destroy`, `rollback`, `drift`, `state` | §22.2.8–10 / roadmap | ⏳ stub | Phase 14 (Deployment, State, Verification and Drift)                                                                                                            |
| `import`, `export`                                | roadmap              | ⏳ stub | Phase 18 (Ecosystem, Migration and Open Standardization)                                                                                                        |

Every stub prints exactly one stable line to stderr — `iap <cmd>: not yet available — requires Phase <N> (<title>) engines; tracked in ROADMAP.yaml` — and exits 2, per the roadmap's "deployment-related commands remain disabled or experimental until their phases are complete".

### Automation contracts (M5.4)

- **JSON output** on every implemented command (`formatVersion: 1`, stable key order, byte-identical across runs — pinned by a determinism test).
- **SARIF 2.1.0** from `iap validate -o sarif`: rules from the embedded error-code registry (id, `shortDescription` from the title, `defaultConfiguration.level` from the registry severity; `contextual` maps to `warning`), results with physical source regions whenever the parser source map resolves the finding's JSON Pointer (nearest-ancestor fallback) plus the pointer as a logical location.
- **Exit codes** as above; **stdin-free, prompt-free** operation throughout; `--quiet` for exit-code-only use; `--no-color` accepted.
- The error-code registry is embedded (`packages/cli/registry/error-codes.yaml`) with a byte-equality drift test against `spec/conformance/error-codes.yaml` — the `@iap/model` embedded-schema pattern.

## Files changed

Created: `packages/cli/{package.json,tsconfig.json}`, `packages/cli/registry/error-codes.yaml` (embedded copy), `packages/cli/src/{cli.ts,shared.ts,registry.ts,sarif.ts,version.ts}`, `packages/cli/src/commands/{validate,graph,diagram,policy,normalize,explain,diff,doctor,init,stubs}.ts`, `packages/cli/test/cli.test.ts`, this document, `docs/reports/phase-5-completion.md`. Modified: `ROADMAP.yaml`, `CHANGELOG.md`, `docs/architecture/compatibility-matrix.md`.

## Tests added

39 tests in `packages/cli/test/cli.test.ts`, all exercising the exported `run(argv, io)` entry point in-process (the bin shim calls the same function): registry drift guard; validate human/JSON/SARIF on `basic-webapp` (exit 0) and `invalid/01-unknown-kind` (exit 1, IAP102, SARIF source region); JSON determinism; unreadable-file usage error; normalize profile-sensitivity of the canonical hash; all five diagram views rendering `flowchart TD` Mermaid (+JSON/DOT formats, usage errors); graph human/JSON/DOT; `policy --pack private-only` on `serverless-api` (exit 1, IAP501 on the public gateway) and unknown-pack usage error; semantic diff base-vs-production (changed resources `web`/`orders-db` with leaf pointers) and identical-model case; fmt round-trip hash preservation (stdout and `--write`); explain provenance (explicit + profile sources), edges, waves, unknown-id error; doctor versions + document health; init create/validate/refuse/`--force`; unknown command/flag, stub phase messages, help/version, `--quiet`.

## Conformance status

Green. `pnpm exec vitest run packages/cli` 39/39; `pnpm exec eslint packages/cli` clean; spec harness `node tests/conformance/run.mjs` 59/59; end-to-end smoke `node packages/cli/dist/cli.js validate --file spec/examples/basic-webapp.iap.yaml` exits 0 with the five-phase table. (Full-workspace `pnpm run verify` is currently red only in `packages/language-server`, which is mid-flight in a parallel Phase 4 work stream — nothing in this milestone touches it.)

## Architecture decisions

- **One entry point for bin and tests.** `src/cli.ts` exports `run(argv, {stdout, stderr}): Promise<exitCode>` over injected writers; the shebang shim executes it only when the file is the real process entry (realpath-compared). Everything CI observes is therefore covered in-process.
- **Validate = executable pipeline, honestly labeled.** Ch. 22 §22.2.1 names phases 1–8; only 1–5 have engines today (validator + policy). The CLI reports exactly those five phases rather than fabricating empty security/compliance/version rows.
- **Registry embedding over runtime spec-tree reads.** The published CLI must not reach into `spec/`; the drift test keeps the copy honest.
- **`fmt` as SDK round-trip, not canonical rewrite.** The SDK's `serialize('yaml')` round-trip (authored key order, hash-neutral — test-pinned) is the deterministic formatter available today; ch. 22's canonical-form rewrite with `--check` needs a comment-preserving canonical emitter and is deferred (see Known limitations).

## Specification gaps

- Ch. 22 fixes `-o` values as `human|json|sarif` globally but §22.2.3/§22.2.4 also use `-o dot` / `-o mermaid` — the CLI accepts the per-command supersets and additionally offers `--format` for graph/diagram; a ch. 22 clarification would help.
- The ch. 22 §22.2.1 sample prints dotted paths (`resources.api…`); engine findings carry RFC 6901 pointers (policy findings: dotted field paths per ch. 7). The CLI prints paths verbatim from the engines. Sample outputs are informative, but an alignment pass would improve polish.

## Security findings

None. The CLI adds no network access, no clock reads in machine output, and no code execution beyond the SDK engines it composes. `deploy` cannot run at all (exit 2), which structurally enforces the review-before-deploy contract for now.

## Known limitations

- `iap migrate` (§22.2.11) is not registered: there is no second specification major to migrate to yet; it arrives with the ch. 10 transform when `iap.dev/v2` exists.
- `iap fmt --check` (CI canonical-form check, §22.2.12) is deferred with the canonical-YAML emitter; `iap normalize` piped to comparison covers the CI use case meanwhile.
- Validation phases 6–8 (security, compliance, version/extension) surface in `iap validate` when their engines land (Phases 11+); `iap validate` output will grow rows, not change shape.
- Shell completions (roadmap deliverable) are deferred to the M5.3 wrap-up.

## Next milestone

M5.3 — `iap create`/`iap edit` natural-language flow, **gated on Phase 3** (Intent Authoring Engine and Intent Compiler). Phase 5 stays in-progress until then.
