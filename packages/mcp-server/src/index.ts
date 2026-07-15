/**
 * `@iap/mcp-server` — the IaP MCP server (roadmap Phase 13, M13.2). The tool
 * surface an AI assistant or IDE drives to author and review IaP, wrapping the
 * reference engines (`@iap/intent-compiler`, `@iap/sdk`, `@iap/cost`,
 * `@iap/security`, `@iap/compliance`). Authoring tools are separated from
 * deployment tools by ABSENCE: no deployment, mutation, or provider-API tool
 * exists in the registry, so an assistant cannot deploy or reach a provider
 * (spec ch. 19). Authoring runs through the intent-compiler gate; every
 * committed result carries per-field provenance.
 */
export { IAP_TOOLS, assertReadOnly } from './tools.js';
export type { JsonSchema, ToolDefinition, ToolKind } from './tools.js';

export { IaPMcpServer } from './server.js';
export type { DispatchResult, ManifestTool, ServerManifest } from './server.js';

export {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  handleMessage,
  runStdio,
} from './transport.js';
export type { JsonRpcResponse, StdioOptions } from './transport.js';

export { main } from './bin.js';
