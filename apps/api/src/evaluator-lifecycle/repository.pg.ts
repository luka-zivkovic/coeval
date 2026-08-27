import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  EVALUATOR_LIFECYCLE_CONTRACT_VERSION,
  EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,
  EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,
  EvaluatorCandidateCreateResultSchema,
  EvaluatorLifecycleEventSchema,
  EvaluatorLifecycleProjectionSchema,
  MinimumVerdictOutputSchema,
  SkillSchema,
  SkillVersionSchema,
  type DatasetReferenceProvenance,
  type DatasetRevisionPayloadSnapshot,
  type EvaluatorCandidateCreateInput,
  type EvaluatorCandidateCreateResult,
  type EvaluatorLifecycleActivateInput,
  type EvaluatorLifecycleArtifact,
  type EvaluatorLifecycleEvent,
  type EvaluatorLifecycleListPage,
  type EvaluatorLifecycleProjection,
  type EvaluatorLifecycleRetireInput,
  type EvaluatorLifecycleTransitionResult,
  type Skill
} from "@coeval/shared";
import {
  evaluatorCandidateRequestDigest,
  evaluatorExecutionAuthorizationDigest,
  evaluatorLifecycleContentDigest,
  evaluatorLifecycleDigest,
  evaluatorLifecycleEventContentDigest
} from "../lib/evaluator-lifecycle.js";
import {
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest
} from "../lib/dataset-revision.js";
import {
  EvaluatorLifecycleRepositoryError,
  type EvaluatorExecutionAuthorizationInput,
  type EvaluatorLifecycleAccess,
  type EvaluatorLifecyclePageInput,
  type EvaluatorLifecycleRepository
} from "./repository.js";

interface CandidateContextRow extends Record<string, unknown> {
  promotion_id: unknown;
  batch_digest: unknown;
  truth_revision_digest: unknown;
  truth_content_digest: unknown;
  truth_item_count: unknown;
}

interface PreparedRegressionItem {
  id: string;
  position: number;
  inputDigest: string;
  itemDigest: string;
  payload: DatasetRevisionPayloadSnapshot;
  referenceLabel: "pass" | "fail";
  referenceProvenance: DatasetReferenceProvenance;
}

export class PgEvaluatorLifecycleRepository implements EvaluatorLifecycleRepository {
  constructor(private readonly pool: Pool) {}

