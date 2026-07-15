/**
 * `@iap/designer-app` — a runnable local web shell over the headless
 * `@iap/designer` session (roadmap Phase 19, M19.4).
 *
 * The architectural boundary from spec ch. 19 is preserved on the wire: the
 * browser is a **thin client** that holds NO authoring logic. Every edit is
 * POSTed as a plain action to `/api/session`, where a server-side
 * `DesignerSession` translates it into a compiler operation and commits it
 * through the same `apply` gate the CLI uses. The server re-loads the produced
 * document through the `@iap/sdk` facade to compute validity and findings, and
 * returns the serialized IaP YAML. The canvas is a view; the IaP document is
 * the single source of truth.
 *
 * This module holds the transport-agnostic core (session driving, validation,
 * the HTML page, and the request handler) so it can be exercised directly by
 * the smoke test. `server.ts` is the thin `node:http` entry point.
 */
import { DesignerSession } from '@iap/designer';
import { load, validateExtensions } from '@iap/sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Types are derived from the two @iap/* workspace packages so this app needs
// no dependency beyond @iap/designer and @iap/sdk (spec ch. 19 boundary).
/** A resource kind accepted by the designer session. */
type Kind = Parameters<DesignerSession['addResource']>[0];
/** A validation/policy/extension finding as surfaced by the SDK facade. */
type Finding = ReturnType<typeof validateExtensions>[number];

/** The core resources the canvas can add, with a minimal valid default spec. */
export const RESOURCE_PALETTE: readonly Kind[] = [
  'Service',
  'Database',
  'Cache',
  'Gateway',
  'Queue',
  'ObjectStore',
];

/**
 * Sensible, spec-valid default specs per kind. A caller may override any of
 * these by sending an explicit `spec` in the action; these only fill the gap
 * so a single button click yields a valid resource.
 */
const DEFAULT_SPECS: Record<string, Record<string, unknown>> = {
  Service: {
    artifact: { type: 'container-image', reference: 'registry.example.com/app:1.0.0' },
    size: 'm',
  },
  Database: { class: 'relational', engine: 'postgresql', availability: 'standard' },
  Cache: { engine: 'redis-compatible', capacity: { memory: '1Gi' } },
  Gateway: { exposure: 'public', domains: ['app.example.com'], tls: { minimumVersion: '1.3' } },
  Queue: { delivery: 'at-least-once', ordering: 'none', messageRetention: '4d' },
  ObjectStore: { versioning: 'enabled', exposure: 'private' },
};

/** A canvas action sent by the (logic-free) browser to be driven server-side. */
export type SessionAction =
  | { op: 'addResource'; kind: string; name: string; spec?: Record<string, unknown> }
  | { op: 'connect'; from: string; to: string; verb?: string; access?: string }
  | { op: 'setProperty'; id: string; path: string; value: unknown }
  | { op: 'remove'; id: string }
  | { op: 'reset'; name?: string };

/** A finding projected to a small, JSON-serializable shape for the wire. */
export interface WireFinding {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

/** The JSON payload returned by the session and export endpoints. */
export interface SessionState {
  /** The current IaP document serialized as YAML (the single source of truth). */
  document: string;
  /** True when re-loading `document` through the SDK yields no error findings. */
  valid: boolean;
  /** All validation, policy, and extension findings on the current document. */
  findings: WireFinding[];
  /** True when the last edit committed; false when the gate refused it. */
  ok: boolean;
  /** Gate refusal messages when `ok` is false (document is left unchanged). */
  rejected?: string[];
}

function toWireFinding(f: Finding): WireFinding {
  return { code: f.code, severity: f.severity, path: f.path, message: f.message };
}

/**
 * Re-load a produced IaP document through the `@iap/sdk` facade and gather the
 * full four-phase validation, policy, and extension findings. Empty documents
 * (no resources yet) validate as trivially OK.
 */
async function validateDocument(
  yaml: string,
): Promise<{ valid: boolean; findings: WireFinding[] }> {
  const ws = await load(yaml);
  const findings: Finding[] = [...ws.findings];
  if (ws.document !== undefined) {
    findings.push(
      ...ws.validate().findings,
      ...ws.policies().findings,
      ...validateExtensions(ws.document),
    );
  }
  const valid = ws.ok && findings.every((f) => f.severity !== 'error');
  return { valid, findings: findings.map(toWireFinding) };
}

/**
 * A live designer session plus the operations the web shell drives against it.
 * All IaP generation happens here, server-side, through the `DesignerSession`
 * gate — never in the browser.
 */
export class DesignerApp {
  private session: DesignerSession;
  private lastRejected: string[] | undefined;

