import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,
  SkillVersionSchema,
  type BinaryCalibrationArtifact,
  type BinaryCalibrationCompletionEligibilityReason,
  type BinaryCalibrationErrorCode,
  type BinaryCalibrationPrivateLedger,
  type BinaryCalibrationPrivateProviderObservation,
  type ModelBinding,
  type SkillVersion
} from "@coeval/shared";
import { evaluatorExecutionAuthorizationDigest } from "../lib/evaluator-lifecycle.js";
import {
  canonicalJson,
  sha256Digest,
  skillDigest
} from "../lib/assessment-receipt.js";
import {
  binaryCalibrationArtifactDigest,
  binaryCalibrationPrivateLedgerCommitmentDigest,
  buildBinaryCalibrationArtifact,
  canonicalBinaryCalibrationArtifactBytes,
  canonicalBinaryCalibrationPrivateLedgerBytes,
  verifyBinaryCalibrationPrivateLedgerForArtifact
} from "../lib/binary-calibration.js";
import { evaluatorOutputContractDigest } from "../lib/evaluator-suite.js";
import { governedContentV1Digest } from "../lib/governed-content-digest.js";
import type {
  BinaryCalibrationActor,
  BinaryCalibrationArtifactCopy,
  BinaryCalibrationArtifactStatusReason,
  BinaryCalibrationArtifactStatusProjection,
  BinaryCalibrationAttemptWorkItem,
  BinaryCalibrationAuthorizedRun,
  BinaryCalibrationControlRepository,
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationExecutionRepository,
  BinaryCalibrationMintResult,
  BinaryCalibrationProjectAccess,
  BinaryCalibrationProviderDataHandlingPolicy,
  BinaryCalibrationRequestedModelBinding,
  BinaryCalibrationRunProjection,
  CompleteBinaryCalibrationAttemptInput,
  CreateBinaryCalibrationRunInput
} from "./repository.js";
import {
  binaryCalibrationBaseUrlDigest,
  BinaryCalibrationRepositoryError
} from "./repository.js";

type Db = Pool | PoolClient;

const COVERED_CAPABILITIES = [
  "criterion_authoring",
  "instruction_authoring",
  "evaluator_authoring",
  "rubric_authoring",
  "prompt_authoring",
  "example_selection",
  "development_exposure"
] as const;

interface RunRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  dataset_revision_id: string;
  revision_digest: string;
  truth_content_digest: string;
  item_count: number;
  criterion_id: string;
  criterion_version_id: string;
  criterion_digest: string;
  skill_id: string;
  skill_version_id: string;
  requested_provider: string;
  requested_model_id: string;
  requested_model_version: string;
  temperature_decimal: string;
  top_p_decimal: string | null;
  endpoint_kind: "managed" | "custom";
  base_url_digest: string | null;
  requested_binding_digest: string;
  suite_manifest_id: string | null;
  suite_manifest_digest: string | null;
  suite_member_position: number | null;
  positive_class: "pass" | "fail";
  state: BinaryCalibrationRunProjection["state"];
  planned_observations: number;
  accounted_observations: number;
  artifact_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

interface FrozenOriginRow extends Record<string, unknown> {
  batch_id: string;
  batch_content_digest: string;
  instruction_version_id: string;
  instruction_digest: string;
  population_id: string;
  population_digest: string;
  source_population_id: string;
  population_definition: unknown;
  population_collection_provenance: unknown;
  population_size: number;
  selection_method: string;
  selection_seed: string | null;
  rng_version: string | null;
  draw_executed_by: string;
  fixed_budget: number;
  draw_digest: string;
  strata: unknown;
  custodian_subject_id: string;
}

interface EligibilityResult {
  exposureState: "protected" | "exposed";
  eligible: boolean;
  reasons: BinaryCalibrationCompletionEligibilityReason[];
  snapshot: Record<string, unknown>;
}

