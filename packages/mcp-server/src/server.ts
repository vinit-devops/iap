/**
 * The IaP MCP server core (roadmap Phase 13, M13.2). A protocol-neutral tool
 * dispatcher over the read-only `IAP_TOOLS` registry, plus a manifest an MCP
 * client lists. Kept protocol-neutral so it is fully testable in-process; a
 * thin stdio MCP binding wraps it in `bin.ts`. The trust boundary is asserted
 * at construction: a registry containing any mutation tool refuses to start.
 */
import { IAP_TOOLS, assertReadOnly } from './tools.js';
import type { JsonSchema, ToolDefinition } from './tools.js';

export interface ManifestTool {
  name: string;
  kind: string;
  description: string;
  /** JSON Schema for the tool's arguments (surfaced as MCP `inputSchema`). */
  inputSchema: JsonSchema;
}

export interface ServerManifest {
  name: string;
  version: string;
  /** The normative trust-boundary declaration surfaced to clients (ch. 19). */
  trustBoundary: string;
  tools: ManifestTool[];
}

export type DispatchResult = { ok: true; result: unknown } | { ok: false; error: string };

export class IaPMcpServer {
  private readonly tools: Map<string, ToolDefinition>;

  constructor(tools: ToolDefinition[] = IAP_TOOLS) {
    // Fail closed: a mutation/deployment tool must never be exposed (ch. 19).
    assertReadOnly(tools);
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  manifest(): ServerManifest {
    return {
      name: '@iap/mcp-server',
      version: '1.0.0',
      trustBoundary:
        'Authoring and analysis only. This server exposes no deployment, mutation, or provider-API tool; an assistant using it cannot deploy or reach a provider (spec ch. 19). Authoring goes through the intent-compiler gate — an LLM never writes YAML into the source of truth.',
      tools: [...this.tools.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({
          name: t.name,
          kind: t.kind,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
    };
  }

  /** True when a tool with this name exists. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Dispatch a tool call. Never throws — errors are returned as data.
   *
   * Only canonical `iap_*` tool names are accepted. The IIS→IaP rename was a
   * hard, pre-release cut: there are NO legacy `iis_*` aliases, so a legacy
   * name resolves to nothing and returns an unknown-tool error (ADR-0003).
   */
  async call(name: string, input: Record<string, unknown>): Promise<DispatchResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) return { ok: false, error: `unknown tool "${name}"` };
    try {
      const result = await tool.handler(input);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
}
