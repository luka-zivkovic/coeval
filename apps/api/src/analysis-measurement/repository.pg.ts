import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ANALYSIS_TAXONOMY_COVERAGE_VERSION,
  ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION,
  ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION,
  AnalysisTaxonomyCoverageSchema,
  AnalysisWorkflowMeasurementReportSchema,
  type AnalysisCalibrationMeasurement,
  type AnalysisWorkflowMeasurementReport,
  type BinaryCalibrationArtifact
} from "@coeval/shared";
import { parseCanonicalBinaryCalibrationArtifactBytes } from "../lib/binary-calibration.js";
import {
  analysisWorkflowMeasurementReportDigest,
  analysisCalibrationTrialMeasurements,
  deriveAnalysisGovernedDisagreement,
  deriveAnalysisTaxonomyChurn,
  exactDurationMilliseconds,
  verifyAnalysisWorkflowMeasurementReport,
  type GovernedDisagreementItemInput,
  type TaxonomyChurnCodeInput
} from "../lib/analysis-measurement.js";
import {
  AnalysisMeasurementRepositoryError,
  type AnalysisMeasurementAccess,
  type AnalysisMeasurementQuery,
  type AnalysisMeasurementRepository
} from "./repository.js";

interface StudyRow extends Record<string, unknown> {
  id: unknown;
  project_id: unknown;
  population_id: unknown;
  draw_id: unknown;
  dataset_revision_id: unknown;
  created_at: unknown;
  state: unknown;
  selected_item_count: unknown;
  viewed_item_count: unknown;
  in_progress_item_count: unknown;
  completed_item_count: unknown;
  no_failure_item_count: unknown;
  missing_item_count: unknown;
  calculated_at: unknown;
}

export class PgAnalysisMeasurementRepository implements AnalysisMeasurementRepository {
  constructor(private readonly pool: Pool) {}

