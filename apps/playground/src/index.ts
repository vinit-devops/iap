/**
 * `@iap/playground` — the transport-agnostic core of the IaP Planning
 * Playground (roadmap-v2 Phase 19, M19.5).
 *
 * A safe, local, PLAN-ONLY web app: a natural-language request goes through the
 * full plan-preview pipeline (`runPlanPreview`, see `./pipeline.ts`) server-side
 * and the derived artifacts come back to a thin browser view. The browser holds
 * no planning logic; it only renders what the server computes.
 *
 * Guardrails enforced here (roadmap-v2 §11 — the playground MUST NOT):
 * - Accept AWS credentials: every request body is scanned and any
 *   credential/profile/secret-looking key is rejected with 400. The server has
 *   no AWS SDK and no deploy path (it does not depend on `@iap/deploy-aws`).
 * - Deploy anything: there is no apply/deploy route — only plan preview.
 * - Store plaintext secrets: request bodies are never written to disk; results
 *   live in memory for the duration of the response only.
 * - Claim exact costs / compliance certification: the mandated disclaimers ride
 *   on every response and are shown in the UI.
 *
 * This module owns the request handler, the credential guard, the single HTML
 * page, and a `createServer` factory, so the smoke test can drive it directly.
 * `server.ts` is the thin `node:http` entry point (the `iap-playground` bin).
 */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { runPlanPreview } from './pipeline.js';

export { runPlanPreview, DEFAULT_TIMESTAMP, DISCLAIMERS } from './pipeline.js';
export type {
  PlanPreview,
  PlanPreviewInput,
  PlanPreviewSummary,
  PlanActionSummary,
  DependencyArc,
  AuthoringSummary,
  WireFinding,
} from './pipeline.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 5173;

/**
 * Key-name patterns that look like a credential, secret, or cloud profile.
 * A request body carrying any matching key (at any depth) is refused: this app
 * never accepts credentials and has no path that could use them (roadmap-v2
 * §11). The scan is over object KEYS, not string values, so a shared IaP
 * document that happens to mention "profiles" in its YAML text is unaffected.
 */
export const CREDENTIAL_KEY_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /password|passwd|pwd/i,
  /token/i,
  /credential/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /session[_-]?token/i,
  /api[_-]?key/i,
  /(^|[_-])profile$/i,
  /aws[_-]?/i,
];

/** Collect every object key (at any depth) that looks credential-ish. */
export function findCredentialKeys(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findCredentialKeys(item, `${path}[${index}]`)));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const here = path === '' ? key : `${path}.${key}`;
      if (CREDENTIAL_KEY_PATTERNS.some((re) => re.test(key))) hits.push(here);
      hits.push(...findCredentialKeys(child, here));
    }
  }
  return hits;
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
 * The plan-preview request handler. Routes:
 * - `GET /`               the self-contained single-page UI.
 * - `POST /api/plan`      `{ request }` or `{ document }` -> `runPlanPreview`.
 *                         A credential/profile/secret-looking key -> 400.
 * - `GET /api/share?d=`   base64 IaP document -> read-only reproduce.
 */
export function createRequestHandler() {
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

      if (req.method === 'GET' && path === '/api/share') {
        const encoded = url.searchParams.get('d');
        if (encoded === null || encoded === '') {
          json(res, 400, { error: 'missing ?d=<base64 document>' });
          return;
        }
        let document: string;
        try {
          document = Buffer.from(encoded, 'base64').toString('utf8');
        } catch {
          json(res, 400, { error: 'invalid base64 in ?d=' });
          return;
        }
        json(res, 200, await runPlanPreview({ document }));
        return;
      }

      if (req.method === 'POST' && path === '/api/plan') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { error: 'invalid JSON body' });
          return;
        }
        if (typeof body !== 'object' || body === null) {
          json(res, 400, { error: 'body must be a JSON object' });
          return;
        }

        // Guardrail: never accept credentials (roadmap-v2 §11). Any
        // credential/profile/secret-looking key refuses the whole request —
        // this server has no AWS SDK and no deploy path.
        const offending = findCredentialKeys(body);
        if (offending.length > 0) {
          json(res, 400, {
            error:
              'this playground is plan-only and never accepts credentials, profiles, or secrets',
            rejectedKeys: offending,
          });
          return;
        }

        const { request, document } = body as { request?: unknown; document?: unknown };
        if (typeof request !== 'string' && typeof document !== 'string') {
          json(res, 400, { error: 'provide a string `request` or `document`' });
          return;
        }
        const input: { request?: string; document?: string } = {};
        if (typeof request === 'string') input.request = request;
        if (typeof document === 'string') input.document = document;
        json(res, 200, await runPlanPreview(input));
        return;
      }

      json(res, 404, { error: `no route for ${req.method ?? '?'} ${path}` });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** Build an HTTP server over a fresh request handler. Callers `listen()` it. */
