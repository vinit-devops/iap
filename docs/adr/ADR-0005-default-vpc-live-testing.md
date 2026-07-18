# ADR-0005: Default-VPC pragmatism for early live-run waves

**Status:** Proposed
**Date:** 2026-07-16

## Context

ROADMAP-V4's live verification bar requires one real-AWS golden-path run per wave. The compute
and data-engine waves (M21.3 three-tier app; Phase 22 engines such as Aurora, DocumentDB,
Neptune, MemoryDB, Amazon MQ) need VPC networking — subnets, security groups, subnet groups —
but the `Network` kind is reserved until spec minor 1.2.0 (M23.3) and its handlers arrive only
in M23.4. Blocking every VPC-adjacent live run on the `Network` graduation would invert the
roadmap's critical path and idle Phases 21–22.

## Decision

We will run early live waves on the AWS account's **default VPC**:

1. From M21.3 through Phase 22, live runs place VPC-resident resources into the default VPC
   (and its default subnets), creating only resource-scoped networking objects (e.g. DB subnet
   groups, security groups) that the wave's handlers own and tear down.
2. Every evidence doc for these waves records the default-VPC caveat under "Honest scope
   notes" — the runs prove handler lifecycles, not IaP-managed networking.
3. M23.4 **retrofits** the M21.3 golden path onto IaP-managed `Network` resources and re-runs
   it, closing this pragmatism; the retrofit is an M23.4 exit criterion, so the debt cannot
   silently persist.

## Consequences

- Phases 21–22 proceed without waiting on spec work; the critical path
  (M21.1 → M21.3 → M22.1 → M23.1 → M23.3 → M24.1) holds.
- Until M23.4, live evidence for VPC-resident services carries a known caveat: network topology
  is account-provided, not plan-managed or drift-checked.
- The retrofit run at M23.4 doubles as the planner dependency-ordering verification on the
  6-resource network graph (VPC/Subnet/SecurityGroup/IGW/RouteTable/NatGateway).
- Accounts without a default VPC (deleted or opt-out regions) need a documented pre-flight
  check in the live-run runbook before M21.3.

## Alternatives considered

- **Block data-engine waves on `Network` graduation (M23.3/M23.4 first).** Rejected: inverts
  the critical path; spec gates must never block Class B waves (recorded roadmap decision).
- **Hand-rolled temporary VPC scripts outside IaP.** Rejected: unmanaged resources with drift
  and teardown risk — exactly what the evidence bar exists to prevent; sweeps could not
  distinguish scripted leftovers from orphans.
- **Graduate `Network` early via an out-of-order spec minor.** Rejected: rushes vocabulary that
  five other kinds' graduation experience (1.1.0) should inform first.

## References

- ROADMAP-V4.yml M21.3 (recorded decision), M23.4 (retrofit exit criterion); roadmap-v4 risk
  register item 2.
- docs/guides/live-run-runbook.md (pre-flight; honest scope notes template).
