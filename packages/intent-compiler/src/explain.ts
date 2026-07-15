/**
 * Semantic diff explanation (M3.3, §3.5 "Explain what changes this request
 * will make"): a deterministic, human-readable rendering of what a proposal
 * batch WOULD change — adds/changes/removes over the canonical projections
 * (the M3.1 `PreviewDiff`), per-field provenance citing the writing
 * operations, assumption and clarification status, and destructive
 * classification.
 *
 * `explainBatch` produces PROSE, never document bytes: it speculatively
 * applies the batch to a copy, diffs the canonical projections, and throws
 * the copy away. OP-1 is untouched — the only serializer remains the closure
 * on the gate's committed result.
 */

import { canonicalize } from '@iap/model';
import type { IaPDocument } from '@iap/model';
import { applyOperationInPlace } from './apply.js';
import type { AppliedStep } from './apply.js';
import type { OperationRefusal } from './errors.js';
import type { PreviewDiff } from './preview.js';
import { buildPreviewDiff } from './preview.js';
import type { FieldProvenanceRecord } from './provenance.js';
import { attachProvenance } from './provenance.js';
import { validateBatchStructure } from './schema.js';

export interface ExplainOptions {
  /** Profile the canonical projections are relative to (`null`/omitted = base). */
  profile?: string | null;
}

export type ExplainResult =
  | {
      ok: true;
      /** The deterministic human-readable explanation. */
      text: string;
      diff: PreviewDiff;
      provenance: FieldProvenanceRecord[];
    }
  | { ok: false; refusals: OperationRefusal[] };

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function compact(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Explain what applying `batch` to `document` would change, and why. Pure
 * and deterministic; the input document is never mutated. Structural or
 * application problems return the gate's refusal shapes — an unexplainable
 * proposal is reported, never partially narrated.
 */
export function explainBatch(
  document: IaPDocument,
  batch: unknown,
  options: ExplainOptions = {},
): ExplainResult {
  const profile = options.profile ?? null;
  const structure = validateBatchStructure(batch);
  if (!structure.ok) return { ok: false, refusals: structure.refusals };
  const operations = structure.batch.operations;

  const working = structuredClone(document);
  const steps: AppliedStep[] = [];
  for (const envelope of operations) {
    const outcome = applyOperationInPlace(working, envelope);
    if (!outcome.ok) return { ok: false, refusals: [outcome.refusal] };
    steps.push(outcome.step);
  }

  const base = canonicalize(document, { profile });
  const result = canonicalize(working, { profile });
  const destructive = steps.flatMap((step) =>
    step.destructive === undefined ? [] : [step.destructive],
  );
  const diff = buildPreviewDiff(base.canonicalJson, result.canonicalJson, destructive);

  const provenanceByPath = new Map<string, FieldProvenanceRecord>();
  operations.forEach((envelope, index) => {
    attachProvenance(provenanceByPath, envelope, (steps[index] as AppliedStep).writes, undefined);
  });
  const provenance = [...provenanceByPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const baseModel = JSON.parse(base.canonicalJson) as unknown;
  const resultModel = JSON.parse(result.canonicalJson) as unknown;
  const describeWriter = (path: string): string => {
    // Longest-prefix provenance match: a subtree add reports its root path,
    // while records are per written leaf.
    let best: FieldProvenanceRecord | undefined;
    for (const record of provenance) {
      if (
        record.path === path ||
        record.path.startsWith(`${path}.`) ||
        path.startsWith(`${record.path}.`)
      ) {
        if (best === undefined || record.path.length < best.path.length) best = record;
      }
    }
    return best === undefined ? '' : ` — written by ${best.operationId} (${best.source})`;
  };

  const lines: string[] = [];
  const name = document.metadata?.name ?? 'document';
  lines.push(
    `Applying ${operations.length} operation(s) to "${name}"${profile === null ? '' : ` (profile ${profile})`}:`,
  );

  if (diff.adds.length === 0 && diff.changes.length === 0 && diff.removes.length === 0) {
    lines.push('', 'No semantic changes: the canonical document is unchanged.');
  }
  if (diff.adds.length > 0) {
    lines.push('', 'Adds:');
    for (const path of diff.adds) {
      lines.push(`  + ${path} = ${compact(getAtPath(resultModel, path))}${describeWriter(path)}`);
    }
  }
  if (diff.changes.length > 0) {
    lines.push('', 'Changes:');
    for (const path of diff.changes) {
      lines.push(
        `  ~ ${path}: ${compact(getAtPath(baseModel, path))} -> ${compact(getAtPath(resultModel, path))}${describeWriter(path)}`,
      );
    }
  }
  if (diff.removes.length > 0) {
    lines.push('', 'Removes:');
    for (const path of diff.removes) {
      lines.push(`  - ${path} (was ${compact(getAtPath(baseModel, path))})`);
    }
  }

  if (diff.destructive) {
    lines.push('', 'DESTRUCTIVE — requires explicit acknowledgment (ch. 14 §14.2):');
    for (const entry of diff.destructiveOperations) {
      lines.push(
        `  ! ${entry.reason} on ${entry.kind} "${entry.resourceId}" (${entry.operationId})${entry.paths.length > 0 ? `: ${entry.paths.join(', ')}` : ''}`,
      );
    }
  }

  const assumptionLines: string[] = [];
  for (const envelope of operations) {
    for (const assumption of envelope.assumptions) {
      assumptionLines.push(
        `  ? ${envelope.operationId}: ${assumption.field} = ${compact(assumption.assumed)} (${assumption.reason})`,
      );
    }
  }
  if (assumptionLines.length > 0) {
    lines.push('', 'Assumed values requiring confirmation (OP-3):', ...assumptionLines);
  }

  const clarificationLines: string[] = [];
  for (const envelope of operations) {
    for (const clarification of envelope.requiredClarifications) {
      clarificationLines.push(
        `  ? ${clarification.id} (blocks ${envelope.operationId}): ${clarification.question}`,
      );
    }
  }
  if (clarificationLines.length > 0) {
    lines.push('', 'Open clarifications blocking commit (OP-3):', ...clarificationLines);
  }

  return { ok: true, text: lines.join('\n'), diff, provenance };
}
