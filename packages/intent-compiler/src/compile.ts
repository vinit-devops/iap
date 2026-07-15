/**
 * The deterministic facet compiler (M3.2): `(facets, currentDocument,
 * options) → proposal batch` for the M3.1 operation gate. A pure function —
 * no clock, no randomness, no floating-point arithmetic: operation ids and
 * resource ids derive from facet content; per-operation confidence is the
 * MINIMUM of the contributing facets' confidences (the aggregation rule —
 * a chain of evidence is only as strong as its weakest link, and `min` is a
 * comparison, never arithmetic).
 *
 * Honesty rules (roadmap §3.4):
 * - Anything defaulted without explicit user input becomes an `assumptions`
 *   entry on the writing operation — never silently confident. (Derived
 *   resource IDENTIFIERS are addressing, not intent: they surface in the
 *   preview diff and are not recorded as assumptions; assumed VALUES are.)
 * - Capabilities outside the v1 core vocabulary surface as explicit
 *   `UnsupportedFinding`s — never guessed into extensions (ch. 19 §19.7).
 * - Subject references that resolve to zero or several resources surface as
 *   `UnresolvedSubject` records for the clarification engine — never a guess.
 */

import type { IaPDocument, Kind, Policy, RelationshipEdge, ResourceEntry } from '@iap/model';
import type {
  ApplicationFacet,
  AvailabilityFacet,
  BackupFacet,
  BudgetFacet,
  ComplianceFacet,
  DataServiceFacet,
  EnvironmentFacet,
  ExistingResourceFacet,
  ExposureFacet,
  IdentityFacet,
  IntentFacet,
  MessagingFacet,
  NetworkingFacet,
  OperationalFacet,
  ProviderPreferenceFacet,
  RecoveryObjectiveFacet,
  RegionFacet,
  RemovalFacet,
  ScalingFacet,
  SecretFacet,
  SecurityFacet,
  SubjectRef,
  UnsupportedFinding,
  WorkloadFacet,
} from './facets.js';
import type {
  Assumption,
  OperationBatch,
  OperationEnvelope,
  OperationType,
  ProposalChannel,
  SourceSpan,
} from './operations.js';
import { OPERATIONS_API_VERSION } from './operations.js';

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

export interface CompileOptions {
  /** Authoring surface stamped into envelope provenance (default natural-language). */
  channel?: ProposalChannel;
  /** Audit-only adapter identity stamped into envelope provenance (OP-2: never influences application). */
  modelId?: string;
  /** Audit-only prompt version stamped into envelope provenance. */
  promptVersion?: string;
}

/** A subject reference the compiler could not resolve to exactly one resource. */
export interface UnresolvedSubject {
  /** What the facet referred to (resource id or kind name). */
  reference: string;
  /** Matching resource ids; empty when nothing matched. */
  candidates: string[];
  /** The operation emitted against the first candidate (ambiguous case only). */
  operationId?: string;
  sourceSpan?: SourceSpan;
}

export interface CompileResult {
  /** The proposal batch, or null when no operations were derivable. */
  batch: OperationBatch | null;
  /** Capabilities the facets requested that v1 core vocabulary cannot express. */
  unsupported: UnsupportedFinding[];
  /** Subject references needing clarification before they can be trusted. */
  unresolved: UnresolvedSubject[];
}

/* ------------------------------------------------------------------ */
/* Deterministic vocabulary tables                                     */
/* ------------------------------------------------------------------ */

/** Default resource identifiers per created construct (deterministic addressing, not intent). */
export const DEFAULT_RESOURCE_IDS: Readonly<Record<string, string>> = {
  Service: 'app',
  Job: 'job',
  Function: 'fn',
  Gateway: 'edge',
  Database: 'db',
  Cache: 'cache',
  ObjectStore: 'store',
  Volume: 'data',
  Queue: 'queue',
  Topic: 'events',
  Identity: 'app-identity',
  Secret: 'app-secret',
  Application: 'application',
};

/** Kinds carrying `spec.availability` (ch. 3 field tables). */
const AVAILABILITY_KINDS: readonly Kind[] = ['Service', 'Database', 'Cache'];
/** Kinds carrying `spec.resilience` (ch. 3 §3.2.6 per-kind defaults). */
const RESILIENCE_KINDS: readonly Kind[] = ['Database', 'Volume', 'ObjectStore'];
/** Kinds carrying `spec.observability` (ch. 3 §3.2.5). */
const OBSERVABILITY_KINDS: readonly Kind[] = [
  'Service',
  'Job',
  'Function',
  'Gateway',
  'Database',
  'Cache',
  'ObjectStore',
  'Queue',
  'Topic',
];
/** Kinds carrying `spec.encryption` (ch. 3 §3.2.4). */
const ENCRYPTION_KINDS: readonly Kind[] = [
  'Service',
  'Database',
  'Cache',
  'ObjectStore',
  'Volume',
  'Queue',
  'Topic',
];

/** Exposure values each kind permits (ch. 3 per-kind field tables). */
const EXPOSURE_VALUES: Readonly<Partial<Record<Kind, readonly string[]>>> = {
  Service: ['public', 'internal', 'private'],
  Gateway: ['public', 'internal'],
  Database: ['private', 'internal'],
  Cache: ['private', 'internal'],
  ObjectStore: ['private', 'public'],
};

/** The most restrictive exposure each exposable kind permits (§3.2.2: default = most restrictive). */
const MOST_RESTRICTIVE_EXPOSURE: Readonly<Partial<Record<Kind, string>>> = {
  Service: 'private',
  Gateway: 'internal',
  Database: 'private',
  Cache: 'private',
  ObjectStore: 'private',
};

