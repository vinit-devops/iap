/**
 * Per-operation application to the authored DOCUMENT (phase-3 design
 * decision 1): operations edit the document object — the source of truth —
 * never the derived canonical model. The gate clones the base document once
 * per batch (copy-on-write, IEP-0008 immutability) and this module mutates
 * the working clone sequentially; any refusal aborts the whole batch with
 * the caller's document untouched (IEP-0009 rule 1).
 *
 * Target resolution runs against the working document at each operation's
 * position in the batch: dangling targets, duplicate creates, ambiguous
 * relationship references, and grammar violations refuse here. Content-level
 * problems the resulting document would carry (unknown spec fields, dangling
 * edge targets embedded in a created resource, verb/kind incompatibility)
 * are the dry run's concern and surface as pass-through IaP findings.
 */

import { RESOURCE_ID_PATTERN, isValidResourceId } from '@iap/model';
import type { IaPDocument, Policy, RelationshipEdge, ResourceEntry } from '@iap/model';
import type { OperationRefusal } from './errors.js';
import { refuse } from './errors.js';
import type {
  ChangeSetUnset,
  CreateResourceChange,
  OperationEnvelope,
  PolicyChange,
  ProfileChange,
  RelationshipRef,
} from './operations.js';
import type { DestructiveOperation } from './preview.js';
import { isReplaceEligibleChange, isStatefulKind } from './preview.js';

/** Extension namespace grammar (ch. 11 §11.1). */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Edge members updatable in place; verb and target changes are remove + create. */
const EDGE_MUTABLE_FIELDS = new Set(['description', 'port', 'protocol', 'access', 'path', 'host']);

/** What one applied operation did, for provenance (OP-4), preview, and the log. */
export interface AppliedStep {
  /** Document-root dot paths of every leaf the operation wrote. */
  writes: string[];
  /** Document-root dot paths the operation removed. */
  removes: string[];
  destructive?: DestructiveOperation;
}

export type StepResult = { ok: true; step: AppliedStep } | { ok: false; refusal: OperationRefusal };

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(prefix: string, segment: string): string {
  return prefix === '' ? segment : `${prefix}.${segment}`;
}

/** Collect every leaf dot path (scalars, empty objects, empty arrays) under a value. */
function collectLeaves(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.push(path);
    value.forEach((item, index) => collectLeaves(item, joinPath(path, String(index)), out));
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) out.push(path);
    for (const key of keys) collectLeaves(value[key], joinPath(path, key), out);
  } else {
    out.push(path);
  }
}

/* ------------------------------------------------------------------ */
/* Dot-path editing (design decision 2: explicit set/unset)            */
/* ------------------------------------------------------------------ */

type PathError = { at: string; reason: string };

/** Read the value at a dot path; `undefined` when any segment is missing. */
function getAtPath(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
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

/**
 * Write a value at a dot path, creating missing intermediate containers
 * (arrays when the next segment is an index, objects otherwise). Refuses to
 * write THROUGH an existing non-container value and to create sparse arrays
 * (an index may extend an array by exactly one).
 */
function setAtPath(root: JsonObject, segments: string[], value: unknown): PathError | null {
  let current: JsonObject | unknown[] = root;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    const last = i === segments.length - 1;
    const walked = segments.slice(0, i + 1).join('.');

    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return { at: walked, reason: 'array elements are addressed by zero-based index' };
      }
      const index = Number(segment);
      if (index > current.length) {
        return {
          at: walked,
          reason: `index ${index} would leave a gap (length ${current.length})`,
        };
      }
      if (last) {
        current[index] = structuredClone(value);
        return null;
      }
      if (current[index] === undefined) {
        current[index] = /^\d+$/.test(segments[i + 1] as string) ? [] : {};
      }
      const next: unknown = current[index];
      if (!isPlainObject(next) && !Array.isArray(next)) {
        return { at: walked, reason: 'cannot write through an existing non-container value' };
      }
      current = next;
    } else {
      if (last) {
        current[segment] = structuredClone(value);
        return null;
      }
      if (current[segment] === undefined) {
        current[segment] = /^\d+$/.test(segments[i + 1] as string) ? [] : {};
      }
      const next: unknown = current[segment];
      if (!isPlainObject(next) && !Array.isArray(next)) {
        return { at: walked, reason: 'cannot write through an existing non-container value' };
      }
      current = next;
    }
  }
  return null;
}

