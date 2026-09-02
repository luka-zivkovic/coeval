import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  type BinaryCalibrationCompletionEligibilityReason,
  type ModelBinding
} from "@coeval/shared";

import { canonicalJson, sha256Digest, skillDigest } from "../lib/assessment-receipt.js";

import { evaluatorOutputContractDigest } from "../lib/evaluator-suite.js";
import { governedContentV1Digest } from "../lib/governed-content-digest.js";
import type {
  BinaryCalibrationAuthorizedRun,
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationProviderDataHandlingPolicy,
  CreateBinaryCalibrationRunInput
} from "./repository.js";

import {
  COVERED_CAPABILITIES,
  Db,
  EligibilityResult,
  FrozenOriginRow,
  RunRow,
  isEmptyObject,
  isString,
  nullableString,
  parseJson,
  providerPolicyFor,
  repoError,
  requestedBindingFor,
  requestedBindingFromRun,
  skillVersionFromRow,
  stableId,
  toIso
} from "./repository.pg-support.js";

export async function deriveRunIdentity(
  client: PoolClient,
  projectId: string,
  input: CreateBinaryCalibrationRunInput
) {
  const result = await client.query(
    `select revision.id as revision_id,revision.revision_digest,revision.content_digest,
            revision.item_count,revision.role,revision.source_kind,revision.provenance_level,
            revision.criterion_version_id,
            criterion.criterion_id,criterion.criterion_digest,
            skill.id as skill_id,version.*,
            batch.id as batch_id,batch.content_digest as batch_content_digest,
            batch.instruction_version_id,batch.population_id,batch.population_digest,
            batch.source_population_id,batch.population_definition,batch.population_collection_provenance,
            batch.population_size,batch.selection_method,batch.selection_seed,batch.rng_version,
            batch.draw_executed_by,batch.fixed_budget,batch.draw_digest,batch.strata,
            batch.custodian_subject_id,
            instruction.content_digest as instruction_digest
     from dataset_revisions revision
     join criterion_versions criterion on criterion.id=revision.criterion_version_id
     join skill_versions version
       on version.id=$3 and version.project_id=revision.project_id
      and version.criterion_version_id=revision.criterion_version_id
     join skills skill on skill.id=version.skill_id and skill.criterion_id=criterion.criterion_id
     join governed_review_batch_events frozen
       on frozen.dataset_revision_id=revision.id and frozen.event_kind='frozen'
     join governed_review_batches batch on batch.id=frozen.batch_id
     join review_instruction_versions instruction on instruction.id=batch.instruction_version_id
     where revision.id=$1 and revision.project_id=$2
       and governed_review_current_batch_state(batch.id)='frozen'`,
    [input.datasetRevisionId, projectId, input.skillVersionId]
  );
  if (result.rows.length !== 1) {
    throw repoError("ineligible", "calibration requires one frozen governed truth origin and exact evaluator criterion");
  }
  const row = result.rows[0];
  if (row.role !== "sealed_validation" || row.source_kind !== "sealed_intake" ||
      row.provenance_level !== "governed_blind") {
    throw repoError("ineligible", "calibration requires sealed governed-blind truth");
  }
  if (Number(row.item_count) < 1 || Number(row.item_count) > 5_000 ||
      Number(row.fixed_budget) !== Number(row.item_count)) {
    throw repoError("ineligible", "calibration truth support must be a complete governed selection of at most 5,000 items");
  }
  const skillVersion = skillVersionFromRow(row);
  if (skillVersion.verdictKind !== "binary") {
    throw repoError("unsupported", "binary calibration requires a binary evaluator version");
  }
  if (skillVersion.modelBinding.topP !== undefined) {
    throw repoError("unsupported", "sealed calibration v1 does not execute a top-p binding until every provider preserves it exactly");
  }
  const requestedBinding = requestedBindingFor(skillVersion.modelBinding);
  const providerPolicy = providerPolicyFor(requestedBinding);
  const providerPolicyBytes = Buffer.from(canonicalJson({
    contract: "coeval/provider-data-handling-policy/v1",
    schemaVersion: 1,
    provider: requestedBinding.provider,
    endpointKind: requestedBinding.endpointKind,
    baseUrlDigest: requestedBinding.baseUrlDigest,
    executionEnvironment: providerPolicy.executionEnvironment,
    payloadTransmission: providerPolicy.payloadTransmission,
    rawProviderResponsePersistence: "none"
  }), "utf8");

  let suiteBinding: { manifestId: string; manifestDigest: string; memberPosition: number } | null = null;
  if (input.suiteBinding) {
    const suite = await client.query(
      `select manifest.manifest_digest,manifest.trial_plan,member.skill_version_id,
              member.criterion_version_id,member.skill_digest,member.output_contract_digest
       from evaluator_suite_manifests manifest
       join evaluator_suite_manifest_members member
         on member.manifest_id=manifest.id and member.position=$3
       where manifest.id=$1 and manifest.project_id=$2`,
      [input.suiteBinding.manifestId, projectId, input.suiteBinding.memberPosition]
    );
    const member = suite.rows[0];
    if (!member || canonicalJson(parseJson(member.trial_plan)) !== "null" ||
        String(member.skill_version_id) !== skillVersion.id ||
        String(member.criterion_version_id) !== skillVersion.criterionVersionId ||
        String(member.skill_digest) !== skillDigest(skillVersion) ||
        String(member.output_contract_digest) !== evaluatorOutputContractDigest(skillVersion)) {
      throw repoError("ineligible", "suite binding is not the exact single-trial evaluator member");
    }
    suiteBinding = {
      manifestId: input.suiteBinding.manifestId,
      manifestDigest: String(member.manifest_digest),
      memberPosition: input.suiteBinding.memberPosition
    };
  }

  const origin: FrozenOriginRow = {
    batch_id: String(row.batch_id),
    batch_content_digest: String(row.batch_content_digest),
    instruction_version_id: String(row.instruction_version_id),
    instruction_digest: String(row.instruction_digest),
    population_id: String(row.population_id),
    population_digest: String(row.population_digest),
    source_population_id: String(row.source_population_id),
    population_definition: parseJson(row.population_definition),
    population_collection_provenance: parseJson(row.population_collection_provenance),
    population_size: Number(row.population_size),
    selection_method: String(row.selection_method),
    selection_seed: nullableString(row.selection_seed),
    rng_version: nullableString(row.rng_version),
    draw_executed_by: String(row.draw_executed_by),
    fixed_budget: Number(row.fixed_budget),
    draw_digest: String(row.draw_digest),
    strata: parseJson(row.strata),
    custodian_subject_id: String(row.custodian_subject_id)
  };
  const representativeness = await deriveRepresentativeness(client, origin);
  return {
    revisionDigest: String(row.revision_digest),
    truthContentDigest: String(row.content_digest),
    itemCount: Number(row.item_count),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    criterionDigest: String(row.criterion_digest),
    skillVersion,
    skillDigest: skillDigest(skillVersion),
    outputContractDigest: evaluatorOutputContractDigest(skillVersion),
    requestedBinding,
    providerPolicy,
    providerPolicyBytes,
    suiteBinding,
    origin: {
      batchId: origin.batch_id,
      batchDigest: origin.batch_content_digest,
      instructionVersionId: origin.instruction_version_id,
      instructionDigest: origin.instruction_digest,
      populationId: origin.population_id,
      populationDigest: origin.population_digest,
      drawDigest: origin.draw_digest,
      selectionMethod: origin.selection_method
    },
    representativeness
  };
}
async function deriveRepresentativeness(client: PoolClient, origin: FrozenOriginRow): Promise<{
  representativeOfPopulationId: string | null;
  reasons: string[];
}> {
  const evidence = (await client.query(
    `select
       governed_review_draw_digest($1)=$2 as draw_matches,
       (select count(*)::int from governed_review_batch_items where batch_id=$1) as selected_count,
       (select count(*)::int from governed_review_batch_items item
        cross join lateral governed_review_item_resolution(item.id) resolution
        where item.batch_id=$1 and resolution.resolved_label in ('pass','fail')) as resolved_count,
       exists(select 1 from governed_review_tasks task where task.batch_id=$1
              and governed_review_current_task_state(task.id)='deferred') as deferred,
       exists(select 1 from governed_review_tasks task where task.batch_id=$1
              and governed_review_current_task_state(task.id)<>'submitted') as incomplete_tasks,
       exists(select 1 from governed_active_review_labels label
              where label.batch_id=$1 and label.label='cannot_determine') as cannot_determine`,
    [origin.batch_id, origin.draw_digest]
  )).rows[0];
  const reasons: string[] = [];
  const probabilityMethod = origin.selection_method === "simple_random" ||
    origin.selection_method === "stratified_random";
  if (!probabilityMethod) reasons.push("selection_method_not_eligible");
  if (isEmptyObject(origin.population_definition) || origin.population_size <= 0) {
    reasons.push("population_frame_incomplete");
  }
  if (isEmptyObject(origin.population_collection_provenance)) {
    reasons.push("collection_provenance_unverified");
  }
  if (origin.draw_executed_by !== "coeval_server") reasons.push("draw_not_server_executed");
  if (probabilityMethod && (!origin.selection_seed || !origin.rng_version || evidence.draw_matches !== true)) {
    reasons.push("draw_not_reproducible");
  }
  if (origin.fixed_budget !== Number(evidence.selected_count)) reasons.push("fixed_budget_mismatch");
  if (origin.selection_method === "stratified_random" &&
      (!Array.isArray(origin.strata) || origin.strata.length === 0)) reasons.push("strata_incomplete");
  if (evidence.incomplete_tasks === true) reasons.push("review_coverage_incomplete");
  if (evidence.deferred === true) reasons.push("deferred_assignments");
  if (evidence.cannot_determine === true) reasons.push("cannot_determine_present");
  if (Number(evidence.resolved_count) !== Number(evidence.selected_count)) reasons.push("unresolved_items");
  const sorted = [...new Set(reasons)].sort();
  return {
    representativeOfPopulationId: sorted.length === 0 ? origin.source_population_id : null,
    reasons: sorted
  };
}

