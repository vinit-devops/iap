// Shared ORDERED, EXACT replacement rules for the IIS -> IaP rename engine
// (tools/rename-iis-to-iap.mjs) and its safety tests (tests/rename-safety.test.ts).
// Order matters: most-specific first, and every error-code / diagnostic family
// rule MUST precede the generic \bIIS\b / \biis\b rules so codes become IAP,
// never IaP. This is deliberately token-scoped — NEVER a blind s/iis/iap/.

export const RULES = [
  // 1. Error codes + hundred-block range refs + regex matchers: IIS followed by
  //    a phase digit 1-8 -> IAP, preserving the suffix (402, xx, 5[0-9]{2}, ...).
  [/\bIIS([1-8])/g, 'IAP$1'],
  // 2. Error-code REGEX character classes: any `IIS[` -> `IAP[` (uppercase).
  [/IIS(?=\[)/g, 'IAP'],
  // 3. Domain (covers all $id + apiVersion namespaces)
  ['iis.dev', 'iap.dev'],
  // 4. Package scope
  ['@iis/', '@iap/'],
  // 5. Compound project names
  ['iis-monorepo', 'iap-monorepo'],
  ['iis-language-server', 'iap-language-server'],
  ['iis-provider-', 'iap-provider-'],
  ['iis-mapping-v1.schema', 'iap-mapping-v1.schema'],
  ['iis-v1.schema', 'iap-v1.schema'],
  // 6. File-extension references
  ['.iis-map.yaml', '.iap-map.yaml'],
  ['.iis-map.yml', '.iap-map.yml'],
  ['.iis.yaml', '.iap.yaml'],
  ['.iis.yml', '.iap.yml'],
  // 7. LSP custom request methods (not preceded by @ — those are package scopes)
  ['iis/preview', 'iap/preview'],
  ['iis/canonical', 'iap/canonical'],
  // 8. MCP tool + LSP snake_case identifiers
  [/\biis_/g, 'iap_'],
  // 9. Environment variables IIS_* -> IAP_*
  [/\bIIS_/g, 'IAP_'],
  // 10. Public type identifiers Iis* -> IaP* (and IISSDK -> IaPSDK)
  ['IISSDK', 'IaPSDK'],
  [/\bIis/g, 'IaP'],
  // 11. Product-name prose
  ['Infrastructure Intent Specification', 'Infrastructure as Prompt'],
  ['IIS Enhancement Proposal', 'IaP Enhancement Proposal'],
  // 12. Standalone product-name tokens (after all compound/coded forms handled)
  [/\bIIS\b/g, 'IaP'],
  [/\biis\b/g, 'iap'],
];

export function applyRules(text) {
  let out = text;
  for (const [from, to] of RULES) {
    if (typeof from === 'string') out = out.split(from).join(to);
    else out = out.replace(from, to);
  }
  return out;
}