  async createCandidate(
    actor: EvaluatorLifecycleAccess,
    input: EvaluatorCandidateCreateInput
  ): Promise<EvaluatorCandidateCreateResult> {
    requireOwner(actor);
    const requestDigest = evaluatorCandidateRequestDigest(actor.projectId, input);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set constraints all deferred");
      const prior = await lifecycleByIdempotency(client, actor.projectId, input.idempotencyKey);
      if (prior) {
        if (String(prior.request_digest) !== requestDigest) throw repoError("idempotency_conflict", "Candidate idempotency key was already used for different semantics");
        const result = await loadCandidateResult(client, actor.projectId, String(prior.skill_version_id), true);
        await client.query("commit");
        return result;
      }

      const criterion = (await client.query(
        `select criterion.id,criterion.source_kind,
                definition.id as criterion_version_id,definition.criterion_digest
         from criteria criterion
         join criterion_versions definition on definition.criterion_id=criterion.id
           and definition.project_id=criterion.project_id
         where criterion.id=$1 and criterion.project_id=$2 and definition.id=$3
         for update of criterion,definition`,
        [input.criterionId, actor.projectId, input.criterionVersionId]
      )).rows[0];
      if (!criterion || criterion.source_kind !== "analysis_promotion") {
        throw repoError("candidate_provenance_conflict", "Candidate creation requires an exact analysis-promotion criterion definition");
      }
      const replayAfterLock = await lifecycleByIdempotency(client, actor.projectId, input.idempotencyKey);
      if (replayAfterLock) {
        if (String(replayAfterLock.request_digest) !== requestDigest) throw repoError("idempotency_conflict", "Candidate idempotency key was already used for different semantics");
        const result = await loadCandidateResult(client, actor.projectId, String(replayAfterLock.skill_version_id), true);
        await client.query("commit");
        return result;
      }

      const subjectId = await ensureOwnerSubject(client, actor);
      const context = await loadCandidateContext(client, actor.projectId, input);
      assertCandidateContext(context, input);
      const truthItems = await loadTruthItems(client, actor.projectId, input.truthDatasetRevisionId);
      if (truthItems.length !== Number(context.truth_item_count) || truthItems.length === 0) {
        throw repoError("truth_conflict", "Frozen candidate truth must contain at least one completely resolved pass/fail item");
      }

      const lifecycleId = `elc_${randomUUID()}`;
      const skillVersionId = `skillv_${randomUUID()}`;
      const existingSkill = (await client.query(
        `select * from skills where project_id=$1 and criterion_id=$2 for update`,
        [actor.projectId, input.criterionId]
      )).rows[0];
      const skillId = existingSkill ? String(existingSkill.id) : `skill_${randomUUID()}`;
      if (!existingSkill) {
        await client.query(
          `insert into skills
             (id,project_id,name,description,owner_user_id,status,is_starter,criterion_id)
           values ($1,$2,$3,$4,$5,'calibrating',false,$6)`,
          [skillId, actor.projectId, input.skillName, input.skillDescription, actor.userId, input.criterionId]
        );
      } else if (String(existingSkill.name) !== input.skillName || String(existingSkill.description) !== input.skillDescription) {
        throw repoError("candidate_provenance_conflict", "Existing governed evaluator lineage has different immutable skill identity text");
      }

      const preparedItems = truthItems.map((row, position): PreparedRegressionItem => {
        const payload = parseJson(row.payload_snapshot) as DatasetRevisionPayloadSnapshot;
        const referenceLabel = row.reference_label === "fail" ? "fail" : "pass";
        const referenceProvenance: DatasetReferenceProvenance = {
          kind: "dataset_claim",
          sourceId: String(row.truth_link_id),
          verdictIds: [],
          actorUserIds: [],
          basis: "Governed nonsealed truth copied into an immutable known-failure regression snapshot; not sealed calibration evidence."
        };
        const itemDigest = datasetRevisionItemDigest({
          inputIdentity: { basis: "input-identity/v1", digest: String(row.input_digest) },
          redactedPayload: payload,
          referenceLabel,
          expectedFailStep: null,
          reviewProvenance: referenceProvenance,
          note: null
        });
        return {
          id: `dsri_${randomUUID()}`,
          position,
          inputDigest: String(row.input_digest),
          itemDigest,
          payload,
          referenceLabel,
          referenceProvenance
        };
      });
      const itemDigests = preparedItems.map((item) => item.itemDigest);
      const regressionContentDigest = datasetRevisionContentDigest(itemDigests);
      const regressionRevisionDigest = datasetRevisionDigest({ role: "regression_golden", itemDigests });
      const regressionRevisionId = `dsr_${randomUUID()}`;
      const seriesId = `candidate-regression:${actor.projectId}:${input.criterionVersionId}`;
      const priorRevision = (await client.query(
        `select id,revision_number from dataset_revisions
         where project_id=$1 and series_id=$2 order by revision_number desc,id desc limit 1`,
        [actor.projectId, seriesId]
      )).rows[0];
      await client.query(
        `insert into dataset_revisions
           (id,project_id,series_id,revision_number,source_dataset_id,parent_revision_id,role,source_kind,
            identity_basis,content_digest,revision_digest,item_count,provenance_level,created_by_user_id,
            idempotency_key,criterion_version_id)
         values ($1,$2,$3,$4,null,$5,'regression_golden','golden_snapshot','input-identity/v1',
                 $6,$7,$8,'governed_blind',$9,$10,$11)`,
        [regressionRevisionId, actor.projectId, seriesId, Number(priorRevision?.revision_number ?? 0) + 1,
          priorRevision ? String(priorRevision.id) : null, regressionContentDigest, regressionRevisionDigest,
          preparedItems.length, actor.userId, `candidate-regression:${lifecycleId}`, input.criterionVersionId]
      );
      for (const item of preparedItems) {
        await client.query(
          `insert into dataset_revision_items
             (id,revision_id,project_id,position,input_digest,item_digest,payload_snapshot,
              reference_label,reference_fail_step,reference_provenance,note)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,null,$9::jsonb,null)`,
          [item.id, regressionRevisionId, actor.projectId, item.position, item.inputDigest, item.itemDigest,
            JSON.stringify(item.payload), item.referenceLabel, JSON.stringify(item.referenceProvenance)]
        );
      }
      await client.query(
        `insert into criterion_regression_revisions(project_id,criterion_version_id,revision_id)
         values ($1,$2,$3)
         on conflict (project_id,criterion_version_id) do update
         set revision_id=excluded.revision_id,updated_at=clock_timestamp()`,
        [actor.projectId, input.criterionVersionId, regressionRevisionId]
      );

      const versionNumber = Number((await client.query(
        `select count(*)::int as count from skill_versions where project_id=$1 and skill_id=$2`,
        [actor.projectId, skillId]
      )).rows[0]?.count ?? 0) + 1;
      await client.query(
        `insert into skill_versions
           (id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,model_binding,
            golden_set_agreement,too_strict_count,too_lenient_count,ambiguous_count,known_limitations,
            verdict_kind,scalar_range,categorical_choice_scores,rubric_provenance,
            regression_dataset_revision_id,created_at,approved_at,criterion_version_id,
            created_by_user_id,created_by_subject_id,developer_identity_status)
         values ($1,$2,$3,$4,'calibrating',$5,$6,$7::jsonb,$8::jsonb,
                 null,0,0,0,'{}','binary',null,null,'human-authored',$9,
                 date_trunc('milliseconds',clock_timestamp()),null,$10,$11,$12,'recorded')`,
        [skillVersionId, skillId, actor.projectId, `${versionNumber}.0.0`, input.rubricMarkdown, input.prompt,
          JSON.stringify(input.outputSchema ?? MinimumVerdictOutputSchema), JSON.stringify(input.modelBinding),
          regressionRevisionId, input.criterionVersionId, actor.userId, subjectId]
      );

      const developerExposureEventId = `dse_${randomUUID()}`;
      await client.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,actor_user_id,
            evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key)
         values ($1,$2,$3,'human_access','development','rubric_authoring','person',$4,$5,
                 'evaluator_lifecycle',$6,'Candidate evaluator authored from governed nonsealed truth',
                 $7::jsonb,$8)`,
        [developerExposureEventId, actor.projectId, input.truthDatasetRevisionId, subjectId, actor.userId,
          lifecycleId, JSON.stringify({ criterionId: input.criterionId, skillVersionId }),
          `candidate-authoring:${lifecycleId}`]
      );

      const artifactWithoutDigest: Omit<EvaluatorLifecycleArtifact, "contentDigest" | "createdAt"> = {
        id: lifecycleId,
        contractVersion: EVALUATOR_LIFECYCLE_CONTRACT_VERSION,
        projectId: actor.projectId,
        criterionId: input.criterionId,
        criterionVersionId: input.criterionVersionId,
        skillId,
        skillVersionId,
        promotionId: String(context.promotion_id),
        governedBatchId: input.governedBatchId,
        governedBatchDigest: input.expectedBatchDigest,
        truthDatasetRevisionId: input.truthDatasetRevisionId,
        truthRevisionDigest: input.expectedTruthRevisionDigest,
        truthContentDigest: input.expectedTruthContentDigest,
        truthItemCount: truthItems.length,
        regressionDatasetRevisionId: regressionRevisionId,
        regressionRevisionDigest,
        regressionContentDigest,
        regressionItemCount: preparedItems.length,
        developerExposureEventId,
        createdByUserId: actor.userId,
        createdBySubjectId: subjectId,
        idempotencyKey: input.idempotencyKey,
        requestDigest
      };
      const lifecycleContentDigest = evaluatorLifecycleContentDigest(artifactWithoutDigest);
      await client.query(
        `insert into evaluator_lifecycles
           (id,contract_version,project_id,criterion_id,criterion_version_id,skill_id,skill_version_id,
            promotion_id,governed_batch_id,governed_batch_digest,truth_dataset_revision_id,
            truth_revision_digest,truth_content_digest,truth_item_count,regression_dataset_revision_id,
            regression_revision_digest,regression_content_digest,regression_item_count,
            developer_exposure_event_id,created_by_user_id,created_by_subject_id,idempotency_key,
            request_digest,content_digest)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [lifecycleId, EVALUATOR_LIFECYCLE_CONTRACT_VERSION, actor.projectId, input.criterionId,
          input.criterionVersionId, skillId, skillVersionId, context.promotion_id, input.governedBatchId,
          input.expectedBatchDigest, input.truthDatasetRevisionId, input.expectedTruthRevisionDigest,
          input.expectedTruthContentDigest, truthItems.length, regressionRevisionId,
          regressionRevisionDigest, regressionContentDigest, preparedItems.length,
          developerExposureEventId, actor.userId, subjectId, input.idempotencyKey,
          requestDigest, lifecycleContentDigest]
      );

      const seedId = `elce_${randomUUID()}`;
      const seedRequestDigest = evaluatorLifecycleDigest({
        basis: "evaluator-lifecycle-candidate-created-request/v1",
        lifecycleId,
        skillVersionId
      });
      const seedWithoutDigest: Omit<EvaluatorLifecycleEvent, "contentDigest" | "occurredAt"> = {
        id: seedId,
        contractVersion: EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,
        lifecycleId,
        projectId: actor.projectId,
        criterionId: input.criterionId,
        skillVersionId,
        sequence: "1",
        transition: "candidate_created",
        state: "candidate",
        predecessorEventId: null,
        predecessorEventDigest: null,
        activationBundleId: null,
        activationEvidence: null,
        replacedSkillVersionId: null,
        actorUserId: actor.userId,
        actorSubjectId: subjectId,
        actorRole: "owner",
        reason: "Candidate created from exact frozen governed nonsealed truth.",
        idempotencyKey: `candidate-created:${lifecycleId}`,
        requestDigest: seedRequestDigest
      };
      await insertLifecycleEvent(client, seedWithoutDigest);
      await client.query("commit");
      return await this.loadCandidateResultAfterCommit(actor.projectId, skillVersionId, false);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw mapError(error);
    } finally {
      client.release();
    }
  }

  async getLifecycle(
    access: Pick<EvaluatorLifecycleAccess, "projectId">,
    skillVersionId: string
  ): Promise<EvaluatorLifecycleProjection | null> {
    return loadProjection(this.pool, access.projectId, skillVersionId);
  }

  async listLifecycles(
    access: Pick<EvaluatorLifecycleAccess, "projectId">,
    input: EvaluatorLifecyclePageInput
  ): Promise<EvaluatorLifecycleListPage> {
    const cursor = input.cursor === null ? null : decodeLifecycleCursor(input.cursor);
    const result = await this.pool.query(
      `select skill_version_id,id,
              to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
       from evaluator_lifecycles
       where project_id=$1
         and ($2::timestamptz is null or (created_at,id)<($2::timestamptz,$3::text))
       order by created_at desc,id desc limit $4`,
      [access.projectId, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1]
    );
    const pageRows = result.rows.slice(0, input.limit);
    const items: EvaluatorLifecycleProjection[] = [];
    for (const row of pageRows) {
      const projection = await loadProjection(this.pool, access.projectId, String(row.skill_version_id));
      if (projection) items.push(projection);
    }
    const last = pageRows.at(-1);
    const nextCursor = result.rows.length > input.limit && last
      ? encodeLifecycleCursor({ createdAt: String(last.cursor_created_at), id: String(last.id) })
      : null;
    const totalCount = String((await this.pool.query(
      `select count(*)::text as total_count from evaluator_lifecycles where project_id=$1`,
      [access.projectId]
    )).rows[0]?.total_count ?? "0");
    return { items, nextCursor, totalCount };
  }

  async activate(
    actor: EvaluatorLifecycleAccess,
    skillVersionId: string,
    input: EvaluatorLifecycleActivateInput
  ): Promise<EvaluatorLifecycleTransitionResult> {
    requireOwner(actor);
    return this.appendOwnerTransition(actor, skillVersionId, input, "activated");
  }

  async retire(
    actor: EvaluatorLifecycleAccess,
    skillVersionId: string,
    input: EvaluatorLifecycleRetireInput
  ): Promise<EvaluatorLifecycleTransitionResult> {
    requireOwner(actor);
    return this.appendOwnerTransition(actor, skillVersionId, input, "retired");
  }

  async authorizeExecution(input: EvaluatorExecutionAuthorizationInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = (await client.query(
        `select lifecycle.id as lifecycle_id,head.id as event_id,head.calibration_artifact_id
         from skill_versions version
         left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
         left join lateral evaluator_lifecycle_head_v1(lifecycle.id) head on true
         where version.project_id=$1 and version.id=$2`,
        [input.projectId, input.skillVersionId]
      )).rows[0];
      if (!current) throw repoError("not_found", "Evaluator version not found");
      const contentDigest = evaluatorExecutionAuthorizationDigest({
        projectId: input.projectId,
        skillVersionId: input.skillVersionId,
        context: input.context,
        lifecycleEventId: current.event_id ? String(current.event_id) : null,
        calibrationArtifactId: current.calibration_artifact_id ? String(current.calibration_artifact_id) : null,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId
      });
      const authorization = await client.query(
        `insert into evaluator_execution_authorizations
           (id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,
            calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (project_id,idempotency_key)
         do nothing
         returning content_digest`,
        [`eauth_${randomUUID()}`, EVALUATOR_EXECUTION_AUTHORIZATION_VERSION, input.projectId,
          input.skillVersionId, input.context, current.event_id ?? null,
          current.calibration_artifact_id ?? null, input.resourceKind, input.resourceId,
          input.idempotencyKey, contentDigest]
      );
      const persistedDigest = authorization.rows[0]?.content_digest ?? (await client.query(
        `select content_digest from evaluator_execution_authorizations
         where project_id=$1 and idempotency_key=$2`,
        [input.projectId,input.idempotencyKey]
      )).rows[0]?.content_digest;
      if (String(persistedDigest ?? "") !== contentDigest) {
        throw repoError("idempotency_conflict", "Execution authorization idempotency key was reused");
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw mapError(error, "execution_forbidden");
    } finally {
      client.release();
    }
  }

  private async appendOwnerTransition(
    actor: EvaluatorLifecycleAccess,
    skillVersionId: string,
    input: EvaluatorLifecycleActivateInput | EvaluatorLifecycleRetireInput,
    transition: "activated" | "retired"
  ): Promise<EvaluatorLifecycleTransitionResult> {
    const { idempotencyKey: _idempotencyKey, ...semanticInput } = input;
    const requestDigest = evaluatorLifecycleDigest({
      basis: `evaluator-lifecycle-${transition}-request/v1`,
      projectId: actor.projectId,
      skillVersionId,
      ...semanticInput
    });
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set constraints all deferred");
      const existing = await eventByIdempotency(client, actor.projectId, input.idempotencyKey);
      if (existing) {
        if (String(existing.request_digest) !== requestDigest) throw repoError("idempotency_conflict", "Lifecycle transition idempotency key was reused");
        const result = await loadTransitionResult(client, actor.projectId, existing, true);
        await client.query("commit");
        return result;
      }
      const lifecycle = (await client.query(
        `select * from evaluator_lifecycles where project_id=$1 and skill_version_id=$2`,
        [actor.projectId, skillVersionId]
      )).rows[0];
      if (!lifecycle) throw repoError("not_found", "Evaluator lifecycle not found");
      await client.query(`select id from criteria where project_id=$1 and id=$2 for update`, [actor.projectId, lifecycle.criterion_id]);
      const afterLock = await eventByIdempotency(client, actor.projectId, input.idempotencyKey);
      if (afterLock) {
        if (String(afterLock.request_digest) !== requestDigest) throw repoError("idempotency_conflict", "Lifecycle transition idempotency key was reused");
        const result = await loadTransitionResult(client, actor.projectId, afterLock, true);
        await client.query("commit");
        return result;
      }
      const subjectId = await ensureOwnerSubject(client, actor);
      const head = await lifecycleHead(client, String(lifecycle.id));
      if (!head || String(head.state) !== input.expectedState || String(head.sequence) !== input.expectedSequence ||
          String(head.id) !== input.expectedEventId || String(head.content_digest) !== input.expectedEventDigest) {
        throw repoError("state_conflict", "Evaluator lifecycle head changed before the transition");
      }
      const bundleId = transition === "activated" ? `elab_${randomUUID()}` : null;
      let replacedEvent: EvaluatorLifecycleEvent | null = null;
      if (transition === "activated") {
        const activation = input as EvaluatorLifecycleActivateInput;
        const active = (await client.query(
          `select other.*,other_head.id as head_id,other_head.sequence as head_sequence,
                  other_head.content_digest as head_digest,other_head.state as head_state
           from evaluator_lifecycles other
           cross join lateral evaluator_lifecycle_head_v1(other.id) other_head
           where other.project_id=$1 and other.criterion_id=$2 and other_head.state='active'
             and other.skill_version_id<>$3`,
          [actor.projectId, lifecycle.criterion_id, skillVersionId]
        )).rows[0];
        if (active) {
          if (activation.expectedPriorActiveSkillVersionId !== String(active.skill_version_id) ||
              activation.expectedPriorActiveEventId !== String(active.head_id) ||
              activation.expectedPriorActiveEventDigest !== String(active.head_digest)) {
            throw repoError("prior_active_conflict", "Activation must name the exact current prior active evaluator");
          }
          const retireId = `elce_${randomUUID()}`;
          const retireWithoutDigest: Omit<EvaluatorLifecycleEvent, "contentDigest" | "occurredAt"> = {
            id: retireId,
            contractVersion: EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,
            lifecycleId: String(active.id),
            projectId: actor.projectId,
            criterionId: String(active.criterion_id),
            skillVersionId: String(active.skill_version_id),
            sequence: String(BigInt(String(active.head_sequence)) + 1n),
            transition: "retired",
            state: "retired",
            predecessorEventId: String(active.head_id),
            predecessorEventDigest: String(active.head_digest),
            activationBundleId: bundleId,
            activationEvidence: null,
            replacedSkillVersionId: null,
            actorUserId: actor.userId,
            actorSubjectId: subjectId,
            actorRole: "owner",
            reason: `Replaced by activated evaluator ${skillVersionId}.`,
            idempotencyKey: `activation-replacement:${bundleId}`,
            requestDigest,
          };
          replacedEvent = await insertLifecycleEvent(client, retireWithoutDigest);
        } else if (activation.expectedPriorActiveSkillVersionId !== null || activation.expectedPriorActiveEventId !== null || activation.expectedPriorActiveEventDigest !== null) {
          throw repoError("prior_active_conflict", "Activation expected a prior active evaluator but none exists");
        }
      }
      const eventId = `elce_${randomUUID()}`;
      const activation = transition === "activated" ? input as EvaluatorLifecycleActivateInput : null;
      const eventWithoutDigest: Omit<EvaluatorLifecycleEvent, "contentDigest" | "occurredAt"> = {
        id: eventId,
        contractVersion: EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,
        lifecycleId: String(lifecycle.id),
        projectId: actor.projectId,
        criterionId: String(lifecycle.criterion_id),
        skillVersionId,
        sequence: String(BigInt(String(head.sequence)) + 1n),
        transition,
        state: transition === "activated" ? "active" : "retired",
        predecessorEventId: String(head.id),
        predecessorEventDigest: String(head.content_digest),
        activationBundleId: bundleId,
        activationEvidence: activation ? {
          calibrationArtifactId: activation.calibrationArtifactId,
          calibrationArtifactDigest: activation.expectedCalibrationArtifactDigest,
          calibrationEvidenceDigest: activation.expectedCalibrationEvidenceDigest,
          regressionRunId: activation.regressionRunId,
          regressionDatasetRevisionId: String(lifecycle.regression_dataset_revision_id)
        } : null,
        replacedSkillVersionId: transition === "activated" ? (input as EvaluatorLifecycleActivateInput).expectedPriorActiveSkillVersionId : null,
        actorUserId: actor.userId,
        actorSubjectId: subjectId,
        actorRole: "owner",
        reason: input.rationale,
        idempotencyKey: input.idempotencyKey,
        requestDigest
      };
      const event = await insertLifecycleEvent(client, eventWithoutDigest);
      await client.query("commit");
      const projection = await loadProjection(this.pool, actor.projectId, skillVersionId);
      if (!projection) throw new Error("Lifecycle vanished after transition");
      return { projection, event, replacedEvent, replayed: false };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw mapError(error);
    } finally {
      client.release();
    }
  }

  private async loadCandidateResultAfterCommit(
    projectId: string,
    skillVersionId: string,
    replayed: boolean
  ): Promise<EvaluatorCandidateCreateResult> {
    const client = await this.pool.connect();
    try {
      return await loadCandidateResult(client, projectId, skillVersionId, replayed);
    } finally {
      client.release();
    }
  }
}

