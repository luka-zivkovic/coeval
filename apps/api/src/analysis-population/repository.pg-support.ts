import {
  ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
  ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
  ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
  ANALYSIS_POPULATION_ORDERING_VERSION,
  AnalysisPopulationCreateResultSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisPopulation,
  type AnalysisPopulationCreateResult,
  type AnalysisPopulationDrawSelection,
  type AnalysisPopulationDrawSummary,
  type AnalysisPopulationExclusion,
  type AnalysisPopulationMember,
  type DatasetRevisionPayloadSnapshot
} from "@coeval/shared";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  analysisPopulationClaim,
  analysisPopulationExclusionDigest,
  analysisPopulationFrameMemberDigest,
  analysisPopulationItemDigest,
  analysisPopulationMemberLineageDigest,
  normalizeAnalysisPopulationTimestamp
} from "../lib/analysis-population.js";
import { AnalysisPopulationRepositoryError } from "./repository.js";

const SCAN_BATCH_SIZE = 1_000;
// Full snapshots can approach the 256 KiB ingestion ceiling. Keep payload
// pages small enough that node-pg rows plus the JSON insert copy stay bounded.
const PAYLOAD_SCAN_BATCH_SIZE = 50;
const INSERT_BATCH_SIZE = 250;

interface ScanRow extends Record<string, unknown> {
  id: string;
  created_at_exact: string;
  ingestion_time: string;
  case_type: string;
  ingestion_purpose: string;
  raw_trace_id: string | null;
  source_trace_id: string | null;
  input_digest: string | null;
  identity_count: string | number | null;
  identity_usage_class: string | null;
  normalized_payload?: unknown;
}

interface PreparedMember {
  id: string;
  revisionItemId: string;
  caseId: string;
  rawTraceId: string;
  sourceTraceId: string;
  caseType: "manual" | "langsmith" | "langfuse" | "ironside";
  ingestionPurpose:
    | "analysis_eligible_manual"
    | "analysis_eligible_langsmith"
    | "analysis_eligible_langfuse"
    | "analysis_eligible_ironside";
  position: number;
  ingestionTime: string;
  inputDigest: string;
  itemDigest: string;
  frameMemberDigest: string;
  lineageDigest: string;
}

interface CursorValue {
  createdAt?: string;
  id?: string;
  position?: string;
}

export async function scanWindowPreflight(
  client: PoolClient,
  projectId: string,
  windowStart: string,
  windowEnd: string
): Promise<{
  identityUnresolved: boolean;
  sealedOverlap: boolean;
  eligibleCount: number;
  exclusionCount: bigint;
}> {
  let afterTime: string | null = null;
  let afterId: string | null = null;
  let identityUnresolved = false;
  let sealedOverlap = false;
  let eligibleCount = 0;
  let exclusionCount = 0n;
  while (true) {
    const page = await scanRows(client, projectId, windowStart, windowEnd, afterTime, afterId, false);
    for (const row of page) {
      if (isEligiblePair(row.case_type, row.ingestion_purpose)) {
        eligibleCount += 1;
        if (
          !row.raw_trace_id ||
          !row.source_trace_id ||
          !row.input_digest ||
          Number(row.identity_count) !== 1
        ) identityUnresolved = true;
        if (row.identity_usage_class === "sealed") sealedOverlap = true;
      } else {
        exclusionCount += 1n;
      }
    }
    if (page.length < SCAN_BATCH_SIZE) break;
    const last = page[page.length - 1]!;
    afterTime = last.created_at_exact;
    afterId = last.id;
  }
  return { identityUnresolved, sealedOverlap, eligibleCount, exclusionCount };
}

