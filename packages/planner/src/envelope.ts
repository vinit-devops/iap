/**
 * Plan envelope creation, signing, and fail-closed verification (IEP-0011
 * invalidation and expiry; PL-2; phase-7 design decision 7).
 *
 * The envelope carries timestamps and the detached ed25519 signature AROUND
 * the hashed plan content — it is never part of planId (§14.5). Both
 * timestamps are INJECTED RFC 3339 strings supplied by the caller; nothing
 * in this module reads a clock (the policy engine's injected `now` is the
 * precedent). Signing reuses the ed25519 + canonical-serialization
 * semantics proven by `@iap/provider-sdk`'s manifest signing (node:crypto,
 * PKCS#8 PEM keys, base64 signatures, canonical compact key-sorted UTF-8
 * JSON as the signing form) — the signing form here is the canonical
 * serialization of `{ createdAt, expiresAt, planId }`. Because planId is
 * the SHA-256 of the canonical content serialization, the signature binds
 * the envelope timestamps to the exact content bytes: verifying the
 * signature plus recomputing planId over content is equivalent to signing
 * the content itself, while also making expiry tamper-evident.
 *
 * `verifyPlan` is the engine-side PL-2 rule: recompute the identities of
 * all nine determinism inputs from the current artifacts and refuse the
 * plan on any mismatch, a recomputed inputsHash or planId mismatch, an
 * advanced state revision, expiry, or a missing/failed signature. Refusals
 * use a closed, machine-readable taxonomy; re-planning is always the
 * remedy — there is no plan patching.
 */

import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalJsonStringify, sha256Hex } from '@iap/model';
import type { ProviderPlan } from '@iap/provider-sdk';
import type { TrustStore } from '@iap/provider-sdk';
import { computeInputsHash, computeStateIntegrity } from './inputs.js';
import type { DeterminismInputs, StateSnapshot } from './inputs.js';
import { IDENTITY_ELEMENTS } from './lifecycle.js';
import type { IdentityElement } from './lifecycle.js';
import { computePlanId, deriveDeterminismInputs } from './plan.js';
import type { InputIdentities, PlanArtifact, PlanEnvelope } from './plan.js';
import { validatePlanArtifact } from './validate.js';

/** RFC 3339 timestamp grammar accepted in envelopes (mirrors the schema). */
export const RFC3339_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/;

function epochMillis(timestamp: string, label: string): number {
  if (!RFC3339_PATTERN.test(timestamp)) {
    throw new TypeError(`${label} must be an RFC 3339 timestamp, got ${JSON.stringify(timestamp)}`);
  }
  return Date.parse(timestamp);
}

/**
 * The canonical signing form: compact key-sorted UTF-8 JSON of the envelope
 * timestamps and the planId they vouch for. Both signing and verification
 * derive their bytes from this single function (the manifest-signing
 * pattern of `@iap/provider-sdk`).
 */
export function planSigningBytes(planId: string, createdAt: string, expiresAt: string): Buffer {
  return Buffer.from(canonicalJsonStringify({ createdAt, expiresAt, planId }), 'utf8');
}

export interface SignPlanOptions {
  /** Injected RFC 3339 creation time — supplied by the caller, never a clock. */
  createdAt: string;
  /**
   * Injected RFC 3339 expiry: the earliest validity horizon of the pinned
   * discovery/pricing snapshots, capped by configuration (IEP-0011). Must
   * be strictly after createdAt. Engines refuse the plan at or beyond it.
   */
  expiresAt: string;
  /** ed25519 private key, PEM (PKCS#8) — the provider-sdk key format. */
  privateKeyPem: string;
  /** Identifier verifiers resolve against their trust store. */
  keyId: string;
}

/**
 * Create the signed envelope for an artifact and return the enveloped
 * artifact. Fail-closed: refuses to sign an artifact whose planId does not
 * match its content (signing would launder the tamper), a non-ed25519 key,
 * or a timestamp pair that is not a strictly increasing RFC 3339 range.
 * The returned artifact's planId and content are byte-identical to the
 * input's — the envelope is never hashed.
 */
