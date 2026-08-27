import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
  ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
  ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
  ANALYSIS_POPULATION_ORDERING_VERSION,
  AnalysisPopulationCreateInputSchema,
  AnalysisPopulationCreateResultSchema,
  AnalysisPopulationDetailSchema,
  AnalysisPopulationExclusionsPageSchema,
  AnalysisPopulationMembersPageSchema,
  AnalysisPopulationOverlapsPageSchema,
  AnalysisPopulationSelectedItemsPageSchema,
  AnalysisPopulationSummariesPageSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisPopulation,
  type AnalysisPopulationCreateInput,
  type AnalysisPopulationCreateResult,
  type AnalysisPopulationDetail,
  type AnalysisPopulationDrawSelection,
  type AnalysisPopulationDrawSummary,
  type AnalysisPopulationExclusion,
  type AnalysisPopulationExclusionsPage,
  type AnalysisPopulationMember,
  type AnalysisPopulationMembersPage,
  type AnalysisPopulationOverlapsPage,
  type AnalysisPopulationSelectedItemsPage,
  type AnalysisPopulationSummariesPage,
  type DatasetRevisionPayloadSnapshot
} from "@coeval/shared";
import {
  analysisPopulationClaim,
  analysisPopulationContentDigest,
  analysisPopulationExclusionDigest,
  analysisPopulationFrameDigest,
  analysisPopulationFrameMemberDigest,
  analysisPopulationItemDigest,
  analysisPopulationMemberLineageDigest,
  analysisPopulationRequestDigest,
  assertAnalysisPopulationDrawBounds,
  assertAnalysisPopulationWindow,
  decideAnalysisPopulationFrameReuse,
  drawAnalysisPopulationSample,
  normalizeAnalysisPopulationTimestamp
} from "../lib/analysis-population.js";
import {
  datasetRevisionContentDigest,
  datasetRevisionDigest
} from "../lib/dataset-revision.js";
import type {
  AnalysisPopulationAccess,
  AnalysisPopulationActor,
  AnalysisPopulationPageInput,
  AnalysisPopulationRepository,
  AnalysisPopulationSelectedContent
} from "./repository.js";
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

export class PgAnalysisPopulationRepository implements AnalysisPopulationRepository {
  constructor(private readonly pool: Pool) {}