export async function prepareEligibleMembers(
  client: PoolClient,
  projectId: string,
  windowStart: string,
  windowEnd: string,
  revisionId: string
): Promise<PreparedMember[]> {
  const prepared: PreparedMember[] = [];
  let afterTime: string | null = null;
  let afterId: string | null = null;
  while (true) {
    const page = await scanRows(
      client,
      projectId,
      windowStart,
      windowEnd,
      afterTime,
      afterId,
      true,
      PAYLOAD_SCAN_BATCH_SIZE
    );
    for (const row of page) {
      if (!isEligiblePair(row.case_type, row.ingestion_purpose)) continue;
      if (
        !row.raw_trace_id ||
        !row.source_trace_id ||
        !row.input_digest ||
        Number(row.identity_count) !== 1
      ) {
        throw repoError("analysis_population_identity_unresolved", "Eligible analysis evidence lost its exact retained identity");
      }
      let payloadSnapshot: DatasetRevisionPayloadSnapshot;
      try {
        payloadSnapshot = normalizedPayloadSnapshot(row.normalized_payload);
      } catch (error) {
        throw repoError(
          "analysis_population_revision_conflict",
          error instanceof Error ? error.message : "Eligible analysis evidence has no valid frozen payload"
        );
      }
      const position = prepared.length;
      const inputIdentity = { basis: "input-identity/v1" as const, digest: row.input_digest };
      const itemDigest = analysisPopulationItemDigest({ caseId: row.id, inputIdentity, payloadSnapshot });
      const ingestionTime = normalizeAnalysisPopulationTimestamp(row.ingestion_time);
      const frameMemberDigest = analysisPopulationFrameMemberDigest({
        caseId: row.id,
        inputDigest: row.input_digest,
        itemDigest,
        ingestionTime,
        position
      });
      const revisionItemId = `dsri_${randomUUID()}`;
      prepared.push({
        id: `apm_${randomUUID()}`,
        revisionItemId,
        caseId: row.id,
        rawTraceId: row.raw_trace_id,
        sourceTraceId: row.source_trace_id,
        caseType: row.case_type,
        ingestionPurpose: row.ingestion_purpose as PreparedMember["ingestionPurpose"],
        position,
        ingestionTime,
        inputDigest: row.input_digest,
        itemDigest,
        frameMemberDigest,
        lineageDigest: analysisPopulationMemberLineageDigest({
          caseId: row.id,
          revisionItemId,
          inputDigest: row.input_digest,
          itemDigest,
          ingestionTime,
          position
        })
      });
    }
    if (page.length < PAYLOAD_SCAN_BATCH_SIZE) break;
    const last = page[page.length - 1]!;
    afterTime = last.created_at_exact;
    afterId = last.id;
  }
  return prepared;
}

async function scanRows(
  client: PoolClient,
  projectId: string,
  windowStart: string,
  windowEnd: string,
  afterTime: string | null,
  afterId: string | null,
  withPayload: boolean,
  limit = SCAN_BATCH_SIZE
): Promise<ScanRow[]> {
  const result = await client.query<ScanRow>(
    `select case_row.id,
            case_row.created_at::text as created_at_exact,
            analysis_timestamp_v1(case_row.created_at) as ingestion_time,
            case_row.case_type,
            case_row.ingestion_purpose,
            case_row.raw_trace_id,
            raw.source_trace_id,
            identity_record.input_digest,
            identity_record.identity_count,
            claim.usage_class as identity_usage_class
            ${withPayload ? ",case_row.normalized_payload" : ""}
     from cases case_row
     left join raw_traces raw
       on raw.id=case_row.raw_trace_id and raw.project_id=case_row.project_id
     left join lateral (
       select identity_value.input_digest,count(*) over() as identity_count
       from case_input_identity_records identity_value
       where identity_value.project_id=case_row.project_id
         and identity_value.source_case_id=case_row.id
         and identity_value.identity_basis='input-identity/v1'
         and identity_value.record_kind in ('authoring_import','identity_resolved')
         and identity_value.input_digest is not null
       order by case when identity_value.record_kind='authoring_import' then 0 else 1 end,
                identity_value.created_at,identity_value.id
       limit 1
     ) identity_record on true
     left join governed_input_identity_claims claim
       on claim.project_id=case_row.project_id and claim.input_digest=identity_record.input_digest
     where case_row.project_id=$1
       and case_row.created_at >= $2 and case_row.created_at < $3
       and ($4::timestamptz is null or (case_row.created_at,case_row.id)>($4,$5))
     order by case_row.created_at,case_row.id
     limit ${limit}`,
    [projectId, windowStart, windowEnd, afterTime, afterId]
  );
  return result.rows;
}

