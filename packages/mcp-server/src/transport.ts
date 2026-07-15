/**
 * A minimal, dependency-free MCP-over-stdio transport (roadmap Phase 19, M19.4).
 *
 * This is the wire binding that turns the protocol-neutral `IaPMcpServer` into a
 * server a real assistant (Claude Code, Cursor, an IDE) can connect to. It speaks
 * JSON-RPC 2.0 over stdio using the MCP stdio framing (protocol `2025-06-18`):
 * **newline-delimited JSON** — exactly one message per line, terminated by `\n`,
 * with no framing headers and no embedded newlines inside a message. (MCP is not
 * LSP: `Content-Length` headers are NOT part of the MCP stdio transport.)
 *
 * Deliberately hand-rolled with only `node:*` primitives — NO
 * `@modelcontextprotocol/sdk`, no network, no new dependencies. Protocol
 * messages go to stdout; everything else (logs, diagnostics) MUST go to stderr,
 * because any stray byte on stdout corrupts the message stream.
 *
 * The dispatcher never throws across the protocol: a failed tool call becomes an
 * MCP tool result with `isError: true`, and an unknown method becomes a JSON-RPC
 * `-32601` error — the boundary stays fail-closed and the connection survives.
 */
import type { Readable, Writable } from 'node:stream';
import type { IaPMcpServer } from './server.js';

/** The MCP protocol revision this server implements. */
export const PROTOCOL_VERSION = '2025-06-18';

const SERVER_INFO = { name: '@iap/mcp-server', version: '0.1.0' } as const;

/** JSON-RPC standard error code for an unknown method. */
const METHOD_NOT_FOUND = -32601;
/** JSON-RPC standard error code for a malformed / unparseable request. */
const PARSE_ERROR = -32700;
/** JSON-RPC standard error code for an invalid request shape. */
const INVALID_REQUEST = -32600;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle a single decoded JSON-RPC message against the server.
 *
 * Returns the response to write back, or `null` when nothing should be written
 * (JSON-RPC notifications — messages with no `id` — never get a reply). Never
 * throws: tool failures and unknown methods are encoded as data.
 */
export async function handleMessage(
  server: IaPMcpServer,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const { method, params } = message;
  // A notification has no `id`. Its result must never be written back.
  const isNotification = message.id === undefined;
  const id: JsonRpcId = message.id ?? null;

  if (typeof method !== 'string') {
    return isNotification ? null : fail(id, INVALID_REQUEST, 'missing "method"');
  }

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });

    case 'notifications/initialized':
    case 'initialized':
      // Lifecycle notification — acknowledged by silence.
      return null;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: server.manifest().tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: 'object' },
        })),
      });

    case 'tools/call': {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') {
        return fail(id, INVALID_REQUEST, 'tools/call requires a string "name"');
      }
      const dispatch = await server.call(name, args);
      if (dispatch.ok) {
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(dispatch.result) }],
          isError: false,
        });
      }
      // Fail-closed: a tool error is a tool RESULT with isError, not a protocol
      // error — the client sees the failure without the connection dying.
      return ok(id, {
        content: [{ type: 'text', text: dispatch.error }],
        isError: true,
      });
    }

    default:
      // Unknown notifications are ignored; unknown requests get -32601.
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

/**
 * Encode a JSON-RPC message as one newline-terminated line (MCP stdio framing).
 * `JSON.stringify` is compact by construction — any newline inside a string
 * value is escaped to `\n`, so the encoded message can never contain a raw
 * embedded newline (spec: messages MUST NOT contain embedded newlines).
 */
export function encodeMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * A streaming decoder for newline-delimited JSON messages. Feed it raw chunks
 * (which may split a message anywhere — even mid-UTF-8-codepoint — or carry
 * several messages at once) and it returns whichever complete lines are now
 * available, buffering the remainder for the next chunk. Tolerates `\r\n` line
 * endings and skips blank lines.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  /** Append a chunk and drain every complete line's JSON body. */
  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const bodies: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf(0x0a); // '\n'
      if (newline === -1) break; // no complete line buffered yet
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 0) bodies.push(line); // trim drops a trailing '\r'; skip blanks
    }
    return bodies;
  }
}

export interface StdioOptions {
  input?: Readable;
  output?: Writable;
  /** Sink for diagnostics; defaults to stderr. Never write these to stdout. */
  log?: (message: string) => void;
}

/**
 * Run the stdio server loop: decode newline-delimited JSON-RPC from `input`,
 * dispatch each message to `server`, and write one newline-terminated response
 * line per request to `output`. Messages are
 * processed strictly in order (responses are serialised through a promise chain)
 * so an async `tools/call` can never overtake an earlier reply.
 *
 * Returns a `stop()` handle that detaches the listeners.
 */
export function runStdio(server: IaPMcpServer, options: StdioOptions = {}): { stop: () => void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`));

  const decoder = new FrameDecoder();
  let chain: Promise<void> = Promise.resolve();

  const onData = (chunk: Buffer): void => {
    let bodies: string[];
    try {
      bodies = decoder.push(chunk);
    } catch (error) {
      log(`transport: frame decode failed: ${(error as Error).message}`);
      return;
    }
    for (const body of bodies) {
      chain = chain.then(async () => {
        let message: JsonRpcRequest;
        try {
          message = JSON.parse(body) as JsonRpcRequest;
        } catch (error) {
          log(`transport: JSON parse failed: ${(error as Error).message}`);
          output.write(encodeMessage(fail(null, PARSE_ERROR, 'parse error')));
          return;
        }
        const response = await handleMessage(server, message);
        if (response !== null) output.write(encodeMessage(response));
      });
    }
  };

  input.on('data', onData);
  if (typeof (input as Readable & { resume?: () => void }).resume === 'function') {
    (input as Readable).resume();
  }

  return {
    stop: () => {
      input.off('data', onData);
    },
  };
}
