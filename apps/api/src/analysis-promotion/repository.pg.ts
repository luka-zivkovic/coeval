import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
  ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
  type AnalysisCriterionPromotionArtifact,
  type AnalysisCriterionPromotionCandidate,
  type AnalysisCriterionPromotionCandidatesPage,
  type AnalysisCriterionPromotionCreateInput,
  type AnalysisCriterionPromotionCreateResult,
  type AnalysisCriterionPromotionDetail,
  type AnalysisCriterionPromotionHandoff,
  type AnalysisCriterionPromotionSummariesPage,
  type AnalysisCriterionPromotionSummary,
  type AnalysisCriterionPromotionSupportArtifact,
  type AnalysisCriterionPromotionSupportsPage,
  type Criterion,
  type CriterionVersion
} from "@coeval/shared";
import {
  analysisCriterionPromotionContentDigest,
  analysisCriterionPromotionHandoffDigest,
  analysisCriterionPromotionRequestDigest,
  analysisCriterionPromotionStableKey,
  analysisCriterionPromotionSupportContentDigest,
  analysisCriterionPromotionSupportSetDigest,
  canonicalizeAnalysisCriterionPromotionSupports,
  decideAnalysisCriterionPromotionCommand
} from "../lib/analysis-promotion.js";
import { evaluatorSuiteCriterionDigest } from "../lib/evaluator-suite.js";
import {
  AnalysisPromotionRepositoryError,
  type AnalysisPromotionAccess,
  type AnalysisPromotionActor,
  type AnalysisPromotionCandidatePageInput,
  type AnalysisPromotionPageInput,
  type AnalysisPromotionRepository
} from "./repository.js";

interface PromotionContext {
  studyId: string;
  state: string;
  populationId: string;
  drawId: string;
  sourceDatasetRevisionId: string;
  sourceDatasetRevisionContentDigest: string;
  sourceDatasetRevisionDigest: string;
  closureId: string;
  closureDigest: string;
  taxonomyId: string;
  taxonomyRevisionId: string;
  taxonomyRevisionSequence: number;
  taxonomyRevisionDigest: string;
  codeId: string;
  codeEntryId: string;
  codeEntryDigest: string;
  codeLabel: string;
  codeDefinition: string;
  codeStatus: string;
  isTaxonomyHead: boolean;
}

interface CandidateEvidenceRow {
  study_item_id: unknown;
  closure_item_id: unknown;
  closure_item_digest: unknown;
  position: unknown;
  source_dataset_revision_item_id: unknown;
  source_item_digest: unknown;
  observation_event_id: unknown;
  observation_event_digest: unknown;
  failure_label: unknown;
  observation_rationale: unknown;
  anchor_kind: unknown;
  anchor_step_index: unknown;
  observation_author_user_id: unknown;
  observation_author_subject_id: unknown;
  assignment_event_id: unknown;
  assignment_event_digest: unknown;
  assignment_rationale: unknown;
}

export class PgAnalysisPromotionRepository implements AnalysisPromotionRepository {
  constructor(private readonly pool: Pool) {}

