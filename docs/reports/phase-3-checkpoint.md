# Phase 3 Checkpoint — Resumption State (session ended near usage limit)

**Date:** 2026-07-11 · **Purpose:** the session concluded while the M3.5+M5.3 agent was
still in its reading phase (nothing written to disk). This records exactly where Phase 3
stands so the next session resumes without re-deriving anything. Delete this file when
Phase 3 + Phase 5 are signed off.

## Standing state

- **User directive:** roadmap execution is ACTIVE ("continue with next milestones",
  2026-07-11) — milestone-at-a-time, reviewable doc each, ROADMAP.yaml maintained,
  exit-criteria-gated, full `pnpm run verify` + `pnpm run format:check` green at each step.
- No git operations, ever, without an explicit user instruction.
- Completed phases: 0, 0.5, 1, 2, 4, 6, 7, 8, 9. Phase 7 signed off at
  `docs/reports/phase-7-completion.md`.

## Phase 3 status (design: `docs/architecture/phase-3-design.md`)

- **M3.1 COMPLETED + consolidated** — operation gate per IEP-0009
  (`docs/milestones/M3.1-compiler-operation-model.md`).
- **M3.2/M3.3/M3.4 COMPLETED + consolidated** — authoring engine
  (`docs/milestones/M3.2-M3.4-authoring-engine.md`): facet model, `extractRules`,
  `compileFacets`, `clarify`/`applyClarificationAnswers`, `recommend`/`acceptRecommendations`,
  `explainBatch`, `ModelAdapter` + `createAdapterSession` + `fixtureAdapter`/`rulesAdapter`,
  sha256-pinned prompt registry.
- **Verified state at checkpoint:** `pnpm run verify` exit 0 — 15 projects build, lint
  clean, **1022 passed + 5 skipped** unit tests (53 files), **63/63** spec harness,
  **45/45** provider conformance, **29/29** determinism; `format:check` clean.
  ROADMAP/CHANGELOG/compatibility-matrix all consolidated through M3.4.
- **M3.5 is `in-progress` in ROADMAP.yaml but NOT STARTED on disk** — no
  `tests/authoring/`, no `packages/cli/src/commands/create.ts`, no `test:authoring`
  script, no milestone doc exist yet. The launched agent died with the session before
  writing anything.

## To resume: relaunch ONE agent for M3.5 + M5.3

Brief essentials (full context in `docs/architecture/phase-3-design.md` decisions 11–12,
roadmap lines 1164–1209 and 1264–1343, ch. 22):

1. **Benchmark** `tests/authoring/`: fixture cases across all eleven roadmap §3.7
   categories; one NL case per official example (all nine; rules adapter where its
   vocabulary suffices, fixtureAdapter recordings elsewhere — both cross the same gate);
   expected outcomes as failing checks (kinds/relationships, clarification ids,
   unsupported findings, validity, pinned hashes where meaningful).
2. **Metric harness** `tests/authoring/run.mjs` (house style of tests/determinism/run.mjs,
   over built packages; root script `test:authoring` wired into `verify`): §3.7 metrics —
   extraction correctness, clarification precision, unsupported detection,
   false-assumption rate, validity, semantic equivalence (canonical-model comparison, not
   byte equality), double-run determinism. Model-independence at scale: ≥3 cases through
   both adapters ⇒ byte-identical documents.
3. **`iap create` (M5.3)** in packages/cli replacing its stub only: `--request`/
   `--request-file`, `--file` (edit mode), `--answers`, `--yes-defaults`,
   `--acknowledge-destructive`, `--accept-recommendations`, `--explain-only`, `--out`
   (+`--force`), `-o human|json` (`formatVersion: 1`); writes ONLY via gate
   `apply` → `CommittedBatch.serialize`; unanswered blocking clarifications ⇒ rendered
   questions + findings exit code; exit codes per ch. 22 (plan-command precedent);
   never guesses; CLI stays structurally unable to deploy.
4. **Milestone doc** `docs/milestones/M3.5-M5.3-evaluation-and-create.md` with the
   evidence table mapping ALL SIX Phase 3 exit criteria + Phase 5's remaining two
   ("Natural-language creation produces validated IaP", "CLI never deploys before
   explicit approval").
5. Constraints as always: no git, no new runtime deps, hermetic (no network), strict ajv,
   injected time/ids only, don't touch ROADMAP/CHANGELOG/matrix (orchestrator),
   intent-compiler behavior frozen (additive exports only; extend the OP-1 export pin
   additively), full verify + format green.

## After the agent completes (orchestrator)

1. Independent `pnpm run verify` + `pnpm run format:check`.
2. ROADMAP.yaml: M3.5 + M5.3 → completed with evidence; Phase 3 → completed;
   Phase 5 → completed.
3. CHANGELOG: benchmark + `iap create` entries; compatibility-matrix: CLI row
   (create unlocked), intent-compiler row (extended M3.5) if warranted.
4. Write `docs/reports/phase-3-completion.md` AND `docs/reports/phase-5-completion.md`
   (exit-criteria tables with evidence, spec gaps, deferrals — phase-7 report is the
   template). Candidate-IEP note carried from M3.2–M3.4: the closed twelve-operation
   vocabulary has no `outputs` operation (removal of an output-referenced resource
   correctly fails closed) — IEP-0009 v2 candidate; also ch. 7 doc note that `deny`
   fires when the rule condition HOLDS.
5. Next phase after 3+5: **Phase 10 — Cost Engine** (roadmap line 1656), then 11, 12, …, 18
   per the standing directive. Phase 10 wires real pricing into the planner's
   `deltas.cost` (identity 7 already pinned and hashed).