export async function insertRevisionItems(
  client: PoolClient,
  projectId: string,
  revisionId: string,
  windowStart: string,
  windowEnd: string,
  members: readonly PreparedMember[]
): Promise<void> {
  let afterTime: string | null = null;
  let afterId: string | null = null;
  let position = 0;
  while (true) {
    const page = await scanRows(
      client,
      projectId,
      windowStart,
      windowEnd,
      afterTime,
      afterId,
      true,
      PAYLOAD_SCAN_BATCH_SIZE
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const row of page) {
      if (!isEligiblePair(row.case_type, row.ingestion_purpose)) continue;
      const member = members[position];
      if (!member || member.caseId !== row.id || !row.input_digest) {
        throw repoError(
          "analysis_population_revision_conflict",
          "Analysis population payload pass no longer matches the frozen frame"
        );
      }
      let payloadSnapshot: DatasetRevisionPayloadSnapshot;
      try {
        payloadSnapshot = normalizedPayloadSnapshot(row.normalized_payload);
      } catch (error) {
        throw repoError(
          "analysis_population_revision_conflict",
          error instanceof Error ? error.message : "Eligible analysis evidence has no valid frozen payload"
        );
      }
      const itemDigest = analysisPopulationItemDigest({
        caseId: member.caseId,
        inputIdentity: { basis: "input-identity/v1", digest: row.input_digest },
        payloadSnapshot
      });
      if (row.input_digest !== member.inputDigest || itemDigest !== member.itemDigest) {
        throw repoError(
          "analysis_population_revision_conflict",
          "Analysis population payload changed inside its repeatable-read snapshot"
        );
      }
      rows.push({
        id: member.revisionItemId,
        position: member.position,
        case_id: member.caseId,
        source_trace_id: member.sourceTraceId,
        input_digest: member.inputDigest,
        item_digest: member.itemDigest,
        payload_snapshot: payloadSnapshot,
        reference_provenance: {
          kind: "unlabeled",
          sourceId: member.caseId,
          verdictIds: [],
          actorUserIds: [],
          basis: "Analysis population member; no reference label."
        }
      });
      position += 1;
    }
    await client.query(
      `insert into dataset_revision_items
         (id,revision_id,project_id,position,source_case_id,source_trace_id,
          source_dataset_item_id,source_golden_entry_id,input_digest,item_digest,
          payload_snapshot,reference_label,reference_fail_step,reference_provenance,note)
       select row_value.id,$1,$2,row_value.position,row_value.case_id,row_value.source_trace_id,
              null,null,row_value.input_digest,row_value.item_digest,row_value.payload_snapshot,
              null,null,row_value.reference_provenance,null
       from jsonb_to_recordset($3::jsonb) as row_value(
         id text,position integer,case_id text,source_trace_id text,input_digest text,
         item_digest text,payload_snapshot jsonb,reference_provenance jsonb
       )`,
      [revisionId, projectId, JSON.stringify(rows)]
    );
    if (page.length < PAYLOAD_SCAN_BATCH_SIZE) break;
    const last = page[page.length - 1]!;
    afterTime = last.created_at_exact;
    afterId = last.id;
  }
  if (position !== members.length) {
    throw repoError(
      "analysis_population_revision_conflict",
      "Analysis population payload pass did not cover the exact frozen frame"
    );
  }
}

export async function insertMembers(
  client: PoolClient,
  projectId: string,
  populationId: string,
  members: readonly PreparedMember[]
): Promise<void> {
  for (let start = 0; start < members.length; start += INSERT_BATCH_SIZE) {
    const rows = members.slice(start, start + INSERT_BATCH_SIZE);
    await client.query(
      `insert into analysis_population_members
         (id,project_id,population_id,revision_item_id,case_id,raw_trace_id,source_trace_id,
          case_type,ingestion_purpose,position,ingestion_time,input_digest,item_digest,
          frame_member_digest,lineage_digest)
       select row_value.id,$1,$2,row_value.revision_item_id,row_value.case_id,
              case_row.raw_trace_id,raw.source_trace_id,case_row.case_type,case_row.ingestion_purpose,
              row_value.position,case_row.created_at,row_value.input_digest,row_value.item_digest,
              row_value.frame_member_digest,row_value.lineage_digest
       from jsonb_to_recordset($3::jsonb) as row_value(
         id text,revision_item_id text,case_id text,position integer,input_digest text,
         item_digest text,frame_member_digest text,lineage_digest text
       )
       join cases case_row on case_row.id=row_value.case_id and case_row.project_id=$1
       join raw_traces raw on raw.id=case_row.raw_trace_id and raw.project_id=$1`,
      [projectId, populationId, JSON.stringify(rows.map((member) => ({
        id: member.id,
        revision_item_id: member.revisionItemId,
        case_id: member.caseId,
        position: member.position,
        input_digest: member.inputDigest,
        item_digest: member.itemDigest,
        frame_member_digest: member.frameMemberDigest,
        lineage_digest: member.lineageDigest
      })))]
    );
  }
}