async function loadCandidateContext(
  client: PoolClient,
  projectId: string,
  input: EvaluatorCandidateCreateInput
): Promise<CandidateContextRow> {
  const row = (await client.query(
    `select promotion.id as promotion_id,batch.content_digest as batch_digest,
            truth.revision_digest as truth_revision_digest,truth.content_digest as truth_content_digest,
            truth.item_count as truth_item_count
     from analysis_criterion_promotions promotion
     join governed_review_batches batch on batch.id=$3 and batch.project_id=promotion.project_id
       and batch.criterion_version_id=promotion.criterion_version_id
       and batch.role_intent in ('analysis_authoring','iterative_development')
     join governed_review_batch_states state on state.batch_id=batch.id and state.state='frozen'
     join governed_review_batch_events frozen on frozen.batch_id=batch.id and frozen.event_kind='frozen'
       and frozen.dataset_revision_id=$4
     join dataset_revisions truth on truth.id=frozen.dataset_revision_id
       and truth.project_id=batch.project_id and truth.criterion_version_id=batch.criterion_version_id
       and truth.role in ('analysis_authoring','iterative_development') and truth.provenance_level='governed_blind'
     where promotion.project_id=$1 and promotion.criterion_id=$2
       and promotion.criterion_version_id=$5`,
    [projectId, input.criterionId, input.governedBatchId, input.truthDatasetRevisionId, input.criterionVersionId]
  )).rows[0];
  if (!row) throw repoError("candidate_provenance_conflict", "Candidate source batch is not exact frozen governed nonsealed truth for the promoted criterion");
  return row as CandidateContextRow;
}

