import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ANALYSIS_MAX_EVENT_VERSION,
  ANALYSIS_MAX_TAXONOMY_REVISIONS,
  ANALYSIS_POPULATION_MAX_FIXED_BUDGET,
  ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
  ANALYSIS_STUDY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_COVERAGE_VERSION,
  AnalysisFailureTaxonomyCreateInputSchema,
  AnalysisObservationAssignmentEventInputSchema,
  AnalysisObservationAssignmentEventResultSchema,
  AnalysisObservationAssignmentsPageSchema,
  AnalysisStudyAbandonInputSchema,
  AnalysisStudyCloseInputSchema,
  AnalysisStudyCompleteInputSchema,
  AnalysisStudyCreateInputSchema,
  AnalysisStudyCreateResultSchema,
  AnalysisStudyDetailSchema,
  AnalysisStudyEventResultSchema,
  AnalysisStudyItemEventArtifactSchema,
  AnalysisStudyItemEventInputSchema,
  AnalysisStudyItemEventResultSchema,
  AnalysisStudyItemEventsPageSchema,
  AnalysisStudyItemProjectionSchema,
  AnalysisStudyItemsPageSchema,
  AnalysisStudyOpenInputSchema,
  AnalysisStudyProjectionSchema,
  AnalysisStudySummariesPageSchema,
  AnalysisTaxonomyCoverageSchema,
  AnalysisTaxonomyDetailSchema,
  AnalysisTaxonomyRevisionCreateInputSchema,
  AnalysisTaxonomyRevisionProjectionSchema,
  AnalysisTaxonomyRevisionResultSchema,
  AnalysisTaxonomyRevisionsPageSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisFailureTaxonomyArtifact,
  type AnalysisFailureTaxonomyCreateInput,
  type AnalysisObservationAssignmentEventArtifact,
  type AnalysisObservationAssignmentEventInput,
  type AnalysisObservationAssignmentEventResult,
  type AnalysisObservationAssignmentsPage,
  type AnalysisStudyAbandonInput,
  type AnalysisStudyCloseInput,
  type AnalysisStudyClosureArtifact,
  type AnalysisStudyCompleteInput,
  type AnalysisStudyCreateInput,
  type AnalysisStudyCreateResult,
  type AnalysisStudyDetail,
  type AnalysisStudyEventArtifact,
  type AnalysisStudyEventResult,
  type AnalysisStudyItemEventArtifact,
  type AnalysisStudyItemEventInput,
  type AnalysisStudyItemEventResult,
  type AnalysisStudyItemEventsPage,
  type AnalysisStudyItemProjection,
  type AnalysisStudyItemsPage,
  type AnalysisStudyOpenInput,
  type AnalysisStudyProjection,
  type AnalysisStudyStoppingRule,
  type AnalysisStudySummariesPage,
  type AnalysisStudySummary,
  type AnalysisTaxonomyCoverage,
  type AnalysisTaxonomyDetail,
  type AnalysisTaxonomyRevisionArtifact,
  type AnalysisTaxonomyRevisionCodeArtifact,
  type AnalysisTaxonomyRevisionCreateInput,
  type AnalysisTaxonomyRevisionProjection,
  type AnalysisTaxonomyRevisionResult,
  type AnalysisTaxonomyRevisionsPage
} from "@coeval/shared";
import {
  analysisAssignmentRequestDigest,
  analysisFailureCodeContentDigest,
  analysisFailureTaxonomyContentDigest,
  analysisFailureTaxonomyRequestDigest,
  analysisStudyContentDigest,
  analysisStudyClosureContentDigest,
  analysisStudyClosureItemContentDigest,
  analysisStudyEventRequestDigest,
  analysisStudyItemContentDigest,
  analysisStudyItemEventRequestDigest,
  analysisStudyItemViewRequestDigest,
  analysisStudyRequestDigest,
  analysisStudyViewSetDigest,
  analysisTaxonomyContentDigest,
  analysisTaxonomyRevisionCodeEntryDigest,
  analysisTaxonomyRevisionDigest,
  analysisTaxonomyRevisionRequestDigest,
  assertAnalysisTaxonomyRevision
} from "../lib/analysis-study.js";
import type {
  AnalysisStudyAccess,
  AnalysisStudyActor,
  AnalysisStudyItemContent,
  AnalysisStudyItemContext,
  AnalysisStudyPageInput,
  AnalysisStudyRepository
} from "./repository.js";
import { AnalysisStudyRepositoryError } from "./repository.js";

interface CursorValue {
  kind: "chronological" | "position" | "version" | "sequence";
  primary: string;
  id?: string;
}

export class PgAnalysisStudyRepository implements AnalysisStudyRepository {
  constructor(private readonly pool: Pool) {}

