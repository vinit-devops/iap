#!/usr/bin/env node
/**
 * `iap-playground` — the runnable local entry point for the IaP Planning
 * Playground (roadmap-v2 Phase 19, M19.5). A dependency-free `node:http` server
 * (no express, no frameworks) that binds to loopback only and serves the
 * plan-preview UI plus its JSON API. All planning happens server-side through
 * the reused `@iap/*` engines; the request handler lives in `./index.ts`.
 *
 * Plan-only and safe by construction: no AWS SDK is imported, there is no
 * apply/deploy route, request bodies are never written to disk, and any
 * credential/profile/secret-looking request field is rejected (roadmap-v2 §11).
 *
 * Port resolution: `--port <n>` flag, then `PORT` env, then the default 5173.
 * `--port 0` binds an ephemeral port (useful for tests). The listening URL is
 * logged to stderr. SIGINT/SIGTERM shut the server down gracefully.
 */
import type { Server } from 'node:http';
import { DEFAULT_PORT, HOST, createServer } from './index.js';

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

/** Start the server, log the URL to stderr, and wire graceful shutdown. */
export function start(port: number = resolvePort()): Server {
  const server = createServer();
  server.listen(port, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    process.stderr.write(`IaP Planning Playground listening on http://${HOST}:${boundPort}\n`);
    process.stderr.write('  plan-only · no credentials · no deploy · nothing written to disk\n');
  });

  const shutdown = (signal: string): void => {
    process.stderr.write(`\n${signal} received — shutting down IaP Planning Playground\n`);
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
