#!/usr/bin/env node
/**
 * `iap` — the reference CLI (spec ch. 22; roadmap Phase 5). A thin shell
 * over `@iap/sdk` and `@iap/architecture`: every command invokes SDK
 * components and formats their artifacts; the CLI adds no semantics of its
 * own.
 *
 * Global conventions (§22.1): default input `infrastructure.iap.yaml`
 * (`--file` overrides); `--profile` selects the merged view (inspecting
 * commands default to the unmerged base document); `--output human|json`
 * (+`sarif` for validate, `dot` for graph); exit codes 0 success / 1
 * error-severity findings / 2 usage error / 3 operation failure. Machine
 * outputs are deterministic (no timestamps, stable ordering) and every JSON
 * payload carries `formatVersion: 1`.
 *
 * `run(argv, io)` is the whole CLI as a pure-ish async function over
 * injected writers — the bin shim below and the test suite call the same
 * entry point, so everything observable in CI is covered in-process.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { CliIO, FlagSpec, ParsedArgs } from './shared.js';
import {
  COMMON_FLAGS,
  EXIT_OK,
  EXIT_OPERATION,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  parseFlags,
  stringFlag,
  writeJson,
} from './shared.js';
import { validateCommand } from './commands/validate.js';
import { createCommand } from './commands/create.js';
import { costCommand } from './commands/cost.js';
import { securityCommand } from './commands/security.js';
import { complianceCommand } from './commands/compliance.js';
import { planCommand } from './commands/plan.js';
import { graphCommand } from './commands/graph.js';
import { VIEWS, diagramCommand } from './commands/diagram.js';
import { policyCommand } from './commands/policy.js';
import { fmtCommand, normalizeCommand } from './commands/normalize.js';
import { explainCommand } from './commands/explain.js';
import { diffCommand } from './commands/diff.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { deployCommand } from './commands/deploy.js';
import { destroyCommand } from './commands/destroy.js';
import { driftCommand } from './commands/drift.js';
import { stateCommand } from './commands/state.js';
import { STUB_COMMANDS, stubCommand } from './commands/stubs.js';
import { cliVersion } from './version.js';

export type { CliIO, CliWriter } from './shared.js';

interface CommandDef {
  name: string;
  aliases?: string[];
  summary: string;
  flags: FlagSpec[];
  handler: (args: ParsedArgs, io: CliIO) => Promise<number> | number;
}

const output = (values: readonly string[]): FlagSpec => ({
  name: 'output',
  alias: 'o',
  takesValue: true,
  values,
});

const COMMANDS: CommandDef[] = [
  {
    name: 'create',
    summary: 'Author IaP from a natural-language requirement (compiler + clarifications + preview)',
    flags: [
      { name: 'profile', takesValue: true },
      { name: 'quiet', alias: 'q', takesValue: false },
      { name: 'no-color', takesValue: false },
      output(['human', 'json']),
      { name: 'request', takesValue: true },
      { name: 'out', takesValue: true },
      { name: 'name', takesValue: true },
      { name: 'answers', takesValue: true },
      { name: 'yes-defaults', takesValue: false },
      { name: 'acknowledge-destructive', takesValue: false },
      { name: 'force', takesValue: false },
      { name: 'stdout', takesValue: false },
      { name: 'timestamp', takesValue: true },
      { name: 'actor', takesValue: true },
    ],
    handler: createCommand,
  },
  {
    name: 'validate',
    summary: 'Run validation phases 1–5 (schema, reference, relationship, dependency, policy)',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'json', 'sarif']),
      { name: 'strict', takesValue: false },
    ],
    handler: validateCommand,
  },
  {
    name: 'plan',
    summary: 'Produce a deterministic plan.iap.dev/v1 artifact from a mapping (never executes)',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'json']),
      { name: 'mapping', takesValue: true },
      { name: 'state', takesValue: true },
      { name: 'keys', takesValue: true },
      { name: 'out', takesValue: true },
    ],
    handler: planCommand,
  },
  {
    name: 'cost',
    summary: 'Estimate cost and validate budgets (ch. 16; reference cost model + price snapshot)',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'json']),
      { name: 'snapshot', takesValue: true },
      { name: 'against', takesValue: true },
    ],
    handler: costCommand,
  },
  {
    name: 'security',
    summary:
      'Derive the security posture: grants, reachability, encryption, IAP6xx findings (ch. 15)',
    flags: [...COMMON_FLAGS, output(['human', 'json'])],
    handler: securityCommand,
  },
  {
    name: 'compliance',
    summary: 'Evaluate framework bundles and emit the evidence report (ch. 17; IAP701/702)',
    flags: [...COMMON_FLAGS, output(['human', 'json'])],
    handler: complianceCommand,
  },
  {
    name: 'graph',
    summary: 'Print the normalized canonical edge set and execution waves',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'text', 'json', 'dot']),
      { name: 'format', takesValue: true, values: ['human', 'text', 'json', 'dot'] },
    ],
    handler: graphCommand,
  },
  {
    name: 'diagram',
    summary: 'Render a derived architecture view (ch. 18) as Mermaid, DOT, or JSON',
    flags: [
      ...COMMON_FLAGS,
      { name: 'view', takesValue: true, values: VIEWS },
      { name: 'application', takesValue: true },
      { name: 'format', takesValue: true, values: ['mermaid', 'dot', 'json'] },
      output(['mermaid', 'dot', 'json']),
    ],
    handler: diagramCommand,
  },
  {
    name: 'policy',
    summary: 'Evaluate document policies plus built-in packs (--pack, repeatable)',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'json']),
      { name: 'pack', takesValue: true, repeatable: true },
    ],
    handler: policyCommand,
  },
  {
    name: 'normalize',
    summary: 'Print the canonical form (C5+C6 byte projection; -o json adds the hash)',
    flags: [...COMMON_FLAGS, output(['human', 'json'])],
    handler: normalizeCommand,
  },
  {
    name: 'fmt',
    aliases: ['format'],
    summary: 'Round-trip re-serialize the document as YAML (stdout, or --write in place)',
    flags: [...COMMON_FLAGS, { name: 'write', takesValue: false }],
    handler: fmtCommand,
  },
  {
    name: 'explain',
    summary: 'Explain one resource: effective values with provenance, edges, wave position',
    flags: [...COMMON_FLAGS, output(['human', 'json'])],
    handler: explainCommand,
  },
  {
    name: 'diff',
    summary: 'Semantic diff of two canonical models (--profile for base, --profile-b for other)',
    flags: [...COMMON_FLAGS, output(['human', 'json']), { name: 'profile-b', takesValue: true }],
    handler: diffCommand,
  },
  {
    name: 'doctor',
    summary: 'Report toolchain versions and validate the target document end to end',
    flags: [...COMMON_FLAGS, output(['human', 'json'])],
    handler: doctorCommand,
  },
  {
    name: 'init',
    summary: 'Write a starter infrastructure.iap.yaml (refuses to overwrite without --force)',
    flags: [...COMMON_FLAGS, { name: 'force', takesValue: false }],
    handler: initCommand,
  },
  {
    name: 'deploy',
    summary:
      'Realize a document against live AWS — dry-run by default; --confirm opens the live gate',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'json']),
      { name: 'mapping', takesValue: true },
      { name: 'keys', takesValue: true },
      { name: 'state', takesValue: true },
      { name: 'region', takesValue: true },
      { name: 'aws-profile', takesValue: true },
      { name: 'confirm', takesValue: false },
      { name: 'confirm-replace', takesValue: false },
      { name: 'actor', takesValue: true },
      { name: 'timestamp', takesValue: true },
    ],
    handler: deployCommand,
  },
  {
    name: 'destroy',
    summary: 'Tear down a document’s managed resources (--confirm gated; managed-only)',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'json']),
      { name: 'mapping', takesValue: true },
      { name: 'keys', takesValue: true },
      { name: 'state', takesValue: true },
      { name: 'region', takesValue: true },
      { name: 'aws-profile', takesValue: true },
      { name: 'confirm', takesValue: false },
      { name: 'actor', takesValue: true },
      { name: 'timestamp', takesValue: true },
    ],
    handler: destroyCommand,
  },
  {
    name: 'drift',
    summary: 'Report drift between desired and live state (read-only; no --confirm)',
    flags: [
      ...COMMON_FLAGS,
      output(['human', 'json']),
      { name: 'mapping', takesValue: true },
      { name: 'keys', takesValue: true },
      { name: 'region', takesValue: true },
      { name: 'aws-profile', takesValue: true },
    ],
    handler: driftCommand,
  },
  {
    name: 'state',
    summary: 'Show the persisted state snapshot for this document/profile (read-only)',
    flags: [...COMMON_FLAGS, output(['human', 'json']), { name: 'state', takesValue: true }],
    handler: stateCommand,
  },
  {
    name: 'version',
    summary: 'Print the CLI version',
    flags: [output(['human', 'json'])],
    handler: (args, io): number => {
      if (stringFlag(args, 'output') === 'json') {
        writeJson(io.stdout, {
          formatVersion: JSON_FORMAT_VERSION,
          name: '@iap/cli',
          version: cliVersion(),
        });
      } else {
        io.stdout.write(`iap ${cliVersion()}\n`);
      }
      return EXIT_OK;
    },
  },
  {
    name: 'help',
    summary: 'Show usage',
    flags: [],
    handler: (_args, io): number => {
      io.stdout.write(usage());
      return EXIT_OK;
    },
  },
];

function usage(): string {
  const implemented = COMMANDS.map((command) => {
    const names = [command.name, ...(command.aliases ?? [])].join(' | ');
    return `  ${names.padEnd(16)} ${command.summary}`;
  }).join('\n');
  const stubs = Object.keys(STUB_COMMANDS).join(' ');
  return `iap — Infrastructure as Prompt reference CLI (spec ch. 22)

Usage: iap <command> [flags]

Commands:
${implemented}

Not yet available (each exits 2 with the roadmap phase that unlocks it):
  ${stubs}

Global flags:
  -f, --file <path>      Input document (default: infrastructure.iap.yaml)
      --profile <name>   Active profile (inspecting commands default to the base document)
  -o, --output <format>  human | json (validate adds sarif; graph adds dot;
                         diagram takes mermaid | dot | json)
  -q, --quiet            Suppress human output (machine output and exit codes only)
      --no-color         Accepted for CI compatibility (output is never colored)

Exit codes: 0 success · 1 error-severity findings · 2 usage error · 3 operation failure
`;
}

/**
 * Execute one CLI invocation. `argv` excludes the node/script prefix
 * (i.e. pass `process.argv.slice(2)`); all output goes to the injected
 * writers. Resolves to the process exit code — never throws.
 */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === '--help' || name === '-h') {
    // Bare `iap` is a usage error (§22.1); explicit help is a success.
    const writer = name === undefined ? io.stderr : io.stdout;
    writer.write(usage());
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (name === '--version') {
    io.stdout.write(`iap ${cliVersion()}\n`);
    return EXIT_OK;
  }

  if (Object.prototype.hasOwnProperty.call(STUB_COMMANDS, name)) {
    return stubCommand(name, io);
  }

  const command = COMMANDS.find((c) => c.name === name || (c.aliases ?? []).includes(name));
  if (command === undefined) {
    io.stderr.write(`iap: unknown command "${name}"\n\n${usage()}`);
    return EXIT_USAGE;
  }

  const parsed = parseFlags(rest, command.flags);
  if (!parsed.ok) {
    io.stderr.write(`iap ${command.name}: ${parsed.message}\n`);
    return EXIT_USAGE;
  }

  try {
    return await command.handler(parsed.args, io);
  } catch (error) {
    io.stderr.write(`iap ${command.name}: ${String(error)}\n`);
    return EXIT_OPERATION;
  }
}

/* ------------------------------------------------------------------ */
/* Bin shim: only runs when this file is the executed entry point      */
/* ------------------------------------------------------------------ */

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

function readProcessStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

if (isMainModule()) {
  void run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    readStdin: readProcessStdin,
  }).then((code) => {
    process.exitCode = code;
  });
}