export function createServer(): Server {
  return createHttpServer(createRequestHandler());
}

/**
 * The single self-contained HTML page: inline CSS and JS, no external assets.
 * The client only issues JSON requests and renders the plan preview the server
 * returns; it performs no planning of its own. The mandated cost and compliance
 * disclaimers are rendered on their panels.
 */
export function renderPage(): string {
  // Client JS deliberately avoids template literals so this server-side
  // template literal needs no nested escaping.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IaP Planning Playground (local, plan-only)</title>
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
  header p { margin: 4px 0 0; color: #93a0b8; font-size: 12px; max-width: 90ch; }
  .safety { margin-top: 8px; font-size: 11px; color: #74e0a3; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px; }
  textarea {
    width: 100%; min-height: 84px; resize: vertical; font: inherit;
    background: #0c1320; color: #e6e9ef; border: 1px solid #2a3142; border-radius: 8px; padding: 10px 12px;
  }
  .actions { display: flex; gap: 10px; align-items: center; margin: 10px 0 4px; flex-wrap: wrap; }
  button {
    font: inherit; cursor: pointer; border: 1px solid #33507a; background: #1c2b45;
    color: #dbe6fb; padding: 8px 14px; border-radius: 7px;
  }
  button:hover { background: #244071; }
  button.ghost { border-color: #3a465c; background: transparent; color: #9fb0cc; }
  .examples { font-size: 12px; color: #7c8aa5; }
  .examples a { color: #8fb4ff; cursor: pointer; text-decoration: underline; margin-right: 12px; }
  .status { display: flex; align-items: center; gap: 10px; margin: 16px 0 4px; }
  .badge { font-weight: 650; padding: 3px 10px; border-radius: 999px; font-size: 12px; }
  .badge.valid { background: #143324; color: #74e0a3; border: 1px solid #1f6b45; }
  .badge.invalid { background: #3a1620; color: #f2a3b3; border: 1px solid #7a2b3d; }
  .badge.muted { background: #1a2233; color: #93a0b8; border: 1px solid #33405c; }
  .panel { margin-top: 16px; border: 1px solid #1f2738; border-radius: 10px; overflow: hidden; }
  .panel > h2 {
    margin: 0; padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: .07em;
    color: #9fb0cc; background: #131a29; border-bottom: 1px solid #1f2738;
  }
  .panel .body { padding: 12px 14px; }
  .disclaimer { font-size: 11px; color: #e6cf8a; margin: 0 0 8px; font-style: italic; }
  pre {
    margin: 0; overflow: auto; background: #0a0f1a; border: 1px solid #1f2738; border-radius: 8px;
    padding: 12px; font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre; color: #cdd6e6;
  }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1f2738; }
  th { color: #7c8aa5; font-weight: 600; }
  .finding { font-size: 12px; padding: 6px 9px; border-radius: 6px; margin-bottom: 5px; }
  .finding.error { background: #2a1620; color: #f2a3b3; }
  .finding.warning { background: #2a2416; color: #e6cf8a; }
  .muted { color: #7c8aa5; font-size: 12px; }
  code.k { color: #8fb4ff; }
  .notice { padding: 8px 10px; border-radius: 6px; background: #2a2416; color: #e6cf8a; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>IaP Planning Playground</h1>
  <p>Describe the infrastructure you want in plain language. The request is authored into an IaP document server-side and run through the full plan-preview pipeline: validation, architecture, dependencies, cost, security, compliance, and a deterministic AWS plan preview.</p>
  <p class="safety">Local &amp; plan-only. No credentials are accepted, nothing is deployed, and no request is written to disk.</p>
</header>
<main>
  <textarea id="request" placeholder="an internal web service connected to a managed postgres database"></textarea>
  <div class="actions">
    <button id="plan">Plan</button>
    <button class="ghost" id="share" disabled>Copy share link</button>
    <span class="muted" id="hint"></span>
  </div>
  <div class="examples">
    <span>try:</span>
    <a data-ex="an internal web service connected to a managed postgres database">web + postgres</a>
    <a data-ex="a public API gateway routing to an internal service with a redis cache">gateway + service + cache</a>
  </div>

  <div class="status">
    <span class="badge muted" id="badge">idle</span>
    <span class="muted" id="meta"></span>
  </div>

  <div id="notice"></div>

  <div class="panel"><h2>Generated IaP document</h2><div class="body"><pre id="doc">(none yet)</pre></div></div>
  <div class="panel"><h2>Validation</h2><div class="body" id="validation"><span class="muted">—</span></div></div>
  <div class="panel"><h2>Architecture (Mermaid)</h2><div class="body"><pre id="arch">—</pre></div></div>
  <div class="panel"><h2>Dependencies</h2><div class="body" id="deps"><span class="muted">—</span></div></div>
  <div class="panel"><h2>Cost</h2><div class="body"><p class="disclaimer" id="costDisc"></p><div id="cost"><span class="muted">—</span></div></div></div>
  <div class="panel"><h2>Security</h2><div class="body" id="security"><span class="muted">—</span></div></div>
  <div class="panel"><h2>Compliance</h2><div class="body"><p class="disclaimer" id="compDisc"></p><div id="compliance"><span class="muted">—</span></div></div></div>
  <div class="panel"><h2>AWS plan preview</h2><div class="body" id="plan"><span class="muted">—</span></div></div>
  <div class="panel"><h2>Provenance</h2><div class="body" id="prov"><span class="muted">—</span></div></div>
</main>
<script>
  var el = function (id) { return document.getElementById(id); };
  var lastDocument = null;

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }

  function renderFindings(container, findings) {
    if (!findings || findings.length === 0) { container.innerHTML = '<span class="muted">no findings</span>'; return; }
    container.innerHTML = '';
    findings.forEach(function (f) {
      var div = document.createElement('div');
      div.className = 'finding ' + f.severity;
      div.textContent = '[' + f.code + '] ' + f.path + ' — ' + f.message;
      container.appendChild(div);
    });
  }

  function renderTable(rows, headers) {
    if (!rows || rows.length === 0) return '<span class="muted">none</span>';
    var h = '<table><thead><tr>' + headers.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>';
    var b = rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return h + b + '</tbody></table>';
  }

  function render(state) {
    lastDocument = state.document || null;
    el('share').disabled = !lastDocument;

    var badge = el('badge');
    var committed = state.authoring && state.authoring.outcome === 'committed';
    if (!committed) {
      badge.className = 'badge muted'; badge.textContent = state.authoring ? state.authoring.outcome : 'no result';
    } else {
      badge.className = 'badge ' + (state.valid ? 'valid' : 'invalid');
      badge.textContent = state.valid ? 'valid IaP' : 'invalid';
    }

    var notice = el('notice');
    if (state.authoring && state.authoring.messages && state.authoring.messages.length && !state.document) {
      notice.innerHTML = '<div class="notice">' + state.authoring.messages.map(esc).join('<br>') + '</div>';
    } else { notice.innerHTML = ''; }

    el('doc').textContent = state.document || '(no document — the request did not commit)';
    renderFindings(el('validation'), state.findings);
    el('arch').textContent = (state.architecture && state.architecture.mermaid) || '—';

    var deps = state.dependencies || { arcs: [], waves: [] };
    var depHtml = renderTable(deps.arcs.map(function (a) { return [a.before, a.after]; }), ['before', 'after']);
    depHtml += '<p class="muted" style="margin-top:8px;">execution waves: ' +
      (deps.waves.length ? deps.waves.map(function (w, i) { return (i + 1) + ') ' + w.join(', '); }).join(' &nbsp; ') : 'none') + '</p>';
    el('deps').innerHTML = depHtml;

    el('costDisc').textContent = 'Cost is an ' + ((state.disclaimers && state.disclaimers.cost) || 'estimate.');
    if (state.cost) {
      var ids = Object.keys(state.cost.resources || {}).sort();
      var rows = ids.map(function (id) {
        var r = state.cost.resources[id];
        return [id, r.kind, r.confidence, (r.estimatedMonthly == null ? '—' : r.estimatedMonthly.toFixed(2) + '/mo')];
      });
      var total = state.cost.totals ? (state.cost.totals.estimatedMonthly.toFixed(2) + '/mo (' + state.cost.totals.confidence + ')') : '—';
      el('cost').innerHTML = renderTable(rows, ['resource', 'kind', 'confidence', 'est. monthly']) +
        '<p class="muted" style="margin-top:8px;">total: ' + esc(total) + ' &nbsp; currency: ' + esc(state.cost.currency) + '</p>';
    } else { el('cost').innerHTML = '<span class="muted">—</span>'; }

    if (state.security) {
      var grants = (state.security.grants || []).map(function (g) { return [g.principal, g.target + ' (' + g.targetKind + ')', g.access, g.via]; });
      el('security').innerHTML = '<p class="muted">risk: <code class="k">' + esc(state.security.risk) + '</code></p>' +
        renderTable(grants, ['principal', 'target', 'access', 'via']) +
        '<div style="margin-top:8px;"></div>';
      var secFind = document.createElement('div');
      renderFindings(secFind, state.security.findings);
      el('security').appendChild(secFind);
    } else { el('security').innerHTML = '<span class="muted">—</span>'; }

    el('compDisc').textContent = 'Compliance output is ' + ((state.disclaimers && state.disclaimers.compliance) || 'not a certification.');
    if (state.compliance) {
      var s = state.compliance.summary || { satisfied: 0, violated: 0, notApplicable: 0 };
      var ev = (state.compliance.evidence || []).map(function (e) { return [e.framework + '/' + e.control, e.title, e.disposition]; });
      el('compliance').innerHTML = '<p class="muted">frameworks: ' + esc((state.compliance.frameworks || []).join(', ') || 'none declared') +
        ' &nbsp; ' + s.satisfied + ' satisfied / ' + s.violated + ' violated / ' + s.notApplicable + ' n-a</p>' +
        renderTable(ev, ['control', 'title', 'disposition']) +
        '<p class="muted" style="margin-top:8px;">' + esc(state.compliance.disclaimer || '') + '</p>';
    } else { el('compliance').innerHTML = '<span class="muted">—</span>'; }

    var plan = state.plan || { planId: null, actions: [] };
    if (plan.planId) {
      var acts = plan.actions.map(function (a) { return [a.action, a.resource, a.reversibility, a.destructive ? 'destructive' : '']; });
      el('plan').innerHTML = '<p class="muted">planId: <code class="k">' + esc(plan.planId) + '</code> (deterministic; empty-state, all create)</p>' +
        renderTable(acts, ['action', 'resource', 'reversibility', 'flags']);
    } else if (plan.diagnostics && plan.diagnostics.length) {
      el('plan').innerHTML = '<p class="muted">outside the AWS coverage matrix:</p>' +
        plan.diagnostics.map(function (d) { return '<div class="finding warning">' + esc(d) + '</div>'; }).join('');
    } else { el('plan').innerHTML = '<span class="muted">—</span>'; }

    var prov = state.provenance || [];
    el('prov').innerHTML = prov.length
      ? renderTable(prov.map(function (p) { return [p.path, p.source, p.operationId]; }), ['field', 'source', 'operation'])
      : '<span class="muted">no per-field provenance (shared documents reproduce read-only)</span>';
  }

  async function plan() {
    var request = el('request').value.trim();
    if (!request) return;
    el('hint').textContent = 'planning…';
    el('badge').className = 'badge muted'; el('badge').textContent = 'planning…';
    try {
      var res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: request }),
      });
      var state = await res.json();
      if (!res.ok) { el('hint').textContent = state.error || ('HTTP ' + res.status); return; }
      el('hint').textContent = '';
      el('meta').textContent = 'authored with a pinned timestamp — deterministic';
      render(state);
    } catch (e) { el('hint').textContent = String(e); }
  }

  async function reproduce(encoded) {
    el('hint').textContent = 'reproducing shared plan…';
    try {
      var res = await fetch('/api/share?d=' + encodeURIComponent(encoded));
      var state = await res.json();
      if (!res.ok) { el('hint').textContent = state.error || ('HTTP ' + res.status); return; }
      el('hint').textContent = '';
      el('meta').textContent = 'reproduced from a shared document (read-only)';
      render(state);
    } catch (e) { el('hint').textContent = String(e); }
  }

  el('plan').onclick = plan;
  el('request').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') plan();
  });
  el('share').onclick = function () {
    if (!lastDocument) return;
    var link = location.origin + '/#d=' + b64encode(lastDocument);
    location.hash = 'd=' + b64encode(lastDocument);
    navigator.clipboard && navigator.clipboard.writeText(link);
    el('hint').textContent = 'share link copied';
  };
  Array.prototype.forEach.call(document.querySelectorAll('.examples a'), function (a) {
    a.onclick = function () { el('request').value = a.getAttribute('data-ex'); plan(); };
  });

  // Reproduce a shared plan when the page opens on a #d=<base64> fragment.
  var hash = location.hash.replace(/^#/, '');
  var m = /(?:^|&)d=([^&]+)/.exec(hash);
  if (m) reproduce(decodeURIComponent(m[1]));
</script>
</body>
</html>`;
}