export class PgBinaryCalibrationRepository implements
  BinaryCalibrationControlRepository,
  BinaryCalibrationExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async createRun(
    actor: BinaryCalibrationActor,
    input: CreateBinaryCalibrationRunInput
  ): Promise<BinaryCalibrationRunProjection> {
    requireOwner(actor);
    validateCreateInput(input);
    return this.transaction(async (client) => {
      await requireProjectOwner(client, actor);
      const derived = await deriveRunIdentity(client, actor.projectId, input);
      const semanticRequest = {
        datasetRevisionId: input.datasetRevisionId,
        idempotencyKey: input.idempotencyKey,
        positiveClass: input.positiveClass,
        providerDataHandling: derived.providerPolicy,
        skillVersionId: input.skillVersionId,
        suiteBinding: input.suiteBinding,
        trialPlan: input.trialPlan
      };
      const requestDigest = sha256Digest(semanticRequest);
      const existing = await client.query<RunRow>(
        `select * from binary_calibration_runs where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (String(existing.rows[0].request_digest) !== requestDigest) {
          throw repoError("idempotency_conflict", "binary calibration idempotency key was reused with different input");
        }
        return rowToRun(existing.rows[0]);
      }

      const runId = stableId("bcr", actor.projectId, input.idempotencyKey);
      try {
        const inserted = await client.query<RunRow>(
          `insert into binary_calibration_runs
             (id,project_id,dataset_revision_id,revision_digest,truth_content_digest,item_count,
              criterion_id,criterion_version_id,criterion_digest,skill_id,skill_version_id,
              skill_digest,output_contract_digest,requested_provider,requested_model_id,
              requested_model_version,temperature_decimal,top_p_decimal,endpoint_kind,
              base_url_digest,requested_binding_digest,suite_manifest_id,suite_manifest_digest,
              suite_member_position,governed_review_batch_id,governed_review_batch_digest,
              review_instruction_version_id,review_instruction_digest,population_id,population_digest,
              draw_digest,representative_of_population_id,representative_ineligible_reasons,
              selection_method,positive_class,trial_plan_kind,trials_per_item,execution_environment,
              provider_policy_id,provider_policy_digest,provider_policy_canonical_bytes,
              payload_transmission,idempotency_key,request_digest,state,planned_observations)
           values
             ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
              $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,'single',1,$36,
              $37,$38,$39,$40,$41,$42,'queued',$6)
           returning *`,
          [
            runId, actor.projectId, input.datasetRevisionId, derived.revisionDigest,
            derived.truthContentDigest, derived.itemCount, derived.criterionId,
            derived.criterionVersionId, derived.criterionDigest, derived.skillVersion.skillId,
            derived.skillVersion.id, derived.skillDigest, derived.outputContractDigest,
            derived.requestedBinding.provider, derived.requestedBinding.modelId,
            derived.requestedBinding.modelVersion, derived.requestedBinding.temperatureDecimal,
            derived.requestedBinding.topPDecimal, derived.requestedBinding.endpointKind,
            derived.requestedBinding.baseUrlDigest, derived.requestedBinding.requestedBindingDigest,
            derived.suiteBinding?.manifestId ?? null, derived.suiteBinding?.manifestDigest ?? null,
            derived.suiteBinding?.memberPosition ?? null, derived.origin.batchId,
            derived.origin.batchDigest, derived.origin.instructionVersionId,
            derived.origin.instructionDigest, derived.origin.populationId,
            derived.origin.populationDigest, derived.origin.drawDigest,
            derived.representativeness.representativeOfPopulationId,
            derived.representativeness.reasons, derived.origin.selectionMethod,
            input.positiveClass, derived.providerPolicy.executionEnvironment,
            derived.providerPolicy.policyId, derived.providerPolicy.policyDigest,
            derived.providerPolicyBytes, derived.providerPolicy.payloadTransmission,
            input.idempotencyKey, requestDigest
          ]
        );
        return rowToRun(inserted.rows[0]!);
      } catch (error) {
        throw mapPgError(error);
      }
    });
  }

  async listRuns(access: BinaryCalibrationProjectAccess): Promise<BinaryCalibrationRunProjection[]> {
    const result = await this.pool.query<RunRow>(
      `select * from binary_calibration_runs where project_id=$1 order by created_at desc,id desc`,
      [access.projectId]
    );
    return result.rows.map(rowToRun);
  }

  async getRun(
    access: BinaryCalibrationProjectAccess,
    runId: string
  ): Promise<BinaryCalibrationRunProjection> {
    const result = await this.pool.query<RunRow>(
      `select * from binary_calibration_runs where id=$1 and project_id=$2`,
      [runId, access.projectId]
    );
    if (!result.rows[0]) throw repoError("not_found", "binary calibration run not found");
    return rowToRun(result.rows[0]);
  }

  async getArtifact(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactCopy> {
    const result = await this.pool.query(
      `select id,run_id,canonical_bytes,artifact_digest,evidence_digest,created_at
       from binary_calibration_artifacts where id=$1 and project_id=$2`,
      [artifactId, access.projectId]
    );
    const row = result.rows[0];
    if (!row) throw repoError("not_found", "binary calibration artifact not found");
    return artifactCopyFromRow(row);
  }

  async getArtifactStatus(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactStatusProjection> {
    const result = await this.pool.query(
      `select artifact.id,artifact.run_id,artifact.status,run.dataset_revision_id,
              completion.recorded_at,
              coalesce(array_agg(distinct revocation.reason order by revocation.reason)
                filter (where revocation.reason is not null),'{}'::text[]) as explicit_reasons,
              date_trunc('milliseconds',clock_timestamp()) as evaluated_at,
              exists(
                select 1 from dataset_exposure_events exposure
                where exposure.revision_id=run.dataset_revision_id
                  and exposure.occurred_at >= completion.recorded_at
                  and (exposure.exposure_class='development' or exposure.activity in (
                    'declassify','analysis_authoring','rubric_authoring','prompt_tuning',
                    'example_selection','model_selection','development_run','regression_run'
                  ))
              ) as later_development_exposure
       from binary_calibration_artifacts artifact
       join binary_calibration_runs run on run.id=artifact.run_id
       join binary_calibration_exposure_checks completion
         on completion.id=run.completion_check_id and completion.phase='completion'
       left join binary_calibration_revocation_events revocation on revocation.artifact_id=artifact.id
       where artifact.id=$1 and artifact.project_id=$2
       group by artifact.id,artifact.run_id,artifact.status,run.dataset_revision_id,completion.recorded_at`,
      [artifactId, access.projectId]
    );
    const row = result.rows[0];
    if (!row) throw repoError("not_found", "binary calibration artifact not found");
    const reasons = asStringArray(row.explicit_reasons) as BinaryCalibrationArtifactStatusReason[];
    if (row.later_development_exposure === true) reasons.push("development_exposure");
    const uniqueReasons = [...new Set(reasons)].sort();
    const statusUnavailable = uniqueReasons.includes("current_status_unavailable");
    if (statusUnavailable && uniqueReasons.length !== 1) {
      throw new Error("binary calibration current-status evidence is internally inconsistent");
    }
    return {
      contract: "coeval/binary-calibration-artifact-status/v1",
      schemaVersion: 1,
      artifactId: String(row.id),
      calibrationRunId: String(row.run_id),
      artifactStatus: row.status === "complete" ? "complete" : "incomplete",
      currentAdmissibility: statusUnavailable ? "unknown" : uniqueReasons.length > 0 ? "revoked" : "admissible",
      reasons: uniqueReasons,
      evaluatedAt: toIso(row.evaluated_at)
    };
  }

  async listRunnableRunIds(limit: number): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw repoError("unsupported", "runnable calibration limit must be an integer from 1 to 1000");
    }
    const result = await this.pool.query(
      `select id from binary_calibration_runs
       where state in ('queued','recovery_required')
          or (state='running' and claim_expires_at < clock_timestamp())
       order by created_at,id limit $1`,
      [limit]
    );
    return result.rows.map((row) => String(row.id));
  }

  async claimRun(
    runId: string,
    workerId: string,
    claimTtlMs: number
  ): Promise<BinaryCalibrationExecutionClaim | null> {
    validateClaimInput(workerId, claimTtlMs);
    const claimToken = randomBytes(32).toString("hex");
    try {
      const result = await this.pool.query(
        `update binary_calibration_runs
         set state='running',claim_worker_id=$2,claim_token=$3,
             claim_expires_at=date_trunc('milliseconds',clock_timestamp())
               + ($4::double precision * interval '1 millisecond')
         where id=$1
           and state in ('queued','running','recovery_required')
           and (claim_token is null or claim_expires_at < clock_timestamp())
         returning id,claim_worker_id,claim_token,claim_expires_at`,
        [runId, workerId, claimToken, claimTtlMs]
      );
      return result.rows[0] ? claimFromRow(result.rows[0]) : null;
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async heartbeatClaim(
    claim: BinaryCalibrationExecutionClaim,
    claimTtlMs: number
  ): Promise<BinaryCalibrationExecutionClaim> {
    validateClaimInput(claim.workerId, claimTtlMs);
    const result = await this.pool.query(
      `update binary_calibration_runs
       set claim_expires_at=date_trunc('milliseconds',clock_timestamp())
             + ($4::double precision * interval '1 millisecond')
       where id=$1 and claim_worker_id=$2 and claim_token=$3
         and state in ('running','recovery_required')
         and claim_expires_at >= clock_timestamp()
       returning id,claim_worker_id,claim_token,claim_expires_at`,
      [claim.runId, claim.workerId, claim.claimToken, claimTtlMs]
    );
    if (!result.rows[0]) throw repoError("state_conflict", "binary calibration worker claim is stale");
    return claimFromRow(result.rows[0]);
  }

  async authorizeRun(claim: BinaryCalibrationExecutionClaim): Promise<BinaryCalibrationAuthorizedRun> {
    const result = await this.transaction(async (client) => {
      const run = await requireClaim(client, claim, true);
      await insertEvaluatorExecutionAuthorization(client, run, {
        context: "binary_calibration_evidence",
        resourceKind: "binary_calibration_run",
        resourceId: String(run.id),
        idempotencyKey: `provider-start:binary-calibration:${run.id}:${run.skill_version_id}`
      });
      await client.query(`select id from dataset_revisions where id=$1 for update`, [run.dataset_revision_id]);
      if (run.authorization_check_id) {
        await requireActiveRevisionLease(client, run);
        return { run, rejected: false };
      }

      const eligibility = await evaluateEligibility(client, run, "authorization");
      if (!eligibility.eligible || eligibility.exposureState !== "protected") {
        const rejectedAt = await databaseClock(client);
        await client.query(
          `update binary_calibration_runs
           set state='rejected',rejection_reason=$2,completed_at=$3::timestamptz,
               claim_worker_id=null,claim_token=null,claim_expires_at=null
           where id=$1`,
          [run.id, eligibility.reasons.join(",") || "exposure_state_unknown", rejectedAt]
        );
        return { run, rejected: true };
      }

      const authorizationAt = await databaseClock(client);
      try {
        await client.query(
          `insert into binary_calibration_revision_leases
             (dataset_revision_id,project_id,run_id,acquired_at) values ($1,$2,$3,$4::timestamptz)`,
          [run.dataset_revision_id, run.project_id, run.id, authorizationAt]
        );
      } catch (error) {
        throw mapPgError(error);
      }

      const exposureEventId = stableId("bcde", run.id, "authorization");
      await client.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
            evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key,occurred_at)
         values ($1,$2,$3,'evaluator_execution','provenance','final_validation_run',
                 'evaluator_version',$4,'binary_calibration_run',$5,
                 'Sealed binary calibration authorization',$6::jsonb,$7,
                 $8::timestamptz)`,
        [exposureEventId, run.project_id, run.dataset_revision_id, run.skill_version_id,
          run.id, JSON.stringify({ calibrationRunId: run.id, criterionVersionId: run.criterion_version_id }),
          `binary-calibration:${run.id}:authorization`, authorizationAt]
      );

      const recordedAt = authorizationAt;
      const snapshot = {
        ...eligibility.snapshot,
        authorizationExposureEventId: exposureEventId,
        recordedAt
      };
      const check = snapshotRecord(run, "authorization", "protected", "eligible", [], snapshot, recordedAt);
      await insertExposureCheck(client, check);

      const truthRows = await client.query(
        `select item.id,item.item_digest,truth.resolved_label
         from dataset_revision_items item
         join governed_dataset_truth_links truth
           on truth.dataset_revision_item_id=item.id
          and truth.dataset_revision_id=item.revision_id
          and truth.criterion_version_id=$2
         where item.revision_id=$1 and item.project_id=$3
           and truth.source_kind in ('governed_labels','adjudication')
         order by item.item_digest,item.id`,
        [run.dataset_revision_id, run.criterion_version_id, run.project_id]
      );
      if (truthRows.rows.length !== Number(run.item_count)) {
        throw repoError("ineligible", "sealed revision does not have exact governed binary truth coverage");
      }
      for (const row of truthRows.rows) {
        await client.query(
          `insert into binary_calibration_attempts
             (id,run_id,project_id,dataset_revision_item_id,dataset_revision_item_digest,
              trial_index,truth_label,provider,commitment_salt)
           values ($1,$2,$3,$4,$5,0,$6,$7,$8)`,
          [stableId("bca", run.id, String(row.item_digest)), run.id, run.project_id,
            row.id, row.item_digest, row.resolved_label, run.requested_provider,
            randomBytes(32).toString("hex")]
        );
      }
      await client.query(
        `update binary_calibration_runs
         set authorization_check_id=$2,started_at=$3::timestamptz
         where id=$1`,
        [run.id, check.id, recordedAt]
      );
      return { run: { ...run, authorization_check_id: check.id, started_at: recordedAt }, rejected: false };
    });
    if (result.rejected) {
      throw repoError("ineligible", "sealed calibration authorization was rejected");
    }
    return loadAuthorizedRun(this.pool, claim, result.run);
  }

  async recoverStartedAttempts(claim: BinaryCalibrationExecutionClaim): Promise<number> {
    return this.transaction(async (client) => {
      const run = await requireClaim(client, claim, true);
      await requireActiveRevisionLease(client, run);
      const recovered = await client.query(
        `update binary_calibration_attempts
         set accounting_state='accounted',terminal_evaluator_outcome='errored',
             attempt_state='started',error_code='outcome_unknown',
             accounted_at=date_trunc('milliseconds',clock_timestamp())
         where run_id=$1 and accounting_state='pending' and attempt_state='started'
         returning id`,
        [run.id]
      );
      if ((recovered.rowCount ?? 0) > 0) {
        await client.query(
          `update binary_calibration_runs
           set accounted_observations=accounted_observations+$2 where id=$1`,
          [run.id, recovered.rowCount]
        );
      }
      return recovered.rowCount ?? 0;
    });
  }

  async getNextAttempt(
    claim: BinaryCalibrationExecutionClaim
  ): Promise<BinaryCalibrationAttemptWorkItem | null> {
    const run = await requireClaim(this.pool, claim, false);
    const result = await this.pool.query(
      `select attempt.id,attempt.run_id,attempt.dataset_revision_item_digest,
              attempt.trial_index,attempt.physical_provider_calls,item.payload_snapshot
       from binary_calibration_attempts attempt
       join dataset_revision_items item on item.id=attempt.dataset_revision_item_id
       join binary_calibration_revision_leases lease
         on lease.run_id=attempt.run_id and lease.dataset_revision_id=item.revision_id
       where attempt.run_id=$1 and attempt.accounting_state='pending'
         and attempt.attempt_state='not_started'
       order by attempt.trial_index,attempt.dataset_revision_item_digest
       limit 1`,
      [run.id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      attemptId: String(row.id),
      runId: String(row.run_id),
      datasetRevisionItemDigest: String(row.dataset_revision_item_digest),
      trialIndex: 0,
      payloadSnapshot: parseJson(row.payload_snapshot),
      physicalProviderCalls: Number(row.physical_provider_calls)
    };
  }

  async recordProviderCallStarted(
    claim: BinaryCalibrationExecutionClaim,
    attemptId: string
  ): Promise<number> {
    return this.transaction(async (client) => {
      const run = await requireClaim(client, claim, true);
      await requireActiveRevisionLease(client, run);
      const result = await client.query(
        `update binary_calibration_attempts
         set attempt_state='started',physical_provider_calls=physical_provider_calls+1
         where id=$1 and run_id=$2 and accounting_state='pending'
           and physical_provider_calls < 9007199254740991
         returning physical_provider_calls`,
        [attemptId, run.id]
      );
      if (!result.rows[0]) throw repoError("state_conflict", "binary calibration attempt cannot start a provider call");
      return Number(result.rows[0].physical_provider_calls);
    });
  }

  async completeAttempt(
    claim: BinaryCalibrationExecutionClaim,
    attemptId: string,
    input: CompleteBinaryCalibrationAttemptInput
  ): Promise<void> {
    validateAttemptCompletion(input);
    await this.transaction(async (client) => {
      const run = await requireClaim(client, claim, true);
      await requireActiveRevisionLease(client, run);
      if (input.providerObservation.provider !== String(run.requested_provider)) {
        throw repoError("conflict", "attempt provider observation does not match the pinned requested provider");
      }
      const result = await client.query(
        `update binary_calibration_attempts
         set accounting_state='accounted',terminal_evaluator_outcome=$3,attempt_state=$4,
             error_code=$5,observed_model=$6,observed_version=$7,system_fingerprint=$8,
             accounted_at=date_trunc('milliseconds',clock_timestamp())
         where id=$1 and run_id=$2 and accounting_state='pending'
         returning id`,
        [attemptId, run.id, input.terminalEvaluatorOutcome, input.attemptState,
          input.errorCode, input.providerObservation.observedModel,
          input.providerObservation.observedVersion, input.providerObservation.systemFingerprint]
      );
      if (!result.rows[0]) throw repoError("state_conflict", "binary calibration attempt is already accounted or missing");
      await client.query(
        `update binary_calibration_runs
         set accounted_observations=accounted_observations+1 where id=$1`,
        [run.id]
      );
    });
  }

  async finalizeRun(claim: BinaryCalibrationExecutionClaim): Promise<BinaryCalibrationMintResult> {
    return this.transaction(async (client) => {
      const run = await requireClaim(client, claim, true);
      await client.query(`select id from dataset_revisions where id=$1 for update`, [run.dataset_revision_id]);
      await requireActiveRevisionLease(client, run);
      if (!run.authorization_check_id || !run.started_at) {
        throw repoError("state_conflict", "binary calibration run is not authorized");
      }
      const pending = await client.query(
        `select count(*)::int as count from binary_calibration_attempts
         where run_id=$1 and accounting_state='pending'`,
        [run.id]
      );
      if (Number(pending.rows[0]?.count ?? 0) !== 0 ||
          Number(run.accounted_observations) !== Number(run.planned_observations)) {
        throw repoError("state_conflict", "binary calibration run still has unaccounted observations");
      }

      const completion = await evaluateEligibility(client, run, "completion");
      const completionAt = await databaseClock(client);
      const completedAt = completionAt;
      const completionRecordedAt = completionAt;
      const completionSnapshot = {
        ...completion.snapshot,
        recordedAt: completionRecordedAt
      };
      const completionCheck = snapshotRecord(
        run,
        "completion",
        completion.exposureState,
        completion.eligible ? "eligible" : "ineligible",
        completion.reasons,
        completionSnapshot,
        completionRecordedAt
      );
      await insertExposureCheck(client, completionCheck);

      const attemptResult = await client.query(
        `select dataset_revision_item_digest,truth_label,trial_index,
                terminal_evaluator_outcome,attempt_state,error_code,
                physical_provider_calls,provider,observed_model,observed_version,
                system_fingerprint,commitment_salt
         from binary_calibration_attempts where run_id=$1
         order by trial_index,dataset_revision_item_digest`,
        [run.id]
      );
      if (attemptResult.rows.length !== Number(run.planned_observations)) {
        throw repoError("state_conflict", "binary calibration ledger coverage differs from the run plan");
      }
      const artifactId = stableId("bca", run.id, "artifact-root");
      const ledgerId = stableId("bcl", run.id, "private-ledger-root");
      const records = attemptResult.rows.map((row) => ({
        datasetRevisionItemDigest: String(row.dataset_revision_item_digest),
        trialIndex: Number(row.trial_index),
        truthLabel: row.truth_label === "pass" ? "pass" as const : "fail" as const,
        terminalEvaluatorOutcome: String(row.terminal_evaluator_outcome) as
          BinaryCalibrationPrivateLedger["records"][number]["terminalEvaluatorOutcome"],
        attemptState: String(row.attempt_state) as
          BinaryCalibrationPrivateLedger["records"][number]["attemptState"],
        errorCode: row.error_code === null ? null : String(row.error_code) as BinaryCalibrationErrorCode,
        physicalProviderCalls: Number(row.physical_provider_calls),
        providerObservation: {
          provider: String(row.provider),
          observedModel: nullableString(row.observed_model),
          observedVersion: nullableString(row.observed_version),
          systemFingerprint: nullableString(row.system_fingerprint)
        },
        commitmentSalt: String(row.commitment_salt)
      }));
      const ledger: BinaryCalibrationPrivateLedger = {
        contract: "coeval/binary-calibration-private-ledger/v1",
        schemaVersion: 1,
        canonicalizationVersion: "coeval-canonical-json/v1",
        artifactId,
        calibrationRunId: run.id,
        projectId: run.project_id,
        revisionDigest: String(run.revision_digest),
        requestedProvider: String(run.requested_provider),
        itemCount: Number(run.item_count),
        trialsPerItem: 1,
        records
      };
      const ledgerBytes = canonicalBinaryCalibrationPrivateLedgerBytes(ledger);
      const ledgerCommitment = binaryCalibrationPrivateLedgerCommitmentDigest(ledger);
      const aggregate = aggregateTrial(records);
      const authorization = await loadExposureCheck(client, String(run.authorization_check_id));
      const artifactCreatedAt = await databaseClock(client);
      const artifact = buildBinaryCalibrationArtifact({
        artifactId,
        calibrationRunId: run.id,
        projectId: run.project_id,
        lineage: { artifactRevision: 1, predecessorArtifactId: null, correctionReason: null },
        createdAt: artifactCreatedAt,
        startedAt: toIso(run.started_at),
        completedAt,
        criterion: {
          criterionId: String(run.criterion_id),
          criterionVersionId: String(run.criterion_version_id),
          criterionDigest: String(run.criterion_digest)
        },
        evaluator: {
          skillId: String(run.skill_id),
          skillVersionId: String(run.skill_version_id),
          skillDigest: String(run.skill_digest),
          outputContractDigest: String(run.output_contract_digest),
          requestedModelBinding: requestedBindingFromRun(run)
        },
        suiteBinding: run.suite_manifest_id === null ? null : {
          manifestId: String(run.suite_manifest_id),
          manifestDigest: String(run.suite_manifest_digest),
          memberPosition: Number(run.suite_member_position)
        },
        truth: {
          datasetRevisionId: String(run.dataset_revision_id),
          revisionDigest: String(run.revision_digest),
          contentDigest: String(run.truth_content_digest),
          itemCount: Number(run.item_count),
          role: "sealed_validation",
          sourceKind: "sealed_intake",
          provenanceLevel: "governed_blind",
          semanticLeakageDetection: "unsupported",
          representativeOfPopulationId: nullableString(run.representative_of_population_id),
          representativeIneligibleReasons: asStringArray(run.representative_ineligible_reasons) as
            BinaryCalibrationArtifact["truth"]["representativeIneligibleReasons"],
          selectionMethod: String(run.selection_method) as BinaryCalibrationArtifact["truth"]["selectionMethod"],
          origin: {
            governedReviewBatchId: String(run.governed_review_batch_id),
            governedReviewBatchDigest: String(run.governed_review_batch_digest),
            reviewInstructionVersionId: String(run.review_instruction_version_id),
            reviewInstructionDigest: String(run.review_instruction_digest),
            populationId: String(run.population_id),
            populationDigest: String(run.population_digest),
            drawDigest: String(run.draw_digest)
          }
        },
        exposure: {
          authorization: {
            state: "protected",
            snapshotDigest: authorization.snapshotDigest,
            eventId: authorization.id,
            recordedAt: authorization.recordedAt
          },
          completion: {
            state: completion.exposureState,
            snapshotDigest: completionCheck.snapshotDigest,
            eventId: completionCheck.id,
            recordedAt: completionRecordedAt,
            eligibility: {
              result: completion.eligible ? "eligible" : "ineligible",
              reasons: completion.reasons
            }
          }
        },
        execution: {
          definitionVersion: "sealed-binary-calibration-execution/v1",
          providerDataHandling: {
            executionEnvironment: String(run.execution_environment) as
              BinaryCalibrationArtifact["execution"]["providerDataHandling"]["executionEnvironment"],
            policyId: String(run.provider_policy_id),
            policyDigest: String(run.provider_policy_digest),
            payloadTransmission: "sealed_payload_to_pinned_provider"
          }
        },
        positiveClass: run.positive_class === "pass" ? "pass" : "fail",
        trialPlan: { kind: "single", trialsPerItem: 1 },
        truthSupport: aggregate.truthSupport,
        privateLedgerCommitmentDigest: ledgerCommitment,
        trials: [{
          trialIndex: 0,
          outcomes: aggregate.outcomes,
          confusionMatrix: aggregate.confusionMatrix,
          providerIdentityGroups: aggregate.providerIdentityGroups
        }]
      });
      verifyBinaryCalibrationPrivateLedgerForArtifact(ledger, artifact);
      const artifactBytes = canonicalBinaryCalibrationArtifactBytes(artifact);
      const artifactDigest = binaryCalibrationArtifactDigest(artifactBytes);

      await client.query(`set constraints binary_calibration_private_ledger_artifact_fk deferred`);
      await client.query(
        `insert into binary_calibration_private_ledgers
           (id,run_id,project_id,artifact_id,contract,canonical_bytes,commitment_digest,created_at)
         values ($1,$2,$3,$4,'coeval/binary-calibration-private-ledger/v1',$5,$6,$7::timestamptz)`,
        [ledgerId, run.id, run.project_id, artifactId, ledgerBytes, ledgerCommitment, artifactCreatedAt]
      );
      const artifactRow = (await client.query(
        `insert into binary_calibration_artifacts
           (id,run_id,project_id,private_ledger_id,artifact_revision,predecessor_artifact_id,
            correction_reason,status,contract,canonical_bytes,artifact_digest,evidence_digest,created_at)
         values ($1,$2,$3,$4,1,null,null,$5,'coeval/binary-calibration/v1',$6,$7,$8,$9::timestamptz)
         returning id,run_id,canonical_bytes,artifact_digest,evidence_digest,created_at`,
        [artifactId, run.id, run.project_id, ledgerId, artifact.status, artifactBytes,
          artifactDigest, artifact.evidenceDigest, artifactCreatedAt]
      )).rows[0];
      const terminalState = artifact.status === "complete" ? "complete" : "incomplete";
      const terminalRun = (await client.query<RunRow>(
        `update binary_calibration_runs
         set state=$2,accounted_observations=planned_observations,completion_check_id=$3,
             artifact_id=$4,artifact_digest=$6,evidence_digest=$7,completed_at=$5::timestamptz,
             claim_worker_id=null,claim_token=null,claim_expires_at=null
         where id=$1 returning *`,
        [run.id, terminalState, completionCheck.id, artifactId, completedAt,
          artifactDigest, artifact.evidenceDigest]
      )).rows[0]!;
      const released = await client.query(
        `delete from binary_calibration_revision_leases
         where run_id=$1 and dataset_revision_id=$2 returning run_id`,
        [run.id, run.dataset_revision_id]
      );
      if (!released.rows[0]) throw repoError("state_conflict", "binary calibration revision lease disappeared during mint");
      return {
        run: rowToRun(terminalRun),
        artifact,
        artifactCopy: artifactCopyFromRow(artifactRow),
        completion: {
          state: completion.exposureState,
          eligibility: completion.eligible ? "eligible" : "ineligible",
          reasons: completion.reasons,
          snapshotDigest: completionCheck.snapshotDigest,
          eventId: completionCheck.id,
          recordedAt: completionRecordedAt
        }
      };
    });
  }

  async markRecoveryRequired(claim: BinaryCalibrationExecutionClaim): Promise<void> {
    const result = await this.pool.query(
      `update binary_calibration_runs
       set state='recovery_required',claim_worker_id=null,claim_token=null,claim_expires_at=null
       where id=$1 and claim_worker_id=$2 and claim_token=$3 and state='running'
       returning id`,
      [claim.runId, claim.workerId, claim.claimToken]
    );
    if (!result.rows[0]) throw repoError("state_conflict", "binary calibration worker claim is stale");
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const value = await work(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }
}

async function deriveRunIdentity(
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

async function evaluateEligibility(
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

function snapshotRecord(
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

async function insertExposureCheck(
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

async function loadExposureCheck(db: Db, checkId: string): Promise<{
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

async function loadAuthorizedRun(
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

async function requireClaim(
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

async function requireActiveRevisionLease(client: PoolClient, run: RunRow): Promise<void> {
  const result = await client.query(
    `select run_id from binary_calibration_revision_leases
     where dataset_revision_id=$1 and run_id=$2 for update`,
    [run.dataset_revision_id, run.id]
  );
  if (!result.rows[0]) throw repoError("state_conflict", "binary calibration revision lease is missing");
}

function aggregateTrial(records: BinaryCalibrationPrivateLedger["records"]) {
  const outcomes = {
    planned: records.length,
    classified: 0,
    abstained: 0,
    errored: 0,
    unevaluated: 0,
    providerCalls: 0,
    byTruth: {
      pass: { classified: 0, abstained: 0, errored: 0, unevaluated: 0 },
      fail: { classified: 0, abstained: 0, errored: 0, unevaluated: 0 }
    },
    errors: [] as Array<{ code: BinaryCalibrationErrorCode; count: number }>
  };
  const truthSupport = { total: records.length, pass: 0, fail: 0 };
  const confusionMatrix = {
    truthPassEvaluatorPass: 0,
    truthPassEvaluatorFail: 0,
    truthFailEvaluatorPass: 0,
    truthFailEvaluatorFail: 0
  };
  const errors = new Map<BinaryCalibrationErrorCode, number>();
  const groups = new Map<string, {
    provider: string;
    observedModel: string | null;
    observedVersion: string | null;
    systemFingerprint: string | null;
    identityStrength: "observed_version" | "observed_fingerprint" | "observed_model" | "requested_only";
    observationCount: number;
  }>();
  for (const record of records) {
    truthSupport[record.truthLabel] += 1;
    outcomes.providerCalls += record.physicalProviderCalls;
    const bucket = record.terminalEvaluatorOutcome === "evaluator_pass" ||
      record.terminalEvaluatorOutcome === "evaluator_fail"
      ? "classified"
      : record.terminalEvaluatorOutcome;
    const outcomeBucket = bucket === "classified" || bucket === "abstained" ||
      bucket === "errored" || bucket === "unevaluated" ? bucket : "errored";
    outcomes[outcomeBucket] += 1;
    outcomes.byTruth[record.truthLabel][outcomeBucket] += 1;
    if (record.terminalEvaluatorOutcome === "evaluator_pass") {
      confusionMatrix[record.truthLabel === "pass" ?
        "truthPassEvaluatorPass" : "truthFailEvaluatorPass"] += 1;
    } else if (record.terminalEvaluatorOutcome === "evaluator_fail") {
      confusionMatrix[record.truthLabel === "pass" ?
        "truthPassEvaluatorFail" : "truthFailEvaluatorFail"] += 1;
    }
    if (record.errorCode) errors.set(record.errorCode, (errors.get(record.errorCode) ?? 0) + 1);
    const identityStrength = record.providerObservation.observedVersion !== null
      ? "observed_version" as const
      : record.providerObservation.systemFingerprint !== null
        ? "observed_fingerprint" as const
        : record.providerObservation.observedModel !== null
          ? "observed_model" as const
          : "requested_only" as const;
    const group = { ...record.providerObservation, identityStrength, observationCount: 1 };
    const key = canonicalJson({
      provider: group.provider,
      observedModel: group.observedModel,
      observedVersion: group.observedVersion,
      systemFingerprint: group.systemFingerprint,
      identityStrength: group.identityStrength
    });
    const prior = groups.get(key);
    groups.set(key, prior ? { ...prior, observationCount: prior.observationCount + 1 } : group);
  }
  outcomes.errors = [...errors.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, count]) => ({ code, count }));
  const providerIdentityGroups = [...groups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, group]) => group);
  return { outcomes, truthSupport, confusionMatrix, providerIdentityGroups };
}

function requestedBindingFor(binding: ModelBinding): BinaryCalibrationRequestedModelBinding {
  if (!["anthropic", "openai", "openrouter", "custom", "mock"].includes(binding.provider)) {
    throw repoError("unsupported", "sealed calibration requires a canonical supported provider id");
  }
  if (!binding.modelId || !binding.modelVersion ||
      Array.from(binding.modelId).length > 4_096 || Array.from(binding.modelVersion).length > 4_096 ||
      containsLoneSurrogate(binding.modelId) || containsLoneSurrogate(binding.modelVersion)) {
    throw repoError("unsupported", "sealed calibration requires a nonempty model id and requested version");
  }
  const endpointKind = binding.provider === "custom" ? "custom" as const : "managed" as const;
  if ((endpointKind === "custom") !== Boolean(binding.baseUrl)) {
    throw repoError("unsupported", "custom sealed calibration bindings require an exact base URL");
  }
  const unsigned = {
    provider: binding.provider,
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    temperatureDecimal: canonicalDecimal(binding.temperature),
    topPDecimal: binding.topP === undefined ? null : canonicalDecimal(binding.topP),
    endpointKind,
    baseUrlDigest: binding.baseUrl ? binaryCalibrationBaseUrlDigest(binding.baseUrl) : null
  };
  return { ...unsigned, requestedBindingDigest: sha256Digest(unsigned) };
}

function requestedBindingFromRun(run: Record<string, unknown>): BinaryCalibrationRequestedModelBinding {
  return {
    provider: String(run.requested_provider),
    modelId: String(run.requested_model_id),
    modelVersion: String(run.requested_model_version),
    temperatureDecimal: String(run.temperature_decimal),
    topPDecimal: nullableString(run.top_p_decimal),
    endpointKind: run.endpoint_kind === "custom" ? "custom" : "managed",
    baseUrlDigest: nullableString(run.base_url_digest),
    requestedBindingDigest: String(run.requested_binding_digest)
  };
}

function providerPolicyFor(
  binding: BinaryCalibrationRequestedModelBinding
): BinaryCalibrationProviderDataHandlingPolicy {
  const executionEnvironment = binding.provider === "mock" ? "local_provider" : "external_provider";
  const policyContent = {
    contract: "coeval/provider-data-handling-policy/v1",
    schemaVersion: 1,
    provider: binding.provider,
    endpointKind: binding.endpointKind,
    baseUrlDigest: binding.baseUrlDigest,
    executionEnvironment,
    payloadTransmission: "sealed_payload_to_pinned_provider" as const,
    rawProviderResponsePersistence: "none"
  };
  const policyDigest = sha256Digest(policyContent);
  return {
    executionEnvironment,
    policyId: stableId("bcp", policyDigest),
    policyDigest,
    payloadTransmission: "sealed_payload_to_pinned_provider"
  };
}

function skillVersionFromRow(row: Record<string, unknown>): SkillVersion {
  const scalarRange = row.scalar_range === null || row.scalar_range === undefined
    ? null : parseJson(row.scalar_range);
  const choices = row.categorical_choice_scores === null || row.categorical_choice_scores === undefined
    ? null : parseJson(row.categorical_choice_scores);
  return SkillVersionSchema.parse({
    id: String(row.id),
    skillId: String(row.skill_id),
    criterionVersionId: String(row.criterion_version_id),
    version: String(row.version),
    status: String(row.status),
    rubricMarkdown: String(row.rubric_markdown),
    prompt: String(row.prompt),
    modelBinding: parseJson(row.model_binding),
    outputSchema: parseJson(row.output_schema),
    goldenSetAgreement: row.golden_set_agreement == null ? null : Number(row.golden_set_agreement),
    tooStrictCount: Number(row.too_strict_count),
    tooLenientCount: Number(row.too_lenient_count),
    ambiguousCount: Number(row.ambiguous_count),
    knownLimitations: asStringArray(row.known_limitations),
    verdictKind: String(row.verdict_kind),
    scalarRange,
    categoricalChoiceScores: choices,
    rubricProvenance: String(row.rubric_provenance),
    regressionDatasetRevisionId: nullableString(row.regression_dataset_revision_id),
    createdAt: toIso(row.created_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null
  });
}

function rowToRun(row: RunRow): BinaryCalibrationRunProjection {
  return {
    runId: String(row.id),
    projectId: String(row.project_id),
    datasetRevisionId: String(row.dataset_revision_id),
    revisionDigest: String(row.revision_digest),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    skillId: String(row.skill_id),
    skillVersionId: String(row.skill_version_id),
    positiveClass: row.positive_class === "pass" ? "pass" : "fail",
    trialPlan: { kind: "single", trialsPerItem: 1 },
    suiteBinding: row.suite_manifest_id === null ? null : {
      manifestId: String(row.suite_manifest_id),
      manifestDigest: String(row.suite_manifest_digest),
      memberPosition: Number(row.suite_member_position)
    },
    state: row.state,
    plannedObservations: Number(row.planned_observations),
    accountedObservations: Number(row.accounted_observations),
    artifactId: nullableString(row.artifact_id),
    artifactDigest: nullableString(row.artifact_digest),
    evidenceDigest: nullableString(row.evidence_digest),
    createdAt: toIso(row.created_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null
  };
}

function artifactCopyFromRow(row: Record<string, unknown>): BinaryCalibrationArtifactCopy {
  return {
    artifactId: String(row.id),
    calibrationRunId: String(row.run_id),
    canonicalBytes: Uint8Array.from(Buffer.from(row.canonical_bytes as Uint8Array)),
    artifactDigest: String(row.artifact_digest),
    evidenceDigest: String(row.evidence_digest),
    createdAt: toIso(row.created_at)
  };
}

function claimFromRow(row: Record<string, unknown>): BinaryCalibrationExecutionClaim {
  return {
    runId: String(row.id),
    workerId: String(row.claim_worker_id),
    claimToken: String(row.claim_token),
    claimExpiresAt: toIso(row.claim_expires_at)
  };
}

function validateCreateInput(input: CreateBinaryCalibrationRunInput): void {
  if (!input.datasetRevisionId || !input.skillVersionId) {
    throw repoError("unsupported", "binary calibration requires revision and evaluator identities");
  }
  if (input.positiveClass !== "pass" && input.positiveClass !== "fail") {
    throw repoError("unsupported", "binary calibration positive class must be pass or fail");
  }
  if (input.trialPlan.kind !== "single" || input.trialPlan.trialsPerItem !== 1) {
    throw repoError("unsupported", "Batch 5B executes only one trial per item");
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200 ||
      input.idempotencyKey.trim() !== input.idempotencyKey) {
    throw repoError("unsupported", "binary calibration idempotency key must be 1-200 unpadded characters");
  }
  if (input.suiteBinding && (!Number.isSafeInteger(input.suiteBinding.memberPosition) ||
      input.suiteBinding.memberPosition < 0 || input.suiteBinding.memberPosition > 99)) {
    throw repoError("unsupported", "binary calibration suite member position must be 0-99");
  }
}

function validateClaimInput(workerId: string, claimTtlMs: number): void {
  if (!workerId || workerId.length > 256 || !Number.isSafeInteger(claimTtlMs) ||
      claimTtlMs < 1_000 || claimTtlMs > 15 * 60_000) {
    throw repoError("unsupported", "binary calibration claim requires a worker id and a 1s-15m TTL");
  }
}

function validateAttemptCompletion(input: CompleteBinaryCalibrationAttemptInput): void {
  const allowedOutcomes = ["evaluator_pass", "evaluator_fail", "abstained", "errored", "unevaluated"];
  const allowedErrors: BinaryCalibrationErrorCode[] = [
    "provider_unavailable", "provider_authentication", "provider_rate_limit", "provider_timeout",
    "provider_transport", "provider_protocol", "invalid_evaluator_output", "outcome_unknown", "internal"
  ];
  if (!allowedOutcomes.includes(input.terminalEvaluatorOutcome)) {
    throw repoError("unsupported", "unknown terminal evaluator outcome");
  }
  if (input.errorCode !== null && !allowedErrors.includes(input.errorCode)) {
    throw repoError("unsupported", "unknown binary calibration error code");
  }
  if ((input.terminalEvaluatorOutcome === "errored") !== (input.errorCode !== null)) {
    throw repoError("conflict", "only errored calibration outcomes carry an error code");
  }
  if (input.errorCode === "outcome_unknown") {
    throw repoError("conflict", "outcome_unknown is reserved for repository crash recovery");
  }
  const expectedState = input.terminalEvaluatorOutcome === "unevaluated" ? "not_started" : "terminal";
  if (input.attemptState !== expectedState) {
    throw repoError("conflict", `${input.terminalEvaluatorOutcome} requires ${expectedState} attempt state`);
  }
  if ((input.providerObservation.observedVersion !== null ||
      input.providerObservation.systemFingerprint !== null) &&
      input.providerObservation.observedModel === null) {
    throw repoError("conflict", "observed provider version/fingerprint requires an observed model");
  }
  for (const value of [
    input.providerObservation.provider,
    input.providerObservation.observedModel,
    input.providerObservation.observedVersion,
    input.providerObservation.systemFingerprint
  ]) {
    if (value !== null && (Array.from(value).length > 4_096 || containsLoneSurrogate(value))) {
      throw repoError("unsupported", "provider observation strings exceed the contract boundary");
    }
  }
}

async function requireProjectOwner(client: PoolClient, actor: BinaryCalibrationActor): Promise<void> {
  const result = await client.query(
    `select 1 from project_members where project_id=$1 and user_id=$2 and role='owner'`,
    [actor.projectId, actor.userId]
  );
  if (!result.rows[0]) throw repoError("forbidden", "only a project owner may start sealed calibration");
}

function requireOwner(actor: BinaryCalibrationActor): void {
  if (actor.projectRole !== "owner") {
    throw repoError("forbidden", "only a project owner may start sealed calibration");
  }
}

function repoError(
  code: ConstructorParameters<typeof BinaryCalibrationRepositoryError>[0],
  message: string
): BinaryCalibrationRepositoryError {
  return new BinaryCalibrationRepositoryError(code, message);
}

function mapPgError(error: unknown): Error {
  if (error instanceof BinaryCalibrationRepositoryError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code) : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint) : "";
  if (code === "23505" && constraint.includes("idempotency")) {
    return repoError("idempotency_conflict", "binary calibration idempotency conflict");
  }
  if (code === "23505" || code === "40001" || code === "40P01" || code === "55000") {
    return repoError("state_conflict", "binary calibration state conflict");
  }
  if (code === "23503" || code === "23514") {
    return repoError("ineligible", "binary calibration identity or invariant is ineligible");
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function insertEvaluatorExecutionAuthorization(
  client: PoolClient,
  run: Record<string, unknown>,
  input: {
    context: "binary_calibration_evidence";
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }
): Promise<void> {
  const current = (await client.query(
    `select lifecycle.id as lifecycle_id,head.id as event_id,head.calibration_artifact_id
     from skill_versions version
     left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
     left join lateral evaluator_lifecycle_head_v1(lifecycle.id) head on true
     where version.project_id=$1 and version.id=$2`,
    [run.project_id, run.skill_version_id]
  )).rows[0];
  if (!current) throw repoError("ineligible", "binary calibration evaluator version is unavailable");
  const contentDigest = evaluatorExecutionAuthorizationDigest({
    projectId: String(run.project_id),
    skillVersionId: String(run.skill_version_id),
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
    [stableId("eauth",String(run.id),input.context),EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,
      run.project_id,run.skill_version_id,input.context,current.event_id ?? null,
      current.calibration_artifact_id ?? null,input.resourceKind,input.resourceId,input.idempotencyKey,
      contentDigest]
  );
  const persistedDigest = authorization.rows[0]?.content_digest ?? (await client.query(
    `select content_digest from evaluator_execution_authorizations
     where project_id=$1 and idempotency_key=$2`,
    [run.project_id,input.idempotencyKey]
  )).rows[0]?.content_digest;
  if (String(persistedDigest ?? "") !== contentDigest) {
    throw repoError("ineligible", "binary calibration execution authorization replay does not match");
  }
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 48)}`;
}

function canonicalDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    throw repoError("unsupported", "model binding decimal is not a canonical nonnegative finite number");
  }
  const raw = JSON.stringify(value);
  if (!/[eE]/.test(raw)) return raw;
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (!match) throw repoError("unsupported", "model binding decimal cannot be canonicalized");
  const integer = match[1]!;
  const fraction = match[2] ?? "";
  const digits = `${integer}${fraction}`;
  const point = integer.length + Number(match[3]);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${"0".repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

async function databaseClock(db: Db): Promise<string> {
  const row = (await db.query(
    `select date_trunc('milliseconds',clock_timestamp()) as recorded_at`
  )).rows[0];
  return toIso(row.recorded_at);
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid persisted timestamp");
  return date.toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function isString(value: string | null): value is string {
  return value !== null;
}

function isEmptyObject(value: unknown): boolean {
  return !(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0);
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) return true;
  }
  return false;
}
