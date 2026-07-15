/**
 * `iap cost` — cost estimation and budget validation (spec ch. 16; roadmap
 * Phase 10, M10.2). A thin shell over `@iap/cost`: load + canonicalize the
 * document (respecting `--profile`), price it with the reference cost model
 * against a price snapshot (`--snapshot` or the bundled reference), evaluate the
 * document's budget policies at plan time (IAP505), and render the report.
 *
 * Cost is an annotation layer, never content: nothing is written back to the
 * document. Exit 0 when clean; 1 when a `deny` budget is exceeded (IAP505 error)
 * or the document itself has error-severity findings.
 */
import {
  diffReports,
  estimateCost,
  evaluateBudgets,
  loadSnapshot,
  referenceCostModel,
  referenceSnapshot,
} from '@iap/cost';
import type { CostReport, PriceSnapshot } from '@iap/cost';
import type { Finding } from '@iap/model';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  booleanFlag,
  hasErrors,
  openWorkspace,
  stringFlag,
  writeJson,
} from '../shared.js';

function resolveSnapshot(path: string | undefined): PriceSnapshot {
  return path === undefined ? referenceSnapshot() : loadSnapshot(path);
}

function renderHuman(io: CliIO, report: CostReport, budgets: Finding[]): void {
  io.stdout.write(
    `Cost report for "${report.document}"${report.profile ? ` (profile: ${report.profile})` : ''}\n`,
  );
  io.stdout.write(`  cost model: ${report.costModel}   snapshot: ${report.priceSnapshot}\n`);
  io.stdout.write(`  currency:   ${report.currency}\n\n`);

  const ids = Object.keys(report.resources).sort();
  const width = Math.max(8, ...ids.map((id) => id.length));
  for (const id of ids) {
    const r = report.resources[id];
    if (r === undefined) continue;
    const monthly = r.estimatedMonthly === undefined ? '—' : r.estimatedMonthly.toFixed(2);
    io.stdout.write(
      `  ${id.padEnd(width)}  ${r.kind.padEnd(11)}  ${r.confidence.padEnd(8)}  ${monthly.padStart(10)}/mo\n`,
    );
  }

  const t = report.totals;
  io.stdout.write(
    `\n  TOTAL${' '.repeat(width - 3)}  ${''.padEnd(11)}  ${t.confidence.padEnd(8)}  ${t.estimatedMonthly.toFixed(2).padStart(10)}/mo${t.lowerBound ? '  (lower bound — includes unpriced resources)' : ''}\n`,
  );

  const apps = Object.keys(report.rollups.byApplication);
  if (apps.length > 0) {
    io.stdout.write('\n  by application:\n');
    for (const app of apps.sort()) {
      const r = report.rollups.byApplication[app];
      if (r === undefined) continue;
      io.stdout.write(
        `    ${app}: ${r.estimatedMonthly.toFixed(2)}/mo${r.lowerBound ? ' (lower bound)' : ''}\n`,
      );
    }
  }

  if (report.suggestions.length > 0) {
    io.stdout.write('\n  suggestions:\n');
    for (const s of report.suggestions) {
      io.stdout.write(
        `    [${s.rule}] ${s.resource}: save ~${s.estimatedMonthlySavings.toFixed(2)}/mo — ${s.detail}\n`,
      );
    }
  }

  if (budgets.length > 0) {
    io.stdout.write('\n  budgets:\n');
    for (const f of budgets) {
      io.stdout.write(`    ${f.code} ${f.severity}  ${f.path}  ${f.message}\n`);
    }
  }
}

export async function costCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap cost: ${opened.message}\n`);
    return opened.code;
  }
  const { ws } = opened;
  if (ws.document === undefined) {
    io.stderr.write('iap cost: no parsable document\n');
    return EXIT_USAGE;
  }

  let snapshot: PriceSnapshot;
  try {
    snapshot = resolveSnapshot(stringFlag(args, 'snapshot'));
  } catch (error) {
    io.stderr.write(`iap cost: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  }

  const model = ws.canonical().model;
  const report = estimateCost(model, { costModel: referenceCostModel(), snapshot });
  const budgets = evaluateBudgets(model, report);

  // Optional cost diff against a second document (--against <path>).
  const againstPath = stringFlag(args, 'against');
  let diff: ReturnType<typeof diffReports> | undefined;
  if (againstPath !== undefined) {
    const other = await openWorkspace({
      ...args,
      flags: new Map(args.flags).set('file', againstPath),
    });
    if (!other.ok || other.ws.document === undefined) {
      io.stderr.write(`iap cost: cannot read --against document ${againstPath}\n`);
      return EXIT_USAGE;
    }
    const otherReport = estimateCost(other.ws.canonical().model, {
      costModel: referenceCostModel(),
      snapshot,
    });
    diff = diffReports(otherReport, report);
  }

  const docErrors = ws.validate().findings.filter((f) => f.severity === 'error');
  const budgetErrors = budgets.filter((f) => f.severity === 'error');

  if (output === 'json') {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      report,
      budgets,
      ...(diff === undefined ? {} : { diff }),
    });
  } else if (!quiet) {
    renderHuman(io, report, budgets);
    if (diff !== undefined) {
      io.stdout.write(
        `\n  cost diff vs ${againstPath}: total ${diff.totalBefore.toFixed(2)} -> ${diff.totalAfter.toFixed(2)} (${diff.totalDelta >= 0 ? '+' : ''}${diff.totalDelta.toFixed(2)})/mo\n`,
      );
    }
  }

  return budgetErrors.length > 0 || hasErrors(docErrors) ? EXIT_FINDINGS : EXIT_OK;
}
