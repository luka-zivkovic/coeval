import type {
  AppendGovernedReviewAdjudicationInput,
  AppendGovernedReviewAlignmentEventInput,
  CreateImportedTruthInput,
  CreateGovernedReviewBatchInput,
  CreateGovernedReviewInstructionInput,
  CreateSealedReviewIntakeInput,
  DeferGovernedReviewTaskInput,
  GovernedAdjudicationProjection,
  GovernedAlignmentEventProjection,
  GovernedPostBarrierItemProjection,
  GovernedReviewBatchProjection,
  GovernedReviewInstructionProjection,
  GovernedReviewListQuery,
  GovernedReviewerTaskProjection,
  GovernedReviewStreamCommand,
  GovernedReviewSubjectProjection,
  GovernedSealedIntakeReceipt,
  GovernedTaskMutationProjection,
  ImportedTruthListQuery,
  ImportedTruthProjection,
  ResumeGovernedReviewTaskInput,
  SubmitGovernedReviewLabelInput,
  WithdrawGovernedReviewLabelInput
} from "./contracts.js";

export type GovernedReviewProjectRole = "owner" | "member";

export interface GovernedReviewActor {
  projectId: string;
  userId: string;
  projectRole: GovernedReviewProjectRole;
}

export interface GovernedBlindTaskViewArtifact {
  canonicalBytes: Uint8Array;
  viewDigest: string;
}

export type GovernedTaskAction =
  | { kind: "defer"; input: DeferGovernedReviewTaskInput }
  | { kind: "resume"; input: ResumeGovernedReviewTaskInput }
  | { kind: "submit_label"; input: SubmitGovernedReviewLabelInput }
  | { kind: "withdraw_label"; input: WithdrawGovernedReviewLabelInput };

export type GovernedBatchAction =
  | "open"
  | "close_labeling"
  | "open_alignment"
  | "start_adjudication"
  | "finalize"
  | "freeze";

/**
 * Governed review intentionally has its own persistence abstraction. Legacy
 * verdict and review-queue repositories may not satisfy any method here.
 * Implementations own authorization-sensitive projections and all batch/task
 * transaction locking; the HTTP layer never loads a case and filters it.
 */
export interface GovernedReviewRepository {
  listInstructions(
    actor: GovernedReviewActor,
    criterionVersionId?: string
  ): Promise<GovernedReviewInstructionProjection[]>;
  createInstruction(
    actor: GovernedReviewActor,
    input: CreateGovernedReviewInstructionInput
  ): Promise<GovernedReviewInstructionProjection>;
  listAssignableSubjects(actor: GovernedReviewActor): Promise<GovernedReviewSubjectProjection[]>;
  /**
   * Redacts and inserts the full intake atomically after project-wide overlap
   * and protected-successor checks. The response is a receipt only; it must
   * never contain item payloads, pre-redaction inputs, or internal item ids.
   */
  createSealedIntake(
    actor: GovernedReviewActor,
    input: CreateSealedReviewIntakeInput
  ): Promise<GovernedSealedIntakeReceipt>;
  /**
   * Freezes the source frame, executes the selection server-side, creates
   * immutable items and assignments, and records idempotency in one
   * transaction. A sealed result must be a receipt only, never intake data.
   */
  createBatchDraft(
    actor: GovernedReviewActor,
    input: CreateGovernedReviewBatchInput
  ): Promise<GovernedReviewBatchProjection>;
  listBatches(actor: GovernedReviewActor, query: GovernedReviewListQuery): Promise<GovernedReviewBatchProjection[]>;
  getBatchSummary(actor: GovernedReviewActor, batchId: string): Promise<GovernedReviewBatchProjection>;
  /** Locks the batch stream and commits the derived event/evidence atomically. */
  transitionBatch(
    actor: GovernedReviewActor,
    batchId: string,
    action: GovernedBatchAction,
    command: GovernedReviewStreamCommand
  ): Promise<GovernedReviewBatchProjection>;
  listReviewerTasks(actor: GovernedReviewActor): Promise<GovernedReviewerTaskProjection[]>;
  /**
   * Resolves only an assignment owned by actor (not-owned and absent are the
   * same 404), locks batch before task, and atomically persists the first
   * `viewed` event, exposure record, and exact canonical artifact. Repeats
   * return the persisted bytes verbatim.
   */
  getOrCreateBlindTaskView(
    actor: GovernedReviewActor,
    taskId: string
  ): Promise<GovernedBlindTaskViewArtifact>;
  /** Locks batch before task and commits action, label, and stream event atomically. */
  appendTaskAction(
    actor: GovernedReviewActor,
    taskId: string,
    action: GovernedTaskAction
  ): Promise<GovernedTaskMutationProjection>;
  /** Enforces the irreversible barrier before loading peer evidence. */
  getPostBarrierItemView(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    purpose: "alignment" | "adjudication"
  ): Promise<GovernedPostBarrierItemProjection>;
  appendAlignmentEvent(
    actor: GovernedReviewActor,
    batchId: string,
    input: AppendGovernedReviewAlignmentEventInput
  ): Promise<GovernedAlignmentEventProjection>;
  appendAdjudication(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    input: AppendGovernedReviewAdjudicationInput
  ): Promise<GovernedAdjudicationProjection>;
  createImportedTruth(
    actor: GovernedReviewActor,
    input: CreateImportedTruthInput
  ): Promise<ImportedTruthProjection>;
  listImportedTruth(
    actor: GovernedReviewActor,
    query: ImportedTruthListQuery
  ): Promise<ImportedTruthProjection[]>;
}
