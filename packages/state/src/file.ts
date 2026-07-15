/**
 * `FileStateBackend` — a DURABLE filesystem state backend (IEP-0010; roadmap
 * Phase 19, M19.3). Unlike `LocalStateBackend` (in-memory, development only),
 * this backend persists every state instance under a configurable root
 * directory, one directory per `StateRef`, so state survives process restart.
 *
 * It implements the full `StateBackend` contract with REAL guarantees:
 *
 *  - Durability: each write is materialised to disk via write-temp-then-rename,
 *    so a reader either sees the previous file or the new one, never a torn
 *    write. A fresh backend pointed at the same root observes prior state.
 *  - Integrity: every stored file carries a `sha256` checksum over the
 *    canonical serialization of its payload. `read` recomputes and compares it
 *    and FAILS CLOSED on mismatch — a tampered or corrupt file is an error, not
 *    silently accepted. The `StateDocument.integrity` hash over the object map
 *    is re-verified too, as defence in depth.
 *  - Cross-process locking: the lease lives in an on-disk lockfile created with
 *    the exclusive `wx` flag (atomic across processes). Acquiring a held,
 *    unexpired lease fails closed; an expired lease may be broken; two backends
 *    over the same root observe each other's lock.
 *  - History: append-only, one JSON record per line (JSONL).
 *  - Encryption at rest: OPTIONAL and HONEST. When an encryption key is
 *    configured (constructor option or `IAP_STATE_ENCRYPTION_KEY`), object data
 *    is sealed with AES-256-GCM and the `encryptionAtRest` capability reports
 *    `true`; with no key, data is stored as plaintext JSON and the capability
 *    reports `false`. The key is NEVER written to the state file.
 *
 * The clock is injected (`now`) so lease expiry stays deterministic and
 * testable, exactly as in `LocalStateBackend`.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJsonStringify, sha256Hex } from '@iap/model';
import type {
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
import { InvalidLockError, LockHeldError, RevisionConflictError } from './types.js';
import { stateIntegrity } from './local.js';

/** Options for {@link FileStateBackend}. */
export interface FileStateBackendOptions {
  /** Root directory under which state instances are persisted. Created lazily. */
  rootDir: string;
  /**
   * At-rest encryption key material. When provided, object data is sealed with
   * AES-256-GCM. Accepts a 32-byte `Buffer` (used directly) or any string
   * (treated as a passphrase and stretched with scrypt per file). Omit to store
   * plaintext. Falls back to `process.env.IAP_STATE_ENCRYPTION_KEY` when unset.
   */
  encryptionKey?: string | Buffer;
}

/** Wire form of a lease persisted to the on-disk lockfile. */
interface StoredLock {
  ref: StateRef;
  token: string;
  holder: string;
  operation: LockOperation;
  /** RFC 3339 instant the lease was acquired. */
  acquiredAt: string;
  /** RFC 3339 instant the lease becomes invalid. */
  expiresAt: string;
  planId?: string;
}

/** Plaintext payload variant of a stored envelope. */
interface PlainPayload {
  algorithm: 'none';
  objects: Record<string, StateObject>;
}

/** AES-256-GCM sealed payload variant of a stored envelope (all base64). */
interface SealedPayload {
  algorithm: 'aes-256-gcm';
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** The on-disk state document envelope. */
interface StoredEnvelope {
  version: 1;
  ref: StateRef;
  revision: number;
  /** `StateDocument.integrity`: sha256 over the canonical object map. */
  integrity: string;
  payload: PlainPayload | SealedPayload;
  /** sha256 over the canonical serialization of the envelope sans `checksum`. */
  checksum: string;
}

function addSeconds(iso: string, seconds: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`invalid RFC 3339 instant: ${iso}`);
  return new Date(ms + seconds * 1000).toISOString();
}

/** A stable, filesystem-safe directory name for a state ref. */
function refDirName(ref: StateRef): string {
  return sha256Hex(canonicalJsonStringify({ document: ref.document, profile: ref.profile }));
}

/** True when the error is an ENOENT (missing file). */
function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** True when the error is an EEXIST (exclusive-create collision). */
function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}

/** The checksum over an envelope's canonical form, excluding the checksum field. */
function envelopeChecksum(env: Omit<StoredEnvelope, 'checksum'>): string {
  return `sha256:${sha256Hex(canonicalJsonStringify(env))}`;
}

export class FileStateBackend implements StateBackend {
  private readonly rootDir: string;
  private readonly key: Buffer | null;

  readonly capabilities: StateBackend['capabilities'];

