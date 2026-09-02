import {
  ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
  ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
  ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
  ANALYSIS_POPULATION_ORDERING_VERSION,
  AnalysisPopulationCreateInputSchema,
  AnalysisPopulationDetailSchema,
  AnalysisPopulationExclusionsPageSchema,
  AnalysisPopulationMembersPageSchema,
  AnalysisPopulationOverlapsPageSchema,
  AnalysisPopulationSelectedItemsPageSchema,
  AnalysisPopulationSummariesPageSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisPopulationCreateInput,
  type AnalysisPopulationCreateResult,
  type AnalysisPopulationDetail,
  type AnalysisPopulationExclusionsPage,
  type AnalysisPopulationMembersPage,
  type AnalysisPopulationOverlapsPage,
  type AnalysisPopulationSelectedItemsPage,
  type AnalysisPopulationSummariesPage
} from "@coeval/shared";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  analysisPopulationContentDigest,
  analysisPopulationFrameDigest,
  analysisPopulationRequestDigest,
  assertAnalysisPopulationDrawBounds,
  assertAnalysisPopulationWindow,
  decideAnalysisPopulationFrameReuse,
  drawAnalysisPopulationSample
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
import * as populationSupport from "./repository.pg-support.js";

export class PgAnalysisPopulationRepository implements AnalysisPopulationRepository {
  constructor(private readonly pool: Pool) {}

  async createPopulation(
    actor: AnalysisPopulationActor,
    rawInput: AnalysisPopulationCreateInput
  ): Promise<AnalysisPopulationCreateResult> {
    const input = AnalysisPopulationCreateInputSchema.parse(rawInput);
    if (actor.projectRole !== "owner") {
      throw populationSupport.repoError("analysis_population_forbidden", "Only project owners may freeze analysis populations");
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
      await populationSupport.requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await populationSupport.ensureGovernedSubject(client, actor.projectId, actor.userId);
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
          throw populationSupport.repoError(
            "analysis_population_idempotency_conflict",
            "Analysis population idempotency key was reused with different input"
          );
        }
        const result = await populationSupport.loadCreateResult(client, actor.projectId, String(replay.rows[0].population_id), true);
        await client.query("commit");
        transactionOpen = false;
        return result;
      }

      const clock = (await client.query(
        `select transaction_timestamp() as snapshot_taken_at,
                pg_current_snapshot()::text as snapshot_xid8`
      )).rows[0]!;
      try {
        assertAnalysisPopulationWindow(input, populationSupport.iso(clock.snapshot_taken_at));
      } catch (error) {
        throw populationSupport.repoError(
          "analysis_population_window_too_recent",
          error instanceof Error ? error.message : "Analysis population window is too recent"
        );
      }

      const preflight = await populationSupport.scanWindowPreflight(client, actor.projectId, input.windowStart, input.windowEnd);
      if (preflight.identityUnresolved) {
        throw populationSupport.repoError(
          "analysis_population_identity_unresolved",
          "Analysis population window contains eligible evidence without an exact retained pre-redaction identity"
        );
      }
      if (preflight.sealedOverlap) {
        throw populationSupport.repoError(
          "analysis_population_sealed_overlap",
          "Analysis population window overlaps protected sealed evidence"
        );
      }
      try {
        assertAnalysisPopulationDrawBounds(preflight.eligibleCount, input.fixedBudget);
      } catch (error) {
        const code = populationSupport.boundErrorCode(error);
        const bound = error as { limit?: unknown; observed?: unknown };
        throw populationSupport.repoError(code, error instanceof Error ? error.message : "Invalid analysis population bounds", {
          limit: typeof bound.limit === "number" ? bound.limit : null,
          observed: typeof bound.observed === "number" ? bound.observed : null,
          fixedBudget: input.fixedBudget
        });
      }

