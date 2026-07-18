# ADR-0004: Derived handler registry and lazy per-service AWS clients

**Status:** Proposed
**Date:** 2026-07-16

## Context

The v0.1 AWS executor (`packages/deploy-aws/`) realizes exactly three target types. Handlers
are wired through a hand-maintained Map, the supported set is a hand-maintained constant
(`SUPPORTED_TARGET_TYPES` in `packages/deploy-aws/src/types.ts`), and `clients.ts` eagerly
constructs one SDK client per AWS service at module load. ROADMAP-V4 grows the executor to
~88–105 handlers across ~40 AWS SDK clients; three hand-maintained, must-stay-consistent
registration points and an eager client fan-out do not scale to that width, and a missed
registration would silently diverge the plan layer from the execution layer.

## Decision

We will make handler registration self-declaring and client construction lazy, in M21.1,
before any new handler lands:

1. Each TargetHandler self-declares its `targetType`. The handler Map and
   `SUPPORTED_TARGET_TYPES` are **derived** from the set of registered handlers at module
   init — never hand-edited again.
2. Fail-closed behavior is preserved exactly: a target type with no registered handler raises
   `UnsupportedTargetTypeError`, and registration stays static (no dynamic/plugin loading), so
   the supported set remains deterministic and auditable.
3. `clients.ts` is replaced by a lazy per-service client cache: an SDK client is constructed on
   first use by a handler and reused thereafter. No client is constructed for services a run
   never touches.

## Consequences

- Adding a handler becomes one file with one declaration; the registry, the supported set, and
  the fail-closed boundary update themselves. Wave-sized handler batches (Phases 21–24) stay
  mechanical.
- The existing three handlers must pass their unchanged test suite through the derived
  registry — this is an M21.1 exit criterion, proving the refactor is behavior-neutral.
- Lazy clients change construction timing; any code that relied on eager construction (e.g.
  early credential validation) must move to the pre-flight path in the live-run harness.
- Derivation happens at module init, so a duplicate `targetType` declaration must fail fast at
  init, not at dispatch.

## Alternatives considered

- **Keep the hand-maintained Map/constant.** Rejected: three synchronized edit points ×
  ~100 handlers is a standing consistency bug; the constant would become a merge-conflict
  magnet across waves.
- **Dynamic/plugin handler loading.** Rejected: breaks determinism and the signed, fail-closed
  provider trust model; the supported set must be knowable from the build, not from runtime
  discovery.
- **Keep eager clients, add the missing ~35.** Rejected: pays startup and memory cost for every
  service on every run, and each wave would edit a global file rather than shipping
  self-contained handlers.

## References

- ROADMAP-V4.yml M21.1 (foundation milestone); roadmap-v4 Phase 21.
- `packages/deploy-aws/src/types.ts` (`SUPPORTED_TARGET_TYPES`), `packages/deploy-aws/src/clients.ts`.
- ADR-0006 (replacement-update semantics — the other M21.1 foundation piece).
