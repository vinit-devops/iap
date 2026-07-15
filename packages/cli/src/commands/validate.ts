/**
 * `iap validate` — the full executable validation pipeline, phases 1–5
 * (ch. 8 via ch. 22 §22.2.1): schema → reference → relationship →
 * dependency (SDK `validate()`) plus policy (SDK `policies()`, IAP5xx).
 * Phases 6–8 (security, compliance, version) arrive with their engines
 * (roadmap Phases 11+) and are reported as pending in `iap help`.
 */

import type { Finding } from '@iap/model';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  JSON_FORMAT_VERSION,
  booleanFlag,
  countBySeverity,
  formatFindingBlock,
  hasErrors,
  openWorkspace,
  severitySummary,
  stringFlag,
  writeJson,
} from '../shared.js';
import { toSarif } from '../sarif.js';
import { cliVersion } from '../version.js';

const PHASE_ORDER = ['schema', 'reference', 'relationship', 'dependency', 'policy'] as const;
type CliPhase = (typeof PHASE_ORDER)[number];

interface PhaseReportOut {
  findings: Finding[];
  skipped: boolean;
}

export async function validateCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const strict = booleanFlag(args, 'strict');
  const quiet = booleanFlag(args, 'quiet');

  const opened = await openWorkspace(args, { sourceMap: output === 'sarif' });
  if (!opened.ok) {
    io.stderr.write(`iap validate: ${opened.message}\n`);
    return opened.code;
  }
  const { ws, file } = opened;

  // Phases 1–4 from the validator; phase 5 (policy) from the policy engine.
  // Policy evaluation needs a parsed document (it runs over the canonical
  // model); when parsing failed entirely the phase is reported as skipped.
  const validation = ws.validate();
  const phases: Record<CliPhase, PhaseReportOut> = {
    schema: validation.phases.schema,
    reference: validation.phases.reference,
    relationship: validation.phases.relationship,
    dependency: validation.phases.dependency,
    policy: { findings: [], skipped: true },
  };
  if (ws.document !== undefined) {
    phases.policy = { findings: ws.policies().findings, skipped: false };
  }

  const findings: Finding[] = PHASE_ORDER.flatMap((phase) => phases[phase].findings);
  const { errors, warnings } = countBySeverity(findings);
  const ok = errors === 0 && (!strict || warnings === 0);
  const exit = ok ? EXIT_OK : EXIT_FINDINGS;

  if (output === 'json') {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      ok,
      findings,
      phases,
    });
    return exit;
  }

  if (output === 'sarif') {
    const sarifOptions: Parameters<typeof toSarif>[1] = { file, toolVersion: cliVersion() };
    if (ws.sourceMap !== undefined) sarifOptions.sourceMap = ws.sourceMap;
    writeJson(io.stdout, toSarif(findings, sarifOptions));
    return exit;
  }

  if (!quiet) {
    for (const phase of PHASE_ORDER) {
      const report = phases[phase];
      io.stdout.write(phaseLine(phase, report) + '\n');
      for (const finding of report.findings) {
        io.stdout.write(formatFindingBlock(finding) + '\n');
      }
    }
    io.stdout.write(`${severitySummary(findings)}\n`);
  }
  return exit;
}

function phaseLine(phase: CliPhase, report: PhaseReportOut): string {
  const name = phase.padEnd(13);
  if (report.skipped) return `– ${name} skipped (earlier phase errors)`;
  const count = report.findings.length;
  const noun = `${count} finding${count === 1 ? '' : 's'}`;
  if (count === 0) return `✔ ${name} ${noun}`;
  return `${hasErrors(report.findings) ? '✖' : '⚠'} ${name} ${noun}`;
}
