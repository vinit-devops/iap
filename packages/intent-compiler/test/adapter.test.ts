/**
 * M3.4 model-provider abstraction: the vendor-neutral adapter interface and
 * the enforcement middleware — structured output with bounded retry/repair,
 * token/cost limits, redaction hooks, data residency — plus the two in-repo
 * adapters and the model-independence guarantee (OP-2).
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_ERROR_CODES,
  apply,
  compileFacets,
  createAdapterSession,
  emptyDocument,
  fixtureAdapter,
  requiredConfirmations,
  rulesAdapter,
} from '../src/index';
import type {
  AdapterContext,
  AuthoringRequest,
  ExtractionResult,
  ModelAdapter,
} from '../src/index';

const EMPTY: ExtractionResult = { facets: [], unparsed: [], unsupported: [] };
const INVALID = {
  facets: [{ bogus: true }],
  unparsed: [],
  unsupported: [],
} as unknown as ExtractionResult;

const request = (input = 'a web app', requestId = 'req-1'): AuthoringRequest => ({
  requestId,
  input,
});

function adapterOf(
  extract: (req: AuthoringRequest, ctx: AdapterContext) => Promise<ExtractionResult>,
  residency = 'local',
): ModelAdapter {
  return { id: 'test-adapter', version: '1', residency, extract };
}

describe('the middleware taxonomy is closed', () => {
  it('exactly six refusal codes exist', () => {
    expect(ADAPTER_ERROR_CODES).toEqual([
      'residency-refused',
      'structured-output-invalid',
      'attempts-exhausted',
      'token-limit-exceeded',
      'cost-limit-exceeded',
      'adapter-failure',
    ]);
  });
});

describe('redaction hooks', () => {
  it('a registered redactor provably runs before the adapter sees the request', async () => {
    let seen = '';
    const session = createAdapterSession(
      adapterOf((req) => {
        seen = req.input;
        return Promise.resolve(EMPTY);
      }),
      {
        redactors: [
          (req) => ({ ...req, input: req.input.replace(/hunter2/g, '[REDACTED]') }),
          (req) => ({ ...req, input: req.input.replace(/4111(-?\d{4}){3}/g, '[PAN]') }),
        ],
      },
    );
    const outcome = await session.extract(
      request('password hunter2 and card 4111-1111-1111-1111 web app'),
    );
    expect(outcome.ok).toBe(true);
    expect(seen).toBe('password [REDACTED] and card [PAN] web app');
    expect(seen).not.toContain('hunter2');
  });
});

describe('structured-output enforcement with bounded retry/repair', () => {
  it('an invalid first attempt is retried with the repair issues; the repaired output passes', async () => {
    const contexts: AdapterContext[] = [];
    const session = createAdapterSession(
      adapterOf((_req, ctx) => {
        contexts.push(ctx);
        return Promise.resolve(ctx.attempt === 1 ? INVALID : EMPTY);
      }),
      { maxAttempts: 2 },
    );
    const outcome = await session.extract(request());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    expect(contexts[0]).toMatchObject({ attempt: 1, maxAttempts: 2 });
    expect(contexts[1]?.attempt).toBe(2);
    expect(contexts[1]?.repair?.length).toBeGreaterThan(0);
  });

  it('exhaustion refuses — repair never auto-accepts invalid output', async () => {
    let calls = 0;
    const session = createAdapterSession(
      adapterOf(() => {
        calls += 1;
        return Promise.resolve(INVALID);
      }),
      { maxAttempts: 3 },
    );
    const outcome = await session.extract(request());
    expect(calls).toBe(3);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusals[0]?.code).toBe('attempts-exhausted');
      expect(outcome.refusals.slice(1).every((r) => r.code === 'structured-output-invalid')).toBe(
        true,
      );
    }
  });

  it('a direct proposal batch is validated via the operations companion schema', async () => {
    const withBadProposal: ExtractionResult = { ...EMPTY, proposal: { apiVersion: 'nope' } };
    const session = createAdapterSession(
      adapterOf(() => Promise.resolve(withBadProposal)),
      {
        maxAttempts: 1,
      },
    );
    const outcome = await session.extract(request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusals.some((r) => r.message.startsWith('proposal:'))).toBe(true);
    }
  });

  it('a throwing adapter surfaces as adapter-failure after exhaustion', async () => {
    const session = createAdapterSession(
      adapterOf(() => Promise.reject(new Error('connection refused'))),
      { maxAttempts: 2 },
    );
    const outcome = await session.extract(request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusals.map((r) => r.code)).toEqual([
        'attempts-exhausted',
        'adapter-failure',
      ]);
    }
  });

  it('maxAttempts below 1 is caller misuse', () => {
    expect(() =>
      createAdapterSession(
        adapterOf(() => Promise.resolve(EMPTY)),
        { maxAttempts: 0 },
      ),
    ).toThrow(TypeError);
  });
});

describe('token and cost limits (counts supplied by the adapter, enforced here)', () => {
  const usageAdapter = (usage: ExtractionResult['usage']) =>
    adapterOf(() => Promise.resolve({ ...EMPTY, ...(usage === undefined ? {} : { usage }) }));

  it('per-request token limits refuse when exceeded', async () => {
    const session = createAdapterSession(usageAdapter({ inputTokens: 900, outputTokens: 300 }), {
      limits: { maxInputTokensPerRequest: 500 },
    });
    const outcome = await session.extract(request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals[0]?.code).toBe('token-limit-exceeded');
    const total = createAdapterSession(usageAdapter({ inputTokens: 900, outputTokens: 300 }), {
      limits: { maxTotalTokensPerRequest: 1000 },
    });
    const totalOutcome = await total.extract(request());
    expect(totalOutcome.ok).toBe(false);
  });

  it('limits within bounds pass, and session usage accumulates in integers', async () => {
    const session = createAdapterSession(
      usageAdapter({ inputTokens: 100, outputTokens: 50, costMicrocents: 700 }),
      { limits: { maxInputTokensPerRequest: 500 } },
    );
    await session.extract(request());
    await session.extract(request());
    expect(session.usage()).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      costMicrocents: 1400,
      requests: 2,
    });
  });

  it('the cumulative session cost ceiling refuses once crossed', async () => {
    const session = createAdapterSession(
      usageAdapter({ inputTokens: 1, outputTokens: 1, costMicrocents: 600 }),
      { limits: { maxSessionCostMicrocents: 1000 } },
    );
    expect((await session.extract(request())).ok).toBe(true);
    const second = await session.extract(request());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusals[0]?.code).toBe('cost-limit-exceeded');
  });

  it('configured limits with missing usage counts fail closed', async () => {
    const session = createAdapterSession(usageAdapter(undefined), {
      limits: { maxInputTokensPerRequest: 500 },
    });
    const outcome = await session.extract(request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals[0]?.code).toBe('token-limit-exceeded');
  });
});

describe('data residency', () => {
  it('an adapter whose declared residency violates the session config is refused BEFORE invocation', async () => {
    let invoked = false;
    const session = createAdapterSession(
      adapterOf(() => {
        invoked = true;
        return Promise.resolve(EMPTY);
      }, 'us'),
      { residency: { allowed: ['local', 'eu'] } },
    );
    const outcome = await session.extract(request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals[0]?.code).toBe('residency-refused');
    expect(invoked).toBe(false);
  });

  it('a conforming residency declaration passes', async () => {
    const session = createAdapterSession(
      adapterOf(() => Promise.resolve(EMPTY), 'eu'),
      {
        residency: { allowed: ['local', 'eu'] },
      },
    );
    expect((await session.extract(request())).ok).toBe(true);
  });
});

describe('the in-repo adapters', () => {
  it('the rules adapter wraps the deterministic extractor behind the interface (local, no prompts)', async () => {
    const adapter = rulesAdapter();
    expect(adapter).toMatchObject({ id: 'iap-rules', version: '1', residency: 'local' });
    const session = createAdapterSession(adapter);
    const outcome = await session.extract(request('a postgresql database'));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.facets[0]).toMatchObject({
        facet: 'data-service',
        engine: 'postgresql',
      });
      expect(outcome.result.facets[0]?.sourceSpan.input).toBe('req-1');
    }
  });

  it('the fixture adapter replays recordings by request id and fails closed on unknown ids', async () => {
    const recording: ExtractionResult = {
      facets: [
        {
          facet: 'availability',
          availability: 'high',
          sourceSpan: { input: 'req-1', start: 0, end: 4, text: 'high' },
          confidence: 0.95,
          channel: 'exact-keyword',
        },
      ],
      unparsed: [],
      unsupported: [],
    };
    const session = createAdapterSession(fixtureAdapter({ 'req-1': recording }));
    const replayed = await session.extract(request('anything'));
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.result).toEqual(recording);

    const missing = await session.extract(request('anything', 'req-unknown'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.refusals.map((r) => r.code)).toContain('adapter-failure');
    }
  });

  it('model independence: fixture and rules adapters yielding the same confirmed batch produce byte-identical documents', async () => {
    const document = emptyDocument('shop');
    const input = 'An api running image example.com/api:1.0.0 with a postgresql database';

    const rules = createAdapterSession(rulesAdapter());
    const fromRules = await rules.extract({ requestId: 'req-9', input, document });
    expect(fromRules.ok).toBe(true);
    if (!fromRules.ok) return;

    const recorded = structuredClone(fromRules.result);
    const fixture = createAdapterSession(
      fixtureAdapter({ 'req-9': recorded }, { id: 'vendor-model', version: '9', residency: 'eu' }),
    );
    const fromFixture = await fixture.extract({ requestId: 'req-9', input, document });
    expect(fromFixture.ok).toBe(true);
    if (!fromFixture.ok) return;

    const batchA = compileFacets(fromRules.result.facets, document, {
      modelId: 'iap-rules@1',
    }).batch;
    const batchB = compileFacets(fromFixture.result.facets, document, {
      modelId: 'vendor-model@9',
    }).batch;
    const confirmations = requiredConfirmations(batchA as never).map((need) => ({
      operationId: need.operationId,
      actor: 'reviewer@example.com',
      channel: 'user-input' as const,
      timestamp: '2026-07-11T12:00:00Z',
    }));
    const committedA = await apply(document, batchA, { confirmations });
    const committedB = await apply(document, batchB, { confirmations });
    expect(committedA.ok && committedB.ok).toBe(true);
    if (committedA.ok && committedB.ok) {
      expect(committedA.result.serialize('yaml')).toBe(committedB.result.serialize('yaml'));
      expect(committedA.result.serialize('canonical-json')).toBe(
        committedB.result.serialize('canonical-json'),
      );
      expect(committedA.result.canonicalHash).toBe(committedB.result.canonicalHash);
    }
  });
});
