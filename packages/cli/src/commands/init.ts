/**
 * `iap init` — write a minimal, schema-valid starter document to
 * `infrastructure.iap.yaml` (or `--file <path>`). Refuses to overwrite an
 * existing file unless `--force` is given. The starter validates cleanly
 * through `iap validate` (phases 1–5, zero findings).
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  DEFAULT_FILE,
  EXIT_OK,
  EXIT_OPERATION,
  EXIT_USAGE,
  booleanFlag,
  stringFlag,
} from '../shared.js';

const STARTER = `# infrastructure.iap.yaml — starter document created by \`iap init\`.
# Express WHAT your infrastructure should be; providers decide HOW.
# Reference: the Infrastructure as Prompt (iap.dev/v1).
apiVersion: iap.dev/v1

metadata:
  name: my-infrastructure
  description: Describe this system in one sentence

resources:
  app:
    kind: Service
    description: Example service — replace with your own resources
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/app:1.0.0
`;

export async function initCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const file = stringFlag(args, 'file') ?? DEFAULT_FILE;
  const force = booleanFlag(args, 'force');
  const quiet = booleanFlag(args, 'quiet');

  if (existsSync(file) && !force) {
    io.stderr.write(`iap init: ${file} already exists — pass --force to overwrite\n`);
    return EXIT_USAGE;
  }
  try {
    await writeFile(file, STARTER, 'utf8');
  } catch (error) {
    io.stderr.write(`iap init: cannot write ${file}: ${(error as Error).message}\n`);
    return EXIT_OPERATION;
  }
  if (!quiet) io.stdout.write(`created ${file}\n`);
  return EXIT_OK;
}
