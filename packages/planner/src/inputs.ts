/**
 * The determinism input vector (IEP-0011) and the minimal state-snapshot
 * input (IEP-0010 subset per phase-7 design decision 3).
 *
 * Every artifact that may influence a plan's bytes is identified here; the
 * canonical serialization of the nine identities folds into `inputsHash`.
 * Nothing else — no clock, network, environment, locale, or randomness —
 * participates in planning (CP-1, PL-5). All hashing reuses `@iap/model`'s
 * canonical-serialization helpers (one byte form in the whole toolchain).
 */

import { canonicalJsonStringify, sha256Hex } from '@iap/model';
import type { Scalar } from '@iap/provider-sdk';

/** Plan artifact format identifier (IEP-0011). */
export const PLAN_API_VERSION = 'plan.iap.dev/v1' as const;

/**
 * Identity 9 of the determinism input vector: the semver of this planning
 * implementation. The risk rule-table version is folded into it (phase-7
 * design decision 8), so a rule-table change requires a version bump here.
 * 0.2.0: risk rule table v1 replaced the M7.1 stub annotator as the default
 * (M7.3) — every planId and inputsHash intentionally changed.
 */
export const PLANNER_VERSION = '0.2.0' as const;

/** Digest spelling used throughout the plan artifact: sha256:<hex> (IEP-0011). */
export function sha256Digest(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

/** Identity 1b: the explicit deployment target the plan is computed for. */
export interface DeploymentTarget {
  /** Provider namespace (the mapping artifact's `provider` field). */
  provider: string;
  /** Active profile the canonical form is relative to; null = base document. */
  profile: string | null;
}

/**
 * The closed nine-element determinism input set of IEP-0011. Elements 1a/1b
 * (documentHash + target) and 8a/8b (stateRevision + stateIntegrity) are the
 * two-part identities of the IEP's items 1 and 8.
 */
export interface DeterminismInputs {
  /** Identity 1a: sha256:<hex> of the canonical IaP document (C1–C6). */
  documentHash: string;
  /** Identity 1b: explicit deployment target. */
  target: DeploymentTarget;
  /** Identity 2: profile name → sha256:<hex> of each merged profile definition. */
  profileHashes: Record<string, string>;
  /** Identity 3: policy bundle name → version/hash in force. */
  policyBundles: Record<string, string>;
  /** Identity 4: extension package namespace → version. */
  extensionVersions: Record<string, string>;
  /** Identity 5: provider mapping namespace → mapping artifact version. */
  mappingVersions: Record<string, string>;
  /** Identity 6: discovery snapshot id; null when no snapshot participates. */
  discoverySnapshot: string | null;
  /** Identity 7: pricing snapshot id; null ⇒ deltas.cost is explicitly unavailable. */
  pricingSnapshot: string | null;
  /** Identity 8a: state document revision (IEP-0010); 0 = empty snapshot. */
  stateRevision: number;
  /** Identity 8b: sha256:<hex> integrity hash of the snapshot's objects. */
  stateIntegrity: string;
  /** Identity 9: semver of the planning implementation. */
  plannerVersion: string;
}

/** `content.inputs` as emitted: the nine identities plus their fold. */
export interface PlanInputs extends DeterminismInputs {
  /** sha256:<hex> over the canonical serialization of the nine identities. */
  inputsHash: string;
}

/**
 * Fold the nine identities into `inputsHash`: SHA-256 over their canonical
 * serialization (compact UTF-8 JSON, keys sorted by Unicode code point —
 * the same byte rules as document canonical form, CP-2). The identity
 * object is rebuilt member by member so extraneous properties on the input
 * can never leak into the hash.
 */
export function computeInputsHash(inputs: DeterminismInputs): string {
  const identity: DeterminismInputs = {
    documentHash: inputs.documentHash,
    target: { provider: inputs.target.provider, profile: inputs.target.profile },
    profileHashes: { ...inputs.profileHashes },
    policyBundles: { ...inputs.policyBundles },
    extensionVersions: { ...inputs.extensionVersions },
    mappingVersions: { ...inputs.mappingVersions },
    discoverySnapshot: inputs.discoverySnapshot,
    pricingSnapshot: inputs.pricingSnapshot,
    stateRevision: inputs.stateRevision,
    stateIntegrity: inputs.stateIntegrity,
    plannerVersion: inputs.plannerVersion,
  };
  return sha256Digest(canonicalJsonStringify(identity));
}

/**
 * One object of the engine's state document, reduced to the minimal subset
 * the planner needs (phase-7 design decision 3): the provider resource type,
 * the abstract attribute values as last applied, and whether the object is
 * under management. Unmanaged objects are import material, never diff or
 * delete candidates (ch. 14 §14.2 via the mock executor's M6.2 semantics).
 */
export interface StateObject {
  /** Provider resource type (e.g. mock:core:Store). */
  type: string;
  /** Attribute values as last applied, keyed like `desiredAttributes`. */
  attributes: Record<string, Scalar>;
  /** True when a conformant engine manages the object. */
  managed: boolean;
  /**
   * Deployed-time dependency edges (logical ids this object depended on at
   * its last apply). Optional, additive to the design-decision-3 shape: the
   * state document records the deployed edge set (ch. 13 §13.3), and reverse
   * delete ordering — "a deleted resource is removed only after every
   * deleted resource that depends on it" (ch. 14 §14.3) — is computable only
   * from it, because deleted objects no longer appear in the desired plan.
   * When absent, deletes are treated as mutually independent.
   */
  dependsOn?: readonly string[];
}

/** The planner's view of the infrastructure model (IEP-0010 subset). */
export interface StateSnapshot {
  /** Monotonic revision of the state document; 0 = never deployed. */
  revision: number;
  /** sha256:<hex> over the canonical serialization of `objects`. */
  integrity: string;
  /** Logical id → object belief. */
  objects: Record<string, StateObject>;
}

/**
 * Integrity hash of a snapshot's object set: SHA-256 (sha256:<hex>) over the
 * canonical serialization of `objects`. `buildPlan` recomputes and verifies
 * it, refusing a snapshot whose declared integrity does not match (ch. 13
 * §13.1: externally introduced change is corruption, not input).
 */
export function computeStateIntegrity(objects: StateSnapshot['objects']): string {
  return sha256Digest(canonicalJsonStringify(objects));
}

/**
 * The empty snapshot (revision 0): nothing deployed, so every desired
 * resource classifies `create`. This is the golden-plan baseline (design
 * decision 3).
 */
export function emptySnapshot(): StateSnapshot {
  const objects: Record<string, StateObject> = {};
  return { revision: 0, integrity: computeStateIntegrity(objects), objects };
}
