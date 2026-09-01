import type {
  ApiKey,
  AssessmentReceipt,
  Criterion,
  CriterionVersion,
  Dataset,
  DatasetExposureEvent,
  DatasetItem,
  DatasetKind,
  DatasetReferenceProvenance,
  DatasetRevision,
  DatasetRevisionItem,
  DatasetRevisionPayloadSnapshot,
  EvalRun,
  EvalRunItem,
  EvalRunItemStatus,
  EvalRunStatus,
  EvalRunTrigger,
  EvaluatorSuite,
  ExceptionCase,
  GateCheck,
  GateCheckItem,
  GoldenSetEntry,
  ImportJobRecord,
  ImportJobStatus,
  IronsideIntegration,
  JudgeRun,
  LangfuseIntegration,
  LangSmithIntegration,
  Project,
  ProjectSettings,
  RegressionRunResult,
  ReviewQueue,
  ReviewQueueItem,
  ReviewQueueStatus,
  RunComparison,
  Skill,
  SkillVersion,
  TraceTestRevision,
  TraceTestRunSource,
  TraceTestSummary,
  TraceTestValidation,
  VerdictRecord
} from "@coeval/shared";
import {
  deriveGateCheckDecision,
  IronsideConnectionTestResultSchema,
  LangfuseConnectionTestResultSchema,
  LangSmithConnectionTestResultSchema,
  RegressionRunResultSchema,
  SkillSchema,
  SkillVersionSchema,
  VerdictLabelSchema,
  VerdictPayloadSchema,
  VerdictRecordSchema
} from "@coeval/shared";
import { parseCanonicalReceiptBytes, receiptArtifactDigest } from "../lib/assessment-receipt.js";
import type {
  AssessmentReceiptArtifact,
  AssessmentReceiptArtifactSource,
  AssessmentReceiptComparison,
  FeedbackSyncJobRecord,
  FeedbackSyncProvider,
  FeedbackSyncStatus
} from "../repository/contracts.js";
import {
  AssessmentReceiptIntegrityError,
  DatasetRevisionConflictError
} from "../repository/errors.js";

export function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    mode: row.mode === "bench" ? "bench" : "tracing",
    traceProvider: row.trace_provider === "langsmith" || row.trace_provider === "langfuse" || row.trace_provider === "ironside" || row.trace_provider === "manual" ? row.trace_provider : "unknown",
    importedTraceCount: Number(row.imported_trace_count ?? 0),
    autoJudgedTraceCount: Number(row.auto_judged_trace_count ?? 0),
    syncBackCoverage: Number(row.sync_back_coverage ?? 0),
    traceRetentionDays: row.trace_retention_days === null || row.trace_retention_days === undefined ? null : Number(row.trace_retention_days),
    updatedAt: toIso(row.updated_at)
  };
}

export function rowToProjectSettings(row: Record<string, unknown>): ProjectSettings {
  return {
    projectId: String(row.id),
    name: String(row.name),
    mode: row.mode === "bench" ? "bench" : "tracing",
    traceRetentionDays: row.trace_retention_days === null || row.trace_retention_days === undefined ? null : Number(row.trace_retention_days)
  };
}

export function rowToCriterion(row: Record<string, unknown>): Criterion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    stableKey: String(row.stable_key),
    sourceKind: criterionSourceKind(row.source_kind),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

export function rowToCriterionVersion(row: Record<string, unknown>): CriterionVersion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    revision: Number(row.revision),
    name: String(row.name),
    definition: String(row.definition),
    criterionDigest: String(row.criterion_digest),
    sourceKind: criterionSourceKind(row.source_kind),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

function criterionSourceKind(value: unknown): "native" | "analysis_promotion" {
  if (value === "native" || value === "analysis_promotion") return value;
  throw new Error(`Unsupported criterion source kind: ${String(value)}`);
}