      const populationId = `ap_${randomUUID()}`;
      const revisionId = `dsr_${randomUUID()}`;
      const prepared = await populationSupport.prepareEligibleMembers(
        client,
        actor.projectId,
        input.windowStart,
        input.windowEnd,
        revisionId
      );
      if (prepared.length !== preflight.eligibleCount) {
        throw populationSupport.repoError(
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
          throw populationSupport.repoError(
            "analysis_population_draw_conflict",
            "An identical immutable frame already has a different fixed draw budget",
            {
              existingFixedBudget: decision.existingFixedBudget,
              requestedFixedBudget: decision.requestedFixedBudget
            }
          );
        }
        await populationSupport.insertRequestAlias(client, {
          projectId: actor.projectId,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          populationId: String(existingFrame.rows[0].id)
        });
        const result = await populationSupport.loadCreateResult(
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

      await populationSupport.insertRevisionItems(
        client,
        actor.projectId,
        revisionId,
        input.windowStart,
        input.windowEnd,
        prepared
      );
      await populationSupport.insertMembers(client, actor.projectId, populationId, prepared);
      await populationSupport.insertExclusions(
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
      await populationSupport.insertDrawItems(client, actor.projectId, populationId, drawId, sampled.selections);
      await populationSupport.insertRequestAlias(client, {
        projectId: actor.projectId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        populationId
      });
      await populationSupport.insertCreationExposure(client, {
        projectId: actor.projectId,
        userId: actor.userId,
        subjectId,
        populationId,
        revisionId
      });

      const result = await populationSupport.loadCreateResult(client, actor.projectId, populationId, false);
      await client.query("commit");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) await client.query("rollback").catch(() => undefined);
      throw populationSupport.mapPgError(error);
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
    await populationSupport.requireProjectRole(this.pool, access.projectId, access.userId);
    const cursor = populationSupport.decodeCursor(page.cursor, "population list", "chronological");
    const result = await this.pool.query(
      `${populationSupport.summarySelect()}
       where population.project_id=$1
         and ($2::timestamptz is null or (population.created_at,population.id) < ($2,$3))
       order by population.created_at desc,population.id desc
       limit $4`,
      [access.projectId, cursor.createdAt ?? null, cursor.id ?? null, page.limit + 1]
    );
    const items = result.rows.slice(0, page.limit).map(populationSupport.rowToSummary);
    const total = await this.pool.query(
      `select count(*)::text as total from analysis_populations where project_id=$1`,
      [access.projectId]
    );
    return AnalysisPopulationSummariesPageSchema.parse({
      items,
      totalCount: String(total.rows[0]?.total ?? "0"),
      nextCursor: result.rows.length > page.limit
        ? populationSupport.encodeCursor({ createdAt: String(result.rows[page.limit - 1]!.population_created_at_exact), id: String(result.rows[page.limit - 1]!.population_id) })
        : null
    });
  }

  async getPopulation(
    access: AnalysisPopulationAccess,
    populationId: string
  ): Promise<AnalysisPopulationDetail | null> {
    await populationSupport.requireProjectRole(this.pool, access.projectId, access.userId);
    const result = await this.pool.query(
      `${populationSupport.summarySelect()}
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
      ...populationSupport.rowToSummary(result.rows[0]),
      overlapCount: String(overlaps.rows[0]?.total ?? "0")
    });
  }

  async listMembers(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationMembersPage | null> {
    await populationSupport.requireProjectRole(this.pool, access.projectId, access.userId);
    if (!await populationSupport.populationExists(this.pool, access.projectId, populationId)) return null;
    const cursor = populationSupport.decodeCursor(page.cursor, "population members", "position");
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
      items: rows.rows.slice(0, page.limit).map(populationSupport.rowToMember),
      totalCount: Number(count.rows[0]!.population_size),
      nextCursor: rows.rows.length > page.limit
        ? populationSupport.encodeCursor({ position: String(rows.rows[page.limit - 1]!.position) })
        : null
    });
  }

  async listSelections(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationSelectedItemsPage | null> {
    await populationSupport.requireProjectRole(this.pool, access.projectId, access.userId);
    const cursor = populationSupport.decodeCursor(page.cursor, "population selections", "position");
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
      items: rows.rows.slice(0, page.limit).map(populationSupport.rowToSelection),
      totalCount: Number(draw.rows[0].fixed_budget),
      nextCursor: rows.rows.length > page.limit
        ? populationSupport.encodeCursor({ position: String(rows.rows[page.limit - 1]!.position) })
        : null
    });
  }

  async listExclusions(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationExclusionsPage | null> {
    await populationSupport.requireProjectRole(this.pool, access.projectId, access.userId);
    const population = await this.pool.query(
      `select exclusion_count from analysis_populations where project_id=$1 and id=$2`,
      [access.projectId, populationId]
    );
    if (!population.rows[0]) return null;
    const cursor = populationSupport.decodeCursor(page.cursor, "population exclusions", "position");
    const rows = await this.pool.query(
      `select * from analysis_population_exclusions
       where project_id=$1 and population_id=$2 and ($3::bigint is null or position>$3)
       order by position,id limit $4`,
      [access.projectId, populationId, cursor.position ?? null, page.limit + 1]
    );
    return AnalysisPopulationExclusionsPageSchema.parse({
      items: rows.rows.slice(0, page.limit).map(populationSupport.rowToExclusion),
      totalCount: String(population.rows[0].exclusion_count),
      nextCursor: rows.rows.length > page.limit
        ? populationSupport.encodeCursor({ position: String(rows.rows[page.limit - 1]!.position) })
        : null
    });
  }

  async listOverlaps(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationOverlapsPage | null> {
    await populationSupport.requireProjectRole(this.pool, access.projectId, access.userId);
    if (!await populationSupport.populationExists(this.pool, access.projectId, populationId)) return null;
    const cursor = populationSupport.decodeCursor(page.cursor, "population overlaps", "chronological");
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
        windowStart: populationSupport.iso(row.window_start),
        windowEnd: populationSupport.iso(row.window_end),
        createdAt: populationSupport.iso(row.population_created_at)
      })),
      totalCount: String(total.rows[0]?.total ?? "0"),
      nextCursor: rows.rows.length > page.limit
        ? populationSupport.encodeCursor({ createdAt: String(rows.rows[page.limit - 1]!.population_created_at_exact), id: String(rows.rows[page.limit - 1]!.population_id) })
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
      await populationSupport.requireProjectRole(client, access.projectId, access.userId);
      const subjectId = await populationSupport.ensureGovernedSubject(client, access.projectId, access.userId);
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
        throw populationSupport.repoError(
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
        payloadSnapshot: DatasetRevisionPayloadSnapshotSchema.parse(populationSupport.parseJson(row.payload_snapshot))
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw populationSupport.mapPgError(error);
    } finally {
      client.release();
    }
  }
}
