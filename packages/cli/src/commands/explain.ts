/**
 * `iap explain <resource-id>` — one resource, fully accounted for: kind,
 * the materialized spec with the provenance of every effective value
 * (explicit / default / profile, IEP-0008 — every default is explained),
 * incoming and outgoing canonical edges, and the execution-wave position.
 */

import type { CanonicalEdge, ProvenanceRecord } from '@iap/model';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  booleanFlag,
  openWorkspace,
  resolvePointer,
  stringFlag,
  writeFindings,
  writeJson,
} from '../shared.js';

export async function explainCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');
  const id = args.positionals[0];

  if (id === undefined || args.positionals.length !== 1) {
    io.stderr.write('iap explain: exactly one <resource-id> argument is required\n');
    return EXIT_USAGE;
  }

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap explain: ${opened.message}\n`);
    return opened.code;
  }
  const { ws, file, profile } = opened;
  if (ws.document === undefined) {
    writeFindings(io.stderr, ws.findings);
    return EXIT_FINDINGS;
  }

  const model = ws.canonical().model;
  const resource = model.resources[id];
  if (resource === undefined) {
    const known = Object.keys(model.resources).sort().join(', ');
    io.stderr.write(`iap explain: resource "${id}" not found — known resources: ${known}\n`);
    return EXIT_USAGE;
  }

  // Provenance entries scoped to this resource, pointer-sorted (totality:
  // every effective leaf has exactly one record).
  const prefix = `/resources/${id}/`;
  const provenance: Record<string, ProvenanceRecord> = {};
  for (const pointer of Object.keys(model.provenance).sort()) {
    if (pointer.startsWith(prefix)) {
      provenance[pointer.slice(prefix.length - 1)] = model.provenance[pointer] as ProvenanceRecord;
    }
  }

  const edgesOut = model.edges.filter((edge) => edge.source === id);
  const edgesIn = model.edges.filter((edge) => edge.target === id);
  const waves = ws.waves();
  const waveIndex = waves.findIndex((wave) => wave.includes(id));
  const wave = { index: waveIndex + 1, of: waves.length };

  if (output === 'json') {
    writeJson(io.stdout, {
      formatVersion: JSON_FORMAT_VERSION,
      file,
      profile,
      id,
      kind: resource.kind,
      labels: resource.labels,
      spec: resource.spec,
      provenance,
      edgesOut: edgesOut.map(edgeOut),
      edgesIn: edgesIn.map(edgeOut),
      wave,
    });
    return EXIT_OK;
  }

  if (!quiet) {
    io.stdout.write(`${id} (${resource.kind}) — ${file}\n`);
    io.stdout.write(`profile: ${profile ?? '(base document)'}\n`);
    io.stdout.write(waveIndex === -1 ? 'wave: none\n' : `wave: ${wave.index} of ${wave.of}\n`);

    io.stdout.write('\neffective values (explicit / default / profile):\n');
    const pointers = Object.keys(provenance);
    const width = pointers.reduce((max, p) => Math.max(max, p.length), 0);
    for (const pointer of pointers) {
      const record = provenance[pointer] as ProvenanceRecord;
      const value = resolvePointer({ resources: model.resources }, `/resources/${id}${pointer}`);
      io.stdout.write(
        `  ${pointer.padEnd(width)}  ${JSON.stringify(value)}  [${record.source}: ${record.originId}]\n`,
      );
    }
    if (pointers.length === 0) io.stdout.write('  (none recorded)\n');

    io.stdout.write('\nedges out:\n');
    for (const edge of edgesOut) io.stdout.write(`  ${edgeLine(edge, 'out')}\n`);
    if (edgesOut.length === 0) io.stdout.write('  (none)\n');
    io.stdout.write('edges in:\n');
    for (const edge of edgesIn) io.stdout.write(`  ${edgeLine(edge, 'in')}\n`);
    if (edgesIn.length === 0) io.stdout.write('  (none)\n');
  }
  return EXIT_OK;
}

function edgeOut(edge: CanonicalEdge): Record<string, unknown> {
  return { source: edge.source, type: edge.type, target: edge.target, attributes: edge.attributes };
}

function edgeLine(edge: CanonicalEdge, direction: 'in' | 'out'): string {
  const attrs = Object.keys(edge.attributes)
    .sort()
    .map((key) => `${key}=${String(edge.attributes[key])}`)
    .join(', ');
  const suffix = attrs === '' ? '' : ` (${attrs})`;
  return direction === 'out'
    ? `${edge.type} → ${edge.target}${suffix}`
    : `${edge.source} ${edge.type} →${suffix}`;
}
