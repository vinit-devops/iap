/**
 * `iap plan` — the deterministic planner behind the CLI (ch. 22 §22.2.2;
 * roadmap Phase 7, design decision 9). A thin shell over the pure pipeline:
 * load + canonicalize the document (`@iap/sdk`), apply the mapping
 * (`@iap/provider-sdk` — a verified provider package directory or a bare
 * `*.iap-map.yaml` artifact), and plan against the state snapshot
 * (`@iap/planner`; `emptySnapshot()` when `--state` is omitted, so
 * everything plans as create).
 *
 * Fail-closed contract:
 *  - `--profile` is REQUIRED whenever the document declares profiles — an
 *    ambiguous merge is never guessed (§22.1; exit 2).
 *  - A document with any error-severity validation or policy finding is
 *    refused before planning (CP-4; ch. 19 §19.6 deny gate; exit 1).
 *  - Mapping diagnostics (anything outside the coverage matrix) print in
 *    full and exit 1 — never a partial plan.
 *  - An unusable `--mapping` argument (unreadable, unverifiable package,
 *    schema-invalid or non-tiling artifact) is a usage error (exit 2);
 *    planner input refusals (e.g. a corrupt state snapshot) are operation
 *    failures (exit 3).
 *
 * The command produces artifacts only: it imports no execution machinery,
 * and `iap deploy` remains phase-gated — the CLI stays structurally unable
 * to execute anything.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { canonicalJsonStringify } from '@iap/model';
import type { Finding } from '@iap/model';
import { applyMapping } from '@iap/provider-sdk';
import { emptySnapshot, plan, sha256Digest } from '@iap/planner';
import type { PlanActionEntry, PlanArtifact, PlanContent, StateSnapshot } from '@iap/planner';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  booleanFlag,
  openWorkspace,
  stringFlag,
  writeFindings,
  writeJson,
} from '../shared.js';
import { resolveMapping, writeDiagnostics } from './provider-plan.js';

const ACTION_GLYPHS: Record<PlanActionEntry['action'], string> = {
  create: '+',
  'update-in-place': '~',
  replace: '!',
  delete: '-',
  import: '>',
};

function readStateSnapshot(path: string): StateSnapshot {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as StateSnapshot;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.revision !== 'number' ||
    typeof parsed.integrity !== 'string' ||
    typeof parsed.objects !== 'object' ||
    parsed.objects === null
  ) {
    throw new Error(
      `state snapshot "${path}" must be { revision, integrity, objects } (IEP-0010 subset)`,
    );
  }
  return parsed;
}

function countByAction(content: PlanContent): Record<PlanActionEntry['action'], number> {
  const counts = { create: 0, 'update-in-place': 0, replace: 0, delete: 0, import: 0 };
  for (const entry of content.waves.flat()) counts[entry.action] += 1;
  return counts;
}

/** Human rendering: waves, provenance (why), destructive/risk/rollback summary. */
function renderHuman(io: CliIO, artifact: PlanArtifact, outPath: string | undefined): void {
  const content = artifact.content;
  const counts = countByAction(content);
  io.stdout.write(
    `Plan: ${counts.create} to create, ${counts['update-in-place']} to update-in-place, ` +
      `${counts.replace} to replace, ${counts.delete} to delete, ${counts.import} to import\n`,
  );
  content.waves.forEach((wave, index) => {
    io.stdout.write(`  wave ${index + 1}\n`);
    for (const entry of wave) {
      const marks: string[] = [entry.action, entry.reversibility];
      if (entry.destructive) marks.push('destructive');
      io.stdout.write(
        `    ${ACTION_GLYPHS[entry.action]} ${entry.resource}  (${marks.join(', ')})\n`,
      );
      // Why each field has its value: the mapping-level source recorded in
      // the provider plan's provenance; changedBy names the identity that
      // caused the action (why the resource is scheduled at all).
      io.stdout.write(`        changedBy ${entry.provenance.changedBy}\n`);
      for (const field of entry.fields) {
        io.stdout.write(`        ${field} ← ${entry.provenance.fieldSources[field] ?? 'state'}\n`);
      }
    }
  });

  if (content.destructiveActions.length === 0) {
    io.stdout.write('Destructive: none\n');
  } else {
    io.stdout.write('Destructive:\n');
    for (const action of content.destructiveActions) {
      io.stdout.write(`  ${action.resource}  ${action.action} (${action.reversibility})\n`);
    }
  }

  const outputBindings = content.unknownValues.filter((v) => v.reason === 'output-binding').length;
  const sensitive = content.unknownValues.length - outputBindings;
  io.stdout.write(
    `Unknown at apply time: ${content.unknownValues.length} attribute(s) (output-binding ${outputBindings}, sensitive ${sensitive})\n`,
  );

  const factors = content.risk.factors
    .map((factor) => `${factor.id}×${factor.resources.length} (${factor.weight})`)
    .join(', ');
  io.stdout.write(
    `Risk: ${content.risk.class} (score ${content.risk.score})${factors ? ` — ${factors}` : ''}\n`,
  );

  const cost = content.deltas.cost;
  io.stdout.write(
    `Deltas: cost ${cost.status} (${cost.reason}) · security ${content.deltas.security.length} change(s) · compliance deferred (${content.deltas.compliance.deferred})\n`,
  );
  for (const delta of content.deltas.security) {
    io.stdout.write(`  security  ${delta.resource}  ${delta.field} ← ${delta.source}\n`);
  }

  if (content.rollback.limitations.length === 0) {
    io.stdout.write(`Rollback: ${content.rollback.strategy}; limitations: none\n`);
  } else {
    io.stdout.write(`Rollback: ${content.rollback.strategy}; limitations:\n`);
    for (const limitation of content.rollback.limitations) {
      io.stdout.write(`  ${limitation.resource}  ${limitation.reason}\n`);
    }
  }

  if (content.approvalsRequired.length === 0) {
    io.stdout.write('Approvals required: none\n');
  } else {
    io.stdout.write('Approvals required:\n');
    for (const approval of content.approvalsRequired) {
      io.stdout.write(`  ${approval.resource}  ${approval.gate}\n`);
    }
  }

  io.stdout.write(`planId: ${artifact.planId}${outPath !== undefined ? ` → ${outPath}` : ''}\n`);
}