export function rowToEvaluatorSuite(row: Record<string, unknown>): EvaluatorSuite {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

export function rowToSkill(row: Record<string, unknown>): Skill {
  return SkillSchema.parse({
    id: String(row.id),
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    name: String(row.name),
    description: String(row.description),
    ownerName: String(row.owner_name ?? row.owner_email ?? row.owner_user_id ?? "Owner"),
    status: toSkillStatus(row.status),
    isStarter: row.is_starter === true,
    currentVersion: {
      id: String(row.version_id),
      skillId: String(row.id),
      criterionVersionId: String(row.version_criterion_version_id),
      version: String(row.version),
      status: toSkillStatus(row.version_status),
      rubricMarkdown: String(row.rubric_markdown),
      prompt: String(row.prompt),
      modelBinding: parseJson(row.model_binding),
      outputSchema: parseJson(row.output_schema),
      goldenSetAgreement: row.golden_set_agreement === null || row.golden_set_agreement === undefined ? null : Number(row.golden_set_agreement),
      tooStrictCount: Number(row.too_strict_count ?? 0),
      tooLenientCount: Number(row.too_lenient_count ?? 0),
      ambiguousCount: Number(row.ambiguous_count ?? 0),
      knownLimitations: Array.isArray(row.known_limitations) ? row.known_limitations.map(String) : [],
      verdictKind: String(row.verdict_kind),
      scalarRange: row.scalar_range == null ? null : parseJson(row.scalar_range),
      categoricalChoiceScores: row.categorical_choice_scores == null ? null : parseJson(row.categorical_choice_scores),
      rubricProvenance: String(row.rubric_provenance),
      onboardingAssurance: row.onboarding_assurance === "starter_unvalidated" ? "starter_unvalidated" : null,
      regressionDatasetRevisionId: row.regression_dataset_revision_id === null || row.regression_dataset_revision_id === undefined
        ? null
        : String(row.regression_dataset_revision_id),
      createdAt: toIso(row.version_created_at),
      approvedAt: row.approved_at ? toIso(row.approved_at) : null
    }
  });
}

export function rowToGoldenSetEntry(row: Record<string, unknown>): GoldenSetEntry {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    traceId: String(row.trace_id),
    agreedLabel: row.agreed_label === "fail" ? "fail" : "pass",
    reason: String(row.reason ?? ""),
    promotedBy: String(row.promoted_by ?? row.promoted_by_user_id ?? "Unknown"),
    promotedAt: toIso(row.promoted_at),
    sourceSkillVersionId: String(row.source_skill_version_id),
    criterionVersionId: String(row.criterion_version_id)
  };
}



export function rowToSkillVersion(row: Record<string, unknown>): SkillVersion {
  const scalarRangeRaw = row.scalar_range == null ? null : parseJson(row.scalar_range);
  const categoricalChoiceScoresRaw = row.categorical_choice_scores == null ? null : parseJson(row.categorical_choice_scores);
  return SkillVersionSchema.parse({
    id: String(row.id),
    skillId: String(row.skill_id),
    criterionVersionId: String(row.criterion_version_id),
    version: String(row.version),
    status: toSkillStatus(row.status),
    rubricMarkdown: String(row.rubric_markdown),
    prompt: String(row.prompt),
    modelBinding: parseJson(row.model_binding),
    outputSchema: parseJson(row.output_schema),
    goldenSetAgreement: row.golden_set_agreement === null || row.golden_set_agreement === undefined ? null : Number(row.golden_set_agreement),
    tooStrictCount: Number(row.too_strict_count ?? 0),
    tooLenientCount: Number(row.too_lenient_count ?? 0),
    ambiguousCount: Number(row.ambiguous_count ?? 0),
    knownLimitations: Array.isArray(row.known_limitations) ? row.known_limitations.map(String) : [],
    verdictKind: String(row.verdict_kind),
    scalarRange: scalarRangeRaw,
    categoricalChoiceScores: categoricalChoiceScoresRaw,
    rubricProvenance: String(row.rubric_provenance),
    onboardingAssurance: row.onboarding_assurance === "starter_unvalidated" ? "starter_unvalidated" : null,
    regressionDatasetRevisionId: row.regression_dataset_revision_id === null || row.regression_dataset_revision_id === undefined
      ? null
      : String(row.regression_dataset_revision_id),
    createdAt: toIso(row.created_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null
  });
}

export function rowToJudgeRun(row: Record<string, unknown>): JudgeRun {
  const metadata = row.provider_metadata && typeof parseJson(row.provider_metadata) === "object"
    ? parseJson(row.provider_metadata) as Record<string, unknown>
    : {};
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    caseId: String(row.case_id),
    skillVersionId: String(row.skill_version_id),
    verdict: row.verdict === "fail" ? "fail" : row.verdict === "ambiguous" ? "ambiguous" : "pass",
    score: Number(row.score),
    reasoning: String(row.reasoning),
    ...(row.latency_ms === null || row.latency_ms === undefined ? {} : { latencyMs: Number(row.latency_ms) }),
    providerMetadata: {
      model: typeof metadata.model === "string" ? metadata.model : null,
      requestId: typeof metadata.requestId === "string" ? metadata.requestId : null,
      responseId: typeof metadata.responseId === "string" ? metadata.responseId : null,
      systemFingerprint: typeof metadata.systemFingerprint === "string" ? metadata.systemFingerprint : null
    },
    createdAt: toIso(row.created_at)
  };
}

// Postgres unique_violation. Used to translate constraint backstops (e.g. the
// active-dataset-name partial index) into domain errors instead of 500s.
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export function isCheckViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23514";
}

