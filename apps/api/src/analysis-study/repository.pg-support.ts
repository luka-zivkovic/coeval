import {
  ANALYSIS_MAX_EVENT_VERSION,
  ANALYSIS_MAX_TAXONOMY_REVISIONS,
  ANALYSIS_POPULATION_MAX_FIXED_BUDGET,
  ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
  ANALYSIS_TAXONOMY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_COVERAGE_VERSION,
  AnalysisStudyEventResultSchema,
  AnalysisStudyItemEventArtifactSchema,
  AnalysisStudyItemEventResultSchema,
  AnalysisStudyItemProjectionSchema,
  AnalysisStudyProjectionSchema,
  AnalysisTaxonomyCoverageSchema,
  AnalysisTaxonomyRevisionProjectionSchema,
  AnalysisTaxonomyRevisionResultSchema,
  type AnalysisFailureTaxonomyArtifact,
  type AnalysisObservationAssignmentEventArtifact,
  type AnalysisStudyClosureArtifact,
  type AnalysisStudyEventArtifact,
  type AnalysisStudyEventResult,
  type AnalysisStudyItemEventArtifact,
  type AnalysisStudyItemEventInput,
  type AnalysisStudyItemEventResult,
  type AnalysisStudyItemProjection,
  type AnalysisStudyProjection,
  type AnalysisStudyStoppingRule,
  type AnalysisStudySummary,
  type AnalysisTaxonomyCoverage,
  type AnalysisTaxonomyRevisionArtifact,
  type AnalysisTaxonomyRevisionCodeArtifact,
  type AnalysisTaxonomyRevisionProjection,
  type AnalysisTaxonomyRevisionResult
} from "@coeval/shared";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  analysisStudyClosureContentDigest,
  analysisStudyClosureItemContentDigest,
  analysisStudyEventRequestDigest,
  analysisStudyViewSetDigest
} from "../lib/analysis-study.js";
import type { AnalysisStudyActor } from "./repository.js";
import { AnalysisStudyRepositoryError } from "./repository.js";

interface CursorValue {
  kind: "chronological" | "position" | "version" | "sequence";
  primary: string;
  id?: string;
}

