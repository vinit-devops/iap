/**
 * The AI review engine (spec ch. 19, roadmap Phase 17, M17.1). Produces
 * EXPLAINABLE review findings over a document with hard guardrails: every item
 * is advisory (warn-level at most, never a deny/blocking effect — ch. 20
 * §20.2.3), carries an explanation and its basis (a deterministic rule id and,
 * where knowledge-grounded, source citations), and never mutates anything.
 * Acceptance is out of scope here — an accepted suggestion becomes intent only
 * through the intent-compiler recommend→accept→gate path, which validates it.
 * The engine is deterministic: the "AI" is the review lens, not a source of
 * nondeterministic output. The platform operates fully without it.
 */
import type { CanonicalModel, CanonicalResource } from '@iap/model';
import { securityReport } from '@iap/security';
import { evaluateCompliance } from '@iap/compliance';

/** Advisory severity only — the guardrail. Never `deny`/blocking (§20.2.3). */
export type ReviewSeverity = 'info' | 'advisory';

export interface ReviewItem {
  /** The deterministic rule id that produced this item. */
  rule: string;
  severity: ReviewSeverity;
  resource: string | null;
  /** Human-readable explanation of why this fired (explainability, M17.1). */
  explanation: string;
  /** Source citations grounding the item (knowledge snapshot ids / control ids). Never empty when cited. */
  citations: string[];
  /** A suggested change to apply THROUGH the acceptance gate — advisory, never auto-applied. */
  suggestion?: string;
}

const DATA_KINDS = new Set(['Database', 'Cache', 'ObjectStore', 'Volume']);

/** Deterministic best-practice rules over the model (never model inference). */
function bestPracticeItems(model: CanonicalModel): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const id of Object.keys(model.resources).sort()) {
    const resource = model.resources[id] as CanonicalResource;
    const spec = resource.spec;
    // Excess availability without disaster recovery.
    if (spec.availability === 'maximum') {
      const resilience = spec.resilience as { backup?: unknown } | undefined;
      if (resilience?.backup !== 'required') {
        items.push({
          rule: 'max-availability-without-backup',
          severity: 'advisory',
          resource: id,
          explanation: `"${id}" declares availability: maximum but spec.resilience.backup is not required — high availability without a backup leaves a gap.`,
          citations: ['well-architected:reliability'],
          suggestion: 'set spec.resilience.backup to required',
        });
      }
    }
    // Data resource with no inbound workload edge (possible orphan).
    if (DATA_KINDS.has(resource.kind) && !model.edges.some((e) => e.target === id)) {
      items.push({
        rule: 'orphaned-data-resource',
        severity: 'advisory',
        resource: id,
        explanation: `${resource.kind} "${id}" has no inbound edge from any workload — it may be unused.`,
        citations: ['well-architected:cost'],
        suggestion: 'remove the resource or connect a workload to it',
      });
    }
  }
  return items;
}

export interface ReviewOptions {
  /** Extra knowledge snapshot ids to cite on knowledge-grounded items. */
  knowledgeSnapshotIds?: string[];
}

/**
 * Review a canonical model, folding the security and compliance engines and the
 * best-practice rules into one explainable, cited, advisory finding set. Pure
 * and deterministic; items are sorted by (rule, resource).
 */
export function reviewDocument(model: CanonicalModel, options: ReviewOptions = {}): ReviewItem[] {
  const items: ReviewItem[] = [];

  // Security lens — surfaced as advisory review items (never blocking here).
  for (const finding of securityReport(model).findings) {
    items.push({
      rule: `security:${finding.code}`,
      severity: 'advisory',
      resource: finding.path.replace(/^\/resources\//, '').split('/')[0] ?? null,
      explanation: finding.message,
      citations: [`ch15:${finding.code}`, ...(options.knowledgeSnapshotIds ?? [])],
    });
  }

  // Compliance lens — control violations become advisory review items.
  for (const finding of evaluateCompliance(model).findings.filter((f) => f.code === 'IAP701')) {
    items.push({
      rule: `compliance:${finding.code}`,
      severity: 'advisory',
      resource: finding.path.replace(/^\/resources\//, '').split('/')[0] ?? null,
      explanation: finding.message,
      citations: [String(finding.policyId)],
    });
  }

  items.push(...bestPracticeItems(model));

  items.sort((a, b) =>
    a.rule === b.rule
      ? String(a.resource).localeCompare(String(b.resource))
      : a.rule.localeCompare(b.rule),
  );
  return items;
}

/* ------------------------------------------------------------------ */
/* Guardrails (ch. 19 / §20.2.3)                                       */
/* ------------------------------------------------------------------ */

/**
 * Assert the review guardrails hold: every item is advisory (never blocking)
 * and every item is grounded in at least one citation. A review that violates
 * either is a conformance error — AI output must be explainable and non-binding.
 */
export function assertGuardrails(items: ReviewItem[]): void {
  for (const item of items) {
    if (item.severity !== 'info' && item.severity !== 'advisory') {
      throw new Error(
        `review item "${item.rule}" has a non-advisory severity "${item.severity}" (AI suggestions cannot block; §20.2.3)`,
      );
    }
    if (item.citations.length === 0) {
      throw new Error(
        `review item "${item.rule}" cites no source (recommendations must cite sources; ch. 19)`,
      );
    }
  }
}
