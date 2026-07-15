/**
 * Shared CLI plumbing: exit codes (ch. 22 §22.1), the injected IO contract
 * that keeps every command testable in-process, hand-rolled flag parsing
 * (no external argv dependency), workspace loading with the normative
 * error-to-exit-code mapping, and small deterministic formatting helpers.
 */

import { load } from '@iap/sdk';
import type { IaPWorkspaceResult } from '@iap/sdk';
import type { Finding } from '@iap/model';

/* ------------------------------------------------------------------ */
/* Exit codes (ch. 22 §22.1 — normative)                               */
/* ------------------------------------------------------------------ */

/** Success. */
export const EXIT_OK = 0;
/** Error-severity findings were produced (warnings alone do not affect the exit code). */
export const EXIT_FINDINGS = 1;
/** Usage error: unknown flag/command, bad argument, unreadable file. */
export const EXIT_USAGE = 2;
/** Operation failure at execution time. */
export const EXIT_OPERATION = 3;

/** Default input document (ch. 22 §22.1). */
export const DEFAULT_FILE = 'infrastructure.iap.yaml';

/** The version stamped into every machine-readable (JSON) output. */
export const JSON_FORMAT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Injected IO (in-process testability: no global stdout writes)      */
/* ------------------------------------------------------------------ */

export interface CliWriter {
  write(text: string): void;
}

export interface CliIO {
  stdout: CliWriter;
  stderr: CliWriter;
  /**
   * Read all of standard input to end (used by `iap create` when no request
   * is given on the command line). Optional so tests can inject it; absent
   * means stdin is unavailable and commands must fall back to a usage error.
   */
  readStdin?(): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Flag parsing (hand-rolled; ch. 22 conventions)                      */
/* ------------------------------------------------------------------ */

export interface FlagSpec {
  /** Long name without dashes (`file` → `--file`). */
  name: string;
  /** Optional single-letter alias (`f` → `-f`). */
  alias?: string;
  takesValue: boolean;
  /** Collect repeated occurrences into an array (e.g. `--pack a --pack b`). */
  repeatable?: boolean;
  /** Closed value set; anything else is a usage error. */
  values?: readonly string[];
}

export type FlagValue = string | true | string[];

export interface ParsedArgs {
  flags: Map<string, FlagValue>;
  positionals: string[];
}

export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; message: string };

/** Common flags shared by the inspecting commands. */
export const COMMON_FLAGS: FlagSpec[] = [
  { name: 'file', alias: 'f', takesValue: true },
  { name: 'profile', takesValue: true },
  { name: 'quiet', alias: 'q', takesValue: false },
  // Accepted for CI compatibility; the CLI never emits color, so it is a no-op.
  { name: 'no-color', takesValue: false },
];

export function parseFlags(argv: string[], specs: FlagSpec[]): ParseResult {
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];
  const byName = new Map<string, FlagSpec>();
  const byAlias = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.alias !== undefined) byAlias.set(spec.alias, spec);
  }

  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;

    if (token === '--') {
      positionals.push(...argv.slice(index));
      break;
    }

    let spec: FlagSpec | undefined;
    let inlineValue: string | undefined;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (eq !== -1) inlineValue = token.slice(eq + 1);
      spec = byName.get(name);
      if (spec === undefined) return { ok: false, message: `unknown flag "--${name}"` };
    } else if (token.startsWith('-') && token.length > 1) {
      spec = byAlias.get(token.slice(1));
      if (spec === undefined) return { ok: false, message: `unknown flag "${token}"` };
    } else {
      positionals.push(token);
      continue;
    }

    let value: FlagValue = true;
    if (spec.takesValue) {
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[index];
        if (next === undefined) {
          return { ok: false, message: `flag "--${spec.name}" requires a value` };
        }
        value = next;
        index += 1;
      }
      if (spec.values !== undefined && !spec.values.includes(value)) {
        return {
          ok: false,
          message: `invalid value "${value}" for "--${spec.name}" — expected one of: ${spec.values.join(', ')}`,
        };
      }
    } else if (inlineValue !== undefined) {
      return { ok: false, message: `flag "--${spec.name}" does not take a value` };
    }

    if (spec.repeatable) {
      const existing = flags.get(spec.name);
      const list = Array.isArray(existing) ? existing : [];
      if (typeof value === 'string') list.push(value);
      flags.set(spec.name, list);
    } else {
      flags.set(spec.name, value);
    }
  }

  return { ok: true, args: { flags, positionals } };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

export function listFlag(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  return Array.isArray(value) ? value : [];
}

/* ------------------------------------------------------------------ */
/* Workspace loading with the normative exit-code mapping              */
/* ------------------------------------------------------------------ */

export type OpenResult =
  | { ok: true; ws: IaPWorkspaceResult; file: string; profile: string | null }
  | { ok: false; code: number; message: string };

/**
 * Load the target document through the SDK. An unreadable file is a usage
 * error (exit 2, ch. 22 §22.1); document problems stay findings on the
 * returned workspace and never throw here.
 */
export async function openWorkspace(
  args: ParsedArgs,
  options: { sourceMap?: boolean } = {},
): Promise<OpenResult> {
  const file = stringFlag(args, 'file') ?? DEFAULT_FILE;
  const profile = stringFlag(args, 'profile') ?? null;
  try {
    const loadOptions: Parameters<typeof load>[1] = { profile };
    if (options.sourceMap) loadOptions.sourceMap = true;
    const ws = await load({ path: file }, loadOptions);
    return { ok: true, ws, file, profile };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR' || code === 'ENOTDIR') {
      return {
        ok: false,
        code: EXIT_USAGE,
        message: `cannot read ${file}: ${(error as Error).message}`,
      };
    }
    return { ok: false, code: EXIT_OPERATION, message: String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic formatting helpers                                    */
/* ------------------------------------------------------------------ */

export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

export function countBySeverity(findings: Finding[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** `1 error, 2 warnings` — the ch. 22 summary-line vocabulary. */
export function severitySummary(findings: Finding[]): string {
  const { errors, warnings } = countBySeverity(findings);
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${plural(errors, 'error')}, ${plural(warnings, 'warning')}`;
}

/** One finding as an indented two-line block (ch. 22 §22.2.1 sample shape). */
export function formatFindingBlock(finding: Finding, indent = '    '): string {
  const label = `${finding.code} ${finding.severity}  `;
  const head = `${indent}${label}${finding.path === '' ? '(document)' : finding.path}`;
  const cont = `${indent}${' '.repeat(label.length)}${finding.message}`;
  return `${head}\n${cont}`;
}

/** Print findings (used by non-validate commands when a document is broken). */
export function writeFindings(io: CliWriter, findings: Finding[]): void {
  for (const finding of findings) {
    io.write(
      `${finding.code} ${finding.severity}  ${finding.path === '' ? '(document)' : finding.path}  ${finding.message}\n`,
    );
  }
}

/** JSON with recursively sorted keys — for order-insensitive semantic comparison. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Resolve an RFC 6901 pointer against a plain-object tree (`undefined` when absent). */
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let current: unknown = root;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Serialize one machine-readable payload: 2-space JSON plus trailing newline. */
export function writeJson(io: CliWriter, payload: unknown): void {
  io.write(JSON.stringify(payload, null, 2) + '\n');
}