export async function ensureDueClosure(pool: Pool, projectId: string, studyId: string): Promise<void> {
  try {
    await transaction(pool, async (client) => {
      await closeIfDue(client, studyId, projectId);
      await client.query(`select analysis_clear_deadline_retry_v1($1,$2)`, [projectId, studyId]);
    });
  } catch (error) {
    await pool.query(
      `select analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
      [projectId, studyId]
    ).catch(() => undefined);
    throw error;
  }
}

export async function appendStudyEvent(
  pool: Pool,
  actor: AnalysisStudyActor,
  studyId: string,
  idempotencyKey: string,
  requestDigest: string,
  build: (head: AnalysisStudyProjection) => StudyEventInsert
): Promise<AnalysisStudyEventResult> {
  requireOwnerActor(actor);
  const replay = await transaction(pool, async (client) => {
    await requireProjectRole(client, actor.projectId, actor.userId, "owner");
    const event = await findStudyEventReplay(client, actor.projectId, studyId, idempotencyKey, requestDigest);
    return event ? studyEventResult(client, actor.projectId, studyId, event, true) : null;
  });
  if (replay) return replay;
  await ensureDueClosure(pool, actor.projectId, studyId);
  let outcome: AnalysisStudyEventResult | null;
  try {
    outcome = await transaction(pool, async (client) => {
      await requireProjectRole(client, actor.projectId, actor.userId, "owner");
    const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
    const repeated = await findStudyEventReplay(client, actor.projectId, studyId, idempotencyKey, requestDigest);
    if (repeated) return studyEventResult(client, actor.projectId, studyId, repeated, true);
    if (!(await lockOwnedStudy(client, actor.projectId, studyId))) {
      throw repoError("analysis_study_not_found", "Analysis study not found");
    }
    const lockedReplay = await findStudyEventReplay(client, actor.projectId, studyId,
      idempotencyKey, requestDigest);
    if (lockedReplay) return studyEventResult(client, actor.projectId, studyId, lockedReplay, true);
    if (await closeIfDue(client, studyId, actor.projectId)) return null;
    const head = await requireStudyProjection(client, actor.projectId, studyId);
    const value = build(head);
    if (head.currentVersion !== value.expectedVersion) {
      throw repoError("analysis_study_version_conflict", "Study compare-and-swap version does not match");
    }
    let inserted;
    try {
      inserted = await insertStudyEvent(client, { projectId: actor.projectId, studyId,
        actorUserId: actor.userId, actorSubjectId: subjectId, actorRole: "owner",
        idempotencyKey, requestDigest, ...value });
    } catch (error) {
      throw mapPgError(error);
    }
      return studyEventResult(client, actor.projectId, studyId, rowToStudyEvent(inserted), false);
    });
  } catch (error) {
    await ensureDueClosure(pool, actor.projectId, studyId).catch(() => undefined);
    throw error;
  }
  if (outcome === null) throw repoError("analysis_study_state_conflict", "Study deadline closed before this command");
  return outcome;
}

export async function transaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await body(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw mapPgError(error);
  } finally {
    client.release();
  }
}

export const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

interface StudyEventInsert {
  eventType: "coding_opened" | "study_completed" | "study_abandoned";
  fromState: "draft" | "coding_open" | "coding_closed";
  toState: "coding_open" | "completed" | "abandoned";
  stoppingRule: AnalysisStudyStoppingRule | null;
  closeCause: null;
  closureId: null;
  closureDigest: null;
  expectedClosureDigest: string | null;
  reason: string | null;
  expectedVersion: string;
  head: AnalysisStudyProjection;
}

export function studySummarySelect(): string {
  return `select study.id as study_id,study.project_id,study.population_id,study.draw_id,
                 study.dataset_revision_id,study.contract_version,study.idempotency_key,
                 study.request_digest,study.content_digest,study.created_by_user_id,
                 study.created_by_subject_id,study.created_at as study_created_at,
                 to_char(study.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   as study_created_at_exact,
                 projection.state,projection.current_version,projection.current_event_id,
                 projection.current_event_digest,projection.stopping_rule,projection.close_at,
                 projection.closure_id,projection.closure_digest,
                 (select count(*)::integer from analysis_study_items value where value.study_id=study.id)
                   as selected_item_count,
                 case when closure.id is not null then closure.viewed_item_count else
                   (select count(*)::integer from analysis_study_items value
                    cross join lateral analysis_study_item_projection_v1(value.id,null) item_projection
                    where value.study_id=study.id and cardinality(item_projection.view_event_ids)>0) end
                   as viewed_item_count,
                 case when closure.id is not null then closure.completed_item_count else
                   (select count(*)::integer from analysis_study_items value
                    cross join lateral analysis_study_item_projection_v1(value.id,null) item_projection
                    where value.study_id=study.id and item_projection.item_state='completed') end
                   as completed_item_count,
                 closure.id as close_id,closure.stopping_rule as close_stopping_rule,
                 closure.close_at as close_at_frozen,closure.close_cause,
                 closure.close_actor_user_id,closure.close_actor_subject_id,closure.close_actor_role,
                 closure.close_reason,closure.effective_closed_at,closure.recorded_at,
                 closure.selected_item_count as closure_selected_item_count,
                 closure.viewed_item_count as closure_viewed_item_count,
                 closure.completed_item_count as closure_completed_item_count,
                 closure.view_set_digest,closure.assessment_version,closure.method,
                 closure.frozen_frame_digest,closure.recomputed_frame_digest,
                 closure.frozen_draw_digest,closure.recomputed_draw_digest,
                 closure.method_eligible,closure.frame_reproducible,closure.draw_complete,
                 closure.coding_complete,closure.closure_item_count,
                 closure.drawn_from_population_id,closure.representative_of_population_id,
                 closure.representative_reason,closure.assessment_digest,
                 closure.content_digest as closure_content_digest,
                 closure.closure_digest as close_closure_digest,closure.created_at as closure_created_at
          from analysis_studies study
          cross join lateral analysis_study_projection_v1(study.id) projection
          left join analysis_study_closures closure on closure.study_id=study.id`;
}

export function studyItemSelect(): string {
  return `select item.id,item.project_id,item.study_id,item.draw_item_id,item.member_id,
                 item.revision_item_id,item.case_id,item.position,item.content_digest,item.created_at,
                 projection.*
          from analysis_study_items item
          cross join lateral analysis_study_item_projection_v1(item.id,null) projection`;
}

function rowToStudyProjection(row: Record<string, unknown>): AnalysisStudyProjection {
  const stoppingRule = row.stopping_rule === null || row.stopping_rule === undefined ? null : {
    kind: String(row.stopping_rule),
    closeAt: row.stopping_rule === "server_deadline" ? iso(row.close_at) : null
  };
  return AnalysisStudyProjectionSchema.parse({
    study: {
      id: String(row.study_id), projectId: String(row.project_id),
      populationId: String(row.population_id), drawId: String(row.draw_id),
      datasetRevisionId: String(row.dataset_revision_id), contractVersion: String(row.contract_version),
      idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
      contentDigest: String(row.content_digest), createdByUserId: String(row.created_by_user_id),
      createdBySubjectId: String(row.created_by_subject_id), createdAt: iso(row.study_created_at)
    },
    state: String(row.state), currentVersion: String(row.current_version),
    currentEventId: nullableString(row.current_event_id),
    currentEventDigest: nullableString(row.current_event_digest), stoppingRule,
    closureId: nullableString(row.closure_id), closureDigest: nullableString(row.closure_digest)
  });
}

function rowToClosure(row: Record<string, unknown>): AnalysisStudyClosureArtifact | null {
  if (!row.close_id) return null;
  return {
    id: String(row.close_id), projectId: String(row.project_id), studyId: String(row.study_id),
    populationId: String(row.population_id), drawId: String(row.draw_id),
    datasetRevisionId: String(row.dataset_revision_id),
    stoppingRule: { kind: String(row.close_stopping_rule) as AnalysisStudyStoppingRule["kind"],
      closeAt: row.close_stopping_rule === "server_deadline" ? iso(row.close_at_frozen) : null } as AnalysisStudyStoppingRule,
    closeCause: String(row.close_cause) as AnalysisStudyClosureArtifact["closeCause"],
    closeActorUserId: nullableString(row.close_actor_user_id),
    closeActorSubjectId: nullableString(row.close_actor_subject_id),
    closeActorRole: String(row.close_actor_role) as AnalysisStudyClosureArtifact["closeActorRole"],
    closeReason: nullableString(row.close_reason), effectiveClosedAt: iso(row.effective_closed_at),
    recordedAt: iso(row.recorded_at), selectedItemCount: Number(row.closure_selected_item_count),
    viewedItemCount: Number(row.closure_viewed_item_count),
    completedItemCount: Number(row.closure_completed_item_count),
    viewSetDigest: String(row.view_set_digest), assessmentVersion: String(row.assessment_version) as typeof ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
    method: String(row.method), frozenFrameDigest: String(row.frozen_frame_digest),
    recomputedFrameDigest: nullableString(row.recomputed_frame_digest),
    frozenDrawDigest: String(row.frozen_draw_digest),
    recomputedDrawDigest: nullableString(row.recomputed_draw_digest),
    methodEligible: Boolean(row.method_eligible), frameReproducible: Boolean(row.frame_reproducible),
    drawComplete: Boolean(row.draw_complete), codingComplete: Boolean(row.coding_complete),
    closureItemCount: Number(row.closure_item_count),
    drawnFromPopulationId: String(row.drawn_from_population_id),
    representativeOfPopulationId: nullableString(row.representative_of_population_id),
    representativeReason: nullableString(row.representative_reason) as AnalysisStudyClosureArtifact["representativeReason"],
    assessmentDigest: String(row.assessment_digest), contentDigest: String(row.closure_content_digest),
    closureDigest: String(row.close_closure_digest), createdAt: iso(row.closure_created_at)
  };
}

export function rowToStudySummary(row: Record<string, unknown>): AnalysisStudySummary {
  return {
    study: rowToStudyProjection(row), selectedItemCount: Number(row.selected_item_count),
    viewedItemCount: Number(row.viewed_item_count), completedItemCount: Number(row.completed_item_count),
    closure: rowToClosure(row)
  };
}

export function rowToStudyItemProjection(row: Record<string, unknown>): AnalysisStudyItemProjection {
  return AnalysisStudyItemProjectionSchema.parse({
    item: { id: String(row.id), projectId: String(row.project_id), studyId: String(row.study_id),
      drawItemId: String(row.draw_item_id), memberId: String(row.member_id),
      revisionItemId: String(row.revision_item_id), caseId: String(row.case_id),
      position: Number(row.position), contentDigest: String(row.content_digest), createdAt: iso(row.created_at) },
    state: String(row.item_state), currentVersion: String(row.current_version),
    currentEventId: nullableString(row.current_event_id), currentEventDigest: nullableString(row.current_event_digest),
    viewEventIds: textArray(row.view_event_ids), viewEventDigests: textArray(row.view_event_digests),
    activeFailureObservationEventIds: textArray(row.active_failure_observation_event_ids),
    activeFailureObservationEventDigests: textArray(row.active_failure_observation_event_digests),
    activeFailureAssignmentEventIds: nullableTextArray(row.active_failure_assignment_event_ids),
    activeFailureAssignmentEventDigests: nullableTextArray(row.active_failure_assignment_event_digests),
    activeNoFailureEventId: nullableString(row.active_no_failure_event_id),
    activeNoFailureEventDigest: nullableString(row.active_no_failure_event_digest),
    completionEventId: nullableString(row.completion_event_id),
    completionEventDigest: nullableString(row.completion_event_digest)
  });
}

export async function loadStudyProjection(db: Pool | PoolClient, projectId: string, studyId: string): Promise<AnalysisStudyProjection | null> {
  const result = await db.query(
    `select study.id as study_id,study.*,projection.*
     from analysis_studies study cross join lateral analysis_study_projection_v1(study.id) projection
     where study.project_id=$1 and study.id=$2`, [projectId, studyId]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  row.study_created_at = row.created_at;
  return rowToStudyProjection(row);
}

export async function requireStudyProjection(db: Pool | PoolClient, projectId: string, studyId: string): Promise<AnalysisStudyProjection> {
  const projection = await loadStudyProjection(db, projectId, studyId);
  if (!projection) throw repoError("analysis_study_not_found", "Analysis study not found");
  return projection;
}

export async function loadStudyItemProjection(db: Pool | PoolClient, projectId: string, studyId: string, studyItemId: string): Promise<AnalysisStudyItemProjection | null> {
  const result = await db.query(`${studyItemSelect()} where item.project_id=$1 and item.study_id=$2 and item.id=$3`,
    [projectId, studyId, studyItemId]);
  return result.rows[0] ? rowToStudyItemProjection(result.rows[0]) : null;
}

function rowToStudyEvent(row: Record<string, unknown>): AnalysisStudyEventArtifact {
  const common = { id: String(row.id), projectId: String(row.project_id), studyId: String(row.study_id),
    version: String(row.version), predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest),
    actorUserId: nullableString(row.actor_user_id), actorSubjectId: nullableString(row.actor_subject_id),
    actorRole: String(row.actor_role), idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest), eventDigest: String(row.event_digest), occurredAt: iso(row.occurred_at),
    eventType: String(row.event_type), fromState: String(row.from_state), toState: String(row.to_state) };
  if (row.event_type === "coding_opened") return { ...common,
    eventType: "coding_opened", fromState: "draft", toState: "coding_open",
    stoppingRule: { kind: String(row.stopping_rule), closeAt: row.stopping_rule === "server_deadline" ? iso(row.close_at) : null } as AnalysisStudyStoppingRule,
    closeCause: null, closureId: null, closureDigest: null, expectedClosureDigest: null, reason: null } as AnalysisStudyEventArtifact;
  if (row.event_type === "coding_closed") return { ...common,
    eventType: "coding_closed", fromState: "coding_open", toState: "coding_closed", stoppingRule: null,
    closeCause: String(row.close_cause), closureId: String(row.closure_id),
    closureDigest: String(row.closure_digest), expectedClosureDigest: null,
    reason: nullableString(row.reason) } as AnalysisStudyEventArtifact;
  if (row.event_type === "study_completed") return { ...common,
    eventType: "study_completed", fromState: "coding_closed", toState: "completed", stoppingRule: null,
    closeCause: null, closureId: null, closureDigest: null,
    expectedClosureDigest: String(row.expected_closure_digest), reason: null } as AnalysisStudyEventArtifact;
  return { ...common, eventType: "study_abandoned",
    fromState: String(row.from_state), toState: "abandoned", stoppingRule: null, closeCause: null,
    closureId: null, closureDigest: null, expectedClosureDigest: null, reason: String(row.reason) } as AnalysisStudyEventArtifact;
}

export function rowToStudyItemEvent(row: Record<string, unknown>): AnalysisStudyItemEventArtifact {
  const common = { id: String(row.id), projectId: String(row.project_id), studyId: String(row.study_id),
    studyItemId: String(row.study_item_id), version: String(row.version),
    predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest),
    actorUserId: String(row.actor_user_id), actorSubjectId: String(row.actor_subject_id),
    actorRole: String(row.actor_role), idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest), eventDigest: String(row.event_digest), occurredAt: iso(row.occurred_at) };
  const type = String(row.event_type);
  if (type === "failure_observed") return AnalysisStudyItemEventArtifactSchema.parse({ ...common,
    eventType: type, failureLabel: String(row.failure_label), rationale: String(row.rationale),
    evidenceAnchor: row.anchor_kind === "step" ? { kind: "step", stepIndex: Number(row.anchor_step_index) } : { kind: "case_output" } });
  if (type === "no_failure_observed") return AnalysisStudyItemEventArtifactSchema.parse({ ...common, eventType: type, rationale: String(row.rationale) });
  if (type === "coding_completed") return AnalysisStudyItemEventArtifactSchema.parse({ ...common, eventType: type });
  return AnalysisStudyItemEventArtifactSchema.parse({ ...common, eventType: type,
    targetEventId: String(row.target_event_id), targetEventDigest: String(row.target_event_digest),
    rationale: String(row.rationale) });
}

function rowToTaxonomyArtifact(row: Record<string, unknown>): AnalysisFailureTaxonomyArtifact {
  return { id: String(row.id), projectId: String(row.project_id),
    contractVersion: String(row.contract_version) as typeof ANALYSIS_TAXONOMY_CONTRACT_VERSION,
    name: String(row.name), description: String(row.description),
    idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest), createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id), createdAt: iso(row.created_at) };
}

export function rowToTaxonomyRevision(row: Record<string, unknown>): AnalysisTaxonomyRevisionArtifact {
  return { id: String(row.id), projectId: String(row.project_id), taxonomyId: String(row.taxonomy_id),
    sequence: Number(row.sequence), predecessorRevisionId: nullableString(row.predecessor_revision_id),
    predecessorRevisionDigest: nullableString(row.predecessor_revision_digest), reason: String(row.reason),
    codeCount: Number(row.code_count), contentDigest: String(row.content_digest),
    revisionDigest: String(row.revision_digest), createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id), idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest), createdAt: iso(row.created_at) };
}

function rowToTaxonomyCode(row: Record<string, unknown>): AnalysisTaxonomyRevisionCodeArtifact {
  return { id: String(row.id), projectId: String(row.project_id), taxonomyId: String(row.taxonomy_id),
    taxonomyRevisionId: String(row.taxonomy_revision_id), codeId: String(row.code_id),
    position: Number(row.position), label: String(row.label), definition: String(row.definition),
    status: String(row.status) as AnalysisTaxonomyRevisionCodeArtifact["status"],
    entryDigest: String(row.entry_digest), createdAt: iso(row.created_at) };
}

export async function loadTaxonomyArtifact(db: Pool | PoolClient, projectId: string, taxonomyId: string | null): Promise<AnalysisFailureTaxonomyArtifact | null> {
  const result = await db.query(
    `select * from analysis_failure_taxonomies where project_id=$1 and ($2::text is null or id=$2)`,
    [projectId, taxonomyId]
  );
  return result.rows[0] ? rowToTaxonomyArtifact(result.rows[0]) : null;
}

export async function loadTaxonomyRevisionProjection(
  db: Pool | PoolClient,
  projectId: string,
  taxonomyId: string,
  revisionId: string | null
): Promise<AnalysisTaxonomyRevisionProjection | null> {
  const revisionResult = await db.query(
    `select * from analysis_failure_taxonomy_revisions
     where project_id=$1 and taxonomy_id=$2 and ($3::text is null or id=$3)
     order by sequence desc limit 1`, [projectId, taxonomyId, revisionId]
  );
  if (!revisionResult.rows[0]) return null;
  const revision = rowToTaxonomyRevision(revisionResult.rows[0]);
  const codes = await db.query(
    `select * from analysis_failure_taxonomy_revision_codes
     where project_id=$1 and taxonomy_revision_id=$2 order by position`,
    [projectId, revision.id]
  );
  return AnalysisTaxonomyRevisionProjectionSchema.parse({ revision, codes: codes.rows.map(rowToTaxonomyCode) });
}

export async function loadTaxonomyRevisionResult(
  db: Pool | PoolClient,
  projectId: string,
  taxonomyId: string,
  revisionId: string | null,
  replayed: boolean
): Promise<AnalysisTaxonomyRevisionResult> {
  const taxonomy = await loadTaxonomyArtifact(db, projectId, taxonomyId);
  const revision = taxonomy ? await loadTaxonomyRevisionProjection(db, projectId, taxonomyId, revisionId) : null;
  if (!taxonomy || !revision) throw repoError("analysis_taxonomy_not_found", "Failure taxonomy revision not found");
  return AnalysisTaxonomyRevisionResultSchema.parse({ taxonomy, revision, replayed });
}

export function rowToAssignmentEvent(row: Record<string, unknown>): AnalysisObservationAssignmentEventArtifact {
  const value = { id: String(row.id), projectId: String(row.project_id), taxonomyId: String(row.taxonomy_id),
    taxonomyRevisionId: String(row.taxonomy_revision_id),
    taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence), studyId: String(row.study_id),
    studyItemId: String(row.study_item_id), observationEventId: String(row.observation_event_id),
    version: String(row.version), predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest), eventType: String(row.event_type),
    codeId: nullableString(row.code_id), rationale: String(row.rationale), actorUserId: String(row.actor_user_id),
    actorSubjectId: String(row.actor_subject_id), actorRole: String(row.actor_role),
    idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
    eventDigest: String(row.event_digest), occurredAt: iso(row.occurred_at) };
  return value as AnalysisObservationAssignmentEventArtifact;
}

export async function loadCoverage(db: Pool | PoolClient, projectId: string, studyId: string, revisionId: string): Promise<AnalysisTaxonomyCoverage | null> {
  const result = await db.query(
    `select coverage.*
     from analysis_studies study
     join analysis_failure_taxonomy_revisions revision on revision.project_id=study.project_id and revision.id=$3
     cross join lateral analysis_taxonomy_coverage_v1(study.id,revision.id) coverage
     where study.project_id=$1 and study.id=$2`, [projectId, studyId, revisionId]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return AnalysisTaxonomyCoverageSchema.parse({ projectId, studyId, taxonomyId: String(row.taxonomy_id),
    taxonomyRevisionId: revisionId, taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence),
    calculationVersion: ANALYSIS_TAXONOMY_COVERAGE_VERSION,
    selectedItemCount: Number(row.selected_item_count), completedItemCount: Number(row.completed_item_count),
    noFailureObservedItemCount: Number(row.no_failure_observed_item_count),
    activeFailureObservationCount: String(row.active_failure_observation_count),
    categorized: String(row.categorized), assignedToRetiredCode: String(row.assigned_to_retired_code),
    uncategorized: String(row.uncategorized), categorizedItemCount: Number(row.categorized_item_count),
    assignedToRetiredCodeItemCount: Number(row.assigned_to_retired_code_item_count),
    uncategorizedItemCount: Number(row.uncategorized_item_count) });
}

async function insertStudyEvent(client: PoolClient, input: {
  projectId: string; studyId: string; actorUserId: string | null; actorSubjectId: string | null;
  actorRole: "owner" | "system"; idempotencyKey: string; requestDigest: string;
  eventType: "coding_opened" | "study_completed" | "study_abandoned";
  fromState: "draft" | "coding_open" | "coding_closed";
  toState: "coding_open" | "completed" | "abandoned";
  stoppingRule: AnalysisStudyStoppingRule | null; closeCause: null; closureId: null;
  closureDigest: null; expectedClosureDigest: string | null; reason: string | null;
  expectedVersion: string; head: AnalysisStudyProjection;
}): Promise<Record<string, unknown>> {
  const result = await client.query(
    `insert into analysis_study_events
       (id,project_id,study_id,version,predecessor_event_id,predecessor_event_digest,
        event_type,from_state,to_state,stopping_rule,close_at,close_cause,closure_id,
        closure_digest,expected_closure_digest,reason,actor_subject_id,actor_user_id,
        actor_role,idempotency_key,request_digest,event_digest,occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null,null,null,$12,$13,$14,$15,$16,$17,$18,$19,transaction_timestamp())
     returning *`,
    [`ase_${randomUUID()}`, input.projectId, input.studyId,
      (BigInt(input.head.currentVersion) + 1n).toString(), input.head.currentEventId,
      input.head.currentEventDigest, input.eventType, input.fromState, input.toState,
      input.stoppingRule?.kind ?? null, input.stoppingRule?.closeAt ?? null,
      input.expectedClosureDigest, input.reason, input.actorSubjectId, input.actorUserId,
      input.actorRole, input.idempotencyKey, input.requestDigest, PLACEHOLDER_DIGEST]
  );
  return result.rows[0];
}

export async function studyEventResult(db: Pool | PoolClient, projectId: string, studyId: string,
  event: AnalysisStudyEventArtifact, replayed: boolean): Promise<AnalysisStudyEventResult> {
  return AnalysisStudyEventResultSchema.parse({ study: await requireStudyProjection(db, projectId, studyId), event, replayed });
}

export async function itemEventResult(db: Pool | PoolClient, projectId: string, studyId: string,
  studyItemId: string, event: AnalysisStudyItemEventArtifact, replayed: boolean): Promise<AnalysisStudyItemEventResult> {
  const item = await loadStudyItemProjection(db, projectId, studyId, studyItemId);
  if (!item) throw repoError("analysis_study_not_found", "Analysis study item not found");
  return AnalysisStudyItemEventResultSchema.parse({ item, event, replayed });
}

export async function findStudyEventReplay(db: Pool | PoolClient, projectId: string, studyId: string,
  key: string, requestDigest: string): Promise<AnalysisStudyEventArtifact | null> {
  const result = await db.query(`select * from analysis_study_events where project_id=$1 and study_id=$2 and idempotency_key=$3`,
    [projectId, studyId, key]);
  if (!result.rows[0]) return null;
  if (String(result.rows[0].request_digest) !== requestDigest) throw repoError("analysis_study_idempotency_conflict", "Study event idempotency key was reused with different input");
  return rowToStudyEvent(result.rows[0]);
}

export async function findItemEventReplay(db: Pool | PoolClient, projectId: string, studyId: string,
  itemId: string, key: string, requestDigest: string): Promise<AnalysisStudyItemEventArtifact | null> {
  const result = await db.query(`select * from analysis_study_item_events where project_id=$1 and study_id=$2 and study_item_id=$3 and idempotency_key=$4`,
    [projectId, studyId, itemId, key]);
  if (!result.rows[0]) return null;
  if (String(result.rows[0].request_digest) !== requestDigest) throw repoError("analysis_study_idempotency_conflict", "Study item event idempotency key was reused with different input");
  return rowToStudyItemEvent(result.rows[0]);
}

export async function findAssignmentReplay(db: Pool | PoolClient, projectId: string, taxonomyId: string,
  observationId: string, key: string, requestDigest: string): Promise<AnalysisObservationAssignmentEventArtifact | null> {
  const result = await db.query(`select * from analysis_observation_assignment_events where project_id=$1 and taxonomy_id=$2 and observation_event_id=$3 and idempotency_key=$4`,
    [projectId, taxonomyId, observationId, key]);
  if (!result.rows[0]) return null;
  if (String(result.rows[0].request_digest) !== requestDigest) throw repoError("analysis_study_idempotency_conflict", "Assignment idempotency key was reused with different input");
  return rowToAssignmentEvent(result.rows[0]);
}

export async function materializeClosure(client: PoolClient, input: {
  projectId: string;
  studyId: string;
  idempotencyKey: string;
  requestDigest: string;
  closeCause: "server_deadline" | "explicit_owner_close";
  closeActorUserId: string | null;
  closeActorSubjectId: string | null;
  closeReason: string | null;
  expectedVersion: string;
}): Promise<AnalysisStudyEventResult> {
  if (!(await lockOwnedStudy(client, input.projectId, input.studyId))) {
    throw repoError("analysis_study_not_found", "Analysis study not found");
  }
  const replay = await findStudyEventReplay(client, input.projectId, input.studyId,
    input.idempotencyKey, input.requestDigest);
  if (replay) return studyEventResult(client, input.projectId, input.studyId, replay, true);
  const study = await requireStudyProjection(client, input.projectId, input.studyId);
  if (study.state !== "coding_open" || !study.stoppingRule ||
      study.stoppingRule.kind !== input.closeCause || study.currentVersion !== input.expectedVersion) {
    throw repoError("analysis_study_state_conflict", "Study is not at the requested closure head");
  }
  const basis = await client.query(
    `select study.population_id,study.draw_id,study.dataset_revision_id,
            population.frame_digest,draw.draw_digest,draw.method,draw.fixed_budget,
            analysis_recomputed_population_frame_digest_v1(study.population_id) recomputed_frame_digest,
            analysis_population_draw_digest_v1(study.draw_id) recomputed_draw_digest
     from analysis_studies study
     join analysis_populations population on population.id=study.population_id
     join analysis_population_draws draw on draw.id=study.draw_id
     where study.project_id=$1 and study.id=$2`,
    [input.projectId, input.studyId]
  );
  if (!basis.rows[0]) throw repoError("analysis_study_not_found", "Analysis study not found");
  const frame = basis.rows[0];
  const cutoff = study.stoppingRule.kind === "server_deadline" ? study.stoppingRule.closeAt : null;
  const items = await client.query(
    `select item.id,item.draw_item_id,item.case_id,item.position,projection.*
     from analysis_study_items item
     cross join lateral analysis_study_item_projection_v1(item.id,$3::timestamptz) projection
     where item.project_id=$1 and item.study_id=$2 order by item.position`,
    [input.projectId, input.studyId, cutoff]
  );
  const closureId = `asc_${randomUUID()}`;
  const prepared = items.rows.map((row) => {
    const value = {
      studyId: input.studyId, studyItemId: String(row.id), drawItemId: String(row.draw_item_id),
      caseId: String(row.case_id), position: Number(row.position),
      itemState: String(row.item_state) as AnalysisStudyItemProjection["state"],
      itemEventVersion: String(row.current_version), currentEventId: nullableString(row.current_event_id),
      currentEventDigest: nullableString(row.current_event_digest),
      viewEventIds: textArray(row.view_event_ids), viewEventDigests: textArray(row.view_event_digests),
      activeFailureObservationEventIds: textArray(row.active_failure_observation_event_ids),
      activeFailureObservationEventDigests: textArray(row.active_failure_observation_event_digests),
      activeFailureAssignmentEventIds: nullableTextArray(row.active_failure_assignment_event_ids),
      activeFailureAssignmentEventDigests: nullableTextArray(row.active_failure_assignment_event_digests),
      activeNoFailureEventId: nullableString(row.active_no_failure_event_id),
      activeNoFailureEventDigest: nullableString(row.active_no_failure_event_digest),
      completionEventId: nullableString(row.completion_event_id),
      completionEventDigest: nullableString(row.completion_event_digest)
    };
    return { ...value, id: `asci_${randomUUID()}`,
      contentDigest: analysisStudyClosureItemContentDigest(value) };
  });
  if (prepared.length !== Number(frame.fixed_budget)) {
    throw repoError("analysis_study_closure_conflict", "Closure could not snapshot every selected draw item");
  }
  const viewedItemCount = prepared.filter((item) => item.viewEventIds.length > 0).length;
  const completedItemCount = prepared.filter((item) => item.itemState === "completed").length;
  const viewSetDigest = analysisStudyViewSetDigest(prepared.flatMap((item) => item.viewEventDigests));
  const contentDigest = analysisStudyClosureContentDigest(prepared.map((item) => item.contentDigest));
  const methodEligible = String(frame.method) === "simple_random";
  const recomputedFrame = nullableString(frame.recomputed_frame_digest);
  const recomputedDraw = nullableString(frame.recomputed_draw_digest);
  const frameReproducible = recomputedFrame !== null && recomputedFrame === String(frame.frame_digest);
  const drawComplete = recomputedDraw !== null && recomputedDraw === String(frame.draw_digest);
  const codingComplete = drawComplete && completedItemCount === prepared.length;
  const representativeReason = !methodEligible ? "method_not_eligible"
    : !frameReproducible ? "frame_not_reproducible"
      : !drawComplete ? "draw_not_complete"
        : !codingComplete ? "coding_not_complete" : null;
  const closeAt = study.stoppingRule.kind === "server_deadline" ? study.stoppingRule.closeAt : null;
  const closureInsert = await client.query(
    `insert into analysis_study_closures
       (id,project_id,study_id,population_id,draw_id,dataset_revision_id,stopping_rule,
        close_at,close_cause,close_actor_user_id,close_actor_subject_id,close_actor_role,
        close_reason,effective_closed_at,recorded_at,selected_item_count,viewed_item_count,
        completed_item_count,view_set_digest,assessment_version,method,frozen_frame_digest,
        recomputed_frame_digest,frozen_draw_digest,recomputed_draw_digest,method_eligible,
        frame_reproducible,draw_complete,coding_complete,closure_item_count,
        drawn_from_population_id,representative_of_population_id,representative_reason,
        assessment_digest,content_digest,closure_digest,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             coalesce($8,transaction_timestamp()),transaction_timestamp(),$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$4,$29,$30,$31,$32,$33,transaction_timestamp())
     returning *`,
    [closureId, input.projectId, input.studyId, frame.population_id, frame.draw_id,
      frame.dataset_revision_id, study.stoppingRule.kind, closeAt, input.closeCause,
      input.closeActorUserId, input.closeActorSubjectId,
      input.closeCause === "server_deadline" ? "system" : "owner", input.closeReason,
      prepared.length, viewedItemCount, completedItemCount, viewSetDigest,
      ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION, frame.method, frame.frame_digest,
      recomputedFrame, frame.draw_digest, recomputedDraw, methodEligible, frameReproducible,
      drawComplete, codingComplete, prepared.length,
      representativeReason === null ? frame.population_id : null, representativeReason,
      PLACEHOLDER_DIGEST, contentDigest, PLACEHOLDER_DIGEST]
  );
  const closure = closureInsert.rows[0];
  for (const item of prepared) {
    await client.query(
      `insert into analysis_study_closure_items
         (id,project_id,study_id,closure_id,study_item_id,draw_item_id,case_id,position,
          item_state,item_event_version,current_event_id,current_event_digest,
          active_failure_observation_event_ids,active_failure_observation_event_digests,
          active_failure_assignment_event_ids,active_failure_assignment_event_digests,
          active_no_failure_event_id,active_no_failure_event_digest,completion_event_id,
          completion_event_digest,view_event_ids,view_event_digests,content_digest,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
               $20,$21,$22,$23,$24)`,
      [item.id, input.projectId, input.studyId, closureId, item.studyItemId, item.drawItemId,
        item.caseId, item.position, item.itemState, item.itemEventVersion, item.currentEventId,
        item.currentEventDigest, item.activeFailureObservationEventIds,
        item.activeFailureObservationEventDigests, item.activeFailureAssignmentEventIds,
        item.activeFailureAssignmentEventDigests, item.activeNoFailureEventId,
        item.activeNoFailureEventDigest, item.completionEventId, item.completionEventDigest,
        item.viewEventIds, item.viewEventDigests, item.contentDigest, closure.created_at]
    );
  }
  const eventResult = await client.query(
    `insert into analysis_study_events
       (id,project_id,study_id,version,predecessor_event_id,predecessor_event_digest,
        event_type,from_state,to_state,stopping_rule,close_at,close_cause,closure_id,
        closure_digest,expected_closure_digest,reason,actor_subject_id,actor_user_id,
        actor_role,idempotency_key,request_digest,event_digest,occurred_at)
     values ($1,$2,$3,$4,$5,$6,'coding_closed','coding_open','coding_closed',null,null,$7,$8,
             $9,null,$10,$11,$12,$13,$14,$15,$16,transaction_timestamp()) returning *`,
    [`ase_${randomUUID()}`, input.projectId, input.studyId,
      (BigInt(study.currentVersion) + 1n).toString(), study.currentEventId,
      study.currentEventDigest, input.closeCause, closureId, closure.closure_digest,
      input.closeReason, input.closeActorSubjectId, input.closeActorUserId,
      input.closeCause === "server_deadline" ? "system" : "owner", input.idempotencyKey,
      input.requestDigest, PLACEHOLDER_DIGEST]
  );
  const result = await studyEventResult(client, input.projectId, input.studyId,
    rowToStudyEvent(eventResult.rows[0]), false);
  await client.query(`select analysis_clear_deadline_retry_v1($1,$2)`, [input.projectId, input.studyId]);
  return result;
}

export async function closeIfDue(client: PoolClient, studyId: string, expectedProjectId: string | null): Promise<boolean> {
  if (expectedProjectId !== null) {
    const owned = await client.query(`select 1 from analysis_studies where id=$1 and project_id=$2`,
      [studyId, expectedProjectId]);
    if (!owned.rows[0]) return false;
  }
  await lockStudy(client, studyId);
  const due = await client.query(
    `select study.project_id,projection.current_version,opened.close_at
     from analysis_studies study
     cross join lateral analysis_study_projection_v1(study.id) projection
     join analysis_study_events opened on opened.study_id=study.id and opened.event_type='coding_opened'
     where study.id=$1 and ($2::text is null or study.project_id=$2) and projection.state='coding_open'
       and opened.stopping_rule='server_deadline' and opened.close_at<=clock_timestamp()`,
    [studyId, expectedProjectId]
  );
  if (!due.rows[0]) return false;
  const row = due.rows[0];
  const expectedVersion = String(row.current_version);
  const key = stableId("analysis-deadline-close", studyId, iso(row.close_at));
  const requestDigest = analysisStudyEventRequestDigest({ studyId, expectedVersion,
    eventType: "coding_closed", reason: null });
  await materializeClosure(client, { projectId: String(row.project_id), studyId,
    idempotencyKey: key, requestDigest, closeCause: "server_deadline",
    closeActorUserId: null, closeActorSubjectId: null, closeReason: null, expectedVersion });
  return true;
}

export function itemEventColumns(input: AnalysisStudyItemEventInput): {
  targetEventId: string | null; targetEventDigest: string | null;
  failureLabel: string | null; rationale: string | null;
  anchorKind: "case_output" | "step" | null; anchorStepIndex: number | null;
} {
  if (input.eventType === "failure_observed") return {
    targetEventId: null, targetEventDigest: null, failureLabel: input.failureLabel,
    rationale: input.rationale, anchorKind: input.evidenceAnchor.kind,
    anchorStepIndex: input.evidenceAnchor.kind === "step" ? input.evidenceAnchor.stepIndex : null
  };
  if (input.eventType === "failure_withdrawn" || input.eventType === "no_failure_withdrawn" ||
      input.eventType === "coding_reopened") return {
    targetEventId: input.targetEventId, targetEventDigest: input.targetEventDigest,
    failureLabel: null, rationale: input.rationale, anchorKind: null, anchorStepIndex: null
  };
  if (input.eventType === "no_failure_observed") return {
    targetEventId: null, targetEventDigest: null, failureLabel: null,
    rationale: input.rationale, anchorKind: null, anchorStepIndex: null
  };
  return { targetEventId: null, targetEventDigest: null, failureLabel: null,
    rationale: null, anchorKind: null, anchorStepIndex: null };
}

async function lockStudy(client: PoolClient, studyId: string): Promise<void> {
  await client.query(`select analysis_study_lock_v1($1)`, [studyId]);
}

export async function lockOwnedStudy(client: PoolClient, projectId: string, studyId: string): Promise<boolean> {
  const owned = await client.query(
    `select 1 from analysis_studies where project_id=$1 and id=$2`,
    [projectId, studyId]
  );
  if (!owned.rows[0]) return false;
  await lockStudy(client, studyId);
  return true;
}

export async function lockOwnedTaxonomy(client: PoolClient, projectId: string, taxonomyId: string): Promise<boolean> {
  const owned = await client.query(
    `select 1 from analysis_failure_taxonomies where project_id=$1 and id=$2`,
    [projectId, taxonomyId]
  );
  if (!owned.rows[0]) return false;
  await client.query(`select analysis_taxonomy_lock_v1($1)`, [taxonomyId]);
  return true;
}

export async function requireProjectRole(
  db: Pool | PoolClient,
  projectId: string,
  userId: string,
  required?: "owner"
): Promise<void> {
  const result = await db.query(`select role from project_members where project_id=$1 and user_id=$2`, [projectId, userId]);
  const role = result.rows[0]?.role ? String(result.rows[0].role) : null;
  if (!role || (required === "owner" && role !== "owner")) {
    throw repoError("analysis_study_forbidden", "Analysis study access is forbidden");
  }
}

export async function ensureGovernedSubject(client: PoolClient, projectId: string, userId: string): Promise<string> {
  const subjectId = stableId("grs", projectId, userId);
  await client.query(
    `insert into governed_reviewer_subjects (id,project_id,account_user_id,subject_digest)
     values ($1,$2,$3,governed_content_v1_digest(
       'governed-reviewer-subject/v1',jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
     )) on conflict (project_id,account_user_id) where account_user_id is not null do nothing`,
    [subjectId, projectId, userId]
  );
  const result = await client.query(`select id from governed_reviewer_subjects where project_id=$1 and account_user_id=$2`, [projectId, userId]);
  if (!result.rows[0]) throw repoError("analysis_study_forbidden", "A governed project subject is required");
  return String(result.rows[0].id);
}

export function requireOwnerActor(actor: AnalysisStudyActor): void {
  if (actor.projectRole !== "owner") throw repoError("analysis_study_forbidden", "Only project owners may administer analysis studies");
}

export async function studyExists(db: Pool | PoolClient, projectId: string, studyId: string): Promise<boolean> {
  const result = await db.query(`select 1 from analysis_studies where project_id=$1 and id=$2`, [projectId, studyId]);
  return Boolean(result.rows[0]);
}

export async function itemExists(db: Pool | PoolClient, projectId: string, studyId: string, itemId: string): Promise<boolean> {
  const result = await db.query(`select 1 from analysis_study_items where project_id=$1 and study_id=$2 and id=$3`, [projectId, studyId, itemId]);
  return Boolean(result.rows[0]);
}

export async function taxonomyExists(db: Pool | PoolClient, projectId: string, taxonomyId: string): Promise<boolean> {
  const result = await db.query(`select 1 from analysis_failure_taxonomies where project_id=$1 and id=$2`, [projectId, taxonomyId]);
  return Boolean(result.rows[0]);
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

export function decodeCursor(value: string | null, scope: string, kind: CursorValue["kind"]): CursorValue | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.kind !== kind || typeof parsed.primary !== "string" ||
        parsed.primary.length < 1 || parsed.primary.length > 240) throw new Error("shape");
    if (kind === "chronological") {
      if (typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 240 ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.primary) ||
          !Number.isFinite(Date.parse(parsed.primary))) throw new Error("chronological");
      return { kind, primary: parsed.primary, id: parsed.id };
    }
    if (!/^(0|[1-9][0-9]*)$/.test(parsed.primary)) throw new Error("numeric");
    if (kind === "version" && !decimalAtMost(parsed.primary, ANALYSIS_MAX_EVENT_VERSION)) {
      throw new Error("version domain");
    }
    if (kind === "position" && !decimalAtMost(parsed.primary, String(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1))) {
      throw new Error("position domain");
    }
    if (kind === "sequence" && !decimalAtMost(parsed.primary, String(ANALYSIS_MAX_TAXONOMY_REVISIONS))) {
      throw new Error("sequence domain");
    }
    return { kind, primary: parsed.primary };
  } catch {
    throw repoError("analysis_study_invalid_cursor", `Invalid ${scope} cursor`);
  }
}

function decimalAtMost(value: string, maximum: string): boolean {
  return value.length < maximum.length || (value.length === maximum.length && value <= maximum);
}

export function withoutIdempotency<T extends { idempotencyKey: string }>(input: T): Omit<T, "idempotencyKey"> {
  const { idempotencyKey: _idempotencyKey, ...request } = input;
  return request;
}

export function repoError(
  code: ConstructorParameters<typeof AnalysisStudyRepositoryError>[0],
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): AnalysisStudyRepositoryError {
  return new AnalysisStudyRepositoryError(code, message, details);
}

export function mapPgError(error: unknown): unknown {
  if (error instanceof AnalysisStudyRepositoryError) return error;
  const pg = error as { code?: string; message?: string; constraint?: string };
  const message = pg?.message ?? (error instanceof Error ? error.message : String(error));
  if (pg?.code === "23505" && /idempotency|draw_id|project_id.*unique/i.test(`${pg.constraint ?? ""} ${message}`)) {
    return repoError("analysis_study_idempotency_conflict", "Analysis study command conflict");
  }
  if (/anchor/i.test(message)) return repoError("analysis_study_anchor_invalid", "Evidence anchor is absent from the frozen payload");
  if (/server deadline must be a future/i.test(message)) {
    return repoError("analysis_study_deadline_invalid", "Study deadline must be a future millisecond-normalized timestamp");
  }
  if (/assignment/i.test(message) && /compare-and-swap|version|head mismatch/i.test(message)) {
    return repoError("analysis_assignment_conflict", "Observation assignment compare-and-swap conflict");
  }
  if (/compare-and-swap|version|head mismatch/i.test(message)) {
    return repoError("analysis_study_version_conflict", "Analysis study compare-and-swap conflict");
  }
  if (/assignment/i.test(message) && (pg?.code === "23514" || pg?.code === "23503" || pg?.code === "23505")) {
    return repoError("analysis_assignment_conflict", "Observation assignment conflicts with immutable coding state");
  }
  if (/taxonomy/i.test(message) && (pg?.code === "23514" || pg?.code === "23503" || pg?.code === "23505")) {
    return repoError("analysis_taxonomy_conflict", "Failure taxonomy command conflicts with immutable taxonomy state");
  }
  if (pg?.code === "23514" || pg?.code === "23503" || pg?.code === "55000" || pg?.code === "40001") {
    return repoError("analysis_study_state_conflict", "Analysis study command conflicts with immutable study state");
  }
  return error;
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 32)}`;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function nullableTextArray(value: unknown): (string | null)[] {
  return Array.isArray(value) ? value.map(nullableString) : [];
}

export function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
