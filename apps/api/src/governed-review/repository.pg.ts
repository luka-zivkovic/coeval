import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "../lib/assessment-receipt.js";
import { governedContentV1Digest } from "../lib/governed-content-digest.js";
import {
  datasetInputIdentity,
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest
} from "../lib/dataset-revision.js";
import { governedReviewRequestDigest } from "../lib/governed-review.js";
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
import {
  GovernedImportedTruthVerificationUnavailableError,
  GovernedReviewConflictError,
  GovernedReviewForbiddenError,
  GovernedReviewIdempotencyConflictError,
  GovernedReviewLabelAlreadyRevealedError,
  GovernedReviewNotFoundError,
  GovernedReviewSealedOverlapError,
  GovernedReviewSeparationIneligibleError,
  GovernedReviewSeparationUnknownError,
  GovernedReviewStreamConflictError,
  GovernedReviewTransitionConflictError
} from "./errors.js";
import { assertBlindProjectionSafe, projectGovernedReviewPayload } from "./projection.js";
import type {
  GovernedBatchAction,
  GovernedBlindTaskViewArtifact,
  GovernedReviewActor,
  GovernedReviewRepository,
  GovernedTaskAction
} from "./repository.js";
import { executeGovernedReviewSelection, type GovernedSelectionFrameItem } from "./selection.js";

type Db = Pool | PoolClient;

const ALLOWED_LABELS = ["pass", "fail", "cannot_determine"] as const;
const MAX_BLIND_VIEW_BYTES = 2 * 1024 * 1024;
// Public idempotency keys are bounded to 200 bytes by contracts.ts. Keeping
// internal stream keys outside that length domain makes collisions impossible
// even when a caller deliberately chooses the old `view:<taskId>` shape.
const INTERNAL_VIEW_IDEMPOTENCY_KEY = `coeval-internal/view/v1/${"0".repeat(200)}`;
const COVERED_CAPABILITIES = [
  "criterion_authoring", "instruction_authoring", "evaluator_authoring",
  "rubric_authoring", "prompt_authoring", "example_selection", "development_exposure"
] as const;

interface BatchRow {
  id: string;
  project_id: string;
  criterion_version_id: string;
  instruction_version_id: string;
  role_intent: "analysis_authoring" | "iterative_development" | "sealed_validation";
  source_population_kind: "dataset_revision" | "sealed_intake" | "analysis_promotion_handoff";
  source_population_id: string;
  population_id: string;
  population_definition: unknown;
  population_collection_provenance: unknown;
  population_size: number;
  population_digest: string;
  selection_method: CreateGovernedReviewBatchInput["selection"]["method"];
  selection_seed: string | null;
  rng_version: string | null;
  selection_algorithm_version: string;
  fixed_budget: number;
  stop_at: Date | string;
  draw_digest: string;
  required_labels_per_item: number;
  custodian_subject_id: string | null;
  custodian_role_at_review: string | null;
  created_at: Date | string;
}

export class PgGovernedReviewRepository implements GovernedReviewRepository {
  constructor(private readonly pool: Pool) {}

  async listInstructions(
    actor: GovernedReviewActor,
    criterionVersionId?: string
  ): Promise<GovernedReviewInstructionProjection[]> {
    const result = await this.pool.query(
      `select * from review_instruction_versions
       where project_id=$1 and ($2::text is null or criterion_version_id=$2)
       order by criterion_version_id, revision, id`,
      [actor.projectId, criterionVersionId ?? null]
    );
    return result.rows.map(rowToInstruction);
  }

