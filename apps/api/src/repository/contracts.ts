import type { JudgeProvider, Trace } from "@coeval/audit/runtime";
import type {
  AssessmentReceipt,
  DatasetKind,
  DatasetReferenceProvenance,
  DatasetRevisionPayloadSnapshot,
  DatasetRevisionRole,
  EvalRunTrigger,
  ImportJobStatus,
  IronsideIntegration,
  IronsideSyncState,
  JudgeKeyProvider,
  JudgeRun,
  LangSmithIntegration,
  LangfuseIntegration,
  ManualTraceImportResult,
  PromoteGoldenSetInput,
  ProviderResponseMetadata,
  RuntimeIngestionPurpose,
  SkillVersion,
  TraceRedactionConfig,
  TraceSource,
  TraceStep,
  TraceTestDraftContent,
  TraceTestFunnelEventInput,
  TraceTestRunSource,
  TraceTestSourceScope,
  TraceTestValidationDiagnostic,
  TraceTestValidationEvaluator,
  TraceTestValidationEvidenceInput,
  TraceTestValidationMethod,
  VerdictPayload,
  VerdictSource
} from "@coeval/shared";
import type { NormalizedTraceStep } from "../lib/redaction.js";

// Public shapes at the repository boundary. Implementations continue to own
// storage behavior; this module stays declaration-only at runtime.
export interface CreateSkillVersionContext {
  projectId: string;
  actorUserId?: string | undefined;
  rubricProvenance?: SkillVersion["rubricProvenance"] | undefined;
  // First-run only: append this exact visible quality question to the seeded
  // native criterion and bind the new evaluator version in the same write.
  onboardingCriterion?: {
    name: string;
    definition: string;
    idempotencyKey: string;
    requestDigest: string;
  } | undefined;
  agentSetup?: {
    pairingId?: string | undefined;
    skillName: string;
    skillDescription: string;
    providerCredential?: { provider: JudgeKeyProvider; apiKey: string } | undefined;
  } | undefined;
}

export interface ConvergenceAuditPageInput {
  limit?: number | undefined;
  cursor?: string | null | undefined;
}

export type AssessmentReceiptArtifactSource = "terminal_mint" | "historical_freeze" | "correction";

