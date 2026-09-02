import type { Pool, PoolClient } from "pg";

import { datasetInputIdentity } from "../lib/dataset-revision.js";
import { governedReviewRequestDigest } from "../lib/governed-review.js";
import type {
  CreateGovernedReviewBatchInput,
  CreateGovernedReviewInstructionInput,
  CreateSealedReviewIntakeInput,
  GovernedReviewBatchProjection,
  GovernedReviewInstructionProjection,
  GovernedReviewListQuery,
  GovernedReviewSubjectProjection,
  GovernedReviewStreamCommand,
  GovernedSealedIntakeReceipt
} from "./contracts.js";
import {
  GovernedReviewConflictError,
  GovernedReviewForbiddenError,
  GovernedReviewIdempotencyConflictError,
  GovernedReviewNotFoundError,
  GovernedReviewSealedOverlapError,
  GovernedReviewSeparationIneligibleError,
  GovernedReviewSeparationUnknownError,
  GovernedReviewStreamConflictError,
  GovernedReviewTransitionConflictError
} from "./errors.js";
import { projectGovernedReviewPayload } from "./projection.js";
import type { GovernedBatchAction, GovernedReviewActor } from "./repository.js";
import { executeGovernedReviewSelection } from "./selection.js";

import {
  ALLOWED_LABELS,
  assertReplay,
  dbDigest,
  ensureSubject,
  mapPgError,
  normalizedTimestamp,
  requireOwnerActor,
  rowToInstruction,
  rowToIntake,
  sealedItemId,
  stableId
} from "./repository.pg-common.js";
import {
  assertBatchBlindViewsWithinLimit,
  preparePromotionFrame,
  prepareRevisionFrame,
  prepareSealedFrame,
  translateSelection
} from "./repository.pg-frame-support.js";
import {
  appendCapabilityChecks,
  batchEventDetails,
  contentExposedSubjects,
  currentBatchState,
  deriveBatchEventKind,
  loadBatchProjection,
  lockBatch,
  materializeFrozenTruth,
  observeBatchEventClock
} from "./repository.pg-stream-support.js";

export class PgGovernedReviewAdministrationRepository {
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
