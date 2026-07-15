/**
 * The IaP MCP tool registry (spec ch. 19 §19.2, ch. 23; roadmap Phase 13,
 * M13.2). This is the surface an AI assistant (Claude Code, Cursor, Windsurf,
 * an IDE) drives to author and review IaP. Its defining property is the ch. 19
 * boundary: every tool is READ-ONLY / authoring — there is NO deployment,
 * mutation, or provider-API tool anywhere in the registry, so an assistant
 * structurally cannot deploy or reach a provider. Authoring runs through the
 * intent-compiler gate (an LLM never writes YAML); analysis tools run the same
 * reference engines the CLI uses.
 */
import { load } from '@iap/sdk';
import { runAuthoringSession } from '@iap/intent-compiler';
import { estimateCost, evaluateBudgets, referenceCostModel, referenceSnapshot } from '@iap/cost';
import { securityReport } from '@iap/security';
import { evaluateCompliance } from '@iap/compliance';

/** Tool kind — authoring produces intent; analysis reports on it. Never mutation. */
export type ToolKind = 'authoring' | 'analysis';

/**
 * A JSON Schema (object-typed) describing a tool's arguments. Surfaced verbatim
 * as the MCP `inputSchema` in `tools/list` so an assistant knows how to call it.
 */
export interface JsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  kind: ToolKind;
  description: string;
  /** JSON Schema for the tool's arguments (MCP `inputSchema`). */
  inputSchema: JsonSchema;
  /** Runs the tool. Pure with respect to the world — reads inputs, returns data. */
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

/** Shared schema: an analysis tool that takes a single IaP document string. */
const DOCUMENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    document: { type: 'string', description: 'The IaP document text (YAML) to analyse.' },
  },
  required: ['document'],
  additionalProperties: false,
};

/** Verbs that would indicate a mutation/deployment capability (forbidden, ch. 19). */
const FORBIDDEN_VERBS = [
  'deploy',
  'destroy',
  'apply',
  'rollback',
  'provision',
  'mutate',
  'delete',
  'push',
  'execute',
];

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`tool input "${key}" must be a non-empty string`);
  }
  return value;
}

async function canonicalModel(documentText: string): Promise<ReturnType<typeof modelOf>> {
  return modelOf(documentText);
}
async function modelOf(documentText: string) {
  const ws = await load(documentText);
  if (!ws.ok || ws.document === undefined) throw new Error('document did not parse');
  return ws.canonical().model;
}

/** The closed authoring + analysis tool set. No deployment/mutation tool exists. */
export const IAP_TOOLS: ToolDefinition[] = [
  {
    name: 'iap_author',
    kind: 'authoring',
    description:
      'Author IaP from a natural-language requirement. Runs the intent compiler (extract → clarify → gate). Returns the outcome, clarifications, a semantic preview, and — only when it fully commits — the document and its per-field provenance. Never writes to disk or deploys.',
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'The natural-language infrastructure requirement to author from.',
        },
        timestamp: {
          type: 'string',
          description: 'ISO-8601 timestamp for deterministic authoring (defaults to epoch).',
        },
        name: { type: 'string', description: 'Name for the authored document.' },
        autoAnswerDefaults: {
          type: 'boolean',
          description: 'Auto-answer clarifications with their defaults where safe.',
        },
      },
      required: ['request'],
      additionalProperties: false,
    },
    async handler(input) {
      const request = requireString(input, 'request');
      const timestamp =
        typeof input.timestamp === 'string' ? input.timestamp : '1970-01-01T00:00:00Z';
      const result = await runAuthoringSession(request, {
        timestamp,
        documentName: typeof input.name === 'string' ? input.name : 'infrastructure',
        autoAnswerDefaults: input.autoAnswerDefaults === true,
      });
      return {
        outcome: result.outcome,
        unsupported: result.unsupported.map((u) => u.capability),
        clarifications: result.questions.map((q) => ({
          id: q.id,
          question: q.question,
          trigger: q.trigger,
        })),
        preview: result.explain !== undefined && result.explain.ok ? result.explain.text : null,
        document: result.committed?.serialize('yaml') ?? null,
        provenance: result.committed?.provenance ?? [],
      };
    },
  },
  {
    name: 'iap_validate',
    kind: 'analysis',
    description: 'Validate an IaP document (phases 1–5) and return the findings. Read-only.',
    inputSchema: DOCUMENT_SCHEMA,
    async handler(input) {
      const document = requireString(input, 'document');
      const ws = await load(document);
      if (!ws.ok) return { ok: false, findings: ws.findings };
      const findings = [...ws.validate().findings, ...ws.policies().findings];
      return { ok: findings.every((f) => f.severity !== 'error'), findings };
    },
  },
  {
    name: 'iap_cost',
    kind: 'analysis',
    description: 'Estimate cost and evaluate budgets for an IaP document (ch. 16). Read-only.',
    inputSchema: DOCUMENT_SCHEMA,
    async handler(input) {
      const model = await canonicalModel(requireString(input, 'document'));
      const report = estimateCost(model, {
        costModel: referenceCostModel(),
        snapshot: referenceSnapshot(),
      });
      return { report, budgets: evaluateBudgets(model, report) };
    },
  },
  {
    name: 'iap_security',
    kind: 'analysis',
    description:
      'Derive the security posture (grants, reachability, IAP6xx findings) for an IaP document (ch. 15). Read-only.',
    inputSchema: DOCUMENT_SCHEMA,
    async handler(input) {
      return securityReport(await canonicalModel(requireString(input, 'document')));
    },
  },
  {
    name: 'iap_compliance',
    kind: 'analysis',
    description:
      'Evaluate active compliance framework bundles and return the evidence report (ch. 17). Read-only.',
    inputSchema: DOCUMENT_SCHEMA,
    async handler(input) {
      return evaluateCompliance(await canonicalModel(requireString(input, 'document')));
    },
  },
];

/**
 * Assert the registry exposes NO mutation/deployment capability (ch. 19). A
 * build- and test-time guard: any tool whose name suggests mutation, or any
 * tool kind other than authoring/analysis, is a conformance violation.
 */
export function assertReadOnly(tools: ToolDefinition[] = IAP_TOOLS): void {
  for (const tool of tools) {
    if (tool.kind !== 'authoring' && tool.kind !== 'analysis') {
      throw new Error(`tool "${tool.name}" has non-read-only kind "${tool.kind}"`);
    }
    const lowered = tool.name.toLowerCase();
    for (const verb of FORBIDDEN_VERBS) {
      if (lowered.includes(verb)) {
        throw new Error(
          `tool "${tool.name}" names a forbidden mutation verb "${verb}" (ch. 19: assistant tools cannot deploy)`,
        );
      }
    }
  }
}