/** Kinds whose default exposure is public (only Gateway, ch. 3 §3.8). */
const DEFAULT_PUBLIC_KINDS: readonly Kind[] = ['Gateway'];

interface CompliancePolicySpec {
  idSuffix: string;
  description: string;
  kinds: Kind[];
  rule: { field: string; operator: string; value?: unknown };
  effect: 'deny' | 'warn' | 'require';
}

/** Framework id slugs conforming to the policy-id grammar (dots are not DNS-label characters). */
const FRAMEWORK_SLUGS: Readonly<Record<string, string>> = {
  soc2: 'soc2',
  'pci-dss-4.0': 'pci-dss',
  hipaa: 'hipaa',
  'iso27001-2022': 'iso27001',
  'nist-800-53-r5': 'nist-800-53',
  'cis-8.0': 'cis',
};

// Effect semantics (ch. 7): `require` is violated when the rule does NOT
// hold; `deny` is violated when it DOES (the rule describes the forbidden
// state). Both produce error-severity findings.
const ENCRYPTION_AT_REST: CompliancePolicySpec = {
  idSuffix: 'encryption-at-rest',
  description: 'Data services must require encryption at rest',
  kinds: ['Database', 'Cache', 'ObjectStore', 'Volume', 'Queue', 'Topic'],
  rule: { field: 'spec.encryption.atRest', operator: 'equals', value: 'required' },
  effect: 'require',
};
const ENCRYPTION_IN_TRANSIT: CompliancePolicySpec = {
  idSuffix: 'encryption-in-transit',
  description: 'Data services must require encryption in transit',
  kinds: ['Database', 'Cache', 'ObjectStore', 'Volume', 'Queue', 'Topic'],
  rule: { field: 'spec.encryption.inTransit', operator: 'equals', value: 'required' },
  effect: 'require',
};
const NO_PUBLIC_DATA: CompliancePolicySpec = {
  idSuffix: 'no-public-data-stores',
  description: 'Data stores must not be publicly exposed',
  kinds: ['Database', 'Cache', 'ObjectStore'],
  rule: { field: 'spec.exposure', operator: 'equals', value: 'public' },
  effect: 'deny',
};
const BACKUP_REQUIRED: CompliancePolicySpec = {
  idSuffix: 'backup-required',
  description: 'Durable data must require backups',
  kinds: ['Database', 'Volume'],
  rule: { field: 'spec.resilience.backup', operator: 'equals', value: 'required' },
  effect: 'require',
};

/** Deterministic per-framework control sets (closed; ch. 17 frameworks). */
const COMPLIANCE_POLICIES: Readonly<Record<string, readonly CompliancePolicySpec[]>> = {
  'pci-dss-4.0': [ENCRYPTION_AT_REST, ENCRYPTION_IN_TRANSIT, NO_PUBLIC_DATA, BACKUP_REQUIRED],
  soc2: [ENCRYPTION_AT_REST, BACKUP_REQUIRED],
  hipaa: [ENCRYPTION_AT_REST, ENCRYPTION_IN_TRANSIT, BACKUP_REQUIRED],
  'iso27001-2022': [ENCRYPTION_AT_REST, BACKUP_REQUIRED],
  'nist-800-53-r5': [ENCRYPTION_AT_REST, NO_PUBLIC_DATA],
  'cis-8.0': [ENCRYPTION_AT_REST],
};

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function minConfidence(values: number[]): number {
  let lowest = 1;
  for (const value of values) if (value < lowest) lowest = value;
  return lowest;
}

function setDeep(target: JsonObject, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = current[segment];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      current = next as JsonObject;
    } else {
      const fresh: JsonObject = {};
      current[segment] = fresh;
      current = fresh;
    }
  }
  current[segments[segments.length - 1] as string] = value;
}

interface CreationRecord {
  id: string;
  kind: Kind;
  /** Entry payload under construction; `spec` filled via `setDeep`. */
  change: JsonObject;
  confidences: number[];
  assumptions: Assumption[];
  span: SourceSpan;
}

type SubjectResolution =
  | { status: 'resolved'; id: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'missing' };

function subjectLabel(ref: SubjectRef): string {
  return ref.resourceId ?? ref.kind ?? 'unknown';
}

class Compiler {
  private readonly opIds = new Set<string>();
  private readonly resourceIds = new Set<string>();
  readonly creations: CreationRecord[] = [];
  readonly unsupported: UnsupportedFinding[] = [];
  readonly unresolved: UnresolvedSubject[] = [];
  /** Pending update payloads keyed by resource id. */
  readonly updates = new Map<
    string,
    {
      set: Record<string, unknown>;
      confidences: number[];
      assumptions: Assumption[];
      span: SourceSpan;
    }
  >();

  constructor(
    readonly document: IaPDocument,
    private readonly channel: ProposalChannel,
    private readonly modelId: string | undefined,
    private readonly promptVersion: string | undefined,
  ) {
    for (const id of Object.keys(document.resources ?? {})) this.resourceIds.add(id);
  }

  /** Deterministic operation id: content-derived slug, `-2`/`-3`… on collision. */
  operationId(slug: string): string {
    let candidate = slug;
    let counter = 2;
    while (this.opIds.has(candidate)) {
      candidate = `${slug}-${counter}`;
      counter += 1;
    }
    this.opIds.add(candidate);
    return candidate;
  }

  /** Deterministic resource id: desired name, `-2`/`-3`… on collision with document or batch. */
  resourceId(desired: string): string {
    let candidate = desired;
    let counter = 2;
    while (this.resourceIds.has(candidate)) {
      candidate = `${desired}-${counter}`;
      counter += 1;
    }
    this.resourceIds.add(candidate);
    return candidate;
  }

