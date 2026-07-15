/**
 * The Kubernetes migration importer (roadmap Phase 18, M18.1). Translates a set
 * of Kubernetes manifests into IaP THROUGH the operation gate, so the imported
 * result is validated IaP — never hand-assembled YAML. Constructs the importer
 * cannot faithfully map are reported as `unmapped`, never guessed into intent
 * (precision over recall). Terraform, CloudFormation, Pulumi, and Crossplane
 * importers implement the same `ImportResult` contract.
 */
import { parseAllDocuments } from 'yaml';
import type { IaPDocument, Kind } from '@iap/model';
import { apply, emptyDocument } from '@iap/intent-compiler';
import type { OperationBatch, OperationEnvelope } from '@iap/intent-compiler';

export interface ImportedResource {
  id: string;
  kind: Kind;
  from: string;
}

export interface UnmappedResource {
  from: string;
  reason: string;
}

export type ImportResult =
  | {
      ok: true;
      document: IaPDocument;
      yaml: string;
      imported: ImportedResource[];
      unmapped: UnmappedResource[];
    }
  | { ok: false; errors: string[]; unmapped: UnmappedResource[] };

interface K8sManifest {
  kind?: unknown;
  metadata?: { name?: unknown };
  spec?: Record<string, unknown>;
}

function toDnsLabel(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'resource'
  );
}

/** Extract the first container image from a workload pod template. */
function podImage(spec: Record<string, unknown> | undefined): string | undefined {
  const template = spec?.template as { spec?: { containers?: { image?: unknown }[] } } | undefined;
  const image = template?.spec?.containers?.[0]?.image;
  return typeof image === 'string' ? image : undefined;
}

let counter = 0;
function envelope(id: string, kind: Kind, spec: Record<string, unknown>): OperationEnvelope {
  counter += 1;
  return {
    operationId: `import-${id}-${counter}`,
    type: 'CreateResource',
    target: { resourceId: id },
    confidence: 0.95,
    assumptions: [],
    requiredClarifications: [],
    provenance: { source: 'explicit-user', channel: 'api' },
    change: { kind, ...(Object.keys(spec).length > 0 ? { spec } : {}) },
  } as OperationEnvelope;
}

/** Map one manifest to an IaP resource operation, or record it unmapped. */
function mapManifest(m: K8sManifest): {
  op?: OperationEnvelope;
  imported?: ImportedResource;
  unmapped?: UnmappedResource;
} {
  const k8sKind = typeof m.kind === 'string' ? m.kind : '';
  const name = typeof m.metadata?.name === 'string' ? m.metadata.name : undefined;
  if (name === undefined)
    return { unmapped: { from: k8sKind, reason: 'manifest has no metadata.name' } };
  const id = toDnsLabel(name);
  const from = `${k8sKind}/${name}`;

  switch (k8sKind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet': {
      const image = podImage(m.spec);
      if (image === undefined)
        return { unmapped: { from, reason: 'workload has no container image' } };
      return {
        op: envelope(id, 'Service', { artifact: { type: 'container-image', reference: image } }),
        imported: { id, kind: 'Service', from },
      };
    }
    case 'Job':
    case 'CronJob': {
      const jobSpec =
        k8sKind === 'CronJob'
          ? (m.spec?.jobTemplate as { spec?: Record<string, unknown> })?.spec
          : m.spec;
      const image = podImage(jobSpec);
      if (image === undefined) return { unmapped: { from, reason: 'job has no container image' } };
      return {
        op: envelope(id, 'Job', { artifact: { type: 'container-image', reference: image } }),
        imported: { id, kind: 'Job', from },
      };
    }
    case 'PersistentVolumeClaim': {
      const storage = (m.spec?.resources as { requests?: { storage?: unknown } })?.requests
        ?.storage;
      const spec = typeof storage === 'string' ? { capacity: { storage } } : {};
      return { op: envelope(id, 'Volume', spec), imported: { id, kind: 'Volume', from } };
    }
    case 'Ingress':
      return {
        op: envelope(id, 'Gateway', { exposure: 'public' }),
        imported: { id, kind: 'Gateway', from },
      };
    case 'Secret':
      return {
        op: envelope(id, 'Secret', { source: 'external' }),
        imported: { id, kind: 'Secret', from },
      };
    case 'ConfigMap':
      return {
        unmapped: {
          from,
          reason:
            'ConfigMap is configuration, not an IaP resource — fold values into the consuming workload',
        },
      };
    case 'Service':
      // A K8s Service is realized by IaP exposure/edges, not a standalone resource.
      return {
        unmapped: {
          from,
          reason:
            'Kubernetes Service maps to IaP exposure/relationships on the workload, not a resource',
        },
      };
    default:
      return { unmapped: { from, reason: `no IaP mapping for Kubernetes kind ${k8sKind}` } };
  }
}

/** Import Kubernetes manifest text (one or many YAML documents) into IaP. */
export async function importKubernetes(
  manifestText: string,
  documentName = 'imported',
): Promise<ImportResult> {
  const docs = parseAllDocuments(manifestText)
    .map((d) => d.toJS() as K8sManifest)
    .filter((d) => d !== null && typeof d === 'object');

  const ops: OperationEnvelope[] = [];
  const imported: ImportedResource[] = [];
  const unmapped: UnmappedResource[] = [];
  for (const m of docs) {
    const result = mapManifest(m);
    if (result.op !== undefined && result.imported !== undefined) {
      ops.push(result.op);
      imported.push(result.imported);
    } else if (result.unmapped !== undefined) {
      unmapped.push(result.unmapped);
    }
  }

  if (ops.length === 0) {
    return { ok: false, errors: ['no Kubernetes manifests mapped to IaP resources'], unmapped };
  }

  const batch: OperationBatch = { apiVersion: 'operations.iap.dev/v1', operations: ops };
  const committed = await apply(emptyDocument(documentName), batch, {});
  if (!committed.ok) {
    return {
      ok: false,
      errors: committed.refusals.map((r) => `${r.code}: ${r.message}`),
      unmapped,
    };
  }
  return {
    ok: true,
    document: committed.result.document,
    yaml: committed.result.serialize('yaml'),
    imported,
    unmapped,
  };
}
