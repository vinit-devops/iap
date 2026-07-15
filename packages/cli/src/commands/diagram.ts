/**
 * `iap diagram` — render one of the five derived views of ch. 18 (§22.2.4)
 * via `@iap/architecture`. Diagrams are pure derivations of the canonical
 * model: there is no flag to inject manual layout or content.
 */

import { deriveView, toDot, toMermaid } from '@iap/architecture';
import type { DeriveViewOptions, ViewName } from '@iap/architecture';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  openWorkspace,
  stringFlag,
  writeFindings,
  writeJson,
} from '../shared.js';

export const VIEWS = ['architecture', 'dependency', 'network', 'security', 'application'] as const;

export async function diagramCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const view = stringFlag(args, 'view');
  const format = stringFlag(args, 'format') ?? stringFlag(args, 'output') ?? 'mermaid';
  const application = stringFlag(args, 'application');

  if (view === undefined) {
    io.stderr.write(`iap diagram: --view is required (one of: ${VIEWS.join(', ')})\n`);
    return EXIT_USAGE;
  }
  if (view === 'application' && application === undefined) {
    io.stderr.write(
      'iap diagram: the application view requires --application <id> (ch. 18 §18.2.5)\n',
    );
    return EXIT_USAGE;
  }

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap diagram: ${opened.message}\n`);
    return opened.code;
  }
  const { ws } = opened;
  if (ws.document === undefined) {
    writeFindings(io.stderr, ws.findings);
    return EXIT_FINDINGS;
  }

  const model = ws.canonical().model;
  let graph;
  try {
    const options: DeriveViewOptions = {};
    if (application !== undefined) options.application = application;
    graph = deriveView(model, view as ViewName, options);
  } catch (error) {
    // deriveView rejects unknown Applications and misuse — bad arguments.
    io.stderr.write(`iap diagram: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  }

  if (format === 'json') {
    writeJson(io.stdout, { formatVersion: JSON_FORMAT_VERSION, ...graph });
  } else if (format === 'dot') {
    io.stdout.write(toDot(graph));
  } else {
    io.stdout.write(toMermaid(graph));
  }
  return EXIT_OK;
}
