#!/usr/bin/env node
/**
 * `iap-mcp-server` — the runnable stdio entrypoint (roadmap Phase 19, M19.4).
 *
 * Constructs the read-only `IaPMcpServer` and serves it over MCP/stdio so an
 * assistant or IDE (Claude Code, Cursor, Windsurf) can connect. Register it with
 * a client as, e.g.:
 *
 *     { "command": "iap-mcp-server" }        // via the package `bin`
 *     { "command": "node", "args": ["packages/mcp-server/dist/bin.js"] }
 *
 * The process reads/writes JSON-RPC frames on stdio and emits nothing else on
 * stdout; a one-line readiness banner is written to stderr on startup.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IaPMcpServer } from './server.js';
import { runStdio } from './transport.js';

/** Construct the server and start the stdio loop. Exported for testing. */
export function main(): { stop: () => void } {
  const server = new IaPMcpServer();
  process.stderr.write('iap-mcp-server: listening on stdio (MCP JSON-RPC)\n');
  return runStdio(server);
}

/** True when this module is being executed directly as the process entrypoint. */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main();
  // Keep the event loop alive until stdin closes, then exit cleanly.
  process.stdin.on('end', () => process.exit(0));
}