/** Remove the value at a dot path; absent paths are an idempotent no-op. Returns whether it existed. */
function unsetAtPath(root: JsonObject, segments: string[]): boolean {
  const parent = getAtPath(root, segments.slice(0, -1));
  const last = segments[segments.length - 1] as string;
  if (Array.isArray(parent)) {
    if (!/^\d+$/.test(last)) return false;
    const index = Number(last);
    if (index >= parent.length) return false;
    parent.splice(index, 1);
    return true;
  }
  if (isPlainObject(parent) && last in parent) {
    delete parent[last];
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Shared set/unset application with per-construct path guards         */
/* ------------------------------------------------------------------ */

interface SetUnsetRules {
  /** Dot-path prefix from the document root the change is scoped under. */
  basePath: string;
  /** Returns a refusal-worthy objection for a relative path, or null. */
  guard(
    relativePath: string,
    segments: string[],
  ): { code: 'invalid-change-path' | 'extension-namespace-violation'; reason: string } | null;
}

function applySetUnset(
  container: JsonObject,
  change: ChangeSetUnset,
  envelope: OperationEnvelope,
  rules: SetUnsetRules,
  step: AppliedStep,
): OperationRefusal | null {
  const operationId = envelope.operationId;
  for (const [path, value] of Object.entries(change.set ?? {})) {
    const segments = path.split('.');
    if (segments.some((segment) => segment.length === 0)) {
      return refuse('invalid-change-path', `malformed dot path "${path}"`, { operationId, path });
    }
    const objection = rules.guard(path, segments);
    if (objection !== null) {
      return refuse(objection.code, objection.reason, {
        operationId,
        path: joinPath(rules.basePath, path),
      });
    }
    const error = setAtPath(container, segments, value);
    if (error !== null) {
      return refuse('invalid-change-path', `cannot set "${path}": ${error.reason}`, {
        operationId,
        path: joinPath(rules.basePath, error.at),
      });
    }
    collectLeaves(value, joinPath(rules.basePath, path), step.writes);
  }
  for (const path of change.unset ?? []) {
    const segments = path.split('.');
    if (segments.some((segment) => segment.length === 0)) {
      return refuse('invalid-change-path', `malformed dot path "${path}"`, { operationId, path });
    }
    const objection = rules.guard(path, segments);
    if (objection !== null) {
      return refuse(objection.code, objection.reason, {
        operationId,
        path: joinPath(rules.basePath, path),
      });
    }
    if (unsetAtPath(container, segments)) {
      step.removes.push(joinPath(rules.basePath, path));
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Per-operation handlers                                              */
/* ------------------------------------------------------------------ */

function resolveResource(
  document: IaPDocument,
  envelope: OperationEnvelope,
): { id: string; entry: ResourceEntry } | OperationRefusal {
  const id = envelope.target.resourceId as string;
  const entry = document.resources?.[id];
  if (entry === undefined) {
    return refuse('dangling-target', `resource "${id}" does not exist in the document`, {
      operationId: envelope.operationId,
      path: `resources.${id}`,
    });
  }
  return { id, entry };
}

function resolveEdge(
  entry: ResourceEntry,
  id: string,
  ref: RelationshipRef,
  envelope: OperationEnvelope,
): { index: number; edge: RelationshipEdge } | OperationRefusal {
  const edges = entry.relationships ?? [];
  const matches: number[] = [];
  edges.forEach((edge, index) => {
    if (edge.type === ref.type && edge.target === ref.target) matches.push(index);
  });
  const path = `resources.${id}.relationships`;
  if (matches.length === 0) {
    return refuse('dangling-target', `no ${ref.type} edge from "${id}" to "${ref.target}" exists`, {
      operationId: envelope.operationId,
      path,
    });
  }
  if (matches.length > 1) {
    return refuse(
      'ambiguous-target',
      `${matches.length} ${ref.type} edges from "${id}" to "${ref.target}" exist — addressing by (verb, target) is ambiguous`,
      { operationId: envelope.operationId, path },
    );
  }
  const index = matches[0] as number;
  return { index, edge: edges[index] as RelationshipEdge };
}

/** Rebuild an object with a fixed leading member order (deterministic serialization). */
function ordered(source: JsonObject, order: readonly string[]): JsonObject {
  const result: JsonObject = {};
  for (const key of order) {
    if (source[key] !== undefined) result[key] = structuredClone(source[key]);
  }
  for (const key of Object.keys(source)) {
    if (!(key in result) && source[key] !== undefined) result[key] = structuredClone(source[key]);
  }
  return result;
}

function createResource(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const id = envelope.target.resourceId as string;
  if (!isValidResourceId(id)) {
    return refuse(
      'id-grammar',
      `resource id "${id}" violates ${RESOURCE_ID_PATTERN} (ch. 2 §2.6.1)`,
      {
        operationId: envelope.operationId,
        path: `resources.${id}`,
      },
    );
  }
  if (document.resources?.[id] !== undefined) {
    return refuse('duplicate-create', `resource "${id}" already exists`, {
      operationId: envelope.operationId,
      path: `resources.${id}`,
    });
  }
  const change = envelope.change as CreateResourceChange & JsonObject;
  if ((change as JsonObject).extensions !== undefined) {
    return refuse(
      'extension-namespace-violation',
      'CreateResource must not write extensions — SetExtensionValue is the sole path into extensions (ch. 11)',
      { operationId: envelope.operationId, path: `resources.${id}.extensions` },
    );
  }
  const entry = ordered(change as JsonObject, [
    'kind',
    'description',
    'labels',
    'spec',
    'relationships',
  ]);
  document.resources ??= {};
  document.resources[id] = entry as unknown as ResourceEntry;
  collectLeaves(entry, `resources.${id}`, step.writes);
  return null;
}

function updateResource(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const resolved = resolveResource(document, envelope);
  if ('code' in resolved) return resolved;
  const { id, entry } = resolved;
  const change = envelope.change as ChangeSetUnset;

  // Destructive classification BEFORE mutation: directional rules compare
  // against the pre-change values (design decision 8).
  const touched: string[] = [];
  const kind = entry.kind;
  const inspect = (path: string, newValue: unknown): void => {
    const oldValue = getAtPath(entry, path.split('.'));
    if (isReplaceEligibleChange(kind, path, oldValue, newValue)) touched.push(path);
  };
  for (const [path, value] of Object.entries(change.set ?? {})) inspect(path, value);
  for (const path of change.unset ?? []) inspect(path, undefined);
  if (touched.length > 0) {
    step.destructive = {
      operationId: envelope.operationId,
      resourceId: id,
      kind,
      reason: 'replace-eligible-update',
      paths: touched,
    };
  }

  return applySetUnset(
    entry as unknown as JsonObject,
    change,
    envelope,
    {
      basePath: `resources.${id}`,
      guard: (path, segments) => {
        const head = segments[0] as string;
        if (head === 'kind') {
          return {
            code: 'invalid-change-path',
            reason:
              'kind is not updatable — a kind change is remove + create (ch. 13 rename semantics)',
          };
        }
        if (head === 'extensions') {
          return {
            code: 'extension-namespace-violation',
            reason:
              'core operations must not write into extensions — SetExtensionValue is the sole path (ch. 11)',
          };
        }
        if (head === 'relationships') {
          return {
            code: 'invalid-change-path',
            reason: `edges are edited via the relationship operations, not "${path}"`,
          };
        }
        return null;
      },
    },
    step,
  );
}

function removeResource(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const resolved = resolveResource(document, envelope);
  if ('code' in resolved) return resolved;
  const { id, entry } = resolved;
  if (isStatefulKind(entry.kind)) {
    step.destructive = {
      operationId: envelope.operationId,
      resourceId: id,
      kind: entry.kind,
      reason: 'stateful-remove',
      paths: [],
    };
  }
  delete document.resources[id];
  step.removes.push(`resources.${id}`);
  return null;
}

function createRelationship(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const resolved = resolveResource(document, envelope);
  if ('code' in resolved) return resolved;
  const { id, entry } = resolved;
  const change = envelope.change as RelationshipEdge & JsonObject;
  if (document.resources?.[change.target] === undefined) {
    return refuse(
      'dangling-target',
      `edge target "${change.target}" does not exist in the document`,
      { operationId: envelope.operationId, path: `resources.${id}.relationships` },
    );
  }
  const edge = ordered(change as JsonObject, [
    'type',
    'target',
    'description',
    'port',
    'protocol',
    'access',
    'path',
    'host',
  ]) as unknown as RelationshipEdge;
  const existing = entry.relationships ?? [];
  if (existing.some((candidate) => JSON.stringify(candidate) === JSON.stringify(edge))) {
    return refuse(
      'duplicate-create',
      `an identical ${change.type} edge from "${id}" to "${change.target}" already exists`,
      { operationId: envelope.operationId, path: `resources.${id}.relationships` },
    );
  }
  entry.relationships = [...existing, edge];
  collectLeaves(edge, `resources.${id}.relationships.${existing.length}`, step.writes);
  return null;
}

function updateRelationship(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const resolved = resolveResource(document, envelope);
  if ('code' in resolved) return resolved;
  const { id, entry } = resolved;
  const found = resolveEdge(entry, id, envelope.target.relationship as RelationshipRef, envelope);
  if ('code' in found) return found;
  return applySetUnset(
    found.edge as unknown as JsonObject,
    envelope.change as ChangeSetUnset,
    envelope,
    {
      basePath: `resources.${id}.relationships.${found.index}`,
      guard: (path, segments) => {
        const head = segments[0] as string;
        if (EDGE_MUTABLE_FIELDS.has(head) || head.startsWith('x-')) return null;
        return {
          code: 'invalid-change-path',
          reason:
            head === 'type' || head === 'target'
              ? 'edge verb and target are not updatable — retargeting is remove + create'
              : `"${path}" is not an edge attribute (ch. 4 §4.4)`,
        };
      },
    },
    step,
  );
}

function removeRelationship(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const resolved = resolveResource(document, envelope);
  if ('code' in resolved) return resolved;
  const { id, entry } = resolved;
  const found = resolveEdge(entry, id, envelope.target.relationship as RelationshipRef, envelope);
  if ('code' in found) return found;
  const edges = entry.relationships as RelationshipEdge[];
  edges.splice(found.index, 1);
  if (edges.length === 0) delete entry.relationships;
  step.removes.push(`resources.${id}.relationships.${found.index}`);
  return null;
}

function applyProfile(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const name = envelope.target.profile as string;
  if (!isValidResourceId(name)) {
    return refuse('id-grammar', `profile name "${name}" violates the identifier grammar`, {
      operationId: envelope.operationId,
      path: `profiles.${name}`,
    });
  }
  const change = envelope.change as ProfileChange & JsonObject;
  const definition = ordered(change as JsonObject, ['description', 'extends', 'overrides']);
  document.profiles ??= {};
  document.profiles[name] = definition;
  collectLeaves(definition, `profiles.${name}`, step.writes);
  return null;
}

function removeProfile(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const name = envelope.target.profile as string;
  if (document.profiles?.[name] === undefined) {
    return refuse('dangling-target', `profile "${name}" does not exist in the document`, {
      operationId: envelope.operationId,
      path: `profiles.${name}`,
    });
  }
  delete document.profiles[name];
  if (Object.keys(document.profiles).length === 0) delete document.profiles;
  step.removes.push(`profiles.${name}`);
  return null;
}

function addPolicy(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const policyId = envelope.target.policyId as string;
  if (!isValidResourceId(policyId)) {
    return refuse('id-grammar', `policy id "${policyId}" violates the identifier grammar`, {
      operationId: envelope.operationId,
      path: 'policies',
    });
  }
  const policies = document.policies ?? [];
  if (policies.some((policy) => policy.id === policyId)) {
    return refuse('duplicate-create', `policy "${policyId}" already exists`, {
      operationId: envelope.operationId,
      path: 'policies',
    });
  }
  const change = envelope.change as PolicyChange & JsonObject;
  const policy = ordered({ id: policyId, ...(change as JsonObject) }, [
    'id',
    'description',
    'target',
    'rule',
    'effect',
    'params',
  ]) as unknown as Policy;
  document.policies = [...policies, policy];
  collectLeaves(policy, `policies.${policies.length}`, step.writes);
  return null;
}

function changeConstraint(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const policyId = envelope.target.policyId as string;
  const index = (document.policies ?? []).findIndex((policy) => policy.id === policyId);
  if (index < 0) {
    return refuse('dangling-target', `policy "${policyId}" does not exist in the document`, {
      operationId: envelope.operationId,
      path: 'policies',
    });
  }
  const policy = (document.policies as Policy[])[index] as Policy;
  return applySetUnset(
    policy as unknown as JsonObject,
    envelope.change as ChangeSetUnset,
    envelope,
    {
      basePath: `policies.${index}`,
      guard: (_path, segments) =>
        (segments[0] as string) === 'id'
          ? {
              code: 'invalid-change-path',
              reason: 'a policy id is its identity — changing it is AddPolicy under a new id',
            }
          : null,
    },
    step,
  );
}

function setMetadata(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  return applySetUnset(
    document.metadata as unknown as JsonObject,
    envelope.change as ChangeSetUnset,
    envelope,
    { basePath: 'metadata', guard: () => null },
    step,
  );
}

function setExtensionValue(
  document: IaPDocument,
  envelope: OperationEnvelope,
  step: AppliedStep,
): OperationRefusal | null {
  const namespace = envelope.target.namespace as string;
  if (!NAMESPACE_PATTERN.test(namespace)) {
    return refuse(
      'id-grammar',
      `extension namespace "${namespace}" violates ${NAMESPACE_PATTERN} (ch. 11 §11.1)`,
      {
        operationId: envelope.operationId,
      },
    );
  }

  const resourceId = envelope.target.resourceId;
  let owner: JsonObject;
  let basePath: string;
  if (resourceId !== undefined) {
    const resolved = resolveResource(document, envelope);
    if ('code' in resolved) return resolved;
    owner = resolved.entry as unknown as JsonObject;
    basePath = `resources.${resolved.id}.extensions.${namespace}`;
  } else {
    owner = document as unknown as JsonObject;
    basePath = `extensions.${namespace}`;
  }

  const extensions = (owner.extensions ??= {}) as JsonObject;
  const block = (extensions[namespace] ??= {}) as JsonObject;

  const result = applySetUnset(
    block,
    envelope.change as ChangeSetUnset,
    envelope,
    {
      basePath,
      guard: (_path, segments) =>
        resourceId !== undefined && (segments[0] as string) === 'version'
          ? {
              code: 'invalid-change-path',
              reason:
                'resource-level extension blocks must not declare version — the document-level registration governs (ch. 11 §11.2)',
            }
          : null,
    },
    step,
  );

  // Namespace scoping is structural: every path applied above is relative to
  // extensions.<namespace>. Empty blocks left behind by unset are dropped so
  // authored absence round-trips.
  if (Object.keys(block).length === 0) delete extensions[namespace];
  if (Object.keys(extensions).length === 0) delete owner.extensions;
  return result;
}

/**
 * Apply one schema-validated envelope to the working document IN PLACE.
 * Callers own the copy-on-write clone; a refusal means the batch must be
 * abandoned (the clone is tainted — rule 1 atomicity is the gate's job).
 */
export function applyOperationInPlace(
  working: IaPDocument,
  envelope: OperationEnvelope,
): StepResult {
  const step: AppliedStep = { writes: [], removes: [] };
  const handlers: Record<
    string,
    (d: IaPDocument, e: OperationEnvelope, s: AppliedStep) => OperationRefusal | null
  > = {
    CreateResource: createResource,
    UpdateResource: updateResource,
    RemoveResource: removeResource,
    CreateRelationship: createRelationship,
    UpdateRelationship: updateRelationship,
    RemoveRelationship: removeRelationship,
    ApplyProfile: applyProfile,
    RemoveProfile: removeProfile,
    AddPolicy: addPolicy,
    ChangeConstraint: changeConstraint,
    SetMetadata: setMetadata,
    SetExtensionValue: setExtensionValue,
  };
  const handler = handlers[envelope.type];
  if (handler === undefined) {
    return {
      ok: false,
      refusal: refuse('invalid-operation-type', `unknown operation type "${envelope.type}"`, {
        operationId: envelope.operationId,
      }),
    };
  }
  const refusal = handler(working, envelope, step);
  if (refusal !== null) return { ok: false, refusal };
  return { ok: true, step };
}
