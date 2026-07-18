# ADR-0006: Replacement-update semantics (immutable attributes → gated delete+create)

**Status:** Proposed
**Date:** 2026-07-16

## Context

The M19.3 live run deferred lifecycle test 4 (replacement update): for S3/SQS/IAM the resource
identity *is* the name, so a same-identity immutable-attribute replacement isn't natural for
those types. The plan layer already classifies a `replace` action, but the executor has no
implementation. ROADMAP-V4 makes this blocking early: DynamoDB (M22.2) has an immutable key
schema, and many later services (RDS engine/major-version paths, EC2 launch settings,
cluster topologies) can only reconcile some attribute changes by replacing the resource.
Without executor support, drift on an immutable attribute dead-ends — the plan says `replace`
and the deploy can only fail or lie.

## Decision

We will implement replacement-update semantics in the M21.1 foundation, before any handler
that needs them ships:

1. Each handler declares its **immutable attributes** alongside its desired projection. The
   diff engine detects a changed immutable attribute and classifies the action as `replace`
   (never `update-in-place`).
2. Replacement executes as **delete-then-create** and is **gated**: it never runs implicitly.
   The plan surfaces the replacement and its data-loss implication, and execution requires the
   same explicit confirmation path as destroy (`--confirm`), failing closed otherwise.
3. State and tags track the replacement atomically enough to recover: a failure between delete
   and create leaves an honest error state (`errors[]`, non-zero exit), never a silent
   half-replacement — matching the fail-closed behavior proven in M19.3 tests 6–7.
4. The live-run runbook's lifecycle test 4 exercises replacement in every wave that has an
   immutable-attribute resource; the first mandatory live exercise is DynamoDB's key schema in
   M22.2.

## Consequences

- Replacement is destructive by construction; the gate + explicit plan surface make data loss a
  human decision, not an executor side effect.
- Handler authors must think about immutability per attribute up front — a per-handler
  declaration, kept next to the projection, becomes part of the handler contract.
- Stateful resources (databases, volumes) get an honest answer for immutable drift; future
  snapshot/migrate-before-replace strategies can layer on top without changing the
  classification contract.
- Between delete and create the resource does not exist; the runbook must note availability
  impact for replacement tests on shared-fate workloads.

## Alternatives considered

- **Update-only: error on immutable-attribute change.** Rejected: dead-ends drift
  reconciliation; the plan layer already promises a `replace` classification.
- **Silent delete+create inside `update`.** Rejected: destroys data without a gate; violates
  the fail-closed, no-silent-success principles the M19.3 evidence established.
- **Create-before-delete (blue/green) replacement.** Rejected for now: name-keyed identities
  (buckets, queues, roles, tables) often cannot coexist, so it cannot be the general strategy;
  may arrive later as a per-handler optimization where identities permit.

## References

- ROADMAP-V4.yml M21.1 (foundation), M22.2 (first live exercise); roadmap-v4 risk register
  item 1 (top dependency).
- M19.3 live-run evidence, lifecycle test 4 (`e10ebe0^:docs/reports/m19.3-live-run-evidence.md`).
- docs/guides/live-run-runbook.md lifecycle test 4; ADR-0004 (companion M21.1 refactor).
