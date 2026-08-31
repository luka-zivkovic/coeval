import type { GoldenSetRetirementContext } from "@coeval/shared";

// Stable typed failures shared by repository implementations and route
// adapters. Keeping one constructor identity preserves instanceof checks.
export class OnboardingCheckConflictError extends Error {
  constructor(
    readonly code: "project_already_configured" | "criterion_not_native" | "idempotency_conflict",
    message: string
  ) {
    super(message);
    this.name = "OnboardingCheckConflictError";
  }
}

export class InvalidConvergenceCursorError extends Error {
  constructor() {
    super("Invalid convergence case cursor");
    this.name = "InvalidConvergenceCursorError";
  }
}

export class AssessmentReceiptUnavailableError extends Error {
  constructor(readonly reason: "not_release_evidence" | "not_terminal" | "missing_source", message: string) {
    super(message);
    this.name = "AssessmentReceiptUnavailableError";
  }
}

export class AssessmentReceiptIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssessmentReceiptIntegrityError";
  }
}

export class DatasetRevisionNotFoundError extends Error {
  constructor(readonly revisionId: string) {
    super(`Dataset revision not found in this project: ${revisionId}`);
    this.name = "DatasetRevisionNotFoundError";
  }
}

export class SealedValidationUnavailableError extends Error {
  constructor() {
    super("Sealed validation intake is unavailable until governed blind collection and review are enabled.");
    this.name = "SealedValidationUnavailableError";
  }
}

export class DatasetRevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetRevisionConflictError";
  }
}

export class GateRunBindingMismatchError extends Error {
  constructor(readonly jobDatasetRevisionId: string, readonly versionDatasetRevisionId: string) {
    super(`Gate job dataset revision does not match skill version binding: ${jobDatasetRevisionId}`);
    this.name = "GateRunBindingMismatchError";
  }
}

export class RecursiveTraceSkippedError extends Error {
  constructor(sourceTraceId?: string) {
    super(sourceTraceId
      ? `Trace marked coeval-internal was skipped on ingest: ${sourceTraceId}`
      : "Trace marked coeval-internal was skipped on ingest");
    this.name = "RecursiveTraceSkippedError";
  }
}

export class GoldenSetEntryAlreadyRetiredError extends Error {
  constructor(entryId: string, readonly retirement: GoldenSetRetirementContext | null = null) {
    super(`Golden-set entry already retired: ${entryId}`);
    this.name = "GoldenSetEntryAlreadyRetiredError";
  }
}

export class GoldenSetEntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Golden-set entry not found: ${entryId}`);
    this.name = "GoldenSetEntryNotFoundError";
  }
}

export class CaseNotFoundError extends Error {
  constructor(caseId: string) {
    super(`Case not found in this project: ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

// The skill version pins a real provider but the factory could only produce
// the mock fallback (missing API key / unknown provider). The gate must
// refuse to run rather than certify a version with meaningless verdicts.
export class SkillVersionNotSignableError extends Error {
  constructor(versionId: string, status: string) {
    super(`Skill version ${versionId} is ${status} — only a never-approved draft can be signed off as-is`);
    this.name = "SkillVersionNotSignableError";
  }
}

export class AgentSetupEligibilityError extends Error {
  constructor(
    readonly code: "project_not_empty" | "project_already_configured" | "pairing_no_longer_active",
    message: string
  ) {
    super(message);
    this.name = "AgentSetupEligibilityError";
  }
}

export class RegressionGateUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(
      `Regression gate cannot run: skill version pins provider "${provider}" but no usable credentials are configured (the judge would fall back to the mock). Set the provider API key or pin provider "mock" explicitly.`
    );
    this.name = "RegressionGateUnavailableError";
  }
}

// A provider call failed while re-judging the golden set. Surfaced as a typed
// error so the route can answer 502 with context instead of a bare 500.
export class RegressionGateJudgeError extends Error {
  constructor(caseId: string, cause: unknown) {
    super(
      `Regression gate failed while judging golden case ${caseId}: ${cause instanceof Error ? cause.message : String(cause)}. No version was created; retry once the provider recovers.`
    );
    this.name = "RegressionGateJudgeError";
  }
}

// Promotion would freeze a label that contradicts the team's recorded human
// decision on the case. 409 — the caller must read the recorded label first.
export class GoldenSetLabelConflictError extends Error {
  constructor(caseId: string, requested: string, recorded: string) {
    super(
      `Cannot promote ${caseId} as "${requested}": the recorded human decision on this case is "${recorded}". Record a new human verdict first, or promote with the recorded label.`
    );
    this.name = "GoldenSetLabelConflictError";
  }
}

export class LangSmithIntegrationNotFoundError extends Error {
  constructor(integrationId: string) {
    super(`LangSmith integration not found: ${integrationId}`);
    this.name = "LangSmithIntegrationNotFoundError";
  }
}

