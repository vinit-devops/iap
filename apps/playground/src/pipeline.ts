/**
 * `runPlanPreview` — the pure plan-preview pipeline behind the IaP Planning
 * Playground (roadmap-v2 Phase 19, M19.5).
 *
 * It drives one natural-language request (or a supplied IaP document) through
 * the FULL plan-preview surface, reusing the existing engines end to end and
 * reimplementing none of them:
 *
 *   author (@iap/intent-compiler runAuthoringSession, rules-based, deterministic)
 *     -> validate (@iap/sdk load().validate() + .policies())
 *     -> architecture (@iap/architecture deriveView + toMermaid)
 *     -> dependencies (@iap/graph deriveOrdering + executionWaves)
 *     -> cost (@iap/cost estimateCost + referenceCostModel/referenceSnapshot)
 *     -> security (@iap/security securityReport)
 *     -> compliance (@iap/compliance evaluateCompliance)
 *     -> AWS plan preview (@iap/provider-sdk applyMapping over the bundled AWS
 *        mapping -> @iap/planner plan() against emptySnapshot() -> planId)
 *
 * Determinism (roadmap-v2 §11): the authoring clock is INJECTED — every audit
 * instant comes from `timestamp` (default `DEFAULT_TIMESTAMP`), never a wall
 * clock — and the planner runs against `emptySnapshot()`, so identical inputs
 * yield a byte-identical `planId`. A document shared back in (`document`)
 * reproduces the same downstream result without re-authoring.
 *
 * Guardrails (roadmap-v2 §11): this module imports NO AWS SDK and NO
 * `@iap/deploy-aws` — there is no apply/deploy path anywhere. It writes nothing
 * to disk. The only file it reads is the bundled, read-only AWS mapping asset.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runAuthoringSession } from '@iap/intent-compiler';
import type {
  AuthoringOutcome,
  ClarificationAnswer,
  ClarificationQuestion,
  FieldProvenanceRecord,
} from '@iap/intent-compiler';
import { load } from '@iap/sdk';
import { deriveView, toMermaid } from '@iap/architecture';
import { deriveOrdering, executionWaves } from '@iap/graph';
import { estimateCost, referenceCostModel, referenceSnapshot } from '@iap/cost';
import type { CostReport } from '@iap/cost';
import { securityReport } from '@iap/security';
import type { SecurityReport } from '@iap/security';
import { evaluateCompliance } from '@iap/compliance';
import type { ComplianceReport } from '@iap/compliance';
import { applyMapping, validateMappingArtifact } from '@iap/provider-sdk';
import type { MappingArtifact } from '@iap/provider-sdk';
import { emptySnapshot, plan } from '@iap/planner';

/**
 * The pinned audit instant used when the caller injects none. A constant clock
 * is what makes the whole preview deterministic (roadmap-v2 §11): the same
 * request always authors to the same document and therefore the same planId.
 */
export const DEFAULT_TIMESTAMP = '2026-01-01T00:00:00Z';

/** Mandatory labels (roadmap-v2 §11): never claim exact cost or certification. */
export const DISCLAIMERS = {
  cost: 'estimate (illustrative pricing, not a quote)',
  compliance: 'configuration coverage only — not a certification',
} as const;

/** A validation/policy finding projected to a small JSON-serializable shape. */
export interface WireFinding {
  code: string;
  severity: string;
  path: string;
  message: string;
}

/** One scheduled plan action, flattened from the plan's provisioning waves. */
export interface PlanActionSummary {
  resource: string;
  action: string;
  destructive: boolean;
  reversibility: string;
}

/** The deterministic AWS plan-preview summary (no deploy, ever). */
export interface PlanPreviewSummary {
  /** `sha256:<hex>` over the canonical plan content, or null when unavailable. */
  planId: string | null;
  actions: PlanActionSummary[];
  /** Fail-closed mapping diagnostics when the model is outside the AWS matrix. */
  diagnostics?: string[];
}

/** One provisioning ordering arc: `before` must exist before `after`. */
export interface DependencyArc {
  before: string;
  after: string;
}

/** How the request was authored, so the UI can explain a non-committed run. */
export interface AuthoringSummary {
  outcome: AuthoringOutcome;
  /** Human-readable reasons a request did not commit (questions/refusals). */
  messages: string[];
}