export function signPlan(artifact: PlanArtifact, options: SignPlanOptions): PlanArtifact {
  const recomputed = computePlanId(artifact.content);
  if (recomputed !== artifact.planId) {
    throw new TypeError(
      `refusing to sign: planId ${artifact.planId} does not match the canonical content serialization (${recomputed})`,
    );
  }
  const createdAt = epochMillis(options.createdAt, 'createdAt');
  const expiresAt = epochMillis(options.expiresAt, 'expiresAt');
  if (!(expiresAt > createdAt)) {
    throw new TypeError(
      `expiresAt (${options.expiresAt}) must be strictly after createdAt (${options.createdAt})`,
    );
  }
  const key = createPrivateKey(options.privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`signing key must be ed25519, got ${String(key.asymmetricKeyType)}`);
  }
  const envelope: PlanEnvelope = {
    createdAt: options.createdAt,
    expiresAt: options.expiresAt,
    signature: {
      keyId: options.keyId,
      alg: 'ed25519',
      value: sign(
        null,
        planSigningBytes(artifact.planId, options.createdAt, options.expiresAt),
        key,
      ).toString('base64'),
    },
  };
  return { ...artifact, envelope };
}

/** Closed refusal taxonomy (PL-2): machine-readable, exhaustively enumerable. */
export const PLAN_REFUSAL_CODES = [
  'schema-invalid',
  'plan-id-mismatch',
  'inputs-hash-mismatch',
  'identity-mismatch',
  'state-advanced',
  'expired',
  'unsigned',
  'signature-invalid',
] as const;
export type PlanRefusalCode = (typeof PLAN_REFUSAL_CODES)[number];

export interface PlanRefusal {
  code: PlanRefusalCode;
  message: string;
  /** The mismatched identity element, for identity-mismatch refusals. */
  identity?: IdentityElement;
}

export type VerifyPlanResult = { ok: true } | { ok: false; refusals: PlanRefusal[] };

export interface VerifyPlanOptions {
  /** The CURRENT provider plan (re-mapped from the current document). */
  desired: ProviderPlan;
  /** The CURRENT state snapshot. */
  state: StateSnapshot;
  /** The CURRENT caller-supplied identities (profiles, policies, snapshots). */
  identities?: InputIdentities;
  /** Injected RFC 3339 evaluation time for the expiry check — never a clock. */
  now: string;
  /**
   * keyId → PEM public key trust material (the provider-sdk TrustStore
   * shape). Required whenever a signature is to be verified.
   */
  trustStore?: TrustStore;
  /**
   * Require a signed envelope: an artifact without one refuses `unsigned`.
   * When false (default), an unenveloped artifact skips signature and
   * expiry checks; a PRESENT envelope is always fully verified.
   */
  requireSignature?: boolean;
}

function refusal(code: PlanRefusalCode, message: string, identity?: IdentityElement): PlanRefusal {
  return identity === undefined ? { code, message } : { code, message, identity };
}

function identityValue(inputs: DeterminismInputs, element: IdentityElement): unknown {
  return inputs[element];
}