export class LangfuseIntegrationNotFoundError extends Error {
  constructor(integrationId: string) {
    super(`Langfuse integration not found: ${integrationId}`);
    this.name = "LangfuseIntegrationNotFoundError";
  }
}

export class NoCurrentSkillError extends Error {
  constructor(projectId: string) {
    super(`No skill version found for project: ${projectId}`);
    this.name = "NoCurrentSkillError";
  }
}

export class ImportSkillVersionBindingError extends Error {
  constructor(message = "Import jobs must be pinned to an evaluator version in the same project") {
    super(message);
    this.name = "ImportSkillVersionBindingError";
  }
}

export class AmbiguousProjectSkillError extends Error {
  constructor(readonly projectId: string, readonly criterionCount: number) {
    super(
      `Project ${projectId} has ${criterionCount} evaluator scopes; choose a criterion or skillVersionId explicitly.`
    );
    this.name = "AmbiguousProjectSkillError";
  }
}

export class CriterionStableKeyConflictError extends Error {
  constructor(readonly stableKey: string) {
    super(`Criterion stableKey already exists in this project: ${stableKey}`);
    this.name = "CriterionStableKeyConflictError";
  }
}

export class EvaluatorSuiteBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorSuiteBindingError";
  }
}

export class EvaluatorSuiteIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Evaluator suite idempotency key was already used for different semantics: ${idempotencyKey}`);
    this.name = "EvaluatorSuiteIdempotencyConflictError";
  }
}

export class LangSmithCredentialsMissingError extends Error {
  constructor(integrationId: string) {
    super(`LangSmith integration credentials missing API key: ${integrationId}`);
    this.name = "LangSmithCredentialsMissingError";
  }
}

export class LangfuseCredentialsMissingError extends Error {
  constructor(integrationId: string) {
    super(`Langfuse integration credentials missing public/secret key: ${integrationId}`);
    this.name = "LangfuseCredentialsMissingError";
  }
}

export class IronsideIntegrationNotFoundError extends Error {
  constructor(integrationId: string) {
    super(`Ironside integration not found: ${integrationId}`);
    this.name = "IronsideIntegrationNotFoundError";
  }
}

export class IronsideIntegrationChangedError extends Error {
  constructor(integrationId: string) {
    super(`Ironside integration changed during validation: ${integrationId}`);
    this.name = "IronsideIntegrationChangedError";
  }
}

export class IronsideIntegrationAlreadyExistsError extends Error {
  constructor(projectId: string) {
    super(`An Ironside integration already exists for project: ${projectId}`);
    this.name = "IronsideIntegrationAlreadyExistsError";
  }
}

export class IronsideIntegrationRevalidationRequiredError extends Error {
  constructor(integrationId: string) {
    super(`Ironside integration must be revalidated before importing: ${integrationId}`);
    this.name = "IronsideIntegrationRevalidationRequiredError";
  }
}

export class IronsideCredentialsMissingError extends Error {
  constructor(integrationId: string) {
    super(`Ironside integration credentials missing API key: ${integrationId}`);
    this.name = "IronsideCredentialsMissingError";
  }
}

export class FeedbackSyncJobNotFoundError extends Error {
  constructor(feedbackSyncJobId: string) {
    super(`Feedback sync job not found: ${feedbackSyncJobId}`);
    this.name = "FeedbackSyncJobNotFoundError";
  }
}

export class FeedbackSyncCredentialsMissingError extends Error {
  constructor(feedbackSyncJobId: string) {
    super(`Feedback sync credentials missing API key: ${feedbackSyncJobId}`);
    this.name = "FeedbackSyncCredentialsMissingError";
  }
}

export class DatasetNotFoundError extends Error {
  constructor(datasetId: string) {
    super(`Dataset not found in this project: ${datasetId}`);
    this.name = "DatasetNotFoundError";
  }
}

export class DatasetNameTakenError extends Error {
  constructor(name: string) {
    super(`An active dataset named "${name}" already exists in this project`);
    this.name = "DatasetNameTakenError";
  }
}

export class TraceTestSourceNotFoundError extends Error {
  constructor(sourceCaseId: string) {
    super(`Source conversation not found in this project: ${sourceCaseId}`);
    this.name = "TraceTestSourceNotFoundError";
  }
}

export class TraceTestNotFoundError extends Error {
  constructor(traceTestId: string) {
    super(`Test not found in this project: ${traceTestId}`);
    this.name = "TraceTestNotFoundError";
  }
}

export class TraceTestRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly currentRevision: number) {
    super(`Test changed from revision ${expectedRevision} to ${currentRevision}`);
    this.name = "TraceTestRevisionConflictError";
  }
}

export class TraceTestValidationNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceTestValidationNotReadyError";
  }
}
