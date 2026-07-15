/**
 * Deployment-related and engine-gated commands stay disabled until their
 * phases are complete (roadmap Phase 5: "Deployment-related commands remain
 * disabled or experimental until their phases are complete"). Each stub
 * prints exactly one line to stderr and exits 2 — a stable, scriptable
 * contract that flips to a real implementation without changing the CLI's
 * surface. Notably, `deploy` being unavailable trivially satisfies the
 * "CLI never deploys before explicit approval" exit criterion.
 */

import type { CliIO } from '../shared.js';
import { EXIT_USAGE } from '../shared.js';

/** Command → the roadmap phase (id + title) whose engines it requires. */
export const STUB_COMMANDS: Readonly<Record<string, { phase: string; title: string }>> = {
  // `create` shipped in M5.3 (Phase 3 authoring engine). `edit` (incremental
  // authoring against an existing document) reuses the same engine and is the
  // next CLI step — kept gated until it lands with its own tests.
  edit: { phase: '3', title: 'Intent Authoring Engine and Intent Compiler' },
  provider: { phase: '6', title: 'Provider Mapping and Plugin Framework' },
  extension: { phase: '6', title: 'Provider Mapping and Plugin Framework' },
  // deploy, destroy, drift, state shipped in Phase 19 (M19.3) — see their
  // command modules. rollback stays gated until its verification engine lands.
  rollback: { phase: '14', title: 'Deployment, State, Verification and Drift' },
  import: { phase: '18', title: 'Ecosystem, Migration and Open Standardization' },
  export: { phase: '18', title: 'Ecosystem, Migration and Open Standardization' },
};

export function stubCommand(name: string, io: CliIO): number {
  const stub = STUB_COMMANDS[name] as { phase: string; title: string };
  io.stderr.write(
    `iap ${name}: not yet available — requires Phase ${stub.phase} (${stub.title}) engines; planned for a future release\n`,
  );
  return EXIT_USAGE;
}
