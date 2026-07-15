# IaP IDE and Assistant Integration Guide

**Roadmap Phase 13 (M13.1, M13.3).** How editors and AI assistants integrate with IaP. Every
integration reuses the same reference components as the CLI — the language server
(`@iap/language-server`, Phase 4) for editor features and the IaP MCP server
(`@iap/mcp-server`, M13.2) for assistant authoring/analysis — so an IDE never has its own
semantics, and an assistant never gains a deployment path (spec ch. 19).

## The trust boundary (read first)

Assistant and IDE tools are **authoring and analysis only**. The IaP MCP server exposes no
deployment, mutation, or provider-API tool — an assistant using it structurally cannot deploy
or reach a provider (ch. 19 §19.2). Authoring runs through the intent-compiler gate: an LLM
never writes YAML into the source of truth; it proposes operations, which are validated and
committed by the gate, and every committed value carries provenance. Deployment stays with the
CLI/control plane behind explicit human approval (Phase 14/16).

## VS Code extension (M13.1)

The extension is a thin client that spawns the language server over stdio — it adds no
language semantics of its own:

- **Language features** — diagnostics, completion, hover, definition/references/rename, code
  actions, and the `iap/preview` / `iap/canonical` custom requests, all from
  `@iap/language-server` (Phase 4). Diagnostics are identical to `iap validate`.
- **Assistant panel** — connects to the IaP MCP server for `iap_author` (natural-language
  authoring with clarifications and a semantic preview) and the read-only analysis tools
  (`iap_validate`, `iap_cost`, `iap_security`, `iap_compliance`).
- **No credentials** — baseline editing requires no cloud credentials; the extension performs
  no network I/O beyond the language server it spawns.

Extension `package.json` (contributes) registers the `iap` language for `*.iap.yaml`, starts
`iap-language-server`, and surfaces the custom requests as commands ("IaP: Preview
Architecture", "IaP: Show Canonical Form"). Packaging a `.vsix` is a release step over this
client; the language-server core it drives is fully tested in `@iap/language-server`.

## Cursor / Claude Code / Windsurf (M13.3)

These assistants consume IaP through the **IaP MCP server**. Register it as an MCP server in
the assistant's config; it advertises the authoring/analysis tool set and a trust-boundary
declaration. The assistant then:

1. calls `iap_author` with the user's natural-language requirement → receives the outcome,
   any clarifications to ask the user, a semantic preview, and (on commit) the document with
   per-field provenance;
2. calls `iap_validate` / `iap_cost` / `iap_security` / `iap_compliance` to review a document;
3. presents the result and provenance to the user for review — and, to deploy, hands off to
   the CLI or control plane, which enforces the human-approval gate. The assistant itself
   cannot deploy: no such tool exists.

Because the tools are the same engines the CLI uses, an assistant's review matches
`iap validate`/`cost`/`security`/`compliance` exactly.

## JetBrains (M13.3, prototype)

JetBrains IDEs consume the same language server via the LSP4IJ / built-in LSP client: point an
LSP configuration at the `iap-language-server` binary for `*.iap.yaml`. Feature parity with VS
Code follows from sharing the server; JetBrains-specific UI (tool windows for preview) is a
prototype surface over the same `iap/preview` request.

## Invariants every integration preserves

- IDE/assistant actions use the same SDK, engines, and gate as the CLI (no second
  implementation).
- Assistant tools cannot call provider APIs or deploy (ch. 19; enforced by tool absence and
  the server's `assertReadOnly` guard).
- Every generated value and its provenance is inspectable (the authoring result carries the
  operation provenance).
- Users can generate and review IaP without writing YAML (`iap_author` + the analysis tools).