export function postgresErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "Dataset revision violates an immutable evidence constraint";
}

export function rowToTraceTestSummary(row: Record<string, unknown>): TraceTestSummary {
  const currentRevision = Number(row.current_revision);
  const enabledRevision = row.enabled_revision === null || row.enabled_revision === undefined
    ? null
    : Number(row.enabled_revision);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sourceCaseId: row.source_case_id ? String(row.source_case_id) : null,
    sourceCaseRef: String(row.source_case_ref),
    sourceTraceRef: String(row.source_trace_ref),
    lifecycle: enabledRevision === null ? "draft" : "enabled",
    currentRevision,
    enabledRevision,
    hasUnpublishedChanges: enabledRevision !== null && currentRevision !== enabledRevision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function rowToTraceTestRevision(row: Record<string, unknown>): TraceTestRevision {
  return {
    id: String(row.id),
    traceTestId: String(row.trace_test_id),
    revision: Number(row.revision),
    lifecycle: row.lifecycle === "enabled" ? "enabled" : "draft",
    desiredBehavior: String(row.desired_behavior),
    scenario: String(row.scenario),
    expectedBehavior: String(row.expected_behavior),
    mustDo: parseJson(row.must_do) as string[],
    mustAvoid: parseJson(row.must_avoid) as string[],
    goodExample: parseJson(row.good_example) as TraceTestRevision["goodExample"],
    badExample: parseJson(row.bad_example) as TraceTestRevision["badExample"],
    checker: parseJson(row.checker) as TraceTestRevision["checker"],
    draftProvenance: parseJson(row.draft_provenance) as TraceTestRevision["draftProvenance"],
    validationId: row.validation_id ? String(row.validation_id) : null,
    validatedRevision: row.validated_revision === null || row.validated_revision === undefined
      ? null
      : Number(row.validated_revision),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    reviewedByUserId: row.reviewed_by_user_id ? String(row.reviewed_by_user_id) : null,
    createdAt: toIso(row.created_at),
    reviewedAt: row.reviewed_at ? toIso(row.reviewed_at) : null
  };
}

export function rowToTraceTestValidation(row: Record<string, unknown>): TraceTestValidation {
  return {
    id: String(row.id),
    traceTestId: String(row.trace_test_id),
    revision: Number(row.revision),
    status: String(row.status) as TraceTestValidation["status"],
    badEvidence: parseJson(row.bad_evidence) as TraceTestValidation["badEvidence"],
    goodEvidence: parseJson(row.good_evidence) as TraceTestValidation["goodEvidence"],
    method: String(row.method) as TraceTestValidation["method"],
    diagnostic: row.diagnostic === null || row.diagnostic === undefined ? null : String(row.diagnostic) as TraceTestValidation["diagnostic"],
    evaluator: row.evaluator === null || row.evaluator === undefined ? null : parseJson(row.evaluator) as TraceTestValidation["evaluator"],
    overrideReason: row.override_reason === null || row.override_reason === undefined ? null : String(row.override_reason),
    recordedByUserId: row.recorded_by_user_id ? String(row.recorded_by_user_id) : null,
    createdAt: toIso(row.created_at)
  };
}

export function rowToDataset(row: Record<string, unknown>, itemCount: number): Dataset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    kind: String(row.kind) as DatasetKind,
    itemCount,
    createdAt: toIso(row.created_at),
    archivedAt: row.archived_at ? toIso(row.archived_at) : null
  };
}

export function rowToDatasetItem(row: Record<string, unknown>): DatasetItem {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    caseId: String(row.case_id),
    traceId: String(row.trace_id),
    expectedLabel: row.expected_label ? (String(row.expected_label) as "pass" | "fail") : null,
    expectedFailStep: row.expected_fail_step === null || row.expected_fail_step === undefined ? null : Number(row.expected_fail_step),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    addedAt: toIso(row.added_at)
  };
}

export function normalizedPayloadSnapshot(value: unknown): DatasetRevisionPayloadSnapshot {
  const payload = parseJson(value) as {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    steps?: DatasetRevisionPayloadSnapshot["steps"];
  } | null;
  if (!payload || !("input" in payload) || !("output" in payload)) {
    throw new DatasetRevisionConflictError("Case has no complete retained normalized payload to freeze");
  }
  return {
    input: payload.input,
    output: payload.output,
    metadata: payload.metadata ?? {},
    ...(payload.steps ? { steps: payload.steps } : {})
  };
}

