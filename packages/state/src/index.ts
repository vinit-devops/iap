/**
 * `@iap/state` — the state backend (spec ch. 13, IEP-0010; roadmap Phase 14,
 * M14.1). A pluggable `StateBackend` with lease-based locking (fail-closed on a
 * live lease, §5.5), CAS writes on a monotonic revision, an integrity-hashed
 * object store, and append-only history. The `LocalStateBackend` is the
 * in-memory/development implementation; remote backends implement the same
 * interface. Secrets are never stored — state holds references only (§13.2).
 */
export { LocalStateBackend, stateIntegrity } from './local.js';
export { FileStateBackend, StateIntegrityError } from './file.js';
export type { FileStateBackendOptions } from './file.js';
export { InvalidLockError, LockHeldError, RevisionConflictError } from './types.js';
export type {
  ForceUnlockRequest,
  HistoryRecord,
  LockOperation,
  LockRequest,
  LockToken,
  StateBackend,
  StateDocument,
  StateObject,
  StateRef,
} from './types.js';
