# Changelog

All notable changes to the IaP VS Code extension are documented here.

## 0.1.0 — 2026-07-15

Initial release.

- Registers the `iap` language for `*.iap.yaml`, `*.iap.yml`, `*.iap-map.yaml`
  and `infrastructure.iap.yaml`, with YAML-style comment, bracket and
  auto-closing behaviour.
- Fully self-contained `.vsix`: bundles both the LSP client
  (`vscode-languageclient`) and the compiled IaP language server
  (`server/server.js`), so a clean install needs no monorepo dependencies, no
  global packages and no configuration.
- Language Server Protocol features: schema-derived diagnostics, completion,
  hover, navigation, rename and code actions.
- Commands: **IaP: Restart Language Server** (`iap.restartServer`) and
  **IaP: Show Architecture Preview** (`iap.showPreview`, custom `iap/preview`
  request).
- Settings: `iap.languageServer.path` (optional override for the bundled
  server) and `iap.trace.server` (LSP trace verbosity).
