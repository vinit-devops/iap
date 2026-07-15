/**
 * The headless visual-designer session (roadmap Phase 15). The core invariant
 * is architectural: **the designer canvas is a VIEW; the IaP document is the
 * single source of truth.** Every canvas edit — add a resource, connect two,
 * set a property, remove one — is translated into a compiler operation and
 * committed through the same gate (`apply`) the CLI and authoring engine use.
 * A rejected edit leaves the document unchanged (the UI shows the refusal), so
 * the UI can never become a second source of truth, and every committed value
 * has provenance. Deterministic and clock-free (any confirmation timestamp is
 * injected). The web shell is a thin client over this session.
 */
import type { IaPDocument, Kind } from '@iap/model';
import { apply, emptyDocument } from '@iap/intent-compiler';
import type {
  FieldProvenanceRecord,
  OperationBatch,
  OperationEnvelope,
  OperationType,
} from '@iap/intent-compiler';

export type EditResult =
  { ok: true; document: IaPDocument; yaml: string } | { ok: false; errors: string[] };

let counter = 0;
function opId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function envelope(
  type: OperationType,
  target: OperationEnvelope['target'],
  change?: unknown,
): OperationEnvelope {
  const op: OperationEnvelope = {
    operationId: opId(type.toLowerCase()),
    type,
    target,
    confidence: 0.95,
    assumptions: [],
    requiredClarifications: [],
    provenance: { source: 'explicit-user', channel: 'visual-designer' },
  };
  if (change !== undefined) op.change = change;
  return op;
}

function batch(...ops: OperationEnvelope[]): OperationBatch {
  return { apiVersion: 'operations.iap.dev/v1', operations: ops };
}

/** A stateful designer session over one document. */
export class DesignerSession {
  private doc: IaPDocument;
  private prov: FieldProvenanceRecord[] = [];

  constructor(documentName = 'infrastructure') {
    this.doc = emptyDocument(documentName);
  }

  get document(): IaPDocument {
    return this.doc;
  }

  /** Serialize the current document (round-trip YAML). */
  yaml(): string {
    // A no-op commit is not needed; keep the last serialized form by re-applying nothing.
    return this.lastYaml;
  }
  private lastYaml = 'apiVersion: iap.dev/v1\n';

  private async commit(b: OperationBatch): Promise<EditResult> {
    const result = await apply(this.doc, b, {});
    if (!result.ok) {
      return {
        ok: false,
        errors: result.refusals.map((r) => `${r.code}${r.path ? ` ${r.path}` : ''}: ${r.message}`),
      };
    }
    this.doc = result.result.document;
    this.prov = result.result.provenance;
    this.lastYaml = result.result.serialize('yaml');
    return { ok: true, document: this.doc, yaml: this.lastYaml };
  }

  /** Add a resource of `kind`. `spec` supplies any required fields (e.g. a Service artifact). */
  addResource(kind: Kind, id: string, spec: Record<string, unknown> = {}): Promise<EditResult> {
    return this.commit(
      batch(
        envelope(
          'CreateResource',
          { resourceId: id },
          { kind, ...(Object.keys(spec).length > 0 ? { spec } : {}) },
        ),
      ),
    );
  }

  /** Connect two resources with a relationship verb and optional access. */
  connect(from: string, to: string, verb = 'connectsTo', access?: string): Promise<EditResult> {
    const change: Record<string, unknown> = { type: verb, target: to };
    if (access !== undefined) change.access = access;
    return this.commit(batch(envelope('CreateRelationship', { resourceId: from }, change)));
  }

  /** Set a property on a resource (dot path under the resource). */
  setProperty(id: string, path: string, value: unknown): Promise<EditResult> {
    return this.commit(
      batch(envelope('UpdateResource', { resourceId: id }, { set: { [path]: value } })),
    );
  }

  /** Remove a resource. */
  remove(id: string): Promise<EditResult> {
    return this.commit(batch(envelope('RemoveResource', { resourceId: id })));
  }

  /** Property inspector: a resource's effective spec plus the provenance of its fields. */
  inspect(id: string): {
    kind: string | undefined;
    spec: unknown;
    provenance: FieldProvenanceRecord[];
  } {
    const resource = this.doc.resources[id] as { kind?: string; spec?: unknown } | undefined;
    return {
      kind: resource?.kind,
      spec: resource?.spec,
      provenance: this.prov.filter((p) => p.path.startsWith(`resources.${id}`)),
    };
  }
}
