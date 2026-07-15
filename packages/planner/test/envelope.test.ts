import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeInputsHash,
  computePlanId,
  emptySnapshot,
  plan,
  refuseIfInvalid,
  signPlan,
  validatePlanArtifact,
  verifyPlan,
} from '../src/index';
import type { PlanArtifact, PlanContent, PlanRefusalCode, VerifyPlanOptions } from '../src/index';
import { rehash, stateFromPlan, webshopPlan } from './helpers';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trustStore = { 'planner-test-2026': publicKeyPem };

const KEY_ID = 'planner-test-2026';
const CREATED = '2026-07-11T00:00:00Z';
const EXPIRES = '2026-07-12T00:00:00Z';
const NOW = '2026-07-11T12:00:00Z';

function signed(artifact: PlanArtifact): PlanArtifact {
  return signPlan(artifact, {
    createdAt: CREATED,
    expiresAt: EXPIRES,
    privateKeyPem,
    keyId: KEY_ID,
  });
}

function currentOptions(overrides: Partial<VerifyPlanOptions> = {}): VerifyPlanOptions {
  return {
    desired: webshopPlan(),
    state: emptySnapshot(),
    now: NOW,
    trustStore,
    ...overrides,
  };
}

/**
 * Forge a well-formed artifact whose content was produced under different
 * identities (as an older/other planner would emit): mutate the content,
 * recompute inputsHash and planId so the artifact is internally consistent
 * — only verification against CURRENT inputs can catch it (PL-2).
 */
function reissue(artifact: PlanArtifact, mutate: (content: PlanContent) => void): PlanArtifact {
  const content = structuredClone(artifact.content);
  mutate(content);
  const identities = { ...content.inputs } as Partial<typeof content.inputs>;
  delete identities.inputsHash;
  content.inputs.inputsHash = computeInputsHash(identities as typeof content.inputs);
  return { apiVersion: artifact.apiVersion, planId: computePlanId(content), content };
}

function refusalCodes(artifact: PlanArtifact, options: VerifyPlanOptions): PlanRefusalCode[] {
  const result = verifyPlan(artifact, options);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe('signPlan (injected timestamps, ed25519 over {createdAt, expiresAt, planId})', () => {
  const artifact = plan(webshopPlan(), emptySnapshot());

  it('attaches a schema-valid envelope without touching planId or content', () => {
    const enveloped = signed(artifact);
    expect(enveloped.envelope).toEqual({
      createdAt: CREATED,
      expiresAt: EXPIRES,
      signature: {
        keyId: KEY_ID,
        alg: 'ed25519',
        value: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/) as unknown as string,
      },
    });
    expect(enveloped.planId).toBe(artifact.planId);
    expect(enveloped.content).toEqual(artifact.content);
    expect(validatePlanArtifact(enveloped).ok).toBe(true);
  });

  it('refuses to sign an artifact whose planId does not match its content', () => {
    const tampered = { ...artifact, planId: `sha256:${'0'.repeat(64)}` };
    expect(() => signed(tampered)).toThrow(/refusing to sign/);
  });

  it('refuses non-ed25519 keys and non-increasing timestamp ranges', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() =>
      signPlan(artifact, {
        createdAt: CREATED,
        expiresAt: EXPIRES,
        privateKeyPem: ecPem,
        keyId: KEY_ID,
      }),
    ).toThrow(/must be ed25519/);
    expect(() =>
      signPlan(artifact, { createdAt: EXPIRES, expiresAt: CREATED, privateKeyPem, keyId: KEY_ID }),
    ).toThrow(/strictly after/);
    expect(() =>
      signPlan(artifact, {
        createdAt: 'yesterday',
        expiresAt: EXPIRES,
        privateKeyPem,
        keyId: KEY_ID,
      }),
    ).toThrow(/RFC 3339/);
  });
});

describe('verifyPlan accepts an unchanged world', () => {
  it('verifies a signed plan against identical current inputs', () => {
    const enveloped = signed(plan(webshopPlan(), emptySnapshot()));
    expect(verifyPlan(enveloped, currentOptions())).toEqual({ ok: true });
    expect(() => refuseIfInvalid(enveloped, currentOptions())).not.toThrow();
  });

  it('verifies an unenveloped plan when no signature is required', () => {
    const artifact = plan(webshopPlan(), emptySnapshot());
    expect(verifyPlan(artifact, currentOptions())).toEqual({ ok: true });
  });

  it('refuses an unenveloped plan when a signature is required', () => {
    const artifact = plan(webshopPlan(), emptySnapshot());
    expect(refusalCodes(artifact, currentOptions({ requireSignature: true }))).toEqual([
      'unsigned',
    ]);
  });
});