export function rowToDatasetRevision(row: Record<string, unknown>): DatasetRevision {
  const role = String(row.role) as DatasetRevision["role"];
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    seriesId: String(row.series_id),
    revisionNumber: Number(row.revision_number),
    sourceDatasetId: row.source_dataset_id === null || row.source_dataset_id === undefined ? null : String(row.source_dataset_id),
    parentRevisionId: row.parent_revision_id === null || row.parent_revision_id === undefined ? null : String(row.parent_revision_id),
    role,
    sourceKind: String(row.source_kind) as DatasetRevision["sourceKind"],
    identityBasis: "input-identity/v1",
    contentDigest: String(row.content_digest),
    revisionDigest: String(row.revision_digest),
    itemCount: Number(row.item_count),
    provenanceLevel: String(row.provenance_level) as DatasetRevision["provenanceLevel"],
    exposureState: role !== "sealed_validation"
      ? "visible_by_design"
      : Boolean(row.has_development_exposure) ? "exposed" : "protected",
    semanticLeakageDetection: "unsupported",
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined ? null : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

export function rowToDatasetRevisionItem(row: Record<string, unknown>): DatasetRevisionItem {
  return {
    id: String(row.id),
    revisionId: String(row.revision_id),
    position: Number(row.position),
    sourceCaseId: row.source_case_id === null || row.source_case_id === undefined ? null : String(row.source_case_id),
    sourceTraceId: row.source_trace_id === null || row.source_trace_id === undefined ? null : String(row.source_trace_id),
    sourceDatasetItemId: row.source_dataset_item_id === null || row.source_dataset_item_id === undefined ? null : String(row.source_dataset_item_id),
    sourceGoldenEntryId: row.source_golden_entry_id === null || row.source_golden_entry_id === undefined ? null : String(row.source_golden_entry_id),
    inputDigest: String(row.input_digest),
    itemDigest: String(row.item_digest),
    payloadSnapshot: normalizedPayloadSnapshot(row.payload_snapshot),
    referenceLabel: row.reference_label === "pass" || row.reference_label === "fail" ? row.reference_label : null,
    referenceFailStep: row.reference_fail_step === null || row.reference_fail_step === undefined ? null : Number(row.reference_fail_step),
    referenceProvenance: parseJson(row.reference_provenance) as DatasetReferenceProvenance,
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: toIso(row.created_at)
  };
}

export function rowToDatasetExposureEvent(row: Record<string, unknown>): DatasetExposureEvent {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    revisionId: String(row.revision_id),
    revisionItemId: row.revision_item_id === null || row.revision_item_id === undefined ? null : String(row.revision_item_id),
    kind: String(row.kind) as DatasetExposureEvent["kind"],
    exposureClass: String(row.exposure_class) as DatasetExposureEvent["exposureClass"],
    activity: String(row.activity) as DatasetExposureEvent["activity"],
    subjectKind: String(row.subject_kind) as DatasetExposureEvent["subjectKind"],
    subjectId: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
    evidenceRefKind: row.evidence_ref_kind === null || row.evidence_ref_kind === undefined ? null : String(row.evidence_ref_kind),
    evidenceRefId: row.evidence_ref_id === null || row.evidence_ref_id === undefined ? null : String(row.evidence_ref_id),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    details: (parseJson(row.details) ?? {}) as Record<string, unknown>,
    occurredAt: toIso(row.occurred_at)
  };
}

export function rowToEvalRun(row: Record<string, unknown>): EvalRun {
  const sourceTraceTest: TraceTestRunSource | null = row.source_trace_test_id
    ? {
        traceTestId: String(row.source_trace_test_id),
        revision: Number(row.source_trace_test_revision),
        validationRevision: Number(row.source_trace_test_validation_revision),
        validationId: String(row.source_trace_test_validation_id),
        sourceCaseRef: String(row.source_trace_test_case_ref),
        caseId: String(row.source_trace_test_case_id),
        datasetItemId: String(row.source_trace_test_dataset_item_id)
      }
    : null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    datasetId: row.dataset_id ? String(row.dataset_id) : null,
    datasetRevisionId: row.dataset_revision_id ? String(row.dataset_revision_id) : null,
    skillVersionId: String(row.skill_version_id),
    trigger: String(row.trigger) as EvalRunTrigger,
    status: String(row.status) as EvalRunStatus,
    blocking: Boolean(row.blocking),
    totalItems: Number(row.total_items),
    completedItems: Number(row.completed_items),
    failedItems: Number(row.failed_items),
    agreedItems: Number(row.agreed_items),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    sourceTraceTest,
    createdAt: toIso(row.created_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    finishedAt: row.finished_at ? toIso(row.finished_at) : null
  };
}

