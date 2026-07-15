/**
 * `iap state` — show the current persisted state snapshot (Phase 19, M19.3).
 * Read-only: it opens the durable `FileStateBackend` rooted at `--state` (or
 * the default `.iap-state/`) and prints the snapshot for this document/profile.
 * The state identity is derived from the document's metadata name and the
 * active profile — the same ref `iap deploy` writes under. Never mutates and
 * never acquires a lock.
 */

import type { CliIO, ParsedArgs } from '../shared.js';
import {
  DEFAULT_FILE,
  EXIT_OK,
  EXIT_OPERATION,
  JSON_FORMAT_VERSION,
  booleanFlag,
  stringFlag,
  writeJson,
} from '../shared.js';
import { load } from '@iap/sdk';
import { DEFAULT_STATE_DIR, openStateBackend, stateRefFor } from './execution.js';

export async function stateCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const json = stringFlag(args, 'output') === 'json';
  const quiet = booleanFlag(args, 'quiet');
  const file = stringFlag(args, 'file') ?? DEFAULT_FILE;
  const profile = stringFlag(args, 'profile') ?? null;

  // Resolve the document name for the state ref; do not require a valid
  // document, only a readable one (state inspection must work even when the
  // document has drifted from conformance).
  let documentName = file;
  try {
    const ws = await load({ path: file }, { profile });
    documentName =
      (ws.document as { metadata?: { name?: string } } | undefined)?.metadata?.name ?? file;
  } catch (error) {
    io.stderr.write(`iap state: cannot read ${file}: ${String(error)}\n`);
    return EXIT_OPERATION;
  }

  const stateDir = stringFlag(args, 'state') ?? DEFAULT_STATE_DIR;
  const ref = stateRefFor(documentName, profile);

  let snapshot;
  try {
    snapshot = await openStateBackend(stateDir).read(ref);
  } catch (error) {
    io.stderr.write(`iap state: ${String(error)}\n`);
    return EXIT_OPERATION;
  }

  if (json) {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      document: ref.document,
      profile: ref.profile,
      present: snapshot !== null,
      state: snapshot,
    });
    return EXIT_OK;
  }

  if (!quiet) {
    if (snapshot === null) {
      io.stdout.write(
        `No state for ${ref.document}/${ref.profile ?? 'base'} under ${stateDir} (never deployed)\n`,
      );
    } else {
      const ids = Object.keys(snapshot.objects).sort();
      io.stdout.write(
        `State ${ref.document}/${ref.profile ?? 'base'} @ revision ${snapshot.revision} ` +
          `(${ids.length} object(s), integrity ${snapshot.integrity})\n`,
      );
      for (const id of ids) {
        const object = snapshot.objects[id];
        if (object === undefined) continue;
        io.stdout.write(`  ${id}  (${object.type})${object.managed ? ' managed' : ''}\n`);
      }
    }
  }

  return EXIT_OK;
}