function assertCandidateContext(context: CandidateContextRow, input: EvaluatorCandidateCreateInput): void {
  if (String(context.batch_digest) !== input.expectedBatchDigest) throw repoError("candidate_provenance_conflict", "Governed batch digest changed");
  if (String(context.truth_revision_digest) !== input.expectedTruthRevisionDigest ||
      String(context.truth_content_digest) !== input.expectedTruthContentDigest) {
    throw repoError("truth_conflict", "Frozen truth revision digest does not match the request");
  }
  if (Number(context.truth_item_count) < 1) throw repoError("truth_conflict", "Frozen truth revision is empty");
}

async function loadTruthItems(client: PoolClient, projectId: string, revisionId: string): Promise<Record<string, unknown>[]> {
  return (await client.query(
    `select item.*,link.id as truth_link_id
     from dataset_revision_items item
     join governed_dataset_truth_links link on link.dataset_revision_item_id=item.id
       and link.dataset_revision_id=item.revision_id and link.project_id=item.project_id
       and link.resolved_label=item.reference_label
     where item.project_id=$1 and item.revision_id=$2 and item.reference_label in ('pass','fail')
     order by item.position,item.id`,
    [projectId, revisionId]
  )).rows;
}

async function ensureOwnerSubject(client: PoolClient, actor: EvaluatorLifecycleAccess): Promise<string> {
  const account = (await client.query(
    `select 1 from project_members where project_id=$1 and user_id=$2 and role='owner'`,
    [actor.projectId, actor.userId]
  )).rows[0];
  if (!account) throw repoError("forbidden", "Only a current project owner may change evaluator lifecycle");
  const existing = (await client.query(
    `select id from governed_reviewer_subjects where project_id=$1 and account_user_id=$2`,
    [actor.projectId, actor.userId]
  )).rows[0];
  if (existing) return String(existing.id);
  const subjectId = `grs_${createHash("sha256").update(`${actor.projectId}\0${actor.userId}`).digest("hex").slice(0,48)}`;
  await client.query(
    `insert into governed_reviewer_subjects(id,project_id,account_user_id,subject_digest)
     values ($1,$2,$3,governed_content_v1_digest('governed-reviewer-subject/v1',
       jsonb_build_object('projectId',$2::text,'subjectId',$1::text)))
     on conflict do nothing`,
    [subjectId, actor.projectId, actor.userId]
  );
  const subject = (await client.query(
    `select id from governed_reviewer_subjects where id=$1 and project_id=$2 and account_user_id=$3`,
    [subjectId, actor.projectId, actor.userId]
  )).rows[0];
  if (!subject) throw repoError("forbidden", "Owner durable subject is unavailable");
  return subjectId;
}

