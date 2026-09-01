import type { Trace } from "@coeval/audit/runtime";
import type {
  ApiKey,
  CaseSource,
  Criterion,
  CriterionVersion,
  DatasetExposureEvent,
  DatasetItem,
  DatasetKind,
  DatasetRevision,
  DatasetRevisionItem,
  EvalRun,
  EvalRunDetail,
  EvalRunItem,
  EvaluatorSuite,
  EvaluatorSuiteManifest,
  GoldenSetEntry,
  GoldenSetRetirementContext,
  ImportJobRecord,
  JudgeRun,
  RegressionRunResult,
  ReviewQueueItem,
  ReviewQueueStatus,
  RunComparison,
  RuntimeIngestionPurpose,
  Skill,
  SkillVersion,
  TraceTestRevision,
  TraceTestSourceScope,
  TraceTestValidation,
  VerdictRecord
} from "@coeval/shared";
import type { datasetInputIdentity } from "../lib/dataset-revision.js";
import type {
  AssessmentReceiptArtifact,
  AssessmentReceiptComparison,
  FeedbackSyncContext,
  FeedbackSyncStatus,
  IronsideImportContext,
  LangSmithImportContext,
  LangfuseImportContext
} from "./contracts.js";

// One mutable state owner for the demo facade and its future domain slices.
// This is an internal composition seam, not a public repository API.
export class DemoRepositoryStore {
  readonly traces = new Map<string, Trace>();
  readonly caseInputIdentities = new Map<string, ReturnType<typeof datasetInputIdentity>>();
  readonly traceSources = new Map<string, {
    source: CaseSource;
    sourceTraceId: string;
    sourceTraceVersion?: string | undefined;
    sourceRemoteProjectId?: string | undefined;
    rawTraceId: string;
    ingestionPurpose: RuntimeIngestionPurpose;
    createdAt: string;
    sourceIntegrationId?: string | undefined;
    importJobId?: string | undefined;
  }>();
  readonly judgeRuns: JudgeRun[] = [];
  // Empty by default. DemoRepository seeds this collection only when its
  // existing seedVerdicts option is enabled; recordVerdict remains append-only.
  readonly verdicts: VerdictRecord[] = [];
  // Lazy unless seedVerdicts initializes the predecessor/current pair.
  skillVersions: SkillVersion[] | null = null;
  readonly regressionRuns = new Map<string, RegressionRunResult>();
  readonly reviewQueues: Array<{
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    status: ReviewQueueStatus;
    createdByUserId: string | null;
    createdAt: string;
    closedAt: string | null;
  }> = [];
  readonly reviewQueueItems: ReviewQueueItem[] = [];
  readonly langSmithIntegrations = new Map<string, LangSmithImportContext & {
    pollEnabled: boolean;
    pollIntervalMs: number;
  }>();
  readonly langSmithLastPolledAt = new Map<string, number>();
  readonly langfuseIntegrations = new Map<string, LangfuseImportContext & {
    pollEnabled: boolean;
    pollIntervalMs: number;
  }>();
  readonly langfuseLastPolledAt = new Map<string, number>();
  readonly ironsideIntegrations = new Map<string, IronsideImportContext & {
    pollEnabled: boolean;
    pollIntervalMs: number;
  }>();
  readonly ironsideLastPolledAt = new Map<string, number>();
  readonly feedbackJobs = new Map<string, FeedbackSyncContext & { status: FeedbackSyncStatus }>();
  readonly feedbackJobAttempts = new Map<string, number>();
  readonly feedbackJobLastError = new Map<string, string>();
  readonly feedbackJobRunIds = new Map<string, string>();
  readonly promotedGoldenSet: GoldenSetEntry[] = [];
  readonly retiredGoldenSetEntries = new Map<string, GoldenSetRetirementContext>();
  readonly importJobs: ImportJobRecord[] = [];
  // Plaintext is returned once; only the hash is retained in this demo store.
  readonly apiKeys: Array<{ record: ApiKey; keyHash: string }> = [];
  readonly traceTests: Array<{
    id: string;
    projectId: string;
    sourceCaseId: string | null;
    sourceCaseRef: string;
    sourceTraceRef: string;
    sourceSnapshot: unknown;
    sourceScope: TraceTestSourceScope;
    currentRevision: number;
    enabledRevision: number | null;
    createdByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [];
  readonly traceTestRevisions: TraceTestRevision[] = [];
  readonly traceTestValidations: TraceTestValidation[] = [];
  readonly traceTestFunnelEvents = new Set<string>();
  readonly datasets: Array<{
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    kind: DatasetKind;
    createdAt: string;
    archivedAt: string | null;
  }> = [];
  readonly datasetItems: DatasetItem[] = [];
  readonly datasetRevisions: DatasetRevision[] = [];
  readonly datasetRevisionItems: DatasetRevisionItem[] = [];
  readonly datasetExposureEvents: DatasetExposureEvent[] = [];
  readonly datasetRevisionIdempotency = new Map<string, string>();
  regressionDatasetRevisionId: string | null = null;
  readonly regressionDatasetRevisionIdsByCriterion = new Map<string, string>();
  readonly evalRuns: EvalRun[] = [];
  readonly evalRunItems: EvalRunItem[] = [];
  readonly convergenceEvalRuns = new Map<string, Promise<EvalRunDetail>>();
  readonly importedCaseEvalRuns = new Map<string, Promise<EvalRunDetail>>();
  readonly evalRunDispatches = new Map<string, {
    jobId: string;
    dispatchToken: string | null;
    claimedAt: number | null;
    dispatched: boolean;
  }>();
  readonly evalRunItemQueueJobs = new Map<string, string>();
  readonly evalRunItemDeliveryDeadlines = new Map<string, number>();
  readonly evalRunItemExecutions = new Map<string, {
    executionToken: string;
    claimedAt: number;
    providerCallStarted: boolean;
    providerCallReturned: boolean;
  }>();
  readonly assessmentReceiptArtifacts: AssessmentReceiptArtifact[] = [];
  readonly assessmentReceiptComparisons: AssessmentReceiptComparison[] = [];
  readonly runComparisons: RunComparison[] = [];
  readonly criteria: Criterion[] = [];
  readonly criterionVersions: CriterionVersion[] = [];
  readonly evaluatorSuites: EvaluatorSuite[] = [];
  readonly evaluatorSuiteManifests: Array<{
    manifest: EvaluatorSuiteManifest;
    canonicalBytes: Buffer;
    idempotencyKey: string;
    requestDigest: string;
  }> = [];
  readonly skillVersionCriteria = new Map<string, string>();
  readonly onboardingCheckRequests = new Map<string, { requestDigest: string; versionId: string }>();
  readonly criterionSkills = new Map<string, Skill>();
  // Plaintext in memory: encryption at rest is a PostgreSQL-only property.
  judgeProviderKeys = new Map<string, { apiKey: string; keyDisplay: string; createdAt: string }>();
  // CURRENT compatibility records for deprecated historical gate evidence.
  readonly gateChecks: Array<{
    id: string;
    projectId: string;
    skillVersionId: string;
    evalRunId: string;
    label: string | null;
    metadata: Record<string, unknown>;
    maxDisagreements: number;
    createdAt: string;
    items: Array<{
      id: string;
      goldenEntryId: string;
      goldenCaseId: string;
      caseKey: string;
      candidateCaseId: string;
      expectedLabel: "pass" | "fail";
      createdAt: string;
    }>;
  }> = [];
}
