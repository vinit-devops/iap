/**
 * `iap policy` — evaluate the document's own `policies` array plus any
 * `--pack <name>` built-in packs from the `POLICY_PACKS` registry (ch. 7;
 * validation phase 5). Reports findings, the per-(policy, resource)
 * evaluation trace (JSON), and deterministic RFC 7386 autofix patches.
 */

import { POLICY_PACKS, evaluatePolicies } from '@iap/sdk';
import type { Policy } from '@iap/model';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  booleanFlag,
  hasErrors,
  listFlag,
  openWorkspace,
  severitySummary,
  stringFlag,
  writeFindings,
  writeJson,
} from '../shared.js';

export async function policyCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');
  const packNames = listFlag(args, 'pack');

  const packPolicies: Policy[] = [];
  for (const name of packNames) {
    const pack = POLICY_PACKS[name];
    if (pack === undefined) {
      io.stderr.write(
        `iap policy: unknown pack "${name}" — available packs: ${Object.keys(POLICY_PACKS).sort().join(', ')}\n`,
      );
      return EXIT_USAGE;
    }
    packPolicies.push(...pack);
  }

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap policy: ${opened.message}\n`);
    return opened.code;
  }
  const { ws } = opened;
  if (ws.document === undefined) {
    writeFindings(io.stderr, ws.findings);
    return EXIT_FINDINGS;
  }

  const model = ws.canonical().model;
  const result = evaluatePolicies({
    resources: model.resources,
    policies: [...model.policies, ...packPolicies],
  });
  const exit = hasErrors(result.findings) ? EXIT_FINDINGS : EXIT_OK;

  if (output === 'json') {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      ok: exit === EXIT_OK,
      packs: packNames,
      findings: result.findings,
      autofixes: result.autofixes,
      evaluations: result.evaluations,
    });
    return exit;
  }

  if (!quiet) {
    for (const finding of result.findings) {
      const policy = finding.policyId !== undefined ? `  [policy ${finding.policyId}]` : '';
      io.stdout.write(
        `${finding.code} ${finding.severity}  ${finding.path === '' ? '(document)' : finding.path}  ${finding.message}${policy}\n`,
      );
    }
    if (result.autofixes.length > 0) {
      io.stdout.write('autofixes (RFC 7386 merge patches):\n');
      for (const fix of result.autofixes) {
        io.stdout.write(`  ${fix.resourceId} ← ${fix.policyId}: ${JSON.stringify(fix.patch)}\n`);
      }
    }
    io.stdout.write(`${severitySummary(result.findings)}\n`);
  }
  return exit;
}
