/**
 * `@iap/state` — the state backend (spec ch. 13, IEP-0010). Pins lease-based
 * locking (fail-closed on a live lease), CAS writes on the monotonic revision,
 * the integrity hash, and append-only history.
 */
import { describe, expect, it } from 'vitest';
import {
  InvalidLockError,
  LocalStateBackend,
  LockHeldError,
  RevisionConflictError,
  stateIntegrity,
} from '../src/index';
import type { StateDocument, StateObject, StateRef } from '../src/index';

const REF: StateRef = { document: 'orders', profile: null };
const T0 = '2026-07-01T00:00:00Z';
const later = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

const OBJ: StateObject = { type: 'mock:core:Store', attributes: { size: 'm' }, managed: true };

function doc(revision: number, objects: Record<string, StateObject>): StateDocument {
  return { ref: REF, revision, integrity: stateIntegrity(objects), objects };
}

describe('lease locking (fail-closed, §5.5)', () => {
  it('grants a lock, then refuses a second acquisition while the lease is live', async () => {
    const b = new LocalStateBackend();
    await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await expect(
      b.acquireLock(REF, { holder: 'b', operation: 'apply', ttlSeconds: 300 }, later(10)),
    ).rejects.toBeInstanceOf(LockHeldError);
  });

  it('grants a new lock once the prior lease has expired', async () => {
    const b = new LocalStateBackend();
    await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 60 }, T0);
    const second = await b.acquireLock(
      REF,
      { holder: 'b', operation: 'apply', ttlSeconds: 60 },
      later(120),
    );
    expect(second.holder).toBe('b');
  });

  it('release frees the lock; breakLock force-frees it', async () => {
    const b = new LocalStateBackend();
    const lock = await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await b.releaseLock(lock);
    const again = await b.acquireLock(
      REF,
      { holder: 'b', operation: 'apply', ttlSeconds: 300 },
      later(1),
    );
    expect(again.holder).toBe('b');
    await b.breakLock(REF, { actor: 'admin', reason: 'stuck' }, later(2));
    await expect(
      b.acquireLock(REF, { holder: 'c', operation: 'apply', ttlSeconds: 300 }, later(3)),
    ).resolves.toBeDefined();
  });
});

describe('CAS writes and integrity', () => {
  it('writes at revision+1 under the active lock, then reads back', async () => {
    const b = new LocalStateBackend();
    const lock = await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await b.write(REF, doc(1, { s: OBJ }), 0, lock);
    const read = await b.read(REF);
    expect(read?.revision).toBe(1);
    expect(read?.objects.s).toEqual(OBJ);
  });

  it('refuses a stale expectedRevision (concurrent mutation prevented)', async () => {
    const b = new LocalStateBackend();
    const lock = await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await b.write(REF, doc(1, { s: OBJ }), 0, lock);
    await expect(b.write(REF, doc(2, { s: OBJ }), 0, lock)).rejects.toBeInstanceOf(
      RevisionConflictError,
    );
  });

  it('refuses a write whose integrity hash does not match its objects', async () => {
    const b = new LocalStateBackend();
    const lock = await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    const bad: StateDocument = {
      ref: REF,
      revision: 1,
      integrity: 'sha256:deadbeef',
      objects: { s: OBJ },
    };
    await expect(b.write(REF, bad, 0, lock)).rejects.toBeInstanceOf(InvalidLockError);
  });

  it('refuses a write without the active lock', async () => {
    const b = new LocalStateBackend();
    const lock = await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await b.releaseLock(lock);
    await expect(b.write(REF, doc(1, { s: OBJ }), 0, lock)).rejects.toBeInstanceOf(
      InvalidLockError,
    );
  });
});

describe('history', () => {
  it('appends and reads back records under the lock', async () => {
    const b = new LocalStateBackend();
    const lock = await b.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await b.appendHistory(
      REF,
      {
        revision: 1,
        planId: 'p1',
        timestamp: T0,
        actor: 'a',
        outcome: 'succeeded',
        approvals: ['a'],
        applied: ['s'],
        failed: [],
        findings: [],
      },
      lock,
    );
    const history = await b.history(REF);
    expect(history).toHaveLength(1);
    expect(history[0].planId).toBe('p1');
  });
});
