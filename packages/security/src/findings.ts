/**
 * Security findings IAP601–IAP603 (spec ch. 15 §15.4/§15.5/§15.6), derived from
 * the canonical document at validation time. IAP604 (isolation unenforceable)
 * is a PLAN-time, mapping-specific code and is not derivable from the document
 * alone; it is emitted by the planner/mapping, not here. Deterministic: findings
 * are sorted by (code, path).
 */
import type { CanonicalModel, CanonicalResource, Finding } from '@iap/model';
import { DATA_KINDS } from './derive.js';

/** Frameworks under which an explicit encryption downgrade is an error (§15.6). */
const DOWNGRADE_FRAMEWORKS = new Set(['pci-dss-4.0', 'soc2']);

/** Field-name fragments that mark a value as likely secret material. */
const SECRET_KEY_RE = /pass(word)?|secret|token|credential|api[-_]?key|private[-_]?key/i;
/** Well-known token shapes (§15.5: entropy + well-known-token heuristics). */
const TOKEN_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];

function looksSecret(key: string, value: string): boolean {
  if (TOKEN_PATTERNS.some((re) => re.test(value))) return true;
  return SECRET_KEY_RE.test(key) && value.trim().length >= 8;
}

/** Walk configuration/x-* subtrees flagging secret-looking string values. */
function scanForSecrets(node: unknown, path: string, keyHint: string, out: Finding[]): void {
  if (typeof node === 'string') {
    if (looksSecret(keyHint, node)) {
      out.push({
        code: 'IAP602',
        severity: 'error',
        path,
        message: `plaintext secret material at ${path}: secret values must never appear in a document (use a Secret resource; ch. 15 §15.5)`,
      });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => scanForSecrets(item, `${path}/${i}`, keyHint, out));
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      scanForSecrets(v, `${path}/${k}`, k, out);
    }
  }
}

function activeFrameworks(model: CanonicalModel): Set<string> {
  const frameworks = model.compliance?.frameworks;
  return new Set(Array.isArray(frameworks) ? frameworks : []);
}

function hasInboundStoresData(model: CanonicalModel, id: string): boolean {
  return model.edges.some((edge) => edge.type === 'storesDataIn' && edge.target === id);
}

/** Compute IAP601–IAP603 for a canonical model. */
export function securityFindings(model: CanonicalModel): Finding[] {
  const findings: Finding[] = [];
  const frameworks = activeFrameworks(model);

  for (const id of Object.keys(model.resources)) {
    const resource = model.resources[id] as CanonicalResource;
    const spec = resource.spec;

    // IAP601 — public exposure on a data kind (contextual severity).
    if (DATA_KINDS.has(resource.kind) && spec.exposure === 'public') {
      const isStore = hasInboundStoresData(model, id);
      findings.push({
        code: 'IAP601',
        severity: isStore ? 'error' : 'warning',
        path: `/resources/${id}/spec/exposure`,
        message: `public exposure on data kind ${resource.kind} "${id}"${isStore ? ' that stores workload data' : ''} — data kinds should not be public (ch. 15 §15.4)`,
      });
    }

    // IAP603 — encryption downgrade under an active framework.
    const enc = spec.encryption;
    if (typeof enc === 'object' && enc !== null) {
      const e = enc as { atRest?: unknown; inTransit?: unknown };
      const anyFrameworkActive = [...frameworks].some((f) => DOWNGRADE_FRAMEWORKS.has(f));
      if (anyFrameworkActive) {
        for (const dim of ['atRest', 'inTransit'] as const) {
          if (e[dim] === 'preferred') {
            findings.push({
              code: 'IAP603',
              severity: 'error',
              path: `/resources/${id}/spec/encryption/${dim}`,
              message: `encryption.${dim} downgraded to 'preferred' on "${id}" while a compliance framework requiring encryption is active (ch. 15 §15.6)`,
            });
          }
        }
      }
    }

    // IAP602 — plaintext secret material in configuration or x-* fields.
    if (typeof spec.configuration === 'object' && spec.configuration !== null) {
      scanForSecrets(
        spec.configuration,
        `/resources/${id}/spec/configuration`,
        'configuration',
        findings,
      );
    }
    for (const [k, v] of Object.entries(resource as unknown as Record<string, unknown>)) {
      if (k.startsWith('x-')) scanForSecrets(v, `/resources/${id}/${k}`, k, findings);
    }
  }

  findings.sort((a, b) =>
    a.code === b.code ? a.path.localeCompare(b.path) : a.code.localeCompare(b.code),
  );
  return findings;
}

/* ------------------------------------------------------------------ */
/* Risk scoring                                                        */
/* ------------------------------------------------------------------ */

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** Deterministic risk of the whole report from its findings and posture. */
export function scoreRisk(findings: Finding[], publicDataKinds: number): RiskLevel {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  if (findings.some((f) => f.code === 'IAP602') || (publicDataKinds > 0 && errors > 0))
    return 'critical';
  if (errors > 0) return 'high';
  if (publicDataKinds > 0 || warnings > 1) return 'medium';
  if (warnings > 0) return 'low';
  return 'none';
}