  async createStudy(
    actor: AnalysisStudyActor,
    rawInput: AnalysisStudyCreateInput
  ): Promise<AnalysisStudyCreateResult> {
    const input = AnalysisStudyCreateInputSchema.parse(rawInput);
    requireOwnerActor(actor);
    return this.transaction(async (client) => {
      await requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
      const requestDigest = analysisStudyRequestDigest(actor.projectId, input.populationId);
      const replay = await client.query(
        `select id,request_digest from analysis_studies
         where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== requestDigest) {
          throw repoError("analysis_study_idempotency_conflict", "Study idempotency key was reused with different input");
        }
        return AnalysisStudyCreateResultSchema.parse({
          study: await requireStudyProjection(client, actor.projectId, String(replay.rows[0].id)),
          reused: true
        });
      }

      await client.query(
        `select pg_advisory_xact_lock(hashtextextended(
           jsonb_build_array('analysis-study-create/v1',$1::text)::text,0
         ))`,
        [actor.projectId]
      );
      const lockedReplay = await client.query(
        `select id,request_digest from analysis_studies where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (lockedReplay.rows[0]) {
        if (String(lockedReplay.rows[0].request_digest) !== requestDigest) {
          throw repoError("analysis_study_idempotency_conflict", "Study idempotency key was reused with different input");
        }
        return AnalysisStudyCreateResultSchema.parse({
          study: await requireStudyProjection(client, actor.projectId, String(lockedReplay.rows[0].id)), reused: true
        });
      }
      const frame = await client.query(
        `select population.id as population_id,population.project_id,population.dataset_revision_id,
                draw.id as draw_id
         from analysis_populations population
         join analysis_population_draws draw
           on draw.population_id=population.id and draw.project_id=population.project_id
         where population.project_id=$1 and population.id=$2
         for key share of population,draw`,
        [actor.projectId, input.populationId]
      );
      if (!frame.rows[0]) throw repoError("analysis_study_not_found", "Analysis population not found");
      const existing = await client.query(
        `select id from analysis_studies where project_id=$1 and draw_id=$2`,
        [actor.projectId, frame.rows[0].draw_id]
      );
      if (existing.rows[0]) {
        throw repoError("analysis_study_draw_conflict", "The selected draw already has its permanent analysis study", {
          studyId: String(existing.rows[0].id)
        });
      }

      const studyId = `as_${randomUUID()}`;
      const studyBasis = {
        projectId: actor.projectId,
        populationId: String(frame.rows[0].population_id),
        drawId: String(frame.rows[0].draw_id),
        datasetRevisionId: String(frame.rows[0].dataset_revision_id),
        contractVersion: ANALYSIS_STUDY_CONTRACT_VERSION
      } as const;
      await client.query(
        `insert into analysis_studies
           (id,project_id,population_id,draw_id,dataset_revision_id,contract_version,
            idempotency_key,request_digest,content_digest,created_by_user_id,
            created_by_subject_id,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,transaction_timestamp())`,
        [studyId, actor.projectId, studyBasis.populationId, studyBasis.drawId,
          studyBasis.datasetRevisionId, studyBasis.contractVersion, input.idempotencyKey,
          requestDigest, analysisStudyContentDigest(studyBasis), actor.userId, subjectId]
      );
      const drawItems = await client.query(
        `select id,member_id,revision_item_id,case_id,position
         from analysis_population_draw_items
         where project_id=$1 and draw_id=$2 order by position`,
        [actor.projectId, studyBasis.drawId]
      );
      for (const row of drawItems.rows) {
        const item = {
          studyId,
          drawItemId: String(row.id),
          memberId: String(row.member_id),
          revisionItemId: String(row.revision_item_id),
          caseId: String(row.case_id),
          position: Number(row.position)
        };
        await client.query(
          `insert into analysis_study_items
             (id,project_id,study_id,draw_item_id,member_id,revision_item_id,case_id,
              position,content_digest,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,transaction_timestamp())`,
          [`asi_${randomUUID()}`, actor.projectId, studyId, item.drawItemId, item.memberId,
            item.revisionItemId, item.caseId, item.position, analysisStudyItemContentDigest(item)]
        );
      }
      return AnalysisStudyCreateResultSchema.parse({
        study: await requireStudyProjection(client, actor.projectId, studyId),
        reused: false
      });
    });
  }

  async listStudies(access: AnalysisStudyAccess, page: AnalysisStudyPageInput): Promise<AnalysisStudySummariesPage> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    const cursor = decodeCursor(page.cursor, "study list", "chronological");
    const candidates = await this.pool.query(
      `select study.id,
              to_char(study.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                as created_at_exact,
              (retry.study_id is not null and retry.next_retry_at>clock_timestamp())
                as retry_deferred
       from analysis_studies study
       left join analysis_study_deadline_retry_state retry
         on retry.study_id=study.id and retry.project_id=study.project_id
       where study.project_id=$1
         and ($2::timestamptz is null or (study.created_at,study.id)<($2::timestamptz,$3::text))
       order by study.created_at desc,study.id desc limit $4`,
      [access.projectId, cursor?.primary ?? null, cursor?.id ?? null, page.limit + 1]
    );
    const rawWindow = candidates.rows.slice(0, page.limit);
    const available: Array<{ id: string; createdAtExact: string }> = [];
    let unavailableDueClosureCount = 0;
    for (const row of rawWindow) {
      if (row.retry_deferred === true) {
        unavailableDueClosureCount += 1;
        continue;
      }
      try {
        await this.ensureDueClosure(access.projectId, String(row.id));
        available.push({ id: String(row.id), createdAtExact: String(row.created_at_exact) });
      } catch {
        // The failed study is durably backed off by ensureDueClosure. Omit it
        // fail-closed while retaining healthy metadata from the same page.
        unavailableDueClosureCount += 1;
      }
    }
    const result = available.length === 0 ? { rows: [] } : await this.pool.query(
      `${studySummarySelect()}
       where study.project_id=$1 and study.id=any($2::text[])
       order by study.created_at desc,study.id desc`,
      [access.projectId, available.map((value) => value.id)]
    );
    const total = await this.pool.query(`select count(*)::text total from analysis_studies where project_id=$1`, [access.projectId]);
    const rows = result.rows;
    const cursorSource = candidates.rows.length > page.limit
      ? rawWindow.at(-1)
      : null;
    return AnalysisStudySummariesPageSchema.parse({
      items: rows.map(rowToStudySummary),
      totalCount: String(total.rows[0]?.total ?? "0"),
      unavailableDueClosureCount,
      nextCursor: cursorSource
        ? encodeCursor({ kind: "chronological", primary: String(cursorSource.created_at_exact), id: String(cursorSource.id) })
        : null
    });
  }

  async getStudy(access: AnalysisStudyAccess, studyId: string): Promise<AnalysisStudyDetail | null> {
    const outcome = await this.transaction(async (client) => {
      await requireProjectRole(client, access.projectId, access.userId);
      await closeIfDue(client, studyId, access.projectId);
      const summaryRow = await client.query(`${studySummarySelect()} where study.project_id=$1 and study.id=$2`, [access.projectId, studyId]);
      if (!summaryRow.rows[0]) return null;
      const summary = rowToStudySummary(summaryRow.rows[0]);
      const taxonomy = await client.query(
        `select revision.id from analysis_failure_taxonomies taxonomy
         join lateral (select id from analysis_failure_taxonomy_revisions
           where taxonomy_id=taxonomy.id order by sequence desc limit 1) revision on true
         where taxonomy.project_id=$1`,
        [access.projectId]
      );
      const coverage = taxonomy.rows[0]
        ? await loadCoverage(client, access.projectId, studyId, String(taxonomy.rows[0].id))
        : null;
      return AnalysisStudyDetailSchema.parse({ summary, taxonomyCoverage: coverage });
    });
    return outcome;
  }

  async openStudy(actor: AnalysisStudyActor, studyId: string, rawInput: AnalysisStudyOpenInput): Promise<AnalysisStudyEventResult> {
    const input = AnalysisStudyOpenInputSchema.parse(rawInput);
    return this.appendStudyEvent(actor, studyId, input.idempotencyKey,
      analysisStudyEventRequestDigest({ studyId, expectedVersion: input.expectedVersion,
        eventType: "coding_opened", stoppingRule: input.stoppingRule }),
      (head) => ({ eventType: "coding_opened" as const, fromState: "draft" as const,
        toState: "coding_open" as const, stoppingRule: input.stoppingRule,
        closeCause: null, closureId: null, closureDigest: null, expectedClosureDigest: null,
        reason: null, expectedVersion: input.expectedVersion, head }));
  }

  async completeStudy(actor: AnalysisStudyActor, studyId: string, rawInput: AnalysisStudyCompleteInput): Promise<AnalysisStudyEventResult> {
    const input = AnalysisStudyCompleteInputSchema.parse(rawInput);
    return this.appendStudyEvent(actor, studyId, input.idempotencyKey,
      analysisStudyEventRequestDigest({ studyId, expectedVersion: input.expectedVersion,
        eventType: "study_completed", expectedClosureDigest: input.expectedClosureDigest }),
      (head) => ({ eventType: "study_completed" as const, fromState: "coding_closed" as const,
        toState: "completed" as const, stoppingRule: null, closeCause: null, closureId: null,
        closureDigest: null, expectedClosureDigest: input.expectedClosureDigest, reason: null,
        expectedVersion: input.expectedVersion, head }));
  }

  async abandonStudy(actor: AnalysisStudyActor, studyId: string, rawInput: AnalysisStudyAbandonInput): Promise<AnalysisStudyEventResult> {
    const input = AnalysisStudyAbandonInputSchema.parse(rawInput);
    return this.appendStudyEvent(actor, studyId, input.idempotencyKey,
      analysisStudyEventRequestDigest({ studyId, expectedVersion: input.expectedVersion,
        eventType: "study_abandoned", reason: input.reason }),
      (head) => ({ eventType: "study_abandoned" as const,
        fromState: (head.state === "coding_open" ? "coding_open" : "draft") as "draft" | "coding_open",
        toState: "abandoned" as const, stoppingRule: null, closeCause: null, closureId: null,
        closureDigest: null, expectedClosureDigest: null, reason: input.reason,
        expectedVersion: input.expectedVersion, head }));
  }