export interface AssessmentReceiptArtifact {
  id: string;
  projectId: string;
  evalRunId: string;
  receiptId: string;
  contractVersion: number;
  artifactRevision: number;
  canonicalBytes: Buffer;
  artifactDigest: string;
  evidenceDigest: string;
  sourceSnapshotDigest: string;
  sourceKind: AssessmentReceiptArtifactSource;
  predecessorArtifactId: string | null;
  correctionReason: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface AssessmentReceiptComparison {
  id: string;
  projectId: string;
  evalRunId: string;
  artifactId: string;
  consumerReceiptId: string;
  consumerCanonicalBytes: Buffer;
  consumerArtifactDigest: string;
  comparisonStatus: "match" | "diverged";
  createdAt: string;
}

export interface CompareAssessmentReceiptCopyInput {
  projectId: string;
  evalRunId: string;
  consumerCanonicalBytes: Buffer;
}

export interface CreateAssessmentReceiptCorrectionInput {
  projectId: string;
  evalRunId: string;
  receipt: AssessmentReceipt;
  reason: string;
  createdByUserId?: string | undefined;
}

export interface CreateGateCheckInputDb {
  projectId: string;
  skillVersionId: string;
  evalRunId: string;
  label?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  maxDisagreements: number;
  createdByUserId?: string | undefined;
  items: Array<{
    goldenEntryId: string;
    goldenCaseId: string;
    // Snapshot of the golden entry's trace id — the CI-facing candidate key.
    caseKey: string;
    candidateCaseId: string;
    expectedLabel: "pass" | "fail";
  }>;
}

export interface CreateRunComparisonInputDb {
  projectId: string;
  datasetId: string;
  datasetRevisionId?: string | undefined;
  versionAId: string;
  versionBId: string;
  runAId: string;
  runBId: string;
}

export interface CreateEvalRunInputDb {
  projectId: string;
  skillVersionId: string;
  trigger: EvalRunTrigger;
  datasetId?: string | undefined;
  datasetRevisionId?: string | undefined;
  blocking?: boolean | undefined;
  createdByUserId?: string | undefined;
  sourceTraceTest?: TraceTestRunSource | undefined;
  items: Array<{
    caseId: string;
    datasetItemId?: string | undefined;
    datasetRevisionItemId?: string | undefined;
    clientItemId?: string | undefined;
    contentDigest?: string | undefined;
    expectedLabel?: "pass" | "fail" | undefined;
    expectedFailStep?: number | undefined;
    // cached items reuse the recorded verdict's failingStep.
    failingStep?: number | undefined;
    // Pre-terminal items (batch idempotency / recursive-trace skips) land in
    // the run already counted, so the queue only sees genuinely pending work.
    status?: "pending" | "completed" | "skipped" | undefined;
    verdictId?: string | undefined;
    resultLabel?: string | undefined;
    cached?: boolean | undefined;
    providerMetadata?: ProviderResponseMetadata | undefined;
  }>;
}

export interface CreateConvergenceEvalRunInputDb {
  projectId: string;
  skillVersionId: string;
  caseId: string;
  createdByUserId?: string | undefined;
}

export interface CreateImportedCaseEvalRunInputDb {
  projectId: string;
  skillVersionId: string;
  caseId: string;
}

export interface EvalRunDispatchInputDb {
  projectId: string;
  evalRunId: string;
  dispatchToken: string;
}

export type EvalRunDispatchClaim =
  | { state: "claimed"; jobId: string }
  | { state: "busy" | "dispatched"; jobId: string | null };

export interface EvalRunItemExecutionInputDb {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken: string;
}

export type EvalRunItemExecutionClaim =
  | { state: "claimed" }
  | { state: "busy" | "terminal" }
  | { state: "outcome_unknown"; executionToken: string; providerCallReturned: boolean };

export type EvalRunItemReleaseDisposition =
  | { state: "released" }
  | { state: "pre_call_held" }
  | { state: "provider_started"; providerCallReturned: boolean }
  | { state: "lost" };

export interface EvalRunItemReleaseOptions {
  // A terminal pre-call failure must keep its exact execution generation
  // until failEvalRunItem commits. Releasing first would let a redelivery
  // start the provider before an older handler's failure write.
  preservePreCallClaim?: boolean;
}

export interface StaleEvalRunItemExecution {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken: string | null;
  providerCallStarted: boolean;
  providerCallReturned: boolean;
}

export interface CompleteEvalRunItemInputDb {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken?: string | undefined;
  verdictId: string;
  resultLabel: string;
  // the judge-named failing step from the verdict payload (absent when
  // omitted/dropped).
  failingStep?: number | undefined;
  latencyMs?: number | undefined;
  // this call's token usage (absent when the provider didn't report).
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  providerMetadata?: ProviderResponseMetadata | undefined;
}

export interface FailEvalRunItemInputDb {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken?: string | undefined;
  error: string;
}

export interface CreateApiKeyInputDb {
  projectId: string;
  name: string;
  createdByUserId?: string | undefined;
}

export interface CreateTraceTestInputDb extends TraceTestDraftContent {
  projectId: string;
  sourceCaseId: string;
  sourceScope: TraceTestSourceScope;
  desiredBehavior: string;
  createdByUserId?: string | undefined;
}

export interface ReviseTraceTestInputDb extends TraceTestDraftContent {
  projectId: string;
  traceTestId: string;
  expectedRevision: number;
  desiredBehavior: string;
  createdByUserId?: string | undefined;
}

export interface RecordTraceTestValidationInputDb {
  projectId: string;
  traceTestId: string;
  revision: number;
  badEvidence: TraceTestValidationEvidenceInput;
  goodEvidence: TraceTestValidationEvidenceInput;
  method?: TraceTestValidationMethod | undefined;
  diagnostic?: TraceTestValidationDiagnostic | null | undefined;
  evaluator?: TraceTestValidationEvaluator | null | undefined;
  overrideReason?: string | null | undefined;
  badAttempts?: number | undefined;
  goodAttempts?: number | undefined;
  badUsage?: { inputTokens: number; outputTokens: number } | null | undefined;
  goodUsage?: { inputTokens: number; outputTokens: number } | null | undefined;
  recordedByUserId?: string | undefined;
}

export interface EnableTraceTestInputDb {
  projectId: string;
  traceTestId: string;
  expectedRevision: number;
  validationId: string;
  reviewedByUserId: string;
}

export interface RecordTraceTestFunnelEventInputDb extends TraceTestFunnelEventInput {
  projectId: string;
  actorUserId?: string | undefined;
}

export interface CreateDatasetInputDb {
  projectId: string;
  name: string;
  description?: string | undefined;
  kind?: DatasetKind | undefined;
  createdByUserId?: string | undefined;
}

export interface AddDatasetItemsInputDb {
  projectId: string;
  datasetId: string;
  items: Array<{ caseId: string; expectedLabel?: "pass" | "fail" | undefined; expectedFailStep?: number | undefined; note?: string | undefined }>;
}

// Skill Bench bulk ingestion (M0 C2): example cases + their dataset membership
// land atomically — a mid-flow failure must not strand membership-less cases.
// Items are pre-deduped by sourceTraceId (the route coalesces duplicates).
export interface ImportDatasetExamplesDbInput {
  projectId: string;
  datasetId: string;
  ingestionPurpose: Extract<RuntimeIngestionPurpose, "dataset_example" | "trace_test_synthetic">;
  items: Array<{
    sourceTraceId: string;
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown>;
    steps?: TraceStep[] | undefined;
    expectedLabel?: "pass" | "fail" | undefined;
    expectedFailStep?: number | undefined;
    note?: string | undefined;
  }>;
}

export interface ImportDatasetExamplesDbResult {
  items: Array<{ sourceTraceId: string; caseId: string; created: boolean; datasetItemId: string | null }>;
}

export interface CreateDatasetRevisionDbInput {
  projectId: string;
  datasetId: string;
  role: DatasetRevisionRole;
  expectedParentRevisionId?: string | undefined;
  idempotencyKey?: string | undefined;
  // Internal comparison runs may reuse the latest byte-identical snapshot;
  // explicit user freezes always create a new lineage revision.
  reuseLatestContent?: boolean | undefined;
  createdByUserId?: string | undefined;
}

export interface PreparedDatasetRevisionItem {
  sourceCaseId: string | null;
  sourceTraceId: string | null;
  sourceDatasetItemId: string | null;
  sourceGoldenEntryId: string | null;
  payloadSnapshot: DatasetRevisionPayloadSnapshot;
  inputDigest: string;
  itemDigest: string;
  referenceLabel: "pass" | "fail" | null;
  referenceFailStep: number | null;
  referenceProvenance: DatasetReferenceProvenance;
  note: string | null;
}

export interface AddQueueItemsInputDb {
  projectId: string;
  queueId: string;
  items: Array<{
    caseId: string;
    criterionVersionId?: string | undefined;
    assignedToUserId?: string | undefined;
  }>;
}

export interface CreateReviewQueueInputDb {
  projectId: string;
  name: string;
  description?: string | undefined;
  criterionVersionId?: string | undefined;
  caseIds: string[];
  createdByUserId?: string | undefined;
}

export interface RecordVerdictInput {
  projectId: string;
  caseId: string;
  source: VerdictSource;
  payload: VerdictPayload;
  skillVersionId?: string | undefined;
  actorUserId?: string | undefined;
  externalRunId?: string | undefined;
}

export interface ListCasesOptions {
  since?: string | undefined;
  limit?: number | undefined;
}

export interface CaseListEntry {
  caseId: string;
  sourceTraceId: string;
  createdAt: string;
  trace: {
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown>;
    steps?: NormalizedTraceStep[] | undefined;
  };
}

export interface ListVerdictsInput {
  projectId: string;
  caseId?: string | undefined;
  source?: VerdictSource | undefined;
  skillVersionId?: string | undefined;
  criterionId?: string | undefined;
  evidenceScope?: "all" | "customer" | undefined;
  limit: number;
}

export type TraceImportResult = Omit<ManualTraceImportResult, "queued" | "queueJobId"> & {
  created: boolean;
};

export interface JudgeRunContext {
  projectId: string;
  caseId: string;
  skillVersion: SkillVersion;
  trace: Trace;
}

export interface RecordJudgeRunInput {
  projectId: string;
  caseId: string;
  skillVersionId: string;
  verdict: Awaited<ReturnType<JudgeProvider["judge"]>>;
  rawRequest?: unknown;
  rawResponse?: unknown;
  // Wall-clock duration of the provider call (added early so eval runs have
  // latency history; cost capture follows with provider-usage plumbing).
  latencyMs?: number | undefined;
  // token usage from the provider envelope (absent when unreported).
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  providerMetadata?: {
    model: string | null;
    requestId: string | null;
    responseId: string | null;
    systemFingerprint: string | null;
  } | undefined;
}

export interface TraceImportContext {
  ingestionPurpose: RuntimeIngestionPurpose;
  sourceIntegrationId?: string | undefined;
  sourceTraceVersion?: string | undefined;
  /** Stable tenant identity at the upstream provider; part of import identity. */
  sourceRemoteProjectId?: string | undefined;
  importJobId?: string | undefined;
  normalizationVersion?: string | undefined;
  redactionConfig?: TraceRedactionConfig | undefined;
}

export interface CreateImportJobInput {
  projectId: string;
  source: TraceSource;
  sourceIntegrationId?: string | undefined;
  skillVersionId?: string | undefined;
  actorUserId?: string | undefined;
  requestedLimit?: number | undefined;
}

export interface CompleteImportJobInput {
  importedCount: number;
  queuedJudgeCount: number;
}

export interface ListImportJobsInput {
  projectId: string;
  status?: ImportJobStatus | undefined;
  limit: number;
}

export interface PromoteExceptionToGoldenSetInput extends PromoteGoldenSetInput {
  projectId: string;
  caseId: string;
  actorUserId?: string | undefined;
  actorName?: string | undefined;
}

export interface RetireGoldenSetEntryInput {
  projectId: string;
  entryId: string;
  actorUserId?: string | undefined;
  reason?: string | undefined;
}

export interface LangSmithImportContext extends LangSmithIntegration {
  apiKey: string;
  limit: number;
  redactionConfig?: TraceRedactionConfig | undefined;
}

export interface ClaimLangSmithImportTargetsInput {
  now: Date;
  intervalMs: number;
  batchSize: number;
  defaultLimit: number;
}

export interface LangfuseImportContext extends LangfuseIntegration {
  publicKey: string;
  secretKey: string;
  limit: number;
  redactionConfig?: TraceRedactionConfig | undefined;
}

export interface ClaimLangfuseImportTargetsInput {
  now: Date;
  intervalMs: number;
  batchSize: number;
  defaultLimit: number;
}

export interface IronsideImportContext extends IronsideIntegration {
  apiKey: string;
  limit: number;
  redactionConfig?: TraceRedactionConfig | undefined;
  syncState: IronsideSyncState;
  revalidationRequired: boolean;
  /** Monotonic connection identity CAS; never exposed through the public API. */
  connectionRevision: number;
}

export interface ClaimIronsideImportTargetsInput {
  now: Date;
  intervalMs: number;
  batchSize: number;
  defaultLimit: number;
}

export interface LangSmithCredentials extends LangSmithIntegration {
  apiKey: string;
}

export interface LangfuseCredentials extends LangfuseIntegration {
  publicKey: string;
  secretKey: string;
}

export interface IronsideCredentials extends IronsideIntegration {
  apiKey: string;
  connectionRevision: number;
}

export type FeedbackSyncProvider = "langsmith" | "langfuse" | "ironside";

export type FeedbackSyncStatus = "pending" | "sending" | "synced" | "failed" | "blocked";

export interface FeedbackSyncJobRecord {
  id: string;
  projectId: string;
  judgeRunId: string;
  provider: FeedbackSyncProvider;
  status: FeedbackSyncStatus;
}

export interface FeedbackSyncContext {
  id: string;
  projectId: string;
  provider: FeedbackSyncProvider;
  judgeRun: JudgeRun & { modelBinding: SkillVersion["modelBinding"] };
  sourceTraceId: string;
  sourceTraceVersion: string | null;
  criterionStableKey: string;
  integration: LangSmithCredentials | LangfuseCredentials | IronsideCredentials;
}

export interface ListFeedbackSyncJobsInput {
  projectId: string;
  status?: FeedbackSyncStatus | undefined;
  limit: number;
}

export interface FeedbackSyncJobListItem {
  id: string;
  projectId: string;
  judgeRunId: string;
  provider: FeedbackSyncProvider;
  status: FeedbackSyncStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export type ConvergenceCursor = {
  versionId: string;
  criterionVersionId: string;
  beforeVersionId: string | null;
  snapshotCreatedAt: string;
  snapshotId: string;
  rank: number;
  caseId: string;
};
