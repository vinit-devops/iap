/**
 * `@iap/migrate` — migration importers (roadmap Phase 18, M18.1). Translate
 * existing infrastructure into IaP THROUGH the operation gate, so an imported
 * result is validated IaP and any construct the importer cannot faithfully map
 * is reported explicitly, never guessed. The Kubernetes importer ships here;
 * Terraform, CloudFormation, Pulumi, and Crossplane importers implement the
 * same `ImportResult` contract.
 */
export { importKubernetes } from './kubernetes.js';
export type { ImportedResource, ImportResult, UnmappedResource } from './kubernetes.js';