export function rowToAssessmentReceiptArtifact(row: Record<string, unknown>): AssessmentReceiptArtifact {
  const canonicalBytes = Buffer.from(row.canonical_bytes as Uint8Array);
  let receipt: AssessmentReceipt;
  try {
    receipt = parseCanonicalReceiptBytes(canonicalBytes);
  } catch (error) {
    throw new AssessmentReceiptIntegrityError(
      `Persisted assessment receipt bytes failed validation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const artifactDigest = String(row.artifact_digest);
  if (artifactDigest !== receiptArtifactDigest(canonicalBytes)) {
    throw new AssessmentReceiptIntegrityError("Persisted assessment receipt artifactDigest mismatch");
  }
  const projectId = String(row.project_id);
  const evalRunId = String(row.eval_run_id);
  const receiptId = String(row.receipt_id);
  const contractVersion = Number(row.contract_version);
  const evidenceDigest = String(row.evidence_digest);
  if (
    receipt.projectId !== projectId ||
    receipt.evalRunId !== evalRunId ||
    receipt.receiptId !== receiptId ||
    receipt.schemaVersion !== contractVersion ||
    receipt.evidenceDigest !== evidenceDigest
  ) {
    throw new AssessmentReceiptIntegrityError("Persisted assessment receipt columns do not match its canonical bytes");
  }
  return {
    id: String(row.id),
    projectId,
    evalRunId,
    receiptId,
    contractVersion,
    artifactRevision: Number(row.artifact_revision),
    canonicalBytes,
    artifactDigest,
    evidenceDigest,
    sourceSnapshotDigest: String(row.source_snapshot_digest),
    sourceKind: String(row.source_kind) as AssessmentReceiptArtifactSource,
    predecessorArtifactId: row.predecessor_artifact_id === null || row.predecessor_artifact_id === undefined
      ? null
      : String(row.predecessor_artifact_id),
    correctionReason: row.correction_reason === null || row.correction_reason === undefined
      ? null
      : String(row.correction_reason),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

export function rowToAssessmentReceiptComparison(row: Record<string, unknown>): AssessmentReceiptComparison {
  const consumerCanonicalBytes = Buffer.from(row.consumer_canonical_bytes as Uint8Array);
  let receipt: AssessmentReceipt;
  try {
    receipt = parseCanonicalReceiptBytes(consumerCanonicalBytes);
  } catch (error) {
    throw new AssessmentReceiptIntegrityError(
      `Persisted consumer receipt bytes failed validation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const projectId = String(row.project_id);
  const evalRunId = String(row.eval_run_id);
  const consumerReceiptId = String(row.consumer_receipt_id);
  const consumerArtifactDigest = String(row.consumer_artifact_digest);
  const comparisonStatus = String(row.comparison_status);
  if (consumerArtifactDigest !== receiptArtifactDigest(consumerCanonicalBytes)) {
    throw new AssessmentReceiptIntegrityError("Persisted consumer receipt artifactDigest mismatch");
  }
  if (
    receipt.projectId !== projectId ||
    receipt.evalRunId !== evalRunId ||
    receipt.receiptId !== consumerReceiptId
  ) {
    throw new AssessmentReceiptIntegrityError("Persisted consumer receipt columns do not match its canonical bytes");
  }
  if (comparisonStatus !== "match" && comparisonStatus !== "diverged") {
    throw new AssessmentReceiptIntegrityError("Persisted consumer receipt comparison status is invalid");
  }
  return {
    id: String(row.id),
    projectId,
    evalRunId,
    artifactId: String(row.artifact_id),
    consumerReceiptId,
    consumerCanonicalBytes,
    consumerArtifactDigest,
    comparisonStatus,
    createdAt: toIso(row.created_at)
  };
}

export function rowToRunComparison(row: Record<string, unknown>): RunComparison {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    datasetId: String(row.dataset_id),
    datasetRevisionId: row.dataset_revision_id ? String(row.dataset_revision_id) : null,
    versionAId: String(row.version_a_id),
    versionBId: String(row.version_b_id),
    runAId: String(row.run_a_id),
    runBId: String(row.run_b_id),
    createdAt: toIso(row.created_at)
  };
}

export function rowToEvalRunItem(row: Record<string, unknown>): EvalRunItem {
  return {
    id: String(row.id),
    evalRunId: String(row.eval_run_id),
    caseId: String(row.case_id),
    datasetItemId: row.dataset_item_id ? String(row.dataset_item_id) : null,
    datasetRevisionItemId: row.dataset_revision_item_id ? String(row.dataset_revision_item_id) : null,
    clientItemId: row.client_item_id === null || row.client_item_id === undefined ? null : String(row.client_item_id),
    contentDigest: row.content_digest === null || row.content_digest === undefined ? null : String(row.content_digest),
    status: String(row.status) as EvalRunItemStatus,
    verdictId: row.verdict_id ? String(row.verdict_id) : null,
    expectedLabel: row.expected_label ? (String(row.expected_label) as "pass" | "fail") : null,
    expectedFailStep: row.expected_fail_step === null || row.expected_fail_step === undefined ? null : Number(row.expected_fail_step),
    failingStep: row.failing_step === null || row.failing_step === undefined ? null : Number(row.failing_step),
    resultLabel: row.result_label === null || row.result_label === undefined ? null : String(row.result_label),
    agreement: row.agreement === null || row.agreement === undefined ? null : Boolean(row.agreement),
    // Tri-state, never blended into overall agreement: true/false only when
    // BOTH the expectation and the judge's named step exist.
    stepAgreement:
      row.expected_fail_step === null || row.expected_fail_step === undefined ||
      row.failing_step === null || row.failing_step === undefined
        ? null
        : Number(row.expected_fail_step) === Number(row.failing_step),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
    providerMetadata: row.provider_metadata === null || row.provider_metadata === undefined
      ? null
      : parseJson(row.provider_metadata) as EvalRunItem["providerMetadata"],
    cached: Boolean(row.cached),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: toIso(row.created_at),
    finishedAt: row.finished_at ? toIso(row.finished_at) : null
  };
}

// Eval-run counter columns a gate-check projection needs, aliased so they
// can't collide with gate_checks' own columns (both tables have created_at).
export const GATE_CHECK_RUN_COLUMNS =
  `er.status as run_status, er.total_items as run_total_items,
   er.completed_items as run_completed_items, er.failed_items as run_failed_items,
   er.agreed_items as run_agreed_items, er.finished_at as run_finished_at`;

export function rowToGateCheck(row: Record<string, unknown>): GateCheck {
  const maxDisagreements = Number(row.max_disagreements);
  const decision = deriveGateCheckDecision({
    runStatus: String(row.run_status) as EvalRunStatus,
    totalItems: Number(row.run_total_items),
    completedItems: Number(row.run_completed_items),
    failedItems: Number(row.run_failed_items),
    agreedItems: Number(row.run_agreed_items),
    maxDisagreements
  });
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    skillVersionId: String(row.skill_version_id),
    evalRunId: String(row.eval_run_id),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    metadata: (parseJson(row.metadata) ?? {}) as Record<string, unknown>,
    maxDisagreements,
    status: decision.status,
    totalCandidates: Number(row.run_total_items),
    judgedCandidates: Number(row.run_completed_items),
    erroredCandidates: Number(row.run_failed_items),
    disagreements: decision.disagreements,
    createdAt: toIso(row.created_at),
    finishedAt: row.run_finished_at ? toIso(row.run_finished_at) : null
  };
}

