/**
 * `@iap/designer` — the headless visual-designer session (roadmap Phase 15,
 * M15.1–M15.3). Every canvas edit commits through the compiler gate, so the
 * canvas is a view and the IaP document is the single source of truth; the
 * web designer shell is a thin client over this session. Produces valid,
 * deterministic IaP with inspectable per-field provenance.
 */
export { DesignerSession } from './session.js';
export type { EditResult } from './session.js';
