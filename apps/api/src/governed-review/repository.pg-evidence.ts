import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "../lib/assessment-receipt.js";

import { datasetInputIdentity } from "../lib/dataset-revision.js";
import { governedReviewRequestDigest } from "../lib/governed-review.js";
import type {
  AppendGovernedReviewAdjudicationInput,
  AppendGovernedReviewAlignmentEventInput,
  CreateImportedTruthInput,
  GovernedAdjudicationProjection,
  GovernedAlignmentEventProjection,
  GovernedPostBarrierItemProjection,
  GovernedReviewerTaskProjection,
  GovernedTaskMutationProjection,
  ImportedTruthListQuery,
  ImportedTruthProjection
} from "./contracts.js";
import {
  GovernedImportedTruthVerificationUnavailableError,
  GovernedReviewConflictError,
  GovernedReviewForbiddenError,
  GovernedReviewLabelAlreadyRevealedError,
  GovernedReviewNotFoundError,
  GovernedReviewSeparationIneligibleError,
  GovernedReviewSeparationUnknownError,
  GovernedReviewStreamConflictError,
  GovernedReviewTransitionConflictError
} from "./errors.js";
import { assertBlindProjectionSafe, projectGovernedReviewPayload } from "./projection.js";
import type {
  GovernedBlindTaskViewArtifact,
  GovernedReviewActor,
  GovernedTaskAction
} from "./repository.js";

import {
  INTERNAL_VIEW_IDEMPOTENCY_KEY,
  asStringArray,
  assertReplay,
  dbDigest,
  ensureSubject,
  isPgError,
  jsonParam,
  loadAdjudication,
  mapPgError,
  parseJson,
  requireOwnerActor,
  resolveSubjectId,
  rowToAlignment,
  rowToImportedTruth,
  sha256Bytes,
  stableId,
  taskEventContent
} from "./repository.pg-common.js";
import { buildBlindTaskViewArtifact } from "./repository.pg-frame-support.js";
import {
  appendCapabilityChecks,
  currentBatchState,
  currentTaskState,
  loadTaskMutation,
  lockBatch,
  readTaskStateWithoutScope,
  rowToTaskProjection
} from "./repository.pg-stream-support.js";

export class PgGovernedReviewEvidenceRepository {
  constructor(private readonly pool: Pool) {}

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
