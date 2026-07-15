/**
 * `FileStateBackend` (IEP-0010; roadmap Phase 19, M19.3). Pins the DURABLE
 * filesystem contract: persistence across process/instance boundaries,
 * fail-closed integrity, cross-instance on-disk locking, and HONEST optional
 * at-rest encryption. Also pins the RISK-001 fix on `LocalStateBackend`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileStateBackend,
  LocalStateBackend,
  LockHeldError,
  StateIntegrityError,
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

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'iap-state-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Locate the persisted state.json for REF under the root (dir is hashed). */
function stateFilePath(): string {
  const sub = readdirSync(root);
  expect(sub).toHaveLength(1);
  return join(root, sub[0]!, 'state.json');
}

describe('durability (survives a fresh backend instance)', () => {
  it('persists a write→read round-trip across instances over the same dir', async () => {
    const a = new FileStateBackend({ rootDir: root });
    const lock = await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.write(REF, doc(1, { s: OBJ }), 0, lock);

    // A brand-new backend, no shared memory, pointed at the same directory.
    const b = new FileStateBackend({ rootDir: root });
    const read = await b.read(REF);
    expect(read?.revision).toBe(1);
    expect(read?.objects.s).toEqual(OBJ);
  });

  it('preserves append-only history across instances', async () => {
    const a = new FileStateBackend({ rootDir: root });
    const lock = await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.appendHistory(
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
    const b = new FileStateBackend({ rootDir: root });
    const history = await b.history(REF);
    expect(history).toHaveLength(1);
    expect(history[0]!.planId).toBe('p1');
  });
});

describe('integrity (fail-closed on tamper/corruption)', () => {
  it('rejects a read of a corrupted on-disk file', async () => {
    const a = new FileStateBackend({ rootDir: root });
    const lock = await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.write(REF, doc(1, { s: OBJ }), 0, lock);

    const path = stateFilePath();
    const env = JSON.parse(await readFile(path, 'utf8')) as {
      payload: { objects: Record<string, StateObject> };
    };
    // Tamper with the object data but leave the (now stale) checksum in place.
    env.payload.objects.s!.attributes.size = 'XL';
    await writeFile(path, JSON.stringify(env), 'utf8');

    const b = new FileStateBackend({ rootDir: root });
    await expect(b.read(REF)).rejects.toBeInstanceOf(StateIntegrityError);
  });
});

describe('cross-process locking (on-disk lease, fail-closed)', () => {
  it('refuses a second acquire while another instance holds a live lease', async () => {
    const a = new FileStateBackend({ rootDir: root });
    const b = new FileStateBackend({ rootDir: root });
    await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await expect(
      b.acquireLock(REF, { holder: 'b', operation: 'apply', ttlSeconds: 300 }, later(10)),
    ).rejects.toBeInstanceOf(LockHeldError);
  });

  it('grants the lock to another instance after unlock', async () => {
    const a = new FileStateBackend({ rootDir: root });
    const b = new FileStateBackend({ rootDir: root });
    const lock = await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.releaseLock(lock);
    const again = await b.acquireLock(
      REF,
      { holder: 'b', operation: 'apply', ttlSeconds: 300 },
      later(1),
    );
    expect(again.holder).toBe('b');
  });

  it('breaks an expired lease and grants a fresh lock', async () => {
    const a = new FileStateBackend({ rootDir: root });
    await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 60 }, T0);
    const b = new FileStateBackend({ rootDir: root });
    const second = await b.acquireLock(
      REF,
      { holder: 'b', operation: 'apply', ttlSeconds: 60 },
      later(120),
    );
    expect(second.holder).toBe('b');
  });

  it('breakLock force-frees a held lease', async () => {
    const a = new FileStateBackend({ rootDir: root });
    await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.breakLock(REF, { actor: 'admin', reason: 'stuck' }, later(1));
    await expect(
      a.acquireLock(REF, { holder: 'c', operation: 'apply', ttlSeconds: 300 }, later(2)),
    ).resolves.toBeDefined();
  });
});

describe('at-rest encryption (honest capability)', () => {
  const SECRET = 'SUPER-SECRET-ATTR-VALUE-9c3f';
  const SECRET_OBJ: StateObject = {
    type: 'mock:core:Store',
    attributes: { note: SECRET },
    managed: true,
  };

  it('does not write the plaintext secret when a key is configured, and round-trips', async () => {
    const key = 'unit-test-passphrase';
    const a = new FileStateBackend({ rootDir: root, encryptionKey: key });
    expect(a.capabilities.encryptionAtRest).toBe(true);

    const secretDoc: StateDocument = {
      ref: REF,
      revision: 1,
      integrity: stateIntegrity({ s: SECRET_OBJ }),
      objects: { s: SECRET_OBJ },
    };
    const lock = await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.write(REF, secretDoc, 0, lock);

    const bytes = await readFile(stateFilePath(), 'utf8');
    expect(bytes).not.toContain(SECRET);
    expect(bytes).toContain('aes-256-gcm');

    const b = new FileStateBackend({ rootDir: root, encryptionKey: key });
    const read = await b.read(REF);
    expect(read?.objects.s).toEqual(SECRET_OBJ);
  });

  it('reports encryptionAtRest=false and stores plaintext with no key', async () => {
    const a = new FileStateBackend({ rootDir: root });
    expect(a.capabilities.encryptionAtRest).toBe(false);
    const lock = await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.write(REF, doc(1, { s: OBJ }), 0, lock);
    const bytes = await readFile(stateFilePath(), 'utf8');
    expect(bytes).toContain('"algorithm":"none"');
  });

  it('fails to decrypt with the wrong key', async () => {
    const a = new FileStateBackend({ rootDir: root, encryptionKey: 'right-key' });
    const secretDoc: StateDocument = {
      ref: REF,
      revision: 1,
      integrity: stateIntegrity({ s: SECRET_OBJ }),
      objects: { s: SECRET_OBJ },
    };
    const lock = await a.acquireLock(REF, { holder: 'a', operation: 'apply', ttlSeconds: 300 }, T0);
    await a.write(REF, secretDoc, 0, lock);

    const b = new FileStateBackend({ rootDir: root, encryptionKey: 'wrong-key' });
    await expect(b.read(REF)).rejects.toBeInstanceOf(StateIntegrityError);
  });
});

describe('RISK-001: LocalStateBackend capability honesty', () => {
  it('reports encryptionAtRest=false (in-memory plaintext store)', () => {
    const b = new LocalStateBackend();
    expect(b.capabilities.encryptionAtRest).toBe(false);
  });
});