  async closeStudy(actor: AnalysisStudyActor, studyId: string, rawInput: AnalysisStudyCloseInput): Promise<AnalysisStudyEventResult> {
    const input = AnalysisStudyCloseInputSchema.parse(rawInput);
    requireOwnerActor(actor);
    let outcome: AnalysisStudyEventResult | null;
    try {
      outcome = await this.transaction(async (client) => {
        await requireProjectRole(client, actor.projectId, actor.userId, "owner");
        const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
        const requestDigest = analysisStudyEventRequestDigest({ studyId, expectedVersion: input.expectedVersion,
          eventType: "coding_closed", reason: input.reason });
        const replay = await findStudyEventReplay(client, actor.projectId, studyId, input.idempotencyKey, requestDigest);
        if (replay) return studyEventResult(client, actor.projectId, studyId, replay, true);
        if (!(await lockOwnedStudy(client, actor.projectId, studyId))) {
          throw repoError("analysis_study_not_found", "Analysis study not found");
        }
        const lockedReplay = await findStudyEventReplay(
          client, actor.projectId, studyId, input.idempotencyKey, requestDigest
        );
        if (lockedReplay) return studyEventResult(client, actor.projectId, studyId, lockedReplay, true);
        if (await closeIfDue(client, studyId, actor.projectId)) return null;
        const head = await requireStudyProjection(client, actor.projectId, studyId);
        if (head.currentVersion !== input.expectedVersion || head.state !== "coding_open" || head.stoppingRule?.kind !== "explicit_owner_close") {
          throw repoError("analysis_study_state_conflict", "Study is not at the requested explicit-close head");
        }
        return materializeClosure(client, {
          projectId: actor.projectId, studyId, idempotencyKey: input.idempotencyKey,
          requestDigest, closeCause: "explicit_owner_close", closeActorUserId: actor.userId,
          closeActorSubjectId: subjectId, closeReason: input.reason, expectedVersion: input.expectedVersion
        });
      });
    } catch (error) {
      await this.ensureDueClosure(actor.projectId, studyId).catch(() => undefined);
      throw error;
    }
    if (outcome === null) throw repoError("analysis_study_state_conflict", "Frozen server deadline closed the study before owner close");
    return outcome;
  }