export async function evaluateEligibility(
  client: PoolClient,
  run: RunRow,
  phase: "authorization" | "completion"
): Promise<EligibilityResult> {
  const exposedSubjects = await contentExposedSubjects(client, String(run.governed_review_batch_id));
  const capabilityChecks = await appendFinalValidationChecks(client, run, phase, exposedSubjects);
  const exposureRows = await client.query(
    `select id,kind,exposure_class,activity,subject_kind,subject_id,evidence_ref_kind,
            evidence_ref_id,occurred_at
     from dataset_exposure_events
     where revision_id=$1 and project_id=$2
       and not (evidence_ref_kind='binary_calibration_run' and evidence_ref_id=$3)
     order by occurred_at,id`,
    [run.dataset_revision_id, run.project_id, run.id]
  );
  const relevantExposures = exposureRows.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    exposureClass: String(row.exposure_class),
    activity: String(row.activity),
    subjectKind: String(row.subject_kind),
    subjectId: nullableString(row.subject_id),
    evidenceRefKind: nullableString(row.evidence_ref_kind),
    evidenceRefId: nullableString(row.evidence_ref_id),
    occurredAt: toIso(row.occurred_at)
  }));
  const exposureDetected = relevantExposures.some((event) =>
    event.exposureClass === "development" || [
      "declassify", "analysis_authoring", "rubric_authoring", "prompt_tuning",
      "example_selection", "model_selection", "development_run", "regression_run"
    ].includes(event.activity)
  );
  const reuse = await evaluateEvaluatorReuse(client, run);
  const capabilitySemantic = capabilityChecks.map((check) => ({
    subjectId: check.subjectId,
    result: check.result,
    excludedCapabilities: check.excludedCapabilities,
    unknownCapabilities: check.unknownCapabilities
  }));
  const comparableFacts = {
    revisionDigest: String(run.revision_digest),
    criterionId: String(run.criterion_id),
    criterionVersionId: String(run.criterion_version_id),
    skillVersionId: String(run.skill_version_id),
    relevantExposures,
    capabilitySemantic,
    evaluatorReuse: reuse
  };
  const comparableFactsDigest = sha256Digest(comparableFacts);
  const reasons: BinaryCalibrationCompletionEligibilityReason[] = [];
  if (exposureDetected || capabilityChecks.some((check) => check.excludedCapabilities.length > 0)) {
    reasons.push("development_exposure_detected");
  }
  if (capabilityChecks.some((check) => check.result === "unknown")) {
    reasons.push("exposure_state_unknown");
  }
  if (!reuse.eligible) reasons.push("evaluator_reuse_ineligible");

  if (phase === "completion") {
    const authorization = await client.query(
      `select canonical_bytes from binary_calibration_exposure_checks
       where id=$1 and run_id=$2 and phase='authorization'`,
      [run.authorization_check_id, run.id]
    );
    const raw = authorization.rows[0]?.canonical_bytes;
    if (!raw) {
      reasons.push("exposure_state_unknown");
    } else {
      const prior = JSON.parse(Buffer.from(raw).toString("utf8")) as { comparableFactsDigest?: unknown };
      if (prior.comparableFactsDigest !== comparableFactsDigest) {
        reasons.push("authorization_snapshot_changed");
      }
    }
  }
  const sortedReasons = [...new Set(reasons)].sort() as BinaryCalibrationCompletionEligibilityReason[];
  const snapshot = {
    contract: "coeval/binary-calibration-exposure-snapshot/v1",
    schemaVersion: 1,
    phase,
    calibrationRunId: run.id,
    projectId: run.project_id,
    datasetRevisionId: run.dataset_revision_id,
    revisionDigest: run.revision_digest,
    criterionId: run.criterion_id,
    criterionVersionId: run.criterion_version_id,
    skillVersionId: run.skill_version_id,
    comparableFactsDigest,
    comparableFacts,
    capabilityChecks,
    exposureState: exposureDetected ? "exposed" : "protected",
    eligibility: {
      result: sortedReasons.length === 0 ? "eligible" : "ineligible",
      reasons: sortedReasons
    }
  };
  return {
    exposureState: exposureDetected ? "exposed" : "protected",
    eligible: sortedReasons.length === 0,
    reasons: sortedReasons,
    snapshot
  };
}