function verifyEnvelope(
  envelope: PlanEnvelope,
  planId: string,
  nowMillis: number,
  trustStore: TrustStore | undefined,
  refusals: PlanRefusal[],
): void {
  if (nowMillis >= epochMillis(envelope.expiresAt, 'envelope.expiresAt')) {
    refusals.push(
      refusal('expired', `plan expired at ${envelope.expiresAt}; re-plan against current inputs`),
    );
  }
  const signature = envelope.signature;
  if (signature.alg !== 'ed25519') {
    refusals.push(
      refusal('signature-invalid', `unsupported signature algorithm "${String(signature.alg)}"`),
    );
    return;
  }
  const publicKeyPem = trustStore?.[signature.keyId];
  if (publicKeyPem === undefined) {
    refusals.push(
      refusal('signature-invalid', `keyId "${signature.keyId}" is not in the trust store`),
    );
    return;
  }
  try {
    const valid = verify(
      null,
      planSigningBytes(planId, envelope.createdAt, envelope.expiresAt),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.value, 'base64'),
    );
    if (!valid) {
      refusals.push(
        refusal('signature-invalid', 'signature does not verify over the canonical signing form'),
      );
    }
  } catch (error) {
    refusals.push(
      refusal(
        'signature-invalid',
        `signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/**
 * The PL-2 invalidation rule. Given a plan artifact and the CURRENT
 * artifacts and identities, recompute everything the plan's identity vector
 * claims and refuse on: schema invalidity, planId not matching canonical
 * content, inputsHash not matching the recorded identities, any of the nine
 * identities differing from its current recomputation, an advanced state
 * revision, expiry (now at or beyond expiresAt), and a missing or failed
 * signature where one is required. All refusals are collected (never just
 * the first), so operators see the complete invalidation surface at once.
 *
 * The current `desired`/`state` artifacts are themselves verified
 * (planHash, integrity) exactly as `buildPlan` verifies its inputs — a
 * corrupt current artifact throws TypeError rather than producing a
 * refusal, because it is caller error, not plan invalidation.
 */
export function verifyPlan(artifact: PlanArtifact, options: VerifyPlanOptions): VerifyPlanResult {
  const nowMillis = epochMillis(options.now, 'now');
  const validation = validatePlanArtifact(artifact);
  if (!validation.ok) {
    return {
      ok: false,
      refusals: [
        refusal(
          'schema-invalid',
          `plan artifact fails plan-v1.schema.json: ${validation.errors.join('; ')} — a plan failing its own schema is unexecutable (IEP-0011)`,
        ),
      ],
    };
  }

  const refusals: PlanRefusal[] = [];
  const content = artifact.content;

  const recomputedPlanId = computePlanId(content);
  if (recomputedPlanId !== artifact.planId) {
    refusals.push(
      refusal(
        'plan-id-mismatch',
        `planId ${artifact.planId} does not match the canonical content serialization (${recomputedPlanId}) — content was modified after hashing`,
      ),
    );
  }

  const { inputsHash, ...recorded } = content.inputs;
  if (computeInputsHash(recorded) !== inputsHash) {
    refusals.push(
      refusal(
        'inputs-hash-mismatch',
        'recorded inputsHash does not match the canonical serialization of the recorded identities',
      ),
    );
  }

  // Recompute all nine identities from the current artifacts (PL-2). The
  // derivation verifies nothing about the artifacts themselves, so check
  // their self-consistency first, the same way buildPlan does.
  const unhashed: Record<string, unknown> = { ...options.desired };
  delete unhashed.planHash;
  if (sha256Hex(canonicalJsonStringify(unhashed)) !== options.desired.planHash) {
    throw new TypeError(
      'planner input refused: current provider plan planHash does not verify against its content',
    );
  }
  if (computeStateIntegrity(options.state.objects) !== options.state.integrity) {
    throw new TypeError(
      'planner input refused: current state snapshot integrity hash does not verify against its objects (ch. 13 §13.1: treated as corruption)',
    );
  }
  const current = deriveDeterminismInputs(options.desired, options.state, options.identities);

  for (const element of IDENTITY_ELEMENTS) {
    const recordedValue = canonicalJsonStringify(identityValue(recorded, element));
    const currentValue = canonicalJsonStringify(identityValue(current, element));
    if (recordedValue !== currentValue) {
      refusals.push(
        refusal(
          'identity-mismatch',
          `identity "${element}" changed since planning: plan recorded ${recordedValue}, current inputs yield ${currentValue}`,
          element,
        ),
      );
    }
  }
  if (options.state.revision > recorded.stateRevision) {
    refusals.push(
      refusal(
        'state-advanced',
        `state revision advanced from ${recorded.stateRevision} to ${options.state.revision}; the plan no longer describes the transition from current state`,
      ),
    );
  }

  if (artifact.envelope === undefined) {
    if (options.requireSignature === true) {
      refusals.push(
        refusal('unsigned', 'plan artifact carries no envelope, but a signature is required'),
      );
    }
  } else {
    verifyEnvelope(artifact.envelope, recomputedPlanId, nowMillis, options.trustStore, refusals);
  }

  return refusals.length === 0 ? { ok: true } : { ok: false, refusals };
}

/**
 * Throwing form of `verifyPlan`: execution paths call this and simply
 * cannot proceed past changed inputs (Phase 7 exit criterion 5 — enforced
 * by construction for any future engine).
 */
export function refuseIfInvalid(artifact: PlanArtifact, options: VerifyPlanOptions): void {
  const result = verifyPlan(artifact, options);
  if (!result.ok) {
    const summary = result.refusals.map((entry) => `[${entry.code}] ${entry.message}`).join('; ');
    throw new Error(`plan refused (PL-2): ${summary}`);
  }
}