  async createPromotion(
    actor: AnalysisPromotionActor,
    input: AnalysisCriterionPromotionCreateInput
  ): Promise<AnalysisCriterionPromotionCreateResult> {
    if (actor.projectRole !== "owner") {
      throw repoError("analysis_promotion_forbidden", "Only project owners may promote analysis codes");
    }
    const requestDigest = analysisCriterionPromotionRequestDigest(actor.projectId, input);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set constraints all deferred");
      const subjectId = await ensureOwnerSubject(client, actor);

      const initial = await findExistingCommand(client, actor.projectId, input.idempotencyKey, input.codeId);
      const initialDecision = decideAnalysisCriterionPromotionCommand({
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        ...initial
      });
      if (initialDecision.kind === "replay") {
        const replay = await loadCreateResult(client, actor.projectId, initialDecision.promotionId, true);
        await client.query("commit");
        return replay;
      }
      if (initialDecision.kind === "conflict") throw commandConflict(initialDecision.code);

      await assertOwnedLockTarget(client, actor.projectId, input.studyId, input.taxonomyId);
      await client.query(`select analysis_study_lock_v1($1)`, [input.studyId]);
      await client.query(`select analysis_taxonomy_lock_v1($1)`, [input.taxonomyId]);

      const locked = await findExistingCommand(client, actor.projectId, input.idempotencyKey, input.codeId);
      const lockedDecision = decideAnalysisCriterionPromotionCommand({
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        ...locked
      });
      if (lockedDecision.kind === "replay") {
        const replay = await loadCreateResult(client, actor.projectId, lockedDecision.promotionId, true);
        await client.query("commit");
        return replay;
      }
      if (lockedDecision.kind === "conflict") throw commandConflict(lockedDecision.code);

      const context = await loadPromotionContext(client, actor.projectId, input);
      assertPromotionContext(context, input);
      const canonicalInputs = canonicalizeAnalysisCriterionPromotionSupports(input.supportingObservations);
      const evidenceRows = await loadCandidateEvidence(
        client,
        actor.projectId,
        context,
        canonicalInputs.map((support) => support.observationEventId)
      );
      const evidenceByObservation = new Map(
        evidenceRows.map((row) => [String(row.observation_event_id), row])
      );
      if (evidenceByObservation.size !== canonicalInputs.length) {
        throw repoError(
          "analysis_promotion_support_conflict",
          "Every promotion support must be an active closed-study observation assigned to the named code"
        );
      }

      const promotionId = stableId("aprom", actor.projectId, input.codeId);
      const criterionId = stableId("criterion", promotionId);
      const criterionVersionId = stableId("criterionv", promotionId, "1");
      const criterionStableKey = analysisCriterionPromotionStableKey(input.codeId);
      const criterionDigest = evaluatorSuiteCriterionDigest({
        criterionId,
        criterionVersionId,
        criterionName: input.criterionName,
        criterionDefinition: input.criterionDefinition
      });
      const criterionAuthoringExposureEventId = stableId("dse", promotionId, "criterion-authoring");

      const supports = canonicalInputs.map((requested, position) => {
        const evidence = evidenceByObservation.get(requested.observationEventId);
        if (!evidence || !requestedSupportMatchesEvidence(requested, evidence)) {
          throw repoError(
            "analysis_promotion_support_conflict",
            "Promotion support no longer matches the frozen closure and assignment evidence"
          );
        }
        const supportId = stableId("aproms", promotionId, requested.observationEventId);
        const exampleSelectionExposureEventId = stableId("dse", promotionId, supportId, "example-selection");
        const content = {
          promotionId,
          position,
          studyId: context.studyId,
          studyItemId: String(evidence.study_item_id),
          closureId: context.closureId,
          closureItemId: String(evidence.closure_item_id),
          closureItemDigest: String(evidence.closure_item_digest),
          sourceDatasetRevisionId: context.sourceDatasetRevisionId,
          sourceDatasetRevisionItemId: String(evidence.source_dataset_revision_item_id),
          sourceItemDigest: String(evidence.source_item_digest),
          observationEventId: String(evidence.observation_event_id),
          observationEventDigest: String(evidence.observation_event_digest),
          assignmentEventId: String(evidence.assignment_event_id),
          assignmentEventDigest: String(evidence.assignment_event_digest),
          observationAuthorSubjectId: String(evidence.observation_author_subject_id),
          exampleSelectionExposureEventId
        };
        return {
          id: supportId,
          observationAuthorUserId: String(evidence.observation_author_user_id),
          artifact: {
            id: supportId,
            projectId: actor.projectId,
            ...content,
            contentDigest: analysisCriterionPromotionSupportContentDigest(content),
            createdAt: "1970-01-01T00:00:00.000Z"
          } satisfies AnalysisCriterionPromotionSupportArtifact
        };
      });
      const supportSetDigest = analysisCriterionPromotionSupportSetDigest(
        promotionId,
        supports.map(({ artifact }) => artifact)
      );
      const handoffWithoutDigest: Omit<AnalysisCriterionPromotionHandoff, "handoffDigest"> = {
        handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
        promotionId,
        projectId: actor.projectId,
        criterionId,
        criterionVersionId,
        criterionDigest,
        sourceDatasetRevisionId: context.sourceDatasetRevisionId,
        sourceDatasetRevisionContentDigest: context.sourceDatasetRevisionContentDigest,
        sourceDatasetRevisionDigest: context.sourceDatasetRevisionDigest,
        roleIntent: "analysis_authoring",
        sourceKind: "analysis_promotion_handoff",
        evidenceClass: "development_authoring_not_truth",
        createsTruth: false,
        createsEvaluator: false
      };
      const handoffDigest = analysisCriterionPromotionHandoffDigest(handoffWithoutDigest);
      const promotionContent = {
        contractVersion: ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
        projectId: actor.projectId,
        studyId: context.studyId,
        studyClosureId: context.closureId,
        studyClosureDigest: context.closureDigest,
        populationId: context.populationId,
        drawId: context.drawId,
        sourceDatasetRevisionId: context.sourceDatasetRevisionId,
        sourceDatasetRevisionContentDigest: context.sourceDatasetRevisionContentDigest,
        sourceDatasetRevisionDigest: context.sourceDatasetRevisionDigest,
        taxonomyId: context.taxonomyId,
        taxonomyRevisionId: context.taxonomyRevisionId,
        taxonomyRevisionSequence: context.taxonomyRevisionSequence,
        taxonomyRevisionDigest: context.taxonomyRevisionDigest,
        codeId: context.codeId,
        codeEntryId: context.codeEntryId,
        codeEntryDigest: context.codeEntryDigest,
        codeLabel: context.codeLabel,
        codeDefinition: context.codeDefinition,
        criterionId,
        criterionVersionId,
        criterionStableKey,
        criterionName: input.criterionName,
        criterionDefinition: input.criterionDefinition,
        criterionDigest,
        rationale: input.rationale,
        supportCount: supports.length,
        supportSetDigest,
        criterionAuthoringExposureEventId,
        promotedBySubjectId: subjectId,
        handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
        handoffDigest
      } as const;
      const contentDigest = analysisCriterionPromotionContentDigest(promotionContent);

      const inserted = (await client.query(
        `insert into analysis_criterion_promotions
          (id,project_id,contract_version,study_id,study_closure_id,study_closure_digest,
           population_id,draw_id,source_dataset_revision_id,source_dataset_revision_content_digest,
           source_dataset_revision_digest,taxonomy_id,taxonomy_revision_id,taxonomy_revision_sequence,
           taxonomy_revision_digest,code_id,code_entry_id,code_entry_digest,code_label,code_definition,
           criterion_id,criterion_version_id,criterion_stable_key,criterion_name,criterion_definition,
           criterion_digest,rationale,support_count,support_set_digest,criterion_authoring_exposure_event_id,
           promoted_by_user_id,promoted_by_subject_id,promoter_role,idempotency_key,request_digest,
           content_digest,handoff_version,handoff_digest)
         values
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
           $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,'owner',$33,$34,$35,$36,$37)
         returning created_at`,
        [promotionId, actor.projectId, ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
          context.studyId, context.closureId, context.closureDigest, context.populationId,
          context.drawId, context.sourceDatasetRevisionId, context.sourceDatasetRevisionContentDigest,
          context.sourceDatasetRevisionDigest, context.taxonomyId, context.taxonomyRevisionId,
          context.taxonomyRevisionSequence, context.taxonomyRevisionDigest, context.codeId,
          context.codeEntryId, context.codeEntryDigest, context.codeLabel, context.codeDefinition,
          criterionId, criterionVersionId, criterionStableKey, input.criterionName,
          input.criterionDefinition, criterionDigest, input.rationale, supports.length,
          supportSetDigest, criterionAuthoringExposureEventId, actor.userId, subjectId,
          input.idempotencyKey, requestDigest, contentDigest,
          ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION, handoffDigest]
      )).rows[0];
      const createdAt = inserted.created_at;

      await client.query(
        `insert into criteria
          (id,project_id,stable_key,source_kind,created_by_user_id,created_at)
         values ($1,$2,$3,'analysis_promotion',$4,$5)`,
        [criterionId, actor.projectId, criterionStableKey, actor.userId, createdAt]
      );
      await client.query(
        `insert into criterion_versions
          (id,project_id,criterion_id,revision,name,definition,criterion_digest,
           source_kind,created_by_user_id,created_at)
         values ($1,$2,$3,1,$4,$5,$6,'analysis_promotion',$7,$8)`,
        [criterionVersionId, actor.projectId, criterionId, input.criterionName,
          input.criterionDefinition, criterionDigest, actor.userId, createdAt]
      );

      for (const support of supports) {
        const value = support.artifact;
        await client.query(
          `insert into analysis_criterion_promotion_supports
            (id,project_id,promotion_id,position,study_id,study_item_id,closure_id,
             closure_item_id,closure_item_digest,source_dataset_revision_id,
             source_dataset_revision_item_id,source_item_digest,observation_event_id,
             observation_event_digest,assignment_event_id,assignment_event_digest,
             observation_author_user_id,observation_author_subject_id,
             example_selection_exposure_event_id,content_digest)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [value.id, actor.projectId, promotionId, value.position, value.studyId,
            value.studyItemId, value.closureId, value.closureItemId, value.closureItemDigest,
            value.sourceDatasetRevisionId, value.sourceDatasetRevisionItemId, value.sourceItemDigest,
            value.observationEventId, value.observationEventDigest, value.assignmentEventId,
            value.assignmentEventDigest, support.observationAuthorUserId,
            value.observationAuthorSubjectId, value.exampleSelectionExposureEventId,
            value.contentDigest]
        );
      }

      await insertCriterionExposure(client, {
        promotionId,
        projectId: actor.projectId,
        revisionId: context.sourceDatasetRevisionId,
        exposureId: criterionAuthoringExposureEventId,
        subjectId,
        actorUserId: actor.userId
      });
      for (const support of supports) {
        await insertSupportExposure(client, {
          promotionId,
          projectId: actor.projectId,
          revisionId: context.sourceDatasetRevisionId,
          revisionItemId: support.artifact.sourceDatasetRevisionItemId,
          supportId: support.id,
          exposureId: support.artifact.exampleSelectionExposureEventId,
          subjectId: support.artifact.observationAuthorSubjectId,
          actorUserId: actor.userId
        });
      }

      await client.query("commit");
      return loadCreateResult(this.pool, actor.projectId, promotionId, false);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }

  async listPromotions(
    access: AnalysisPromotionAccess,
    studyId: string,
    page: AnalysisPromotionPageInput
  ): Promise<AnalysisCriterionPromotionSummariesPage> {
    const cursor = decodeTimestampCursor(page.cursor);
    const result = await this.pool.query(
      `${promotionSummarySelect()}
       where promotion.project_id=$1 and promotion.study_id=$2
         and ($3::timestamptz is null or
           (promotion.created_at,promotion.id) < ($3::timestamptz,$4::text))
       order by promotion.created_at desc,promotion.id desc limit $5`,
      [access.projectId, studyId, cursor?.createdAt ?? null, cursor?.id ?? null, page.limit + 1]
    );
    const total = await this.pool.query(
      `select count(*)::text as total from analysis_criterion_promotions
       where project_id=$1 and study_id=$2`,
      [access.projectId, studyId]
    );
    const hasMore = result.rows.length > page.limit;
    const rows = result.rows.slice(0, page.limit);
    return {
      items: rows.map(rowToSummary),
      totalCount: String(total.rows[0]?.total ?? "0"),
      nextCursor: hasMore && rows.length > 0
        ? encodeCursor({ v: 1, kind: "promotion", createdAt: String(rows.at(-1)!.cursor_created_at), id: String(rows.at(-1)!.promotion_id) })
        : null
    };
  }

  async listCandidates(
    access: AnalysisPromotionAccess,
    input: AnalysisPromotionCandidatePageInput
  ): Promise<AnalysisCriterionPromotionCandidatesPage> {
    const cursor = decodePositionCursor(input.cursor, "candidate");
    const result = await this.pool.query(
      `with candidates as (
         select study.project_id,study.id as study_id,
                analysis_study_state_v1(study.id) as study_state,
                closure.id as closure_id,closure.closure_digest,
                taxonomy.id as taxonomy_id,revision.id as taxonomy_revision_id,
                revision.sequence as taxonomy_revision_sequence,revision.revision_digest as taxonomy_revision_digest,
                entry.code_id,entry.id as code_entry_id,entry.entry_digest as code_entry_digest,
                entry.label as code_label,entry.definition as code_definition,entry.status as code_status,
                item.id as study_item_id,closure_item.id as closure_item_id,
                closure_item.content_digest as closure_item_digest,closure_item.position,
                study.dataset_revision_id as source_dataset_revision_id,
                source_item.id as source_dataset_revision_item_id,source_item.item_digest as source_item_digest,
                observation.id as observation_event_id,observation.event_digest as observation_event_digest,
                observation.failure_label,observation.rationale as observation_rationale,
                observation.anchor_kind,observation.anchor_step_index,
                assignment.id as assignment_event_id,assignment.event_digest as assignment_event_digest,
                assignment.rationale as assignment_rationale,observation.actor_subject_id as observation_author_subject_id
         from analysis_studies study
         join analysis_study_closures closure on closure.study_id=study.id and closure.project_id=study.project_id
         join analysis_study_closure_items closure_item
           on closure_item.closure_id=closure.id and closure_item.project_id=study.project_id
         join analysis_study_items item on item.id=closure_item.study_item_id and item.project_id=study.project_id
         join dataset_revision_items source_item
           on source_item.id=item.revision_item_id and source_item.revision_id=study.dataset_revision_id
         cross join lateral generate_subscripts(closure_item.active_failure_observation_event_ids,1) slot
         join analysis_study_item_events observation
           on observation.id=closure_item.active_failure_observation_event_ids[slot]
          and observation.event_digest=closure_item.active_failure_observation_event_digests[slot]
         join analysis_observation_assignment_events assignment
           on assignment.id=closure_item.active_failure_assignment_event_ids[slot]
          and assignment.event_digest=closure_item.active_failure_assignment_event_digests[slot]
         join analysis_failure_taxonomies taxonomy on taxonomy.project_id=study.project_id
         join analysis_failure_taxonomy_revisions revision
           on revision.id=$3 and revision.taxonomy_id=taxonomy.id and revision.project_id=study.project_id
         join analysis_failure_taxonomy_revision_codes entry
           on entry.taxonomy_revision_id=revision.id and entry.code_id=$4 and entry.project_id=study.project_id
         join lateral analysis_observation_assignment_head_v1(observation.id,revision.sequence) head
           on head.assignment_event_id=assignment.id and head.assignment_event_type='assigned'
          and head.taxonomy_id=taxonomy.id and head.code_id=entry.code_id
         where study.project_id=$1 and study.id=$2
           and analysis_study_state_v1(study.id) in ('coding_closed','completed')
           and entry.status='active'
           and not exists (select 1 from analysis_failure_taxonomy_revisions successor
                           where successor.predecessor_revision_id=revision.id)
       ), paged as (
         select * from candidates
         where ($5::integer is null or (position,observation_event_id)>($5::integer,$6::text))
         order by position,observation_event_id limit $7
       ), totals as (
         select count(*)::text as total_count from candidates
       )
       select paged.*,totals.total_count from totals left join paged on true
       order by paged.position,paged.observation_event_id`,
      [access.projectId, input.studyId, input.taxonomyRevisionId, input.codeId,
        cursor?.position ?? null, cursor?.id ?? null, input.limit + 1]
    );
    const candidateRows = result.rows.filter((row) => row.observation_event_id !== null);
    const hasMore = candidateRows.length > input.limit;
    const rows = candidateRows.slice(0, input.limit);
    return {
      items: rows.map(rowToCandidate),
      totalCount: String(result.rows[0]?.total_count ?? "0"),
      nextCursor: hasMore && rows.length > 0
        ? encodeCursor({ v: 1, kind: "candidate", position: Number(rows.at(-1)!.position), id: String(rows.at(-1)!.observation_event_id) })
        : null
    };
  }

  async getPromotion(
    access: AnalysisPromotionAccess,
    promotionId: string
  ): Promise<AnalysisCriterionPromotionDetail | null> {
    const row = (await this.pool.query(
      `${promotionSummarySelect()} where promotion.project_id=$1 and promotion.id=$2`,
      [access.projectId, promotionId]
    )).rows[0];
    return row ? rowToSummary(row) : null;
  }

  async listSupports(
    access: AnalysisPromotionAccess,
    promotionId: string,
    page: AnalysisPromotionPageInput
  ): Promise<AnalysisCriterionPromotionSupportsPage | null> {
    const exists = await this.pool.query(
      `select support_count from analysis_criterion_promotions where project_id=$1 and id=$2`,
      [access.projectId, promotionId]
    );
    if (!exists.rows[0]) return null;
    const cursor = decodePositionCursor(page.cursor, "support");
    const result = await this.pool.query(
      `select * from analysis_criterion_promotion_supports
       where project_id=$1 and promotion_id=$2
         and ($3::integer is null or (position,id)>($3::integer,$4::text))
       order by position,id limit $5`,
      [access.projectId, promotionId, cursor?.position ?? null, cursor?.id ?? null, page.limit + 1]
    );
    const hasMore = result.rows.length > page.limit;
    const rows = result.rows.slice(0, page.limit);
    return {
      items: rows.map(rowToSupport),
      totalCount: Number(exists.rows[0].support_count),
      nextCursor: hasMore && rows.length > 0
        ? encodeCursor({ v: 1, kind: "support", position: Number(rows.at(-1)!.position), id: String(rows.at(-1)!.id) })
        : null
    };
  }
}

async function ensureOwnerSubject(client: PoolClient, actor: AnalysisPromotionActor): Promise<string> {
  const member = (await client.query(
    `select role from project_members where project_id=$1 and user_id=$2`,
    [actor.projectId, actor.userId]
  )).rows[0];
  if (!member || String(member.role) !== "owner") {
    throw repoError("analysis_promotion_forbidden", "The promotion actor is not a current project owner");
  }
  const deterministicId = stableId("grs", actor.projectId, actor.userId);
  await client.query(
    `insert into governed_reviewer_subjects (id,project_id,account_user_id,subject_digest)
     values ($1,$2,$3,governed_content_v1_digest(
       'governed-reviewer-subject/v1',jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
     )) on conflict (project_id,account_user_id) where account_user_id is not null do nothing`,
    [deterministicId, actor.projectId, actor.userId]
  );
  const subject = (await client.query(
    `select id from governed_reviewer_subjects where project_id=$1 and account_user_id=$2`,
    [actor.projectId, actor.userId]
  )).rows[0];
  if (!subject) throw repoError("analysis_promotion_subject_unavailable", "A durable owner subject is required");
  return String(subject.id);
}

async function findExistingCommand(
  client: PoolClient,
  projectId: string,
  idempotencyKey: string,
  codeId: string
) {
  const rows = await client.query(
    `select id,idempotency_key,request_digest,code_id
     from analysis_criterion_promotions
     where project_id=$1 and (idempotency_key=$2 or code_id=$3)`,
    [projectId, idempotencyKey, codeId]
  );
  const byKey = rows.rows.find((row) => String(row.idempotency_key) === idempotencyKey) ?? null;
  const byCode = rows.rows.find((row) => String(row.code_id) === codeId) ?? null;
  const project = (row: Record<string, unknown> | null) => row ? {
    promotionId: String(row.id), idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest)
  } : null;
  return { existingByIdempotencyKey: project(byKey), existingForCode: project(byCode) };
}

async function assertOwnedLockTarget(
  client: PoolClient,
  projectId: string,
  studyId: string,
  taxonomyId: string
): Promise<void> {
  const row = (await client.query(
    `select exists(select 1 from analysis_studies where id=$2 and project_id=$1) as study_ok,
            exists(select 1 from analysis_failure_taxonomies where id=$3 and project_id=$1) as taxonomy_ok`,
    [projectId, studyId, taxonomyId]
  )).rows[0];
  if (!row?.study_ok || !row?.taxonomy_ok) {
    throw repoError("analysis_promotion_not_found", "Analysis promotion evidence was not found");
  }
}

async function loadPromotionContext(
  client: PoolClient,
  projectId: string,
  input: AnalysisCriterionPromotionCreateInput
): Promise<PromotionContext> {
  const row = (await client.query(
    `select study.id as study_id,analysis_study_state_v1(study.id) as state,
            study.population_id,study.draw_id,study.dataset_revision_id as source_dataset_revision_id,
            source_revision.content_digest as source_dataset_revision_content_digest,
            source_revision.revision_digest as source_dataset_revision_digest,
            closure.id as closure_id,closure.closure_digest,
            taxonomy.id as taxonomy_id,taxonomy_revision.id as taxonomy_revision_id,
            taxonomy_revision.sequence as taxonomy_revision_sequence,
            taxonomy_revision.revision_digest as taxonomy_revision_digest,
            code.code_id,code.id as code_entry_id,code.entry_digest as code_entry_digest,
            code.label as code_label,code.definition as code_definition,code.status as code_status,
            not exists(select 1 from analysis_failure_taxonomy_revisions successor
                       where successor.predecessor_revision_id=taxonomy_revision.id) as is_taxonomy_head
     from analysis_studies study
     left join analysis_study_closures closure
       on closure.id=$3 and closure.study_id=study.id and closure.project_id=study.project_id
     join dataset_revisions source_revision
       on source_revision.id=study.dataset_revision_id and source_revision.project_id=study.project_id
     join analysis_failure_taxonomies taxonomy
       on taxonomy.id=$4 and taxonomy.project_id=study.project_id
     left join analysis_failure_taxonomy_revisions taxonomy_revision
       on taxonomy_revision.id=$5 and taxonomy_revision.taxonomy_id=taxonomy.id
     left join analysis_failure_taxonomy_revision_codes code
       on code.taxonomy_revision_id=taxonomy_revision.id and code.code_id=$6
     where study.project_id=$1 and study.id=$2`,
    [projectId, input.studyId, input.expectedClosureId, input.taxonomyId,
      input.taxonomyRevisionId, input.codeId]
  )).rows[0];
  if (!row) throw repoError("analysis_promotion_not_found", "Analysis study or taxonomy was not found");
  return {
    studyId: String(row.study_id), state: String(row.state), populationId: String(row.population_id),
    drawId: String(row.draw_id), sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionContentDigest: String(row.source_dataset_revision_content_digest),
    sourceDatasetRevisionDigest: String(row.source_dataset_revision_digest),
    closureId: nullableString(row.closure_id) ?? "", closureDigest: nullableString(row.closure_digest) ?? "",
    taxonomyId: String(row.taxonomy_id), taxonomyRevisionId: nullableString(row.taxonomy_revision_id) ?? "",
    taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence),
    taxonomyRevisionDigest: nullableString(row.taxonomy_revision_digest) ?? "",
    codeId: nullableString(row.code_id) ?? "", codeEntryId: nullableString(row.code_entry_id) ?? "",
    codeEntryDigest: nullableString(row.code_entry_digest) ?? "", codeLabel: nullableString(row.code_label) ?? "",
    codeDefinition: nullableString(row.code_definition) ?? "", codeStatus: nullableString(row.code_status) ?? "",
    isTaxonomyHead: Boolean(row.is_taxonomy_head)
  };
}

function assertPromotionContext(context: PromotionContext, input: AnalysisCriterionPromotionCreateInput): void {
  if (context.state !== "coding_closed" && context.state !== "completed") {
    throw repoError("analysis_promotion_state_conflict", "Promotion requires a closed or completed analysis study");
  }
  if (context.closureId !== input.expectedClosureId || context.closureDigest !== input.expectedClosureDigest) {
    throw repoError("analysis_promotion_closure_conflict", "Promotion closure evidence changed");
  }
  if (!context.isTaxonomyHead || context.taxonomyRevisionId !== input.taxonomyRevisionId ||
    context.taxonomyRevisionDigest !== input.expectedTaxonomyRevisionDigest) {
    throw repoError("analysis_promotion_taxonomy_conflict", "Promotion requires the exact current taxonomy head");
  }
  if (context.codeId !== input.codeId || context.codeEntryDigest !== input.expectedCodeEntryDigest ||
    context.codeStatus !== "active") {
    throw repoError("analysis_promotion_code_conflict", "Promotion requires one active exact taxonomy code entry");
  }
}

async function loadCandidateEvidence(
  client: PoolClient,
  projectId: string,
  context: PromotionContext,
  observationIds: string[]
): Promise<CandidateEvidenceRow[]> {
  const result = await client.query(
    `select item.id as study_item_id,closure_item.id as closure_item_id,
            closure_item.content_digest as closure_item_digest,closure_item.position,
            source_item.id as source_dataset_revision_item_id,source_item.item_digest as source_item_digest,
            observation.id as observation_event_id,observation.event_digest as observation_event_digest,
            observation.failure_label,observation.rationale as observation_rationale,
            observation.anchor_kind,observation.anchor_step_index,
            observation.actor_user_id as observation_author_user_id,
            observation.actor_subject_id as observation_author_subject_id,
            assignment.id as assignment_event_id,assignment.event_digest as assignment_event_digest,
            assignment.rationale as assignment_rationale
     from analysis_study_closure_items closure_item
     join analysis_study_items item on item.id=closure_item.study_item_id and item.project_id=closure_item.project_id
     join dataset_revision_items source_item
       on source_item.id=item.revision_item_id and source_item.revision_id=$4
     cross join lateral generate_subscripts(closure_item.active_failure_observation_event_ids,1) slot
     join analysis_study_item_events observation
       on observation.id=closure_item.active_failure_observation_event_ids[slot]
      and observation.event_digest=closure_item.active_failure_observation_event_digests[slot]
     join analysis_observation_assignment_events assignment
       on assignment.id=closure_item.active_failure_assignment_event_ids[slot]
      and assignment.event_digest=closure_item.active_failure_assignment_event_digests[slot]
     join lateral analysis_observation_assignment_head_v1(observation.id,$6) head
       on head.assignment_event_id=assignment.id and head.assignment_event_digest=assignment.event_digest
      and head.assignment_event_type='assigned' and head.taxonomy_id=$5 and head.code_id=$7
     where closure_item.project_id=$1 and closure_item.study_id=$2 and closure_item.closure_id=$3
       and observation.id=any($8::text[])
     order by governed_utf16_sort_key_v1(observation.id),
              governed_utf16_sort_key_v1(item.id),
              governed_utf16_sort_key_v1(closure_item.id),
              governed_utf16_sort_key_v1(assignment.id)`,
    [projectId, context.studyId, context.closureId, context.sourceDatasetRevisionId,
      context.taxonomyId, context.taxonomyRevisionSequence, context.codeId, observationIds]
  );
  return result.rows as CandidateEvidenceRow[];
}

function requestedSupportMatchesEvidence(
  requested: AnalysisCriterionPromotionCreateInput["supportingObservations"][number],
  evidence: CandidateEvidenceRow
): boolean {
  return requested.studyItemId === String(evidence.study_item_id) &&
    requested.closureItemId === String(evidence.closure_item_id) &&
    requested.closureItemDigest === String(evidence.closure_item_digest) &&
    requested.observationEventId === String(evidence.observation_event_id) &&
    requested.observationEventDigest === String(evidence.observation_event_digest) &&
    requested.assignmentEventId === String(evidence.assignment_event_id) &&
    requested.assignmentEventDigest === String(evidence.assignment_event_digest);
}

async function insertCriterionExposure(client: PoolClient, input: {
  promotionId: string; projectId: string; revisionId: string; exposureId: string;
  subjectId: string; actorUserId: string;
}): Promise<void> {
  await client.query(
    `insert into dataset_exposure_events
      (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,subject_kind,
       subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key)
     select $1,$2,$3,null,'development_use','development','criterion_authoring','person',
            $4,$5,'analysis_criterion_promotion',$6,'Analysis failure-code criterion authoring',
            analysis_criterion_authoring_exposure_details_v1(promotion),
            'analysis-promotion:criterion-authoring:' || promotion.id
     from analysis_criterion_promotions promotion where promotion.id=$6 and promotion.project_id=$2`,
    [input.exposureId, input.projectId, input.revisionId, input.subjectId, input.actorUserId, input.promotionId]
  );
}

async function insertSupportExposure(client: PoolClient, input: {
  promotionId: string; projectId: string; revisionId: string; revisionItemId: string;
  supportId: string; exposureId: string; subjectId: string; actorUserId: string;
}): Promise<void> {
  await client.query(
    `insert into dataset_exposure_events
      (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,subject_kind,
       subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key)
     select $1,$2,$3,$4,'development_use','development','example_selection','person',
            $5,$6,'analysis_criterion_promotion',$7,'Analysis promotion supporting observation',
            analysis_criterion_support_exposure_details_v1(promotion,support),
            'analysis-promotion:example-selection:' || promotion.id || ':' || support.id
     from analysis_criterion_promotions promotion
     join analysis_criterion_promotion_supports support
       on support.promotion_id=promotion.id and support.id=$8
     where promotion.id=$7 and promotion.project_id=$2`,
    [input.exposureId, input.projectId, input.revisionId, input.revisionItemId,
      input.subjectId, input.actorUserId, input.promotionId, input.supportId]
  );
}

function promotionSummarySelect(): string {
  return `select promotion.*,promotion.id as promotion_id,
                 to_char(promotion.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,
                 criterion.stable_key as criterion_stable_key_row,
                 criterion.source_kind as criterion_source_kind,
                 criterion.created_by_user_id as criterion_created_by_user_id,
                 criterion.created_at as criterion_created_at,
                 version.revision as criterion_version_revision,version.name as criterion_version_name,
                 version.definition as criterion_version_definition,
                 version.criterion_digest as criterion_version_digest,
                 version.source_kind as criterion_version_source_kind,
                 version.created_by_user_id as criterion_version_created_by_user_id,
                 version.created_at as criterion_version_created_at
          from analysis_criterion_promotions promotion
          join criteria criterion on criterion.id=promotion.criterion_id and criterion.project_id=promotion.project_id
          join criterion_versions version on version.id=promotion.criterion_version_id and version.project_id=promotion.project_id`;
}

async function loadCreateResult(
  db: Pick<Pool, "query"> | PoolClient,
  projectId: string,
  promotionId: string,
  replayed: boolean
): Promise<AnalysisCriterionPromotionCreateResult> {
  const row = (await db.query(
    `${promotionSummarySelect()} where promotion.project_id=$1 and promotion.id=$2`,
    [projectId, promotionId]
  )).rows[0];
  if (!row) throw repoError("analysis_promotion_not_found", "Analysis promotion was not found");
  const supports = await db.query(
    `select * from analysis_criterion_promotion_supports
     where project_id=$1 and promotion_id=$2 order by position,id`,
    [projectId, promotionId]
  );
  return { ...rowToSummary(row), supports: supports.rows.map(rowToSupport), replayed };
}

function rowToSummary(row: Record<string, unknown>): AnalysisCriterionPromotionSummary {
  const promotion = rowToPromotion(row);
  const criterion: Criterion = {
    id: promotion.criterionId,
    projectId: promotion.projectId,
    stableKey: String(row.criterion_stable_key_row),
    sourceKind: sourceKind(row.criterion_source_kind),
    createdByUserId: nullableString(row.criterion_created_by_user_id),
    createdAt: iso(row.criterion_created_at)
  };
  const criterionVersion: CriterionVersion = {
    id: promotion.criterionVersionId,
    projectId: promotion.projectId,
    criterionId: promotion.criterionId,
    revision: Number(row.criterion_version_revision),
    name: String(row.criterion_version_name),
    definition: String(row.criterion_version_definition),
    criterionDigest: String(row.criterion_version_digest),
    sourceKind: sourceKind(row.criterion_version_source_kind),
    createdByUserId: nullableString(row.criterion_version_created_by_user_id),
    createdAt: iso(row.criterion_version_created_at)
  };
  const handoff: AnalysisCriterionPromotionHandoff = {
    handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    promotionId: promotion.id,
    projectId: promotion.projectId,
    criterionId: promotion.criterionId,
    criterionVersionId: promotion.criterionVersionId,
    criterionDigest: promotion.criterionDigest,
    sourceDatasetRevisionId: promotion.sourceDatasetRevisionId,
    sourceDatasetRevisionContentDigest: promotion.sourceDatasetRevisionContentDigest,
    sourceDatasetRevisionDigest: promotion.sourceDatasetRevisionDigest,
    roleIntent: "analysis_authoring",
    sourceKind: "analysis_promotion_handoff",
    evidenceClass: "development_authoring_not_truth",
    createsTruth: false,
    createsEvaluator: false,
    handoffDigest: promotion.handoffDigest
  };
  return { promotion, criterion, criterionVersion, handoff };
}

function rowToPromotion(row: Record<string, unknown>): AnalysisCriterionPromotionArtifact {
  return {
    id: String(row.promotion_id ?? row.id), projectId: String(row.project_id),
    contractVersion: ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
    studyId: String(row.study_id), studyClosureId: String(row.study_closure_id),
    studyClosureDigest: String(row.study_closure_digest), populationId: String(row.population_id),
    drawId: String(row.draw_id), sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionContentDigest: String(row.source_dataset_revision_content_digest),
    sourceDatasetRevisionDigest: String(row.source_dataset_revision_digest), taxonomyId: String(row.taxonomy_id),
    taxonomyRevisionId: String(row.taxonomy_revision_id), taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence),
    taxonomyRevisionDigest: String(row.taxonomy_revision_digest), codeId: String(row.code_id),
    codeEntryId: String(row.code_entry_id), codeEntryDigest: String(row.code_entry_digest),
    codeLabel: String(row.code_label), codeDefinition: String(row.code_definition),
    criterionId: String(row.criterion_id), criterionVersionId: String(row.criterion_version_id),
    criterionStableKey: String(row.criterion_stable_key), criterionName: String(row.criterion_name),
    criterionDefinition: String(row.criterion_definition), criterionDigest: String(row.criterion_digest),
    rationale: String(row.rationale), supportCount: Number(row.support_count),
    supportSetDigest: String(row.support_set_digest),
    criterionAuthoringExposureEventId: String(row.criterion_authoring_exposure_event_id),
    promotedByUserId: String(row.promoted_by_user_id), promotedBySubjectId: String(row.promoted_by_subject_id),
    promoterRole: "owner", idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest), handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    handoffDigest: String(row.handoff_digest), createdAt: iso(row.created_at)
  };
}

function rowToSupport(row: Record<string, unknown>): AnalysisCriterionPromotionSupportArtifact {
  return {
    id: String(row.id), projectId: String(row.project_id), promotionId: String(row.promotion_id),
    position: Number(row.position), studyId: String(row.study_id), studyItemId: String(row.study_item_id),
    closureId: String(row.closure_id), closureItemId: String(row.closure_item_id),
    closureItemDigest: String(row.closure_item_digest),
    sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionItemId: String(row.source_dataset_revision_item_id),
    sourceItemDigest: String(row.source_item_digest), observationEventId: String(row.observation_event_id),
    observationEventDigest: String(row.observation_event_digest), assignmentEventId: String(row.assignment_event_id),
    assignmentEventDigest: String(row.assignment_event_digest),
    observationAuthorSubjectId: String(row.observation_author_subject_id),
    exampleSelectionExposureEventId: String(row.example_selection_exposure_event_id),
    contentDigest: String(row.content_digest), createdAt: iso(row.created_at)
  };
}

function rowToCandidate(row: Record<string, unknown>): AnalysisCriterionPromotionCandidate {
  return {
    projectId: String(row.project_id), studyId: String(row.study_id),
    studyState: String(row.study_state) as "coding_closed" | "completed",
    closureId: String(row.closure_id), closureDigest: String(row.closure_digest),
    taxonomyId: String(row.taxonomy_id), taxonomyRevisionId: String(row.taxonomy_revision_id),
    taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence),
    taxonomyRevisionDigest: String(row.taxonomy_revision_digest), codeId: String(row.code_id),
    codeEntryId: String(row.code_entry_id), codeEntryDigest: String(row.code_entry_digest),
    codeLabel: String(row.code_label), codeDefinition: String(row.code_definition), codeStatus: "active",
    studyItemId: String(row.study_item_id), closureItemId: String(row.closure_item_id),
    closureItemDigest: String(row.closure_item_digest), position: Number(row.position),
    sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionItemId: String(row.source_dataset_revision_item_id),
    sourceItemDigest: String(row.source_item_digest), observationEventId: String(row.observation_event_id),
    observationEventDigest: String(row.observation_event_digest), failureLabel: String(row.failure_label),
    observationRationale: String(row.observation_rationale),
    evidenceAnchor: String(row.anchor_kind) === "step"
      ? { kind: "step", stepIndex: Number(row.anchor_step_index) }
      : { kind: "case_output" },
    assignmentEventId: String(row.assignment_event_id), assignmentEventDigest: String(row.assignment_event_digest),
    assignmentRationale: String(row.assignment_rationale),
    observationAuthorSubjectId: String(row.observation_author_subject_id)
  };
}

function sourceKind(value: unknown): "native" | "analysis_promotion" {
  if (value === "native" || value === "analysis_promotion") return value;
  throw new Error(`Unsupported criterion source kind: ${String(value)}`);
}

function commandConflict(code: "analysis_promotion_idempotency_conflict" | "analysis_promotion_code_already_promoted") {
  return repoError(code, code === "analysis_promotion_idempotency_conflict"
    ? "The promotion idempotency key was already used for different evidence"
    : "This analysis failure code already has an immutable criterion promotion");
}

function mapPgError(error: unknown): Error {
  if (error instanceof AnalysisPromotionRepositoryError) return error;
  const pg = error as { code?: string; constraint?: string; message?: string };
  const message = pg?.message ?? "Analysis promotion persistence failed";
  if (pg?.code === "23505" && /idempotency/i.test(pg.constraint ?? "")) {
    return repoError("analysis_promotion_idempotency_conflict", "Promotion idempotency conflict");
  }
  if (pg?.code === "23505" && /code_id/i.test(pg.constraint ?? "")) {
    return repoError("analysis_promotion_code_already_promoted", "The analysis code is already promoted");
  }
  if (/support|observation|assignment/i.test(message)) {
    return repoError("analysis_promotion_support_conflict", "Promotion supporting evidence is not current and exact");
  }
  if (/taxonomy|code entry|active code/i.test(message)) {
    return repoError("analysis_promotion_taxonomy_conflict", "Promotion taxonomy evidence is not current and exact");
  }
  if (/closure|closed study/i.test(message)) {
    return repoError("analysis_promotion_closure_conflict", "Promotion closure evidence is not current and exact");
  }
  if (pg?.code === "23503" || pg?.code === "23514" || pg?.code === "40001" || pg?.code === "55000") {
    return repoError("analysis_promotion_state_conflict", "Promotion conflicts with immutable governed evidence");
  }
  return error instanceof Error ? error : new Error(message);
}

function repoError(
  code: ConstructorParameters<typeof AnalysisPromotionRepositoryError>[0],
  message: string
): AnalysisPromotionRepositoryError {
  return new AnalysisPromotionRepositoryError(code, message);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 48)}`;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeTimestampCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (cursor === null) return null;
  const value = decodeCursor(cursor);
  if (value.kind !== "promotion" || typeof value.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt) ||
    typeof value.id !== "string" || value.id.length < 1 || value.id.length > 240) {
    throw repoError("analysis_promotion_invalid_cursor", "Invalid analysis promotion cursor");
  }
  return { createdAt: value.createdAt, id: value.id };
}

function decodePositionCursor(
  cursor: string | null,
  kind: "candidate" | "support"
): { position: number; id: string } | null {
  if (cursor === null) return null;
  const value = decodeCursor(cursor);
  if (value.kind !== kind || !Number.isInteger(value.position) || Number(value.position) < 0 ||
    Number(value.position) > 9_999 || typeof value.id !== "string" ||
    value.id.length < 1 || value.id.length > 240) {
    throw repoError("analysis_promotion_invalid_cursor", "Invalid analysis promotion cursor");
  }
  return { position: Number(value.position), id: value.id };
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value as Record<string, unknown>).some((key) => !["v", "kind", "createdAt", "position", "id"].includes(key)) ||
      (value as { v?: unknown }).v !== 1) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw repoError("analysis_promotion_invalid_cursor", "Invalid analysis promotion cursor");
  }
}
