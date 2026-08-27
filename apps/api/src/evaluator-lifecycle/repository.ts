import type {
  EvaluatorCandidateCreateInput,
  EvaluatorCandidateCreateResult,
  EvaluatorLifecycleActivateInput,
  EvaluatorLifecycleListPage,
  EvaluatorLifecycleProjection,
  EvaluatorLifecycleRetireInput,
  EvaluatorLifecycleTransitionResult,
  EvaluatorExecutionContext
} from "@coeval/shared";

export type EvaluatorLifecycleProjectRole = "owner" | "member";

export interface EvaluatorLifecycleAccess {
  projectId: string;
  userId: string;
  projectRole: EvaluatorLifecycleProjectRole;
}

export interface EvaluatorLifecyclePageInput {
  limit: number;
  cursor: string | null;
}

export interface EvaluatorExecutionAuthorizationInput {
  projectId: string;
  skillVersionId: string;
  context: EvaluatorExecutionContext;
  resourceKind: string;
  resourceId: string;
  idempotencyKey: string;
}

export interface EvaluatorLifecycleRepository {
  createCandidate(
    actor: EvaluatorLifecycleAccess,
    input: EvaluatorCandidateCreateInput
  ): Promise<EvaluatorCandidateCreateResult>;
  getLifecycle(
    access: Pick<EvaluatorLifecycleAccess, "projectId">,
    skillVersionId: string
  ): Promise<EvaluatorLifecycleProjection | null>;
  listLifecycles(
    access: Pick<EvaluatorLifecycleAccess, "projectId">,
    input: EvaluatorLifecyclePageInput
  ): Promise<EvaluatorLifecycleListPage>;
  activate(
    actor: EvaluatorLifecycleAccess,
    skillVersionId: string,
    input: EvaluatorLifecycleActivateInput
  ): Promise<EvaluatorLifecycleTransitionResult>;
  retire(
    actor: EvaluatorLifecycleAccess,
    skillVersionId: string,
    input: EvaluatorLifecycleRetireInput
  ): Promise<EvaluatorLifecycleTransitionResult>;
  authorizeExecution(input: EvaluatorExecutionAuthorizationInput): Promise<void>;
}

export const EVALUATOR_LIFECYCLE_ERROR_CODES = [
  "not_found",
  "forbidden",
  "unsupported",
  "invalid_cursor",
  "idempotency_conflict",
  "state_conflict",
  "candidate_provenance_conflict",
  "truth_conflict",
  "regression_conflict",
  "calibration_conflict",
  "prior_active_conflict",
  "execution_forbidden"
] as const;
export type EvaluatorLifecycleErrorCode = (typeof EVALUATOR_LIFECYCLE_ERROR_CODES)[number];

export class EvaluatorLifecycleRepositoryError extends Error {
  constructor(
    readonly code: EvaluatorLifecycleErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "EvaluatorLifecycleRepositoryError";
  }
}