async function lifecycleByIdempotency(client: PoolClient, projectId: string, key: string): Promise<Record<string, unknown> | null> {
  return (await client.query(`select * from evaluator_lifecycles where project_id=$1 and idempotency_key=$2`, [projectId,key])).rows[0] ?? null;
}

async function eventByIdempotency(client: PoolClient, projectId: string, key: string): Promise<Record<string, unknown> | null> {
  return (await client.query(`select * from evaluator_lifecycle_events where project_id=$1 and idempotency_key=$2`, [projectId,key])).rows[0] ?? null;
}

async function lifecycleHead(client: PoolClient, lifecycleId: string): Promise<Record<string, unknown> | null> {
  return (await client.query(`select * from evaluator_lifecycle_head_v1($1)`, [lifecycleId])).rows[0] ?? null;
}

async function insertLifecycleEvent(
  client: PoolClient,
  event: Omit<EvaluatorLifecycleEvent, "contentDigest" | "occurredAt">
): Promise<EvaluatorLifecycleEvent> {
  const contentDigest = evaluatorLifecycleEventContentDigest(event);
  const activation = event.activationEvidence;
  const row = (await client.query(
    `insert into evaluator_lifecycle_events
       (id,contract_version,lifecycle_id,project_id,criterion_id,skill_version_id,sequence,
        transition,state,predecessor_event_id,predecessor_event_digest,activation_bundle_id,
        calibration_artifact_id,calibration_artifact_digest,calibration_evidence_digest,
        regression_run_id,regression_dataset_revision_id,replaced_skill_version_id,
        actor_user_id,actor_subject_id,actor_role,reason,idempotency_key,request_digest,content_digest)
     values ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     returning *`,
    [event.id,event.contractVersion,event.lifecycleId,event.projectId,event.criterionId,event.skillVersionId,
      event.sequence,event.transition,event.state,event.predecessorEventId,event.predecessorEventDigest,
      event.activationBundleId,activation?.calibrationArtifactId ?? null,activation?.calibrationArtifactDigest ?? null,
      activation?.calibrationEvidenceDigest ?? null,activation?.regressionRunId ?? null,
      activation?.regressionDatasetRevisionId ?? null,event.replacedSkillVersionId,event.actorUserId,
      event.actorSubjectId,event.actorRole,event.reason,event.idempotencyKey,event.requestDigest,contentDigest]
  )).rows[0];
  return rowToEvent(row);
}

