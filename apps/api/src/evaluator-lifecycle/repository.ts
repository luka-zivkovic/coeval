import type {
  EvaluatorCandidateCreateInput,
  EvaluatorCandidateCreateResult,
  EvaluatorLifecycleActivateInput,
  EvaluatorLifecycleListPage,
  EvaluatorLifecycleProjection,
  EvaluatorLifecycleRetireInput,
  EvaluatorLifecycleTransitionResult,
  EvaluatorExecutionContext,
  ResolutionRecord
} from "@rubrist/shared";
import type { GovernedBinding } from "../lib/binding-resolution.js";
import type { ResolutionAttemptInput } from "./resolution.pg.js";

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
  /**
   * Creates a candidate. The governed gate (ADR-0014 section 2) needs the
   * binding's resolution, resolved before the call because probes are network
   * calls; a replay needs none.
   */
  createCandidate(
    actor: EvaluatorLifecycleAccess,
    input: EvaluatorCandidateCreateInput,
    resolution?: ResolutionRecord | null
  ): Promise<EvaluatorCandidateCreateResult>;
  /** Whether this idempotency key already created a candidate, so its replay skips resolution. */
  candidateExists(actor: EvaluatorLifecycleAccess, idempotencyKey: string): Promise<boolean>;
  /** A version's binding and latest resolution record; `null` when the version isn't in the project. */
  getGovernedBinding(
    access: Pick<EvaluatorLifecycleAccess, "projectId">,
    skillVersionId: string
  ): Promise<{ binding: GovernedBinding; record: ResolutionRecord | null } | null>;
  /** Appends a resolution attempt and, for an existing version, stores it as the latest record. */
  recordResolution(attempt: ResolutionAttemptInput, record: ResolutionRecord | null): Promise<void>;
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
  "execution_forbidden",
  "mutable_model_alias",
  "invalid_execution_binding",
  "execution_binding_unresolved"
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
