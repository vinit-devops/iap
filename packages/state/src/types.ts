/**
 * State model types (spec ch. 13, IEP-0010). One state instance exists per
 * (document name, active profile); it holds the engine's belief about deployed
 * objects with a monotonic revision and an integrity hash, plus an append-only
 * history record expanded to the roadmap §4.4 field set. Secrets are never
 * stored — state holds references only (§13.2).
 */
/** A state attribute value (matches `@iap/provider-sdk`'s Scalar). */
export type Scalar = string | number | boolean;

/** Identity of one state instance (ch. 13 §13.1). */
export interface StateRef {
  document: string;
  profile: string | null;
}

/** One deployed object belief. */
export interface StateObject {
  type: string;
  attributes: Record<string, Scalar>;
  managed: boolean;
  /** Deployed-time dependency edges, for reverse delete ordering (ch. 14 §14.3). */
  dependsOn?: readonly string[];
}

/** A state document: the object beliefs at a revision, integrity-hashed. */
export interface StateDocument {
  ref: StateRef;
  /** Monotonic revision; 0 = never deployed. */
  revision: number;
  /** sha256:<hex> over the canonical serialization of `objects`. */
  integrity: string;
  objects: Record<string, StateObject>;
}

/** An immutable execution-history record (roadmap §4.4 superset of ch. 13 §13.4). */
export interface HistoryRecord {
  revision: number;
  planId: string;
  /** RFC 3339 instant, injected — never read from a clock inside the backend. */
  timestamp: string;
  actor: string;
  outcome: 'succeeded' | 'partial' | 'rolled-back';
  /** Approval evidence tying the deployment to an identity (roadmap §4.4). */
  approvals: string[];
  /** Logical ids applied/failed/cancelled this deployment. */
  applied: string[];
  failed: string[];
  /** Findings carried into the record (cost/security/compliance deltas), attribute-only. */
  findings: string[];
  /** Rollback/verification outcomes, when performed. */
  rollback?: 'none' | 'performed' | 'unsupported';
  verification?: 'converged' | 'diverged' | 'skipped';
}

/** A lease lock over one state instance. */
export interface LockToken {
  ref: StateRef;
  /** Opaque token id. */
  token: string;
  holder: string;
  operation: LockOperation;
  /** RFC 3339 expiry; the lease is invalid at or after this instant. */
  expiresAt: string;
  planId?: string;
}

export type LockOperation = 'plan' | 'apply' | 'import' | 'reconcile';

export interface LockRequest {
  holder: string;
  operation: LockOperation;
  ttlSeconds: number;
  planId?: string;
}

export interface ForceUnlockRequest {
  actor: string;
  reason: string;
}

/** Thrown when a lock is already held by a live lease (fail-closed, §5.5). */
export class LockHeldError extends Error {
  constructor(
    public readonly ref: StateRef,
    public readonly holder: string,
    public readonly expiresAt: string,
  ) {
    super(
      `state lock for ${ref.document}/${ref.profile ?? 'base'} is held by "${holder}" until ${expiresAt}`,
    );
    this.name = 'LockHeldError';
  }
}

/** Thrown when a write's expectedRevision does not match (CAS conflict). */
export class RevisionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `state write refused: expected revision ${expected}, found ${actual} (concurrent mutation)`,
    );
    this.name = 'RevisionConflictError';
  }
}

/** Thrown when a write presents an invalid/expired/foreign lock. */
export class InvalidLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLockError';
  }
}

/** The pluggable state backend contract (IEP-0010). */
export interface StateBackend {
  read(ref: StateRef): Promise<StateDocument | null>;
  /** CAS write: fails unless `expectedRevision` matches and `lock` is valid. */
  write(
    ref: StateRef,
    doc: StateDocument,
    expectedRevision: number,
    lock: LockToken,
  ): Promise<void>;
  appendHistory(ref: StateRef, record: HistoryRecord, lock: LockToken): Promise<void>;
  history(ref: StateRef): Promise<HistoryRecord[]>;
  acquireLock(ref: StateRef, req: LockRequest, now: string): Promise<LockToken>;
  renewLock(token: LockToken, now: string): Promise<LockToken>;
  releaseLock(token: LockToken): Promise<void>;
  /** Force-break a lock — audited, human-only (IEP-0010). */
  breakLock(ref: StateRef, force: ForceUnlockRequest, now: string): Promise<void>;
  readonly capabilities: {
    encryptionAtRest: boolean;
    nativeLocking: boolean;
    historyRetention: 'unbounded' | 'archived';
  };
}