export async function insertExclusions(
  client: PoolClient,
  projectId: string,
  populationId: string,
  windowStart: string,
  windowEnd: string,
  expectedCount: bigint
): Promise<void> {
  let afterTime: string | null = null;
  let afterId: string | null = null;
  let position = 0n;
  while (true) {
    const page = await scanRows(client, projectId, windowStart, windowEnd, afterTime, afterId, false);
    const exclusions: Array<Record<string, unknown>> = [];
    for (const row of page) {
      if (isEligiblePair(row.case_type, row.ingestion_purpose)) continue;
      const contentDigest = analysisPopulationExclusionDigest({
        caseId: row.id,
        rawTraceId: row.raw_trace_id,
        sourceTraceId: row.source_trace_id,
        caseType: row.case_type as AnalysisPopulationExclusion["caseType"],
        ingestionPurpose: row.ingestion_purpose as AnalysisPopulationExclusion["ingestionPurpose"],
        ingestionTime: row.ingestion_time,
        position: position.toString(),
        reason: "ineligible_ingestion_purpose"
      } as Parameters<typeof analysisPopulationExclusionDigest>[0]);
      exclusions.push({
        id: `ape_${randomUUID()}`,
        case_id: row.id,
        position: position.toString(),
        content_digest: contentDigest
      });
      position += 1n;
    }
    for (let start = 0; start < exclusions.length; start += INSERT_BATCH_SIZE) {
      const rows = exclusions.slice(start, start + INSERT_BATCH_SIZE);
      await client.query(
        `insert into analysis_population_exclusions
           (id,project_id,population_id,case_id,raw_trace_id,source_trace_id,case_type,
            ingestion_purpose,position,ingestion_time,reason,content_digest)
         select row_value.id,$1,$2,row_value.case_id,case_row.raw_trace_id,raw.source_trace_id,
                case_row.case_type,case_row.ingestion_purpose,row_value.position,case_row.created_at,
                'ineligible_ingestion_purpose',row_value.content_digest
         from jsonb_to_recordset($3::jsonb) as row_value(
           id text,case_id text,position bigint,content_digest text
         )
         join cases case_row on case_row.id=row_value.case_id and case_row.project_id=$1
         left join raw_traces raw on raw.id=case_row.raw_trace_id and raw.project_id=$1`,
        [projectId, populationId, JSON.stringify(rows)]
      );
    }
    if (page.length < SCAN_BATCH_SIZE) break;
    const last = page[page.length - 1]!;
    afterTime = last.created_at_exact;
    afterId = last.id;
  }
  if (position !== expectedCount) {
    throw repoError("analysis_population_revision_conflict", "Analysis exclusion set changed inside its snapshot");
  }
}