async function loadCandidateResult(
  db: Pool | PoolClient,
  projectId: string,
  skillVersionId: string,
  replayed: boolean
): Promise<EvaluatorCandidateCreateResult> {
  const skill = await loadSkill(db, projectId, skillVersionId);
  const projection = await loadProjection(db, projectId, skillVersionId);
  if (!skill || !projection) throw new Error("Candidate lifecycle result vanished");
  return EvaluatorCandidateCreateResultSchema.parse({ skill, projection, replayed });
}

async function loadSkill(db: Pool | PoolClient, projectId: string, skillVersionId: string): Promise<Skill | null> {
  const row = (await db.query(
    `select skill.*,
            case head.state
              when 'candidate' then 'calibrating'
              when 'active' then 'production'
              when 'needs_review' then 'needs_review'
              when 'retired' then 'deprecated'
              else skill.status
            end as status,
            account.name as owner_name,account.email as owner_email,
            version.id as version_id,version.criterion_version_id as version_criterion_version_id,
            version.version,
            case head.state
              when 'candidate' then 'calibrating'
              when 'active' then 'production'
              when 'needs_review' then 'needs_review'
              when 'retired' then 'deprecated'
              else version.status
            end as version_status,
            version.rubric_markdown,version.prompt,
            version.model_binding,version.output_schema,version.golden_set_agreement,
            version.too_strict_count,version.too_lenient_count,version.ambiguous_count,
            version.known_limitations,version.verdict_kind,version.scalar_range,
            version.categorical_choice_scores,version.rubric_provenance,
            version.regression_dataset_revision_id,version.created_at as version_created_at,version.approved_at
     from skill_versions version
     join skills skill on skill.id=version.skill_id and skill.project_id=version.project_id
     left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
     left join lateral evaluator_lifecycle_head_v1(lifecycle.id) head on true
     left join "user" account on account.id=skill.owner_user_id
     where version.project_id=$1 and version.id=$2`,
    [projectId, skillVersionId]
  )).rows[0];
  if (!row) return null;
  const version = SkillVersionSchema.parse({
    id: String(row.version_id),
    skillId: String(row.id),
    criterionVersionId: String(row.version_criterion_version_id),
    version: String(row.version),
    status: row.version_status,
    rubricMarkdown: String(row.rubric_markdown),
    prompt: String(row.prompt),
    modelBinding: parseJson(row.model_binding),
    outputSchema: parseJson(row.output_schema),
    goldenSetAgreement: row.golden_set_agreement == null ? null : Number(row.golden_set_agreement),
    tooStrictCount: Number(row.too_strict_count ?? 0),
    tooLenientCount: Number(row.too_lenient_count ?? 0),
    ambiguousCount: Number(row.ambiguous_count ?? 0),
    knownLimitations: Array.isArray(row.known_limitations) ? row.known_limitations.map(String) : [],
    verdictKind: row.verdict_kind,
    scalarRange: row.scalar_range == null ? null : parseJson(row.scalar_range),
    categoricalChoiceScores: row.categorical_choice_scores == null ? null : parseJson(row.categorical_choice_scores),
    rubricProvenance: row.rubric_provenance,
    regressionDatasetRevisionId: row.regression_dataset_revision_id,
    createdAt: toIso(row.version_created_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null
  });
  return SkillSchema.parse({
    id: String(row.id),
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    name: String(row.name),
    description: String(row.description),
    ownerName: String(row.owner_name ?? row.owner_email ?? row.owner_user_id ?? "Owner"),
    status: row.status,
    isStarter: row.is_starter === true,
    currentVersion: version
  });
}

async function loadProjection(
  db: Pool | PoolClient,
  projectId: string,
  skillVersionId: string
): Promise<EvaluatorLifecycleProjection | null> {
  const row = (await db.query(
    `select lifecycle.*,head.id as event_id,head.contract_version as event_contract_version,
            head.sequence as event_sequence,head.transition,head.state,head.predecessor_event_id,
            head.predecessor_event_digest,head.activation_bundle_id,head.calibration_artifact_id,
            head.calibration_artifact_digest,head.calibration_evidence_digest,head.regression_run_id,
            head.regression_dataset_revision_id as event_regression_revision_id,
            head.replaced_skill_version_id,head.actor_user_id,head.actor_subject_id,head.actor_role,
            head.reason as event_reason,head.idempotency_key as event_idempotency_key,
            head.request_digest as event_request_digest,head.content_digest as event_content_digest,
            head.occurred_at as event_occurred_at,
            evaluator_lifecycle_calibration_admissibility_v1(lifecycle.skill_version_id) as admissibility
     from evaluator_lifecycles lifecycle
     cross join lateral evaluator_lifecycle_head_v1(lifecycle.id) head
     where lifecycle.project_id=$1 and lifecycle.skill_version_id=$2`,
    [projectId, skillVersionId]
  )).rows[0];
  if (!row) return null;
  const currentEvent = rowToEventFromProjection(row);
  const admissibility = String(row.admissibility) as EvaluatorLifecycleProjection["currentCalibrationAdmissibility"];
  const reasons: EvaluatorLifecycleProjection["implicitDenialReasons"] = [];
  if (currentEvent.state !== "active") reasons.push("not_active");
  if (currentEvent.state === "active" && admissibility === "revoked") reasons.push("calibration_revoked");
  if (currentEvent.state === "active" && admissibility === "unknown") reasons.push("calibration_status_unknown");
  if (currentEvent.state === "active" && currentEvent.activationEvidence === null) reasons.push("activation_evidence_mismatch");
  const projection = {
    lifecycle: rowToLifecycle(row),
    currentEvent,
    currentCalibrationAdmissibility: admissibility,
    implicitExecutionAllowed: currentEvent.state === "active" && admissibility === "admissible" && reasons.length === 0,
    implicitDenialReasons: reasons
  };
  return EvaluatorLifecycleProjectionSchema.parse(projection);
}

function rowToLifecycle(row: Record<string, unknown>): EvaluatorLifecycleArtifact {
  return {
    id: String(row.id),
    contractVersion: EVALUATOR_LIFECYCLE_CONTRACT_VERSION,
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    skillId: String(row.skill_id),
    skillVersionId: String(row.skill_version_id),
    promotionId: String(row.promotion_id),
    governedBatchId: String(row.governed_batch_id),
    governedBatchDigest: String(row.governed_batch_digest),
    truthDatasetRevisionId: String(row.truth_dataset_revision_id),
    truthRevisionDigest: String(row.truth_revision_digest),
    truthContentDigest: String(row.truth_content_digest),
    truthItemCount: Number(row.truth_item_count),
    regressionDatasetRevisionId: String(row.regression_dataset_revision_id),
    regressionRevisionDigest: String(row.regression_revision_digest),
    regressionContentDigest: String(row.regression_content_digest),
    regressionItemCount: Number(row.regression_item_count),
    developerExposureEventId: String(row.developer_exposure_event_id),
    createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest),
    createdAt: toIso(row.created_at)
  };
}