  async getReport(
    access: AnalysisMeasurementAccess,
    studyId: string,
    query: AnalysisMeasurementQuery
  ): Promise<AnalysisWorkflowMeasurementReport | null> {
    if (query.calibrationArtifactId && !query.skillVersionId) {
      throw repoError("invalid_binding", "A calibration artifact requires an exact evaluator version binding");
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const study = await loadStudy(client, access.projectId, studyId);
      if (!study) {
        await client.query("rollback");
        return null;
      }
      const taxonomy = query.taxonomyRevisionId
        ? await loadTaxonomyMeasurement(client, access.projectId, studyId, query.taxonomyRevisionId)
        : { state: "not_requested" as const };
      const evaluatorOptions = await loadEvaluatorOptions(client, access.projectId, studyId);
      const evaluator = query.skillVersionId
        ? await loadEvaluatorMeasurement(client, access.projectId, study, query.skillVersionId, query.calibrationArtifactId)
        : null;
      const content = {
        contractVersion: ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION,
        calculationVersion: ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION,
        projectId: access.projectId,
        studyId,
        populationId: String(study.population_id),
        drawId: String(study.draw_id),
        datasetRevisionId: String(study.dataset_revision_id),
        studyCreatedAt: iso(study.created_at),
        studyState: String(study.state) as AnalysisWorkflowMeasurementReport["studyState"],
        coding: {
          selectedItemCount: Number(study.selected_item_count),
          viewedItemCount: Number(study.viewed_item_count),
          inProgressItemCount: Number(study.in_progress_item_count),
          completedItemCount: Number(study.completed_item_count),
          noFailureObservedItemCount: Number(study.no_failure_item_count),
          missingItemCount: Number(study.missing_item_count)
        },
        taxonomy,
        evaluatorOptions,
        evaluator
      };
      const report = AnalysisWorkflowMeasurementReportSchema.parse({
        ...content,
        reportDigest: analysisWorkflowMeasurementReportDigest(content),
        calculatedAt: iso(study.calculated_at)
      });
      await client.query("commit");
      return verifyAnalysisWorkflowMeasurementReport(report);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadEvaluatorOptions(client: PoolClient, projectId: string, studyId: string) {
  const rows = (await client.query(
    `select lifecycle.id as lifecycle_id,lifecycle.promotion_id,lifecycle.criterion_id,
            lifecycle.criterion_version_id,lifecycle.skill_id,lifecycle.skill_version_id
     from evaluator_lifecycles lifecycle
     join analysis_criterion_promotions promotion
       on promotion.id=lifecycle.promotion_id and promotion.project_id=lifecycle.project_id
     where lifecycle.project_id=$1 and promotion.study_id=$2
     order by lifecycle.created_at,lifecycle.id`, [projectId, studyId]
  )).rows;
  if (rows.length > 1_000) throw repoError("evidence_unavailable", "Study evaluator measurement roster exceeds the bounded contract");
  return rows.map((row) => ({
    lifecycleId: String(row.lifecycle_id),
    promotionId: String(row.promotion_id),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    skillId: String(row.skill_id),
    skillVersionId: String(row.skill_version_id)
  }));
}

async function loadStudy(client: PoolClient, projectId: string, studyId: string): Promise<StudyRow | null> {
  const row = (await client.query<StudyRow>(
    `select study.id,study.project_id,study.population_id,study.draw_id,study.dataset_revision_id,
            study.created_at,study_projection.state,
            count(item.id)::integer as selected_item_count,
            count(item.id) filter (where cardinality(item_projection.view_event_ids)>0)::integer as viewed_item_count,
            count(item.id) filter (where item_projection.item_state='in_progress')::integer as in_progress_item_count,
            count(item.id) filter (where item_projection.item_state='completed')::integer as completed_item_count,
            count(item.id) filter (where item_projection.active_no_failure_event_id is not null)::integer as no_failure_item_count,
            count(item.id) filter (where item_projection.item_state='uncoded')::integer as missing_item_count,
            date_trunc('milliseconds',clock_timestamp()) as calculated_at
     from analysis_studies study
     cross join lateral analysis_study_projection_v1(study.id) study_projection
     join analysis_study_items item on item.study_id=study.id and item.project_id=study.project_id
     cross join lateral analysis_study_item_projection_v1(item.id,null) item_projection
     where study.project_id=$1 and study.id=$2
     group by study.id,study_projection.state`, [projectId, studyId]
  )).rows[0];
  return row ?? null;
}

async function loadTaxonomyMeasurement(
  client: PoolClient,
  projectId: string,
  studyId: string,
  revisionId: string
): Promise<AnalysisWorkflowMeasurementReport["taxonomy"]> {
  const revision = (await client.query(
    `select revision.*,taxonomy.id as exact_taxonomy_id
     from analysis_failure_taxonomy_revisions revision
     join analysis_failure_taxonomies taxonomy
       on taxonomy.id=revision.taxonomy_id and taxonomy.project_id=revision.project_id
     where revision.project_id=$1 and revision.id=$2`, [projectId, revisionId]
  )).rows[0];
  if (!revision) throw repoError("not_found", "Analysis taxonomy revision was not found");
  const coverageRow = (await client.query(
    `select coverage.* from analysis_taxonomy_coverage_v1($1,$2) coverage`, [studyId, revisionId]
  )).rows[0];
  if (!coverageRow || String(coverageRow.project_id) !== projectId) {
    throw repoError("invalid_binding", "Taxonomy revision does not belong to the measurement study project");
  }
  const coverage = AnalysisTaxonomyCoverageSchema.parse({
    projectId,
    studyId,
    taxonomyId: String(coverageRow.taxonomy_id),
    taxonomyRevisionId: revisionId,
    taxonomyRevisionSequence: Number(coverageRow.taxonomy_revision_sequence),
    calculationVersion: ANALYSIS_TAXONOMY_COVERAGE_VERSION,
    selectedItemCount: Number(coverageRow.selected_item_count),
    completedItemCount: Number(coverageRow.completed_item_count),
    noFailureObservedItemCount: Number(coverageRow.no_failure_observed_item_count),
    activeFailureObservationCount: String(coverageRow.active_failure_observation_count),
    categorized: String(coverageRow.categorized),
    assignedToRetiredCode: String(coverageRow.assigned_to_retired_code),
    uncategorized: String(coverageRow.uncategorized),
    categorizedItemCount: Number(coverageRow.categorized_item_count),
    assignedToRetiredCodeItemCount: Number(coverageRow.assigned_to_retired_code_item_count),
    uncategorizedItemCount: Number(coverageRow.uncategorized_item_count)
  });
  const currentCodes = await loadTaxonomyCodes(client, projectId, revisionId);
  const predecessorCodes = revision.predecessor_revision_id
    ? await loadTaxonomyCodes(client, projectId, String(revision.predecessor_revision_id))
    : [];
  const reassignmentCount = Number((await client.query(
    `select count(*)::integer as count from analysis_observation_assignment_events assignment
     where assignment.project_id=$1 and assignment.study_id=$2
       and assignment.taxonomy_id=$3 and assignment.taxonomy_revision_id=$4
       and assignment.version>1`,
    [projectId, studyId, revision.taxonomy_id, revisionId]
  )).rows[0]?.count ?? 0);
  const churn = deriveAnalysisTaxonomyChurn({
    taxonomyRevisionId: revisionId,
    taxonomyRevisionDigest: String(revision.revision_digest),
    taxonomyRevisionSequence: Number(revision.sequence),
    predecessorRevisionId: nullableString(revision.predecessor_revision_id),
    predecessorRevisionDigest: nullableString(revision.predecessor_revision_digest),
    currentCodes,
    predecessorCodes,
    observationReassignments: reassignmentCount
  });
  return { state: "available", coverage, churn };
}

async function loadTaxonomyCodes(
  client: PoolClient,
  projectId: string,
  revisionId: string
): Promise<TaxonomyChurnCodeInput[]> {
  const rows = (await client.query(
    `select code_id,label,definition,status
     from analysis_failure_taxonomy_revision_codes
     where project_id=$1 and taxonomy_revision_id=$2 order by position`, [projectId, revisionId]
  )).rows;
  return rows.map((row) => ({
    codeId: String(row.code_id),
    label: String(row.label),
    definition: String(row.definition),
    status: row.status === "retired" ? "retired" : "active"
  }));
}

async function loadEvaluatorMeasurement(
  client: PoolClient,
  projectId: string,
  study: StudyRow,
  skillVersionId: string,
  artifactId: string | null
): Promise<NonNullable<AnalysisWorkflowMeasurementReport["evaluator"]>> {
  const lifecycle = (await client.query(
    `select lifecycle.*,promotion.study_id
     from evaluator_lifecycles lifecycle
     join analysis_criterion_promotions promotion
       on promotion.id=lifecycle.promotion_id and promotion.project_id=lifecycle.project_id
     where lifecycle.project_id=$1 and lifecycle.skill_version_id=$2 and promotion.study_id=$3`,
    [projectId, skillVersionId, study.id]
  )).rows[0];
  if (!lifecycle) throw repoError("not_found", "Evaluator lifecycle was not found for the exact analysis study");
  const disagreement = await loadDisagreement(
    client,
    projectId,
    String(lifecycle.governed_batch_id),
    String(lifecycle.governed_batch_digest)
  );
  const calibration = await loadCalibration(
    client,
    projectId,
    skillVersionId,
    String(lifecycle.criterion_id),
    String(lifecycle.criterion_version_id),
    artifactId
  );
  const durations = await loadArtifactDurations(client, projectId, skillVersionId, iso(study.created_at));
  return {
    lifecycleId: String(lifecycle.id),
    promotionId: String(lifecycle.promotion_id),
    criterionId: String(lifecycle.criterion_id),
    criterionVersionId: String(lifecycle.criterion_version_id),
    skillId: String(lifecycle.skill_id),
    skillVersionId: String(lifecycle.skill_version_id),
    governedDisagreement: disagreement,
    calibration,
    ...durations
  };
}

async function loadDisagreement(
  client: PoolClient,
  projectId: string,
  batchId: string,
  batchDigest: string
) {
  const rows = (await client.query(
    `select item.id,batch.required_labels_per_item,
            (select count(*)::integer from governed_review_tasks task
             where task.batch_item_id=item.id) as assigned_task_count,
            coalesce((select array_agg(active.label order by active.task_id)
                      from governed_active_review_labels active
                      where active.batch_item_id=item.id),'{}'::text[]) as active_labels,
            (select adjudication.decision from governed_review_adjudications adjudication
             where adjudication.batch_item_id=item.id
               and not exists (select 1 from governed_review_adjudications successor
                               where successor.supersedes_adjudication_id=adjudication.id)
             limit 1) as adjudication_decision
     from governed_review_batches batch
     join governed_review_batch_items item on item.batch_id=batch.id and item.project_id=batch.project_id
     where batch.project_id=$1 and batch.id=$2
     order by item.draw_position,item.id`, [projectId, batchId]
  )).rows;
  if (rows.length === 0) throw repoError("evidence_unavailable", "Governed disagreement evidence has no selected items");
  const items: GovernedDisagreementItemInput[] = rows.map((row) => ({
    requiredLabelCount: Number(row.required_labels_per_item),
    assignedTaskCount: Number(row.assigned_task_count),
    activeLabels: textArray(row.active_labels).map((label) => {
      if (label !== "pass" && label !== "fail" && label !== "cannot_determine") {
        throw new Error("Governed disagreement contains an unknown label");
      }
      return label;
    }),
    adjudicationDecision: row.adjudication_decision === "pass" || row.adjudication_decision === "fail" ||
      row.adjudication_decision === "unresolvable" ? row.adjudication_decision : null
  }));
  return deriveAnalysisGovernedDisagreement(batchId, batchDigest, items);
}

async function loadCalibration(
  client: PoolClient,
  projectId: string,
  skillVersionId: string,
  criterionId: string,
  criterionVersionId: string,
  requestedArtifactId: string | null
): Promise<AnalysisCalibrationMeasurement> {
  const row = (await client.query(
    `select run.*,artifact.canonical_bytes,artifact.artifact_digest as stored_artifact_digest,
            artifact.evidence_digest as stored_evidence_digest,artifact.created_at as artifact_created_at,
            artifact.status as artifact_status
     from binary_calibration_runs run
     left join binary_calibration_artifacts artifact on artifact.id=run.artifact_id
     where run.project_id=$1 and run.skill_version_id=$2
       and ($3::text is null or artifact.id=$3)
     order by run.created_at desc,run.id desc limit 1`, [projectId, skillVersionId, requestedArtifactId]
  )).rows[0];
  if (!row) {
    if (requestedArtifactId) throw repoError("not_found", "Calibration artifact was not found for the exact evaluator version");
    return { state: "missing" };
  }
  const state = String(row.state);
  const common = {
    calibrationRunId: String(row.id),
    runCreatedAt: iso(row.created_at),
    plannedObservations: Number(row.planned_observations),
    accountedObservations: Number(row.accounted_observations)
  };
  if (state !== "complete" && state !== "incomplete") {
    if (state !== "queued" && state !== "running" && state !== "recovery_required" && state !== "rejected") {
      throw new Error("Binary calibration run has an unknown state");
    }
    return {
      state,
      ...common,
      rejectionReason: state === "rejected" ? nullableString(row.rejection_reason) : null
    };
  }
  if (!row.canonical_bytes || !row.artifact_id) {
    throw repoError("evidence_unavailable", "Terminal calibration run is missing its public aggregate artifact");
  }
  const bytes = Uint8Array.from(Buffer.from(row.canonical_bytes as Uint8Array));
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== String(row.stored_artifact_digest)) {
    throw repoError("evidence_unavailable", "Calibration artifact bytes do not match the stored digest");
  }
  const artifact = parseCanonicalBinaryCalibrationArtifactBytes(bytes);
  assertArtifactBinding(artifact, row, projectId, skillVersionId, criterionId, criterionVersionId);
  const current = await currentArtifactStatus(client, projectId, String(row.artifact_id));
  return {
    state: artifact.status,
    ...common,
    artifactId: artifact.artifactId,
    artifactDigest: digest,
    evidenceDigest: artifact.evidenceDigest,
    artifactCreatedAt: iso(row.artifact_created_at),
    currentAdmissibility: current.status,
    currentAdmissibilityReasons: current.reasons,
    positiveClass: artifact.positiveClass,
    truthSupport: artifact.truthSupport,
    trials: analysisCalibrationTrialMeasurements(artifact)
  };
}

function assertArtifactBinding(
  artifact: BinaryCalibrationArtifact,
  row: Record<string, unknown>,
  projectId: string,
  skillVersionId: string,
  criterionId: string,
  criterionVersionId: string
): void {
  if (artifact.projectId !== projectId || artifact.artifactId !== String(row.artifact_id) ||
      artifact.calibrationRunId !== String(row.id) || artifact.evaluator.skillVersionId !== skillVersionId ||
      artifact.criterion.criterionId !== criterionId ||
      artifact.criterion.criterionVersionId !== criterionVersionId ||
      artifact.evidenceDigest !== String(row.stored_evidence_digest) || artifact.status !== row.artifact_status) {
    throw repoError("evidence_unavailable", "Calibration artifact identity does not match its retained run evidence");
  }
}

async function currentArtifactStatus(client: PoolClient, projectId: string, artifactId: string): Promise<{
  status: "admissible" | "revoked" | "unknown";
  reasons: Array<"development_exposure" | "provider_policy_invalidated" | "provenance_invalidated" |
    "artifact_superseded" | "current_status_unavailable">;
}> {
  const row = (await client.query(
    `select artifact.status,completion.recorded_at,run.dataset_revision_id,
            coalesce(array_agg(distinct revocation.reason order by revocation.reason)
              filter (where revocation.reason is not null),'{}'::text[]) as reasons,
            exists(select 1 from dataset_exposure_events exposure
                   where exposure.revision_id=run.dataset_revision_id
                     and exposure.occurred_at>=completion.recorded_at
                     and (exposure.exposure_class='development' or exposure.activity in (
                       'declassify','analysis_authoring','rubric_authoring','prompt_tuning',
                       'example_selection','model_selection','development_run','regression_run'
                     ))) as later_development_exposure
     from binary_calibration_artifacts artifact
     join binary_calibration_runs run on run.id=artifact.run_id
     join binary_calibration_exposure_checks completion
       on completion.id=run.completion_check_id and completion.phase='completion'
     left join binary_calibration_revocation_events revocation on revocation.artifact_id=artifact.id
     where artifact.project_id=$1 and artifact.id=$2
     group by artifact.status,completion.recorded_at,run.dataset_revision_id`, [projectId, artifactId]
  )).rows[0];
  if (!row) throw repoError("evidence_unavailable", "Calibration current-status evidence is unavailable");
  const reasons = textArray(row.reasons) as Array<"development_exposure" | "provider_policy_invalidated" |
    "provenance_invalidated" | "artifact_superseded" | "current_status_unavailable">;
  if (row.later_development_exposure === true && !reasons.includes("development_exposure")) {
    reasons.push("development_exposure");
  }
  reasons.sort();
  if (reasons.includes("current_status_unavailable")) return { status: "unknown", reasons };
  return { status: reasons.length === 0 ? "admissible" : "revoked", reasons };
}

async function loadArtifactDurations(
  client: PoolClient,
  projectId: string,
  skillVersionId: string,
  studyCreatedAt: string
): Promise<Pick<NonNullable<AnalysisWorkflowMeasurementReport["evaluator"]>,
  "timeToFirstCompletedCalibrationArtifact" | "timeToFirstCurrentlyAdmissibleCalibrationArtifact">> {
  const rows = (await client.query(
    `select artifact.id,artifact.created_at,artifact.status,completion.recorded_at,run.dataset_revision_id,
            exists(select 1 from binary_calibration_revocation_events revocation
                   where revocation.artifact_id=artifact.id) as explicitly_revoked,
            exists(select 1 from dataset_exposure_events exposure
                   where exposure.revision_id=run.dataset_revision_id
                     and exposure.occurred_at>=completion.recorded_at
                     and (exposure.exposure_class='development' or exposure.activity in (
                       'declassify','analysis_authoring','rubric_authoring','prompt_tuning',
                       'example_selection','model_selection','development_run','regression_run'
                     ))) as later_development_exposure
     from binary_calibration_artifacts artifact
     join binary_calibration_runs run on run.id=artifact.run_id
     join binary_calibration_exposure_checks completion
       on completion.id=run.completion_check_id and completion.phase='completion'
     where artifact.project_id=$1 and run.skill_version_id=$2 and artifact.status='complete'
     order by artifact.created_at,artifact.id`, [projectId, skillVersionId]
  )).rows;
  const historical = rows[0];
  const admissible = rows.find((row) => row.explicitly_revoked !== true && row.later_development_exposure !== true);
  return {
    timeToFirstCompletedCalibrationArtifact: historical ? {
      state: "defined",
      artifactId: String(historical.id),
      artifactCreatedAt: iso(historical.created_at),
      durationMilliseconds: exactDurationMilliseconds(studyCreatedAt, iso(historical.created_at))
    } : { state: "missing" },
    timeToFirstCurrentlyAdmissibleCalibrationArtifact: admissible ? {
      state: "defined",
      artifactId: String(admissible.id),
      artifactCreatedAt: iso(admissible.created_at),
      durationMilliseconds: exactDurationMilliseconds(studyCreatedAt, iso(admissible.created_at))
    } : { state: "missing" }
  };
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid measurement timestamp");
  return date.toISOString();
}

function repoError(
  code: ConstructorParameters<typeof AnalysisMeasurementRepositoryError>[0],
  message: string
): AnalysisMeasurementRepositoryError {
  return new AnalysisMeasurementRepositoryError(code, message);
}
