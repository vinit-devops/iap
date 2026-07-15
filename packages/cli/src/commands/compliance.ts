/**
 * `iap compliance` — evaluate active framework bundles and emit the evidence
 * report (spec ch. 17; roadmap Phase 11, M11.2). A thin shell over
 * `@iap/compliance`: load + canonicalize (respecting `--profile`), evaluate the
 * document's `compliance.frameworks`, and render the per-control dispositions
 * (satisfied/violated/not-applicable) with IAP701/IAP702 findings. Output
 * distinguishes configuration coverage from formal certification — it is never
 * a certification claim. Exit 0 when clean; 1 on any error-severity finding.
 */
import { evaluateCompliance } from '@iap/compliance';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  booleanFlag,
  openWorkspace,
  stringFlag,
  writeJson,
} from '../shared.js';

const GLYPH: Record<string, string> = { satisfied: '✔', violated: '✖', 'not-applicable': '–' };

export async function complianceCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap compliance: ${opened.message}\n`);
    return opened.code;
  }
  if (opened.ws.document === undefined) {
    io.stderr.write('iap compliance: no parsable document\n');
    return EXIT_USAGE;
  }

  const report = evaluateCompliance(opened.ws.canonical().model);

  if (output === 'json') {
    writeJson(io.stdout, report);
  } else if (!quiet) {
    io.stdout.write(
      `Compliance report for "${report.document}"${report.profile ? ` (profile: ${report.profile})` : ''}\n`,
    );
    if (report.frameworks.length === 0) {
      io.stdout.write('  no frameworks declared in compliance.frameworks — nothing to evaluate\n');
    } else {
      io.stdout.write(
        `  frameworks: ${report.bundles.map((b) => `${b.framework}@${b.version}`).join(', ')}\n`,
      );
      io.stdout.write(
        `  controls: ${report.summary.satisfied} satisfied, ${report.summary.violated} violated, ${report.summary.notApplicable} not-applicable\n\n`,
      );
      for (const e of report.evidence) {
        io.stdout.write(
          `  ${GLYPH[e.disposition] ?? '?'} ${e.framework}/${e.control} ${e.title} — ${e.disposition}\n`,
        );
        if (e.disposition === 'violated' && e.remediation !== undefined) {
          io.stdout.write(
            `      resources: ${e.resources.join(', ')}\n      remediation: ${e.remediation}\n`,
          );
        }
        if (e.externalEvidence !== undefined)
          io.stdout.write(`      external evidence still needed: ${e.externalEvidence}\n`);
      }
      if (report.findings.length > 0) {
        io.stdout.write('\n  findings:\n');
        for (const f of report.findings)
          io.stdout.write(`    ${f.code} ${f.severity}  ${f.path}  ${f.message}\n`);
      }
    }
    io.stdout.write(`\n  ${report.disclaimer}\n`);
  }

  return report.findings.some((f) => f.severity === 'error') ? EXIT_FINDINGS : EXIT_OK;
}