export async function insertDrawItems(
  client: PoolClient,
  projectId: string,
  populationId: string,
  drawId: string,
  selections: readonly {
    memberId: string;
    revisionItemId: string;
    caseId: string;
    frameMemberDigest: string;
    rankDigest: string;
    contentDigest: string;
    position: number;
  }[]
): Promise<void> {
  for (let start = 0; start < selections.length; start += INSERT_BATCH_SIZE) {
    const rows = selections.slice(start, start + INSERT_BATCH_SIZE).map((selection) => ({
      id: `apdi_${randomUUID()}`,
      member_id: selection.memberId,
      revision_item_id: selection.revisionItemId,
      case_id: selection.caseId,
      position: selection.position,
      frame_member_digest: selection.frameMemberDigest,
      rank_digest: selection.rankDigest,
      content_digest: selection.contentDigest
    }));
    await client.query(
      `insert into analysis_population_draw_items
         (id,project_id,draw_id,population_id,member_id,revision_item_id,case_id,
          position,frame_member_digest,rank_digest,content_digest)
       select row_value.id,$1,$2,$3,row_value.member_id,row_value.revision_item_id,
              row_value.case_id,row_value.position,row_value.frame_member_digest,
              row_value.rank_digest,row_value.content_digest
       from jsonb_to_recordset($4::jsonb) as row_value(
         id text,member_id text,revision_item_id text,case_id text,position integer,
         frame_member_digest text,rank_digest text,content_digest text
       )`,
      [projectId, drawId, populationId, JSON.stringify(rows)]
    );
  }
}

export async function insertRequestAlias(
  client: PoolClient,
  input: { projectId: string; idempotencyKey: string; requestDigest: string; populationId: string }
): Promise<void> {
  await client.query(
    `insert into analysis_population_requests
       (id,project_id,idempotency_key,request_digest,population_id)
     values ($1,$2,$3,$4,$5)`,
    [`apr_${randomUUID()}`, input.projectId, input.idempotencyKey, input.requestDigest, input.populationId]
  );
}

export async function insertCreationExposure(
  client: PoolClient,
  input: { projectId: string; userId: string; subjectId: string; populationId: string; revisionId: string }
): Promise<void> {
  await client.query(
    `insert into dataset_exposure_events
       (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,
        subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,
        reason,details,idempotency_key)
     values ($1,$2,$3,null,'created','lineage','revision_create','person',$4,$5,
             'dataset_revision',$3,'Immutable analysis population created',$6,$7)`,
    [
      `dse_${randomUUID()}`,
      input.projectId,
      input.revisionId,
      input.subjectId,
      input.userId,
      JSON.stringify({ contract: "coeval/analysis-population-lineage/v1", populationId: input.populationId }),
      `analysis-population-created:${input.populationId}`
    ]
  );
}

export async function loadCreateResult(
  db: Pool | PoolClient,
  projectId: string,
  populationId: string,
  reused: boolean
): Promise<AnalysisPopulationCreateResult> {
  const result = await db.query(`${summarySelect()} where population.project_id=$1 and population.id=$2`, [projectId, populationId]);
  if (!result.rows[0]) throw repoError("analysis_population_not_found", "Analysis population not found");
  return AnalysisPopulationCreateResultSchema.parse({
    ...rowToSummary(result.rows[0]),
    reusedPopulation: reused,
    reusedDraw: reused
  });
}

export function summarySelect(): string {
  return `select population.id as population_id,population.project_id,population.dataset_revision_id,
                 population.window_start,population.window_end,population.eligible_sources,
                 population.eligible_ingestion_purposes,population.canonicalization_version,
                 population.ordering_version,population.population_size,population.exclusion_count,
                 population.frame_digest,population.content_digest,population.snapshot_xid8,
                 population.snapshot_taken_at,population.created_by_user_id,
                 population.created_by_subject_id,population.created_at as population_created_at,
                 to_char(population.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   as population_created_at_exact,
                 draw.id as draw_id,draw.method,draw.stopping_rule,draw.draw_executor,draw.seed,
                 draw.rng_version,draw.algorithm_version,draw.fixed_budget,
                 draw.inclusion_numerator,draw.inclusion_denominator,draw.draw_digest,
                 draw.content_digest as draw_content_digest,draw.executed_by_subject_id,draw.executed_at
          from analysis_populations population
          join analysis_population_draws draw on draw.population_id=population.id`;
}