async function contentExposedSubjects(client: PoolClient, batchId: string): Promise<string[]> {
  const result = await client.query(
    `select custodian_subject_id as subject_id from governed_review_batches where id=$1
     union
     select reviewer_subject_id from governed_review_tasks where batch_id=$1
     union
     select adjudicator_subject_id from governed_review_adjudications where batch_id=$1`,
    [batchId]
  );
  return [...new Set(result.rows.map((row) => nullableString(row.subject_id)).filter(isString))].sort();
}

async function appendFinalValidationChecks(
  client: PoolClient,
  run: RunRow,
  phase: "authorization" | "completion",
  subjectIds: string[]
) {
  const checks: Array<{
    checkId: string;
    contentDigest: string;
    subjectId: string;
    result: "eligible" | "ineligible" | "unknown";
    excludedCapabilities: string[];
    unknownCapabilities: string[];
  }> = [];
  for (const subjectId of subjectIds) {
    const evaluated = await evaluateCapability(client, run, subjectId);
    const sequence = Number((await client.query(
      `select coalesce(max(sequence),0)::int as sequence
       from governed_review_capability_checks
       where batch_id=$1 and check_scope='final_validation' and subject_id=$2
         and evaluator_version_id=$3`,
      [run.governed_review_batch_id, subjectId, run.skill_version_id]
    )).rows[0]?.sequence ?? 0) + 1;
    const evidence = {
      contract: "coeval/sealed-separation-evidence/v1",
      criterionVersionId: run.criterion_version_id,
      evaluatedCapabilities: [...COVERED_CAPABILITIES],
      findings: evaluated.findings
    };
    const evidenceDigest = governedContentV1Digest("sealed-separation-evidence/v1", evidence);
    const content = {
      batchId: run.governed_review_batch_id,
      capabilityQueryVersion: "sealed-separation/v1",
      checkScope: "final_validation",
      coveredCapabilities: [...COVERED_CAPABILITIES],
      evidenceDigest,
      evaluatorVersionId: run.skill_version_id,
      excludedCapabilities: evaluated.excluded,
      result: evaluated.result,
      sequence,
      subjectId,
      unknownCapabilities: evaluated.unknown,
      verificationMethod: "system_derived"
    };
    const contentDigest = governedContentV1Digest("governed-review-capability-check/v1", content);
    const checkId = stableId("grcc", run.id, phase, subjectId);
    const idempotencyKey = `binary-calibration:${run.id}:${phase}:capability:${subjectId}`;
    const requestDigest = sha256Digest({ content, evidence });
    await client.query(
      `insert into governed_review_capability_checks
         (id,project_id,batch_id,criterion_version_id,evaluator_version_id,subject_id,
          sequence,expected_previous_sequence,check_scope,result,verification_method,
          capability_query_version,covered_capabilities,excluded_capabilities,unknown_capabilities,
          evidence,evidence_digest,content_digest,idempotency_key,request_digest,checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'final_validation',$9,'system_derived',
               'sealed-separation/v1',$10,$11,$12,$13::jsonb,$14,$15,$16,$17,
               date_trunc('milliseconds',clock_timestamp()))`,
      [checkId, run.project_id, run.governed_review_batch_id, run.criterion_version_id,
        run.skill_version_id, subjectId, sequence, sequence - 1, evaluated.result,
        [...COVERED_CAPABILITIES], evaluated.excluded, evaluated.unknown,
        JSON.stringify(evidence), evidenceDigest, contentDigest, idempotencyKey, requestDigest]
    );
    checks.push({
      checkId,
      contentDigest,
      subjectId,
      result: evaluated.result,
      excludedCapabilities: evaluated.excluded,
      unknownCapabilities: evaluated.unknown
    });
  }
  return checks.sort((left, right) => left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0);
}

