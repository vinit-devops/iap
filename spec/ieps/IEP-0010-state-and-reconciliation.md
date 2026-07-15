# IEP-0010: State and Reconciliation Model

| Field | Value |
|---|---|
| **Title** | State Backend, Execution History, and Unified Drift Taxonomy |
| **Number** | IEP-0010 |
| **Status** | Draft |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.x |

## Summary

This IEP completes the state story that [Chapter 13](../chapters/13-infrastructure-model.md) (state document) and [Chapter 14](../chapters/14-planning-model.md) (drift, reconciliation, failure recovery) begin: a pluggable **state backend interface** with lock/concurrency semantics, the **immutable execution history record** expanded to the roadmap §4.4 field set, a **unified drift taxonomy** reconciling Chapter 14's disposition classes (`reconcilable`/`conflicting`/`out-of-scope`) with the roadmap's severity classes (benign / intent-preserving / intent-violating / security-critical / unknown), and state recovery after partial failure.

## Motivation

Chapter 13 defines *what* the state document contains and Chapter 14 defines *how* plans consume it, but neither defines where state lives, how concurrent mutation is prevented, or which of the two drift vocabularies now in circulation is authoritative. Roadmap Phase 14 requires local encrypted state, remote object storage with locking, and a pluggable backend; roadmap §4.4 requires history fields (approvals, cost impact, findings, rollback/verification results) beyond Chapter 13's §13.4 record. These deltas are the heart of this IEP.

## Problem statement

1. No backend contract exists; implementations would invent incompatible storage/locking behavior.
2. Two overlapping drift taxonomies exist (spec ch14 vs. roadmap Phase 14) with no defined mapping.
3. Chapter 13's history record is a subset of the roadmap §4.4 record; the superset needs a home that stays consistent with §13.4's normative fields.
4. Recovery semantics after an engine crash mid-apply (as opposed to a failed step, which §14.7 covers) are undefined.

## Goals

- Define `StateBackend` (read/write/lock/history) as a stable plugin interface.
- Define lease-based locking with fail-closed semantics (roadmap §5.5: "state locking fails → stop").
- Extend the history record to roadmap §4.4 without breaking §13.4.
- Define one two-axis drift taxonomy usable by engines, dashboards, and policy.
- Define crash recovery guarantees.

## Non-goals

- Enterprise backends (multi-tenant database, replication, DR) — later Phase 14/16 work.
- Rollback semantics themselves (Chapter 14 §14.6 governs; unchanged here).
- Secret storage (state stores references only, per §13.2).

## Terminology

- **State backend** — the storage/concurrency provider for state documents and history.
- **Lease lock** — an exclusive, expiring lock on one `(document, profile)` state instance.
- **Disposition** — what an engine may do about a drift finding (ch14 axis).
- **Severity** — what the drift means for declared intent (roadmap axis).

## Detailed design

### State backend interface

```typescript
interface StateBackend {
  // Identity: one state instance per (document name, active profile) — Ch. 13 §13.1.
  read(ref: StateRef): Promise<StateDocument | null>;
  // CAS write: fails unless expectedRevision matches; monotonic revision per §13.4.
  write(ref: StateRef, doc: StateDocument, expectedRevision: number,
        lock: LockToken): Promise<void>;
  appendHistory(ref: StateRef, record: HistoryRecord, lock: LockToken): Promise<void>;

  acquireLock(ref: StateRef, req: LockRequest): Promise<LockToken>; // throws LockHeldError
  renewLock(token: LockToken): Promise<LockToken>;
  releaseLock(token: LockToken): Promise<void>;
  breakLock(ref: StateRef, force: ForceUnlockRequest): Promise<void>; // audited, human-only

  readonly capabilities: { encryptionAtRest: boolean; nativeLocking: boolean;
                           historyRetention: "unbounded" | "archived"; };
}

interface LockRequest { holder: string; operation: "plan" | "apply" | "import" | "reconcile";
                        ttlSeconds: number; planId?: string; }
```

Initial implementations: **local encrypted file backend** (development; age/AEAD encryption, lock via lockfile + PID/lease record) and **remote object storage backend** (versioned objects; locking via conditional writes or a companion lock object). Both are selected by configuration, never by document content.

**Lock semantics (normative):** exactly one lock per state instance; `plan` and `apply` both require it; expiry via TTL with renewal heartbeats; a lost or non-renewable lock aborts the operation before the next state write (fail closed); `breakLock` requires an explicit human action and writes an audit history record. Plans record the state `revision` they were computed against; an `apply` MUST refuse to start if the current revision differs (complements plan invalidation, IEP-0011).

### Execution history record

Superset of §13.4, preserving its fields verbatim:

```json
{
  "revision": 15, "planId": "sha256:…", "timestamp": "2026-07-10T10:02:11Z",
  "documentHash": "sha256:…", "outcome": "succeeded", "actor": "vinit.kumar@example.org",
  "canonicalModelHash": "sha256:…",
  "profileHashes": { "production": "sha256:…" }, "policyBundleHashes": { "org-baseline": "sha256:…" },
  "mappingVersions": { "aws": "2.3.1" },
  "approvals": [ { "approver": "…", "gate": "stateful-replace", "at": "…" } ],
  "resourceOutcomes": { "created": [], "updated": ["session-cache"], "replaced": [],
                        "imported": [], "destroyed": [] },
  "costImpact": { "monthlyDelta": "+12.40 USD", "pricingSnapshot": "aws-pricing-2026-07-01" },
  "findings": { "security": [], "compliance": [] },
  "executionLogRef": "blob://…", "rollbackResult": null,
  "verificationResult": { "status": "passed", "checks": 9 },
  "stateVersionBefore": 14, "stateVersionAfter": 15
}
```

