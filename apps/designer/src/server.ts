#!/usr/bin/env node
/**
 * `iap-designer` — the runnable local entry point for the IaP Visual Designer
 * shell (roadmap Phase 19, M19.4). A dependency-free `node:http` server (no
 * express, no frameworks) that binds to loopback only and serves the thin
 * canvas UI plus its JSON API. All IaP authoring happens server-side through
 * the `@iap/designer` gate; see `./index.ts` for the request handler.
 *
 * Port resolution: `--port <n>` flag, then `PORT` env, then the default 4173.
 * `--port 0` binds an ephemeral port (useful for tests). The listening URL is
 * logged to stderr. SIGINT/SIGTERM shut the server down gracefully.
 */
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequestHandler, DesignerApp } from './index.js';

const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1';

/** Resolve the port from `--port`, then `PORT`, then the default. */
export function resolvePort(argv: readonly string[] = process.argv.slice(2)): number {
  const flagIndex = argv.indexOf('--port');
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    const parsed = Number(argv[flagIndex + 1]);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  if (process.env.PORT !== undefined && process.env.PORT !== '') {
    const parsed = Number(process.env.PORT);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_PORT;
}

/**
 * Build an HTTP server over a fresh `DesignerApp`. Callers `listen()` it
 * themselves so the same factory serves both the CLI and the smoke test.
 */
export function createServer(app: DesignerApp = new DesignerApp()): Server {
  return createHttpServer(createRequestHandler(app));
}

/** Start the server, log the URL to stderr, and wire graceful shutdown. */
export function start(port: number = resolvePort()): Server {
  const server = createServer();
  server.listen(port, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    process.stderr.write(`IaP Visual Designer listening on http://${HOST}:${boundPort}\n`);
  });

  const shutdown = (signal: string): void => {
    process.stderr.write(`\n${signal} received — shutting down IaP Visual Designer\n`);
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// Run only when invoked directly (the bin), not when imported for testing.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  start();
}
