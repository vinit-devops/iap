/**
 * `iap diff <other-file>` — semantic diff of two canonical models (the base
 * document from `--file`/`--profile` against the positional other file with
 * `--profile-b`). Resources are compared by their canonical per-resource
 * JSON, so authoring noise (key order, quantity spellings, profile merge
 * mechanics) never reports as a change; only effective semantics do.
 */

import { load } from '@iap/sdk';
import type { CanonicalModel, CanonicalResource } from '@iap/model';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_OPERATION,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  booleanFlag,
  openWorkspace,
  stableStringify,
  stringFlag,
  writeFindings,
  writeJson,
} from '../shared.js';

interface ChangedPath {
  pointer: string;
  base?: unknown;
  other?: unknown;
}

export async function diffCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');
  const otherFile = args.positionals[0];
  if (otherFile === undefined || args.positionals.length !== 1) {
    io.stderr.write('iap diff: exactly one <other-file> argument is required\n');
    return EXIT_USAGE;
  }

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap diff: ${opened.message}\n`);
    return opened.code;
  }
  const baseProfile = opened.profile;
  const otherProfile = stringFlag(args, 'profile-b') ?? null;

  let otherWs;
  try {
    otherWs = await load({ path: otherFile }, { profile: otherProfile });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const usage = code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR';
    io.stderr.write(`iap diff: cannot read ${otherFile}: ${(error as Error).message}\n`);
    return usage ? EXIT_USAGE : EXIT_OPERATION;
  }

  if (opened.ws.document === undefined || otherWs.document === undefined) {
    writeFindings(io.stderr, [...opened.ws.findings, ...otherWs.findings]);
    return EXIT_FINDINGS;
  }

  const base = opened.ws.canonical();
  const other = otherWs.canonical();

  const { added, removed, changed } = diffResources(base.model, other.model);
  const identical = base.hash === other.hash;

  if (output === 'json') {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      base: { file: opened.file, profile: baseProfile, hash: base.hash },
      other: { file: otherFile, profile: otherProfile, hash: other.hash },
      identical,
      added,
      removed,
      changed,
    });
    return EXIT_OK;
  }

  if (!quiet) {
    io.stdout.write(`base:  ${opened.file} (profile: ${baseProfile ?? 'base'})  ${base.hash}\n`);
    io.stdout.write(`other: ${otherFile} (profile: ${otherProfile ?? 'base'})  ${other.hash}\n\n`);
    if (identical) {
      io.stdout.write('canonical models are identical\n');
      return EXIT_OK;
    }
    for (const entry of changed) {
      io.stdout.write(`~ ${entry.id}\n`);
      for (const path of entry.paths) {
        io.stdout.write(
          `    ${path.pointer}: ${JSON.stringify(path.base)} → ${JSON.stringify(path.other)}\n`,
        );
      }
    }
    for (const id of added) io.stdout.write(`+ ${id}\n`);
    for (const id of removed) io.stdout.write(`- ${id}\n`);
    io.stdout.write(
      `\n${changed.length} changed, ${added.length} added, ${removed.length} removed\n`,
    );
  }
  return EXIT_OK;
}

function diffResources(
  base: CanonicalModel,
  other: CanonicalModel,
): { added: string[]; removed: string[]; changed: { id: string; paths: ChangedPath[] }[] } {
  const ids = [
    ...new Set([...Object.keys(base.resources), ...Object.keys(other.resources)]),
  ].sort();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: { id: string; paths: ChangedPath[] }[] = [];
  for (const id of ids) {
    const a = base.resources[id];
    const b = other.resources[id];
    if (a === undefined) {
      added.push(id);
    } else if (b === undefined) {
      removed.push(id);
    } else if (stableStringify(comparable(a)) !== stableStringify(comparable(b))) {
      const paths: ChangedPath[] = [];
      diffValues(comparable(a), comparable(b), '', paths);
      changed.push({ id, paths });
    }
  }
  return { added, removed, changed };
}

/** The semantic surface of a canonical resource (relationships live in `edges`). */
function comparable(resource: CanonicalResource): Record<string, unknown> {
  return {
    kind: resource.kind,
    labels: resource.labels,
    spec: resource.spec,
    extensions: resource.extensions,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collect leaf-level differences as RFC 6901 pointers (deterministic order). */
function diffValues(a: unknown, b: unknown, pointer: string, out: ChangedPath[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
      diffValues(a[key], b[key], `${pointer}/${escaped}`, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      diffValues(a[i], b[i], `${pointer}/${i}`, out);
    }
    return;
  }
  if (stableStringify(a) === stableStringify(b)) return;
  const entry: ChangedPath = { pointer };
  if (a !== undefined) entry.base = a;
  if (b !== undefined) entry.other = b;
  out.push(entry);
}