export async function planCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');
  const mappingPath = stringFlag(args, 'mapping');
  if (mappingPath === undefined) {
    io.stderr.write(
      'iap plan: --mapping <provider-package-dir | artifact.iap-map.yaml> is required\n',
    );
    return EXIT_USAGE;
  }

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap plan: ${opened.message}\n`);
    return opened.code;
  }
  const { ws, profile } = opened;

  // §22.1: --profile is REQUIRED whenever the document declares profiles.
  const declaredProfiles = Object.keys(
    (ws.document as { profiles?: Record<string, unknown> } | undefined)?.profiles ?? {},
  );
  if (profile === null && declaredProfiles.length > 0) {
    io.stderr.write(
      `iap plan: the document declares profiles (${declaredProfiles.sort().join(', ')}) — --profile is required; an ambiguous merge is never guessed (ch. 22 §22.1)\n`,
    );
    return EXIT_USAGE;
  }

  // CP-4: refuse to plan a document that is not conforming (validation
  // phases 1–4 plus deny-gating policy findings, ch. 19 §19.6).
  const validation = ws.validate();
  const findings: Finding[] = [...validation.findings];
  if (ws.document !== undefined) findings.push(...ws.policies().findings);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (ws.document === undefined || errors.length > 0) {
    io.stderr.write('iap plan: refusing to plan a non-conforming document (CP-4):\n');
    writeFindings(io.stderr, errors.length > 0 ? errors : findings);
    return EXIT_FINDINGS;
  }

  const canonical = ws.canonical();
  const canonicalErrors = canonical.findings.filter((finding) => finding.severity === 'error');
  if (canonicalErrors.length > 0) {
    io.stderr.write('iap plan: canonicalization failed:\n');
    writeFindings(io.stderr, canonicalErrors);
    return EXIT_FINDINGS;
  }

  const mapping = resolveMapping(mappingPath, stringFlag(args, 'keys'));
  if (!mapping.ok) {
    io.stderr.write(`iap plan: ${mapping.message}\n`);
    return EXIT_USAGE;
  }

  const mapped = applyMapping(canonical.model, mapping.artifact);
  if (!mapped.ok) {
    if (output === 'json') {
      writeJson(io.stdout, { ok: false, diagnostics: mapped.diagnostics });
    }
    writeDiagnostics(io, mapped.diagnostics);
    return EXIT_FINDINGS;
  }

  const statePath = stringFlag(args, 'state');
  const state = statePath !== undefined ? readStateSnapshot(statePath) : emptySnapshot();

  // Identity 2: hash of each merged profile definition, from the authored
  // document — the same formula the golden-plan suite pins.
  const profileHashes =
    profile === null
      ? {}
      : {
          [profile]: sha256Digest(
            canonicalJsonStringify(
              (ws.document as unknown as { profiles: Record<string, unknown> }).profiles[profile],
            ),
          ),
        };

  const artifact = plan(mapped.plan, state, { profileHashes });

  const outPath = stringFlag(args, 'out');
  if (outPath !== undefined) {
    // Machine artifacts are canonical-form serializations (§22.1): exact
    // canonical bytes for JSON, a YAML projection of the same content
    // otherwise.
    writeFileSync(
      outPath,
      outPath.endsWith('.yaml') || outPath.endsWith('.yml')
        ? stringify(artifact, { aliasDuplicateObjects: false })
        : canonicalJsonStringify(artifact),
    );
  }

  if (output === 'json') {
    // §22.1: json emits the underlying artifact verbatim (it carries its own
    // apiVersion instead of the CLI formatVersion wrapper).
    writeJson(io.stdout, artifact);
  } else if (!quiet) {
    renderHuman(io, artifact, outPath);
  }
  return EXIT_OK;
}