  async listStudyItems(access: AnalysisStudyAccess, studyId: string, page: AnalysisStudyPageInput): Promise<AnalysisStudyItemsPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    await this.ensureDueClosure(access.projectId, studyId);
    if (!(await studyExists(this.pool, access.projectId, studyId))) return null;
    const cursor = decodeCursor(page.cursor, "study item list", "position");
    const result = await this.pool.query(
      `${studyItemSelect()}
       where item.project_id=$1 and item.study_id=$2 and ($3::integer is null or item.position>$3)
       order by item.position limit $4`,
      [access.projectId, studyId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::integer total from analysis_study_items where project_id=$1 and study_id=$2`, [access.projectId, studyId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisStudyItemsPageSchema.parse({ items: rows.map(rowToStudyItemProjection),
      totalCount: Number(total.rows[0]?.total ?? 0), nextCursor: result.rows.length > page.limit
        ? encodeCursor({ kind: "position", primary: String(rows.at(-1)!.position) }) : null });
  }

  async listStudyItemEvents(access: AnalysisStudyAccess, studyId: string, studyItemId: string, page: AnalysisStudyPageInput): Promise<AnalysisStudyItemEventsPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    await this.ensureDueClosure(access.projectId, studyId);
    if (!(await itemExists(this.pool, access.projectId, studyId, studyItemId))) return null;
    const cursor = decodeCursor(page.cursor, "study item event list", "version");
    const result = await this.pool.query(
      `select * from analysis_study_item_events
       where project_id=$1 and study_id=$2 and study_item_id=$3
         and ($4::bigint is null or version<$4)
       order by version desc limit $5`,
      [access.projectId, studyId, studyItemId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::text total from analysis_study_item_events where project_id=$1 and study_id=$2 and study_item_id=$3`, [access.projectId, studyId, studyItemId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisStudyItemEventsPageSchema.parse({ items: rows.map(rowToStudyItemEvent),
      totalCount: String(total.rows[0]?.total ?? "0"), nextCursor: result.rows.length > page.limit
        ? encodeCursor({ kind: "version", primary: String(rows.at(-1)!.version) }) : null });
  }

  async getStudyItem(access: AnalysisStudyAccess, studyId: string, studyItemId: string): Promise<AnalysisStudyItemContext | null> {
    const outcome = await this.transaction(async (client) => {
      await requireProjectRole(client, access.projectId, access.userId);
      await closeIfDue(client, studyId, access.projectId);
      const study = await loadStudyProjection(client, access.projectId, studyId);
      if (!study) return null;
      const item = await loadStudyItemProjection(client, access.projectId, studyId, studyItemId);
      return item ? { study, item } : null;
    });
    return outcome;
  }

  async appendStudyItemEvent(
    actor: AnalysisStudyActor,
    studyId: string,
    studyItemId: string,
    rawInput: AnalysisStudyItemEventInput
  ): Promise<AnalysisStudyItemEventResult> {
    const input = AnalysisStudyItemEventInputSchema.parse(rawInput);
    const requestDigest = analysisStudyItemEventRequestDigest(actor.projectId, studyId, studyItemId, input);
    const replay = await this.transaction(async (client) => {
      await requireProjectRole(client, actor.projectId, actor.userId);
      const event = await findItemEventReplay(client, actor.projectId, studyId, studyItemId,
        input.idempotencyKey, requestDigest);
      return event ? itemEventResult(client, actor.projectId, studyId, studyItemId, event, true) : null;
    });
    if (replay) return replay;
    await this.ensureDueClosure(actor.projectId, studyId);
    let outcome: AnalysisStudyItemEventResult | null;
    try {
      outcome = await this.transaction(async (client) => {
        await requireProjectRole(client, actor.projectId, actor.userId);
      const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
      const repeated = await findItemEventReplay(client, actor.projectId, studyId, studyItemId,
        input.idempotencyKey, requestDigest);
      if (repeated) return itemEventResult(client, actor.projectId, studyId, studyItemId, repeated, true);
      if (!(await lockOwnedStudy(client, actor.projectId, studyId))) {
        throw repoError("analysis_study_not_found", "Analysis study not found");
      }
      const lockedReplay = await findItemEventReplay(client, actor.projectId, studyId, studyItemId,
        input.idempotencyKey, requestDigest);
      if (lockedReplay) return itemEventResult(client, actor.projectId, studyId, studyItemId, lockedReplay, true);
      if (await closeIfDue(client, studyId, actor.projectId)) return null;
      const study = await requireStudyProjection(client, actor.projectId, studyId);
      const item = await loadStudyItemProjection(client, actor.projectId, studyId, studyItemId);
      if (!item) throw repoError("analysis_study_not_found", "Analysis study item not found");
      if (study.state !== "coding_open") throw repoError("analysis_study_state_conflict", "Study coding is not open");
      if (item.currentVersion !== input.expectedVersion) {
        throw repoError("analysis_study_version_conflict", "Study item compare-and-swap version does not match");
      }
      const eventId = `asie_${randomUUID()}`;
      const eventValues = itemEventColumns(input);
      let inserted;
      try {
        inserted = await client.query(
          `insert into analysis_study_item_events
             (id,project_id,study_id,study_item_id,version,predecessor_event_id,
              predecessor_event_digest,event_type,target_event_id,target_event_digest,
              failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
              actor_user_id,actor_role,idempotency_key,request_digest,event_digest,occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,transaction_timestamp())
           returning *`,
          [eventId, actor.projectId, studyId, studyItemId,
            (BigInt(item.currentVersion) + 1n).toString(), item.currentEventId,
            item.currentEventDigest, input.eventType, eventValues.targetEventId,
            eventValues.targetEventDigest, eventValues.failureLabel, eventValues.rationale,
            eventValues.anchorKind, eventValues.anchorStepIndex, subjectId, actor.userId,
            actor.projectRole, input.idempotencyKey, requestDigest, PLACEHOLDER_DIGEST]
        );
      } catch (error) {
        throw mapPgError(error);
      }
      const event = rowToStudyItemEvent(inserted.rows[0]);
        return itemEventResult(client, actor.projectId, studyId, studyItemId, event, false);
      });
    } catch (error) {
      await this.ensureDueClosure(actor.projectId, studyId).catch(() => undefined);
      throw error;
    }
    if (outcome === null) throw repoError("analysis_study_state_conflict", "Study deadline closed coding before this command");
    return outcome;
  }

  async getStudyItemContent(
    access: AnalysisStudyAccess,
    studyId: string,
    studyItemId: string,
    retryAfterDeadline = true
  ): Promise<AnalysisStudyItemContent | null> {
    await this.ensureDueClosure(access.projectId, studyId);
    try {
      return await this.transaction(async (client) => {
        await requireProjectRole(client, access.projectId, access.userId);
      const subjectId = await ensureGovernedSubject(client, access.projectId, access.userId);
      await closeIfDue(client, studyId, access.projectId);
      if (!(await lockOwnedStudy(client, access.projectId, studyId))) return null;
      const result = await client.query(
        `select study.population_id,study.draw_id,study.dataset_revision_id,
                item.id as study_item_id,item.draw_item_id,item.member_id,item.revision_item_id,
                item.case_id,item.position,revision_item.input_digest,revision_item.item_digest,
                revision_item.payload_snapshot
         from analysis_studies study
         join analysis_study_items item on item.study_id=study.id and item.project_id=study.project_id
         join dataset_revision_items revision_item
           on revision_item.id=item.revision_item_id and revision_item.project_id=study.project_id
         where study.project_id=$1 and study.id=$2 and item.id=$3
         for key share of study,item,revision_item`,
        [access.projectId, studyId, studyItemId]
      );
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      const exposureKey = `analysis-content-view:${row.dataset_revision_id}:${subjectId}`;
      await client.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,
            subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,
            reason,details,idempotency_key)
         values ($1,$2,$3,null,'human_access','development','content_view','person',$4,$5,
                 'analysis_population',$6,'Governed Analyze study item content view',$7,$8)
         on conflict (project_id,idempotency_key) do nothing`,
        [`dse_${randomUUID()}`, access.projectId, row.dataset_revision_id, subjectId,
          access.userId, row.population_id,
          JSON.stringify({ contract: "coeval/analysis-study-item-content-view/v1", studyId, studyItemId }),
          exposureKey]
      );
      const exposure = await client.query(
        `select * from dataset_exposure_events where project_id=$1 and idempotency_key=$2`,
        [access.projectId, exposureKey]
      );
      const exposureRow = exposure.rows[0];
      if (!exposureRow || String(exposureRow.revision_id) !== String(row.dataset_revision_id) ||
          exposureRow.revision_item_id !== null || String(exposureRow.subject_id) !== subjectId ||
          String(exposureRow.actor_user_id) !== access.userId ||
          String(exposureRow.evidence_ref_id) !== String(row.population_id)) {
        throw repoError("analysis_study_evidence_conflict", "Dataset exposure did not converge on the exact study content read");
      }
      const viewKey = stableId("analysis-study-view", studyId, studyItemId, subjectId);
      const requestDigest = analysisStudyItemViewRequestDigest({ projectId: access.projectId,
        studyId, studyItemId, viewerUserId: access.userId, viewerSubjectId: subjectId,
        datasetRevisionId: String(row.dataset_revision_id) });
      const viewId = `asiv_${randomUUID()}`;
      await client.query(
        `insert into analysis_study_item_views
           (id,project_id,study_id,study_item_id,dataset_exposure_event_id,viewer_user_id,
            viewer_subject_id,idempotency_key,request_digest,content_digest,viewed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,transaction_timestamp())
         on conflict (study_id,study_item_id,viewer_subject_id) do nothing`,
        [viewId, access.projectId, studyId, studyItemId, exposureRow.id, access.userId,
          subjectId, viewKey, requestDigest, PLACEHOLDER_DIGEST]
      );
      const view = await client.query(
        `select * from analysis_study_item_views
         where project_id=$1 and study_id=$2 and study_item_id=$3 and viewer_subject_id=$4`,
        [access.projectId, studyId, studyItemId, subjectId]
      );
      const viewRow = view.rows[0];
      if (!viewRow || String(viewRow.request_digest) !== requestDigest ||
          String(viewRow.dataset_exposure_event_id) !== String(exposureRow.id)) {
        throw repoError("analysis_study_evidence_conflict", "Study view did not converge on its exact governed exposure");
      }
        return {
        projectId: access.projectId, studyId, populationId: String(row.population_id),
        drawId: String(row.draw_id), datasetRevisionId: String(row.dataset_revision_id),
        studyItemId, drawItemId: String(row.draw_item_id), memberId: String(row.member_id),
        revisionItemId: String(row.revision_item_id), caseId: String(row.case_id),
        position: Number(row.position), inputDigest: String(row.input_digest),
        itemDigest: String(row.item_digest), viewEventId: String(viewRow.id),
        datasetExposureEventId: String(exposureRow.id),
        payloadSnapshot: DatasetRevisionPayloadSnapshotSchema.parse(parseJson(row.payload_snapshot))
        };
      });
    } catch (error) {
      if (retryAfterDeadline && error instanceof AnalysisStudyRepositoryError &&
          error.code === "analysis_study_state_conflict") {
        await this.ensureDueClosure(access.projectId, studyId);
        return this.getStudyItemContent(access, studyId, studyItemId, false);
      }
      throw error;
    }
  }

  async createTaxonomy(
    actor: AnalysisStudyActor,
    rawInput: AnalysisFailureTaxonomyCreateInput
  ): Promise<AnalysisTaxonomyRevisionResult> {
    const input = AnalysisFailureTaxonomyCreateInputSchema.parse(rawInput);
    requireOwnerActor(actor);
    const outcome = await this.transaction(async (client) => {
      await requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
      const requestDigest = analysisFailureTaxonomyRequestDigest(actor.projectId, input);
      const replay = await client.query(
        `select id,request_digest from analysis_failure_taxonomies
         where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== requestDigest) {
          throw repoError("analysis_study_idempotency_conflict", "Taxonomy idempotency key was reused with different input");
        }
        return loadTaxonomyRevisionResult(client, actor.projectId, String(replay.rows[0].id), null, true);
      }
      await client.query(`select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('analysis-taxonomy-project/v1',$1::text)::text,0))`, [actor.projectId]);
      const lockedReplay = await client.query(
        `select id,request_digest from analysis_failure_taxonomies where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (lockedReplay.rows[0]) {
        if (String(lockedReplay.rows[0].request_digest) !== requestDigest) {
          throw repoError("analysis_study_idempotency_conflict", "Taxonomy idempotency key was reused with different input");
        }
        return loadTaxonomyRevisionResult(client, actor.projectId, String(lockedReplay.rows[0].id), null, true);
      }
      const existing = await client.query(`select id from analysis_failure_taxonomies where project_id=$1`, [actor.projectId]);
      if (existing.rows[0]) throw repoError("analysis_taxonomy_conflict", "Project already has its single failure taxonomy");
      const taxonomyId = `aft_${randomUUID()}`;
      const revisionId = `aftr_${randomUUID()}`;
      const requestPayload = withoutIdempotency(input);
      const taxonomyContent = analysisFailureTaxonomyContentDigest({ projectId: actor.projectId,
        contractVersion: ANALYSIS_TAXONOMY_CONTRACT_VERSION, name: input.name, description: input.description });
      await client.query(
        `insert into analysis_failure_taxonomies
           (id,project_id,contract_version,name,description,idempotency_key,request_payload,
            request_digest,content_digest,created_by_user_id,created_by_subject_id,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,transaction_timestamp())`,
        [taxonomyId, actor.projectId, ANALYSIS_TAXONOMY_CONTRACT_VERSION, input.name,
          input.description, input.idempotencyKey, JSON.stringify(requestPayload), requestDigest,
          taxonomyContent, actor.userId, subjectId]
      );
      const codes = input.codes.map((code, position) => ({
        id: `afc_${randomUUID()}`, clientToken: code.clientToken, position,
        label: code.label, definition: code.definition, status: "active" as const
      }));
      const entryDigests = codes.map((code) => analysisTaxonomyRevisionCodeEntryDigest({
        taxonomyId, taxonomyRevisionId: revisionId, codeId: code.id, position: code.position,
        label: code.label, definition: code.definition, status: code.status
      }));
      const contentDigest = analysisTaxonomyContentDigest(entryDigests);
      const revisionBasis = { taxonomyId, sequence: 1, predecessorRevisionId: null,
        predecessorRevisionDigest: null, reason: input.reason, contentDigest };
      await client.query(
        `insert into analysis_failure_taxonomy_revisions
           (id,project_id,taxonomy_id,sequence,predecessor_revision_id,
            predecessor_revision_digest,code_count,reason,content_digest,revision_digest,
            created_by_user_id,created_by_subject_id,idempotency_key,request_payload,
            request_digest,created_at)
         values ($1,$2,$3,1,null,null,$4,$5,$6,$7,$8,$9,$10,$11,$12,transaction_timestamp())`,
        [revisionId, actor.projectId, taxonomyId, codes.length, input.reason, contentDigest,
          analysisTaxonomyRevisionDigest(revisionBasis), actor.userId, subjectId,
          input.idempotencyKey, JSON.stringify(requestPayload), requestDigest]
      );
      for (const [index, code] of codes.entries()) {
        await client.query(
          `insert into analysis_failure_codes
             (id,project_id,taxonomy_id,created_in_revision_id,client_token,content_digest,
              created_by_user_id,created_by_subject_id,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,transaction_timestamp())`,
          [code.id, actor.projectId, taxonomyId, revisionId, code.clientToken,
            analysisFailureCodeContentDigest({ projectId: actor.projectId, taxonomyId,
              createdInRevisionId: revisionId, codeId: code.id }), actor.userId, subjectId]
        );
        await client.query(
          `insert into analysis_failure_taxonomy_revision_codes
             (id,project_id,taxonomy_id,taxonomy_revision_id,code_id,position,label,
              definition,status,entry_digest,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,transaction_timestamp())`,
          [`aftrc_${randomUUID()}`, actor.projectId, taxonomyId, revisionId, code.id,
            code.position, code.label, code.definition, code.status, entryDigests[index]]
        );
      }
      return loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, revisionId, false);
    });
    return outcome;
  }

  async getTaxonomy(access: AnalysisStudyAccess): Promise<AnalysisTaxonomyDetail | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    const taxonomy = await loadTaxonomyArtifact(this.pool, access.projectId, null);
    if (!taxonomy) return null;
    const revision = await loadTaxonomyRevisionProjection(this.pool, access.projectId, taxonomy.id, null);
    return revision ? AnalysisTaxonomyDetailSchema.parse({ taxonomy, revision }) : null;
  }

  async listTaxonomyRevisions(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisTaxonomyRevisionsPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    if (!(await taxonomyExists(this.pool, access.projectId, taxonomyId))) return null;
    const cursor = decodeCursor(page.cursor, "taxonomy revision list", "sequence");
    const result = await this.pool.query(
      `select * from analysis_failure_taxonomy_revisions
       where project_id=$1 and taxonomy_id=$2 and ($3::integer is null or sequence<$3)
       order by sequence desc limit $4`,
      [access.projectId, taxonomyId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::integer total from analysis_failure_taxonomy_revisions where project_id=$1 and taxonomy_id=$2`, [access.projectId, taxonomyId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisTaxonomyRevisionsPageSchema.parse({ items: rows.map(rowToTaxonomyRevision),
      totalCount: Number(total.rows[0]?.total ?? 0), nextCursor: result.rows.length > page.limit
        ? encodeCursor({ kind: "sequence", primary: String(rows.at(-1)!.sequence) }) : null });
  }

  async getTaxonomyRevision(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    revisionId: string
  ): Promise<AnalysisTaxonomyRevisionProjection | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    return loadTaxonomyRevisionProjection(this.pool, access.projectId, taxonomyId, revisionId);
  }

  async createTaxonomyRevision(
    actor: AnalysisStudyActor,
    taxonomyId: string,
    rawInput: AnalysisTaxonomyRevisionCreateInput
  ): Promise<AnalysisTaxonomyRevisionResult> {
    const input = AnalysisTaxonomyRevisionCreateInputSchema.parse(rawInput);
    requireOwnerActor(actor);
    const outcome = await this.transaction(async (client) => {
      await requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
      const requestDigest = analysisTaxonomyRevisionRequestDigest(taxonomyId, input);
      const taxonomy = await loadTaxonomyArtifact(client, actor.projectId, taxonomyId);
      if (!taxonomy) throw repoError("analysis_taxonomy_not_found", "Failure taxonomy not found");
      const replay = await client.query(
        `select id,request_digest from analysis_failure_taxonomy_revisions
         where taxonomy_id=$1 and idempotency_key=$2`,
        [taxonomyId, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== requestDigest) {
          throw repoError("analysis_study_idempotency_conflict", "Taxonomy revision idempotency key was reused with different input");
        }
        return loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, String(replay.rows[0].id), true);
      }
      if (!(await lockOwnedTaxonomy(client, actor.projectId, taxonomyId))) {
        throw repoError("analysis_taxonomy_not_found", "Failure taxonomy not found");
      }
      const lockedReplay = await client.query(
        `select id,request_digest from analysis_failure_taxonomy_revisions where taxonomy_id=$1 and idempotency_key=$2`,
        [taxonomyId, input.idempotencyKey]
      );
      if (lockedReplay.rows[0]) {
        if (String(lockedReplay.rows[0].request_digest) !== requestDigest) {
          throw repoError("analysis_study_idempotency_conflict", "Taxonomy revision idempotency key was reused with different input");
        }
        return loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, String(lockedReplay.rows[0].id), true);
      }
      const previous = await loadTaxonomyRevisionProjection(client, actor.projectId, taxonomyId, null);
      if (!previous || previous.revision.id !== input.expectedPredecessorRevisionId ||
          previous.revision.revisionDigest !== input.expectedPredecessorRevisionDigest ||
          previous.revision.sequence !== input.expectedPredecessorSequence) {
        throw repoError("analysis_taxonomy_conflict", "Taxonomy revision compare-and-swap head mismatch");
      }
      const revisionId = `aftr_${randomUUID()}`;
      const previousCodes = new Map(previous.codes.map((code) => [code.codeId, code]));
      const codes = input.codes.map((command, position) => {
        if (command.kind === "existing") {
          if (!previousCodes.has(command.codeId)) {
            throw repoError("analysis_taxonomy_conflict", "Taxonomy successor named an unknown stable code");
          }
          return { id: command.codeId, clientToken: null, position, label: command.label,
            definition: command.definition, status: command.status, isNew: false };
        }
        return { id: `afc_${randomUUID()}`, clientToken: command.clientToken, position,
          label: command.label, definition: command.definition, status: "active" as const, isNew: true };
      });
      const entryDigests = codes.map((code) => analysisTaxonomyRevisionCodeEntryDigest({
        taxonomyId, taxonomyRevisionId: revisionId, codeId: code.id, position: code.position,
        label: code.label, definition: code.definition, status: code.status
      }));
      const contentDigest = analysisTaxonomyContentDigest(entryDigests);
      const revisionBasis = { taxonomyId, sequence: previous.revision.sequence + 1,
        predecessorRevisionId: previous.revision.id,
        predecessorRevisionDigest: previous.revision.revisionDigest,
        reason: input.reason, contentDigest };
      const candidateRevision: AnalysisTaxonomyRevisionArtifact = {
        id: revisionId, projectId: actor.projectId, ...revisionBasis, codeCount: codes.length,
        revisionDigest: analysisTaxonomyRevisionDigest(revisionBasis), createdByUserId: actor.userId,
        createdBySubjectId: subjectId, idempotencyKey: input.idempotencyKey, requestDigest,
        createdAt: new Date().toISOString()
      };
      const candidateCodes: AnalysisTaxonomyRevisionCodeArtifact[] = codes.map((code, index) => ({
        id: `aftrc_${randomUUID()}`, projectId: actor.projectId, taxonomyId,
        taxonomyRevisionId: revisionId, codeId: code.id, position: code.position,
        label: code.label, definition: code.definition, status: code.status,
        entryDigest: entryDigests[index]!, createdAt: candidateRevision.createdAt
      }));
      assertAnalysisTaxonomyRevision(taxonomy, candidateRevision, candidateCodes, previous);
      await client.query(
        `insert into analysis_failure_taxonomy_revisions
           (id,project_id,taxonomy_id,sequence,predecessor_revision_id,
            predecessor_revision_digest,code_count,reason,content_digest,revision_digest,
            created_by_user_id,created_by_subject_id,idempotency_key,request_payload,
            request_digest,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,transaction_timestamp())`,
        [revisionId, actor.projectId, taxonomyId, revisionBasis.sequence,
          revisionBasis.predecessorRevisionId, revisionBasis.predecessorRevisionDigest,
          codes.length, input.reason, contentDigest, candidateRevision.revisionDigest,
          actor.userId, subjectId, input.idempotencyKey, JSON.stringify(withoutIdempotency(input)),
          requestDigest]
      );
      for (const [index, code] of codes.entries()) {
        if (code.isNew) {
          await client.query(
            `insert into analysis_failure_codes
               (id,project_id,taxonomy_id,created_in_revision_id,client_token,content_digest,
                created_by_user_id,created_by_subject_id,created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,transaction_timestamp())`,
            [code.id, actor.projectId, taxonomyId, revisionId, code.clientToken,
              analysisFailureCodeContentDigest({ projectId: actor.projectId, taxonomyId,
                createdInRevisionId: revisionId, codeId: code.id }), actor.userId, subjectId]
          );
        }
        const entry = candidateCodes[index]!;
        await client.query(
          `insert into analysis_failure_taxonomy_revision_codes
             (id,project_id,taxonomy_id,taxonomy_revision_id,code_id,position,label,
              definition,status,entry_digest,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,transaction_timestamp())`,
          [entry.id, actor.projectId, taxonomyId, revisionId, code.id, code.position,
            code.label, code.definition, code.status, entry.entryDigest]
        );
      }
      return loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, revisionId, false);
    });
    return outcome;
  }