History is append-only (§13.4); the added fields are additive and optional for minimal engines, mandatory for the reference engine. The actor is never an AI system (§13.4, Layer Boundary Invariant).

### Unified drift taxonomy

Every drift finding carries **both axes**:

| | `reconcilable` | `conflicting` | `out-of-scope` |
|---|---|---|---|
| `benign` | auto re-apply eligible | surface, low priority | delegate to extension tooling |
| `intent-preserving` | auto re-apply eligible or accept-into-intent | surface for manual choice | delegate |
| `intent-violating` | re-apply eligible; escalation per policy | MUST surface; never auto-overwrite | delegate + warn |
| `security-critical` | MUST escalate before any action | MUST escalate; never auto-overwrite | MUST escalate (never silently delegated) |
| `unknown` | treated as `conflicting` until classified | surface | surface |

Severity is computed deterministically from the diffed field's semantics (security-relevant fields per [Chapter 15](../chapters/15-security-model.md) → `security-critical`; capability floors → `intent-violating`; observed-only attributes → `benign`), through the mapping's inverse projection (§14.8) — never by inference. Operator actions remain the roadmap set: accept into intent (a compiler operation, IEP-0009), reconcile (re-plan/re-apply), ignore temporarily (with expiry), escalate, re-plan.

### Recovery after partial failure

Failed *steps* already resolve by re-planning (§14.7). For engine *crashes*: every apply writes a write-ahead **apply journal** (planId, wave, step, pre-state revision) through the backend before each provider call; on restart with a held-or-expired lock, the engine replays the journal, refreshes affected objects via inverse projection, commits a corrected state document, and records outcome `partial`. Reconstructibility (§13.1) remains the backstop: state loss is recoverable from document + history + substrate reads.

## Schema impact

No change to `iap-v1.schema.json`. Adds a normative companion `state.iap.dev/v1` schema (Chapter 13 §13.8 anticipates it) including the extended history record and lock metadata.

## Runtime-model impact

Planner input "infrastructure model snapshot" (CP-1) becomes `(state document, revision)` read under lock through this interface.

## Validation impact

None on document validation. Adds state integrity verification (§13.1) as a backend-level check with defined error codes.

## Provider impact

Provider packages implement drift *observation* (inverse projection) and read handlers only; classification and disposition are core logic. Example: an out-of-band storage resize observed via an `aws` mapping's inverse projection classifies `(intent-violating, reconcilable)` if below declared `capacity.storage`, `(benign, reconcilable)` if above the floor.

## Security impact

State contains references, never secrets (§13.2/§13.7). Local backend encrypts at rest; remote backend requires provider-side encryption and access control. `breakLock` and `ignore` actions are audited. `security-critical` drift can never be auto-suppressed.

## Cost impact

History gains `costImpact` per apply, enabling spend audit; storage overhead is bounded by history archiving (`capabilities.historyRetention`).

## Compatibility

Additive to Chapter 13/14. Existing minimal state documents remain valid; extended history fields are optional-on-read.

## Migration

State documents gain `schemaVersion`; a migration tool (`tools/migration`) upgrades v0 development state in place. No document migration.

## Alternatives considered

1. Single mandatory severity axis only — rejected: loses ch14's actionable disposition semantics.
2. Locking via advisory convention (CI serialization) — rejected: fails roadmap §5.5.
3. Git as the state backend — rejected for v1: no atomic lease semantics; revisit as an enterprise backend.

## Rejected alternatives

Embedding state in the IaP document (Terraform-style) is categorically rejected (roadmap §4.3; Chapter 13 §13.7).

## Implementation plan

1. `packages/state`: interfaces, local encrypted backend, in-memory test backend (with mock provider).
2. Remote object-storage backend with conditional-write locking.
3. Extended history + `state.iap.dev/v1` schema; migration tool.
4. Drift classifier + taxonomy conformance cases; crash-recovery failure-injection suite (`tests/security`, `tests/determinism`).

## Conformance requirements

- ST-1: concurrent `apply` attempts on one state instance — exactly one proceeds; the other fails before any state write.
- ST-2: history is append-only; any mutation of an existing record fails integrity verification.
- ST-3: every drift finding carries both taxonomy axes and a deterministic classification replayable from the same observation snapshot.
- ST-4: kill-the-engine failure injection at every journal boundary yields a recoverable, accurate state document.
- ST-5: state rebuilt per §13.1 is planning-equivalent to the lost original (identical subsequent plan).

## Open questions

1. Should `ignore temporarily` be a policy-controlled capability with mandatory expiry ceilings?
2. Minimum lock TTL/renewal defaults, and whether `plan` may use a shared (read) lock instead of exclusive.
3. Where does the apply journal live for backends without native append primitives?

## Decision

Pending review.

## References

- [Chapter 13 — Infrastructure Model](../chapters/13-infrastructure-model.md)
- [Chapter 14 — Planning Model (§14.7–§14.9)](../chapters/14-planning-model.md)
- [Chapter 15 — Security Model](../chapters/15-security-model.md)
- Roadmap §4.3, §4.4, §5.5, Phase 14