  envelope(
    idSlug: string,
    type: OperationType,
    target: OperationEnvelope['target'],
    change: unknown,
    detail: { confidences: number[]; span?: SourceSpan; assumptions?: Assumption[] },
  ): OperationEnvelope {
    const provenance: OperationEnvelope['provenance'] = {
      source: 'explicit-user',
      channel: this.channel,
    };
    if (this.modelId !== undefined) provenance.modelId = this.modelId;
    if (this.promptVersion !== undefined) provenance.promptVersion = this.promptVersion;
    const envelope: OperationEnvelope = {
      operationId: this.operationId(idSlug),
      type,
      target,
      confidence: minConfidence(detail.confidences),
      assumptions: detail.assumptions ?? [],
      requiredClarifications: [],
      provenance,
    };
    if (change !== undefined) envelope.change = change;
    if (detail.span !== undefined) envelope.sourceSpan = { ...detail.span };
    return envelope;
  }

  createdOfKind(kinds: readonly Kind[]): CreationRecord[] {
    return this.creations.filter((record) => kinds.includes(record.kind));
  }

  existingOfKind(kinds: readonly Kind[]): string[] {
    return Object.keys(this.document.resources ?? {})
      .filter((id) => kinds.includes((this.document.resources[id] as ResourceEntry).kind))
      .sort();
  }

  /**
   * Resolve a subject reference: explicit id first, then unique-kind match
   * over batch creations and the existing document. Zero or several matches
   * are reported, never guessed (§3.3 unresolved-reference trigger).
   */
  resolveSubject(ref: SubjectRef): SubjectResolution {
    if (ref.resourceId !== undefined) {
      if (
        this.creations.some((record) => record.id === ref.resourceId) ||
        this.document.resources?.[ref.resourceId] !== undefined
      ) {
        return { status: 'resolved', id: ref.resourceId };
      }
      if (ref.kind === undefined) return { status: 'missing' };
    }
    if (ref.kind !== undefined) {
      const kind = ref.kind;
      const createdIds = this.creations
        .filter((record) => record.kind === kind)
        .map((record) => record.id);
      const existingIds = this.existingOfKind([kind]).filter((id) => !createdIds.includes(id));
      const candidates = [...createdIds, ...existingIds];
      if (candidates.length === 1) return { status: 'resolved', id: candidates[0] as string };
      if (candidates.length > 1) return { status: 'ambiguous', candidates };
    }
    return { status: 'missing' };
  }

  creationById(id: string): CreationRecord | undefined {
    return this.creations.find((record) => record.id === id);
  }

  /** Fold a field write into a batch creation or accumulate an update on an existing resource. */
  fold(
    id: string,
    path: string,
    value: unknown,
    facet: IntentFacet,
    assumption?: Assumption,
  ): void {
    const creation = this.creationById(id);
    if (creation !== undefined) {
      setDeep(creation.change, path, value);
      creation.confidences.push(facet.confidence);
      if (assumption !== undefined) creation.assumptions.push(assumption);
      return;
    }
    let pending = this.updates.get(id);
    if (pending === undefined) {
      pending = { set: {}, confidences: [], assumptions: [], span: facet.sourceSpan };
      this.updates.set(id, pending);
    }
    pending.set[path] = value;
    pending.confidences.push(facet.confidence);
    if (assumption !== undefined) pending.assumptions.push(assumption);
  }
}

/* ------------------------------------------------------------------ */
/* The compiler                                                        */
/* ------------------------------------------------------------------ */

function byType<T extends IntentFacet>(facets: IntentFacet[], type: T['facet']): T[] {
  return facets.filter((facet) => facet.facet === type) as T[];
}

function workloadCreation(compiler: Compiler, facet: WorkloadFacet): void {
  const id = compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS[facet.workload] as string));
  const change: JsonObject = { kind: facet.workload };
  const record: CreationRecord = {
    id,
    kind: facet.workload,
    change,
    confidences: [facet.confidence],
    assumptions: [],
    span: facet.sourceSpan,
  };
  if (facet.artifact !== undefined && facet.workload !== 'Gateway') {
    setDeep(change, 'spec.artifact', { type: 'container-image', reference: facet.artifact });
  }
  if (facet.schedule !== undefined && facet.workload === 'Job') {
    setDeep(change, 'spec.schedule', facet.schedule);
  }
  compiler.creations.push(record);
}