/** Everything the plan-preview produced for one request. */
export interface PlanPreview {
  /** The IaP document as YAML (the single source of truth), or null if none. */
  document: string | null;
  authoring: AuthoringSummary;
  valid: boolean;
  findings: WireFinding[];
  architecture: { mermaid: string | null };
  dependencies: { arcs: DependencyArc[]; waves: string[][] };
  cost: CostReport | null;
  security: SecurityReport | null;
  compliance: ComplianceReport | null;
  plan: PlanPreviewSummary;
  provenance: FieldProvenanceRecord[];
  disclaimers: typeof DISCLAIMERS;
}

/** Input to the pipeline: a natural-language `request` OR a shared `document`. */
export interface PlanPreviewInput {
  /** A natural-language request to author from (rules-based, deterministic). */
  request?: string;
  /** A pre-authored IaP YAML document (the read-only share path). */
  document?: string;
  /** Injected audit instant (RFC 3339). Defaults to `DEFAULT_TIMESTAMP`. */
  timestamp?: string;
}

/**
 * A deterministic, clearly-illustrative answer for a blocking free-form
 * clarification, so a bare request still previews rather than dead-ending at
 * "needs input" for a value only a human could ultimately choose. These are
 * placeholders (e.g. a sample container image), never real user data, and are
 * chosen from the question's target field so the authored document validates.
 * Questions with closed options are left to `autoAnswerDefaults`; questions
 * whose target field we do not recognize are left unanswered (the request then
 * honestly stops at "needs input").
 */
function illustrativeAnswer(question: ClarificationQuestion): ClarificationAnswer | null {
  // Only free-form (no closed options) value questions are auto-filled here.
  if (question.options.length > 0) return null;
  const field = (question.field ?? '').toLowerCase();
  let value: string | null = null;
  if (field.includes('reference') || field.includes('image') || field.includes('artifact')) {
    value = 'registry.example.com/app:1.0.0';
  } else if (field.includes('domain') || field.includes('host')) {
    value = 'app.example.com';
  }
  return value === null ? null : { questionId: question.id, value };
}

let cachedMapping: MappingArtifact | undefined;

/**
 * Load and validate the bundled AWS mapping artifact. It ships inside this
 * package (`assets/aws-core.iap-map.yaml`) and is resolved relative to the
 * compiled module, so no monorepo path is needed at runtime. Read-only.
 */
function awsMapping(): MappingArtifact {
  if (cachedMapping !== undefined) return cachedMapping;
  const url = new URL('../assets/aws-core.iap-map.yaml', import.meta.url);
  const parsed: unknown = parse(readFileSync(url, 'utf8'));
  const validation = validateMappingArtifact(parsed);
  if (!validation.ok) {
    throw new Error(`bundled AWS mapping is invalid: ${validation.errors.join('; ')}`);
  }
  cachedMapping = validation.artifact;
  return cachedMapping;
}

function toWireFinding(f: {
  code: string;
  severity: string;
  path: string;
  message: string;
}): WireFinding {
  return { code: f.code, severity: f.severity, path: f.path, message: f.message };
}

/** An empty preview shell for a request that produced no document. */
function emptyPreview(authoring: AuthoringSummary, findings: WireFinding[] = []): PlanPreview {
  return {
    document: null,
    authoring,
    valid: false,
    findings,
    architecture: { mermaid: null },
    dependencies: { arcs: [], waves: [] },
    cost: null,
    security: null,
    compliance: null,
    plan: { planId: null, actions: [] },
    provenance: [],
    disclaimers: DISCLAIMERS,
  };
}

/**
 * Run the full plan-preview pipeline. Pure with respect to wall-clock time
 * (the audit instant is injected) and to disk (nothing is written); the same
 * input yields the same output, including a byte-identical `planId`.
 */
