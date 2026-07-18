/**
 * The MCP stdio transport (roadmap Phase 19, M19.4). Drives the ACTUAL wire
 * binding — newline-delimited JSON framing (MCP spec 2025-06-18) + JSON-RPC
 * dispatch — not just the class: both in-process (via
 * `handleMessage`/`FrameDecoder`/`runStdio`) and end-to-end by spawning
 * `node dist/bin.js` and exchanging newline-delimited bytes over its stdio.
 *
 * Pins: initialize returns serverInfo + tools capability; tools/list advertises
 * exactly the 5 canonical `iap_*` tools (no `iis_*`); a real `iap_validate` call
 * returns a non-error result; a bad/unknown tool returns `isError: true` rather
 * than crashing; unknown methods map to JSON-RPC -32601; framing round-trips
 * even when a message is split across two chunks; output is exactly one JSON
 * object per line; and LSP-style `Content-Length` frames are NOT accepted
 * (regression pin — MCP stdio is newline-delimited, not LSP).
 */
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IaPMcpServer } from '../src/server';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  handleMessage,
  runStdio,
  type JsonRpcResponse,
} from '../src/transport';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const BASIC = readFileSync(join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml'), 'utf8');

const CANONICAL = ['iap_author', 'iap_compliance', 'iap_cost', 'iap_security', 'iap_validate'];

interface ToolResult {
  content: { type: string; text: string }[];
  isError: boolean;
}

describe('handleMessage — JSON-RPC dispatch', () => {
  it('initialize returns the protocol version, serverInfo, and tools capability', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(res).not.toBeNull();
    const result = res!.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: unknown };
    };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.serverInfo).toEqual({ name: '@iap/mcp-server', version: '1.0.0' });
    expect(result.capabilities.tools).toBeDefined();
  });

  it('notifications/initialized yields no response', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });

  it('tools/list lists exactly the 5 canonical iap_* tools with inputSchema (no iis_*)', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const tools = (res!.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(CANONICAL);
    expect(tools.some((t) => t.name.startsWith('iis_'))).toBe(false);
    for (const t of tools) expect((t.inputSchema as { type: string }).type).toBe('object');
  });

  it('tools/call iap_validate returns a real, non-error result for a valid doc', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'iap_validate', arguments: { document: BASIC } },
    });
    const result = res!.result as ToolResult;
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text) as { ok: boolean; findings: unknown[] };
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.findings)).toBe(true);
  });

  it('a bad tool input returns isError:true rather than throwing', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'iap_security', arguments: {} },
    });
    const result = res!.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('document');
  });

  it('an unknown tool returns isError:true (never a thrown crash)', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'iap_nonexistent', arguments: {} },
    });
    const result = res!.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown tool');
  });

  it('a legacy iis_* tool call is a rejected tool result, not a dispatched call', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'iis_validate', arguments: { document: BASIC } },
    });
    const result = res!.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown tool "iis_validate"');
  });

  it('an unknown method returns a JSON-RPC -32601 error', async () => {
    const res = await handleMessage(new IaPMcpServer(), {
      jsonrpc: '2.0',
      id: 7,
      method: 'does/not/exist',
    });
    expect(res!.error?.code).toBe(-32601);
    expect(res!.result).toBeUndefined();
  });
});

describe('newline-delimited framing (MCP stdio)', () => {
  it('encode produces exactly one newline-terminated line with no embedded newline', () => {
    const encoded = encodeMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { text: 'line one\nline two' }, // newline in a value must be escaped
    }).toString('utf8');
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.slice(0, -1)).not.toContain('\n');
    expect(encoded).not.toContain('Content-Length');
  });

  it('encode/decode round-trips a message', () => {
    const decoder = new FrameDecoder();
    const bodies = decoder.push(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ id: 1, method: 'initialize' });
  });

  it('reassembles a single message split across two chunks', () => {
    const decoder = new FrameDecoder();
    const framed = encodeMessage({ jsonrpc: '2.0', id: 9, method: 'ping' });
    const cut = Math.floor(framed.length / 2);
    expect(decoder.push(framed.subarray(0, cut))).toHaveLength(0); // nothing complete yet
    const bodies = decoder.push(framed.subarray(cut));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ id: 9, method: 'ping' });
  });

  it('drains several messages delivered in one chunk', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
      encodeMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      encodeMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    ]);
    const bodies = decoder.push(chunk);
    expect(bodies.map((b) => (JSON.parse(b) as { id: number }).id)).toEqual([1, 2]);
  });

  it('tolerates \\r\\n line endings and skips blank lines', () => {
    const decoder = new FrameDecoder();
    const bodies = decoder.push(
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n\r\n', 'utf8'),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ id: 1, method: 'ping' });
  });
});