export function rowToSummary(row: Record<string, unknown>) {
  const population: AnalysisPopulation = {
    id: String(row.population_id),
    projectId: String(row.project_id),
    datasetRevisionId: String(row.dataset_revision_id),
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    eligibleSources: [...ANALYSIS_POPULATION_ELIGIBLE_SOURCES],
    eligibleIngestionPurposes: [...ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES],
    canonicalizationVersion: ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
    orderingVersion: ANALYSIS_POPULATION_ORDERING_VERSION,
    populationSize: Number(row.population_size),
    exclusionCount: String(row.exclusion_count),
    frameDigest: String(row.frame_digest),
    contentDigest: String(row.content_digest),
    snapshotXid8: String(row.snapshot_xid8),
    snapshotTakenAt: iso(row.snapshot_taken_at),
    createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id),
    createdAt: iso(row.population_created_at)
  };
  const draw: AnalysisPopulationDrawSummary = {
    id: String(row.draw_id),
    projectId: population.projectId,
    populationId: population.id,
    datasetRevisionId: population.datasetRevisionId,
    method: "simple_random",
    stoppingRule: "fixed",
    drawExecutor: "coeval_server",
    seed: String(row.seed),
    rngVersion: "sha256-rank/v1",
    algorithmVersion: "coeval-analysis-draw/v1",
    fixedBudget: Number(row.fixed_budget),
    populationSize: population.populationSize,
    inclusionProbability: {
      numerator: Number(row.inclusion_numerator),
      denominator: Number(row.inclusion_denominator)
    },
    drawDigest: String(row.draw_digest),
    contentDigest: String(row.draw_content_digest),
    executedBySubjectId: String(row.executed_by_subject_id),
    executedAt: iso(row.executed_at)
  };
  return { population, draw, claim: analysisPopulationClaim(population.id) };
}

export function rowToMember(row: Record<string, unknown>): AnalysisPopulationMember {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    populationId: String(row.population_id),
    revisionItemId: String(row.revision_item_id),
    caseId: String(row.case_id),
    caseType: String(row.case_type) as AnalysisPopulationMember["caseType"],
    ingestionPurpose: String(row.ingestion_purpose) as AnalysisPopulationMember["ingestionPurpose"],
    position: Number(row.position),
    ingestionTime: iso(row.ingestion_time),
    inputDigest: String(row.input_digest),
    itemDigest: String(row.item_digest),
    frameMemberDigest: String(row.frame_member_digest),
    lineageDigest: String(row.lineage_digest),
    createdAt: iso(row.created_at)
  };
}

export function rowToSelection(row: Record<string, unknown>): AnalysisPopulationDrawSelection {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    drawId: String(row.draw_id),
    populationId: String(row.population_id),
    memberId: String(row.member_id),
    revisionItemId: String(row.revision_item_id),
    caseId: String(row.case_id),
    position: Number(row.position),
    frameMemberDigest: String(row.frame_member_digest),
    rankDigest: String(row.rank_digest),
    contentDigest: String(row.content_digest),
    createdAt: iso(row.created_at)
  };
}

export function rowToExclusion(row: Record<string, unknown>): AnalysisPopulationExclusion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    populationId: String(row.population_id),
    caseId: String(row.case_id),
    rawTraceId: row.raw_trace_id === null ? null : String(row.raw_trace_id),
    sourceTraceId: row.source_trace_id === null ? null : String(row.source_trace_id),
    caseType: String(row.case_type),
    ingestionPurpose: String(row.ingestion_purpose),
    position: String(row.position),
    ingestionTime: iso(row.ingestion_time),
    reason: "ineligible_ingestion_purpose",
    contentDigest: String(row.content_digest),
    createdAt: iso(row.created_at)
  } as AnalysisPopulationExclusion;
}

export async function requireProjectRole(
  db: Pool | PoolClient,
  projectId: string,
  userId: string,
  required?: "owner"
): Promise<void> {
  const result = await db.query(
    `select role from project_members where project_id=$1 and user_id=$2`,
    [projectId, userId]
  );
  const role = result.rows[0]?.role ? String(result.rows[0].role) : null;
  if (!role || (required === "owner" && role !== "owner")) {
    throw repoError("analysis_population_forbidden", "Analysis population access is forbidden");
  }
}