  async createPopulation(
    actor: AnalysisPopulationActor,
    rawInput: AnalysisPopulationCreateInput
  ): Promise<AnalysisPopulationCreateResult> {
    const input = AnalysisPopulationCreateInputSchema.parse(rawInput);
    if (actor.projectRole !== "owner") {
      throw repoError("analysis_population_forbidden", "Only project owners may freeze analysis populations");
    }
    const client = await this.pool.connect();
    let transactionOpen = false;
    let advisoryHeld = false;
    try {
      await client.query(
        `select pg_advisory_lock(hashtextextended(
           jsonb_build_array($1::text,'analysis-population-create/v1')::text, 0
         ))`,
        [actor.projectId]
      );
      advisoryHeld = true;
      await client.query("begin isolation level repeatable read");
      transactionOpen = true;
      await requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
      const requestDigest = analysisPopulationRequestDigest({
        projectId: actor.projectId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        fixedBudget: input.fixedBudget
      });

      const replay = await client.query(
        `select request.request_digest, request.population_id
         from analysis_population_requests request
         where request.project_id=$1 and request.idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== requestDigest) {
          throw repoError(
            "analysis_population_idempotency_conflict",
            "Analysis population idempotency key was reused with different input"
          );
        }
        const result = await loadCreateResult(client, actor.projectId, String(replay.rows[0].population_id), true);
        await client.query("commit");
        transactionOpen = false;
        return result;
      }

      const clock = (await client.query(
        `select transaction_timestamp() as snapshot_taken_at,
                pg_current_snapshot()::text as snapshot_xid8`
      )).rows[0]!;
      try {
        assertAnalysisPopulationWindow(input, iso(clock.snapshot_taken_at));
      } catch (error) {
        throw repoError(
          "analysis_population_window_too_recent",
          error instanceof Error ? error.message : "Analysis population window is too recent"
        );
      }

      const preflight = await scanWindowPreflight(client, actor.projectId, input.windowStart, input.windowEnd);
      if (preflight.identityUnresolved) {
        throw repoError(
          "analysis_population_identity_unresolved",
          "Analysis population window contains eligible evidence without an exact retained pre-redaction identity"
        );
      }
      if (preflight.sealedOverlap) {
        throw repoError(
          "analysis_population_sealed_overlap",
          "Analysis population window overlaps protected sealed evidence"
        );
      }
      try {
        assertAnalysisPopulationDrawBounds(preflight.eligibleCount, input.fixedBudget);
      } catch (error) {
        const code = boundErrorCode(error);
        const bound = error as { limit?: unknown; observed?: unknown };
        throw repoError(code, error instanceof Error ? error.message : "Invalid analysis population bounds", {
          limit: typeof bound.limit === "number" ? bound.limit : null,
          observed: typeof bound.observed === "number" ? bound.observed : null,
          fixedBudget: input.fixedBudget
        });
      }

      const populationId = `ap_${randomUUID()}`;
      const revisionId = `dsr_${randomUUID()}`;
      const prepared = await prepareEligibleMembers(
        client,
        actor.projectId,
        input.windowStart,
        input.windowEnd,
        revisionId
      );
      if (prepared.length !== preflight.eligibleCount) {
        throw repoError(
          "analysis_population_revision_conflict",
          "Analysis population frame changed inside its repeatable-read snapshot"
        );
      }
      const frameDigest = analysisPopulationFrameDigest({
        projectId: actor.projectId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        frameMemberDigests: prepared.map((member) => member.frameMemberDigest)
      });
      const contentDigest = analysisPopulationContentDigest(prepared.map((member) => member.itemDigest));
      const existingFrame = await client.query(
        `select population.id, draw.fixed_budget
         from analysis_populations population
         join analysis_population_draws draw on draw.population_id=population.id
         where population.project_id=$1 and population.frame_digest=$2
         for share of population,draw`,
        [actor.projectId, frameDigest]
      );
      if (existingFrame.rows[0]) {
        const decision = decideAnalysisPopulationFrameReuse(
          Number(existingFrame.rows[0].fixed_budget),
          input.fixedBudget
        );
        if (decision.kind === "conflict") {
          throw repoError(
            "analysis_population_draw_conflict",
            "An identical immutable frame already has a different fixed draw budget",
            {
              existingFixedBudget: decision.existingFixedBudget,
              requestedFixedBudget: decision.requestedFixedBudget
            }
          );
        }
        await insertRequestAlias(client, {
          projectId: actor.projectId,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          populationId: String(existingFrame.rows[0].id)
        });
        const result = await loadCreateResult(
          client,
          actor.projectId,
          String(existingFrame.rows[0].id),
          true
        );
        await client.query("commit");
        transactionOpen = false;
        return result;
      }

      await client.query(
        `insert into analysis_populations
           (id,project_id,dataset_revision_id,window_start,window_end,eligible_sources,
            eligible_ingestion_purposes,canonicalization_version,ordering_version,
            population_size,exclusion_count,frame_digest,content_digest,snapshot_xid8,
            snapshot_taken_at,created_by_user_id,created_by_subject_id,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 transaction_timestamp(),$15,$16,transaction_timestamp())`,
        [
          populationId,
          actor.projectId,
          revisionId,
          input.windowStart,
          input.windowEnd,
          [...ANALYSIS_POPULATION_ELIGIBLE_SOURCES],
          [...ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES],
          ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
          ANALYSIS_POPULATION_ORDERING_VERSION,
          prepared.length,
          preflight.exclusionCount.toString(),
          frameDigest,
          contentDigest,
          String(clock.snapshot_xid8),
          actor.userId,
          subjectId
        ]
      );

      const itemDigests = prepared.map((member) => member.itemDigest);
      const revisionContentDigest = datasetRevisionContentDigest(itemDigests);
      const revisionDigest = datasetRevisionDigest({ role: "analysis_authoring", itemDigests });
      await client.query(
        `insert into dataset_revisions
           (id,project_id,series_id,revision_number,source_dataset_id,parent_revision_id,
            role,source_kind,identity_basis,content_digest,revision_digest,item_count,
            provenance_level,created_by_user_id,idempotency_key,criterion_version_id,
            analysis_population_id,created_at)
         values ($1,$2,$3,1,null,null,'analysis_authoring','analysis_population',
                 'input-identity/v1',$4,$5,$6,'unverified',$7,null,null,$8,
                 transaction_timestamp())`,
        [
          revisionId,
          actor.projectId,
          `analysis-population:${populationId}`,
          revisionContentDigest,
          revisionDigest,
          prepared.length,
          actor.userId,
          populationId
        ]
      );

      await insertRevisionItems(
        client,
        actor.projectId,
        revisionId,
        input.windowStart,
        input.windowEnd,
        prepared
      );
      await insertMembers(client, actor.projectId, populationId, prepared);
      await insertExclusions(
        client,
        actor.projectId,
        populationId,
        input.windowStart,
        input.windowEnd,
        preflight.exclusionCount
      );

      const seed = randomBytes(32).toString("hex");
      const drawId = `apd_${randomUUID()}`;
      const sampled = drawAnalysisPopulationSample({
        populationId,
        datasetRevisionId: revisionId,
        frameDigest,
        seed,
        fixedBudget: input.fixedBudget,
        members: prepared.map((member) => ({
          memberId: member.id,
          revisionItemId: member.revisionItemId,
          caseId: member.caseId,
          frameMemberDigest: member.frameMemberDigest
        }))
      });
      await client.query(
        `insert into analysis_population_draws
           (id,project_id,population_id,dataset_revision_id,method,stopping_rule,
            draw_executor,seed,rng_version,algorithm_version,fixed_budget,population_size,
            inclusion_numerator,inclusion_denominator,draw_digest,content_digest,
            executed_by_subject_id,executed_at)
         values ($1,$2,$3,$4,'simple_random','fixed','coeval_server',$5,
                 'sha256-rank/v1','coeval-analysis-draw/v1',$6,$7,$6,$7,$8,$9,$10,
                 transaction_timestamp())`,
        [
          drawId,
          actor.projectId,
          populationId,
          revisionId,
          seed,
          input.fixedBudget,
          prepared.length,
          sampled.drawDigest,
          sampled.contentDigest,
          subjectId
        ]
      );
      await insertDrawItems(client, actor.projectId, populationId, drawId, sampled.selections);
      await insertRequestAlias(client, {
        projectId: actor.projectId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        populationId
      });
      await insertCreationExposure(client, {
        projectId: actor.projectId,
        userId: actor.userId,
        subjectId,
        populationId,
        revisionId
      });

      const result = await loadCreateResult(client, actor.projectId, populationId, false);
      await client.query("commit");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) await client.query("rollback").catch(() => undefined);
      throw mapPgError(error);
    } finally {
      if (advisoryHeld) {
        await client.query(
          `select pg_advisory_unlock(hashtextextended(
             jsonb_build_array($1::text,'analysis-population-create/v1')::text, 0
           ))`,
          [actor.projectId]
        ).catch(() => undefined);
      }
      client.release();
    }
  }

  async listPopulations(
    access: AnalysisPopulationAccess,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationSummariesPage> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    const cursor = decodeCursor(page.cursor, "population list", "chronological");
    const result = await this.pool.query(
      `${summarySelect()}
       where population.project_id=$1
         and ($2::timestamptz is null or (population.created_at,population.id) < ($2,$3))
       order by population.created_at desc,population.id desc
       limit $4`,
      [access.projectId, cursor.createdAt ?? null, cursor.id ?? null, page.limit + 1]
    );
    const items = result.rows.slice(0, page.limit).map(rowToSummary);
    const total = await this.pool.query(
      `select count(*)::text as total from analysis_populations where project_id=$1`,
      [access.projectId]
    );
    return AnalysisPopulationSummariesPageSchema.parse({
      items,
      totalCount: String(total.rows[0]?.total ?? "0"),
      nextCursor: result.rows.length > page.limit
        ? encodeCursor({ createdAt: String(result.rows[page.limit - 1]!.population_created_at_exact), id: String(result.rows[page.limit - 1]!.population_id) })
        : null
    });
  }

  async getPopulation(
    access: AnalysisPopulationAccess,
    populationId: string
  ): Promise<AnalysisPopulationDetail | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    const result = await this.pool.query(
      `${summarySelect()}
       where population.project_id=$1 and population.id=$2`,
      [access.projectId, populationId]
    );
    if (!result.rows[0]) return null;
    const overlaps = await this.pool.query(
      `select count(*)::text as total
       from (
         select other.population_id
         from analysis_population_members target
         join analysis_population_members other
           on other.project_id=target.project_id and other.case_id=target.case_id
          and other.population_id<>target.population_id
         where target.project_id=$1 and target.population_id=$2
         group by other.population_id
       ) overlap`,
      [access.projectId, populationId]
    );
    return AnalysisPopulationDetailSchema.parse({
      ...rowToSummary(result.rows[0]),
      overlapCount: String(overlaps.rows[0]?.total ?? "0")
    });
  }

  async listMembers(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationMembersPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    if (!await populationExists(this.pool, access.projectId, populationId)) return null;
    const cursor = decodeCursor(page.cursor, "population members", "position");
    const rows = await this.pool.query(
      `select * from analysis_population_members
       where project_id=$1 and population_id=$2
         and ($3::bigint is null or position>$3)
       order by position,id limit $4`,
      [access.projectId, populationId, cursor.position ?? null, page.limit + 1]
    );
    const count = await this.pool.query(
      `select population_size from analysis_populations where project_id=$1 and id=$2`,
      [access.projectId, populationId]
    );
    return AnalysisPopulationMembersPageSchema.parse({
      items: rows.rows.slice(0, page.limit).map(rowToMember),
      totalCount: Number(count.rows[0]!.population_size),
      nextCursor: rows.rows.length > page.limit
        ? encodeCursor({ position: String(rows.rows[page.limit - 1]!.position) })
        : null
    });
  }

  async listSelections(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationSelectedItemsPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    const cursor = decodeCursor(page.cursor, "population selections", "position");
    const draw = await this.pool.query(
      `select id,fixed_budget from analysis_population_draws where project_id=$1 and population_id=$2`,
      [access.projectId, populationId]
    );
    if (!draw.rows[0]) return null;
    const rows = await this.pool.query(
      `select * from analysis_population_draw_items
       where project_id=$1 and draw_id=$2 and ($3::integer is null or position>$3)
       order by position,id limit $4`,
      [access.projectId, draw.rows[0].id, cursor.position ?? null, page.limit + 1]
    );
    return AnalysisPopulationSelectedItemsPageSchema.parse({
      items: rows.rows.slice(0, page.limit).map(rowToSelection),
      totalCount: Number(draw.rows[0].fixed_budget),
      nextCursor: rows.rows.length > page.limit
        ? encodeCursor({ position: String(rows.rows[page.limit - 1]!.position) })
        : null
    });
  }

  async listExclusions(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationExclusionsPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    const population = await this.pool.query(
      `select exclusion_count from analysis_populations where project_id=$1 and id=$2`,
      [access.projectId, populationId]
    );
    if (!population.rows[0]) return null;
    const cursor = decodeCursor(page.cursor, "population exclusions", "position");
    const rows = await this.pool.query(
      `select * from analysis_population_exclusions
       where project_id=$1 and population_id=$2 and ($3::bigint is null or position>$3)
       order by position,id limit $4`,
      [access.projectId, populationId, cursor.position ?? null, page.limit + 1]
    );
    return AnalysisPopulationExclusionsPageSchema.parse({
      items: rows.rows.slice(0, page.limit).map(rowToExclusion),
      totalCount: String(population.rows[0].exclusion_count),
      nextCursor: rows.rows.length > page.limit
        ? encodeCursor({ position: String(rows.rows[page.limit - 1]!.position) })
        : null
    });
  }

  async listOverlaps(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationOverlapsPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    if (!await populationExists(this.pool, access.projectId, populationId)) return null;
    const cursor = decodeCursor(page.cursor, "population overlaps", "chronological");
    const base = `
      from analysis_population_members target
      join analysis_population_members shared
        on shared.project_id=target.project_id and shared.case_id=target.case_id
       and shared.population_id<>target.population_id
      join analysis_populations other on other.id=shared.population_id and other.project_id=shared.project_id
      join analysis_population_draws draw on draw.population_id=other.id
      where target.project_id=$1 and target.population_id=$2`;
    const rows = await this.pool.query(
      `select other.id as population_id,other.population_size,count(distinct target.case_id)::integer as overlap_count,
              other.frame_digest,draw.id as draw_id,draw.draw_digest,other.window_start,other.window_end,
              other.created_at as population_created_at,
              to_char(other.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                as population_created_at_exact
       ${base}
       group by other.id,draw.id
       having ($3::timestamptz is null or (other.created_at,other.id)<($3,$4))
       order by other.created_at desc,other.id desc limit $5`,
      [access.projectId, populationId, cursor.createdAt ?? null, cursor.id ?? null, page.limit + 1]
    );
    const total = await this.pool.query(
      `select count(*)::text as total from (select other.id ${base} group by other.id) overlap`,
      [access.projectId, populationId]
    );
    return AnalysisPopulationOverlapsPageSchema.parse({
      items: rows.rows.slice(0, page.limit).map((row) => ({
        populationId: String(row.population_id),
        populationSize: Number(row.population_size),
        overlapCount: Number(row.overlap_count),
        frameDigest: String(row.frame_digest),
        drawId: String(row.draw_id),
        drawDigest: String(row.draw_digest),
        windowStart: iso(row.window_start),
        windowEnd: iso(row.window_end),
        createdAt: iso(row.population_created_at)
      })),
      totalCount: String(total.rows[0]?.total ?? "0"),
      nextCursor: rows.rows.length > page.limit
        ? encodeCursor({ createdAt: String(rows.rows[page.limit - 1]!.population_created_at_exact), id: String(rows.rows[page.limit - 1]!.population_id) })
        : null
    });
  }

  async getSelectedContent(
    access: AnalysisPopulationAccess,
    populationId: string,
    drawPosition: number
  ): Promise<AnalysisPopulationSelectedContent | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await requireProjectRole(client, access.projectId, access.userId);
      const subjectId = await ensureGovernedSubject(client, access.projectId, access.userId);
      const result = await client.query(
        `select population.dataset_revision_id,draw_item.member_id,draw_item.revision_item_id,
                draw_item.case_id,draw_item.position,item.input_digest,item.item_digest,item.payload_snapshot
         from analysis_populations population
         join analysis_population_draws draw on draw.population_id=population.id
         join analysis_population_draw_items draw_item on draw_item.draw_id=draw.id
         join dataset_revision_items item
           on item.id=draw_item.revision_item_id
          and item.project_id=population.project_id
          and item.revision_id=population.dataset_revision_id
         where population.project_id=$1 and population.id=$2 and draw_item.position=$3
         for key share of population,draw,draw_item,item`,
        [access.projectId, populationId, drawPosition]
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return null;
      }
      const row = result.rows[0];
      await client.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,
            subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,
            reason,details,idempotency_key)
         values ($1,$2,$3,null,'human_access','development','content_view','person',$4,$5,
                 'analysis_population',$6,'Governed Analyze population content view',$7,$8)
         on conflict (project_id,idempotency_key) do nothing`,
        [
          `dse_${randomUUID()}`,
          access.projectId,
          row.dataset_revision_id,
          subjectId,
          access.userId,
          populationId,
          JSON.stringify({ contract: "coeval/analysis-population-content-view/v1", populationId }),
          `analysis-content-view:${row.dataset_revision_id}:${subjectId}`
        ]
      );
      const exposureKey = `analysis-content-view:${row.dataset_revision_id}:${subjectId}`;
      const exposure = await client.query(
        `select project_id,revision_id,revision_item_id,kind,exposure_class,activity,
                subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,idempotency_key
         from dataset_exposure_events where project_id=$1 and idempotency_key=$2`,
        [access.projectId, exposureKey]
      );
      const event = exposure.rows[0];
      if (
        !event || String(event.revision_id) !== String(row.dataset_revision_id) ||
        event.revision_item_id !== null || event.kind !== "human_access" ||
        event.exposure_class !== "development" || event.activity !== "content_view" ||
        event.subject_kind !== "person" || String(event.subject_id) !== subjectId ||
        String(event.actor_user_id) !== access.userId ||
        event.evidence_ref_kind !== "analysis_population" ||
        String(event.evidence_ref_id) !== populationId || String(event.idempotency_key) !== exposureKey
      ) {
        throw repoError(
          "analysis_population_revision_conflict",
          "Analysis population content exposure did not converge on the exact governed event"
        );
      }
      await client.query("commit");
      return {
        populationId,
        datasetRevisionId: String(row.dataset_revision_id),
        memberId: String(row.member_id),
        revisionItemId: String(row.revision_item_id),
        caseId: String(row.case_id),
        drawPosition: Number(row.position),
        inputDigest: String(row.input_digest),
        itemDigest: String(row.item_digest),
        payloadSnapshot: DatasetRevisionPayloadSnapshotSchema.parse(parseJson(row.payload_snapshot))
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }
}

async function scanWindowPreflight(
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

async function prepareEligibleMembers(
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

async function insertRevisionItems(
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

async function insertMembers(
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

async function insertExclusions(
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

async function insertDrawItems(
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

async function insertRequestAlias(
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

async function insertCreationExposure(
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

async function loadCreateResult(
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

function summarySelect(): string {
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

function rowToSummary(row: Record<string, unknown>) {
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

function rowToMember(row: Record<string, unknown>): AnalysisPopulationMember {
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

function rowToSelection(row: Record<string, unknown>): AnalysisPopulationDrawSelection {
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

function rowToExclusion(row: Record<string, unknown>): AnalysisPopulationExclusion {
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

async function requireProjectRole(
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

async function ensureGovernedSubject(client: PoolClient, projectId: string, userId: string): Promise<string> {
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

async function populationExists(db: Pool | PoolClient, projectId: string, populationId: string): Promise<boolean> {
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

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: value.position === undefined ? "chronological" : "position",
    ...value
  }), "utf8").toString("base64url");
}

function decodeCursor(
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

function boundErrorCode(error: unknown):
  | "analysis_population_frame_empty"
  | "analysis_population_frame_too_large"
  | "analysis_population_budget_invalid" {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "analysis_population_frame_empty" || code === "analysis_population_frame_too_large") return code;
  return "analysis_population_budget_invalid";
}

function repoError(
  code: ConstructorParameters<typeof AnalysisPopulationRepositoryError>[0],
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): AnalysisPopulationRepositoryError {
  return new AnalysisPopulationRepositoryError(code, message, details);
}

function mapPgError(error: unknown): unknown {
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

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