/** Collect framed responses off a stream until `count` are seen (or timeout). */
function collect(stream: PassThrough, count: number): Promise<JsonRpcResponse[]> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const out: JsonRpcResponse[] = [];
    const timer = setTimeout(
      () => reject(new Error(`only ${out.length}/${count} responses`)),
      5000,
    );
    stream.on('data', (chunk: Buffer) => {
      for (const body of decoder.push(chunk)) out.push(JSON.parse(body) as JsonRpcResponse);
      if (out.length >= count) {
        clearTimeout(timer);
        resolve(out);
      }
    });
  });
}

describe('runStdio — the wire loop over piped streams', () => {
  it('drives initialize → tools/list → tools/call in order over framed streams', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const handle = runStdio(new IaPMcpServer(), {
      input,
      output,
      log: (m) => logs.push(m),
    });

    const responses = collect(output, 3);
    input.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    input.write(encodeMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })); // no reply
    input.write(encodeMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    input.write(
      encodeMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'iap_validate', arguments: { document: BASIC } },
      }),
    );

    const [init, list, call] = await responses;
    expect(init!.id).toBe(1);
    expect((init!.result as { serverInfo: unknown }).serverInfo).toBeDefined();
    expect(list!.id).toBe(2);
    expect((list!.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(
      CANONICAL,
    );
    expect(call!.id).toBe(3);
    expect((call!.result as ToolResult).isError).toBe(false);
    handle.stop();
  });

  it('writes exactly one JSON object per line to the wire', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const raw: Buffer[] = [];
    output.on('data', (chunk: Buffer) => raw.push(chunk));
    const handle = runStdio(new IaPMcpServer(), { input, output, log: (m) => logs.push(m) });

    const responses = collect(output, 2);
    input.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    input.write(encodeMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await responses;

    const text = Buffer.concat(raw).toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.slice(0, -1).split('\n');
    expect(lines).toHaveLength(2); // one JSON object per line, nothing else
    for (const line of lines) {
      expect((JSON.parse(line) as JsonRpcResponse).jsonrpc).toBe('2.0');
    }
    handle.stop();
  });

  it('does NOT answer an LSP-style Content-Length-framed request (regression: MCP stdio is newline-delimited)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const seen: JsonRpcResponse[] = [];
    const decoder = new FrameDecoder();
    output.on('data', (chunk: Buffer) => {
      for (const body of decoder.push(chunk)) seen.push(JSON.parse(body) as JsonRpcResponse);
    });
    const handle = runStdio(new IaPMcpServer(), { input, output, log: (m) => logs.push(m) });

    const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' });
    input.write(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The header line is not JSON → one -32700 parse error with id null. The
    // framed body (no trailing newline) is never treated as a message, so the
    // request id 42 is NEVER answered.
    expect(seen.some((r) => r.id === 42)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBeNull();
    expect(seen[0]!.error?.code).toBe(-32700);
    handle.stop();
  });
});

describe('bin.ts — spawned as a real child process', () => {
  it('node dist/bin.js answers initialize, tools/list, and a bad tools/call over stdio', async () => {
    const binPath = join(here, '..', 'dist', 'bin.js');
    const child = spawn('node', [binPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout = Buffer.concat([stdout, d]);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.stdin.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    child.stdin.write(encodeMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    child.stdin.write(
      encodeMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'iap_bogus', arguments: {} },
      }),
    );

    // Poll the accumulated stdout buffer until 3 complete frames have arrived.
    const responses = await new Promise<JsonRpcResponse[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr}`)), 8000);
      const check = setInterval(() => {
        const bodies = new FrameDecoder().push(stdout.subarray(0));
        if (bodies.length >= 3) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(bodies.map((b) => JSON.parse(b) as JsonRpcResponse));
        }
      }, 25);
    });

    child.stdin.end();
    child.kill();

    expect(stderr).toContain('listening on stdio');
    const init = responses.find((r) => r.id === 1)!;
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION);
    const list = responses.find((r) => r.id === 2)!;
    expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(
      CANONICAL,
    );
    const call = responses.find((r) => r.id === 3)!;
    expect((call.result as ToolResult).isError).toBe(true);
  });
});
