/**
 * `iap graph` — the normalized canonical edge set (ch. 4 §4.7 step-6 output)
 * plus the derived ordering summary (ch. 9): human columns, JSON, or DOT
 * (the ch. 18 dependency view rendered by `@iap/architecture`).
 */

import { deriveView, toDot } from '@iap/architecture';
import type { CanonicalEdge } from '@iap/model';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  JSON_FORMAT_VERSION,
  booleanFlag,
  openWorkspace,
  stringFlag,
  writeFindings,
  writeJson,
} from '../shared.js';

export async function graphCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'format') ?? stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap graph: ${opened.message}\n`);
    return opened.code;
  }
  const { ws } = opened;
  if (ws.document === undefined) {
    writeFindings(io.stderr, ws.findings);
    return EXIT_FINDINGS;
  }

  const model = ws.canonical().model;
  const waves = ws.waves();

  if (output === 'dot') {
    io.stdout.write(toDot(deriveView(model, 'dependency')));
    return EXIT_OK;
  }

  if (output === 'json') {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      edges: model.edges.map((edge) => ({
        source: edge.source,
        type: edge.type,
        target: edge.target,
        attributes: edge.attributes,
      })),
      ordering: { waves },
    });
    return EXIT_OK;
  }

  if (!quiet) {
    const rows = model.edges.map((edge) => [edge.source, edge.type, edge.target, attrs(edge)]);
    const widths = [0, 1, 2].map((column) =>
      rows.reduce((max, row) => Math.max(max, (row[column] as string).length), 0),
    );
    for (const row of rows) {
      const line = [0, 1, 2]
        .map((column) => (row[column] as string).padEnd(widths[column] as number))
        .join('  ');
      io.stdout.write(`${line}  ${row[3] as string}`.trimEnd() + '\n');
    }
    if (model.edges.length === 0) io.stdout.write('(no edges)\n');
    io.stdout.write('\nexecution waves:\n');
    waves.forEach((wave, index) => {
      io.stdout.write(`  ${index + 1}  ${wave.join('  ')}\n`);
    });
  }
  return EXIT_OK;
}

/** `tcp/5432 read-write path=/` — protocol/port, bare access, remaining k=v. */
function attrs(edge: CanonicalEdge): string {
  const parts: string[] = [];
  const protocol = edge.attributes['protocol'];
  const port = edge.attributes['port'];
  if (protocol !== undefined || port !== undefined) {
    parts.push([protocol, port].filter((p) => p !== undefined).join('/'));
  }
  if (edge.attributes['access'] !== undefined) parts.push(String(edge.attributes['access']));
  for (const key of Object.keys(edge.attributes).sort()) {
    if (key === 'protocol' || key === 'port' || key === 'access') continue;
    parts.push(`${key}=${String(edge.attributes[key])}`);
  }
  return parts.join(' ');
}
