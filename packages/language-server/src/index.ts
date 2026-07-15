/**
 * @iap/language-server — the IaP infrastructure language server (spec ch. 23).
 *
 * Public surface:
 *
 * - the pure provider core (`computeDiagnostics`, `computeCompletions`,
 *   `computeHover`, `computeDefinition`, `computeReferences`,
 *   `computeRename`, `computeSymbols`, `computeCodeActions`,
 *   `computePreview`, `resolveSchemaAt`) — protocol-neutral functions any
 *   host can embed;
 * - `startServer` — the stdio LSP binding used by the `iap-language-server`
 *   bin entry.
 */
export * from './providers.js';
export { DIAGNOSTICS_DEBOUNCE_MS, startServer } from './server.js';
export type { CanonicalParams, PreviewParams } from './server.js';