  async createInstruction(
    actor: GovernedReviewActor,
    input: CreateGovernedReviewInstructionInput
  ): Promise<GovernedReviewInstructionProjection> {
    requireOwnerActor(actor, "create governed review instructions");
    return this.transaction(async (client) => {
      const subject = await ensureSubject(client, actor.projectId, actor.userId);
      const id = stableId("griv", actor.projectId, input.idempotencyKey);
      const existing = await client.query(
        `select * from review_instruction_versions where id=$1 and project_id=$2`,
        [id, actor.projectId]
      );
      const predecessor = input.predecessorInstructionVersionId
        ? (await client.query(
            `select * from review_instruction_versions
             where id=$1 and project_id=$2 and criterion_version_id=$3 for update`,
            [input.predecessorInstructionVersionId, actor.projectId, input.criterionVersionId]
          )).rows[0]
        : null;
      if (input.predecessorInstructionVersionId && !predecessor) throw new GovernedReviewNotFoundError();
      const revision = predecessor ? Number(predecessor.revision) + 1 : 1;
      const digestContent = {
        allowedLabels: [...ALLOWED_LABELS],
        criterionVersionId: input.criterionVersionId,
        failureCodeGuidance: input.failureCodeGuidance,
        id,
        instructions: input.instructions,
        predecessorInstructionVersionId: input.predecessorInstructionVersionId ?? null,
        revision,
        title: input.title
      };
      const contentDigest = await dbDigest(client, "review-instruction/v1", digestContent);
      if (existing.rows[0]) {
        if (String(existing.rows[0].content_digest) !== contentDigest) {
          throw new GovernedReviewIdempotencyConflictError();
        }
        return rowToInstruction(existing.rows[0]);
      }
      try {
        const inserted = await client.query(
          `insert into review_instruction_versions
             (id,project_id,criterion_version_id,revision,predecessor_instruction_version_id,
              title,instructions,allowed_labels,failure_code_guidance,content_digest,created_by_subject_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
          [id, actor.projectId, input.criterionVersionId, revision,
            input.predecessorInstructionVersionId ?? null, input.title, input.instructions,
            [...ALLOWED_LABELS], input.failureCodeGuidance, contentDigest, subject.id]
        );
        return rowToInstruction(inserted.rows[0]);
      } catch (error) {
        throw mapPgError(error);
      }
    });
  }

  async listAssignableSubjects(actor: GovernedReviewActor): Promise<GovernedReviewSubjectProjection[]> {
    requireOwnerActor(actor, "list governed review subjects");
    const result = await this.pool.query(
      `select pm.user_id, pm.role, account.name, account.email
       from project_members pm
       join "user" account on account.id=pm.user_id
       where pm.project_id=$1 and pm.role in ('owner','member')
       order by lower(coalesce(account.name,account.email,pm.user_id)), pm.user_id`,
      [actor.projectId]
    );
    const projections: GovernedReviewSubjectProjection[] = [];
    await this.transaction(async (client) => {
      for (const row of result.rows) {
        const subject = await ensureSubject(client, actor.projectId, String(row.user_id));
        projections.push({
          subjectId: subject.id,
          userId: String(row.user_id),
          name: row.name == null ? null : String(row.name),
          email: row.email == null ? null : String(row.email),
          projectRole: row.role === "owner" ? "owner" : "member"
        });
      }
    });
    return projections;
  }

  async createSealedIntake(
    actor: GovernedReviewActor,
    input: CreateSealedReviewIntakeInput
  ): Promise<GovernedSealedIntakeReceipt> {
    try {
      return await this.transaction(async (client) => {
        const requestDigest = governedReviewRequestDigest(input);
        const existing = await client.query(
          `select * from governed_sealed_intake_populations
           where project_id=$1 and idempotency_key=$2 for update`,
          [actor.projectId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          assertReplay(existing.rows[0].request_digest, requestDigest);
          return rowToIntake(existing.rows[0]);
        }
        const custodian = await ensureSubject(client, actor.projectId, actor.userId);
        const intakeId = stableId("grsip", actor.projectId, input.idempotencyKey);
        const populationDefinition = { definition: input.populationDefinition };
        const collectionProvenance = {
          contract: "coeval/sealed-intake-collection/v1",
          collectedBySubjectId: custodian.id,
          payloadContract: "input-output-steps-only",
          drawExecutor: "coeval_server"
        };
        const predecessorItems = new Map<string, string>();
        if (input.predecessorRevisionId) {
          const predecessor = await client.query(
            `select item.id,item.input_digest
             from dataset_revision_items item
             join dataset_revisions revision on revision.id=item.revision_id
             where revision.id=$1 and revision.project_id=$2 and revision.role='sealed_validation'
             order by item.position for key share of item`,
            [input.predecessorRevisionId, actor.projectId]
          );
          if (!predecessor.rowCount) throw new GovernedReviewNotFoundError();
          for (const row of predecessor.rows) predecessorItems.set(String(row.input_digest), String(row.id));
        }
        const prepared = input.items.map((item, position) => {
          const payload = projectGovernedReviewPayload(item) as Record<string, unknown>;
          const inputDigest = datasetInputIdentity({ input: item.input }).digest;
          const predecessorItemId = input.predecessorRevisionId
            ? predecessorItems.get(inputDigest) ?? null
            : null;
          if (input.predecessorRevisionId && !predecessorItemId) {
            throw new GovernedReviewConflictError(
              "sealed_overlap",
              "Every sealed successor input must bind an exact predecessor item"
            );
          }
          return {
            id: sealedItemId(intakeId, item.clientItemId),
            clientItemId: item.clientItemId,
            position,
            payload,
            inputDigest,
            predecessorItemId
          };
        });
        const uniqueDigests = new Set(prepared.map((item) => item.inputDigest));
        if (uniqueDigests.size !== prepared.length) throw new GovernedReviewSealedOverlapError();
        const frameMembers = prepared.map((item) => ({
          framePosition: item.position,
          inputDigest: item.inputDigest,
          reviewItemId: item.id
        }));
        const frameDigest = await dbDigest(client, "governed-sealed-intake-frame/v1", frameMembers);
        const windowStart = await normalizedTimestamp(client, input.timeWindow?.startInclusive ?? null);
        const windowEnd = await normalizedTimestamp(client, input.timeWindow?.endExclusive ?? null);
        const content = {
          collectionProvenance,
          custodianRoleAtReview: "custodian",
          custodianSubjectId: custodian.id,
          frameCount: prepared.length,
          frameDigest,
          populationDefinition,
          predecessorRevisionId: input.predecessorRevisionId ?? null,
          windowEnd,
          windowStart
        };
        const contentDigest = await dbDigest(client, "governed-sealed-intake-population/v1", content);
        await client.query(
          `insert into governed_sealed_intake_populations
             (id,project_id,custodian_subject_id,custodian_role_at_review,population_definition,
              window_start,window_end,collection_provenance,frame_count,frame_digest,
              predecessor_revision_id,content_digest,idempotency_key,request_digest)
           values ($1,$2,$3,'custodian',$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
          [intakeId, actor.projectId, custodian.id, JSON.stringify(populationDefinition),
            input.timeWindow?.startInclusive ?? null, input.timeWindow?.endExclusive ?? null,
            JSON.stringify(collectionProvenance), prepared.length, frameDigest,
            input.predecessorRevisionId ?? null, contentDigest, input.idempotencyKey, requestDigest]
        );
        const redactionProvenance = {
          contract: "coeval/governed-review-projection/v1",
          source: "sealed_session_intake",
          copiedFields: ["input", "output", "steps"],
          metadataAccepted: false
        };
        for (const item of prepared) {
          const itemContent = {
            identityBasis: "input-identity/v1",
            inputDigest: item.inputDigest,
            redactionProvenance,
            reviewPayloadProjectionVersion: "governed-review-payload/v1",
            reviewPayloadSnapshot: item.payload,
            sealedFramePosition: item.position,
            sealedIntakePopulationId: intakeId,
            sealedPredecessorRevisionId: input.predecessorRevisionId ?? null,
            sealedPredecessorRevisionItemId: item.predecessorItemId,
            sourceKind: "sealed_intake",
            sourceItemDigest: null,
            sourceRevisionId: null,
            sourceRevisionItemId: null
          };
          const itemDigest = await dbDigest(client, "governed-review-item/v1", itemContent);
          await client.query(
            `insert into governed_review_items
               (id,project_id,source_kind,sealed_intake_population_id,sealed_frame_position,
                sealed_predecessor_revision_id,sealed_predecessor_revision_item_id,identity_basis,
                input_digest,review_payload_projection_version,review_payload_snapshot,
                redaction_provenance,content_digest,idempotency_key,request_digest,created_by_subject_id)
             values ($1,$2,'sealed_intake',$3,$4,$5,$6,'input-identity/v1',$7,
                     'governed-review-payload/v1',$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
            [item.id, actor.projectId, intakeId, item.position,
              input.predecessorRevisionId ?? null, item.predecessorItemId, item.inputDigest,
              JSON.stringify(item.payload), JSON.stringify(redactionProvenance), itemDigest,
              `${input.idempotencyKey}:item:${item.position}`,
              governedReviewRequestDigest({ intakeId, clientItemId: item.clientItemId, payload: item.payload }),
              custodian.id]
          );
        }
        const row = (await client.query(
          `select * from governed_sealed_intake_populations where id=$1`, [intakeId]
        )).rows[0];
        return rowToIntake(row);
      }, "read committed");
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async createBatchDraft(
    actor: GovernedReviewActor,
    input: CreateGovernedReviewBatchInput
  ): Promise<GovernedReviewBatchProjection> {
    requireOwnerActor(actor, "create governed review batches");
    try {
      return await this.transaction(async (client) => {
        const requestDigest = governedReviewRequestDigest(input);
        const existing = await client.query(
          `select id,request_digest from governed_review_batches
           where project_id=$1 and idempotency_key=$2 for update`,
          [actor.projectId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          assertReplay(existing.rows[0].request_digest, requestDigest);
          return loadBatchProjection(client, actor.projectId, String(existing.rows[0].id));
        }
        if (Date.parse(input.fixedStopAt) <= Date.now()) {
          throw new GovernedReviewConflictError(
            "governed_review_transition_conflict",
            "The governed review fixed stop must be in the future"
          );
        }
        const creator = await ensureSubject(client, actor.projectId, actor.userId);
        const instruction = (await client.query(
          `select * from review_instruction_versions
           where id=$1 and project_id=$2 for key share`,
          [input.instructionVersionId, actor.projectId]
        )).rows[0];
        if (!instruction) throw new GovernedReviewNotFoundError();
        const reviewerSubjects: Array<{ id: string; role: string; userId: string }> = [];
        for (const userId of input.reviewerUserIds) {
          const roleResult = await client.query(
            `select role from project_members where project_id=$1 and user_id=$2`,
            [actor.projectId, userId]
          );
          if (!roleResult.rows[0]) throw new GovernedReviewForbiddenError("Every reviewer must be a current project member");
          const subject = await ensureSubject(client, actor.projectId, userId);
          reviewerSubjects.push({
            id: subject.id,
            role: String(roleResult.rows[0].role),
            userId
          });
        }
        const batchId = stableId("grb", actor.projectId, input.idempotencyKey);
        const frame = input.source.kind === "dataset_revision"
          ? await prepareRevisionFrame(client, actor, creator.id, input.source.revisionId, input.roleIntent)
          : input.source.kind === "analysis_promotion_handoff"
            ? await preparePromotionFrame(
                client,
                actor,
                creator.id,
                input.source.promotionId,
                String(instruction.criterion_version_id)
              )
            : await prepareSealedFrame(client, actor.projectId, input.source.intakeId);
        if (frame.items.length === 0) {
          throw new GovernedReviewConflictError(
            "governed_review_transition_conflict",
            "The immutable review population is empty"
          );
        }
        const translatedSelection = translateSelection(
          input.selection,
          frame.sourceToReviewItemId,
          input.source.kind === "sealed_intake" ? input.source.intakeId : undefined
        );
        const selection = executeGovernedReviewSelection({
          frame: frame.items.map((item) => ({ id: item.id, digest: item.digest })),
          selection: translatedSelection
        });
        const selectedById = new Map(frame.items.map((item) => [item.id, item]));
        const stratumByItem = new Map<string, string>();
        for (const stratum of selection.strata) {
          for (const itemId of stratum.selectedItemIds) stratumByItem.set(itemId, stratum.key);
        }
        const simpleProbability = input.selection.method === "simple_random"
          ? selection.selected.length / frame.items.length
          : null;
        const stratumProbability = new Map(
          selection.strata.map((stratum) => [stratum.key, stratum.fixedBudget / stratum.populationSize])
        );
        const drawMembers = selection.selected.map((selected, drawPosition) => {
          const stratumKey = stratumByItem.get(selected.id) ?? null;
          const inclusionProbability = simpleProbability ?? (stratumKey ? stratumProbability.get(stratumKey)! : null);
          return {
            drawPosition,
            frameMemberDigest: selected.digest,
            inclusionProbability,
            reviewItemId: selected.id,
            samplingWeight: inclusionProbability === null ? null : 1 / inclusionProbability,
            stratumKey
          };
        });
        const drawDigest = await dbDigest(client, "governed-review-draw/v1", drawMembers);
        const stopAt = await normalizedTimestamp(client, input.fixedStopAt);
        const strata = selection.strata.map((stratum) => {
          const probability = stratum.fixedBudget / stratum.populationSize;
          return {
            key: stratum.key,
            definition: stratum.definition,
            populationSize: stratum.populationSize,
            membershipDigest: stratum.membershipDigest,
            inclusionProbability: probability,
            weight: 1 / probability,
            fixedBudget: stratum.fixedBudget,
            drawItemDigests: stratum.selectedItemIds.map((id) => selectedById.get(id)!.digest),
            drawDigest: stratum.drawDigest
          };
        });
        const batchContent = {
          criterionVersionId: String(instruction.criterion_version_id),
          custodianRoleAtReview: frame.custodianRole,
          custodianSubjectId: frame.custodianSubjectId,
          drawDigest,
          drawExecutedBy: "coeval_server",
          evaluatorBlind: true,
          fixedBudget: selection.selected.length,
          instructionVersionId: input.instructionVersionId,
          peerBlindUntilLabelingClosed: true,
          populationCollectionProvenance: frame.collectionProvenance,
          populationDefinition: frame.populationDefinition,
          populationDigest: frame.populationDigest,
          populationId: frame.populationId,
          populationSize: frame.items.length,
          requiredLabelsPerItem: reviewerSubjects.length,
          rngVersion: selection.rngVersion,
          roleIntent: input.roleIntent,
          selectionAlgorithmVersion: selection.algorithmVersion,
          selectionMethod: selection.method,
          selectionSeed: selection.seed,
          separationOfDutiesRequired: input.roleIntent === "sealed_validation",
          sourcePopulationId: frame.sourcePopulationId,
          sourcePopulationKind: frame.sourcePopulationKind,
          stateMachineVersion: "governed-review-state/v1",
          stopAt,
          stoppingRule: "fixed",
          strata,
          windowEnd: frame.windowEnd,
          windowStart: frame.windowStart
        };
        const batchDigest = await dbDigest(client, "governed-review-batch/v1", batchContent);
        await client.query(
          `insert into governed_review_batches
             (id,project_id,criterion_version_id,instruction_version_id,role_intent,
              source_population_kind,source_population_id,population_id,population_definition,
              population_collection_provenance,population_size,population_digest,window_start,window_end,
              selection_method,selection_seed,rng_version,selection_algorithm_version,draw_executed_by,
              fixed_budget,stopping_rule,stop_at,draw_digest,strata,required_labels_per_item,
              evaluator_blind,peer_blind_until_labeling_closed,separation_of_duties_required,
              custodian_subject_id,custodian_role_at_review,state_machine_version,content_digest,
              idempotency_key,request_digest,created_by_subject_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,
                   'coeval_server',$19,'fixed',$20,$21,$22::jsonb,$23,true,true,$24,$25,$26,
                   'governed-review-state/v1',$27,$28,$29,$30)`,
          [batchId, actor.projectId, instruction.criterion_version_id, input.instructionVersionId,
            input.roleIntent, frame.sourcePopulationKind, frame.sourcePopulationId, frame.populationId,
            JSON.stringify(frame.populationDefinition), JSON.stringify(frame.collectionProvenance),
            frame.items.length, frame.populationDigest,
            frame.windowStart, frame.windowEnd, selection.method, selection.seed, selection.rngVersion,
            selection.algorithmVersion, selection.selected.length, input.fixedStopAt, drawDigest,
            JSON.stringify(strata), reviewerSubjects.length, input.roleIntent === "sealed_validation",
            frame.custodianSubjectId, frame.custodianRole, batchDigest,
            input.idempotencyKey, requestDigest, creator.id]
        );
        for (const member of drawMembers) {
          const batchItemId = stableId("grbi", batchId, member.reviewItemId);
          const contentDigest = await dbDigest(client, "governed-review-batch-item/v1", {
            batchId,
            ...member
          });
          await client.query(
            `insert into governed_review_batch_items
               (id,project_id,batch_id,review_item_id,draw_position,frame_member_digest,
                stratum_key,inclusion_probability,sampling_weight,content_digest)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [batchItemId, actor.projectId, batchId, member.reviewItemId, member.drawPosition,
              member.frameMemberDigest, member.stratumKey, member.inclusionProbability,
              member.samplingWeight, contentDigest]
          );
          for (const reviewer of reviewerSubjects) {
            const taskId = stableId("grt", batchId, batchItemId, reviewer.id);
            const taskContent = {
              batchId,
              batchItemId,
              reviewerRoleAtReview: reviewer.role,
              reviewerSubjectId: reviewer.id,
              serveOrder: member.drawPosition
            };
            const taskDigest = await dbDigest(client, "governed-review-task/v1", taskContent);
            await client.query(
              `insert into governed_review_tasks
                 (id,project_id,batch_id,batch_item_id,reviewer_subject_id,reviewer_role_at_review,
                  serve_order,content_digest,idempotency_key,request_digest)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [taskId, actor.projectId, batchId, batchItemId, reviewer.id, reviewer.role,
                member.drawPosition, taskDigest, `assignment:${batchId}:${batchItemId}:${reviewer.id}`,
                governedReviewRequestDigest(taskContent)]
            );
          }
        }
        await assertBatchBlindViewsWithinLimit(client, actor.projectId, batchId);
        return loadBatchProjection(client, actor.projectId, batchId);
      }, input.roleIntent === "sealed_validation" ? "serializable" : "read committed");
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async listBatches(
    actor: GovernedReviewActor,
    query: GovernedReviewListQuery
  ): Promise<GovernedReviewBatchProjection[]> {
    const rows = await this.pool.query(
      `select batch.id
       from governed_review_batches batch
       join governed_review_batch_states state on state.batch_id=batch.id
       where batch.project_id=$1
         and ($2::text is null or batch.criterion_version_id=$2)
         and ($3::text is null or state.state=$3)
       order by batch.created_at desc,batch.id`,
      [actor.projectId, query.criterionVersionId ?? null, query.state ?? null]
    );
    return Promise.all(rows.rows.map((row) => loadBatchProjection(this.pool, actor.projectId, String(row.id))));
  }

  async getBatchSummary(actor: GovernedReviewActor, batchId: string): Promise<GovernedReviewBatchProjection> {
    return loadBatchProjection(this.pool, actor.projectId, batchId);
  }

  async transitionBatch(
    actor: GovernedReviewActor,
    batchId: string,
    action: GovernedBatchAction,
    command: GovernedReviewStreamCommand
  ): Promise<GovernedReviewBatchProjection> {
    requireOwnerActor(actor, "control governed review batches");
    try {
      const result = await this.transaction(async (client) => {
        const batch = await lockBatch(client, actor.projectId, batchId);
        const actorSubject = await ensureSubject(client, actor.projectId, actor.userId);
        const requestDigest = governedReviewRequestDigest({ batchId, action, command });
        const replay = await client.query(
          `select request_digest from governed_review_batch_events
           where batch_id=$1 and idempotency_key=$2`,
          [batchId, command.idempotencyKey]
        );
        if (replay.rows[0]) {
          assertReplay(replay.rows[0].request_digest, requestDigest);
          return { kind: "ok" as const, batch: await loadBatchProjection(client, actor.projectId, batchId) };
        }
        const state = await currentBatchState(client, batchId);
        if (state.version !== command.expectedStateVersion) {
          throw new GovernedReviewStreamConflictError({ currentState: state.state, currentVersion: state.version });
        }
        if (action === "open" && batch.role_intent === "sealed_validation") {
          const subjects = await contentExposedSubjects(client, batch, false);
          const separation = await appendCapabilityChecks(
            client, batch, "batch_open", subjects, command.idempotencyKey
          );
          if (separation === "unknown") return { kind: "separation_unknown" as const };
          if (separation === "ineligible") return { kind: "separation_ineligible" as const };
        }
        if (action === "freeze" && batch.role_intent === "sealed_validation") {
          const subjects = await contentExposedSubjects(client, batch, true);
          const separation = await appendCapabilityChecks(
            client, batch, "truth_freeze", subjects, command.idempotencyKey
          );
          if (separation === "unknown") return { kind: "separation_unknown" as const };
          if (separation === "ineligible") return { kind: "separation_ineligible" as const };
        }
        if (action === "freeze") {
          if (state.state !== "resolved") {
            throw new GovernedReviewTransitionConflictError({ currentState: state.state, attemptedAction: action });
          }
          const frozen = await materializeFrozenTruth(client, actor, actorSubject.id, batch, command, requestDigest, state);
          return { kind: "ok" as const, batch: frozen };
        }
        const eventKind = await deriveBatchEventKind(client, batch, action, state.state);
        const eventClock = await observeBatchEventClock(client, batch.stop_at);
        const details = await batchEventDetails(
          client,
          batch,
          eventKind,
          eventClock.atOrAfterFixedStop
        );
        const priorDigest = state.digest;
        const eventId = stableId("grbe", batchId, command.idempotencyKey);
        const eventContent = {
          actorRoleAtReview: actor.projectRole,
          actorSubjectId: actorSubject.id,
          batchId,
          datasetRevisionId: null,
          details,
          eventKind,
          previousEventDigest: priorDigest,
          representativeIneligibleReasons: [],
          representativeOfPopulationId: null,
          sequence: state.version + 1,
          stateVersion: state.version + 1
        };
        const eventDigest = await dbDigest(client, "governed-review-batch-event/v1", eventContent);
        await client.query(
          `insert into governed_review_batch_events
             (id,project_id,batch_id,sequence,state_version,expected_previous_state_version,event_kind,
              actor_subject_id,actor_role_at_review,dataset_revision_id,representative_of_population_id,
              representative_ineligible_reasons,details,previous_event_digest,event_digest,
              idempotency_key,request_digest,occurred_at)
           values ($1,$2,$3,$4,$4,$5,$6,$7,$8,null,null,'{}',$9::jsonb,$10,$11,$12,$13,$14)`,
          [eventId, actor.projectId, batchId, state.version + 1, state.version, eventKind,
            actorSubject.id, actor.projectRole, JSON.stringify(details), priorDigest, eventDigest,
            command.idempotencyKey, requestDigest, eventClock.occurredAt]
        );
        return { kind: "ok" as const, batch: await loadBatchProjection(client, actor.projectId, batchId) };
      }, "serializable");
      if (result.kind === "separation_unknown") throw new GovernedReviewSeparationUnknownError();
      if (result.kind === "separation_ineligible") throw new GovernedReviewSeparationIneligibleError();
      return result.batch;
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async listReviewerTasks(actor: GovernedReviewActor): Promise<GovernedReviewerTaskProjection[]> {
    const subjectId = await resolveSubjectId(this.pool, actor.projectId, actor.userId);
    if (!subjectId) return [];
    const result = await this.pool.query(
      `select task.id as task_id,task.batch_id,batch.criterion_version_id,batch.instruction_version_id,
              criterion.name as criterion_name,instruction.title as instruction_title,
              state.state,state.state_version,task.serve_order,batch.stop_at,
              active.label_id
       from governed_review_tasks task
       join governed_review_batches batch on batch.id=task.batch_id
       join governed_review_batch_states batch_state on batch_state.batch_id=batch.id
       join governed_review_task_states state on state.task_id=task.id
       join criterion_versions criterion on criterion.id=batch.criterion_version_id
       join review_instruction_versions instruction on instruction.id=batch.instruction_version_id
       left join governed_active_review_labels active on active.task_id=task.id
       where task.project_id=$1 and task.reviewer_subject_id=$2
         and batch_state.state not in ('draft','abandoned')
       order by batch.created_at desc,task.serve_order,task.id`,
      [actor.projectId, subjectId]
    );
    return result.rows.map(rowToTaskProjection);
  }

  async getOrCreateBlindTaskView(
    actor: GovernedReviewActor,
    taskId: string
  ): Promise<GovernedBlindTaskViewArtifact> {
    try {
      return await this.transaction(async (client) => {
        const subjectId = await resolveSubjectId(client, actor.projectId, actor.userId);
        if (!subjectId) throw new GovernedReviewNotFoundError();
        const unlocked = (await client.query(
          `select task.batch_id from governed_review_tasks task
           where task.id=$1 and task.project_id=$2 and task.reviewer_subject_id=$3`,
          [taskId, actor.projectId, subjectId]
        )).rows[0];
        if (!unlocked) throw new GovernedReviewNotFoundError();
        await lockBatch(client, actor.projectId, String(unlocked.batch_id));
        const row = (await client.query(
          `select task.*,batch.criterion_version_id,batch.instruction_version_id,
                  item.review_payload_snapshot,batch_item.draw_position,
                  instruction.title,instruction.instructions,instruction.failure_code_guidance,
                  instruction.allowed_labels,instruction.content_digest as instruction_digest,
                  criterion.criterion_id,criterion.name as criterion_name,
                  criterion.definition as criterion_definition,criterion.criterion_digest
           from governed_review_tasks task
           join governed_review_batches batch on batch.id=task.batch_id
           join governed_review_batch_items batch_item on batch_item.id=task.batch_item_id
           join governed_review_items item on item.id=batch_item.review_item_id
           join review_instruction_versions instruction on instruction.id=batch.instruction_version_id
           join criterion_versions criterion on criterion.id=batch.criterion_version_id
           where task.id=$1 and task.project_id=$2 and task.reviewer_subject_id=$3
           for update of task`,
          [taskId, actor.projectId, subjectId]
        )).rows[0];
        if (!row) throw new GovernedReviewNotFoundError();
        const viewed = (await client.query(
          `select canonical_view_bytes_base64,view_digest
           from governed_review_task_events
           where task_id=$1 and event_kind='viewed' order by sequence limit 1`,
          [taskId]
        )).rows[0];
        if (viewed) {
          return {
            canonicalBytes: Buffer.from(String(viewed.canonical_view_bytes_base64), "base64"),
            viewDigest: String(viewed.view_digest)
          };
        }
        const state = await currentTaskState(client, taskId);
        if (state.state !== "assigned" || state.version !== 0) {
          throw new GovernedReviewTransitionConflictError({
            currentState: state.state,
            attemptedAction: "view"
          });
        }
        const artifact = buildBlindTaskViewArtifact(row);
        const bytes = Buffer.from(artifact.canonicalBytes);
        const viewDigest = artifact.viewDigest;
        const base64 = bytes.toString("base64");
        const eventId = stableId("grte", taskId, "viewed");
        const eventContent = taskEventContent({
          actorRoleAtReview: String(row.reviewer_role_at_review),
          actorSubjectId: subjectId,
          eventKind: "viewed",
          taskId,
          sequence: 1,
          previousEventDigest: null,
          canonicalViewBytesBase64: base64,
          viewDigest,
          viewContractVersion: "coeval/governed-blind-task-view/v1",
          canonicalizationVersion: "coeval-canonical-json/v1",
          exposureClass: "provenance",
          activity: "governed_review"
        });
        const eventDigest = await dbDigest(client, "governed-review-task-event/v1", eventContent);
        await client.query(
          `insert into governed_review_task_events
             (id,project_id,task_id,sequence,state_version,expected_previous_state_version,event_kind,
              actor_subject_id,actor_role_at_review,canonical_view_bytes_base64,view_digest,
              view_contract_version,canonicalization_version,exposure_class,activity,reason,
              previous_event_digest,event_digest,idempotency_key,request_digest)
           values ($1,$2,$3,1,1,0,'viewed',$4,$5,$6,$7,$8,$9,'provenance','governed_review',null,
                   null,$10,$11,$12)`,
          [eventId, actor.projectId, taskId, subjectId, row.reviewer_role_at_review, base64,
            viewDigest, "coeval/governed-blind-task-view/v1", "coeval-canonical-json/v1",
            eventDigest, INTERNAL_VIEW_IDEMPOTENCY_KEY,
            governedReviewRequestDigest({ taskId, action: "view" })]
        );
        return { canonicalBytes: bytes, viewDigest };
      });
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async appendTaskAction(
    actor: GovernedReviewActor,
    taskId: string,
    action: GovernedTaskAction
  ): Promise<GovernedTaskMutationProjection> {
    if (action.input.idempotencyKey.length < 1 || action.input.idempotencyKey.length > 200) {
      throw new GovernedReviewConflictError(
        "governed_review_transition_conflict",
        "Task action idempotency keys must remain in the public 1-200 character namespace"
      );
    }
    try {
      return await this.transaction(async (client) => {
        const subjectId = await resolveSubjectId(client, actor.projectId, actor.userId);
        if (!subjectId) throw new GovernedReviewNotFoundError();
        const identity = (await client.query(
          `select batch_id from governed_review_tasks
           where id=$1 and project_id=$2 and reviewer_subject_id=$3`,
          [taskId, actor.projectId, subjectId]
        )).rows[0];
        if (!identity) throw new GovernedReviewNotFoundError();
        await lockBatch(client, actor.projectId, String(identity.batch_id));
        const task = (await client.query(
          `select * from governed_review_tasks
           where id=$1 and project_id=$2 and reviewer_subject_id=$3 for update`,
          [taskId, actor.projectId, subjectId]
        )).rows[0];
        if (!task) throw new GovernedReviewNotFoundError();
        const input = action.input;
        const requestDigest = governedReviewRequestDigest({ taskId, action });
        const replay = await client.query(
          `select request_digest from governed_review_task_events
           where task_id=$1 and idempotency_key=$2`,
          [taskId, input.idempotencyKey]
        );
        if (replay.rows[0]) {
          assertReplay(replay.rows[0].request_digest, requestDigest);
          return loadTaskMutation(client, taskId);
        }
        const state = await currentTaskState(client, taskId);
        if (state.version !== input.expectedStreamVersion) {
          throw new GovernedReviewStreamConflictError({ currentState: state.state, currentVersion: state.version });
        }
        const sequence = state.version + 1;
        let eventKind: "deferred" | "resumed" | "label_submitted" | "label_withdrawn";
        let labelId: string | null = null;
        let reason: string | null = null;
        if (action.kind === "defer") {
          eventKind = "deferred";
          reason = action.input.reason;
        } else if (action.kind === "resume") {
          eventKind = "resumed";
          reason = action.input.reason ?? null;
        } else if (action.kind === "withdraw_label") {
          eventKind = "label_withdrawn";
          reason = action.input.reason;
          labelId = action.input.labelId;
          const active = (await client.query(
            `select label_id from governed_active_review_labels where task_id=$1`, [taskId]
          )).rows[0];
          if (!active || String(active.label_id) !== labelId) {
            throw new GovernedReviewTransitionConflictError({
              currentState: state.state,
              attemptedAction: "withdraw_label"
            });
          }
          const revealed = await client.query(
            `select 1
             from governed_review_alignment_event_labels where label_id=$1
             union all
             select 1 from governed_review_adjudication_labels where label_id=$1
             limit 1`,
            [labelId]
          );
          if (revealed.rowCount) throw new GovernedReviewLabelAlreadyRevealedError();
        } else {
          eventKind = "label_submitted";
          const prior = (await client.query(
            `select label.id,label.attempt
             from governed_review_labels label
             join governed_review_task_events event on event.label_id=label.id
             where label.task_id=$1 and event.event_kind='label_withdrawn'
             order by event.state_version desc limit 1`,
            [taskId]
          )).rows[0];
          const attempt = prior ? Number(prior.attempt) + 1 : 1;
          const replacesLabelId = prior ? String(prior.id) : null;
          labelId = stableId("grl", taskId, action.input.idempotencyKey);
          const labelContent = {
            attempt,
            blindViewDigest: action.input.viewDigest,
            failureCodes: action.input.failureCodes,
            label: action.input.label,
            rationale: action.input.rationale,
            replacesLabelId,
            reviewerSubjectId: subjectId,
            taskId
          };
          const labelDigest = await dbDigest(client, "governed-review-label/v1", labelContent);
          await client.query(
            `insert into governed_review_labels
               (id,project_id,task_id,reviewer_subject_id,attempt,label,rationale,failure_codes,
                blind_view_digest,replaces_label_id,content_digest,idempotency_key,request_digest)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [labelId, actor.projectId, taskId, subjectId, attempt, action.input.label,
              action.input.rationale, action.input.failureCodes, action.input.viewDigest,
              replacesLabelId, labelDigest, action.input.idempotencyKey, requestDigest]
          );
        }
        const eventContent = taskEventContent({
          actorRoleAtReview: String(task.reviewer_role_at_review),
          actorSubjectId: subjectId,
          eventKind,
          labelId,
          reason,
          taskId,
          sequence,
          previousEventDigest: state.digest
        });
        const eventDigest = await dbDigest(client, "governed-review-task-event/v1", eventContent);
        await client.query(
          `insert into governed_review_task_events
             (id,project_id,task_id,sequence,state_version,expected_previous_state_version,event_kind,
              actor_subject_id,actor_role_at_review,label_id,reason,previous_event_digest,event_digest,
              idempotency_key,request_digest)
           values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [stableId("grte", taskId, input.idempotencyKey), actor.projectId, taskId,
            sequence, state.version, eventKind, subjectId, task.reviewer_role_at_review,
            labelId, reason, state.digest, eventDigest, input.idempotencyKey, requestDigest]
        );
        return loadTaskMutation(client, taskId);
      });
    } catch (error) {
      if (isPgError(error, "40001")) {
        const current = await readTaskStateWithoutScope(this.pool, taskId);
        throw new GovernedReviewStreamConflictError(current);
      }
      throw mapPgError(error);
    }
  }

  async getPostBarrierItemView(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    _purpose: "alignment" | "adjudication"
  ): Promise<GovernedPostBarrierItemProjection> {
    try {
      const preflight = await this.transaction(async (client) => {
        const batch = await lockBatch(client, actor.projectId, batchId);
        const state = await currentBatchState(client, batchId);
        if (!["labeling_closed", "alignment_open", "adjudicating", "resolved", "incomplete", "frozen"].includes(state.state)) {
          throw new GovernedReviewForbiddenError("Independent labels remain hidden until labeling closes");
        }
        const subject = await ensureSubject(client, actor.projectId, actor.userId);
        const isReviewer = Boolean((await client.query(
          `select 1 from governed_review_tasks
           where batch_id=$1 and reviewer_subject_id=$2 limit 1`,
          [batchId, subject.id]
        )).rowCount);
        if (!isReviewer && actor.projectRole !== "owner") {
          throw new GovernedReviewForbiddenError("Post-barrier evidence is limited to assigned reviewers and owners");
        }
        const itemExists = await client.query(
          `select 1 from governed_review_batch_items
           where batch_id=$1 and project_id=$2 and (id=$3 or review_item_id=$3) for key share`,
          [batchId, actor.projectId, itemId]
        );
        if (!itemExists.rowCount) throw new GovernedReviewNotFoundError();
        if (batch.role_intent === "sealed_validation") {
          const result = await appendCapabilityChecks(
            client, batch, "adjudication", [subject.id], `post-barrier:${batchId}:${subject.id}`
          );
          if (result === "unknown") return { kind: "separation_unknown" as const };
          if (result === "ineligible") return { kind: "separation_ineligible" as const };
        }
        return { kind: "ok" as const };
      }, "serializable");
      if (preflight.kind === "separation_unknown") throw new GovernedReviewSeparationUnknownError();
      if (preflight.kind === "separation_ineligible") throw new GovernedReviewSeparationIneligibleError();
      const result = await this.pool.query(
        `select batch_item.id as batch_item_id,batch.criterion_version_id,
                criterion.name as criterion_name,criterion.definition as criterion_definition,
                instruction.id as instruction_version_id,instruction.title,instruction.instructions,
                instruction.failure_code_guidance,item.review_payload_snapshot,
                coalesce((select max(sequence) from governed_review_alignment_events
                          where batch_id=batch.id),0)::int as alignment_version,
                resolution.resolution_kind,resolution.resolved_label,resolution.adjudication_id
         from governed_review_batch_items batch_item
         join governed_review_batches batch on batch.id=batch_item.batch_id
         join governed_review_items item on item.id=batch_item.review_item_id
         join criterion_versions criterion on criterion.id=batch.criterion_version_id
         join review_instruction_versions instruction on instruction.id=batch.instruction_version_id
         cross join lateral governed_review_item_resolution(batch_item.id) resolution
         where batch.id=$1 and batch.project_id=$2
           and (batch_item.id=$3 or batch_item.review_item_id=$3)`,
        [batchId, actor.projectId, itemId]
      );
      const row = result.rows[0];
      if (!row) throw new GovernedReviewNotFoundError();
      const labels = await this.pool.query(
        `select label.id,label.reviewer_subject_id,label.label,label.rationale,label.failure_codes
         from governed_active_review_labels active
         join governed_review_labels label on label.id=active.label_id
         where active.batch_item_id=$1 order by label.id`,
        [row.batch_item_id]
      );
      const payload = parseJson(row.review_payload_snapshot) as GovernedPostBarrierItemProjection["payloadSnapshot"];
      assertBlindProjectionSafe(payload);
      return {
        batchId,
        batchItemId: String(row.batch_item_id),
        alignmentVersion: Number(row.alignment_version),
        criterion: {
          criterionVersionId: String(row.criterion_version_id),
          name: String(row.criterion_name),
          definition: String(row.criterion_definition)
        },
        instruction: {
          instructionVersionId: String(row.instruction_version_id),
          title: String(row.title),
          instructions: String(row.instructions),
          failureCodeGuidance: String(row.failure_code_guidance)
        },
        payloadSnapshot: payload,
        activeLabels: labels.rows.map((label) => ({
          labelId: String(label.id),
          reviewerSubjectId: String(label.reviewer_subject_id),
          label: label.label as "pass" | "fail" | "cannot_determine",
          rationale: String(label.rationale),
          failureCodes: asStringArray(label.failure_codes)
        })),
        resolution: {
          kind: row.resolution_kind,
          resolvedLabel: row.resolved_label,
          adjudicationId: row.adjudication_id
        }
      };
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async appendAlignmentEvent(
    actor: GovernedReviewActor,
    batchId: string,
    input: AppendGovernedReviewAlignmentEventInput
  ): Promise<GovernedAlignmentEventProjection> {
    try {
      return await this.transaction(async (client) => {
        const batch = await lockBatch(client, actor.projectId, batchId);
        const subject = await ensureSubject(client, actor.projectId, actor.userId);
        const isReviewer = Boolean((await client.query(
          `select 1 from governed_review_tasks where batch_id=$1 and reviewer_subject_id=$2 limit 1`,
          [batchId, subject.id]
        )).rowCount);
        if (actor.projectRole !== "owner" && !isReviewer) {
          throw new GovernedReviewForbiddenError(
            "Alignment evidence is limited to assigned reviewers and owners"
          );
        }
        const requestDigest = governedReviewRequestDigest({ batchId, input });
        const replay = await client.query(
          `select * from governed_review_alignment_events
           where batch_id=$1 and idempotency_key=$2`,
          [batchId, input.idempotencyKey]
        );
        if (replay.rows[0]) {
          assertReplay(replay.rows[0].request_digest, requestDigest);
          return rowToAlignment(replay.rows[0]);
        }
        const state = await currentBatchState(client, batchId);
        if (state.state !== "alignment_open") {
          throw new GovernedReviewTransitionConflictError({
            currentState: state.state,
            attemptedAction: "append_alignment"
          });
        }
        if (batch.role_intent === "sealed_validation") {
          const separation = await appendCapabilityChecks(
            client, batch, "adjudication", [subject.id], `alignment:${input.idempotencyKey}`
          );
          if (separation === "unknown") throw new GovernedReviewSeparationUnknownError();
          if (separation === "ineligible") throw new GovernedReviewSeparationIneligibleError();
        }
        const prior = (await client.query(
          `select sequence,event_digest from governed_review_alignment_events
           where batch_id=$1 order by sequence desc limit 1`, [batchId]
        )).rows[0];
        const currentSequence = Number(prior?.sequence ?? 0);
        if (currentSequence !== input.expectedAlignmentVersion) {
          throw new GovernedReviewStreamConflictError({
            currentState: "alignment_open",
            currentVersion: currentSequence
          });
        }
        const labels = await client.query(
          `select label_id from governed_active_review_labels where batch_id=$1 order by label_id`,
          [batchId]
        );
        const labelIds = labels.rows.map((row) => String(row.label_id));
        if (labelIds.length === 0) {
          throw new GovernedReviewTransitionConflictError({
            currentState: "alignment_open",
            attemptedAction: "append_alignment"
          });
        }
        const labelSetDigest = String((await client.query(
          `select governed_review_label_set_digest($1) as digest`, [batchId]
        )).rows[0].digest);
        const sequence = currentSequence + 1;
        const id = stableId("grae", batchId, input.idempotencyKey);
        const content = {
          actorRoleAtReview: actor.projectRole,
          actorSubjectId: subject.id,
          batchId,
          content: input.content,
          eventKind: input.kind,
          previousEventDigest: prior?.event_digest ?? null,
          proposedInstructionVersionId: input.proposedInstructionVersionId ?? null,
          sequence,
          visibleLabelCount: labelIds.length,
          visibleLabelSetDigest: labelSetDigest
        };
        const eventDigest = await dbDigest(client, "governed-review-alignment-event/v1", content);
        const inserted = await client.query(
          `insert into governed_review_alignment_events
             (id,project_id,batch_id,sequence,expected_previous_sequence,event_kind,
              actor_subject_id,actor_role_at_review,content,proposed_instruction_version_id,
              visible_label_count,visible_label_set_digest,previous_event_digest,event_digest,
              idempotency_key,request_digest)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
          [id, actor.projectId, batchId, sequence, currentSequence, input.kind, subject.id,
            actor.projectRole, input.content, input.proposedInstructionVersionId ?? null,
            labelIds.length, labelSetDigest, prior?.event_digest ?? null, eventDigest,
            input.idempotencyKey, requestDigest]
        );
        for (const labelId of labelIds) {
          await client.query(
            `insert into governed_review_alignment_event_labels
               (project_id,alignment_event_id,label_id) values ($1,$2,$3)`,
            [actor.projectId, id, labelId]
          );
        }
        return rowToAlignment(inserted.rows[0]);
      });
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async appendAdjudication(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    input: AppendGovernedReviewAdjudicationInput
  ): Promise<GovernedAdjudicationProjection> {
    try {
      const result = await this.transaction(async (client) => {
        const batch = await lockBatch(client, actor.projectId, batchId);
        const state = await currentBatchState(client, batchId);
        if (actor.projectRole !== "owner") {
          throw new GovernedReviewForbiddenError("Adjudication requires a project owner");
        }
        const subject = await ensureSubject(client, actor.projectId, actor.userId);
        const batchItem = (await client.query(
          `select * from governed_review_batch_items
           where batch_id=$1 and project_id=$2 and (id=$3 or review_item_id=$3) for update`,
          [batchId, actor.projectId, itemId]
        )).rows[0];
        if (!batchItem) throw new GovernedReviewNotFoundError();
        const requestDigest = governedReviewRequestDigest({ batchId, itemId: batchItem.id, input });
        const replay = await client.query(
          `select * from governed_review_adjudications
           where batch_item_id=$1 and idempotency_key=$2`,
          [batchItem.id, input.idempotencyKey]
        );
        if (replay.rows[0]) {
          assertReplay(replay.rows[0].request_digest, requestDigest);
          return {
            kind: "ok" as const,
            adjudication: await loadAdjudication(client, replay.rows[0])
          };
        }
        if (state.state === "frozen") {
          throw new GovernedReviewTransitionConflictError({
            currentState: "frozen",
            attemptedAction: "correct_adjudication_without_successor_materialization"
          });
        }
        if (state.state !== "adjudicating") {
          throw new GovernedReviewTransitionConflictError({
            currentState: state.state,
            attemptedAction: "adjudicate"
          });
        }
        if (batch.role_intent === "sealed_validation") {
          const separation = await appendCapabilityChecks(
            client, batch, "adjudication", [subject.id], input.idempotencyKey
          );
          if (separation === "unknown") return { kind: "separation_unknown" as const };
          if (separation === "ineligible") return { kind: "separation_ineligible" as const };
        }
        const head = (await client.query(
          `select candidate.* from governed_review_adjudications candidate
           where candidate.batch_item_id=$1
             and not exists (select 1 from governed_review_adjudications successor
                             where successor.supersedes_adjudication_id=candidate.id)
           order by candidate.chain_version desc limit 1 for update`,
          [batchItem.id]
        )).rows[0];
        const headId = head ? String(head.id) : null;
        if (headId !== input.expectedHeadAdjudicationId) {
          throw new GovernedReviewStreamConflictError({
            currentState: state.state,
            currentVersion: Number(head?.chain_version ?? 0)
          });
        }
        if (head && !input.correctionReason) {
          throw new GovernedReviewConflictError(
            "governed_review_transition_conflict",
            "Adjudication corrections require a non-empty correction reason"
          );
        }
        if (!head && input.correctionReason != null) {
          throw new GovernedReviewConflictError(
            "governed_review_transition_conflict",
            "A first adjudication cannot be described as a correction"
          );
        }
        const labels = await client.query(
          `select label_id from governed_active_review_labels
           where batch_item_id=$1 order by label_id`,
          [batchItem.id]
        );
        const labelIds = labels.rows.map((row) => String(row.label_id));
        const labelSetDigest = String((await client.query(
          `select governed_review_item_label_set_digest($1) as digest`, [batchItem.id]
        )).rows[0].digest);
        const chainVersion = Number(head?.chain_version ?? 0) + 1;
        const id = stableId("gra", String(batchItem.id), input.idempotencyKey);
        const content = {
          adjudicatorRoleAtReview: actor.projectRole,
          adjudicatorSubjectId: subject.id,
          basis: input.basis,
          batchId,
          batchItemId: String(batchItem.id),
          chainVersion,
          consideredLabelCount: labelIds.length,
          consideredLabelSetDigest: labelSetDigest,
          correctionReason: input.correctionReason ?? null,
          decision: input.decision,
          rationale: input.rationale,
          supersedesAdjudicationId: headId
        };
        const contentDigest = await dbDigest(client, "governed-review-adjudication/v1", content);
        const inserted = await client.query(
          `insert into governed_review_adjudications
             (id,project_id,batch_id,batch_item_id,chain_version,expected_previous_chain_version,
              supersedes_adjudication_id,adjudicator_subject_id,adjudicator_role_at_review,
              decision,rationale,basis,correction_reason,considered_label_count,
              considered_label_set_digest,content_digest,idempotency_key,request_digest)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
          [id, actor.projectId, batchId, batchItem.id, chainVersion, chainVersion - 1, headId,
            subject.id, actor.projectRole, input.decision, input.rationale, input.basis,
            input.correctionReason ?? null, labelIds.length, labelSetDigest, contentDigest,
            input.idempotencyKey, requestDigest]
        );
        for (const labelId of labelIds) {
          await client.query(
            `insert into governed_review_adjudication_labels
               (project_id,adjudication_id,label_id) values ($1,$2,$3)`,
            [actor.projectId, id, labelId]
          );
        }
        return {
          kind: "ok" as const,
          adjudication: await loadAdjudication(client, inserted.rows[0])
        };
      }, "serializable");
      if (result.kind === "separation_unknown") throw new GovernedReviewSeparationUnknownError();
      if (result.kind === "separation_ineligible") throw new GovernedReviewSeparationIneligibleError();
      return result.adjudication;
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async createImportedTruth(
    actor: GovernedReviewActor,
    input: CreateImportedTruthInput
  ): Promise<ImportedTruthProjection> {
    requireOwnerActor(actor, "import human truth");
    try {
      if (input.verificationMethod === "verified_signature" ||
          input.verificationMethod === "independently_verified_transport") {
        throw new GovernedImportedTruthVerificationUnavailableError();
      }
      return await this.transaction(async (client) => {
        const requestDigest = governedReviewRequestDigest(input);
        const existing = await client.query(
          `select * from governed_imported_truth
           where project_id=$1 and idempotency_key=$2 for update`,
          [actor.projectId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          assertReplay(existing.rows[0].request_digest, requestDigest);
          return rowToImportedTruth(existing.rows[0]);
        }
        const criterion = await client.query(
          `select 1 from criterion_versions where id=$1 and project_id=$2`,
          [input.criterionVersionId, actor.projectId]
        );
        if (!criterion.rowCount) throw new GovernedReviewNotFoundError();
        const payloadSnapshot = projectGovernedReviewPayload(input.payloadSnapshot);
        const sourceBytes = Buffer.from(canonicalJson(input.sourceArtifact), "utf8");
        if (sourceBytes.byteLength > 10 * 1024 * 1024) {
          throw new GovernedReviewConflictError(
            "governed_review_transition_conflict",
            "Imported source artifacts cannot exceed 10 MiB"
          );
        }
        const sourceDigest = sha256Bytes(sourceBytes);
        const transport = input.transportProvenance ?? null;
        const verificationEvidence = input.verificationEvidence ?? null;
        const instructions = input.instructionsProvenance ?? null;
        const raters = input.raterProvenance ?? null;
        const adjudication = input.adjudicationProvenance ?? null;
        const blindAttestation = input.blindAttestation ?? null;
        const completeAttestation = transport !== null && instructions !== null && raters !== null &&
          adjudication !== null && blindAttestation !== null;
        // This session route accepts caller artifacts but has no trusted key
        // registry or connector verifier. Proof-shaped JSON can therefore
        // never mint a verified evidence class.
        const evidenceClass = input.verificationMethod === "self_attested" && completeAttestation
          ? "imported_self_attested"
          : "unverified";
        const inputDigest = datasetInputIdentity({ input: input.payloadSnapshot.input }).digest;
        const provenanceContent = {
          adjudication,
          blindAttestation,
          instructions,
          issuer: input.issuer,
          raters,
          sourceArtifactDigest: sourceDigest,
          subject: input.subject,
          transport,
          verificationEvidence,
          verificationMethod: input.verificationMethod
        };
        const provenanceDigest = await dbDigest(
          client, "governed-imported-truth-provenance/v1", provenanceContent
        );
        const content = {
          criterionVersionId: input.criterionVersionId,
          evidenceClass,
          failureCodes: input.failureCodes,
          identityBasis: "input-identity/v1",
          inputDigest,
          label: input.label,
          payloadSnapshot,
          provenanceDigest,
          rationale: input.rationale
        };
        const contentDigest = await dbDigest(client, "governed-imported-truth/v1", content);
        const id = stableId("git", actor.projectId, input.idempotencyKey);
        const inserted = await client.query(
          `insert into governed_imported_truth
             (id,project_id,criterion_version_id,issuer,subject,source_artifact_bytes,
              source_artifact_digest,transport_provenance,verification_method,verification_evidence,
              instructions_provenance,rater_provenance,adjudication_provenance,blind_attestation,
              identity_basis,input_digest,payload_snapshot,label,rationale,failure_codes,evidence_class,
              provenance_digest,content_digest,idempotency_key,request_digest)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12::jsonb,
                   $13::jsonb,$14::jsonb,'input-identity/v1',$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24)
           returning *`,
          [id, actor.projectId, input.criterionVersionId, input.issuer, input.subject,
            sourceBytes, sourceDigest, jsonParam(transport), input.verificationMethod,
            jsonParam(verificationEvidence), jsonParam(instructions), jsonParam(raters),
            jsonParam(adjudication), jsonParam(blindAttestation), inputDigest,
            JSON.stringify(payloadSnapshot), input.label, input.rationale, input.failureCodes,
            evidenceClass, provenanceDigest, contentDigest, input.idempotencyKey, requestDigest]
        );
        return rowToImportedTruth(inserted.rows[0]);
      });
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async listImportedTruth(
    actor: GovernedReviewActor,
    query: ImportedTruthListQuery
  ): Promise<ImportedTruthProjection[]> {
    requireOwnerActor(actor, "list imported human truth");
    const result = await this.pool.query(
      `select * from governed_imported_truth
       where project_id=$1
         and ($2::text is null or criterion_version_id=$2)
         and ($3::text is null or evidence_class=$3)
       order by imported_at desc,id`,
      [actor.projectId, query.criterionVersionId ?? null, query.evidenceClass ?? null]
    );
    return result.rows.map(rowToImportedTruth);
  }

  private async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    isolation: "read committed" | "serializable" = "read committed"
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(isolation === "serializable" ? "begin isolation level serializable" : "begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface PreparedFrameItem extends GovernedSelectionFrameItem {
  sourceId: string;
}

function buildBlindTaskViewArtifact(row: Record<string, unknown>): GovernedBlindTaskViewArtifact {
  const payloadSnapshot = parseJson(row.review_payload_snapshot);
  assertBlindProjectionSafe(payloadSnapshot);
  const view = {
    contract: "coeval/governed-blind-task-view/v1",
    schemaVersion: 1,
    canonicalizationVersion: "coeval-canonical-json/v1",
    taskId: String(row.task_id ?? row.id),
    batchId: String(row.batch_id),
    servePosition: Number(row.serve_order),
    criterion: {
      criterionId: String(row.criterion_id),
      criterionVersionId: String(row.criterion_version_id),
      name: String(row.criterion_name),
      definition: String(row.criterion_definition),
      criterionDigest: String(row.criterion_digest)
    },
    instruction: {
      instructionVersionId: String(row.instruction_version_id),
      title: String(row.title),
      instructions: String(row.instructions),
      failureCodeGuidance: String(row.failure_code_guidance),
      allowedLabels: ALLOWED_LABELS,
      instructionDigest: String(row.instruction_digest)
    },
    payloadSnapshot
  };
  const canonicalBytes = Buffer.from(canonicalJson(view), "utf8");
  if (canonicalBytes.byteLength > MAX_BLIND_VIEW_BYTES) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The immutable blind view exceeds the governed 2 MiB boundary"
    );
  }
  return { canonicalBytes, viewDigest: sha256Bytes(canonicalBytes) };
}

async function assertBatchBlindViewsWithinLimit(
  client: PoolClient,
  projectId: string,
  batchId: string
): Promise<void> {
  const views = await client.query(
    `select task.id as task_id,task.batch_id,task.serve_order,
            batch.criterion_version_id,batch.instruction_version_id,
            item.review_payload_snapshot,
            instruction.title,instruction.instructions,instruction.failure_code_guidance,
            instruction.content_digest as instruction_digest,
            criterion.criterion_id,criterion.name as criterion_name,
            criterion.definition as criterion_definition,criterion.criterion_digest
     from governed_review_tasks task
     join governed_review_batches batch on batch.id=task.batch_id
     join governed_review_batch_items batch_item on batch_item.id=task.batch_item_id
     join governed_review_items item on item.id=batch_item.review_item_id
     join review_instruction_versions instruction on instruction.id=batch.instruction_version_id
     join criterion_versions criterion on criterion.id=batch.criterion_version_id
     where task.batch_id=$1 and task.project_id=$2
     order by task.serve_order,task.id`,
    [batchId, projectId]
  );
  for (const row of views.rows) buildBlindTaskViewArtifact(row);
}

interface PreparedFrame {
  sourcePopulationKind: "dataset_revision" | "sealed_intake" | "analysis_promotion_handoff";
  sourcePopulationId: string;
  populationId: string;
  populationDefinition: unknown;
  collectionProvenance: unknown;
  populationDigest: string;
  windowStart: string | null;
  windowEnd: string | null;
  custodianSubjectId: string | null;
  custodianRole: string | null;
  items: PreparedFrameItem[];
  sourceToReviewItemId: Map<string, string>;
}

async function prepareRevisionFrame(
  client: PoolClient,
  actor: GovernedReviewActor,
  creatorSubjectId: string,
  revisionId: string,
  roleIntent: CreateGovernedReviewBatchInput["roleIntent"]
): Promise<PreparedFrame> {
  const revision = (await client.query(
    `select * from dataset_revisions
     where id=$1 and project_id=$2 and role=$3 and role<>'sealed_validation'
       and source_kind<>'analysis_population'
     for key share`,
    [revisionId, actor.projectId, roleIntent]
  )).rows[0];
  if (!revision) throw new GovernedReviewNotFoundError();
  const sourceItems = await client.query(
    `select * from dataset_revision_items
     where revision_id=$1 and project_id=$2 order by position,id for key share`,
    [revisionId, actor.projectId]
  );
  if (sourceItems.rows.length !== Number(revision.item_count)) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The immutable source revision item count does not match its frozen evidence"
    );
  }
  const redactionProvenance = {
    contract: "coeval/governed-review-projection/v1",
    source: "immutable_dataset_revision",
    copiedFields: ["input", "output", "steps"],
    metadataAccepted: false
  };
  const items: PreparedFrameItem[] = [];
  const sourceToReviewItemId = new Map<string, string>();
  for (const source of sourceItems.rows) {
    const reviewItemId = stableId("gri", actor.projectId, "dataset-revision-item", String(source.id));
    const payload = projectGovernedReviewPayload(parseJson(source.payload_snapshot));
    const content = {
      identityBasis: "input-identity/v1",
      inputDigest: String(source.input_digest),
      redactionProvenance,
      reviewPayloadProjectionVersion: "governed-review-payload/v1",
      reviewPayloadSnapshot: payload,
      sealedFramePosition: null,
      sealedIntakePopulationId: null,
      sealedPredecessorRevisionId: null,
      sealedPredecessorRevisionItemId: null,
      sourceKind: "dataset_revision_item",
      sourceItemDigest: String(source.item_digest),
      sourceRevisionId: revisionId,
      sourceRevisionItemId: String(source.id)
    };
    const contentDigest = await dbDigest(client, "governed-review-item/v1", content);
    await client.query(
      `insert into governed_review_items
         (id,project_id,source_kind,source_revision_id,source_revision_item_id,identity_basis,
          input_digest,source_item_digest,review_payload_projection_version,review_payload_snapshot,
          redaction_provenance,content_digest,idempotency_key,request_digest,created_by_subject_id)
       values ($1,$2,'dataset_revision_item',$3,$4,'input-identity/v1',$5,$6,
               'governed-review-payload/v1',$7::jsonb,$8::jsonb,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [reviewItemId, actor.projectId, revisionId, source.id, source.input_digest, source.item_digest,
        JSON.stringify(payload), JSON.stringify(redactionProvenance), contentDigest,
        `source-revision-item:${source.id}`,
        governedReviewRequestDigest({ sourceRevisionId: revisionId, sourceRevisionItemId: source.id, payload }),
        creatorSubjectId]
    );
    const persisted = (await client.query(
      `select content_digest from governed_review_items where id=$1 and project_id=$2`,
      [reviewItemId, actor.projectId]
    )).rows[0];
    if (!persisted || String(persisted.content_digest) !== contentDigest) {
      throw new GovernedReviewIdempotencyConflictError();
    }
    items.push({ id: reviewItemId, digest: contentDigest, sourceId: String(source.id) });
    sourceToReviewItemId.set(String(source.id), reviewItemId);
    sourceToReviewItemId.set(reviewItemId, reviewItemId);
  }
  return {
    sourcePopulationKind: "dataset_revision",
    sourcePopulationId: revisionId,
    populationId: `dataset-revision:${revisionId}`,
    populationDefinition: {
      kind: "immutable_dataset_revision",
      revisionId,
      role: roleIntent
    },
    collectionProvenance: {
      kind: "dataset_revision",
      revisionDigest: String(revision.revision_digest),
      provenanceLevel: String(revision.provenance_level),
      sourceKind: String(revision.source_kind)
    },
    populationDigest: String(revision.content_digest),
    windowStart: null,
    windowEnd: null,
    custodianSubjectId: null,
    custodianRole: null,
    items,
    sourceToReviewItemId
  };
}

async function preparePromotionFrame(
  client: PoolClient,
  actor: GovernedReviewActor,
  creatorSubjectId: string,
  promotionId: string,
  criterionVersionId: string
): Promise<PreparedFrame> {
  const promotion = (await client.query(
    `select promotion.*,revision.role,revision.source_kind,revision.content_digest as revision_content_digest,
            revision.revision_digest,revision.provenance_level
     from analysis_criterion_promotions promotion
     join dataset_revisions revision
       on revision.id=promotion.source_dataset_revision_id
      and revision.project_id=promotion.project_id
     where promotion.id=$1 and promotion.project_id=$2
       and promotion.criterion_version_id=$3
       and revision.role='analysis_authoring'
       and revision.source_kind='analysis_population'
     for key share of promotion,revision`,
    [promotionId, actor.projectId, criterionVersionId]
  )).rows[0];
  if (!promotion) throw new GovernedReviewNotFoundError();
  const revisionId = String(promotion.source_dataset_revision_id);
  const sourceItems = await client.query(
    `select * from dataset_revision_items
     where revision_id=$1 and project_id=$2 order by position,id for key share`,
    [revisionId, actor.projectId]
  );
  const revision = (await client.query(
    `select * from dataset_revisions where id=$1 and project_id=$2 for key share`,
    [revisionId, actor.projectId]
  )).rows[0];
  if (!revision || sourceItems.rows.length !== Number(revision.item_count)) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The promotion handoff source revision no longer matches its immutable frame"
    );
  }
  const prepared = await materializeRevisionReviewItems(
    client,
    actor,
    creatorSubjectId,
    revisionId,
    sourceItems.rows
  );
  return {
    sourcePopulationKind: "analysis_promotion_handoff",
    sourcePopulationId: promotionId,
    populationId: revisionId,
    populationDefinition: {
      criterionVersionId,
      handoffDigest: String(promotion.handoff_digest),
      kind: "analysis_promotion_handoff",
      promotionId,
      sourceDatasetRevisionId: revisionId
    },
    collectionProvenance: {
      createsEvaluator: false,
      createsTruth: false,
      evidenceClass: "development_authoring_not_truth",
      handoffDigest: String(promotion.handoff_digest),
      kind: "analysis_promotion_handoff",
      promotionId,
      provenanceLevel: String(promotion.provenance_level),
      revisionDigest: String(promotion.source_dataset_revision_digest),
      sourceKind: "analysis_population"
    },
    populationDigest: String(promotion.source_dataset_revision_content_digest),
    windowStart: null,
    windowEnd: null,
    custodianSubjectId: null,
    custodianRole: null,
    ...prepared
  };
}

async function materializeRevisionReviewItems(
  client: PoolClient,
  actor: GovernedReviewActor,
  creatorSubjectId: string,
  revisionId: string,
  sourceRows: Array<Record<string, unknown>>
): Promise<Pick<PreparedFrame, "items" | "sourceToReviewItemId">> {
  const redactionProvenance = {
    contract: "coeval/governed-review-projection/v1",
    source: "immutable_dataset_revision",
    copiedFields: ["input", "output", "steps"],
    metadataAccepted: false
  };
  const items: PreparedFrameItem[] = [];
  const sourceToReviewItemId = new Map<string, string>();
  for (const source of sourceRows) {
    const reviewItemId = stableId("gri", actor.projectId, "dataset-revision-item", String(source.id));
    const payload = projectGovernedReviewPayload(parseJson(source.payload_snapshot));
    const content = {
      identityBasis: "input-identity/v1",
      inputDigest: String(source.input_digest),
      redactionProvenance,
      reviewPayloadProjectionVersion: "governed-review-payload/v1",
      reviewPayloadSnapshot: payload,
      sealedFramePosition: null,
      sealedIntakePopulationId: null,
      sealedPredecessorRevisionId: null,
      sealedPredecessorRevisionItemId: null,
      sourceKind: "dataset_revision_item",
      sourceItemDigest: String(source.item_digest),
      sourceRevisionId: revisionId,
      sourceRevisionItemId: String(source.id)
    };
    const contentDigest = await dbDigest(client, "governed-review-item/v1", content);
    await client.query(
      `insert into governed_review_items
         (id,project_id,source_kind,source_revision_id,source_revision_item_id,identity_basis,
          input_digest,source_item_digest,review_payload_projection_version,review_payload_snapshot,
          redaction_provenance,content_digest,idempotency_key,request_digest,created_by_subject_id)
       values ($1,$2,'dataset_revision_item',$3,$4,'input-identity/v1',$5,$6,
               'governed-review-payload/v1',$7::jsonb,$8::jsonb,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [reviewItemId, actor.projectId, revisionId, source.id, source.input_digest, source.item_digest,
        JSON.stringify(payload), JSON.stringify(redactionProvenance), contentDigest,
        `source-revision-item:${source.id}`,
        governedReviewRequestDigest({ sourceRevisionId: revisionId, sourceRevisionItemId: source.id, payload }),
        creatorSubjectId]
    );
    const persisted = (await client.query(
      `select content_digest from governed_review_items where id=$1 and project_id=$2`,
      [reviewItemId, actor.projectId]
    )).rows[0];
    if (!persisted || String(persisted.content_digest) !== contentDigest) {
      throw new GovernedReviewIdempotencyConflictError();
    }
    items.push({ id: reviewItemId, digest: contentDigest, sourceId: String(source.id) });
    sourceToReviewItemId.set(String(source.id), reviewItemId);
    sourceToReviewItemId.set(reviewItemId, reviewItemId);
  }
  return { items, sourceToReviewItemId };
}

async function prepareSealedFrame(
  client: PoolClient,
  projectId: string,
  intakeId: string
): Promise<PreparedFrame> {
  const population = (await client.query(
    `select * from governed_sealed_intake_populations
     where id=$1 and project_id=$2 for key share`, [intakeId, projectId]
  )).rows[0];
  if (!population) throw new GovernedReviewNotFoundError();
  const rows = await client.query(
    `select id,content_digest,sealed_frame_position from governed_review_items
     where sealed_intake_population_id=$1 and project_id=$2
     order by sealed_frame_position,id for key share`,
    [intakeId, projectId]
  );
  if (rows.rows.length !== Number(population.frame_count)) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The protected sealed frame does not match its immutable population receipt"
    );
  }
  const items = rows.rows.map((row) => ({
    id: String(row.id),
    digest: String(row.content_digest),
    sourceId: String(row.id)
  }));
  return {
    sourcePopulationKind: "sealed_intake",
    sourcePopulationId: intakeId,
    populationId: intakeId,
    populationDefinition: parseJson(population.population_definition),
    collectionProvenance: parseJson(population.collection_provenance),
    populationDigest: String(population.frame_digest),
    windowStart: population.window_start ? iso(population.window_start) : null,
    windowEnd: population.window_end ? iso(population.window_end) : null,
    custodianSubjectId: String(population.custodian_subject_id),
    custodianRole: String(population.custodian_role_at_review),
    items,
    sourceToReviewItemId: new Map(items.map((item) => [item.id, item.id]))
  };
}

function translateSelection(
  selection: CreateGovernedReviewBatchInput["selection"],
  aliases: Map<string, string>,
  sealedIntakeId?: string
) {
  const translate = (id: string) => aliases.get(id) ?? (
    sealedIntakeId && aliases.has(sealedItemId(sealedIntakeId, id))
      ? sealedItemId(sealedIntakeId, id)
      : id
  );
  if (selection.method === "stratified_random") {
    return {
      ...selection,
      strata: selection.strata.map((stratum) => ({
        ...stratum,
        sourceItemIds: stratum.sourceItemIds.map(translate)
      }))
    };
  }
  if (
    selection.method === "convenience" || selection.method === "uncertainty" ||
    selection.method === "failure_hunting" || selection.method === "manual"
  ) {
    return { ...selection, selectedSourceItemIds: selection.selectedSourceItemIds.map(translate) };
  }
  return selection;
}

async function lockBatch(client: PoolClient, projectId: string, batchId: string): Promise<BatchRow> {
  const row = (await client.query(
    `select * from governed_review_batches where id=$1 and project_id=$2 for update`,
    [batchId, projectId]
  )).rows[0];
  if (!row) throw new GovernedReviewNotFoundError();
  return row as BatchRow;
}

async function currentBatchState(
  db: Db,
  batchId: string
): Promise<{ state: string; version: number; digest: string | null }> {
  const row = (await db.query(
    `select governed_review_current_batch_state($1) as state,
            coalesce(max(state_version),0)::int as version,
            (select event_digest from governed_review_batch_events
             where batch_id=$1 order by state_version desc limit 1) as digest
     from governed_review_batch_events where batch_id=$1`,
    [batchId]
  )).rows[0];
  return { state: String(row.state), version: Number(row.version), digest: row.digest ? String(row.digest) : null };
}

async function currentTaskState(
  db: Db,
  taskId: string
): Promise<{ state: string; version: number; digest: string | null }> {
  const row = (await db.query(
    `select governed_review_current_task_state($1) as state,
            coalesce(max(state_version),0)::int as version,
            (select event_digest from governed_review_task_events
             where task_id=$1 order by state_version desc limit 1) as digest
     from governed_review_task_events where task_id=$1`,
    [taskId]
  )).rows[0];
  return { state: String(row.state), version: Number(row.version), digest: row.digest ? String(row.digest) : null };
}

async function readTaskStateWithoutScope(
  db: Db,
  taskId: string
): Promise<{ currentState: string; currentVersion: number }> {
  const current = await currentTaskState(db, taskId);
  return { currentState: current.state, currentVersion: current.version };
}

async function loadBatchProjection(
  db: Db,
  projectId: string,
  batchId: string
): Promise<GovernedReviewBatchProjection> {
  const result = await db.query(
    `select batch.*,state.state,state.state_version,
            frozen.dataset_revision_id,frozen.representative_of_population_id,
            frozen.representative_ineligible_reasons,
            coalesce(count(task.id),0)::int as total_tasks,
            coalesce(count(task.id) filter (where task_state.state='submitted'),0)::int as submitted_tasks,
            coalesce(count(task.id) filter (where task_state.state='deferred'),0)::int as deferred_tasks,
            coalesce(count(task.id) filter (where task_state.state='expired'),0)::int as expired_tasks,
            coalesce(count(task.id) filter (where task_state.state in ('assigned','viewed','withdrawn')),0)::int as pending_tasks
     from governed_review_batches batch
     join governed_review_batch_states state on state.batch_id=batch.id
     left join governed_review_tasks task on task.batch_id=batch.id
     left join governed_review_task_states task_state on task_state.task_id=task.id
     left join lateral (
       select event.dataset_revision_id,event.representative_of_population_id,
              event.representative_ineligible_reasons
       from governed_review_batch_events event
       where event.batch_id=batch.id and event.event_kind='frozen'
       order by event.state_version desc limit 1
     ) frozen on true
     where batch.id=$1 and batch.project_id=$2
     group by batch.id,state.state,state.state_version,frozen.dataset_revision_id,
              frozen.representative_of_population_id,frozen.representative_ineligible_reasons`,
    [batchId, projectId]
  );
  const row = result.rows[0];
  if (!row) throw new GovernedReviewNotFoundError();
  const members = await db.query(
    `select item.id,item.draw_position,resolution.resolution_kind,resolution.resolved_label
     from governed_review_batch_items item
     cross join lateral governed_review_item_resolution(item.id) resolution
     where item.batch_id=$1 order by item.draw_position,item.id`,
    [batchId]
  );
  const frozen = row.state === "frozen";
  const barrierCrossed = !["draft", "open"].includes(String(row.state));
  // Generic sealed projections never reveal evaluator-derived outcomes. A
  // qualified post-barrier reader must use getPostBarrierItemView instead.
  const mayProjectResolution = barrierCrossed && row.role_intent !== "sealed_validation";
  const representativePopulation = row.representative_of_population_id
    ? String(row.representative_of_population_id)
    : null;
  return {
    batchId: String(row.id),
    criterionVersionId: String(row.criterion_version_id),
    instructionVersionId: String(row.instruction_version_id),
    roleIntent: row.role_intent,
    sourcePopulationKind: row.source_population_kind,
    sourcePopulationId: String(row.source_population_id),
    evaluatorBlind: Boolean(row.evaluator_blind),
    peerBlindUntilLabelingClosed: Boolean(row.peer_blind_until_labeling_closed),
    selectionMethod: row.selection_method,
    batchDigest: String(row.content_digest),
    populationDigest: String(row.population_digest),
    drawDigest: String(row.draw_digest),
    fixedBudget: Number(row.fixed_budget),
    requiredIndependentLabels: Number(row.required_labels_per_item),
    state: row.state,
    stateVersion: Number(row.state_version),
    fixedStopAt: iso(row.stop_at),
    itemCount: Number(row.fixed_budget),
    items: members.rows.map((item) => ({
      batchItemId: String(item.id),
      servePosition: Number(item.draw_position),
      resolutionKind: mayProjectResolution ? item.resolution_kind : null,
      resolvedLabel: mayProjectResolution ? item.resolved_label : null
    })),
    completeness: barrierCrossed ? {
      totalTasks: Number(row.total_tasks),
      submittedTasks: Number(row.submitted_tasks),
      deferredTasks: Number(row.deferred_tasks),
      expiredTasks: Number(row.expired_tasks),
      pendingTasks: Number(row.pending_tasks)
    } : null,
    representativeness: frozen
      ? {
          status: representativePopulation ? "eligible" : "ineligible",
          populationId: representativePopulation,
          reasons: representativePopulation ? [] : asStringArray(row.representative_ineligible_reasons)
        }
      : { status: "not_evaluated", populationId: null, reasons: [] },
    datasetRevisionId: row.dataset_revision_id ? String(row.dataset_revision_id) : null,
    evidenceClass: frozen ? "governed_blind" : null,
    createdAt: iso(row.created_at)
  };
}

async function loadTaskMutation(db: Db, taskId: string): Promise<GovernedTaskMutationProjection> {
  const state = await currentTaskState(db, taskId);
  const active = (await db.query(
    `select label_id from governed_active_review_labels where task_id=$1`, [taskId]
  )).rows[0];
  return {
    taskId,
    state: state.state as GovernedTaskMutationProjection["state"],
    stateVersion: state.version,
    activeLabelId: active ? String(active.label_id) : null
  };
}

function rowToTaskProjection(row: Record<string, unknown>): GovernedReviewerTaskProjection {
  return {
    taskId: String(row.task_id),
    batchId: String(row.batch_id),
    criterionVersionId: String(row.criterion_version_id),
    instructionVersionId: String(row.instruction_version_id),
    criterionName: String(row.criterion_name),
    instructionTitle: String(row.instruction_title),
    state: row.state as GovernedReviewerTaskProjection["state"],
    stateVersion: Number(row.state_version),
    servePosition: Number(row.serve_order),
    fixedStopAt: iso(row.stop_at),
    activeLabelId: row.label_id ? String(row.label_id) : null
  };
}

async function deriveBatchEventKind(
  client: PoolClient,
  batch: BatchRow,
  action: Exclude<GovernedBatchAction, "freeze">,
  currentState: string
): Promise<string> {
  const direct: Record<string, { from: string[]; event: string }> = {
    open: { from: ["draft"], event: "open" },
    close_labeling: { from: ["open"], event: "labeling_closed" },
    open_alignment: { from: ["labeling_closed"], event: "alignment_open" },
    start_adjudication: { from: ["labeling_closed", "alignment_open"], event: "adjudicating" }
  };
  if (action !== "finalize") {
    const rule = direct[action];
    if (!rule?.from.includes(currentState)) {
      throw new GovernedReviewTransitionConflictError({ currentState, attemptedAction: action });
    }
    return rule.event;
  }
  if (!["labeling_closed", "alignment_open", "adjudicating"].includes(currentState)) {
    throw new GovernedReviewTransitionConflictError({ currentState, attemptedAction: action });
  }
  const resolutions = await client.query(
    `select resolution.resolution_kind
     from governed_review_batch_items item
     cross join lateral governed_review_item_resolution(item.id) resolution
     where item.batch_id=$1`,
    [batch.id]
  );
  const kinds = resolutions.rows.map((row) => String(row.resolution_kind));
  if (kinds.every((kind) => ["single_rater", "unanimous", "adjudicated"].includes(kind))) return "resolved";
  if (kinds.some((kind) => kind === "coverage_gap" || kind === "unresolvable")) return "incomplete";
  throw new GovernedReviewTransitionConflictError({
    currentState,
    attemptedAction: "finalize_requires_adjudication"
  });
}

async function observeBatchEventClock(
  client: PoolClient,
  stopAt: Date | string
): Promise<{ occurredAt: Date | string; atOrAfterFixedStop: boolean }> {
  const row = (await client.query(
    `with observed as materialized (select clock_timestamp() as occurred_at)
     select occurred_at,occurred_at >= $1::timestamptz as at_or_after_fixed_stop from observed`,
    [stopAt]
  )).rows[0];
  return {
    occurredAt: row.occurred_at as Date | string,
    atOrAfterFixedStop: Boolean(row.at_or_after_fixed_stop)
  };
}

async function batchEventDetails(
  client: PoolClient,
  batch: BatchRow,
  eventKind: string,
  atOrAfterFixedStop: boolean
): Promise<unknown> {
  if (eventKind === "labeling_closed") {
    const active = await client.query(
      `select label_id from governed_active_review_labels where batch_id=$1 order by label_id`, [batch.id]
    );
    const terminal = await client.query(
      `select task.id,governed_review_current_task_state(task.id) as state
       from governed_review_tasks task where task.batch_id=$1 order by task.id for update`,
      [batch.id]
    );
    return {
      activeLabelIds: active.rows.map((row) => String(row.label_id)),
      deferredTaskIds: terminal.rows.filter((row) => row.state === "deferred").map((row) => String(row.id)),
      expiredTaskIds: atOrAfterFixedStop
        ? terminal.rows.filter((row) => ["assigned", "viewed", "withdrawn"].includes(String(row.state))).map((row) => String(row.id))
        : [],
      closedAtFixedStop: atOrAfterFixedStop
    };
  }
  if (eventKind === "resolved" || eventKind === "incomplete") {
    const rows = await client.query(
      `select item.review_item_id,resolution.resolution_kind
       from governed_review_batch_items item
       cross join lateral governed_review_item_resolution(item.id) resolution
       where item.batch_id=$1 order by item.draw_position,item.id`,
      [batch.id]
    );
    return eventKind === "resolved"
      ? { resolvedReviewItemIds: rows.rows.map((row) => String(row.review_item_id)) }
      : {
          gapReviewItemIds: rows.rows
            .filter((row) => ["coverage_gap", "unresolvable"].includes(String(row.resolution_kind)))
            .map((row) => String(row.review_item_id))
        };
  }
  return {};
}

async function contentExposedSubjects(
  client: PoolClient,
  batch: BatchRow,
  includePostBarrier: boolean
): Promise<string[]> {
  const values: string[] = [];
  if (batch.custodian_subject_id) values.push(String(batch.custodian_subject_id));
  const reviewers = await client.query(
    `select distinct reviewer_subject_id from governed_review_tasks where batch_id=$1`, [batch.id]
  );
  values.push(...reviewers.rows.map((row) => String(row.reviewer_subject_id)));
  if (includePostBarrier) {
    const exposed = await client.query(
      `select adjudicator_subject_id as subject_id from governed_review_adjudications where batch_id=$1
       union
       select subject_id from governed_review_capability_checks
       where batch_id=$1 and check_scope='adjudication' and result='eligible'`,
      [batch.id]
    );
    values.push(...exposed.rows.map((row) => String(row.subject_id)));
  }
  return [...new Set(values)].sort();
}

async function appendCapabilityChecks(
  client: PoolClient,
  batch: BatchRow,
  scope: "batch_open" | "adjudication" | "truth_freeze",
  subjectIds: string[],
  commandKey: string
): Promise<"eligible" | "unknown" | "ineligible"> {
  let aggregate: "eligible" | "unknown" | "ineligible" = "eligible";
  for (const subjectId of [...new Set(subjectIds)].sort()) {
    const evaluated = await evaluateCapability(client, batch, subjectId);
    if (evaluated.result === "ineligible") aggregate = "ineligible";
    else if (evaluated.result === "unknown" && aggregate === "eligible") aggregate = "unknown";
    const baseIdempotencyKey = `capability:${batch.id}:${scope}:${subjectId}:${commandKey}`;
    const requestDigest = governedReviewRequestDigest({
      batchId: batch.id,
      scope,
      subjectId,
      evidence: evaluated
    });
    let idempotencyKey = baseIdempotencyKey;
    let priorByKey = await client.query(
      `select result,request_digest from governed_review_capability_checks
       where project_id=$1 and idempotency_key=$2`,
      [batch.project_id, idempotencyKey]
    );
    if (priorByKey.rows[0]) {
      if (String(priorByKey.rows[0].request_digest) === requestDigest) continue;
      // A capability check is point-in-time evidence. If provenance changed
      // since a prior read using the same logical command, append a new check
      // instead of treating the newer evidence as an idempotency conflict.
      idempotencyKey = `${baseIdempotencyKey}:${requestDigest.slice(7, 23)}`;
      priorByKey = await client.query(
        `select result,request_digest from governed_review_capability_checks
         where project_id=$1 and idempotency_key=$2`,
        [batch.project_id, idempotencyKey]
      );
      if (priorByKey.rows[0]) {
        assertReplay(priorByKey.rows[0].request_digest, requestDigest);
        continue;
      }
    }
    const previous = (await client.query(
      `select coalesce(max(sequence),0)::int as sequence
       from governed_review_capability_checks
       where batch_id=$1 and check_scope=$2 and subject_id=$3 and evaluator_version_id is null`,
      [batch.id, scope, subjectId]
    )).rows[0];
    const sequence = Number(previous.sequence) + 1;
    const evidence = {
      contract: "coeval/sealed-separation-evidence/v1",
      criterionVersionId: batch.criterion_version_id,
      evaluatedCapabilities: [...COVERED_CAPABILITIES],
      findings: evaluated.findings
    };
    const evidenceDigest = await dbDigest(client, "sealed-separation-evidence/v1", evidence);
    const content = {
      batchId: batch.id,
      capabilityQueryVersion: "sealed-separation/v1",
      checkScope: scope,
      coveredCapabilities: [...COVERED_CAPABILITIES],
      evidenceDigest,
      evaluatorVersionId: null,
      excludedCapabilities: evaluated.excluded,
      result: evaluated.result,
      sequence,
      subjectId,
      unknownCapabilities: evaluated.unknown,
      verificationMethod: "system_derived"
    };
    const contentDigest = await dbDigest(client, "governed-review-capability-check/v1", content);
    await client.query(
      `insert into governed_review_capability_checks
         (id,project_id,batch_id,criterion_version_id,evaluator_version_id,subject_id,
          sequence,expected_previous_sequence,check_scope,result,verification_method,
          capability_query_version,covered_capabilities,excluded_capabilities,unknown_capabilities,
          evidence,evidence_digest,content_digest,idempotency_key,request_digest)
       values ($1,$2,$3,$4,null,$5,$6,$7,$8,$9,'system_derived','sealed-separation/v1',
               $10,$11,$12,$13::jsonb,$14,$15,$16,$17)`,
      [stableId("grcc", batch.id, scope, subjectId, idempotencyKey), batch.project_id, batch.id,
        batch.criterion_version_id, subjectId, sequence, sequence - 1, scope, evaluated.result,
        [...COVERED_CAPABILITIES], evaluated.excluded, evaluated.unknown,
        JSON.stringify(evidence), evidenceDigest, contentDigest, idempotencyKey, requestDigest]
    );
  }
  return aggregate;
}

async function evaluateCapability(
  client: PoolClient,
  batch: BatchRow,
  subjectId: string
): Promise<{
  result: "eligible" | "unknown" | "ineligible";
  excluded: string[];
  unknown: string[];
  findings: unknown;
}> {
  const subject = (await client.query(
    `select account_user_id from governed_reviewer_subjects
     where id=$1 and project_id=$2`, [subjectId, batch.project_id]
  )).rows[0];
  if (!subject) throw new GovernedReviewForbiddenError("Capability subject is outside the project");
  const accountId = subject.account_user_id ? String(subject.account_user_id) : null;
  const criterionAuthors = await client.query(
    `select candidate.created_by_user_id
     from criterion_versions target
     join criterion_versions candidate
       on candidate.project_id=target.project_id and candidate.criterion_id=target.criterion_id
     where target.id=$1 and target.project_id=$2`,
    [batch.criterion_version_id, batch.project_id]
  );
  const instructionAuthors = await client.query(
    `select instruction.created_by_subject_id
     from criterion_versions target
     join criterion_versions candidate
       on candidate.project_id=target.project_id and candidate.criterion_id=target.criterion_id
     join review_instruction_versions instruction
       on instruction.project_id=candidate.project_id
      and instruction.criterion_version_id=candidate.id
     where target.id=$1 and target.project_id=$2`,
    [batch.criterion_version_id, batch.project_id]
  );
  const excluded: string[] = [];
  const unknown: string[] = [];
  if (criterionAuthors.rows.some((row) => !row.created_by_user_id)) unknown.push("criterion_author_identity");
  if (accountId && criterionAuthors.rows.some((row) => String(row.created_by_user_id) === accountId)) {
    excluded.push("criterion_authoring");
  }
  if (instructionAuthors.rows.some((row) => !row.created_by_subject_id)) unknown.push("instruction_author_identity");
  if (instructionAuthors.rows.some((row) => String(row.created_by_subject_id) === subjectId)) {
    excluded.push("instruction_authoring");
  }
  const skillRows = await client.query(
    `select version.id,version.developer_identity_status,
            exists(select 1 from governed_evaluator_development_events event
                   where event.skill_version_id=version.id and event.project_id=version.project_id
                     and event.criterion_version_id=version.criterion_version_id) as has_event,
            version.created_by_subject_id
     from skill_versions version
     join criterion_versions version_criterion on version_criterion.id=version.criterion_version_id
     join criterion_versions target_criterion
       on target_criterion.project_id=version_criterion.project_id
      and target_criterion.criterion_id=version_criterion.criterion_id
     where version.project_id=$1 and target_criterion.id=$2`,
    [batch.project_id, batch.criterion_version_id]
  );
  for (const row of skillRows.rows) {
    if (row.developer_identity_status !== "recorded" || !row.has_event) {
      unknown.push("evaluator_author_identity");
    }
    if (row.created_by_subject_id && String(row.created_by_subject_id) === subjectId) {
      excluded.push("evaluator_authoring");
    }
  }
  const development = await client.query(
    `select 1
     from governed_evaluator_development_events development
     join criterion_versions development_criterion on development_criterion.id=development.criterion_version_id
     join criterion_versions target_criterion
       on target_criterion.project_id=development_criterion.project_id
      and target_criterion.criterion_id=development_criterion.criterion_id
     where development.project_id=$1 and target_criterion.id=$2
       and development.developer_subject_id=$3 limit 1`,
    [batch.project_id, batch.criterion_version_id, subjectId]
  );
  if (development.rowCount) excluded.push("evaluator_authoring");
  const exposure = await client.query(
    `select 1 from dataset_exposure_events
     where project_id=$1 and exposure_class='development'
       and subject_id = any($2::text[]) limit 1`,
    [batch.project_id, [subjectId, ...(accountId ? [accountId] : [])]]
  );
  if (exposure.rowCount) excluded.push("development_exposure");
  const uniqueExcluded = [...new Set(excluded)].sort();
  const uniqueUnknown = [...new Set(unknown)].sort();
  return {
    result: uniqueExcluded.length > 0 ? "ineligible" : uniqueUnknown.length > 0 ? "unknown" : "eligible",
    excluded: uniqueExcluded,
    unknown: uniqueUnknown,
    findings: {
      criterionAuthorKnown: criterionAuthors.rows.length > 0 &&
        criterionAuthors.rows.every((row) => Boolean(row.created_by_user_id)),
      instructionAuthorKnown: instructionAuthors.rows.length > 0 &&
        instructionAuthors.rows.every((row) => Boolean(row.created_by_subject_id)),
      evaluatorVersionsChecked: skillRows.rows.length,
      recordedDevelopmentExposure: Boolean(exposure.rowCount)
    }
  };
}

async function materializeFrozenTruth(
  client: PoolClient,
  actor: GovernedReviewActor,
  actorSubjectId: string,
  batch: BatchRow,
  command: GovernedReviewStreamCommand,
  requestDigest: string,
  state: { state: string; version: number; digest: string | null }
): Promise<GovernedReviewBatchProjection> {
  const members = await client.query(
    `select batch_item.id as batch_item_id,batch_item.draw_position,
            review_item.*,resolution.resolution_kind,resolution.resolved_label,resolution.adjudication_id
     from governed_review_batch_items batch_item
     join governed_review_items review_item on review_item.id=batch_item.review_item_id
     cross join lateral governed_review_item_resolution(batch_item.id) resolution
     where batch_item.batch_id=$1 order by batch_item.draw_position,batch_item.id for update of batch_item`,
    [batch.id]
  );
  if (members.rows.length !== Number(batch.fixed_budget) || members.rows.some((row) => !row.resolved_label)) {
    throw new GovernedReviewTransitionConflictError({ currentState: state.state, attemptedAction: "freeze_incomplete" });
  }
  const revisionId = stableId("dsr", batch.id, "governed-freeze");
  const priorRevision = batch.role_intent === "sealed_validation"
    ? (await client.query(
        `select revision.* from governed_sealed_intake_populations population
         left join dataset_revisions revision on revision.id=population.predecessor_revision_id
         where population.id=$1`, [batch.source_population_id]
      )).rows[0]
    : null;
  const sourceRevision = batch.source_population_kind === "dataset_revision"
    ? (await client.query(`select * from dataset_revisions where id=$1`, [batch.source_population_id])).rows[0]
    : batch.source_population_kind === "analysis_promotion_handoff"
      ? (await client.query(`select * from dataset_revisions where id=$1`, [batch.population_id])).rows[0]
      : null;
  const seriesId = priorRevision?.id
    ? String(priorRevision.series_id)
    : `governed-review:${batch.id}`;
  const revisionNumber = priorRevision?.id ? Number(priorRevision.revision_number) + 1 : 1;
  const parentRevisionId = priorRevision?.id ? String(priorRevision.id) : null;
  const preparedItems: Array<{
    id: string;
    batchItemId: string;
    position: number;
    payload: Record<string, unknown>;
    inputDigest: string;
    itemDigest: string;
    referenceLabel: "pass" | "fail";
    referenceProvenance: Record<string, unknown>;
    truthLinkId: string;
    resolutionKind: "single_rater" | "unanimous" | "adjudicated";
    adjudicationId: string | null;
    labelIds: string[];
  }> = [];
  for (const member of members.rows) {
    const labelRows = await client.query(
      `select label_id from governed_active_review_labels where batch_item_id=$1 order by label_id`,
      [member.batch_item_id]
    );
    const labelIds = labelRows.rows.map((row) => String(row.label_id));
    const truthLinkId = stableId("gdtl", revisionId, String(member.batch_item_id));
    // Dataset receipt v1 has no governed-truth discriminator. Retain its
    // compatible dataset_claim shape, but make its status and authoritative
    // immutable evidence pointer explicit rather than implying this generic
    // projection proves governance by itself.
    const referenceProvenance = {
      kind: "dataset_claim",
      sourceId: truthLinkId,
      verdictIds: [],
      actorUserIds: [],
      basis: `Non-authoritative receipt-v1 compatibility projection. Authoritative governed provenance is governed_dataset_truth_links ${truthLinkId}.`
    };
    const payload = parseJson(member.review_payload_snapshot) as Record<string, unknown>;
    assertBlindProjectionSafe(payload);
    const itemDigest = datasetRevisionItemDigest({
      inputIdentity: { basis: "input-identity/v1", digest: String(member.input_digest) },
      redactedPayload: payload,
      referenceLabel: String(member.resolved_label),
      expectedFailStep: null,
      reviewProvenance: referenceProvenance,
      note: null
    });
    preparedItems.push({
      id: stableId("dsri", revisionId, String(member.batch_item_id)),
      batchItemId: String(member.batch_item_id),
      position: Number(member.draw_position),
      payload,
      inputDigest: String(member.input_digest),
      itemDigest,
      referenceLabel: member.resolved_label,
      referenceProvenance,
      truthLinkId,
      resolutionKind: member.resolution_kind,
      adjudicationId: member.adjudication_id ? String(member.adjudication_id) : null,
      labelIds
    });
  }
  const itemDigests = preparedItems.map((item) => item.itemDigest);
  const revisionContentDigest = datasetRevisionContentDigest(itemDigests);
  const revisionDigest = datasetRevisionDigest({ role: batch.role_intent, itemDigests });
  await client.query(
    `insert into dataset_revisions
       (id,project_id,series_id,revision_number,source_dataset_id,parent_revision_id,role,source_kind,
        identity_basis,content_digest,revision_digest,item_count,provenance_level,created_by_user_id,
        idempotency_key,criterion_version_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'input-identity/v1',$9,$10,$11,'governed_blind',$12,$13,$14)`,
    [revisionId, actor.projectId, seriesId, revisionNumber,
      batch.role_intent === "sealed_validation" ? null : sourceRevision?.source_dataset_id ?? null,
      parentRevisionId, batch.role_intent,
      batch.role_intent === "sealed_validation" ? "sealed_intake" : "collection_snapshot",
      revisionContentDigest, revisionDigest, preparedItems.length, actor.userId,
      `governed-freeze:${batch.id}`, batch.criterion_version_id]
  );
  for (const item of preparedItems) {
    await client.query(
      `insert into dataset_revision_items
         (id,revision_id,project_id,position,input_digest,item_digest,payload_snapshot,
          reference_label,reference_fail_step,reference_provenance,note)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,null,$9::jsonb,null)`,
      [item.id, revisionId, actor.projectId, item.position, item.inputDigest, item.itemDigest,
        JSON.stringify(item.payload), item.referenceLabel, JSON.stringify(item.referenceProvenance)]
    );
    const sourceKind = item.resolutionKind === "adjudicated" ? "adjudication" : "governed_labels";
    const truthLinkId = item.truthLinkId;
    const truthContent = {
      adjudicationId: item.adjudicationId,
      batchItemId: item.batchItemId,
      criterionVersionId: batch.criterion_version_id,
      datasetRevisionId: revisionId,
      datasetRevisionItemId: item.id,
      governedLabelIds: sourceKind === "governed_labels" ? item.labelIds : [],
      importedTruthId: null,
      resolutionKind: item.resolutionKind,
      resolvedLabel: item.referenceLabel,
      sourceKind,
      supportingLabelCount: item.labelIds.length
    };
    const truthDigest = await dbDigest(client, "governed-dataset-truth-link/v1", truthContent);
    await client.query(
      `insert into governed_dataset_truth_links
         (id,project_id,dataset_revision_id,dataset_revision_item_id,criterion_version_id,
          source_kind,batch_item_id,governed_label_ids,adjudication_id,imported_truth_id,
          resolution_kind,resolved_label,supporting_label_count,content_digest,idempotency_key,request_digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null,$10,$11,$12,$13,$14,$15)`,
      [truthLinkId, actor.projectId, revisionId, item.id, batch.criterion_version_id,
        sourceKind, item.batchItemId, sourceKind === "governed_labels" ? item.labelIds : [],
        item.adjudicationId, item.resolutionKind, item.referenceLabel, item.labelIds.length,
        truthDigest, `truth-link:${batch.id}:${item.batchItemId}`,
        governedReviewRequestDigest(truthContent)]
    );
    if (sourceKind === "governed_labels") {
      for (const labelId of item.labelIds) {
        await client.query(
          `insert into governed_dataset_truth_link_labels
             (project_id,truth_link_id,label_id) values ($1,$2,$3)`,
          [actor.projectId, truthLinkId, labelId]
        );
      }
    }
  }
  await client.query(
    `insert into dataset_exposure_events
       (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
        actor_user_id,evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key)
     values ($1,$2,$3,'created','lineage','revision_create','person',$4,$5,
             'governed_review_batch',$6,'Governed truth freeze',$7::jsonb,$8)`,
    [stableId("dse", revisionId, "created"), actor.projectId, revisionId, actorSubjectId,
      actor.userId, batch.id, JSON.stringify({ batchId: batch.id, evidenceClass: "governed_blind" }),
      `governed-freeze-created:${batch.id}`]
  );
  const drawMatches = String((await client.query(
    `select governed_review_draw_digest($1) as digest`, [batch.id]
  )).rows[0].digest) === String(batch.draw_digest);
  const hasCannotDetermine = Boolean((await client.query(
    `select 1 from governed_active_review_labels
     where batch_id=$1 and label='cannot_determine' limit 1`,
    [batch.id]
  )).rowCount);
  const incompleteTask = Boolean((await client.query(
    `select 1 from governed_review_tasks
     where batch_id=$1 and governed_review_current_task_state(id)<>'submitted' limit 1`,
    [batch.id]
  )).rowCount);
  const populationComplete = !isEmptyObject(parseJson(batch.population_definition)) &&
    !isEmptyObject(parseJson(batch.population_collection_provenance));
  const eligible = ["simple_random", "stratified_random"].includes(batch.selection_method) &&
    Boolean(batch.selection_seed) && Boolean(batch.rng_version) && drawMatches &&
    populationComplete && !hasCannotDetermine && !incompleteTask;
  const reasons = eligible ? [] : [
    ...(!["simple_random", "stratified_random"].includes(batch.selection_method)
      ? ["selection_method_not_representative"] : []),
    ...(!populationComplete ? ["population_provenance_incomplete"] : []),
    ...(!batch.selection_seed || !batch.rng_version || !drawMatches
      ? ["selection_or_draw_not_reproducible"] : []),
    ...(hasCannotDetermine ? ["cannot_determine_present"] : []),
    ...(incompleteTask ? ["review_coverage_incomplete"] : [])
  ];
  const eventId = stableId("grbe", batch.id, command.idempotencyKey);
  const details = {
    materializedItemCount: preparedItems.length,
    resolutionKinds: preparedItems.map((item) => item.resolutionKind)
  };
  const eventContent = {
    actorRoleAtReview: actor.projectRole,
    actorSubjectId,
    batchId: batch.id,
    datasetRevisionId: revisionId,
    details,
    eventKind: "frozen",
    previousEventDigest: state.digest,
    representativeIneligibleReasons: reasons,
    representativeOfPopulationId: eligible ? batch.population_id : null,
    sequence: state.version + 1,
    stateVersion: state.version + 1
  };
  const eventDigest = await dbDigest(client, "governed-review-batch-event/v1", eventContent);
  await client.query(
    `insert into governed_review_batch_events
       (id,project_id,batch_id,sequence,state_version,expected_previous_state_version,event_kind,
        actor_subject_id,actor_role_at_review,dataset_revision_id,representative_of_population_id,
        representative_ineligible_reasons,details,previous_event_digest,event_digest,
        idempotency_key,request_digest)
     values ($1,$2,$3,$4,$4,$5,'frozen',$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)`,
    [eventId, actor.projectId, batch.id, state.version + 1, state.version, actorSubjectId,
      actor.projectRole, revisionId, eligible ? batch.population_id : null, reasons,
      JSON.stringify(details), state.digest, eventDigest, command.idempotencyKey, requestDigest]
  );
  return loadBatchProjection(client, actor.projectId, batch.id);
}

function taskEventContent(input: {
  actorRoleAtReview: string;
  actorSubjectId: string;
  eventKind: string;
  taskId: string;
  sequence: number;
  previousEventDigest: string | null;
  labelId?: string | null;
  reason?: string | null;
  canonicalViewBytesBase64?: string | null;
  viewDigest?: string | null;
  viewContractVersion?: string | null;
  canonicalizationVersion?: string | null;
  exposureClass?: string | null;
  activity?: string | null;
}) {
  return {
    activity: input.activity ?? null,
    actorRoleAtReview: input.actorRoleAtReview,
    actorSubjectId: input.actorSubjectId,
    canonicalizationVersion: input.canonicalizationVersion ?? null,
    eventKind: input.eventKind,
    exposureClass: input.exposureClass ?? null,
    labelId: input.labelId ?? null,
    reason: input.reason ?? null,
    canonicalViewBytesBase64: input.canonicalViewBytesBase64 ?? null,
    previousEventDigest: input.previousEventDigest,
    sequence: input.sequence,
    stateVersion: input.sequence,
    taskId: input.taskId,
    viewContractVersion: input.viewContractVersion ?? null,
    viewDigest: input.viewDigest ?? null
  };
}

async function loadAdjudication(
  db: Db,
  row: Record<string, unknown>
): Promise<GovernedAdjudicationProjection> {
  const labels = await db.query(
    `select label_id from governed_review_adjudication_labels
     where adjudication_id=$1 order by label_id`, [row.id]
  );
  return {
    adjudicationId: String(row.id),
    batchId: String(row.batch_id),
    batchItemId: String(row.batch_item_id),
    chainVersion: Number(row.chain_version),
    predecessorAdjudicationId: row.supersedes_adjudication_id
      ? String(row.supersedes_adjudication_id)
      : null,
    decision: row.decision as GovernedAdjudicationProjection["decision"],
    rationale: String(row.rationale),
    basis: String(row.basis),
    correctionReason: row.correction_reason ? String(row.correction_reason) : null,
    consideredLabelIds: labels.rows.map((label) => String(label.label_id)),
    createdAt: iso(row.created_at)
  };
}

function rowToAlignment(row: Record<string, unknown>): GovernedAlignmentEventProjection {
  return {
    alignmentEventId: String(row.id),
    batchId: String(row.batch_id),
    sequence: Number(row.sequence),
    kind: row.event_kind as GovernedAlignmentEventProjection["kind"],
    content: String(row.content),
    proposedInstructionVersionId: row.proposed_instruction_version_id
      ? String(row.proposed_instruction_version_id)
      : null,
    visibleLabelCount: Number(row.visible_label_count),
    occurredAt: iso(row.occurred_at)
  };
}

function rowToImportedTruth(row: Record<string, unknown>): ImportedTruthProjection {
  const bytes = row.source_artifact_bytes as Buffer | Uint8Array;
  return {
    importedTruthId: String(row.id),
    criterionVersionId: String(row.criterion_version_id),
    issuer: String(row.issuer),
    subject: String(row.subject),
    sourceArtifactDigest: String(row.source_artifact_digest),
    sourceArtifactBytes: bytes.byteLength,
    verificationMethod: row.verification_method as ImportedTruthProjection["verificationMethod"],
    evidenceClass: row.evidence_class as ImportedTruthProjection["evidenceClass"],
    inputDigest: String(row.input_digest),
    label: row.label as ImportedTruthProjection["label"],
    rationale: String(row.rationale),
    failureCodes: asStringArray(row.failure_codes),
    provenanceDigest: String(row.provenance_digest),
    contentDigest: String(row.content_digest),
    importedAt: iso(row.imported_at)
  };
}

function rowToInstruction(row: Record<string, unknown>): GovernedReviewInstructionProjection {
  return {
    instructionVersionId: String(row.id),
    criterionVersionId: String(row.criterion_version_id),
    revision: Number(row.revision),
    predecessorInstructionVersionId: row.predecessor_instruction_version_id
      ? String(row.predecessor_instruction_version_id)
      : null,
    title: String(row.title),
    instructions: String(row.instructions),
    failureCodeGuidance: String(row.failure_code_guidance),
    allowedLabels: [...ALLOWED_LABELS],
    instructionDigest: String(row.content_digest),
    createdAt: iso(row.created_at)
  };
}

function rowToIntake(row: Record<string, unknown>): GovernedSealedIntakeReceipt {
  const definition = parseJson(row.population_definition) as { definition?: unknown };
  return {
    intakeId: String(row.id),
    protection: "sealed",
    populationDefinition: typeof definition.definition === "string"
      ? definition.definition
      : "Protected sealed intake",
    itemCount: Number(row.frame_count),
    frameDigest: String(row.frame_digest),
    predecessorRevisionId: row.predecessor_revision_id ? String(row.predecessor_revision_id) : null,
    createdAt: iso(row.created_at)
  };
}

async function ensureSubject(
  client: PoolClient,
  projectId: string,
  userId: string
): Promise<{ id: string }> {
  const member = await client.query(
    `select 1 from project_members where project_id=$1 and user_id=$2`, [projectId, userId]
  );
  if (!member.rowCount) throw new GovernedReviewForbiddenError("The actor is not a project member");
  const id = governedSubjectId(projectId, userId);
  await client.query(
    `insert into governed_reviewer_subjects (id,project_id,account_user_id,subject_digest)
     values ($1,$2,$3,governed_content_v1_digest(
       'governed-reviewer-subject/v1',jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
     )) on conflict (project_id,account_user_id) where account_user_id is not null do nothing`,
    [id, projectId, userId]
  );
  const row = (await client.query(
    `select id from governed_reviewer_subjects
     where project_id=$1 and account_user_id=$2`, [projectId, userId]
  )).rows[0];
  if (!row) throw new GovernedReviewForbiddenError();
  return { id: String(row.id) };
}

function governedSubjectId(projectId: string, userId: string): string {
  return stableId("grs", projectId, userId);
}

async function resolveSubjectId(db: Db, projectId: string, userId: string): Promise<string | null> {
  const row = (await db.query(
    `select subject.id
     from governed_reviewer_subjects subject
     where subject.project_id=$1 and subject.account_user_id=$2`,
    [projectId, userId]
  )).rows[0];
  return row?.id ? String(row.id) : null;
}

function requireOwnerActor(actor: GovernedReviewActor, action: string): void {
  if (actor.projectRole !== "owner") {
    throw new GovernedReviewForbiddenError(`Only project owners may ${action}`);
  }
}

function sealedItemId(intakeId: string, clientItemId: string): string {
  return stableId("gri", intakeId, "sealed-client-item", clientItemId);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 48)}`;
}

async function dbDigest(db: Db, kind: string, content: unknown): Promise<string> {
  const applicationDigest = governedContentV1Digest(kind, content);
  const row = (await db.query(
    `select governed_content_v1_digest($1,$2::jsonb) as digest`,
    [kind, JSON.stringify(content)]
  )).rows[0];
  const databaseDigest = String(row.digest);
  if (databaseDigest !== applicationDigest) {
    throw new Error(`governed content canonicalization mismatch for ${kind}`);
  }
  return applicationDigest;
}

async function normalizedTimestamp(db: Db, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const row = (await db.query(`select to_jsonb($1::timestamptz) as value`, [value])).rows[0];
  return String(row.value);
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertReplay(existing: unknown, candidate: string): void {
  if (String(existing) !== candidate) throw new GovernedReviewIdempotencyConflictError();
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function isEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function isPgError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

function mapPgError(error: unknown): Error {
  if (error instanceof Error && error.name.startsWith("GovernedReview")) return error;
  const message = error instanceof Error ? error.message : "Governed review persistence failed";
  if (message.includes("overlap") || message.includes("sealed successor")) {
    return new GovernedReviewSealedOverlapError();
  }
  if (message.includes("missing or ineligible") || message.includes("cannot pass sealed")) {
    return new GovernedReviewSeparationIneligibleError();
  }
  if (message.includes("unknown historical") || message.includes("separation is missing")) {
    return new GovernedReviewSeparationUnknownError();
  }
  if (message.includes("revealed") && message.includes("withdraw")) {
    return new GovernedReviewLabelAlreadyRevealedError();
  }
  if (isPgError(error, "40001")) {
    return new GovernedReviewConflictError(
      "governed_review_stream_conflict",
      "The governed review stream changed before this transaction committed"
    );
  }
  if (isPgError(error, "23505")) return new GovernedReviewIdempotencyConflictError();
  if (isPgError(error, "55000") || isPgError(error, "23514")) {
    return new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The governed review transition failed a persistence invariant"
    );
  }
  return error instanceof Error ? error : new Error(message);
}