  constructor(options: FileStateBackendOptions) {
    this.rootDir = options.rootDir;
    const material = options.encryptionKey ?? process.env.IAP_STATE_ENCRYPTION_KEY;
    this.key = material === undefined || material === '' ? null : normalizeKey(material);
    this.capabilities = {
      // HONEST: only true when a key is configured and we actually seal bytes.
      encryptionAtRest: this.key !== null,
      // The lease is a real on-disk lockfile, atomic across processes.
      nativeLocking: true,
      historyRetention: 'unbounded',
    };
  }

  private instanceDir(ref: StateRef): string {
    return join(this.rootDir, refDirName(ref));
  }

  private statePath(ref: StateRef): string {
    return join(this.instanceDir(ref), 'state.json');
  }

  private historyPath(ref: StateRef): string {
    return join(this.instanceDir(ref), 'history.jsonl');
  }

  private lockPath(ref: StateRef): string {
    return join(this.instanceDir(ref), 'lock.json');
  }

  private async ensureDir(ref: StateRef): Promise<void> {
    await mkdir(this.instanceDir(ref), { recursive: true });
  }

  /** Atomically replace `path` with `data` (write-temp-then-rename). */
  private async atomicWrite(path: string, data: string): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  }

  // ---- reads -------------------------------------------------------------

  async read(ref: StateRef): Promise<StateDocument | null> {
    let raw: string;
    try {
      raw = await readFile(this.statePath(ref), 'utf8');
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    const env = JSON.parse(raw) as StoredEnvelope;
    const { checksum, ...rest } = env;
    const expected = envelopeChecksum(rest);
    if (checksum !== expected) {
      // Fail closed: the file was tampered with or is corrupt.
      throw new StateIntegrityError(
        `state integrity check failed for ${ref.document}/${ref.profile ?? 'base'}: ` +
          `checksum ${checksum} does not match ${expected}`,
      );
    }
    const objects = this.openPayload(env.payload, ref);
    const integrity = stateIntegrity(objects);
    if (env.integrity !== integrity) {
      throw new StateIntegrityError(
        `state integrity check failed for ${ref.document}/${ref.profile ?? 'base'}: ` +
          `object hash ${env.integrity} does not match ${integrity}`,
      );
    }
    return { ref: env.ref, revision: env.revision, integrity: env.integrity, objects };
  }

  /** Decode a payload back to the object map, decrypting when sealed. */
  private openPayload(
    payload: StoredEnvelope['payload'],
    ref: StateRef,
  ): Record<string, StateObject> {
    if (payload.algorithm === 'none') {
      if (this.key !== null) {
        throw new StateIntegrityError(
          `state for ${ref.document}/${ref.profile ?? 'base'} is stored unencrypted, ` +
            `but an encryption key is configured`,
        );
      }
      return payload.objects;
    }
    if (this.key === null) {
      throw new StateIntegrityError(
        `state for ${ref.document}/${ref.profile ?? 'base'} is encrypted, ` +
          `but no encryption key is configured`,
      );
    }
    const salt = Buffer.from(payload.salt, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    const key = deriveKey(this.key, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let plaintext: string;
    try {
      plaintext = decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
    } catch {
      throw new StateIntegrityError(
        `state decryption failed for ${ref.document}/${ref.profile ?? 'base'}: ` +
          `wrong key or tampered ciphertext`,
      );
    }
    return JSON.parse(plaintext) as Record<string, StateObject>;
  }

  // ---- writes ------------------------------------------------------------

  async write(
    ref: StateRef,
    doc: StateDocument,
    expectedRevision: number,
    lock: LockToken,
  ): Promise<void> {
    await this.ensureDir(ref);
    await this.assertActiveLock(ref, lock);
    const current = (await this.read(ref))?.revision ?? 0;
    if (current !== expectedRevision) throw new RevisionConflictError(expectedRevision, current);
    if (doc.revision !== expectedRevision + 1) {
      throw new RevisionConflictError(expectedRevision + 1, doc.revision);
    }
    const integrity = stateIntegrity(doc.objects);
    if (doc.integrity !== integrity) {
      throw new InvalidLockError(
        `write refused: integrity hash does not match objects (${doc.integrity} vs ${integrity})`,
      );
    }
    const rest: Omit<StoredEnvelope, 'checksum'> = {
      version: 1,
      ref,
      revision: doc.revision,
      integrity,
      payload: this.sealPayload(doc.objects),
    };
    const env: StoredEnvelope = { ...rest, checksum: envelopeChecksum(rest) };
    await this.atomicWrite(this.statePath(ref), JSON.stringify(env));
  }

  /** Encode the object map, sealing with AES-256-GCM when a key is configured. */
  private sealPayload(objects: Record<string, StateObject>): StoredEnvelope['payload'] {
    if (this.key === null) {
      return { algorithm: 'none', objects };
    }
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = deriveKey(this.key, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = canonicalJsonStringify(objects);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      algorithm: 'aes-256-gcm',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  // ---- history -----------------------------------------------------------

  async appendHistory(ref: StateRef, record: HistoryRecord, lock: LockToken): Promise<void> {
    await this.ensureDir(ref);
    await this.assertActiveLock(ref, lock);
    await appendFile(this.historyPath(ref), `${JSON.stringify(record)}\n`, 'utf8');
  }

  async history(ref: StateRef): Promise<HistoryRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.historyPath(ref), 'utf8');
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as HistoryRecord);
  }

  // ---- locking -----------------------------------------------------------

  private async readLock(ref: StateRef): Promise<StoredLock | null> {
    try {
      return JSON.parse(await readFile(this.lockPath(ref), 'utf8')) as StoredLock;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  private async assertActiveLock(ref: StateRef, lock: LockToken): Promise<void> {
    const held = await this.readLock(ref);
    if (held === null || held.token !== lock.token) {
      throw new InvalidLockError('write refused: the presented lock is not the active lease');
    }
  }

  async acquireLock(ref: StateRef, req: LockRequest, now: string): Promise<LockToken> {
    await this.ensureDir(ref);
    const nowMs = Date.parse(now);
    // Bounded retries handle the narrow race where a concurrent acquirer wins
    // the exclusive create after we observe (and break) an expired lease.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const held = await this.readLock(ref);
      if (held !== null) {
        if (Date.parse(held.expiresAt) > nowMs) {
          // A live lease is held — fail closed (§5.5), never queue or steal.
          throw new LockHeldError(ref, held.holder, held.expiresAt);
        }
        // Expired lease: break it, then attempt to claim.
        await this.removeLock(ref);
      }
      const token: LockToken = {
        ref,
        token: `lock-${req.holder}-${randomUUID()}`,
        holder: req.holder,
        operation: req.operation,
        expiresAt: addSeconds(now, req.ttlSeconds),
        ...(req.planId === undefined ? {} : { planId: req.planId }),
      };
      const stored: StoredLock = {
        ref,
        token: token.token,
        holder: token.holder,
        operation: token.operation,
        acquiredAt: now,
        expiresAt: token.expiresAt,
        ...(req.planId === undefined ? {} : { planId: req.planId }),
      };
      try {
        // Exclusive create: atomic across processes.
        await writeFile(this.lockPath(ref), JSON.stringify(stored), { flag: 'wx' });
        return token;
      } catch (err) {
        if (!isEexist(err)) throw err;
        // Lost the race; loop to re-inspect the winner's lease.
      }
    }
    const held = await this.readLock(ref);
    throw new LockHeldError(ref, held?.holder ?? 'unknown', held?.expiresAt ?? now);
  }

  async renewLock(token: LockToken, now: string): Promise<LockToken> {
    const held = await this.readLock(token.ref);
    if (held === null || held.token !== token.token) {
      throw new InvalidLockError('cannot renew a lock that is not held');
    }
    const ttl = Math.max(
      1,
      Math.round((Date.parse(token.expiresAt) - Date.parse(now)) / 1000) || 60,
    );
    const renewed: LockToken = { ...token, expiresAt: addSeconds(now, ttl) };
    const stored: StoredLock = { ...held, expiresAt: renewed.expiresAt };
    await this.atomicWrite(this.lockPath(token.ref), JSON.stringify(stored));
    return renewed;
  }

  async releaseLock(token: LockToken): Promise<void> {
    const held = await this.readLock(token.ref);
    if (held !== null && held.token === token.token) {
      await this.removeLock(token.ref);
    }
  }

  async breakLock(ref: StateRef, _force: ForceUnlockRequest, _now: string): Promise<void> {
    // Audited, human-only: the caller is responsible for recording the reason.
    await this.removeLock(ref);
  }

  private async removeLock(ref: StateRef): Promise<void> {
    try {
      await unlink(this.lockPath(ref));
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
}

/** Thrown when a stored state file fails its integrity/decryption check. */
export class StateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateIntegrityError';
  }
}

/** Normalize provided key material to a base secret (never persisted). */
function normalizeKey(material: string | Buffer): Buffer {
  if (Buffer.isBuffer(material)) return material;
  return Buffer.from(material, 'utf8');
}

/** Derive a 32-byte AES key from the base secret and a per-file salt. */
function deriveKey(secret: Buffer, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}
