/**
 * `iap drift` — read-only drift detection (Phase 19, M19.3). Builds the
 * `ProviderPlan` from the document + mapping, then runs the executor's
 * read-only `plan()` against live reads and reports every resource whose live
 * state diverges from desired (anything the executor classifies as other than
 * `no-op`). No `--confirm`, no mutation, no state write — issuing an apply from
 * here is structurally impossible.
 */

import type { PlanReport } from '@iap/deploy-aws';
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
import { executorFactory } from './execution.js';
import type { ExecutorEnv } from './execution.js';

export async function driftCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const json = stringFlag(args, 'output') === 'json';
  const quiet = booleanFlag(args, 'quiet');

  const loaded = await loadProviderPlan(args, io, 'drift');
  if (!loaded.ok) return loaded.code;

  const env: ExecutorEnv = {};
  const region = stringFlag(args, 'region');
  // `--aws-profile` (not `--profile`, which is the IaP merge-profile) selects creds.
  const profile = stringFlag(args, 'aws-profile');
  if (region !== undefined) env.region = region;
  if (profile !== undefined) env.profile = profile;

  let report: PlanReport;
  try {
    // Read-only: plan() never mutates. destroy:false compares live vs desired.
    report = await executorFactory()(env).plan(loaded.plan, { destroy: false });
  } catch (error) {
    io.stderr.write(`iap drift: drift detection failed: ${String(error)}\n`);
    return EXIT_OPERATION;
  }

  const drifted = report.items.filter((item) => item.action !== 'no-op');

  if (json) {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      planId: report.planId,
      region: report.region,
      inSync: drifted.length === 0,
      drift: drifted,
    });
  } else if (!quiet) {
    if (drifted.length === 0) {
      io.stdout.write(
        `Drift: none — live state matches desired (${report.items.length} checked)\n`,
      );
    } else {
      io.stdout.write(`Drift: ${drifted.length} resource(s) diverge from desired\n`);
      for (const item of drifted) {
        io.stdout.write(
          `  ${item.action} ${item.logicalId}  (${item.targetType}) — ${item.reason}\n`,
        );
      }
    }
  }

  return EXIT_OK;
}