export function rowToGateCheckItem(row: Record<string, unknown>): GateCheckItem {
  const evalStatus = row.eval_status === null || row.eval_status === undefined ? null : String(row.eval_status);
  return {
    id: String(row.id),
    gateCheckId: String(row.gate_check_id),
    goldenEntryId: String(row.golden_entry_id),
    goldenCaseId: String(row.golden_case_id),
    caseKey: String(row.case_key),
    candidateCaseId: String(row.candidate_case_id),
    expectedLabel: String(row.expected_label) as "pass" | "fail",
    status: evalStatus === "completed" ? "completed" : evalStatus === "failed" ? "failed" : "pending",
    judgedLabel: row.result_label === null || row.result_label === undefined ? null : String(row.result_label),
    agreement: row.agreement === null || row.agreement === undefined ? null : Boolean(row.agreement),
    cached: Boolean(row.cached),
    error: row.eval_error === null || row.eval_error === undefined ? null : String(row.eval_error),
    createdAt: toIso(row.created_at)
  };
}

export function rowToApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    keyPrefix: String(row.key_prefix),
    createdAt: toIso(row.created_at),
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : null,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : null
  };
}

export function rowToExceptionCase(row: Record<string, unknown>): ExceptionCase {
  const payload = parseJson(row.normalized_payload) as { metadata?: Record<string, unknown>; input?: unknown };
  const rawResponse = row.raw_response ? parseJson(row.raw_response) as { failureCategory?: unknown } : {};
  const sourceTraceId = String(row.source_trace_id ?? row.case_id);
  const verdict = VerdictLabelSchema.safeParse(row.verdict).data ?? "fail";
  const latestVerdict = VerdictLabelSchema.safeParse(row.latest_verdict).data ?? null;
  const latestJudgeRunId = row.latest_judge_run_id === null || row.latest_judge_run_id === undefined
    ? null
    : String(row.latest_judge_run_id);
  const judgeRunId = String(row.judge_run_id ?? row.id ?? "");
  const latestReason = row.latest_reasoning === null || row.latest_reasoning === undefined
    ? null
    : String(row.latest_reasoning);
  const reason = String(row.reasoning ?? "");
  const rejudgedSince = latestJudgeRunId && latestJudgeRunId !== judgeRunId && latestVerdict && (
    latestVerdict !== verdict || latestReason !== reason
  )
    ? {
        judgeRunId: latestJudgeRunId,
        verdict: latestVerdict,
        reason: latestReason ?? "",
        createdAt: row.latest_created_at ? toIso(row.latest_created_at) : toIso(row.created_at)
      }
    : null;
  const title = typeof payload.metadata?.name === "string" && payload.metadata.name
    ? payload.metadata.name
    : `Trace ${sourceTraceId}`;
  return {
    id: String(row.case_id),
    traceId: sourceTraceId,
    title,
    ...(judgeRunId ? { judgeRunId } : {}),
    ...(row.skill_version_id ? { skillVersionId: String(row.skill_version_id) } : {}),
    ...(row.criterion_version_id ? { criterionVersionId: String(row.criterion_version_id) } : {}),
    // The recorded label verbatim. This mapper also backs getCaseDetail (any
    // judged case, not just exceptions), so coercing an unrecognized label to
    // "fail" would misrepresent the recorded evidence in the UI.
    verdict,
    reason,
    ...(rejudgedSince ? { rejudgedSince } : {}),
    capabilityGap: typeof rawResponse.failureCategory === "string" ? rawResponse.failureCategory : undefined,
    reviewerState: "needs_review",
    createdAt: toIso(row.created_at)
  };
}

