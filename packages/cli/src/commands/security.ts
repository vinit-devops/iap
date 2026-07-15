/**
 * `iap security` — derive and report the security posture (spec ch. 15; roadmap
 * Phase 11, M11.1). A thin shell over `@iap/security`: load + canonicalize the
 * document (respecting `--profile`), derive least-privilege grants, the
 * reachability graph, encryption posture, and the IAP6xx findings, and render.
 * Security is derived, never annotated — the command adds no analysis of its own.
 * Exit 0 when clean; 1 when any error-severity security finding is present.
 */
import { securityReport } from '@iap/security';
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

export async function securityCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap security: ${opened.message}\n`);
    return opened.code;
  }
  if (opened.ws.document === undefined) {
    io.stderr.write('iap security: no parsable document\n');
    return EXIT_USAGE;
  }

  const report = securityReport(opened.ws.canonical().model);

  if (output === 'json') {
    // The report already carries formatVersion: 1.
    writeJson(io.stdout, report);
  } else if (!quiet) {
    io.stdout.write(
      `Security report for "${report.document}"${report.profile ? ` (profile: ${report.profile})` : ''}\n`,
    );
    io.stdout.write(`  risk: ${report.risk}\n\n`);

    io.stdout.write('  least-privilege grants (derived from edges):\n');
    if (report.grants.length === 0) io.stdout.write('    (none)\n');
    for (const g of report.grants) {
      io.stdout.write(
        `    ${g.principal} -> ${g.target} (${g.targetKind}): ${g.access} via ${g.via}\n`,
      );
    }

    io.stdout.write('\n  reachability (zero-trust; anything undeclared is denied):\n');
    for (const r of report.reachability) {
      const from =
        r.acceptsFrom.length === 0
          ? 'nothing'
          : r.acceptsFrom.map((a) => a.source + (a.port ? `:${a.port}` : '')).join(', ');
      const ext = r.externallyReachable ? ` [${r.exposure}]` : '';
      io.stdout.write(`    ${r.target} (${r.kind})${ext}: accepts from ${from}\n`);
    }

    if (report.findings.length > 0) {
      io.stdout.write('\n  findings:\n');
      for (const f of report.findings) {
        io.stdout.write(`    ${f.code} ${f.severity}  ${f.path}  ${f.message}\n`);
      }
    } else {
      io.stdout.write('\n  findings: none\n');
    }
  }

  return report.findings.some((f) => f.severity === 'error') ? EXIT_FINDINGS : EXIT_OK;
}