export async function runPlanPreview(input: PlanPreviewInput): Promise<PlanPreview> {
  const timestamp = input.timestamp ?? DEFAULT_TIMESTAMP;

  // 1. Obtain the IaP document: author it from the request, or take the shared
  //    document verbatim (the read-only reproduce path). Provenance is only
  //    available on the authoring path (the gate produces it).
  let documentYaml: string;
  let provenance: FieldProvenanceRecord[] = [];
  let authoring: AuthoringSummary;

  if (typeof input.document === 'string' && input.document.trim().length > 0) {
    documentYaml = input.document;
    authoring = { outcome: 'committed', messages: ['reproduced from a shared document'] };
  } else if (typeof input.request === 'string' && input.request.trim().length > 0) {
    const options = {
      timestamp,
      documentName: 'infrastructure',
      autoAnswerDefaults: true,
    } as const;
    let session = await runAuthoringSession(input.request, options);
    // Second pass: supply illustrative defaults for blocking free-form
    // questions (e.g. a placeholder container image) so a bare request still
    // previews. Deterministic — the answers are constant.
    if (session.outcome === 'needs-input' && session.unanswered.length > 0) {
      const answers = session.unanswered
        .map(illustrativeAnswer)
        .filter((a): a is ClarificationAnswer => a !== null);
      if (answers.length > 0) {
        session = await runAuthoringSession(input.request, { ...options, answers });
      }
    }
    if (session.outcome !== 'committed' || session.committed === undefined) {
      const messages: string[] = [
        ...session.unanswered.map((q) => `needs input: ${q.question}`),
        ...session.refusals.map((r) => `refused: ${r.message}`),
        ...session.unsupported.map((u) => `unsupported: ${u.capability} (${u.reason})`),
      ];
      if (messages.length === 0) {
        messages.push(`the request produced no operations (outcome: ${session.outcome})`);
      }
      return emptyPreview({ outcome: session.outcome, messages });
    }
    documentYaml = session.committed.serialize('yaml');
    provenance = session.committed.provenance;
    authoring = { outcome: 'committed', messages: [] };
  } else {
    return emptyPreview({
      outcome: 'no-operations',
      messages: ['provide either a natural-language `request` or a `document`'],
    });
  }

  // 2. Validate: re-load the produced document through the SDK facade and
  //    gather the four-phase validation plus policy findings.
  const ws = await load(documentYaml);
  const findings: WireFinding[] = ws.findings.map(toWireFinding);
  if (ws.document !== undefined) {
    findings.push(
      ...ws.validate().findings.map(toWireFinding),
      ...ws.policies().findings.map(toWireFinding),
    );
  }
  const valid = ws.ok && findings.every((f) => f.severity !== 'error');

  // Without a parsable document, the downstream engines have nothing to work
  // on — surface what we have and stop honestly.
  if (ws.document === undefined) {
    const preview = emptyPreview(authoring, findings);
    preview.document = documentYaml;
    return preview;
  }

  const model = ws.canonical().model;

  // 3. Architecture: the derived architecture view, exported as Mermaid.
  const mermaid = toMermaid(deriveView(model, 'architecture'));

  // 4. Dependencies: the ch. 9 ordering arcs and execution waves.
  const graph = ws.graph();
  const arcs: DependencyArc[] = deriveOrdering(graph).edges.map((arc) => ({
    before: arc.before,
    after: arc.after,
  }));
  const waves = executionWaves(graph);

  // 5. Cost: priced with the reference model against the reference snapshot.
  const cost = estimateCost(model, {
    costModel: referenceCostModel(),
    snapshot: referenceSnapshot(),
  });

  // 6. Security: the derived posture and IAP6xx findings.
  const security = securityReport(model);

  // 7. Compliance: the active framework bundles' evidence.
  const compliance = evaluateCompliance(model);

  // 8. AWS plan preview: map to AWS then plan against an empty snapshot, so
  //    every resource plans as `create` and the planId is deterministic. This
  //    is a preview artifact only — there is no apply/deploy path anywhere.
  const preview: PlanPreviewSummary = { planId: null, actions: [] };
  const mapped = applyMapping(model, awsMapping());
  if (mapped.ok) {
    const artifact = plan(mapped.plan, emptySnapshot());
    preview.planId = artifact.planId;
    preview.actions = artifact.content.waves.flat().map((entry) => ({
      resource: entry.resource,
      action: entry.action,
      destructive: entry.destructive,
      reversibility: entry.reversibility,
    }));
  } else {
    preview.diagnostics = mapped.diagnostics.map((d) => `${d.reason}: ${d.message}`);
  }

  return {
    document: documentYaml,
    authoring,
    valid,
    findings,
    architecture: { mermaid },
    dependencies: { arcs, waves },
    cost,
    security,
    compliance,
    plan: preview,
    provenance,
    disclaimers: DISCLAIMERS,
  };
}
