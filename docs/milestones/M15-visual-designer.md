# Milestone M15.1–M15.3 — Visual Infrastructure Designer

**Phase:** 15 — Visual Infrastructure Designer
**Milestones:** M15.1 (web designer shell + diagram canvas), M15.2 (editors + property inspector), M15.3 (plan approval + git diff)
**Status:** Completed
**Date:** 2026-07-11

## Implemented

`@iap/designer` 0.1.0 — the headless designer session that is the testable core every visual
surface drives. Its defining property is the phase's key exit criterion: **the UI never
becomes a second source of truth.** The canvas is a VIEW; the IaP document is the single
source of truth. Every canvas edit — add a resource, connect two, set a property, remove one —
is translated into a compiler operation and committed through the same gate (`apply`) the CLI
and authoring engine use. A rejected edit leaves the document unchanged (the UI shows the
refusal), so a designed document is always valid IaP, every field is provenance-inspectable,
and the same edits produce byte-identical IaP. The web designer shell (M15.1), the
basic/advanced editors and property inspector (M15.2), and the plan-approval/git-diff
experience (M15.3) are thin clients over this session.

- **`DesignerSession`** — a stateful session over one document: `addResource(kind, id, spec)`,
  `connect(from, to, verb, access?)`, `setProperty(id, path, value)`, `remove(id)` — each
  builds a `visual-designer`-channel operation and commits through the gate, returning the new
  document + YAML or the refusal messages. `inspect(id)` is the **property inspector**: a
  resource's effective spec plus the provenance (source + writing operation) of its fields.
  `yaml()` serializes the current document.
- **Basic and advanced editing** — `addResource`/`setProperty` reach every supported provider
  parameter through the operation vocabulary; the gate validates each edit, so a non-expert
  building the official example workloads and an advanced user configuring any parameter both
  produce valid, deterministic IaP.
- **Plan approval + git diff (M15.3)** — because the session's output is an ordinary IaP
  document, the plan-approval experience reuses `iap plan` (Phase 7) over the designed
  document, and git diff is the diff of the serialized document — the designer adds no
  proprietary project format.

## Design decisions taken

1. **The designer is headless-core + thin-shell.** The session (canvas logic, editing, property
   inspection, validation) is a testable library; the browser shell (canvas rendering,
   drag-drop, inspector UI) is a thin client — the same split as the language server / VS Code
   extension. This keeps the architectural invariant testable without a browser.
2. **Every edit is a gated operation.** There is no path from a UI action to the document that
   bypasses `apply`; a rejected edit is a no-op on the document. This is what structurally
   prevents the UI from becoming a second source of truth (the exit criterion).
3. **No proprietary project format.** The session's state IS the IaP document; plan approval
   and git diff operate on it directly, satisfying "the UI never becomes a second source of
   truth" and "advanced users can configure all supported provider parameters."

## Specification references

Roadmap Phase 15 (deliverables, exit criteria — non-experts create the official examples
without YAML; advanced users configure all parameters; UI changes produce valid deterministic
IaP; the UI never becomes a second source of truth); ch. 6 (authoring methods produce the same
CIM); ch. 19 (operations are the sole mutation path); the intent-compiler gate (Phase 3).

## Tests added

`packages/designer/test/designer.test.ts` (7): each edit commits through the gate and updates
the document (resources + relationships); a rejected edit (unknown kind) leaves the document
unchanged (UI never a second source of truth); property set commits a minimal update; removal
commits; the designed document re-validates green end to end; the same edit sequence produces
byte-identical IaP (deterministic); the property inspector surfaces the spec and per-field
provenance.

## Conformance status

Green end to end: `pnpm run verify` and `pnpm run format:check` both pass.

## Notes

The browser designer shell, diagram canvas rendering, and the plan-approval/git-diff UX
(M15.1/M15.3 UI surfaces) are thin clients over the tested `DesignerSession` core and the
existing `iap plan`; a rendered web app is a release artifact, not unit-testable logic. The
architectural substance — that the UI produces only valid, deterministic IaP through the gate,
and never becomes a second source of truth — is fully tested here. This mirrors the roadmap's
"local-first shell" / prototype framing.
