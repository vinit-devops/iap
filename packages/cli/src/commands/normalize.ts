/**
 * `iap normalize` and `iap fmt` (alias `format`) — the two serializer
 * commands over the SDK round-trip contract (ch. 21; ch. 22 §22.2.12):
 *
 * - `normalize` prints the canonical byte projection (C5+C6). Default output
 *   is the projection itself (already versioned by its embedded
 *   `apiVersion`); `-o json` wraps it with the canonical hash for scripting.
 * - `fmt` re-emits the profile-unmerged document as YAML — a pure
 *   round-trip whose output canonicalizes to the identical hash — to stdout
 *   or back to the file with `--write`.
 */

import { writeFile } from 'node:fs/promises';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_OPERATION,
  JSON_FORMAT_VERSION,
  booleanFlag,
  openWorkspace,
  stringFlag,
  writeFindings,
  writeJson,
} from '../shared.js';

export async function normalizeCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap normalize: ${opened.message}\n`);
    return opened.code;
  }
  const { ws, profile } = opened;
  if (ws.document === undefined) {
    writeFindings(io.stderr, ws.findings);
    return EXIT_FINDINGS;
  }

  const canon = ws.canonical();
  if (output === 'json') {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      profile,
      hash: canon.hash,
      canonical: JSON.parse(canon.canonicalJson) as unknown,
    });
  } else {
    io.stdout.write(canon.canonicalJson + '\n');
  }
  return EXIT_OK;
}

export async function fmtCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const write = booleanFlag(args, 'write');
  const quiet = booleanFlag(args, 'quiet');

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap fmt: ${opened.message}\n`);
    return opened.code;
  }
  const { ws, file } = opened;
  if (ws.document === undefined) {
    writeFindings(io.stderr, ws.findings);
    return EXIT_FINDINGS;
  }

  const text = ws.serialize('yaml');
  if (write) {
    try {
      await writeFile(file, text, 'utf8');
    } catch (error) {
      io.stderr.write(`iap fmt: cannot write ${file}: ${(error as Error).message}\n`);
      return EXIT_OPERATION;
    }
    if (!quiet) io.stdout.write(`formatted ${file}\n`);
  } else {
    io.stdout.write(text);
  }
  return EXIT_OK;
}