async function evaluateCapability(client: PoolClient, run: RunRow, subjectId: string): Promise<{
  result: "eligible" | "ineligible" | "unknown";
  excluded: string[];
  unknown: string[];
  findings: Record<string, unknown>;
}> {
  const subject = (await client.query(
    `select account_user_id from governed_reviewer_subjects where id=$1 and project_id=$2`,
    [subjectId, run.project_id]
  )).rows[0];
  if (!subject) throw repoError("ineligible", "content-exposed subject is outside the calibration project");
  const accountId = nullableString(subject.account_user_id);
  const criterionAuthors = await client.query(
    `select candidate.created_by_user_id
     from criterion_versions target
     join criterion_versions candidate
       on candidate.project_id=target.project_id and candidate.criterion_id=target.criterion_id
     where target.id=$1 and target.project_id=$2`,
    [run.criterion_version_id, run.project_id]
  );
  const instructionAuthors = await client.query(
    `select instruction.created_by_subject_id
     from criterion_versions target
     join criterion_versions candidate
       on candidate.project_id=target.project_id and candidate.criterion_id=target.criterion_id
     join review_instruction_versions instruction
       on instruction.project_id=candidate.project_id and instruction.criterion_version_id=candidate.id
     where target.id=$1 and target.project_id=$2`,
    [run.criterion_version_id, run.project_id]
  );
  const versions = await client.query(
    `select version.id,version.developer_identity_status,version.created_by_subject_id,
            exists(select 1 from governed_evaluator_development_events development
                   where development.skill_version_id=version.id
                     and development.project_id=version.project_id
                     and development.criterion_version_id=version.criterion_version_id) as has_event
     from skill_versions version
     join criterion_versions candidate on candidate.id=version.criterion_version_id
     join criterion_versions target
       on target.project_id=candidate.project_id and target.criterion_id=candidate.criterion_id
     where target.id=$1 and version.project_id=$2`,
    [run.criterion_version_id, run.project_id]
  );
  const excluded: string[] = [];
  const unknown: string[] = [];
  if (criterionAuthors.rows.length === 0 || criterionAuthors.rows.some((row) => !row.created_by_user_id)) {
    unknown.push("criterion_author_identity");
  }
  if (accountId && criterionAuthors.rows.some((row) => String(row.created_by_user_id) === accountId)) {
    excluded.push("criterion_authoring");
  }
  if (instructionAuthors.rows.length === 0 || instructionAuthors.rows.some((row) => !row.created_by_subject_id)) {
    unknown.push("instruction_author_identity");
  }
  if (instructionAuthors.rows.some((row) => String(row.created_by_subject_id) === subjectId)) {
    excluded.push("instruction_authoring");
  }
  if (versions.rows.length === 0 || versions.rows.some((row) =>
    row.developer_identity_status !== "recorded" || row.has_event !== true)) {
    unknown.push("evaluator_author_identity");
  }
  if (versions.rows.some((row) => nullableString(row.created_by_subject_id) === subjectId)) {
    excluded.push("evaluator_authoring");
  }
  const development = await client.query(
    `select 1 from governed_evaluator_development_events development
     join criterion_versions candidate on candidate.id=development.criterion_version_id
     join criterion_versions target
       on target.project_id=candidate.project_id and target.criterion_id=candidate.criterion_id
     where target.id=$1 and development.project_id=$2
       and development.developer_subject_id=$3 limit 1`,
    [run.criterion_version_id, run.project_id, subjectId]
  );
  if (development.rowCount) excluded.push("evaluator_authoring");
  const identifiers = [subjectId, ...(accountId ? [accountId] : [])];
  const exposure = await client.query(
    `select 1 from dataset_exposure_events where project_id=$1 and exposure_class='development'
       and subject_id=any($2::text[]) limit 1`,
    [run.project_id, identifiers]
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
      evaluatorVersionsChecked: versions.rows.length,
      recordedDevelopmentExposure: Boolean(exposure.rowCount)
    }
  };
}

