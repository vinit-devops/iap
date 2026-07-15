#!/usr/bin/env node
/* global fetch */
/**
 * Standalone smoke test for the IaP Planning Playground (roadmap-v2 Phase 19,
 * M19.5). Root vitest excludes `apps/**`, so this runs as a plain node script:
 * it starts the built server on an ephemeral loopback port and asserts the full
 * plan-preview pipeline plus the mandatory guardrails.
 *
 * Checks:
 *  - POST /api/plan {request} returns a document that `@iap/sdk` load() parses,
 *    non-empty architecture, cost (with its disclaimer), security, compliance
 *    (with its disclaimer), and a plan.planId of form `sha256:...`.
 *  - the planId is IDENTICAL across two calls (determinism).
 *  - GET / serves the self-contained HTML page.
 *  - a POST carrying a `credentials` or `awsAccessKeyId` field is REJECTED (400)
 *    and the pipeline never runs.
 *
 * Exits non-zero on any failure.
 *
 * Prereq: `pnpm --filter @iap/playground run build` (the `smoke:playground`
 * root script does this first).
 */
import { load } from '@iap/sdk';
import { createServer } from './dist/index.js';

const REQUEST = 'an internal web service connected to a managed postgres database';

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

  const postPlan = async (body) =>
    fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    // 1. Drive the full plan-preview pipeline from a natural-language request.
    const res = await postPlan({ request: REQUEST });
    check('POST /api/plan responds 200', res.status === 200, `status ${res.status}`);
    const state = await res.json();

    check(
      'the request committed to a document',
      state.authoring && state.authoring.outcome === 'committed',
      JSON.stringify(state.authoring),
    );
    check(
      'response document is a non-empty string',
      typeof state.document === 'string' && state.document.trim().length > 0,
    );
    check(
      'server reports the document valid',
      state.valid === true,
      JSON.stringify(state.findings),
    );

    // The document parses and validates clean through the SDK facade.
    const ws = await load(state.document);
    check('@iap/sdk load() parses the document', ws.document !== undefined && ws.ok === true);
    const errors = [...ws.findings, ...ws.validate().findings].filter(
      (f) => f.severity === 'error',
    );
    check('SDK validation yields no error findings', errors.length === 0, JSON.stringify(errors));

    // Every analysis panel is populated.
    check(
      'architecture Mermaid is non-empty',
      typeof state.architecture.mermaid === 'string' && state.architecture.mermaid.length > 0,
    );
    check(
      'dependencies are present',
      Array.isArray(state.dependencies.arcs) && Array.isArray(state.dependencies.waves),
    );
    check('cost report is present', state.cost !== null && typeof state.cost.currency === 'string');
    check(
      'cost carries the illustrative-pricing disclaimer',
      typeof state.disclaimers.cost === 'string' && /not a quote/i.test(state.disclaimers.cost),
      state.disclaimers.cost,
    );
    check('security report is present', state.security !== null && 'risk' in state.security);
    check(
      'compliance report is present',
      state.compliance !== null && typeof state.compliance.disclaimer === 'string',
    );
    check(
      'compliance carries the not-a-certification disclaimer',
      typeof state.disclaimers.compliance === 'string' &&
        /not a certification/i.test(state.disclaimers.compliance),
      state.disclaimers.compliance,
    );

    // The AWS plan preview yields a sha256 planId.
    check(
      'plan.planId is a sha256 digest',
      typeof state.plan.planId === 'string' && /^sha256:[0-9a-f]{64}$/.test(state.plan.planId),
      state.plan.planId,
    );
    check(
      'plan has scheduled actions',
      Array.isArray(state.plan.actions) && state.plan.actions.length > 0,
    );

    // 2. Determinism: a second identical call reproduces the same planId.
    const second = await (await postPlan({ request: REQUEST })).json();
    check(
      'planId is identical across two calls (deterministic)',
      second.plan.planId === state.plan.planId,
      `${state.plan.planId} vs ${second.plan.planId}`,
    );
    check(
      'document is identical across two calls (deterministic)',
      second.document === state.document,
    );

    // 3. GET / serves the self-contained HTML page.
    const pageRes = await fetch(`${base}/`);
    const html = await pageRes.text();
    check('GET / responds 200', pageRes.status === 200);
    check('GET / serves HTML', (pageRes.headers.get('content-type') || '').includes('text/html'));
    check(
      'HTML page has the playground shell markup',
      html.includes('<!doctype html>') && html.includes('IaP Planning Playground'),
    );

    // 4. Guardrail: a body carrying a credential field is rejected (400) and
    //    the pipeline never runs.
    const credRes = await postPlan({
      request: REQUEST,
      credentials: { awsAccessKeyId: 'AKIAEXAMPLE', awsSecretAccessKey: 'x' },
    });
    check(
      'a request with credentials is rejected 400',
      credRes.status === 400,
      `status ${credRes.status}`,
    );
    const credBody = await credRes.json();
    check(
      'the rejection names the offending credential keys',
      Array.isArray(credBody.rejectedKeys) && credBody.rejectedKeys.length > 0,
      JSON.stringify(credBody),
    );

    const credRes2 = await postPlan({ request: REQUEST, awsAccessKeyId: 'AKIAEXAMPLE' });
    check(
      'a bare awsAccessKeyId field is rejected 400',
      credRes2.status === 400,
      `status ${credRes2.status}`,
    );
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