export async function ensureGovernedSubject(client: PoolClient, projectId: string, userId: string): Promise<string> {
  const subjectId = stableId("grs", projectId, userId);
  await client.query(
    `insert into governed_reviewer_subjects (id,project_id,account_user_id,subject_digest)
     values ($1,$2,$3,governed_content_v1_digest(
       'governed-reviewer-subject/v1',jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
     ))
     on conflict (project_id,account_user_id) where account_user_id is not null do nothing`,
    [subjectId, projectId, userId]
  );
  const row = await client.query(
    `select id from governed_reviewer_subjects where project_id=$1 and account_user_id=$2`,
    [projectId, userId]
  );
  if (!row.rows[0]) throw repoError("analysis_population_forbidden", "A governed project subject is required");
  return String(row.rows[0].id);
}

export async function populationExists(db: Pool | PoolClient, projectId: string, populationId: string): Promise<boolean> {
  const result = await db.query(
    `select 1 from analysis_populations where project_id=$1 and id=$2`,
    [projectId, populationId]
  );
  return Boolean(result.rowCount);
}

function isEligiblePair(caseType: string, purpose: string): caseType is PreparedMember["caseType"] {
  return (
    (caseType === "manual" && purpose === "analysis_eligible_manual") ||
    (caseType === "langsmith" && purpose === "analysis_eligible_langsmith") ||
    (caseType === "langfuse" && purpose === "analysis_eligible_langfuse") ||
    (caseType === "ironside" && purpose === "analysis_eligible_ironside")
  );
}

function normalizedPayloadSnapshot(value: unknown): DatasetRevisionPayloadSnapshot {
  const parsed = parseJson(value) as Record<string, unknown> | null;
  if (!parsed || !("input" in parsed) || !("output" in parsed)) {
    throw new Error("Eligible case has no complete retained normalized payload");
  }
  return DatasetRevisionPayloadSnapshotSchema.parse({
    input: parsed.input,
    output: parsed.output,
    metadata: parsed.metadata ?? {},
    ...(Array.isArray(parsed.steps) ? { steps: parsed.steps } : {})
  });
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: value.position === undefined ? "chronological" : "position",
    ...value
  }), "utf8").toString("base64url");
}

export function decodeCursor(
  value: string | null,
  scope: string,
  expectedKind: "chronological" | "position"
): CursorValue {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.kind !== expectedKind) throw new Error("version or kind");
    if (expectedKind === "position") {
      if (
        typeof parsed.position !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(parsed.position) ||
        BigInt(parsed.position) > 9_223_372_036_854_775_807n
      ) throw new Error("position");
      return { position: parsed.position };
    }
    if (
      typeof parsed.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed.createdAt) ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 240 ||
      parsed.id.includes("\u0000")
    ) throw new Error("identity");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw repoError("analysis_population_invalid_cursor", `Invalid ${scope} cursor`);
  }
}

export function boundErrorCode(error: unknown):
  | "analysis_population_frame_empty"
  | "analysis_population_frame_too_large"
  | "analysis_population_budget_invalid" {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "analysis_population_frame_empty" || code === "analysis_population_frame_too_large") return code;
  return "analysis_population_budget_invalid";
}

export function repoError(
  code: ConstructorParameters<typeof AnalysisPopulationRepositoryError>[0],
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): AnalysisPopulationRepositoryError {
  return new AnalysisPopulationRepositoryError(code, message, details);
}

export function mapPgError(error: unknown): unknown {
  if (error instanceof AnalysisPopulationRepositoryError) return error;
  const pg = error as { code?: string; message?: string; constraint?: string };
  const message = pg?.message ?? (error instanceof Error ? error.message : String(error));
  if (pg?.code === "23505" && pg.constraint?.includes("idempotency")) {
    return repoError("analysis_population_idempotency_conflict", "Analysis population idempotency key conflict");
  }
  if (pg?.code === "40001") {
    return repoError("analysis_population_state_conflict", "Analysis population snapshot serialization conflict; retry the same idempotency key");
  }
  if (/claimed by sealed|sealed evidence|sealed overlap/i.test(message)) {
    return repoError("analysis_population_sealed_overlap", "Analysis population overlaps protected sealed evidence");
  }
  if (pg?.code === "23514" || pg?.code === "23503" || pg?.code === "55000") {
    return repoError("analysis_population_revision_conflict", message.slice(0, 2_000));
  }
  return error;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 32)}`;
}

export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
