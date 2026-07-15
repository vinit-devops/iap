/**
 * `iap doctor` — environment and document health report: the versions
 * actually loaded (CLI, SDK, architecture engine, Node, spec apiVersion,
 * error-code registry), then a full end-to-end run over the target document
 * (parse → validate phases 1–5 → canonicalize → waves). No timestamps are
 * emitted; the report is a pure function of the environment and the file.
 */

import { existsSync } from 'node:fs';
import type { Finding } from '@iap/model';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  DEFAULT_FILE,
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  booleanFlag,
  countBySeverity,
  openWorkspace,
  stringFlag,
  writeJson,
} from '../shared.js';
import { errorCodeRegistry } from '../registry.js';
import { cliVersion, dependencyVersion } from '../version.js';

/** The specification major this CLI implements (documents pin the major only, ch. 10). */
const SPEC_API_VERSION = 'iap.dev/v1';

export async function doctorCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');
  const explicitFile = stringFlag(args, 'file');
  const file = explicitFile ?? DEFAULT_FILE;

  const versions = {
    cli: cliVersion(),
    sdk: dependencyVersion('@iap/sdk'),
    architecture: dependencyVersion('@iap/architecture'),
    node: process.versions.node,
    specApiVersion: SPEC_API_VERSION,
    errorRegistry: errorCodeRegistry().version,
  };

  interface DocumentReport {
    file: string;
    present: boolean;
    ok?: boolean;
    errors?: number;
    warnings?: number;
    hash?: string;
    resources?: number;
    edges?: number;
    waves?: number;
  }
  const document: DocumentReport = { file, present: existsSync(file) };
  let exit = EXIT_OK;

  if (document.present) {
    const opened = await openWorkspace(args);
    if (!opened.ok) {
      io.stderr.write(`iap doctor: ${opened.message}\n`);
      return opened.code;
    }
    const { ws } = opened;
    const findings: Finding[] = [...ws.validate().findings];
    if (ws.document !== undefined) {
      findings.push(...ws.policies().findings);
      const canon = ws.canonical();
      document.hash = canon.hash;
      document.resources = Object.keys(canon.model.resources).length;
      document.edges = canon.model.edges.length;
      document.waves = ws.waves().length;
    }
    const { errors, warnings } = countBySeverity(findings);
    document.errors = errors;
    document.warnings = warnings;
    document.ok = errors === 0;
    if (errors > 0) exit = EXIT_FINDINGS;
  } else if (explicitFile !== undefined) {
    // An explicitly named file that does not exist is a usage error (§22.1);
    // absence of the default file is an environment fact doctor just reports.
    exit = EXIT_USAGE;
  }

  if (output === 'json') {
    writeJson(io.stdout, { formatVersion: JSON_FORMAT_VERSION, versions, document });
    return exit;
  }

  if (!quiet) {
    io.stdout.write('versions:\n');
    io.stdout.write(`  @iap/cli           ${versions.cli}\n`);
    io.stdout.write(`  @iap/sdk           ${versions.sdk}\n`);
    io.stdout.write(`  @iap/architecture  ${versions.architecture}\n`);
    io.stdout.write(`  node               ${versions.node}\n`);
    io.stdout.write(`  spec apiVersion    ${versions.specApiVersion}\n`);
    io.stdout.write(`  error registry     ${versions.errorRegistry}\n`);
    io.stdout.write(`\ndocument: ${file}\n`);
    if (!document.present) {
      io.stdout.write('  not found\n');
    } else {
      io.stdout.write(
        `  validate (phases 1–5): ${document.errors ?? 0} errors, ${document.warnings ?? 0} warnings\n`,
      );
      if (document.hash !== undefined) {
        io.stdout.write(`  canonical hash: ${document.hash}\n`);
        io.stdout.write(
          `  resources: ${document.resources} · edges: ${document.edges} · waves: ${document.waves}\n`,
        );
      }
    }
  }
  return exit;
}