export function rowToLangSmithIntegration(row: Record<string, unknown>): LangSmithIntegration {
  const config = parseJson(row.config) as { projectName?: string | null; endpointUrl?: string | null; skillVersionId?: string | null };
  const lastTestResult = row.last_test_result == null
    ? null
    : LangSmithConnectionTestResultSchema.parse(parseJson(row.last_test_result));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    provider: "langsmith",
    skillVersionId: config.skillVersionId ?? null,
    projectName: config.projectName ?? null,
    endpointUrl: config.endpointUrl ?? null,
    pollEnabled: row.poll_enabled !== false,
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
    pollLimit: Number(row.poll_limit ?? 25),
    lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
    lastTestResult,
    createdAt: toIso(row.created_at)
  };
}

export function rowToLangfuseIntegration(row: Record<string, unknown>): LangfuseIntegration {
  const config = parseJson(row.config) as { projectName?: string | null; endpointUrl?: string | null; skillVersionId?: string | null };
  const lastTestResult = row.last_test_result == null
    ? null
    : LangfuseConnectionTestResultSchema.parse(parseJson(row.last_test_result));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    provider: "langfuse",
    skillVersionId: config.skillVersionId ?? null,
    projectName: config.projectName ?? null,
    endpointUrl: config.endpointUrl ?? null,
    pollEnabled: row.poll_enabled !== false,
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
    pollLimit: Number(row.poll_limit ?? 25),
    lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
    lastTestResult,
    createdAt: toIso(row.created_at)
  };
}

export function rowToIronsideIntegration(row: Record<string, unknown>): IronsideIntegration {
  const config = parseJson(row.config) as {
    url?: string;
    remoteProjectId?: string;
    remoteProjectName?: string;
    protocolVersion?: string;
    settlementQuietPeriodSeconds?: number;
    connectionRevision?: number;
    revalidationRequired?: boolean;
    skillVersionId?: string | null;
  };
  if (
    !config.url || !config.remoteProjectId || !config.remoteProjectName ||
    config.protocolVersion !== "ironside/evaluator/v1" ||
    typeof config.settlementQuietPeriodSeconds !== "number" ||
    !Number.isFinite(config.settlementQuietPeriodSeconds) ||
    typeof config.connectionRevision !== "number" ||
    !Number.isSafeInteger(config.connectionRevision) ||
    typeof config.revalidationRequired !== "boolean"
  ) throw new Error(`Invalid stored Ironside integration config: ${String(row.id)}`);
  const lastTestResult = row.last_test_result == null
    ? null
    : IronsideConnectionTestResultSchema.parse(parseJson(row.last_test_result));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    provider: "ironside",
    skillVersionId: config.skillVersionId ?? null,
    url: config.url,
    remoteProjectId: config.remoteProjectId,
    remoteProjectName: config.remoteProjectName,
    protocolVersion: "ironside/evaluator/v1",
    settlementQuietPeriodSeconds: config.settlementQuietPeriodSeconds,
    revalidationRequired: config.revalidationRequired,
    pollEnabled: row.poll_enabled !== false,
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
    pollLimit: Number(row.poll_limit ?? 25),
    lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
    lastTestResult,
    createdAt: toIso(row.created_at)
  };
}

