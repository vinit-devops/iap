/**
 * @iap/intent-compiler — the compiler operation model (spec ch. 19,
 * IEP-0009; M3.1) and the intent authoring engine above it (M3.2–M3.4).
 *
 * The closed set of typed, validated operations through which ALL authoring
 * surfaces — natural language, guided UI, IDE commands, visual designer —
 * mutate an IaP document. The core rule is normative: an LLM never writes
 * YAML into the source of truth. Proposals are data; `apply` is the gate;
 * only the committed result serializes bytes (OP-1).
 *
 * Layer boundary (ch. 19 / phase-3 exit criterion 5): this package depends
 * only on `@iap/model`, `@iap/parser`, and `@iap/sdk` (which composes
 * `@iap/validator` and `@iap/policy` for the dry-run pipeline) — never on
 * `@iap/provider-sdk`, `@iap/planner`, or any execution surface. The
 * compiler structurally cannot deploy.
 *
 * Public surface (pinned by test):
 * - `apply(document, batch, options)` — the operation gate; returns the
 *   committed result or the closed refusal set.
 * - `replay(baseDocument, logEntries, options)` — byte-identical replay of a
 *   committed batch (OP-2).
 * - `validateBatchStructure` / `compilerOperationsSchema` — structural stage
 *   as data (structured-output enforcement for model adapters, M3.4).
 * - `emptyDocument(name)` — a document skeleton to author into.
 * - Closed vocabularies: operation types, error codes, provenance sources,
 *   confirmation/proposal channels, stateful kinds, replacement-eligible
 *   paths, destructive reasons.
 *
 * Authoring engine (M3.2–M3.4) — everything below emits DATA (facets,
 * proposal batches, questions, prose); the gate above remains the only path
 * to document bytes:
 * - Facet model + embedded intent-facets schema (`facets.ts`), the
 *   deterministic NL rules extractor (`extract-rules.ts`), and the facet
 *   compiler (`compile.ts`).
 * - The deterministic clarification engine and answer flow (`clarify.ts`),
 *   the recommendation seam (`recommend.ts`), and semantic diff explanation
 *   (`explain.ts`).
 * - The vendor-neutral `ModelAdapter` boundary with enforcement middleware,
 *   the in-repo fixture/rules adapters (`adapter.ts`), and the versioned
 *   prompt registry (`prompts.ts`).
 */

export {
  CONFIRMATION_CHANNELS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  OPERATIONS_API_VERSION,
  OPERATION_TYPES,
  PROPOSAL_CHANNELS,
  STATEFUL_KINDS,
  emptyDocument,
} from './operations.js';
export type {
  Assumption,
  ChangeSetUnset,
  Clarification,
  ConfirmationChannel,
  CreateResourceChange,
  EchoedPreviewDiff,
  EchoedValidationResult,
  OperationBatch,
  OperationEnvelope,
  OperationProvenanceSource,
  OperationTarget,
  OperationType,
  PolicyChange,
  ProfileChange,
  ProposalChannel,
  ProposalProvenance,
  RelationshipRef,
  SourceSpan,
  StatefulKind,
} from './operations.js';

export { OPERATION_ERROR_CODES } from './errors.js';
export type { OperationErrorCode, OperationRefusal } from './errors.js';

export { compilerOperationsSchema, validateBatchStructure } from './schema.js';
export type { BatchStructureResult } from './schema.js';

export { apply } from './gate.js';
export type {
  ApplyOptions,
  ApplyResult,
  CommitSerializeFormat,
  CommittedBatch,
  ConfirmationRecord,
} from './gate.js';

export { replay } from './log.js';
export type { OperationLogEntry } from './log.js';

export { DESTRUCTIVE_REASONS, REPLACE_ELIGIBLE_PATHS } from './preview.js';
export type { DestructiveOperation, DestructiveReason, PreviewDiff } from './preview.js';

export { PROVENANCE_SOURCES } from './provenance.js';
export type { FieldProvenanceRecord } from './provenance.js';

/* -- M3.2: facets, extraction, compilation -------------------------- */

export {
  CONFIDENCE_TIERS,
  EXTRACTION_CHANNELS,
  FACET_TYPES,
  intentFacetsSchema,
  validateExtractionStructure,
} from './facets.js';
export type {
  AdapterUsage,
  ApplicationFacet,
  AvailabilityFacet,
  BackupFacet,
  BudgetFacet,
  ComplianceFacet,
  DataServiceFacet,
  EnvironmentFacet,
  ExistingResourceFacet,
  ExposureFacet,
  ExtractionChannel,
  ExtractionResult,
  ExtractionStructureIssue,
  ExtractionStructureResult,
  FacetBase,
  FacetType,
  IdentityFacet,
  IntentFacet,
  MessagingFacet,
  NetworkingFacet,
  OperationalFacet,
  ProviderPreferenceFacet,
  RecoveryObjectiveFacet,
  RegionFacet,
  RemovalFacet,
  ScalingFacet,
  SecretFacet,
  SecurityFacet,
  SubjectRef,
  UnparsedSpan,
  UnsupportedFinding,
  WorkloadFacet,
} from './facets.js';

export { extractRules } from './extract-rules.js';
export type { ExtractRulesOptions } from './extract-rules.js';

export { DEFAULT_RESOURCE_IDS, compileFacets } from './compile.js';
export type { CompileOptions, CompileResult, UnresolvedSubject } from './compile.js';

/* -- M3.2/M3.3: clarification, recommendation, explanation ---------- */

export {
  CLARIFICATION_TRIGGERS,
  HA_DATABASE_BUDGET_FLOOR_USD,
  applyClarificationAnswers,
  clarify,
  requiredConfirmations,
} from './clarify.js';
export type {
  AmendSet,
  AnswerApplicationResult,
  AnswerEffect,
  AnswerIdentity,
  ClarificationAnswer,
  ClarificationOption,
  ClarificationQuestion,
  ClarificationTrigger,
  ClarifyInput,
  ClarifyResult,
  ConfirmationReason,
  ConfirmationRequirement,
} from './clarify.js';

export { RECOMMENDATION_RULES, acceptRecommendations, recommend } from './recommend.js';
export type {
  AcceptedRecommendations,
  Recommendation,
  RecommendationAcceptance,
  RecommendationOrigin,
  RecommendationRule,
  RecommendOptions,
} from './recommend.js';

export { explainBatch } from './explain.js';
export type { ExplainOptions, ExplainResult } from './explain.js';

/* -- M3.4: model-provider abstraction -------------------------------- */

export {
  ADAPTER_ERROR_CODES,
  createAdapterSession,
  fixtureAdapter,
  rulesAdapter,
} from './adapter.js';
export type {
  AdapterContext,
  AdapterErrorCode,
  AdapterLimits,
  AdapterOutcome,
  AdapterRefusal,
  AdapterSession,
  AdapterSessionConfig,
  AdapterSessionUsage,
  AuthoringRequest,
  FixtureAdapterIdentity,
  ModelAdapter,
  PromptReference,
  RedactionHook,
} from './adapter.js';

export { getPrompt, promptRegistry } from './prompts.js';
export type { PromptArtifact, PromptRegistryEntry } from './prompts.js';

/* -- M3.5: natural-language authoring prototype --------------------- */

export { AUTHORING_OUTCOMES, runAuthoringSession } from './author.js';
export type {
  AuthoringOutcome,
  AuthoringSessionOptions,
  AuthoringSessionResult,
  ResolvedAnswer,
} from './author.js';