async function evaluateEvaluatorReuse(client: PoolClient, run: RunRow): Promise<Record<string, unknown> & { eligible: boolean }> {
  const prior = await client.query(
    `select id,skill_version_id,completed_at
     from binary_calibration_runs
     where dataset_revision_id=$1 and criterion_id=$2 and id<>$3
       and state in ('complete','incomplete') and completed_at is not null
     order by completed_at,id`,
    [run.dataset_revision_id, run.criterion_id, run.id]
  );
  if (prior.rows.length === 0) {
    return { eligible: true, basis: "first_final_validation", earliestPriorCompletedAt: null };
  }
  const earliest = toIso(prior.rows[0].completed_at);
  const hasDifferentVersion = prior.rows.some((row) => String(row.skill_version_id) !== String(run.skill_version_id));
  if (!hasDifferentVersion) {
    return { eligible: true, basis: "same_immutable_evaluator_version", earliestPriorCompletedAt: earliest };
  }
  const version = (await client.query(
    `select created_at,developer_identity_status from skill_versions where id=$1 and project_id=$2`,
    [run.skill_version_id, run.project_id]
  )).rows[0];
  const development = await client.query(
    `select occurred_at from governed_evaluator_development_events
     where skill_version_id=$1 and project_id=$2 order by occurred_at,id`,
    [run.skill_version_id, run.project_id]
  );
  const timestampsKnown = Boolean(version) && version.developer_identity_status === "recorded" && development.rows.length > 0;
  const createdBefore = timestampsKnown && toIso(version.created_at) < earliest;
  const allDevelopmentBefore = timestampsKnown && development.rows.every((row) => toIso(row.occurred_at) < earliest);
  return {
    eligible: Boolean(createdBefore && allDevelopmentBefore),
    basis: "different_evaluator_version_pretest_only",
    earliestPriorCompletedAt: earliest,
    evaluatorCreatedAt: version ? toIso(version.created_at) : null,
    developmentEventCount: development.rows.length,
    allDevelopmentBeforeEarliestCompletion: Boolean(allDevelopmentBefore)
  };
}