export function toFeedbackSyncProvider(value: unknown): FeedbackSyncProvider {
  return value === "langfuse" ? "langfuse" : value === "ironside" ? "ironside" : "langsmith";
}

export function rowToFeedbackSyncJobRecord(row: Record<string, unknown>): FeedbackSyncJobRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    judgeRunId: String(row.judge_run_id),
    provider: toFeedbackSyncProvider(row.provider),
    status: toFeedbackSyncStatus(row.status)
  };
}

export function rowToImportJobRecord(row: Record<string, unknown>): ImportJobRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    source: row.source === "langfuse" ? "langfuse" : row.source === "langsmith" ? "langsmith" : row.source === "ironside" ? "ironside" : "manual",
    sourceIntegrationId: row.source_integration_id === null || row.source_integration_id === undefined ? null : String(row.source_integration_id),
    skillVersionId: row.skill_version_id === null || row.skill_version_id === undefined
      ? null
      : String(row.skill_version_id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
    actorEmail: row.actor_email === null || row.actor_email === undefined ? null : String(row.actor_email),
    actorName: row.actor_name === null || row.actor_name === undefined ? null : String(row.actor_name),
    queueJobId: row.queue_job_id === null || row.queue_job_id === undefined ? null : String(row.queue_job_id),
    status: toImportJobStatus(row.status),
    requestedLimit: row.requested_limit === null || row.requested_limit === undefined ? null : Number(row.requested_limit),
    importedCount: Number(row.imported_count ?? 0),
    queuedJudgeCount: Number(row.queued_judge_count ?? 0),
    createdAt: toIso(row.created_at ?? row.started_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    error: row.error === null || row.error === undefined ? null : String(row.error)
  };
}

function toImportJobStatus(value: unknown): ImportJobStatus {
  return value === "running" || value === "completed" || value === "failed" ? value : "queued";
}

export function rowToVerdictRecord(row: Record<string, unknown>): VerdictRecord {
  return VerdictRecordSchema.parse({
    id: String(row.id),
    projectId: String(row.project_id),
    caseId: String(row.case_id),
    skillVersionId: row.skill_version_id === null || row.skill_version_id === undefined ? null : String(row.skill_version_id),
    source: String(row.source),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
    actorName: row.actor_name === null || row.actor_name === undefined ? null : String(row.actor_name),
    payload: VerdictPayloadSchema.parse(parseJson(row.payload)),
    externalRunId: row.external_run_id === null || row.external_run_id === undefined ? null : String(row.external_run_id),
    createdAt: toIso(row.created_at)
  });
}

export function rowToReviewQueue(row: Record<string, unknown>): ReviewQueue {
  const rawStatus = String(row.status);
  const status: ReviewQueueStatus = rawStatus === "closed" ? "closed" : "open";
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    status,
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined ? null : String(row.created_by_user_id),
    createdAt: toIso(row.created_at),
    closedAt: row.closed_at ? toIso(row.closed_at) : null,
    pendingCount: Number(row.pending_count ?? 0),
    completedCount: Number(row.completed_count ?? 0)
  };
}

export function rowToReviewQueueItem(row: Record<string, unknown>): ReviewQueueItem {
  const rawStatus = String(row.status);
  const status = rawStatus === "completed" ? "completed" : "pending";
  return {
    id: String(row.id),
    queueId: String(row.queue_id),
    caseId: String(row.case_id),
    criterionVersionId: String(row.criterion_version_id),
    status,
    position: Number(row.position ?? 0),
    assignedToUserId: row.assigned_to_user_id === null || row.assigned_to_user_id === undefined ? null : String(row.assigned_to_user_id),
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null
  };
}

export function rowToRegressionRun(row: Record<string, unknown>): RegressionRunResult {
  return RegressionRunResultSchema.parse({
    id: row.id,
    skillVersionId: row.skill_version_id,
    datasetRevisionId: row.dataset_revision_id,
    status: row.status,
    compared: row.compared,
    regressed: row.regressed,
    improved: row.improved,
    flipped: row.flipped,
    overrideReason: row.override_reason ?? undefined,
    goldenSetMissing: row.golden_set_missing,
    cases: parseJson(row.cases),
    error: row.error_message ?? null,
    createdAt: toIso(row.created_at)
  });
}

export function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toSkillStatus(value: unknown): Skill["status"] {
  const status = String(value);
  return ["draft", "calibrating", "validated", "approved", "production", "regressing", "failed", "needs_review", "deprecated"].includes(status)
    ? status as Skill["status"]
    : "draft";
}

export function gateFailureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export function toFeedbackSyncStatus(value: unknown): FeedbackSyncStatus {
  const status = String(value);
  return ["pending", "sending", "synced", "failed", "blocked"].includes(status)
    ? status as FeedbackSyncStatus
    : "pending";
}
