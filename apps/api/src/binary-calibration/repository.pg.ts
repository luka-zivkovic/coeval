import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type BinaryCalibrationArtifact,
  type BinaryCalibrationErrorCode,
  type BinaryCalibrationPrivateLedger
} from "@coeval/shared";

import { sha256Digest } from "../lib/assessment-receipt.js";
import {
  binaryCalibrationArtifactDigest,
  binaryCalibrationPrivateLedgerCommitmentDigest,
  buildBinaryCalibrationArtifact,
  canonicalBinaryCalibrationArtifactBytes,
  canonicalBinaryCalibrationPrivateLedgerBytes,
  verifyBinaryCalibrationPrivateLedgerForArtifact
} from "../lib/binary-calibration.js";

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
  BinaryCalibrationRunProjection,
  CompleteBinaryCalibrationAttemptInput,
  CreateBinaryCalibrationRunInput
} from "./repository.js";

import {
  deriveRunIdentity,
  evaluateEligibility,
  insertExposureCheck,
  loadAuthorizedRun,
  loadExposureCheck,
  requireActiveRevisionLease,
  requireClaim,
  snapshotRecord
} from "./repository.pg-authorization.js";
import {
  RunRow,
  aggregateTrial,
  artifactCopyFromRow,
  asStringArray,
  claimFromRow,
  databaseClock,
  insertEvaluatorExecutionAuthorization,
  mapPgError,
  nullableString,
  parseJson,
  repoError,
  requestedBindingFromRun,
  requireOwner,
  requireProjectOwner,
  rowToRun,
  stableId,
  toIso,
  validateAttemptCompletion,
  validateClaimInput,
  validateCreateInput
} from "./repository.pg-support.js";

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