function dataServiceCreation(compiler: Compiler, facet: DataServiceFacet): void {
  if (facet.service === 'database') {
    const id = compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS.Database as string));
    const change: JsonObject = { kind: 'Database' };
    const record: CreationRecord = {
      id,
      kind: 'Database',
      change,
      confidences: [facet.confidence],
      assumptions: [],
      span: facet.sourceSpan,
    };
    if (facet.databaseClass !== undefined) {
      setDeep(change, 'spec.class', facet.databaseClass);
    } else {
      setDeep(change, 'spec.class', 'relational');
      record.assumptions.push({
        field: 'spec.class',
        assumed: 'relational',
        reason: 'database class not stated; relational is the deterministic default',
      });
    }
    if (facet.engine !== undefined) setDeep(change, 'spec.engine', facet.engine);
    if (facet.engineVersion !== undefined)
      setDeep(change, 'spec.engineVersion', facet.engineVersion);
    if (facet.storage !== undefined) setDeep(change, 'spec.capacity.storage', facet.storage);
    compiler.creations.push(record);
    return;
  }
  if (facet.service === 'cache') {
    const id = compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS.Cache as string));
    const change: JsonObject = { kind: 'Cache' };
    const record: CreationRecord = {
      id,
      kind: 'Cache',
      change,
      confidences: [facet.confidence],
      assumptions: [],
      span: facet.sourceSpan,
    };
    if (facet.engine !== undefined) {
      setDeep(change, 'spec.engine', facet.engine);
    } else {
      setDeep(change, 'spec.engine', 'redis-compatible');
      record.assumptions.push({
        field: 'spec.engine',
        assumed: 'redis-compatible',
        reason: 'cache engine not stated; redis-compatible is the deterministic default',
      });
    }
    compiler.creations.push(record);
    return;
  }
  if (facet.service === 'object-store') {
    const id = compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS.ObjectStore as string));
    compiler.creations.push({
      id,
      kind: 'ObjectStore',
      change: { kind: 'ObjectStore' },
      confidences: [facet.confidence],
      assumptions: [],
      span: facet.sourceSpan,
    });
    return;
  }
  // volume
  const id = compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS.Volume as string));
  const change: JsonObject = { kind: 'Volume' };
  const record: CreationRecord = {
    id,
    kind: 'Volume',
    change,
    confidences: [facet.confidence],
    assumptions: [],
    span: facet.sourceSpan,
  };
  if (facet.storage !== undefined) {
    setDeep(change, 'spec.capacity.storage', facet.storage);
  } else {
    setDeep(change, 'spec.capacity.storage', '10Gi');
    record.assumptions.push({
      field: 'spec.capacity.storage',
      assumed: '10Gi',
      reason: 'volume size not stated; 10Gi is the deterministic default',
    });
  }
  compiler.creations.push(record);
}

/** Verb connecting a workload to a data service (ch. 3 relationship guidance). */
function verbForService(service: DataServiceFacet['service']): 'connectsTo' | 'storesDataIn' {
  return service === 'object-store' || service === 'volume' ? 'storesDataIn' : 'connectsTo';
}

/** Resolve a modifier facet's targets: explicit subject, else created resources of the applicable kinds, else existing ones. */
function modifierTargets(
  compiler: Compiler,
  subject: SubjectRef | undefined,
  applicableKinds: readonly Kind[],
  facet: IntentFacet,
): string[] {
  if (subject !== undefined) {
    const resolution = compiler.resolveSubject(subject);
    if (resolution.status === 'resolved') return [resolution.id];
    if (resolution.status === 'ambiguous') {
      // Target the first candidate deterministically and report the ambiguity;
      // the clarification engine turns the report into a retargeting question.
      compiler.unresolved.push({
        reference: subjectLabel(subject),
        candidates: resolution.candidates,
        sourceSpan: facet.sourceSpan,
      });
      return [resolution.candidates[0] as string];
    }
    compiler.unresolved.push({
      reference: subjectLabel(subject),
      candidates: [],
      sourceSpan: facet.sourceSpan,
    });
    return [];
  }
  const created = compiler.createdOfKind(applicableKinds).map((record) => record.id);
  if (created.length > 0) return created;
  return compiler.existingOfKind(applicableKinds);
}

function kindOf(compiler: Compiler, id: string): Kind | undefined {
  return (
    compiler.creationById(id)?.kind ??
    (compiler.document.resources?.[id] as ResourceEntry | undefined)?.kind
  );
}

function applyBackup(
  compiler: Compiler,
  facet: BackupFacet,
  recovery: RecoveryObjectiveFacet[],
): void {
  const targets = modifierTargets(compiler, facet.subject, RESILIENCE_KINDS, facet);
  for (const id of targets) {
    if (!RESILIENCE_KINDS.includes(kindOf(compiler, id) as Kind)) continue;
    const value = facet.backup ?? 'required';
    compiler.fold(id, 'spec.resilience.backup', value, facet);
    if (facet.disasterRecovery === true) {
      const rpo = recovery.find((entry) => entry.rpo !== undefined)?.rpo;
      const rto = recovery.find((entry) => entry.rto !== undefined)?.rto;
      if (rpo === undefined) {
        compiler.fold(id, 'spec.resilience.recoveryPointObjective', '1d', facet, {
          field: 'spec.resilience.recoveryPointObjective',
          assumed: '1d',
          reason: 'disaster recovery requested without an RPO; 1d is the deterministic default',
        });
      }
      if (rto === undefined) {
        compiler.fold(id, 'spec.resilience.recoveryTimeObjective', '4h', facet, {
          field: 'spec.resilience.recoveryTimeObjective',
          assumed: '4h',
          reason: 'disaster recovery requested without an RTO; 4h is the deterministic default',
        });
      }
    }
  }
}

function applyRemovePublicAccess(compiler: Compiler, facet: NetworkingFacet): void {
  const resources = compiler.document.resources ?? {};
  for (const id of Object.keys(resources).sort()) {
    const entry = resources[id] as ResourceEntry;
    const spec = entry.spec as JsonObject | undefined;
    const authored = spec?.exposure;
    const effectivelyPublic =
      authored === 'public' ||
      (authored === undefined && DEFAULT_PUBLIC_KINDS.includes(entry.kind));
    if (!effectivelyPublic) continue;
    const restrictive = MOST_RESTRICTIVE_EXPOSURE[entry.kind];
    if (restrictive === undefined) continue;
    compiler.fold(id, 'spec.exposure', restrictive, facet);
  }
}

/**
 * Compile intent facets into an IEP-0009 proposal batch against the current
 * document. Pure and deterministic: the same facets, document, and options
 * produce a deeply identical batch.
 */
