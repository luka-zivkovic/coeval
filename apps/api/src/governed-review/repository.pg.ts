import type { Pool } from "pg";
import type {
  AppendGovernedReviewAdjudicationInput,
  AppendGovernedReviewAlignmentEventInput,
  CreateGovernedReviewBatchInput,
  CreateGovernedReviewInstructionInput,
  CreateImportedTruthInput,
  CreateSealedReviewIntakeInput,
  GovernedAdjudicationProjection,
  GovernedAlignmentEventProjection,
  GovernedPostBarrierItemProjection,
  GovernedReviewBatchProjection,
  GovernedReviewInstructionProjection,
  GovernedReviewListQuery,
  GovernedReviewerTaskProjection,
  GovernedReviewSubjectProjection,
  GovernedReviewStreamCommand,
  GovernedSealedIntakeReceipt,
  GovernedTaskMutationProjection,
  ImportedTruthListQuery,
  ImportedTruthProjection
} from "./contracts.js";
import type {
  GovernedBatchAction,
  GovernedBlindTaskViewArtifact,
  GovernedReviewActor,
  GovernedReviewRepository,
  GovernedTaskAction
} from "./repository.js";
import { PgGovernedReviewAdministrationRepository } from "./repository.pg-administration.js";
import { PgGovernedReviewEvidenceRepository } from "./repository.pg-evidence.js";

export class PgGovernedReviewRepository implements GovernedReviewRepository {
  private readonly administration: PgGovernedReviewAdministrationRepository;
  private readonly evidence: PgGovernedReviewEvidenceRepository;

  constructor(private readonly pool: Pool) {
    this.administration = new PgGovernedReviewAdministrationRepository(this.pool);
    this.evidence = new PgGovernedReviewEvidenceRepository(this.pool);
  }

  async listInstructions(
    actor: GovernedReviewActor,
    criterionVersionId?: string
  ): Promise<GovernedReviewInstructionProjection[]> {
    return this.administration.listInstructions(actor, criterionVersionId);
  }

  async createInstruction(
    actor: GovernedReviewActor,
    input: CreateGovernedReviewInstructionInput
  ): Promise<GovernedReviewInstructionProjection> {
    return this.administration.createInstruction(actor, input);
  }

  async listAssignableSubjects(actor: GovernedReviewActor): Promise<GovernedReviewSubjectProjection[]> {
    return this.administration.listAssignableSubjects(actor);
  }

  async createSealedIntake(
    actor: GovernedReviewActor,
    input: CreateSealedReviewIntakeInput
  ): Promise<GovernedSealedIntakeReceipt> {
    return this.administration.createSealedIntake(actor, input);
  }

  async createBatchDraft(
    actor: GovernedReviewActor,
    input: CreateGovernedReviewBatchInput
  ): Promise<GovernedReviewBatchProjection> {
    return this.administration.createBatchDraft(actor, input);
  }

  async listBatches(
    actor: GovernedReviewActor,
    query: GovernedReviewListQuery
  ): Promise<GovernedReviewBatchProjection[]> {
    return this.administration.listBatches(actor, query);
  }

  async getBatchSummary(actor: GovernedReviewActor, batchId: string): Promise<GovernedReviewBatchProjection> {
    return this.administration.getBatchSummary(actor, batchId);
  }

  async transitionBatch(
    actor: GovernedReviewActor,
    batchId: string,
    action: GovernedBatchAction,
    command: GovernedReviewStreamCommand
  ): Promise<GovernedReviewBatchProjection> {
    return this.administration.transitionBatch(actor, batchId, action, command);
  }

  async listReviewerTasks(actor: GovernedReviewActor): Promise<GovernedReviewerTaskProjection[]> {
    return this.evidence.listReviewerTasks(actor);
  }

  async getOrCreateBlindTaskView(
    actor: GovernedReviewActor,
    taskId: string
  ): Promise<GovernedBlindTaskViewArtifact> {
    return this.evidence.getOrCreateBlindTaskView(actor, taskId);
  }

  async appendTaskAction(
    actor: GovernedReviewActor,
    taskId: string,
    action: GovernedTaskAction
  ): Promise<GovernedTaskMutationProjection> {
    return this.evidence.appendTaskAction(actor, taskId, action);
  }

  async getPostBarrierItemView(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    _purpose: "alignment" | "adjudication"
  ): Promise<GovernedPostBarrierItemProjection> {
    return this.evidence.getPostBarrierItemView(actor, batchId, itemId, _purpose);
  }

  async appendAlignmentEvent(
    actor: GovernedReviewActor,
    batchId: string,
    input: AppendGovernedReviewAlignmentEventInput
  ): Promise<GovernedAlignmentEventProjection> {
    return this.evidence.appendAlignmentEvent(actor, batchId, input);
  }

  async appendAdjudication(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    input: AppendGovernedReviewAdjudicationInput
  ): Promise<GovernedAdjudicationProjection> {
    return this.evidence.appendAdjudication(actor, batchId, itemId, input);
  }

  async createImportedTruth(
    actor: GovernedReviewActor,
    input: CreateImportedTruthInput
  ): Promise<ImportedTruthProjection> {
    return this.evidence.createImportedTruth(actor, input);
  }

  async listImportedTruth(
    actor: GovernedReviewActor,
    query: ImportedTruthListQuery
  ): Promise<ImportedTruthProjection[]> {
    return this.evidence.listImportedTruth(actor, query);
  }
}