function rowToEvent(row: Record<string, unknown>): EvaluatorLifecycleEvent {
  return EvaluatorLifecycleEventSchema.parse({
    id: String(row.id),
    contractVersion: EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,
    lifecycleId: String(row.lifecycle_id),
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    skillVersionId: String(row.skill_version_id),
    sequence: String(row.sequence),
    transition: row.transition,
    state: row.state,
    predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest),
    activationBundleId: nullableString(row.activation_bundle_id),
    activationEvidence: row.calibration_artifact_id ? {
      calibrationArtifactId: String(row.calibration_artifact_id),
      calibrationArtifactDigest: String(row.calibration_artifact_digest),
      calibrationEvidenceDigest: String(row.calibration_evidence_digest),
      regressionRunId: String(row.regression_run_id),
      regressionDatasetRevisionId: String(row.regression_dataset_revision_id)
    } : null,
    replacedSkillVersionId: nullableString(row.replaced_skill_version_id),
    actorUserId: nullableString(row.actor_user_id),
    actorSubjectId: nullableString(row.actor_subject_id),
    actorRole: row.actor_role,
    reason: String(row.reason),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest),
    occurredAt: toIso(row.occurred_at)
  });
}

function rowToEventFromProjection(row: Record<string, unknown>): EvaluatorLifecycleEvent {
  return rowToEvent({
    id: row.event_id,
    contract_version: row.event_contract_version,
    lifecycle_id: row.id,
    project_id: row.project_id,
    criterion_id: row.criterion_id,
    skill_version_id: row.skill_version_id,
    sequence: row.event_sequence,
    transition: row.transition,
    state: row.state,
    predecessor_event_id: row.predecessor_event_id,
    predecessor_event_digest: row.predecessor_event_digest,
    activation_bundle_id: row.activation_bundle_id,
    calibration_artifact_id: row.calibration_artifact_id,
    calibration_artifact_digest: row.calibration_artifact_digest,
    calibration_evidence_digest: row.calibration_evidence_digest,
    regression_run_id: row.regression_run_id,
    regression_dataset_revision_id: row.event_regression_revision_id,
    replaced_skill_version_id: row.replaced_skill_version_id,
    actor_user_id: row.actor_user_id,
    actor_subject_id: row.actor_subject_id,
    actor_role: row.actor_role,
    reason: row.event_reason,
    idempotency_key: row.event_idempotency_key,
    request_digest: row.event_request_digest,
    content_digest: row.event_content_digest,
    occurred_at: row.event_occurred_at
  });
}

