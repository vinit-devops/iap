# IaP for VS Code

Editor support for **Infrastructure as Prompt (IaP)** documents.

The extension is **fully self-contained**: the `.vsix` bundles both the LSP
client and the compiled IaP language server, so a clean install gives the full
experience — diagnostics, completion, hover, navigation, rename, code actions
and the architecture preview — with **no** monorepo dependencies, **no** global
packages, and **no** `iap.languageServer.path` setting required.

## Features

- Registers the `iap` language for `*.iap.yaml`, `*.iap.yml`, `*.iap-map.yaml`
  and `infrastructure.iap.yaml`, with YAML-style comment, bracket and
  auto-closing behaviour.
- Starts the **bundled** IaP language server as a Language Server Protocol
  client, providing schema-derived diagnostics, completion, hover, navigation,
  rename, code actions and the `iap/preview` architecture preview (spec ch. 23).

## Commands

- **IaP: Restart Language Server** (`iap.restartServer`)
- **IaP: Show Architecture Preview** (`iap.showPreview`) — sends the custom
  `iap/preview` request for the active document and shows the result.

## Settings

- `iap.languageServer.path` — optional absolute path to an alternative
  `iap-language-server` executable. Leave empty to use the bundled server (the
  default). This is an escape hatch for development; it is **not** required.
- `iap.trace.server` — LSP trace verbosity (`off` / `messages` / `verbose`).

## How the server is resolved

`extension.js` resolves the language server in this order:

1. **Bundled server** — `server/server.js`, shipped inside the `.vsix` and
   launched as `node server.js --stdio`. Used first whenever present, so a
   clean install needs no configuration.
2. `iap.languageServer.path` — an explicit override, if set.
3. The `@iap/language-server` package `bin`, if resolvable.
4. A globally installed `iap-language-server` on `PATH`.

If `vscode-languageclient` is somehow unavailable the extension **degrades
gracefully**: the language stays registered (grammar/editing) and LSP features
are skipped with a one-time notice. In the packaged `.vsix` the client is
bundled, so this fallback does not trigger.

## Requirements

- A VS Code host (`engines.vscode: ^1.85.0`), which supplies the `vscode`
  runtime module.
- Node.js on the host (VS Code ships its own; the bundled server is launched
  with it).

## Build & package

Everything is produced **without `vsce`** and **offline** (no registry access
during packaging):

```sh
node build-server.mjs      # esbuild-bundle the language server → server/server.js (+ schemas)
node build-extension.mjs   # esbuild-bundle the extension + vscode-languageclient → extension.bundled.js
node build-vsix.mjs        # run both of the above, then assemble dist/iap-vscode-0.1.0.vsix
node smoke.mjs             # offline release gate (see below)
```

`build-vsix.mjs` assembles the OPC (Open Packaging Conventions) structure — an
`extension/` payload plus `[Content_Types].xml` and `extension.vsixmanifest` at
the archive root — and zips it with the system `zip` CLI. The payload is
**production-only**: the bundled extension, the bundled `server/` tree, the
language configuration, the manifest, this README, the CHANGELOG, the icon and
the license (`LICENSE.txt`, copied from the repo root). The unbundled
`extension.js`, `src`, tests, `node_modules` and the build scripts are excluded.

An equivalent `vsce` packaging path exists for the marketplace publish flow
(`.vscodeignore` keeps its payload aligned with the hand-built one):

```sh
npm run package:vsce        # npx @vscode/vsce package --no-dependencies
npm run publish:marketplace # npx @vscode/vsce publish --no-dependencies (needs VSCE_PAT)
npm run publish:openvsx     # npx ovsx publish (needs OVSX_PAT)
```

The hand-built `build-vsix.mjs` path remains canonical; the publish scripts are
prepared but require registry credentials and are never run by CI.

## Install

```sh
code --install-extension dist/iap-vscode-0.1.0.vsix
```

## Automated verification (`smoke.mjs`, offline)

`pnpm run smoke:vsix` (from the repo root) builds the `.vsix` and then proves,
with no network and — for the LSP checks — no VS Code:

1. **Package shape** — the zip contains the bundled extension, the bundled
   `server/server.js` + schemas, the manifest and `[Content_Types].xml`, and
   `node_modules`/`src`/tests are absent.
2. **Server speaks LSP** — spawns the extracted `server/server.js --stdio`,
   asserts an `initialize` reply with `capabilities`, then opens an **invalid**
   IaP document and asserts a `publishDiagnostics` with ≥1 diagnostic (the
   diagnostics round-trip, proven end-to-end without VS Code).
3. **Client is bundled** — loads `extension.bundled.js` with a minimal `vscode`
   stub and asserts `vscode-languageclient` resolves from the bundle (no
   `MODULE_NOT_FOUND`).
4. **Clean-profile install** — `code --install-extension` into a throwaway
   `--user-data-dir` / `--extensions-dir`, then uninstall and reinstall.

## Manual test checklist (interactive UI — cannot be automated headlessly)

The diagnostics round-trip is automated (step 2 above). The following
interactive surfaces should be spot-checked by hand after installing the
`.vsix` into VS Code:

1. **Activation** — open a `*.iap.yaml` (or `*.iap-map.yaml`) file; the status
   bar language mode shows **IaP** and the language server starts (no error
   toast).
2. **Diagnostics (in-editor)** — introduce an invalid `apiVersion` (e.g.
   `iap.dev/v99`) or an unknown `kind`; a red squiggle with an `IAP###` code
   appears in the editor and the Problems panel.
3. **Completion** — inside a resource, invoke completion (Ctrl/Cmd+Space); the
   dropdown offers IaP kinds / properties.
4. **Hover** — hover a `kind` or property; a hover popup shows its
   documentation.
5. **Commands** — run **IaP: Show Architecture Preview** on an open document (a
   preview panel opens) and **IaP: Restart Language Server** (an info toast
   confirms the restart).
6. **No configuration needed** — verify all of the above work in a fresh
   profile **without** setting `iap.languageServer.path`.