export function snapshotRecord(
  run: RunRow,
  phase: "authorization" | "completion",
  exposureState: "protected" | "exposed",
  eligibility: "eligible" | "ineligible",
  reasons: BinaryCalibrationCompletionEligibilityReason[],
  snapshot: Record<string, unknown>,
  recordedAt: string
) {
  const canonicalBytes = Buffer.from(canonicalJson(snapshot), "utf8");
  return {
    id: stableId("bcec", run.id, phase),
    runId: run.id,
    projectId: run.project_id,
    phase,
    exposureState,
    eligibility,
    reasons,
    canonicalBytes,
    snapshotDigest: `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}`,
    recordedAt
  };
}

export async function insertExposureCheck(
  client: PoolClient,
  check: ReturnType<typeof snapshotRecord>
): Promise<void> {
  await client.query(
    `insert into binary_calibration_exposure_checks
       (id,run_id,project_id,phase,exposure_state,eligibility_result,
        eligibility_reasons,canonical_bytes,snapshot_digest,recorded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
    [check.id, check.runId, check.projectId, check.phase, check.exposureState,
      check.eligibility, check.reasons, check.canonicalBytes, check.snapshotDigest, check.recordedAt]
  );
}

export async function loadExposureCheck(db: Db, checkId: string): Promise<{
  id: string;
  snapshotDigest: string;
  recordedAt: string;
}> {
  const row = (await db.query(
    `select id,snapshot_digest,recorded_at from binary_calibration_exposure_checks where id=$1`,
    [checkId]
  )).rows[0];
  if (!row) throw repoError("state_conflict", "binary calibration exposure snapshot is missing");
  return { id: String(row.id), snapshotDigest: String(row.snapshot_digest), recordedAt: toIso(row.recorded_at) };
}

export async function loadAuthorizedRun(
  db: Db,
  claim: BinaryCalibrationExecutionClaim,
  knownRun?: RunRow
): Promise<BinaryCalibrationAuthorizedRun> {
  const result = await db.query(
    `select run.*,version.rubric_markdown,version.prompt,version.output_schema,version.model_binding,
            auth_check.snapshot_digest,auth_check.recorded_at
     from binary_calibration_runs run
     join skill_versions version on version.id=run.skill_version_id
     join binary_calibration_exposure_checks auth_check
       on auth_check.id=run.authorization_check_id and auth_check.phase='authorization'
     join binary_calibration_revision_leases lease on lease.run_id=run.id
     where run.id=$1 and run.claim_worker_id=$2 and run.claim_token=$3
       and run.claim_expires_at >= clock_timestamp()`,
    [claim.runId, claim.workerId, claim.claimToken]
  );
  const row = result.rows[0] ?? knownRun;
  if (!result.rows[0] || !row) throw repoError("state_conflict", "binary calibration authorization claim is stale");
  const binding = parseJson(row.model_binding) as ModelBinding;
  return {
    claim: {
      runId: claim.runId,
      workerId: claim.workerId,
      claimToken: claim.claimToken,
      claimExpiresAt: toIso(row.claim_expires_at)
    },
    projectId: String(row.project_id),
    datasetRevisionId: String(row.dataset_revision_id),
    revisionDigest: String(row.revision_digest),
    itemCount: Number(row.item_count),
    skillVersionId: String(row.skill_version_id),
    requestedModelBinding: requestedBindingFromRun(row),
    executionModelBinding: binding,
    providerDataHandling: {
      executionEnvironment: String(row.execution_environment) as
        BinaryCalibrationProviderDataHandlingPolicy["executionEnvironment"],
      policyId: String(row.provider_policy_id),
      policyDigest: String(row.provider_policy_digest),
      payloadTransmission: "sealed_payload_to_pinned_provider"
    },
    evaluator: {
      rubricMarkdown: String(row.rubric_markdown),
      prompt: String(row.prompt),
      outputSchema: parseJson(row.output_schema)
    },
    authorization: {
      snapshotDigest: String(row.snapshot_digest),
      eventId: String(row.authorization_check_id),
      recordedAt: toIso(row.recorded_at)
    }
  };
}

export async function requireClaim(
  db: Db,
  claim: BinaryCalibrationExecutionClaim,
  lock: boolean
): Promise<RunRow> {
  const result = await db.query<RunRow>(
    `select * from binary_calibration_runs
     where id=$1 and claim_worker_id=$2 and claim_token=$3
       and state in ('running','recovery_required')
       and claim_expires_at >= clock_timestamp()
     ${lock ? "for update" : ""}`,
    [claim.runId, claim.workerId, claim.claimToken]
  );
  if (!result.rows[0]) throw repoError("state_conflict", "binary calibration worker claim is stale");
  return result.rows[0];
}

export async function requireActiveRevisionLease(client: PoolClient, run: RunRow): Promise<void> {
  const result = await client.query(
    `select run_id from binary_calibration_revision_leases
     where dataset_revision_id=$1 and run_id=$2 for update`,
    [run.dataset_revision_id, run.id]
  );
  if (!result.rows[0]) throw repoError("state_conflict", "binary calibration revision lease is missing");
}