  constructor(documentName = 'infrastructure') {
    this.session = new DesignerSession(documentName);
  }

  /** Apply one canvas action through the gate; a refusal leaves the doc unchanged. */
  async apply(action: SessionAction): Promise<SessionState> {
    this.lastRejected = undefined;
    switch (action.op) {
      case 'addResource': {
        const spec = action.spec ?? DEFAULT_SPECS[action.kind] ?? ({} as Record<string, unknown>);
        const result = await this.session.addResource(action.kind as Kind, action.name, spec);
        if (!result.ok) this.lastRejected = result.errors;
        break;
      }
      case 'connect': {
        const result = await this.session.connect(
          action.from,
          action.to,
          action.verb ?? 'connectsTo',
          action.access,
        );
        if (!result.ok) this.lastRejected = result.errors;
        break;
      }
      case 'setProperty': {
        const result = await this.session.setProperty(action.id, action.path, action.value);
        if (!result.ok) this.lastRejected = result.errors;
        break;
      }
      case 'remove': {
        const result = await this.session.remove(action.id);
        if (!result.ok) this.lastRejected = result.errors;
        break;
      }
      case 'reset': {
        this.session = new DesignerSession(action.name ?? 'infrastructure');
        break;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown action: ${JSON.stringify(_exhaustive)}`);
      }
    }
    return this.state();
  }

  /** The current document plus its validity, without applying any edit. */
  async state(): Promise<SessionState> {
    const document = this.session.yaml();
    const { valid, findings } = await validateDocument(document);
    const state: SessionState = { document, valid, findings, ok: this.lastRejected === undefined };
    if (this.lastRejected !== undefined) state.rejected = this.lastRejected;
    return state;
  }

  /** The current IaP document as YAML (the export surface). */
  export(): string {
    return this.session.yaml();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Build the request handler bound to a single live `DesignerApp`. Every server
 * instance owns one session; all authoring flows through it.
 */
export function createRequestHandler(app: DesignerApp = new DesignerApp()) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/') {
        const html = renderPage();
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'cache-control': 'no-store',
        });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && path === '/api/export') {
        json(res, 200, { document: app.export() });
        return;
      }
      if (req.method === 'GET' && path === '/api/session') {
        json(res, 200, await app.state());
        return;
      }
      if (req.method === 'POST' && path === '/api/session') {
        const raw = await readBody(req);
        let action: SessionAction;
        try {
          action = JSON.parse(raw) as SessionAction;
        } catch {
          json(res, 400, { error: 'invalid JSON body' });
          return;
        }
        if (typeof action !== 'object' || action === null || typeof action.op !== 'string') {
          json(res, 400, { error: 'action must be an object with an "op" field' });
          return;
        }
        json(res, 200, await app.apply(action));
        return;
      }
      json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * The single self-contained HTML page: inline CSS and JS, no external assets.
 * The client only issues JSON actions and renders the YAML the server returns;
 * it performs no IaP authoring of its own.
 */
export function renderPage(): string {
  const palette = JSON.stringify(RESOURCE_PALETTE);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IaP Visual Designer (local shell)</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0f1420; color: #e6e9ef;
  }
  header { padding: 16px 20px; border-bottom: 1px solid #2a3142; background: #131a29; }
  header h1 { margin: 0; font-size: 16px; font-weight: 650; }
  header p { margin: 4px 0 0; color: #93a0b8; font-size: 12px; }
  main { display: grid; grid-template-columns: 320px 1fr; gap: 0; min-height: calc(100vh - 66px); }
  .panel { padding: 18px 20px; }
  .canvas { border-right: 1px solid #2a3142; }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #7c8aa5; margin: 0 0 8px; }
  .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  button {
    font: inherit; cursor: pointer; border: 1px solid #33507a; background: #1c2b45;
    color: #dbe6fb; padding: 7px 11px; border-radius: 7px;
  }
  button:hover { background: #244071; }
  button.ghost { border-color: #3a465c; background: transparent; color: #9fb0cc; }
  button.danger { border-color: #6b2b39; background: #2a1620; color: #f2b8c4; }
  input, select {
    font: inherit; background: #0c1320; color: #e6e9ef; border: 1px solid #2a3142;
    border-radius: 6px; padding: 6px 8px; width: 100%;
  }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
  label { display: block; font-size: 11px; color: #7c8aa5; margin: 0 0 3px; }
  .out { display: flex; flex-direction: column; }
  .status { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .badge { font-weight: 650; padding: 3px 10px; border-radius: 999px; font-size: 12px; }
  .badge.valid { background: #143324; color: #74e0a3; border: 1px solid #1f6b45; }
  .badge.invalid { background: #3a1620; color: #f2a3b3; border: 1px solid #7a2b3d; }
  pre {
    margin: 0; flex: 1; overflow: auto; background: #0a0f1a; border: 1px solid #1f2738;
    border-radius: 8px; padding: 14px; font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, monospace;
    white-space: pre; color: #cdd6e6; min-height: 300px;
  }
  .findings { margin-top: 12px; }
  .finding { font-size: 12px; padding: 6px 9px; border-radius: 6px; margin-bottom: 5px; }
  .finding.error { background: #2a1620; color: #f2a3b3; }
  .finding.warning { background: #2a2416; color: #e6cf8a; }
  .muted { color: #7c8aa5; font-size: 12px; }
  .rejected { margin-top: 10px; padding: 8px 10px; border-radius: 6px; background: #2a1620; color: #f2a3b3; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>IaP Visual Designer — local shell</h1>
  <p>The canvas is a view; the IaP document is the single source of truth. Every edit commits server-side through the compiler gate.</p>
</header>
<main>
  <section class="panel canvas">
    <p class="section-title">Add resource</p>
    <div class="btns" id="palette"></div>

    <p class="section-title">Connect</p>
    <div class="row">
      <div><label for="from">from</label><input id="from" placeholder="web" /></div>
      <div><label for="to">to</label><input id="to" placeholder="db" /></div>
    </div>
    <div class="btns"><button id="connect">Connect (connectsTo)</button></div>

    <p class="section-title">Remove</p>
    <div class="row" style="grid-template-columns: 1fr auto;">
      <input id="removeId" placeholder="resource id" />
      <button class="danger" id="remove">Remove</button>
    </div>

    <div class="btns" style="margin-top:18px;">
      <button class="ghost" id="reset">Reset session</button>
      <button class="ghost" id="export">Export YAML</button>
    </div>
    <p class="muted" id="hint"></p>
  </section>

  <section class="panel out">
    <div class="status">
      <span class="badge" id="badge">…</span>
      <span class="muted" id="meta">infrastructure.iap.yaml</span>
    </div>
    <pre id="yaml">(no resources yet — click a button to add one)</pre>
    <div class="rejected" id="rejected" style="display:none;"></div>
    <div class="findings" id="findings"></div>
  </section>
</main>
<script>
  const PALETTE = ${palette};
  const counters = {};
  const el = (id) => document.getElementById(id);

  async function post(action) {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    });
    return res.json();
  }

  function render(state) {
    el('yaml').textContent =
      state.document && state.document.trim() ? state.document : '(no resources yet)';
    const badge = el('badge');
    badge.textContent = state.valid ? 'valid IaP' : 'invalid';
    badge.className = 'badge ' + (state.valid ? 'valid' : 'invalid');

    const rej = el('rejected');
    if (state.ok === false && state.rejected && state.rejected.length) {
      rej.style.display = 'block';
      rej.textContent = 'Edit refused by the gate: ' + state.rejected.join('; ');
    } else {
      rej.style.display = 'none';
    }

    const f = el('findings');
    f.innerHTML = '';
    for (const finding of state.findings || []) {
      const div = document.createElement('div');
      div.className = 'finding ' + finding.severity;
      div.textContent = '[' + finding.code + '] ' + finding.path + ' — ' + finding.message;
      f.appendChild(div);
    }
  }

  // Build the palette buttons. The browser only names the resource and sends
  // the action; the server supplies the spec and generates the IaP.
  for (const kind of PALETTE) {
    const b = document.createElement('button');
    b.textContent = '+ ' + kind;
    b.onclick = async () => {
      counters[kind] = (counters[kind] || 0) + 1;
      const name = kind.toLowerCase() + (counters[kind] > 1 ? '-' + counters[kind] : '');
      render(await post({ op: 'addResource', kind, name }));
    };
    el('palette').appendChild(b);
  }

  el('connect').onclick = async () => {
    const from = el('from').value.trim();
    const to = el('to').value.trim();
    if (!from || !to) return;
    render(await post({ op: 'connect', from, to }));
  };
  el('remove').onclick = async () => {
    const id = el('removeId').value.trim();
    if (!id) return;
    render(await post({ op: 'remove', id }));
  };
  el('reset').onclick = async () => {
    for (const k of Object.keys(counters)) delete counters[k];
    render(await post({ op: 'reset' }));
  };
  el('export').onclick = async () => {
    const res = await fetch('/api/export');
    const { document } = await res.json();
    el('yaml').textContent = document && document.trim() ? document : '(empty)';
  };

  // Initial state.
  fetch('/api/session').then((r) => r.json()).then(render);
</script>
</body>
</html>`;
}
