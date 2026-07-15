#!/usr/bin/env node
/**
 * Standalone smoke test for the IaP Visual Designer shell (roadmap Phase 19,
 * M19.4). Root vitest excludes `apps/**`, so this runs as a plain node script:
 * it starts the built server on an ephemeral loopback port, drives a real
 * session over HTTP (add a Service, add a Database, connect them), asserts the
 * returned document is non-empty IaP YAML that `@iap/sdk` `load()` parses and
 * validates clean, checks `GET /` serves HTML, then shuts the server down.
 * Exits non-zero on any failure.
 *
 * Prereq: `pnpm --filter @iap/designer-app run build` (the `smoke:designer`
 * root script does this first).
 */
/* global fetch */
import { load, validateExtensions } from '@iap/sdk';
import { createServer } from './dist/server.js';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log(`smoke: server listening on ${base}`);

  const post = async (action) => {
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    });
    if (!res.ok) throw new Error(`POST /api/session -> ${res.status}`);
    return res.json();
  };

  try {
    // Drive a real session server-side through the DesignerSession gate.
    let state = await post({ op: 'addResource', kind: 'Service', name: 'web' });
    check(
      'adding a Service commits through the gate',
      state.ok === true,
      JSON.stringify(state.rejected),
    );

    state = await post({ op: 'addResource', kind: 'Database', name: 'db' });
    check(
      'adding a Database commits through the gate',
      state.ok === true,
      JSON.stringify(state.rejected),
    );

    state = await post({ op: 'connect', from: 'web', to: 'db', access: 'read-write' });
    check(
      'connecting web -> db commits through the gate',
      state.ok === true,
      JSON.stringify(state.rejected),
    );

    // The document is a non-empty IaP YAML.
    check(
      'response document is a non-empty string',
      typeof state.document === 'string' && state.document.trim().length > 0,
    );
    check('document declares the IaP apiVersion', state.document.includes('iap.dev/v1'));
    check(
      'document contains both resources',
      state.document.includes('web') && state.document.includes('db'),
    );
    check(
      'server reports the document valid',
      state.valid === true,
      JSON.stringify(state.findings),
    );

    // Independently re-validate the produced document through the SDK facade.
    const ws = await load(state.document);
    check('@iap/sdk load() parses the document', ws.document !== undefined && ws.ok === true);
    const findings = [
      ...ws.findings,
      ...ws.validate().findings,
      ...ws.policies().findings,
      ...validateExtensions(ws.document),
    ];
    const errors = findings.filter((f) => f.severity === 'error');
    check('SDK validation yields no error findings', errors.length === 0, JSON.stringify(errors));

    // GET /api/export returns the same document.
    const exportRes = await fetch(`${base}/api/export`);
    const exported = await exportRes.json();
    check('GET /api/export returns the document', exported.document === state.document);

    // GET / serves the self-contained HTML page.
    const pageRes = await fetch(`${base}/`);
    const contentType = pageRes.headers.get('content-type') || '';
    const html = await pageRes.text();
    check('GET / responds 200', pageRes.status === 200);
    check('GET / serves HTML', contentType.includes('text/html'));
    check(
      'HTML page has the designer shell markup',
      html.includes('<!doctype html>') && html.includes('IaP Visual Designer'),
    );

    // A rejected edit leaves the document unchanged (gate refusal surfaces).
    const before = (await (await fetch(`${base}/api/export`)).json()).document;
    const rejected = await post({ op: 'addResource', kind: 'NotAKind', name: 'x' });
    const after = (await (await fetch(`${base}/api/export`)).json()).document;
    check(
      'an invalid edit is refused by the gate',
      rejected.ok === false && Array.isArray(rejected.rejected),
    );
    check('a refused edit leaves the document unchanged', before === after);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    console.log('smoke: server closed');
  }

  if (failures > 0) {
    console.error(`\nSMOKE FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nSMOKE PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE ERROR:', err);
  process.exit(1);
});
