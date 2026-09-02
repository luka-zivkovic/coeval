import type { PoolClient } from "pg";

import {
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest
} from "../lib/dataset-revision.js";
import { governedReviewRequestDigest } from "../lib/governed-review.js";
import type {
  GovernedReviewBatchProjection,
  GovernedReviewerTaskProjection,
  GovernedReviewStreamCommand,
  GovernedTaskMutationProjection
} from "./contracts.js";
import {
  GovernedReviewForbiddenError,
  GovernedReviewNotFoundError,
  GovernedReviewTransitionConflictError
} from "./errors.js";
import { assertBlindProjectionSafe } from "./projection.js";
import type { GovernedBatchAction, GovernedReviewActor } from "./repository.js";

import {
  BatchRow,
  COVERED_CAPABILITIES,
  Db,
  asStringArray,
  assertReplay,
  dbDigest,
  isEmptyObject,
  iso,
  parseJson,
  stableId
} from "./repository.pg-common.js";

export async function lockBatch(client: PoolClient, projectId: string, batchId: string): Promise<BatchRow> {
  const row = (await client.query(
    `select * from governed_review_batches where id=$1 and project_id=$2 for update`,
    [batchId, projectId]
  )).rows[0];
  if (!row) throw new GovernedReviewNotFoundError();
  return row as BatchRow;
}
export async function currentBatchState(
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

export async function currentTaskState(
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

export async function readTaskStateWithoutScope(
  db: Db,
  taskId: string
): Promise<{ currentState: string; currentVersion: number }> {
  const current = await currentTaskState(db, taskId);
  return { currentState: current.state, currentVersion: current.version };
}

export async function loadBatchProjection(
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

export async function loadTaskMutation(db: Db, taskId: string): Promise<GovernedTaskMutationProjection> {
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

export function rowToTaskProjection(row: Record<string, unknown>): GovernedReviewerTaskProjection {
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

export async function deriveBatchEventKind(
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

export async function observeBatchEventClock(
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

export async function batchEventDetails(
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

export async function contentExposedSubjects(
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

export async function appendCapabilityChecks(
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

export async function materializeFrozenTruth(
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