export function compileFacets(
  facets: IntentFacet[],
  document: IaPDocument,
  options: CompileOptions = {},
): CompileResult {
  const compiler = new Compiler(
    document,
    options.channel ?? 'natural-language',
    options.modelId,
    options.promptVersion,
  );

  const workloads = byType<WorkloadFacet>(facets, 'workload');
  const dataServices = byType<DataServiceFacet>(facets, 'data-service');
  const messaging = byType<MessagingFacet>(facets, 'messaging');
  const identities = byType<IdentityFacet>(facets, 'identity');
  const secrets = byType<SecretFacet>(facets, 'secret');
  const environments = byType<EnvironmentFacet>(facets, 'environment');
  const applications = byType<ApplicationFacet>(facets, 'application');
  const networking = byType<NetworkingFacet>(facets, 'networking');
  const exposures = byType<ExposureFacet>(facets, 'exposure');
  const availabilities = byType<AvailabilityFacet>(facets, 'availability');
  const scalings = byType<ScalingFacet>(facets, 'scaling');
  const regions = byType<RegionFacet>(facets, 'region');
  const backups = byType<BackupFacet>(facets, 'backup');
  const recoveries = byType<RecoveryObjectiveFacet>(facets, 'recovery-objective');
  const securities = byType<SecurityFacet>(facets, 'security');
  const compliances = byType<ComplianceFacet>(facets, 'compliance');
  const budgets = byType<BudgetFacet>(facets, 'budget');
  const operationals = byType<OperationalFacet>(facets, 'operational');
  const providers = byType<ProviderPreferenceFacet>(facets, 'provider-preference');
  const existing = byType<ExistingResourceFacet>(facets, 'existing-resource');
  const removals = byType<RemovalFacet>(facets, 'removal');

  /* -- Creations ---------------------------------------------------- */
  for (const facet of workloads) workloadCreation(compiler, facet);
  for (const facet of dataServices) dataServiceCreation(compiler, facet);
  for (const facet of messaging) {
    const kind: Kind = facet.messaging === 'topic' ? 'Topic' : 'Queue';
    const fallback =
      facet.messaging === 'unspecified' ? 'messages' : (DEFAULT_RESOURCE_IDS[kind] as string);
    compiler.creations.push({
      id: compiler.resourceId(facet.name ?? fallback),
      kind,
      change: { kind },
      confidences: [facet.confidence],
      assumptions:
        facet.messaging === 'unspecified'
          ? [
              {
                field: 'kind',
                assumed: 'Queue',
                reason:
                  'queue-vs-topic not determinable from the request; point-to-point queue is the deterministic default',
              },
            ]
          : [],
      span: facet.sourceSpan,
    });
  }
  for (const facet of identities) {
    compiler.creations.push({
      id: compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS.Identity as string)),
      kind: 'Identity',
      change: { kind: 'Identity' },
      confidences: [facet.confidence],
      assumptions: [],
      span: facet.sourceSpan,
    });
  }
  for (const facet of secrets) {
    const change: JsonObject = { kind: 'Secret' };
    if (facet.rotation === true) setDeep(change, 'spec.rotation.policy', 'required');
    compiler.creations.push({
      id: compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS.Secret as string)),
      kind: 'Secret',
      change,
      confidences: [facet.confidence],
      assumptions: [],
      span: facet.sourceSpan,
    });
  }

  /* -- Modifier facets ---------------------------------------------- */
  for (const facet of exposures) {
    let targets: string[];
    if (facet.subject !== undefined) {
      targets = modifierTargets(compiler, facet.subject, [], facet);
    } else {
      // Global exposure applies to the entry point: a created Gateway first,
      // else the created workloads, else the sole existing Gateway/Service.
      const createdGateways = compiler.createdOfKind(['Gateway']);
      const createdWorkloads = compiler.createdOfKind(['Service', 'Job', 'Function']);
      if (createdGateways.length > 0) targets = createdGateways.map((record) => record.id);
      else if (createdWorkloads.length > 0) targets = createdWorkloads.map((record) => record.id);
      else {
        const gateways = compiler.existingOfKind(['Gateway']);
        targets = gateways.length > 0 ? gateways : compiler.existingOfKind(['Service']);
      }
    }
    for (const id of targets) {
      const kind = kindOf(compiler, id);
      if (kind === undefined) continue;
      const allowed = EXPOSURE_VALUES[kind];
      if (allowed === undefined) continue;
      if (allowed.includes(facet.exposure)) {
        compiler.fold(id, 'spec.exposure', facet.exposure, facet);
      } else if (kind === 'Gateway' && facet.exposure === 'private') {
        compiler.fold(id, 'spec.exposure', 'internal', facet, {
          field: 'spec.exposure',
          assumed: 'internal',
          reason:
            'a Gateway cannot be private (ch. 3 §3.8); internal is its most restrictive exposure',
        });
      } else {
        compiler.unsupported.push({
          capability: `${kind} exposure ${facet.exposure}`,
          sourceSpan: facet.sourceSpan,
          reason: `${kind} permits exposure values ${allowed.join('/')} only (ch. 3)`,
        });
      }
    }
  }

  for (const facet of availabilities) {
    for (const id of modifierTargets(compiler, facet.subject, AVAILABILITY_KINDS, facet)) {
      if (!AVAILABILITY_KINDS.includes(kindOf(compiler, id) as Kind)) continue;
      compiler.fold(id, 'spec.availability', facet.availability, facet);
    }
  }
  for (const facet of regions) {
    if (facet.regions !== undefined) {
      for (const region of facet.regions) {
        compiler.unsupported.push({
          capability: `region ${region}`,
          sourceSpan: facet.sourceSpan,
          reason:
            'named provider regions are provider-specific; v1 core vocabulary expresses geography as availability intent only',
          suggestion: 'availability: maximum (multi-region-capable, ch. 3 §3.2.1)',
        });
      }
    }
    if (facet.multiRegion === true) {
      for (const id of modifierTargets(compiler, undefined, AVAILABILITY_KINDS, facet)) {
        compiler.fold(id, 'spec.availability', 'maximum', facet);
      }
    }
  }

  for (const facet of scalings) {
    const targets = modifierTargets(compiler, facet.subject, ['Service'], facet);
    for (const id of targets) {
      if (kindOf(compiler, id) !== 'Service') continue;
      if (facet.min !== undefined || facet.max !== undefined) {
        if (facet.min !== undefined) compiler.fold(id, 'spec.scaling.min', facet.min, facet);
        if (facet.max !== undefined) compiler.fold(id, 'spec.scaling.max', facet.max, facet);
      } else {
        compiler.fold(id, 'spec.scaling.min', 1, facet, {
          field: 'spec.scaling.min',
          assumed: 1,
          reason: 'scaling requested without a range; 1 is the deterministic minimum',
        });
        compiler.fold(id, 'spec.scaling.max', 4, facet, {
          field: 'spec.scaling.max',
          assumed: 4,
          reason: 'scaling requested without a range; 4 is the deterministic maximum',
        });
      }
    }
  }

  for (const facet of backups) applyBackup(compiler, facet, recoveries);
  for (const facet of recoveries) {
    for (const id of modifierTargets(compiler, facet.subject, RESILIENCE_KINDS, facet)) {
      if (!RESILIENCE_KINDS.includes(kindOf(compiler, id) as Kind)) continue;
      if (facet.rpo !== undefined) {
        compiler.fold(id, 'spec.resilience.recoveryPointObjective', facet.rpo, facet);
      }
      if (facet.rto !== undefined) {
        compiler.fold(id, 'spec.resilience.recoveryTimeObjective', facet.rto, facet);
      }
    }
  }

  for (const facet of securities) {
    if (facet.requirement === 'tls-minimum-1.3') {
      for (const id of modifierTargets(compiler, facet.subject, ['Gateway'], facet)) {
        if (kindOf(compiler, id) !== 'Gateway') continue;
        compiler.fold(id, 'spec.tls.minimumVersion', '1.3', facet);
      }
      continue;
    }
    for (const id of modifierTargets(compiler, facet.subject, ENCRYPTION_KINDS, facet)) {
      if (!ENCRYPTION_KINDS.includes(kindOf(compiler, id) as Kind)) continue;
      if (facet.requirement !== 'encryption-in-transit') {
        compiler.fold(id, 'spec.encryption.atRest', 'required', facet);
      }
      if (facet.requirement !== 'encryption-at-rest') {
        compiler.fold(id, 'spec.encryption.inTransit', 'required', facet);
      }
    }
  }

  for (const facet of operationals) {
    for (const id of modifierTargets(compiler, undefined, OBSERVABILITY_KINDS, facet)) {
      if (!OBSERVABILITY_KINDS.includes(kindOf(compiler, id) as Kind)) continue;
      compiler.fold(
        id,
        `spec.observability.${facet.requirement}`,
        facet.level ?? 'required',
        facet,
      );
    }
  }

  for (const facet of networking) {
    if (facet.intent === 'remove-public-access') applyRemovePublicAccess(compiler, facet);
  }

  /* -- Existing-resource constraints -------------------------------- */
  for (const facet of existing) {
    const resolution = compiler.resolveSubject({ resourceId: facet.reference });
    if (resolution.status !== 'resolved') {
      compiler.unresolved.push({
        reference: facet.reference,
        candidates: [],
        sourceSpan: facet.sourceSpan,
      });
    }
  }

  /* -- Assemble operations ------------------------------------------ */
  const ops: OperationEnvelope[] = [];
  const resources = document.resources ?? {};

  // Removals: edges referencing the removed resource first, then the resource.
  for (const facet of removals) {
    const resolution = compiler.resolveSubject(facet.subject);
    let removedId: string | undefined;
    if (resolution.status === 'resolved') {
      removedId = resolution.id;
    } else if (resolution.status === 'ambiguous') {
      removedId = resolution.candidates[0] as string;
    } else {
      compiler.unresolved.push({
        reference: subjectLabel(facet.subject),
        candidates: [],
        sourceSpan: facet.sourceSpan,
      });
      continue;
    }
    if (resources[removedId] === undefined) {
      compiler.unresolved.push({
        reference: subjectLabel(facet.subject),
        candidates: [],
        sourceSpan: facet.sourceSpan,
      });
      continue;
    }
    for (const sourceId of Object.keys(resources).sort()) {
      if (sourceId === removedId) continue;
      const entry = resources[sourceId] as ResourceEntry;
      const edges: RelationshipEdge[] = entry.relationships ?? [];
      for (const edge of edges) {
        if (edge.target !== removedId) continue;
        ops.push(
          compiler.envelope(
            `op-remove-edge-${sourceId}-${removedId}`,
            'RemoveRelationship',
            { resourceId: sourceId, relationship: { type: edge.type, target: removedId } },
            undefined,
            { confidences: [facet.confidence], span: facet.sourceSpan },
          ),
        );
      }
      // Application membership referencing the removed resource would leave
      // a dangling component (IAP2xx); restate the filtered array (arrays
      // replace wholesale).
      const components = (entry.spec as JsonObject | undefined)?.components;
      if (
        entry.kind === 'Application' &&
        Array.isArray(components) &&
        components.includes(removedId)
      ) {
        ops.push(
          compiler.envelope(
            `op-update-${sourceId}-components`,
            'UpdateResource',
            { resourceId: sourceId },
            { set: { 'spec.components': components.filter((member) => member !== removedId) } },
            { confidences: [facet.confidence], span: facet.sourceSpan },
          ),
        );
      }
    }
    const removeOp = compiler.envelope(
      `op-remove-${removedId}`,
      'RemoveResource',
      { resourceId: removedId },
      undefined,
      { confidences: [facet.confidence], span: facet.sourceSpan },
    );
    ops.push(removeOp);
    if (resolution.status === 'ambiguous') {
      compiler.unresolved.push({
        reference: subjectLabel(facet.subject),
        candidates: resolution.candidates,
        operationId: removeOp.operationId,
        sourceSpan: facet.sourceSpan,
      });
    }
  }

  // Creations, in derivation order.
  for (const record of compiler.creations) {
    ops.push(
      compiler.envelope(
        `op-create-${record.id}`,
        'CreateResource',
        { resourceId: record.id },
        record.change,
        { confidences: record.confidences, span: record.span, assumptions: record.assumptions },
      ),
    );
  }

  // Application grouping (after member creations so components are known).
  for (const facet of applications) {
    const components = compiler.creations
      .map((record) => record.id)
      .filter((id) => kindOf(compiler, id) !== 'Application')
      .sort();
    const members = components.length > 0 ? components : Object.keys(resources).sort();
    if (members.length === 0) {
      compiler.unresolved.push({
        reference: 'application components',
        candidates: [],
        sourceSpan: facet.sourceSpan,
      });
      continue;
    }
    const id = compiler.resourceId(facet.name ?? (DEFAULT_RESOURCE_IDS.Application as string));
    ops.push(
      compiler.envelope(
        `op-create-${id}`,
        'CreateResource',
        { resourceId: id },
        { kind: 'Application', spec: { components: members } },
        {
          confidences: [facet.confidence],
          span: facet.sourceSpan,
          assumptions: [
            {
              field: 'spec.components',
              assumed: members,
              reason: 'membership not stated; grouped the resources authored in this request',
            },
          ],
        },
      ),
    );
  }

  // Updates on existing resources (one operation per resource, minimal diff).
  const sortedUpdates = [...compiler.updates.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [id, pending] of sortedUpdates) {
    ops.push(
      compiler.envelope(
        `op-update-${id}`,
        'UpdateResource',
        { resourceId: id },
        { set: pending.set },
        {
          confidences: pending.confidences,
          span: pending.span,
          assumptions: pending.assumptions,
        },
      ),
    );
  }

  // Relationships: explicit networking intent, then attach-to, then inferred association.
  const emittedEdges = new Set<string>();
  const edgeExists = (source: string, type: string, target: string): boolean => {
    const key = `${source}|${type}|${target}`;
    if (emittedEdges.has(key)) return true;
    const entry = resources[source] as ResourceEntry | undefined;
    return (entry?.relationships ?? []).some(
      (edge) => edge.type === type && edge.target === target,
    );
  };
  const pushEdge = (
    source: string,
    type: string,
    target: string,
    facet: IntentFacet,
    confidences: number[],
  ): void => {
    if (edgeExists(source, type, target)) return;
    emittedEdges.add(`${source}|${type}|${target}`);
    ops.push(
      compiler.envelope(
        `op-${type.toLowerCase()}-${source}-${target}`,
        'CreateRelationship',
        { resourceId: source },
        { type, target },
        { confidences, span: facet.sourceSpan },
      ),
    );
  };
  const soleCreatedWorkload = (): CreationRecord | undefined => {
    const created = compiler.createdOfKind(['Service', 'Job', 'Function']);
    return created.length === 1 ? created[0] : undefined;
  };

  const EDGE_VERBS: Record<string, string> = {
    connect: 'connectsTo',
    route: 'routesTo',
    publish: 'publishesTo',
    consume: 'consumesFrom',
    store: 'storesDataIn',
  };
  for (const facet of networking) {
    if (facet.intent === 'remove-public-access') continue;
    const verb = EDGE_VERBS[facet.intent] as string;
    const defaultFrom =
      facet.intent === 'route'
        ? { kind: 'Gateway' as Kind }
        : soleCreatedWorkload() !== undefined
          ? { resourceId: (soleCreatedWorkload() as CreationRecord).id }
          : { kind: 'Service' as Kind };
    const fromRef = facet.from ?? defaultFrom;
    const toRef = facet.to ?? (facet.intent === 'route' ? { kind: 'Service' as Kind } : undefined);
    if (toRef === undefined) {
      compiler.unresolved.push({
        reference: `${facet.intent} target`,
        candidates: [],
        sourceSpan: facet.sourceSpan,
      });
      continue;
    }
    const from = compiler.resolveSubject(fromRef);
    const to = compiler.resolveSubject(toRef);
    if (from.status === 'missing' || to.status === 'missing') {
      compiler.unresolved.push({
        reference: subjectLabel(from.status === 'missing' ? fromRef : toRef),
        candidates: [],
        sourceSpan: facet.sourceSpan,
      });
      continue;
    }
    const fromId = from.status === 'resolved' ? from.id : (from.candidates[0] as string);
    const toId = to.status === 'resolved' ? to.id : (to.candidates[0] as string);
    pushEdge(fromId, verb, toId, facet, [facet.confidence]);
    const lastOp = ops[ops.length - 1] as OperationEnvelope;
    if (from.status === 'ambiguous') {
      compiler.unresolved.push({
        reference: subjectLabel(fromRef),
        candidates: from.candidates,
        operationId: lastOp.operationId,
        sourceSpan: facet.sourceSpan,
      });
    }
    if (to.status === 'ambiguous') {
      compiler.unresolved.push({
        reference: subjectLabel(toRef),
        candidates: to.candidates,
        operationId: lastOp.operationId,
        sourceSpan: facet.sourceSpan,
      });
    }
  }

  for (const facet of dataServices) {
    if (facet.attachTo === undefined) continue;
    const serviceRecord = compiler.creations.find((record) => record.span === facet.sourceSpan);
    if (serviceRecord === undefined) continue;
    const resolution = compiler.resolveSubject(facet.attachTo);
    if (resolution.status === 'missing') {
      compiler.unresolved.push({
        reference: subjectLabel(facet.attachTo),
        candidates: [],
        sourceSpan: facet.sourceSpan,
      });
      continue;
    }
    const fromId =
      resolution.status === 'resolved' ? resolution.id : (resolution.candidates[0] as string);
    pushEdge(fromId, verbForService(facet.service), serviceRecord.id, facet, [facet.confidence]);
    if (resolution.status === 'ambiguous') {
      const lastOp = ops[ops.length - 1] as OperationEnvelope;
      compiler.unresolved.push({
        reference: subjectLabel(facet.attachTo),
        candidates: resolution.candidates,
        operationId: lastOp.operationId,
        sourceSpan: facet.sourceSpan,
      });
    }
  }

  // Inferred association: the sole created workload connects to the batch's
  // data services; a created Gateway routes to it; created identities
  // authenticate it. Inferred confidence sits below the gate threshold, so
  // every inferred edge requires human confirmation (OP-3 by construction).
  const INFERRED = 0.7;
  const sole = soleCreatedWorkload();
  if (sole !== undefined && sole.kind !== 'Gateway') {
    for (const facet of dataServices) {
      if (facet.attachTo !== undefined) continue;
      const record = compiler.creations.find((entry) => entry.span === facet.sourceSpan);
      if (record === undefined) continue;
      pushEdge(sole.id, verbForService(facet.service), record.id, facet, [
        sole.confidences[0] as number,
        facet.confidence,
        INFERRED,
      ]);
    }
    for (const gateway of compiler.createdOfKind(['Gateway'])) {
      pushEdge(gateway.id, 'routesTo', sole.id, workloads[0] as WorkloadFacet, [
        gateway.confidences[0] as number,
        INFERRED,
      ]);
    }
    for (const facet of identities) {
      const record = compiler.creations.find(
        (entry) => entry.kind === 'Identity' && entry.span === facet.sourceSpan,
      );
      if (record === undefined) continue;
      pushEdge(sole.id, 'authenticatedBy', record.id, facet, [facet.confidence, INFERRED]);
    }
  }

  // Profiles (environments are profiles, ch. 6 §6.1). ApplyProfile is an
  // upsert of the COMPLETE definition, so profiles already present are left
  // untouched — re-applying would wipe authored overrides.
  for (const facet of environments) {
    for (const name of facet.environments) {
      if (document.profiles?.[name] !== undefined) continue;
      ops.push(
        compiler.envelope(
          `op-profile-${name}`,
          'ApplyProfile',
          { profile: name },
          { description: `${name} environment` },
          { confidences: [facet.confidence], span: facet.sourceSpan },
        ),
      );
    }
  }

  // Compliance controls: deterministic per-framework policy sets.
  const existingPolicyIds = new Set((document.policies ?? []).map((policy: Policy) => policy.id));
  for (const facet of compliances) {
    const slug = FRAMEWORK_SLUGS[facet.framework] as string;
    for (const spec of COMPLIANCE_POLICIES[facet.framework] ?? []) {
      const policyId = `${slug}-${spec.idSuffix}`;
      if (existingPolicyIds.has(policyId)) continue;
      existingPolicyIds.add(policyId);
      ops.push(
        compiler.envelope(
          `op-policy-${policyId}`,
          'AddPolicy',
          { policyId },
          {
            description: `${spec.description} (${facet.framework})`,
            target: { kinds: spec.kinds },
            rule: spec.rule,
            effect: spec.effect,
          },
          { confidences: [facet.confidence], span: facet.sourceSpan },
        ),
      );
    }
  }

  // Budget and provider preference: non-semantic annotations (ch. 19 §19.5 —
  // annotations never change validation, planning, or approval behavior).
  const budgetAmount = budgets.find((facet) => facet.amountUsd !== undefined);
  if (budgetAmount !== undefined) {
    ops.push(
      compiler.envelope(
        'op-set-budget',
        'SetMetadata',
        {},
        { set: { 'annotations.budget-monthly-usd': String(budgetAmount.amountUsd) } },
        { confidences: [budgetAmount.confidence], span: budgetAmount.sourceSpan },
      ),
    );
  }
  if (providers.length > 0) {
    const names = [...new Set(providers.map((facet) => facet.provider))].sort();
    ops.push(
      compiler.envelope(
        'op-set-provider-preference',
        'SetMetadata',
        {},
        { set: { 'annotations.provider-preference': names.join(',') } },
        {
          confidences: providers.map((facet) => facet.confidence),
          span: (providers[0] as ProviderPreferenceFacet).sourceSpan,
        },
      ),
    );
  }

  return {
    batch: ops.length > 0 ? { apiVersion: OPERATIONS_API_VERSION, operations: ops } : null,
    unsupported: compiler.unsupported,
    unresolved: compiler.unresolved,
  };
}
