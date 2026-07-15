/**
 * `iap deploy` — realize a document against live AWS (Phase 19, M19.3).
 *
 * Fail-closed, live-gated pipeline:
 *  1. Load + canonicalize the document and apply the mapping to a
 *     `ProviderPlan` (shared with `iap plan`; the same CP-4 / §22.1 refusals).
 *  2. Construct the executor (real `AwsExecutor` in production; an injected
 *     fake under test) and compute the read-only plan — create/no-op/update.
 *  3. THE LIVE GATE: without `--confirm` this is a DRY RUN — the plan is
 *     printed, no mutating call is issued, and the command exits 0. Only
 *     `--confirm` opens `executor.apply({ apply: true })`, after which the
 *     outcome is persisted to the durable `FileStateBackend` and the exit code
 *     reflects any per-resource failure (0 clean, 3 on any failure).
 *
 * `iap destroy` reuses {@link runDeployment} with `destroy: true`.
 */

import type { ApplyReport, PlanReport } from '@iap/deploy-aws';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_OK,
  EXIT_OPERATION,
  JSON_FORMAT_VERSION,
  booleanFlag,
  stringFlag,
  writeJson,
} from '../shared.js';
import { loadProviderPlan } from './provider-plan.js';
import {
  DEFAULT_STATE_DIR,
  executorFactory,
  openStateBackend,
  persistOutcome,
  stateRefFor,
} from './execution.js';
import type { ExecutorEnv } from './execution.js';

const ACTION_GLYPH: Record<PlanReport['items'][number]['action'], string> = {
  create: '+',
  update: '~',
  delete: '-',
  'no-op': '=',
};

function renderPlan(io: CliIO, report: PlanReport): void {
  const counts = { create: 0, update: 0, delete: 0, 'no-op': 0 };
  for (const item of report.items) counts[item.action] += 1;
  io.stdout.write(
    `Plan (${report.mode}${report.destroy ? ', destroy' : ''}) in ${report.region}: ` +
      `${counts.create} to create, ${counts.update} to update, ${counts.delete} to delete, ` +
      `${counts['no-op']} unchanged\n`,
  );
  for (const item of report.items) {
    io.stdout.write(
      `  ${ACTION_GLYPH[item.action]} ${item.logicalId}  (${item.targetType}) — ${item.reason}\n`,
    );
  }
}

function renderApply(io: CliIO, report: ApplyReport): void {
  io.stdout.write(
    `Apply (${report.mode}) in ${report.region}: ` +
      `${report.items.filter((i) => i.applied).length} applied, ` +
      `${report.items.filter((i) => i.error !== undefined).length} failed\n`,
  );
  for (const item of report.items) {
    const status =
      item.error !== undefined ? `FAILED: ${item.error}` : item.applied ? 'ok' : 'skipped';
    const id = item.identifier === undefined ? '' : ` → ${item.identifier}`;
    io.stdout.write(`  ${item.action} ${item.logicalId}${id}  [${status}]\n`);
  }
  for (const error of report.errors) io.stdout.write(`  ! ${error}\n`);
}

/** Shared realize/teardown flow. `destroy` selects deploy vs destroy semantics. */
export async function runDeployment(
  args: ParsedArgs,
  io: CliIO,
  destroy: boolean,
): Promise<number> {
  const command = destroy ? 'destroy' : 'deploy';
  const json = stringFlag(args, 'output') === 'json';
  const quiet = booleanFlag(args, 'quiet');

  const loaded = await loadProviderPlan(args, io, command);
  if (!loaded.ok) return loaded.code;

  const env: ExecutorEnv = {};
  const region = stringFlag(args, 'region');
  // AWS credential profile uses its OWN flag: `--profile` is reserved for the
  // IaP merge-profile (ch. 6). `--aws-profile` selects the AWS credentials.
  const profile = stringFlag(args, 'aws-profile');
  if (region !== undefined) env.region = region;
  if (profile !== undefined) env.profile = profile;

  let executor;
  try {
    executor = executorFactory()(env);
  } catch (error) {
    io.stderr.write(`iap ${command}: cannot initialize executor: ${String(error)}\n`);
    return EXIT_OPERATION;
  }

  let planReport: PlanReport;
  try {
    planReport = await executor.plan(loaded.plan, { destroy });
  } catch (error) {
    io.stderr.write(`iap ${command}: planning failed: ${String(error)}\n`);
    return EXIT_OPERATION;
  }

  // THE LIVE GATE: mutate only when --confirm is present.
  if (!booleanFlag(args, 'confirm')) {
    if (json) {
      writeJson(io.stdout, {
        formatVersion: JSON_FORMAT_VERSION,
        command,
        dryRun: true,
        applied: false,
        plan: planReport,
      });
    } else if (!quiet) {
      renderPlan(io, planReport);
      io.stdout.write(`dry-run: no changes applied; re-run with --confirm to apply (${command})\n`);
    }
    return EXIT_OK;
  }

  const applyReport = await executor.apply(loaded.plan, { apply: true, destroy });

  const stateDir = stringFlag(args, 'state') ?? DEFAULT_STATE_DIR;
  const backend = openStateBackend(stateDir);
  const ref = stateRefFor(loaded.documentName, loaded.profile);
  const actor = stringFlag(args, 'actor') ?? 'iap-cli';
  const timestamp = stringFlag(args, 'timestamp') ?? new Date().toISOString();

  let revision: number;
  let integrity: string;
  try {
    const stateDoc = await persistOutcome(backend, ref, loaded.plan, applyReport, {
      destroy,
      actor,
      timestamp,
    });
    revision = stateDoc.revision;
    integrity = stateDoc.integrity;
  } catch (error) {
    io.stderr.write(`iap ${command}: failed to persist state: ${String(error)}\n`);
    return EXIT_OPERATION;
  }

  const failed =
    applyReport.errors.length > 0 || applyReport.items.some((i) => i.error !== undefined);

  if (json) {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      command,
      dryRun: false,
      applied: true,
      plan: planReport,
      apply: applyReport,
      state: { document: ref.document, profile: ref.profile, revision, integrity },
    });
  } else if (!quiet) {
    renderPlan(io, planReport);
    renderApply(io, applyReport);
    io.stdout.write(`state: ${ref.document}/${ref.profile ?? 'base'} @ revision ${revision}\n`);
  }

  return failed ? EXIT_OPERATION : EXIT_OK;
}

export function deployCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  return runDeployment(args, io, false);
}
