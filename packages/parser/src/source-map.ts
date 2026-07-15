/**
 * Per-node source maps for IaP documents.
 *
 * The Parser contract (spec ch. 21 §21.3) requires the AST to preserve, for
 * every node, its byte offset, line, and column. This module derives that
 * information from the `yaml` package's positioned AST and exposes it as a
 * flat map from RFC 6901 JSON Pointers to source ranges — the form consumed
 * by finding decoration (`attachPositions` in the package root) and, later,
 * by the LSP (spec ch. 23).
 */
import { LineCounter, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document } from 'yaml';

/** A position in source text. `line` and `col` are 1-based; `offset` is the 0-based character offset. */
export interface SourcePosition {
  line: number;
  col: number;
  offset: number;
}

/** `start` is the first character of the node (or map-entry key); `end` is just past its last character. */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/**
 * Map from RFC 6901 JSON Pointer to the source range of that node.
 * Keys: `''` is the document root, `/resources/web/spec/size` a nested field,
 * `/resources/web/relationships/0` a sequence item. Pointer segments are
 * RFC 6901-escaped (`~` → `~0`, `/` → `~1`). A map entry's range spans its
 * key through its value; a sequence item's range spans the item node.
 */
export type SourceMap = Map<string, SourceRange>;

/** RFC 6901 §3: escape a reference token (`~` → `~0` first, then `/` → `~1`). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Walk an already-parsed `yaml` Document and collect a source map.
 *
 * Aliases are recorded at their use site but never dereferenced, so the walk
 * is linear in source length regardless of alias expansion (safe against
 * alias bombs — pointers *inside* aliased content resolve only at the anchor
 * site; `attachPositions` falls back to the nearest recorded ancestor).
 * `errors` lists constructs that could not be mapped (e.g. non-scalar keys).
 */
export function sourceMapFromDocument(
  document: Document,
  lineCounter: LineCounter,
): { map: SourceMap; errors: string[] } {
  const map: SourceMap = new Map();
  const errors: string[] = [];

  const at = (offset: number): SourcePosition => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, col, offset };
  };
  const record = (pointer: string, start: number, end: number): void => {
    map.set(pointer, { start: at(start), end: at(end) });
  };

  const visit = (node: unknown, pointer: string): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key;
        if (!isScalar(key) || key.range == null) {
          errors.push(`${pointer || '/'}: non-scalar or unpositioned map key — entry skipped`);
          continue;
        }
        const childPointer = `${pointer}/${escapePointerSegment(String(key.value))}`;
        const value = isNode(pair.value) ? pair.value : undefined;
        record(childPointer, key.range[0], value?.range ? value.range[2] : key.range[1]);
        visit(value, childPointer);
      }
      return;
    }
    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        const childPointer = `${pointer}/${index}`;
        if (isNode(item) && item.range) {
          record(childPointer, item.range[0], item.range[2]);
        } else {
          errors.push(`${childPointer}: unpositioned sequence item — skipped`);
        }
        visit(item, childPointer);
      });
    }
    // Scalars and aliases are leaves: their entry was recorded by the parent.
  };

  const root = document.contents;
  if (isNode(root) && root.range) {
    record('', root.range[0], root.range[2]);
  }
  visit(root, '');
  return { map, errors };
}

/**
 * Parse `text` (YAML or JSON — JSON is a YAML subset) and build a per-node
 * source map. Parse problems are reported as `errors` strings; the map still
 * covers whatever was parseable (partial results, spec ch. 21 §21.1.3).
 */
export function buildSourceMap(text: string): { map: SourceMap; errors: string[] } {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true, version: '1.2' });
  const collected = sourceMapFromDocument(document, lineCounter);
  return {
    map: collected.map,
    errors: [...document.errors.map((error) => error.message), ...collected.errors],
  };
}