  async listObservationAssignments(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    observationEventId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisObservationAssignmentsPage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    const target = await this.pool.query(
      `select observation.study_id from analysis_study_item_events observation
       join analysis_failure_taxonomies taxonomy on taxonomy.project_id=observation.project_id
       where observation.project_id=$1 and observation.id=$2 and observation.event_type='failure_observed'
         and taxonomy.id=$3`,
      [access.projectId, observationEventId, taxonomyId]
    );
    if (!target.rows[0]) return null;
    await this.ensureDueClosure(access.projectId, String(target.rows[0].study_id));
    const cursor = decodeCursor(page.cursor, "assignment list", "version");
    const result = await this.pool.query(
      `select * from analysis_observation_assignment_events
       where project_id=$1 and taxonomy_id=$2 and observation_event_id=$3
         and ($4::bigint is null or version<$4)
       order by version desc limit $5`,
      [access.projectId, taxonomyId, observationEventId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::text total from analysis_observation_assignment_events where project_id=$1 and taxonomy_id=$2 and observation_event_id=$3`, [access.projectId, taxonomyId, observationEventId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisObservationAssignmentsPageSchema.parse({ items: rows.map(rowToAssignmentEvent),
      totalCount: String(total.rows[0]?.total ?? "0"), nextCursor: result.rows.length > page.limit
        ? encodeCursor({ kind: "version", primary: String(rows.at(-1)!.version) }) : null });
  }

  async appendObservationAssignment(
    actor: AnalysisStudyActor,
    taxonomyId: string,
    rawInput: AnalysisObservationAssignmentEventInput
  ): Promise<AnalysisObservationAssignmentEventResult> {
    const input = AnalysisObservationAssignmentEventInputSchema.parse(rawInput);
    const requestDigest = analysisAssignmentRequestDigest(input);
    const replay = await this.transaction(async (client) => {
      await requireProjectRole(client, actor.projectId, actor.userId);
      return findAssignmentReplay(client, actor.projectId, taxonomyId, input.observationEventId,
        input.idempotencyKey, requestDigest);
    });
    if (replay) return AnalysisObservationAssignmentEventResultSchema.parse({ event: replay, replayed: true });
    const observation = await this.pool.query(
      `select study_id from analysis_study_item_events where project_id=$1 and id=$2`,
      [actor.projectId, input.observationEventId]
    );
    if (observation.rows[0]) await this.ensureDueClosure(actor.projectId, String(observation.rows[0].study_id));
    let outcome: AnalysisObservationAssignmentEventResult | null;
    try {
      outcome = await this.transaction(async (client) => {
        await requireProjectRole(client, actor.projectId, actor.userId);
      const subjectId = await ensureGovernedSubject(client, actor.projectId, actor.userId);
      const repeated = await findAssignmentReplay(client, actor.projectId, taxonomyId,
        input.observationEventId, input.idempotencyKey, requestDigest);
      if (repeated) return AnalysisObservationAssignmentEventResultSchema.parse({ event: repeated, replayed: true });
      const target = await client.query(
        `select observation.study_id,observation.study_item_id,revision.sequence
         from analysis_study_item_events observation
         join analysis_failure_taxonomy_revisions revision
           on revision.id=$3 and revision.project_id=observation.project_id
         where observation.project_id=$1 and observation.id=$2
           and observation.event_type='failure_observed' and revision.taxonomy_id=$4`,
        [actor.projectId, input.observationEventId, input.taxonomyRevisionId, taxonomyId]
      );
      if (!target.rows[0]) throw repoError("analysis_assignment_conflict", "Assignment target observation or taxonomy revision not found");
      if (!(await lockOwnedStudy(client, actor.projectId, String(target.rows[0].study_id))) ||
          !(await lockOwnedTaxonomy(client, actor.projectId, taxonomyId))) {
        throw repoError("analysis_assignment_conflict", "Assignment target is unavailable");
      }
      const lockedReplay = await findAssignmentReplay(client, actor.projectId, taxonomyId,
        input.observationEventId, input.idempotencyKey, requestDigest);
      if (lockedReplay) return AnalysisObservationAssignmentEventResultSchema.parse({ event: lockedReplay, replayed: true });
      if (await closeIfDue(client, String(target.rows[0].study_id), actor.projectId)) return null;
      const eventId = `aoae_${randomUUID()}`;
      let inserted;
      try {
        inserted = await client.query(
          `insert into analysis_observation_assignment_events
             (id,project_id,study_id,study_item_id,observation_event_id,version,
              predecessor_event_id,predecessor_event_digest,event_type,taxonomy_id,
              taxonomy_revision_id,taxonomy_revision_sequence,code_id,rationale,
              actor_subject_id,actor_user_id,actor_role,idempotency_key,request_digest,
              event_digest,occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,transaction_timestamp())
           returning *`,
          [eventId, actor.projectId, target.rows[0].study_id, target.rows[0].study_item_id,
            input.observationEventId, (BigInt(input.expectedVersion) + 1n).toString(),
            input.expectedPredecessorEventId, input.expectedPredecessorEventDigest,
            input.eventType, taxonomyId, input.taxonomyRevisionId, Number(target.rows[0].sequence),
            input.codeId, input.rationale, subjectId, actor.userId, actor.projectRole,
            input.idempotencyKey, requestDigest, PLACEHOLDER_DIGEST]
        );
      } catch (error) {
        throw mapPgError(error);
      }
        return AnalysisObservationAssignmentEventResultSchema.parse({
          event: rowToAssignmentEvent(inserted.rows[0]), replayed: false
        });
      });
    } catch (error) {
      if (observation.rows[0]) {
        await this.ensureDueClosure(actor.projectId, String(observation.rows[0].study_id)).catch(() => undefined);
      }
      throw error;
    }
    if (outcome === null) throw repoError("analysis_study_state_conflict", "Study deadline closed coding before this assignment");
    return outcome;
  }

  async getTaxonomyCoverage(access: AnalysisStudyAccess, studyId: string, taxonomyRevisionId: string): Promise<AnalysisTaxonomyCoverage | null> {
    await requireProjectRole(this.pool, access.projectId, access.userId);
    await this.ensureDueClosure(access.projectId, studyId);
    return loadCoverage(this.pool, access.projectId, studyId, taxonomyRevisionId);
  }

  async closeDueStudies(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("deadline batch limit is invalid");
    const due = await this.pool.query(
      `select study.id,study.project_id
       from analysis_studies study
       join analysis_study_events opened on opened.study_id=study.id and opened.event_type='coding_opened'
       left join analysis_study_deadline_retry_state retry
         on retry.study_id=study.id and retry.project_id=study.project_id
       where opened.stopping_rule='server_deadline' and opened.close_at<=clock_timestamp()
         and analysis_study_state_v1(study.id)='coding_open'
         and (retry.study_id is null or retry.next_retry_at<=clock_timestamp())
       order by opened.close_at,study.id limit $1`,
      [limit]
    );
    let closed = 0;
    let failed = 0;
    for (const row of due.rows) {
      try {
        const didClose = await this.transaction(async (client) => {
          const result = await closeIfDue(client, String(row.id), String(row.project_id));
          await client.query(`select analysis_clear_deadline_retry_v1($1,$2)`, [row.project_id, row.id]);
          return result;
        });
        if (didClose) closed += 1;
      } catch {
        // One malformed historical study must not starve the remaining due
        // batch. Callers receive only the successful count; IDs stay private.
        failed += 1;
        await this.pool.query(
          `select analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
          [row.project_id, row.id]
        ).catch(() => undefined);
      }
    }
    if (failed > 0) console.error("analysis study deadline closure partial failure");
    return closed;
  }

  private async ensureDueClosure(projectId: string, studyId: string): Promise<void> {
    try {
      await this.transaction(async (client) => {
        await closeIfDue(client, studyId, projectId);
        await client.query(`select analysis_clear_deadline_retry_v1($1,$2)`, [projectId, studyId]);
      });
    } catch (error) {
      await this.pool.query(
        `select analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
        [projectId, studyId]
      ).catch(() => undefined);
      throw error;
    }
  }

  private async appendStudyEvent(
    actor: AnalysisStudyActor,
    studyId: string,
    idempotencyKey: string,
    requestDigest: string,
    build: (head: AnalysisStudyProjection) => StudyEventInsert
  ): Promise<AnalysisStudyEventResult> {
    requireOwnerActor(actor);
    const replay = await this.transaction(async (client) => {
      await requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const event = await findStudyEventReplay(client, actor.projectId, studyId, idempotencyKey, requestDigest);
      return event ? studyEventResult(client, actor.projectId, studyId, event, true) : null;
    });
    if (replay) return replay;
    await this.ensureDueClosure(actor.projectId, studyId);
    let outcome: AnalysisStudyEventResult | null;
    try {
      outcome = await this.transaction(async (client) => {
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
      await this.ensureDueClosure(actor.projectId, studyId).catch(() => undefined);
      throw error;
    }
    if (outcome === null) throw repoError("analysis_study_state_conflict", "Study deadline closed before this command");
    return outcome;
  }

  private async transaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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
}

const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

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

function studySummarySelect(): string {
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

function studyItemSelect(): string {
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

function rowToStudySummary(row: Record<string, unknown>): AnalysisStudySummary {
  return {
    study: rowToStudyProjection(row), selectedItemCount: Number(row.selected_item_count),
    viewedItemCount: Number(row.viewed_item_count), completedItemCount: Number(row.completed_item_count),
    closure: rowToClosure(row)
  };
}

function rowToStudyItemProjection(row: Record<string, unknown>): AnalysisStudyItemProjection {
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

async function loadStudyProjection(db: Pool | PoolClient, projectId: string, studyId: string): Promise<AnalysisStudyProjection | null> {
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

async function requireStudyProjection(db: Pool | PoolClient, projectId: string, studyId: string): Promise<AnalysisStudyProjection> {
  const projection = await loadStudyProjection(db, projectId, studyId);
  if (!projection) throw repoError("analysis_study_not_found", "Analysis study not found");
  return projection;
}

async function loadStudyItemProjection(db: Pool | PoolClient, projectId: string, studyId: string, studyItemId: string): Promise<AnalysisStudyItemProjection | null> {
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

function rowToStudyItemEvent(row: Record<string, unknown>): AnalysisStudyItemEventArtifact {
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

function rowToTaxonomyRevision(row: Record<string, unknown>): AnalysisTaxonomyRevisionArtifact {
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

async function loadTaxonomyArtifact(db: Pool | PoolClient, projectId: string, taxonomyId: string | null): Promise<AnalysisFailureTaxonomyArtifact | null> {
  const result = await db.query(
    `select * from analysis_failure_taxonomies where project_id=$1 and ($2::text is null or id=$2)`,
    [projectId, taxonomyId]
  );
  return result.rows[0] ? rowToTaxonomyArtifact(result.rows[0]) : null;
}

async function loadTaxonomyRevisionProjection(
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

async function loadTaxonomyRevisionResult(
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

function rowToAssignmentEvent(row: Record<string, unknown>): AnalysisObservationAssignmentEventArtifact {
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

async function loadCoverage(db: Pool | PoolClient, projectId: string, studyId: string, revisionId: string): Promise<AnalysisTaxonomyCoverage | null> {
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

async function studyEventResult(db: Pool | PoolClient, projectId: string, studyId: string,
  event: AnalysisStudyEventArtifact, replayed: boolean): Promise<AnalysisStudyEventResult> {
  return AnalysisStudyEventResultSchema.parse({ study: await requireStudyProjection(db, projectId, studyId), event, replayed });
}

async function itemEventResult(db: Pool | PoolClient, projectId: string, studyId: string,
  studyItemId: string, event: AnalysisStudyItemEventArtifact, replayed: boolean): Promise<AnalysisStudyItemEventResult> {
  const item = await loadStudyItemProjection(db, projectId, studyId, studyItemId);
  if (!item) throw repoError("analysis_study_not_found", "Analysis study item not found");
  return AnalysisStudyItemEventResultSchema.parse({ item, event, replayed });
}

async function findStudyEventReplay(db: Pool | PoolClient, projectId: string, studyId: string,
  key: string, requestDigest: string): Promise<AnalysisStudyEventArtifact | null> {
  const result = await db.query(`select * from analysis_study_events where project_id=$1 and study_id=$2 and idempotency_key=$3`,
    [projectId, studyId, key]);
  if (!result.rows[0]) return null;
  if (String(result.rows[0].request_digest) !== requestDigest) throw repoError("analysis_study_idempotency_conflict", "Study event idempotency key was reused with different input");
  return rowToStudyEvent(result.rows[0]);
}

async function findItemEventReplay(db: Pool | PoolClient, projectId: string, studyId: string,
  itemId: string, key: string, requestDigest: string): Promise<AnalysisStudyItemEventArtifact | null> {
  const result = await db.query(`select * from analysis_study_item_events where project_id=$1 and study_id=$2 and study_item_id=$3 and idempotency_key=$4`,
    [projectId, studyId, itemId, key]);
  if (!result.rows[0]) return null;
  if (String(result.rows[0].request_digest) !== requestDigest) throw repoError("analysis_study_idempotency_conflict", "Study item event idempotency key was reused with different input");
  return rowToStudyItemEvent(result.rows[0]);
}

async function findAssignmentReplay(db: Pool | PoolClient, projectId: string, taxonomyId: string,
  observationId: string, key: string, requestDigest: string): Promise<AnalysisObservationAssignmentEventArtifact | null> {
  const result = await db.query(`select * from analysis_observation_assignment_events where project_id=$1 and taxonomy_id=$2 and observation_event_id=$3 and idempotency_key=$4`,
    [projectId, taxonomyId, observationId, key]);
  if (!result.rows[0]) return null;
  if (String(result.rows[0].request_digest) !== requestDigest) throw repoError("analysis_study_idempotency_conflict", "Assignment idempotency key was reused with different input");
  return rowToAssignmentEvent(result.rows[0]);
}

async function materializeClosure(client: PoolClient, input: {
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

async function closeIfDue(client: PoolClient, studyId: string, expectedProjectId: string | null): Promise<boolean> {
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

function itemEventColumns(input: AnalysisStudyItemEventInput): {
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

async function lockOwnedStudy(client: PoolClient, projectId: string, studyId: string): Promise<boolean> {
  const owned = await client.query(
    `select 1 from analysis_studies where project_id=$1 and id=$2`,
    [projectId, studyId]
  );
  if (!owned.rows[0]) return false;
  await lockStudy(client, studyId);
  return true;
}

async function lockOwnedTaxonomy(client: PoolClient, projectId: string, taxonomyId: string): Promise<boolean> {
  const owned = await client.query(
    `select 1 from analysis_failure_taxonomies where project_id=$1 and id=$2`,
    [projectId, taxonomyId]
  );
  if (!owned.rows[0]) return false;
  await client.query(`select analysis_taxonomy_lock_v1($1)`, [taxonomyId]);
  return true;
}

async function requireProjectRole(
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

async function ensureGovernedSubject(client: PoolClient, projectId: string, userId: string): Promise<string> {
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

function requireOwnerActor(actor: AnalysisStudyActor): void {
  if (actor.projectRole !== "owner") throw repoError("analysis_study_forbidden", "Only project owners may administer analysis studies");
}

async function studyExists(db: Pool | PoolClient, projectId: string, studyId: string): Promise<boolean> {
  const result = await db.query(`select 1 from analysis_studies where project_id=$1 and id=$2`, [projectId, studyId]);
  return Boolean(result.rows[0]);
}

async function itemExists(db: Pool | PoolClient, projectId: string, studyId: string, itemId: string): Promise<boolean> {
  const result = await db.query(`select 1 from analysis_study_items where project_id=$1 and study_id=$2 and id=$3`, [projectId, studyId, itemId]);
  return Boolean(result.rows[0]);
}

async function taxonomyExists(db: Pool | PoolClient, projectId: string, taxonomyId: string): Promise<boolean> {
  const result = await db.query(`select 1 from analysis_failure_taxonomies where project_id=$1 and id=$2`, [projectId, taxonomyId]);
  return Boolean(result.rows[0]);
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function decodeCursor(value: string | null, scope: string, kind: CursorValue["kind"]): CursorValue | null {
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

function withoutIdempotency<T extends { idempotencyKey: string }>(input: T): Omit<T, "idempotencyKey"> {
  const { idempotencyKey: _idempotencyKey, ...request } = input;
  return request;
}

function repoError(
  code: ConstructorParameters<typeof AnalysisStudyRepositoryError>[0],
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): AnalysisStudyRepositoryError {
  return new AnalysisStudyRepositoryError(code, message, details);
}

function mapPgError(error: unknown): unknown {
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

function stableId(prefix: string, ...parts: string[]): string {
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

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
