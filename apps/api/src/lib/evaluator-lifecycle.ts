import {
  EVALUATOR_LIFECYCLE_CONTRACT_VERSION,
  EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,
  EvaluatorCandidateCreateInputSchema,
  EvaluatorLifecycleArtifactSchema,
  EvaluatorLifecycleEventSchema,
  type EvaluatorCandidateCreateInput,
  type EvaluatorLifecycleArtifact,
  type EvaluatorLifecycleEvent,
  type EvaluatorLifecycleState,
  type EvaluatorExecutionContext
} from "@coeval/shared";
import { governedContentV1Digest } from "./governed-content-digest.js";

export const EVALUATOR_CANDIDATE_REQUEST_DIGEST_BASIS = "evaluator-candidate-request/v1" as const;
export const EVALUATOR_LIFECYCLE_CONTENT_DIGEST_BASIS = "evaluator-lifecycle/v1" as const;
export const EVALUATOR_LIFECYCLE_EVENT_DIGEST_BASIS = "evaluator-lifecycle-event/v1" as const;
export const EVALUATOR_EXECUTION_AUTHORIZATION_DIGEST_BASIS =
  "evaluator-execution-authorization/v1" as const;

export function evaluatorLifecycleDigest(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      typeof (value as { basis?: unknown }).basis !== "string") {
    throw new Error("Evaluator lifecycle digest input requires a string basis");
  }
  const { basis, ...content } = value as Record<string, unknown> & { basis: string };
  return governedContentV1Digest(basis, content);
}

export function evaluatorCandidateRequestDigest(
  projectId: string,
  input: EvaluatorCandidateCreateInput
): string {
  const parsed = EvaluatorCandidateCreateInputSchema.parse(input);
  const { idempotencyKey: _idempotencyKey, ...request } = parsed;
  return evaluatorLifecycleDigest({
    basis: EVALUATOR_CANDIDATE_REQUEST_DIGEST_BASIS,
    projectId: nonBlank(projectId, "projectId"),
    ...request
  });
}

export function evaluatorLifecycleContentDigest(
  artifact: Omit<EvaluatorLifecycleArtifact, "contentDigest" | "createdAt">
): string {
  const parsed = EvaluatorLifecycleArtifactSchema.parse({
    ...artifact,
    contentDigest: zeroDigest(),
    createdAt: "1970-01-01T00:00:00.000Z"
  });
  const { contentDigest: _contentDigest, createdAt: _createdAt, ...content } = parsed;
  return evaluatorLifecycleDigest({ basis: EVALUATOR_LIFECYCLE_CONTENT_DIGEST_BASIS, ...content });
}

export function evaluatorLifecycleEventContentDigest(
  event: Omit<EvaluatorLifecycleEvent, "contentDigest" | "occurredAt">
): string {
  const parsed = EvaluatorLifecycleEventSchema.parse({
    ...event,
    contentDigest: zeroDigest(),
    occurredAt: "1970-01-01T00:00:00.000Z"
  });
  const { contentDigest: _contentDigest, occurredAt: _occurredAt, ...content } = parsed;
  return evaluatorLifecycleDigest({ basis: EVALUATOR_LIFECYCLE_EVENT_DIGEST_BASIS, ...content });
}

export function evaluatorLifecycleTransitionAllowed(
  from: EvaluatorLifecycleState,
  to: EvaluatorLifecycleState
): boolean {
  if (from === "candidate") return to === "active" || to === "retired";
  if (from === "active") return to === "needs_review" || to === "retired";
  if (from === "needs_review") return to === "active" || to === "retired";
  return false;
}

export function evaluatorExecutionContextAllowsState(
  context: EvaluatorExecutionContext,
  input: {
    state: EvaluatorLifecycleState;
    currentCalibrationAdmissibility: "admissible" | "revoked" | "unknown" | "not_applicable";
  }
): boolean {
  if (input.state === "retired") return false;
  if (context === "explicit_nonproduction_dataset" ||
      context === "governed_nonsealed_evaluation" ||
      context === "binary_calibration_evidence" ||
      context === "candidate_regression_evidence") {
    return true;
  }
  return input.state === "active" && input.currentCalibrationAdmissibility === "admissible";
}

export function evaluatorExecutionAuthorizationDigest(input: {
  projectId: string;
  skillVersionId: string;
  context: EvaluatorExecutionContext;
  lifecycleEventId: string | null;
  calibrationArtifactId: string | null;
  resourceKind: string;
  resourceId: string;
}): string {
  return evaluatorLifecycleDigest({
    basis: EVALUATOR_EXECUTION_AUTHORIZATION_DIGEST_BASIS,
    projectId: nonBlank(input.projectId, "projectId"),
    skillVersionId: nonBlank(input.skillVersionId, "skillVersionId"),
    context: input.context,
    lifecycleEventId: input.lifecycleEventId,
    calibrationArtifactId: input.calibrationArtifactId,
    resourceKind: nonBlank(input.resourceKind, "resourceKind"),
    resourceId: nonBlank(input.resourceId, "resourceId")
  });
}

export const EVALUATOR_LIFECYCLE_VERSIONS = {
  lifecycle: EVALUATOR_LIFECYCLE_CONTRACT_VERSION,
  event: EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION
} as const;

function nonBlank(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} must be non-empty`);
  return value;
}

function zeroDigest(): string {
  return `sha256:${"0".repeat(64)}`;
}