async function loadTransitionResult(
  db: Pool | PoolClient,
  projectId: string,
  eventRow: Record<string, unknown>,
  replayed: boolean
): Promise<EvaluatorLifecycleTransitionResult> {
  const event = rowToEvent(eventRow);
  const projection = await loadProjection(db, projectId, event.skillVersionId);
  if (!projection) throw new Error("Lifecycle transition projection vanished");
  let replacedEvent: EvaluatorLifecycleEvent | null = null;
  if (event.activationBundleId) {
    const row = (await db.query(
      `select * from evaluator_lifecycle_events where project_id=$1 and activation_bundle_id=$2
       and id<>$3 order by sequence desc limit 1`,
      [projectId, event.activationBundleId, event.id]
    )).rows[0];
    if (row) replacedEvent = rowToEvent(row);
  }
  return { projection, event, replacedEvent, replayed };
}

function requireOwner(actor: EvaluatorLifecycleAccess): void {
  if (actor.projectRole !== "owner") throw repoError("forbidden", "Only project owners may change evaluator lifecycle");
}

function repoError(code: ConstructorParameters<typeof EvaluatorLifecycleRepositoryError>[0], message: string): EvaluatorLifecycleRepositoryError {
  return new EvaluatorLifecycleRepositoryError(code, message);
}

function mapError(error: unknown, fallback: ConstructorParameters<typeof EvaluatorLifecycleRepositoryError>[0] = "state_conflict"): unknown {
  if (error instanceof EvaluatorLifecycleRepositoryError) return error;
  if (isPgError(error, "23505")) return repoError("idempotency_conflict", "Evaluator lifecycle command conflicts with existing immutable evidence");
  if (isPgError(error, "23514") || isPgError(error, "40001") || isPgError(error, "55000")) {
    return repoError(fallback, error instanceof Error ? error.message : "Evaluator lifecycle evidence conflict");
  }
  return error;
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

interface LifecycleCursor {
  createdAt: string;
  id: string;
}

function encodeLifecycleCursor(cursor: LifecycleCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeLifecycleCursor(value: string): LifecycleCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.createdAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.createdAt) ||
        !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" ||
        parsed.id.length < 1 || parsed.id.length > 240 || Object.keys(parsed).length !== 3) {
      throw new Error("invalid lifecycle cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw repoError("invalid_cursor", "Invalid evaluator lifecycle cursor");
  }
}