describe('PL-2: every identity perturbed individually ⇒ refusal', () => {
  const artifact = plan(webshopPlan(), emptySnapshot());

  const perturbations: Array<[string, (content: PlanContent) => void]> = [
    ['documentHash', (c) => (c.inputs.documentHash = `sha256:${'0'.repeat(64)}`)],
    ['target', (c) => (c.inputs.target.provider = 'other')],
    ['target', (c) => (c.inputs.target.profile = null)],
    ['profileHashes', (c) => (c.inputs.profileHashes = { production: `sha256:${'1'.repeat(64)}` })],
    ['policyBundles', (c) => (c.inputs.policyBundles = { 'org-baseline': '1.4.0' })],
    ['extensionVersions', (c) => (c.inputs.extensionVersions = { mock: '1.0.0' })],
    ['mappingVersions', (c) => (c.inputs.mappingVersions = { mock: '9.9.9' })],
    ['discoverySnapshot', (c) => (c.inputs.discoverySnapshot = 'disc-2026-07-09-01')],
    ['pricingSnapshot', (c) => (c.inputs.pricingSnapshot = 'price-2026-07-01')],
    ['stateRevision', (c) => (c.inputs.stateRevision = 7)],
    ['stateIntegrity', (c) => (c.inputs.stateIntegrity = `sha256:${'2'.repeat(64)}`)],
    ['plannerVersion', (c) => (c.inputs.plannerVersion = '0.1.0')],
  ];

  it.each(perturbations)(
    'a plan recorded under a different %s refuses with identity-mismatch',
    (element, mutate) => {
      const stale = reissue(artifact, mutate);
      const result = verifyPlan(stale, currentOptions());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const mismatches = result.refusals.filter((r) => r.code === 'identity-mismatch');
      expect(mismatches.map((r) => r.identity)).toContain(element);
    },
  );

  it('refuses with state-advanced when the state revision moved past the plan', () => {
    const desired = webshopPlan();
    const advanced = stateFromPlan(desired); // revision 1, plan recorded revision 0
    const codes = refusalCodes(artifact, currentOptions({ desired, state: advanced }));
    expect(codes).toContain('state-advanced');
    expect(codes).toContain('identity-mismatch');
  });

  it('refuses when the current document differs (recomputed documentHash)', () => {
    const desired = webshopPlan({
      mutateDocument: (document) => {
        const resources = (document as unknown as { resources: Record<string, unknown> }).resources;
        (resources.jobs as { spec: Record<string, unknown> }).spec.messageRetention = '5d';
      },
    });
    const result = verifyPlan(artifact, currentOptions({ desired }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((r) => r.identity)).toContain('documentHash');
  });
});

describe('PL-2: tamper and expiry refusals', () => {
  const enveloped = signed(plan(webshopPlan(), emptySnapshot()));

  it('refuses tampered content whose planId no longer matches', () => {
    const tampered = structuredClone(enveloped);
    tampered.content.approvalsRequired.push({
      resource: 'web.mock:core:Compute',
      gate: 'stateful-delete',
    });
    expect(refusalCodes(tampered, currentOptions())).toContain('plan-id-mismatch');
  });

  it('refuses a recorded inputsHash that does not fold from the identities', () => {
    const content = structuredClone(enveloped.content);
    content.inputs.inputsHash = `sha256:${'3'.repeat(64)}`;
    const tampered: PlanArtifact = {
      apiVersion: enveloped.apiVersion,
      planId: computePlanId(content),
      content,
    };
    expect(refusalCodes(tampered, currentOptions())).toEqual(['inputs-hash-mismatch']);
  });

  it('refuses a tampered signature and an unknown keyId', () => {
    const badValue = structuredClone(enveloped);
    if (badValue.envelope) badValue.envelope.signature.value = 'AAAA';
    expect(refusalCodes(badValue, currentOptions())).toEqual(['signature-invalid']);

    const unknownKey = structuredClone(enveloped);
    if (unknownKey.envelope) unknownKey.envelope.signature.keyId = 'someone-else';
    expect(refusalCodes(unknownKey, currentOptions())).toEqual(['signature-invalid']);
  });

  it('refuses a tampered envelope: extending expiresAt breaks the signature binding', () => {
    const extended = structuredClone(enveloped);
    if (extended.envelope) extended.envelope.expiresAt = '2027-01-01T00:00:00Z';
    expect(refusalCodes(extended, currentOptions())).toEqual(['signature-invalid']);
  });

  it('refuses at and beyond expiry (now ≥ expiresAt), with re-planning as the remedy', () => {
    expect(refusalCodes(enveloped, currentOptions({ now: EXPIRES }))).toEqual(['expired']);
    expect(refusalCodes(enveloped, currentOptions({ now: '2026-08-01T00:00:00Z' }))).toEqual([
      'expired',
    ]);
    expect(verifyPlan(enveloped, currentOptions({ now: '2026-07-11T23:59:59Z' }))).toEqual({
      ok: true,
    });
    expect(() => refuseIfInvalid(enveloped, currentOptions({ now: EXPIRES }))).toThrow(
      /plan refused \(PL-2\).*expired/,
    );
  });

  it('refuses a schema-invalid artifact outright', () => {
    const invalid = structuredClone(enveloped) as unknown as Record<string, unknown>;
    delete (invalid.content as Record<string, unknown>).destructiveActions;
    expect(refusalCodes(invalid as unknown as PlanArtifact, currentOptions())).toEqual([
      'schema-invalid',
    ]);
  });

  it('throws TypeError on corrupt CURRENT inputs (caller error, not invalidation)', () => {
    const desired = webshopPlan();
    const corruptPlan = { ...desired, planHash: '0'.repeat(64) };
    expect(() => verifyPlan(enveloped, currentOptions({ desired: corruptPlan }))).toThrow(
      /planHash does not verify/,
    );
    const corruptState = { ...emptySnapshot(), integrity: `sha256:${'0'.repeat(64)}` };
    expect(() => verifyPlan(enveloped, currentOptions({ state: corruptState }))).toThrow(
      /integrity/,
    );
    expect(() => verifyPlan(enveloped, currentOptions({ now: 'not-a-timestamp' }))).toThrow(
      /RFC 3339/,
    );
  });

  it('collects every refusal at once (complete invalidation surface)', () => {
    const desired = webshopPlan({
      mutatePlan: (p) => {
        p.mappingVersion = '9.9.9';
      },
    });
    const expired = currentOptions({ desired: rehash(desired), now: '2026-08-01T00:00:00Z' });
    const codes = refusalCodes(enveloped, expired);
    expect(codes).toContain('identity-mismatch');
    expect(codes).toContain('expired');
  });
});
