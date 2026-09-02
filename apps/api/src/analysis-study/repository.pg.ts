import {
  ANALYSIS_STUDY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_CONTRACT_VERSION,
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
  AnalysisStudyItemEventInputSchema,
  AnalysisStudyItemEventsPageSchema,
  AnalysisStudyItemsPageSchema,
  AnalysisStudyOpenInputSchema,
  AnalysisStudySummariesPageSchema,
  AnalysisTaxonomyDetailSchema,
  AnalysisTaxonomyRevisionCreateInputSchema,
  AnalysisTaxonomyRevisionsPageSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisFailureTaxonomyCreateInput,
  type AnalysisObservationAssignmentEventInput,
  type AnalysisObservationAssignmentEventResult,
  type AnalysisObservationAssignmentsPage,
  type AnalysisStudyAbandonInput,
  type AnalysisStudyCloseInput,
  type AnalysisStudyCompleteInput,
  type AnalysisStudyCreateInput,
  type AnalysisStudyCreateResult,
  type AnalysisStudyDetail,
  type AnalysisStudyEventResult,
  type AnalysisStudyItemEventInput,
  type AnalysisStudyItemEventResult,
  type AnalysisStudyItemEventsPage,
  type AnalysisStudyItemsPage,
  type AnalysisStudyOpenInput,
  type AnalysisStudySummariesPage,
  type AnalysisTaxonomyCoverage,
  type AnalysisTaxonomyDetail,
  type AnalysisTaxonomyRevisionArtifact,
  type AnalysisTaxonomyRevisionCodeArtifact,
  type AnalysisTaxonomyRevisionCreateInput,
  type AnalysisTaxonomyRevisionProjection,
  type AnalysisTaxonomyRevisionResult,
  type AnalysisTaxonomyRevisionsPage
} from "@coeval/shared";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  analysisAssignmentRequestDigest,
  analysisFailureCodeContentDigest,
  analysisFailureTaxonomyContentDigest,
  analysisFailureTaxonomyRequestDigest,
  analysisStudyContentDigest,
  analysisStudyEventRequestDigest,
  analysisStudyItemContentDigest,
  analysisStudyItemEventRequestDigest,
  analysisStudyItemViewRequestDigest,
  analysisStudyRequestDigest,
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
import * as studySupport from "./repository.pg-support.js";

export class PgAnalysisStudyRepository implements AnalysisStudyRepository {
  constructor(private readonly pool: Pool) {}

  async createStudy(
    actor: AnalysisStudyActor,
    rawInput: AnalysisStudyCreateInput
  ): Promise<AnalysisStudyCreateResult> {
    const input = AnalysisStudyCreateInputSchema.parse(rawInput);
    studySupport.requireOwnerActor(actor);
    return studySupport.transaction(this.pool, async (client) => {
      await studySupport.requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await studySupport.ensureGovernedSubject(client, actor.projectId, actor.userId);
      const requestDigest = analysisStudyRequestDigest(actor.projectId, input.populationId);
      const replay = await client.query(
        `select id,request_digest from analysis_studies
         where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== requestDigest) {
          throw studySupport.repoError("analysis_study_idempotency_conflict", "Study idempotency key was reused with different input");
        }
        return AnalysisStudyCreateResultSchema.parse({
          study: await studySupport.requireStudyProjection(client, actor.projectId, String(replay.rows[0].id)),
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
          throw studySupport.repoError("analysis_study_idempotency_conflict", "Study idempotency key was reused with different input");
        }
        return AnalysisStudyCreateResultSchema.parse({
          study: await studySupport.requireStudyProjection(client, actor.projectId, String(lockedReplay.rows[0].id)), reused: true
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
      if (!frame.rows[0]) throw studySupport.repoError("analysis_study_not_found", "Analysis population not found");
      const existing = await client.query(
        `select id from analysis_studies where project_id=$1 and draw_id=$2`,
        [actor.projectId, frame.rows[0].draw_id]
      );
      if (existing.rows[0]) {
        throw studySupport.repoError("analysis_study_draw_conflict", "The selected draw already has its permanent analysis study", {
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
        study: await studySupport.requireStudyProjection(client, actor.projectId, studyId),
        reused: false
      });
    });
  }

  async listStudies(access: AnalysisStudyAccess, page: AnalysisStudyPageInput): Promise<AnalysisStudySummariesPage> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    const cursor = studySupport.decodeCursor(page.cursor, "study list", "chronological");
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
        await studySupport.ensureDueClosure(this.pool, access.projectId, String(row.id));
        available.push({ id: String(row.id), createdAtExact: String(row.created_at_exact) });
      } catch {
        // The failed study is durably backed off by ensureDueClosure. Omit it
        // fail-closed while retaining healthy metadata from the same page.
        unavailableDueClosureCount += 1;
      }
    }
    const result = available.length === 0 ? { rows: [] } : await this.pool.query(
      `${studySupport.studySummarySelect()}
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
      items: rows.map(studySupport.rowToStudySummary),
      totalCount: String(total.rows[0]?.total ?? "0"),
      unavailableDueClosureCount,
      nextCursor: cursorSource
        ? studySupport.encodeCursor({ kind: "chronological", primary: String(cursorSource.created_at_exact), id: String(cursorSource.id) })
        : null
    });
  }

  async getStudy(access: AnalysisStudyAccess, studyId: string): Promise<AnalysisStudyDetail | null> {
    const outcome = await studySupport.transaction(this.pool, async (client) => {
      await studySupport.requireProjectRole(client, access.projectId, access.userId);
      await studySupport.closeIfDue(client, studyId, access.projectId);
      const summaryRow = await client.query(`${studySupport.studySummarySelect()} where study.project_id=$1 and study.id=$2`, [access.projectId, studyId]);
      if (!summaryRow.rows[0]) return null;
      const summary = studySupport.rowToStudySummary(summaryRow.rows[0]);
      const taxonomy = await client.query(
        `select revision.id from analysis_failure_taxonomies taxonomy
         join lateral (select id from analysis_failure_taxonomy_revisions
           where taxonomy_id=taxonomy.id order by sequence desc limit 1) revision on true
         where taxonomy.project_id=$1`,
        [access.projectId]
      );
      const coverage = taxonomy.rows[0]
        ? await studySupport.loadCoverage(client, access.projectId, studyId, String(taxonomy.rows[0].id))
        : null;
      return AnalysisStudyDetailSchema.parse({ summary, taxonomyCoverage: coverage });
    });
    return outcome;
  }

  async openStudy(actor: AnalysisStudyActor, studyId: string, rawInput: AnalysisStudyOpenInput): Promise<AnalysisStudyEventResult> {
    const input = AnalysisStudyOpenInputSchema.parse(rawInput);
    return studySupport.appendStudyEvent(this.pool, actor, studyId, input.idempotencyKey,
      analysisStudyEventRequestDigest({ studyId, expectedVersion: input.expectedVersion,
        eventType: "coding_opened", stoppingRule: input.stoppingRule }),
      (head) => ({ eventType: "coding_opened" as const, fromState: "draft" as const,
        toState: "coding_open" as const, stoppingRule: input.stoppingRule,
        closeCause: null, closureId: null, closureDigest: null, expectedClosureDigest: null,
        reason: null, expectedVersion: input.expectedVersion, head }));
  }

  async completeStudy(actor: AnalysisStudyActor, studyId: string, rawInput: AnalysisStudyCompleteInput): Promise<AnalysisStudyEventResult> {
    const input = AnalysisStudyCompleteInputSchema.parse(rawInput);
    return studySupport.appendStudyEvent(this.pool, actor, studyId, input.idempotencyKey,
      analysisStudyEventRequestDigest({ studyId, expectedVersion: input.expectedVersion,
        eventType: "study_completed", expectedClosureDigest: input.expectedClosureDigest }),
      (head) => ({ eventType: "study_completed" as const, fromState: "coding_closed" as const,
        toState: "completed" as const, stoppingRule: null, closeCause: null, closureId: null,
        closureDigest: null, expectedClosureDigest: input.expectedClosureDigest, reason: null,
        expectedVersion: input.expectedVersion, head }));
  }

  async abandonStudy(actor: AnalysisStudyActor, studyId: string, rawInput: AnalysisStudyAbandonInput): Promise<AnalysisStudyEventResult> {
    const input = AnalysisStudyAbandonInputSchema.parse(rawInput);
    return studySupport.appendStudyEvent(this.pool, actor, studyId, input.idempotencyKey,
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
    studySupport.requireOwnerActor(actor);
    let outcome: AnalysisStudyEventResult | null;
    try {
      outcome = await studySupport.transaction(this.pool, async (client) => {
        await studySupport.requireProjectRole(client, actor.projectId, actor.userId, "owner");
        const subjectId = await studySupport.ensureGovernedSubject(client, actor.projectId, actor.userId);
        const requestDigest = analysisStudyEventRequestDigest({ studyId, expectedVersion: input.expectedVersion,
          eventType: "coding_closed", reason: input.reason });
        const replay = await studySupport.findStudyEventReplay(client, actor.projectId, studyId, input.idempotencyKey, requestDigest);
        if (replay) return studySupport.studyEventResult(client, actor.projectId, studyId, replay, true);
        if (!(await studySupport.lockOwnedStudy(client, actor.projectId, studyId))) {
          throw studySupport.repoError("analysis_study_not_found", "Analysis study not found");
        }
        const lockedReplay = await studySupport.findStudyEventReplay(
          client, actor.projectId, studyId, input.idempotencyKey, requestDigest
        );
        if (lockedReplay) return studySupport.studyEventResult(client, actor.projectId, studyId, lockedReplay, true);
        if (await studySupport.closeIfDue(client, studyId, actor.projectId)) return null;
        const head = await studySupport.requireStudyProjection(client, actor.projectId, studyId);
        if (head.currentVersion !== input.expectedVersion || head.state !== "coding_open" || head.stoppingRule?.kind !== "explicit_owner_close") {
          throw studySupport.repoError("analysis_study_state_conflict", "Study is not at the requested explicit-close head");
        }
        return studySupport.materializeClosure(client, {
          projectId: actor.projectId, studyId, idempotencyKey: input.idempotencyKey,
          requestDigest, closeCause: "explicit_owner_close", closeActorUserId: actor.userId,
          closeActorSubjectId: subjectId, closeReason: input.reason, expectedVersion: input.expectedVersion
        });
      });
    } catch (error) {
      await studySupport.ensureDueClosure(this.pool, actor.projectId, studyId).catch(() => undefined);
      throw error;
    }
    if (outcome === null) throw studySupport.repoError("analysis_study_state_conflict", "Frozen server deadline closed the study before owner close");
    return outcome;
  }

  async listStudyItems(access: AnalysisStudyAccess, studyId: string, page: AnalysisStudyPageInput): Promise<AnalysisStudyItemsPage | null> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    await studySupport.ensureDueClosure(this.pool, access.projectId, studyId);
    if (!(await studySupport.studyExists(this.pool, access.projectId, studyId))) return null;
    const cursor = studySupport.decodeCursor(page.cursor, "study item list", "position");
    const result = await this.pool.query(
      `${studySupport.studyItemSelect()}
       where item.project_id=$1 and item.study_id=$2 and ($3::integer is null or item.position>$3)
       order by item.position limit $4`,
      [access.projectId, studyId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::integer total from analysis_study_items where project_id=$1 and study_id=$2`, [access.projectId, studyId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisStudyItemsPageSchema.parse({ items: rows.map(studySupport.rowToStudyItemProjection),
      totalCount: Number(total.rows[0]?.total ?? 0), nextCursor: result.rows.length > page.limit
        ? studySupport.encodeCursor({ kind: "position", primary: String(rows.at(-1)!.position) }) : null });
  }

  async listStudyItemEvents(access: AnalysisStudyAccess, studyId: string, studyItemId: string, page: AnalysisStudyPageInput): Promise<AnalysisStudyItemEventsPage | null> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    await studySupport.ensureDueClosure(this.pool, access.projectId, studyId);
    if (!(await studySupport.itemExists(this.pool, access.projectId, studyId, studyItemId))) return null;
    const cursor = studySupport.decodeCursor(page.cursor, "study item event list", "version");
    const result = await this.pool.query(
      `select * from analysis_study_item_events
       where project_id=$1 and study_id=$2 and study_item_id=$3
         and ($4::bigint is null or version<$4)
       order by version desc limit $5`,
      [access.projectId, studyId, studyItemId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::text total from analysis_study_item_events where project_id=$1 and study_id=$2 and study_item_id=$3`, [access.projectId, studyId, studyItemId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisStudyItemEventsPageSchema.parse({ items: rows.map(studySupport.rowToStudyItemEvent),
      totalCount: String(total.rows[0]?.total ?? "0"), nextCursor: result.rows.length > page.limit
        ? studySupport.encodeCursor({ kind: "version", primary: String(rows.at(-1)!.version) }) : null });
  }

  async getStudyItem(access: AnalysisStudyAccess, studyId: string, studyItemId: string): Promise<AnalysisStudyItemContext | null> {
    const outcome = await studySupport.transaction(this.pool, async (client) => {
      await studySupport.requireProjectRole(client, access.projectId, access.userId);
      await studySupport.closeIfDue(client, studyId, access.projectId);
      const study = await studySupport.loadStudyProjection(client, access.projectId, studyId);
      if (!study) return null;
      const item = await studySupport.loadStudyItemProjection(client, access.projectId, studyId, studyItemId);
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
    const replay = await studySupport.transaction(this.pool, async (client) => {
      await studySupport.requireProjectRole(client, actor.projectId, actor.userId);
      const event = await studySupport.findItemEventReplay(client, actor.projectId, studyId, studyItemId,
        input.idempotencyKey, requestDigest);
      return event ? studySupport.itemEventResult(client, actor.projectId, studyId, studyItemId, event, true) : null;
    });
    if (replay) return replay;
    await studySupport.ensureDueClosure(this.pool, actor.projectId, studyId);
    let outcome: AnalysisStudyItemEventResult | null;
    try {
      outcome = await studySupport.transaction(this.pool, async (client) => {
        await studySupport.requireProjectRole(client, actor.projectId, actor.userId);
      const subjectId = await studySupport.ensureGovernedSubject(client, actor.projectId, actor.userId);
      const repeated = await studySupport.findItemEventReplay(client, actor.projectId, studyId, studyItemId,
        input.idempotencyKey, requestDigest);
      if (repeated) return studySupport.itemEventResult(client, actor.projectId, studyId, studyItemId, repeated, true);
      if (!(await studySupport.lockOwnedStudy(client, actor.projectId, studyId))) {
        throw studySupport.repoError("analysis_study_not_found", "Analysis study not found");
      }
      const lockedReplay = await studySupport.findItemEventReplay(client, actor.projectId, studyId, studyItemId,
        input.idempotencyKey, requestDigest);
      if (lockedReplay) return studySupport.itemEventResult(client, actor.projectId, studyId, studyItemId, lockedReplay, true);
      if (await studySupport.closeIfDue(client, studyId, actor.projectId)) return null;
      const study = await studySupport.requireStudyProjection(client, actor.projectId, studyId);
      const item = await studySupport.loadStudyItemProjection(client, actor.projectId, studyId, studyItemId);
      if (!item) throw studySupport.repoError("analysis_study_not_found", "Analysis study item not found");
      if (study.state !== "coding_open") throw studySupport.repoError("analysis_study_state_conflict", "Study coding is not open");
      if (item.currentVersion !== input.expectedVersion) {
        throw studySupport.repoError("analysis_study_version_conflict", "Study item compare-and-swap version does not match");
      }
      const eventId = `asie_${randomUUID()}`;
      const eventValues = studySupport.itemEventColumns(input);
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
            actor.projectRole, input.idempotencyKey, requestDigest, studySupport.PLACEHOLDER_DIGEST]
        );
      } catch (error) {
        throw studySupport.mapPgError(error);
      }
      const event = studySupport.rowToStudyItemEvent(inserted.rows[0]);
        return studySupport.itemEventResult(client, actor.projectId, studyId, studyItemId, event, false);
      });
    } catch (error) {
      await studySupport.ensureDueClosure(this.pool, actor.projectId, studyId).catch(() => undefined);
      throw error;
    }
    if (outcome === null) throw studySupport.repoError("analysis_study_state_conflict", "Study deadline closed coding before this command");
    return outcome;
  }

  async getStudyItemContent(
    access: AnalysisStudyAccess,
    studyId: string,
    studyItemId: string,
    retryAfterDeadline = true
  ): Promise<AnalysisStudyItemContent | null> {
    await studySupport.ensureDueClosure(this.pool, access.projectId, studyId);
    try {
      return await studySupport.transaction(this.pool, async (client) => {
        await studySupport.requireProjectRole(client, access.projectId, access.userId);
      const subjectId = await studySupport.ensureGovernedSubject(client, access.projectId, access.userId);
      await studySupport.closeIfDue(client, studyId, access.projectId);
      if (!(await studySupport.lockOwnedStudy(client, access.projectId, studyId))) return null;
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
        throw studySupport.repoError("analysis_study_evidence_conflict", "Dataset exposure did not converge on the exact study content read");
      }
      const viewKey = studySupport.stableId("analysis-study-view", studyId, studyItemId, subjectId);
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
          subjectId, viewKey, requestDigest, studySupport.PLACEHOLDER_DIGEST]
      );
      const view = await client.query(
        `select * from analysis_study_item_views
         where project_id=$1 and study_id=$2 and study_item_id=$3 and viewer_subject_id=$4`,
        [access.projectId, studyId, studyItemId, subjectId]
      );
      const viewRow = view.rows[0];
      if (!viewRow || String(viewRow.request_digest) !== requestDigest ||
          String(viewRow.dataset_exposure_event_id) !== String(exposureRow.id)) {
        throw studySupport.repoError("analysis_study_evidence_conflict", "Study view did not converge on its exact governed exposure");
      }
        return {
        projectId: access.projectId, studyId, populationId: String(row.population_id),
        drawId: String(row.draw_id), datasetRevisionId: String(row.dataset_revision_id),
        studyItemId, drawItemId: String(row.draw_item_id), memberId: String(row.member_id),
        revisionItemId: String(row.revision_item_id), caseId: String(row.case_id),
        position: Number(row.position), inputDigest: String(row.input_digest),
        itemDigest: String(row.item_digest), viewEventId: String(viewRow.id),
        datasetExposureEventId: String(exposureRow.id),
        payloadSnapshot: DatasetRevisionPayloadSnapshotSchema.parse(studySupport.parseJson(row.payload_snapshot))
        };
      });
    } catch (error) {
      if (retryAfterDeadline && error instanceof AnalysisStudyRepositoryError &&
          error.code === "analysis_study_state_conflict") {
        await studySupport.ensureDueClosure(this.pool, access.projectId, studyId);
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
    studySupport.requireOwnerActor(actor);
    const outcome = await studySupport.transaction(this.pool, async (client) => {
      await studySupport.requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await studySupport.ensureGovernedSubject(client, actor.projectId, actor.userId);
      const requestDigest = analysisFailureTaxonomyRequestDigest(actor.projectId, input);
      const replay = await client.query(
        `select id,request_digest from analysis_failure_taxonomies
         where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== requestDigest) {
          throw studySupport.repoError("analysis_study_idempotency_conflict", "Taxonomy idempotency key was reused with different input");
        }
        return studySupport.loadTaxonomyRevisionResult(client, actor.projectId, String(replay.rows[0].id), null, true);
      }
      await client.query(`select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('analysis-taxonomy-project/v1',$1::text)::text,0))`, [actor.projectId]);
      const lockedReplay = await client.query(
        `select id,request_digest from analysis_failure_taxonomies where project_id=$1 and idempotency_key=$2`,
        [actor.projectId, input.idempotencyKey]
      );
      if (lockedReplay.rows[0]) {
        if (String(lockedReplay.rows[0].request_digest) !== requestDigest) {
          throw studySupport.repoError("analysis_study_idempotency_conflict", "Taxonomy idempotency key was reused with different input");
        }
        return studySupport.loadTaxonomyRevisionResult(client, actor.projectId, String(lockedReplay.rows[0].id), null, true);
      }
      const existing = await client.query(`select id from analysis_failure_taxonomies where project_id=$1`, [actor.projectId]);
      if (existing.rows[0]) throw studySupport.repoError("analysis_taxonomy_conflict", "Project already has its single failure taxonomy");
      const taxonomyId = `aft_${randomUUID()}`;
      const revisionId = `aftr_${randomUUID()}`;
      const requestPayload = studySupport.withoutIdempotency(input);
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
      return studySupport.loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, revisionId, false);
    });
    return outcome;
  }

  async getTaxonomy(access: AnalysisStudyAccess): Promise<AnalysisTaxonomyDetail | null> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    const taxonomy = await studySupport.loadTaxonomyArtifact(this.pool, access.projectId, null);
    if (!taxonomy) return null;
    const revision = await studySupport.loadTaxonomyRevisionProjection(this.pool, access.projectId, taxonomy.id, null);
    return revision ? AnalysisTaxonomyDetailSchema.parse({ taxonomy, revision }) : null;
  }

  async listTaxonomyRevisions(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisTaxonomyRevisionsPage | null> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    if (!(await studySupport.taxonomyExists(this.pool, access.projectId, taxonomyId))) return null;
    const cursor = studySupport.decodeCursor(page.cursor, "taxonomy revision list", "sequence");
    const result = await this.pool.query(
      `select * from analysis_failure_taxonomy_revisions
       where project_id=$1 and taxonomy_id=$2 and ($3::integer is null or sequence<$3)
       order by sequence desc limit $4`,
      [access.projectId, taxonomyId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::integer total from analysis_failure_taxonomy_revisions where project_id=$1 and taxonomy_id=$2`, [access.projectId, taxonomyId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisTaxonomyRevisionsPageSchema.parse({ items: rows.map(studySupport.rowToTaxonomyRevision),
      totalCount: Number(total.rows[0]?.total ?? 0), nextCursor: result.rows.length > page.limit
        ? studySupport.encodeCursor({ kind: "sequence", primary: String(rows.at(-1)!.sequence) }) : null });
  }

  async getTaxonomyRevision(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    revisionId: string
  ): Promise<AnalysisTaxonomyRevisionProjection | null> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    return studySupport.loadTaxonomyRevisionProjection(this.pool, access.projectId, taxonomyId, revisionId);
  }

  async createTaxonomyRevision(
    actor: AnalysisStudyActor,
    taxonomyId: string,
    rawInput: AnalysisTaxonomyRevisionCreateInput
  ): Promise<AnalysisTaxonomyRevisionResult> {
    const input = AnalysisTaxonomyRevisionCreateInputSchema.parse(rawInput);
    studySupport.requireOwnerActor(actor);
    const outcome = await studySupport.transaction(this.pool, async (client) => {
      await studySupport.requireProjectRole(client, actor.projectId, actor.userId, "owner");
      const subjectId = await studySupport.ensureGovernedSubject(client, actor.projectId, actor.userId);
      const requestDigest = analysisTaxonomyRevisionRequestDigest(taxonomyId, input);
      const taxonomy = await studySupport.loadTaxonomyArtifact(client, actor.projectId, taxonomyId);
      if (!taxonomy) throw studySupport.repoError("analysis_taxonomy_not_found", "Failure taxonomy not found");
      const replay = await client.query(
        `select id,request_digest from analysis_failure_taxonomy_revisions
         where taxonomy_id=$1 and idempotency_key=$2`,
        [taxonomyId, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_digest) !== requestDigest) {
          throw studySupport.repoError("analysis_study_idempotency_conflict", "Taxonomy revision idempotency key was reused with different input");
        }
        return studySupport.loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, String(replay.rows[0].id), true);
      }
      if (!(await studySupport.lockOwnedTaxonomy(client, actor.projectId, taxonomyId))) {
        throw studySupport.repoError("analysis_taxonomy_not_found", "Failure taxonomy not found");
      }
      const lockedReplay = await client.query(
        `select id,request_digest from analysis_failure_taxonomy_revisions where taxonomy_id=$1 and idempotency_key=$2`,
        [taxonomyId, input.idempotencyKey]
      );
      if (lockedReplay.rows[0]) {
        if (String(lockedReplay.rows[0].request_digest) !== requestDigest) {
          throw studySupport.repoError("analysis_study_idempotency_conflict", "Taxonomy revision idempotency key was reused with different input");
        }
        return studySupport.loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, String(lockedReplay.rows[0].id), true);
      }
      const previous = await studySupport.loadTaxonomyRevisionProjection(client, actor.projectId, taxonomyId, null);
      if (!previous || previous.revision.id !== input.expectedPredecessorRevisionId ||
          previous.revision.revisionDigest !== input.expectedPredecessorRevisionDigest ||
          previous.revision.sequence !== input.expectedPredecessorSequence) {
        throw studySupport.repoError("analysis_taxonomy_conflict", "Taxonomy revision compare-and-swap head mismatch");
      }
      const revisionId = `aftr_${randomUUID()}`;
      const previousCodes = new Map(previous.codes.map((code) => [code.codeId, code]));
      const codes = input.codes.map((command, position) => {
        if (command.kind === "existing") {
          if (!previousCodes.has(command.codeId)) {
            throw studySupport.repoError("analysis_taxonomy_conflict", "Taxonomy successor named an unknown stable code");
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
          actor.userId, subjectId, input.idempotencyKey, JSON.stringify(studySupport.withoutIdempotency(input)),
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
      return studySupport.loadTaxonomyRevisionResult(client, actor.projectId, taxonomyId, revisionId, false);
    });
    return outcome;
  }

  async listObservationAssignments(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    observationEventId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisObservationAssignmentsPage | null> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    const target = await this.pool.query(
      `select observation.study_id from analysis_study_item_events observation
       join analysis_failure_taxonomies taxonomy on taxonomy.project_id=observation.project_id
       where observation.project_id=$1 and observation.id=$2 and observation.event_type='failure_observed'
         and taxonomy.id=$3`,
      [access.projectId, observationEventId, taxonomyId]
    );
    if (!target.rows[0]) return null;
    await studySupport.ensureDueClosure(this.pool, access.projectId, String(target.rows[0].study_id));
    const cursor = studySupport.decodeCursor(page.cursor, "assignment list", "version");
    const result = await this.pool.query(
      `select * from analysis_observation_assignment_events
       where project_id=$1 and taxonomy_id=$2 and observation_event_id=$3
         and ($4::bigint is null or version<$4)
       order by version desc limit $5`,
      [access.projectId, taxonomyId, observationEventId, cursor?.primary ?? null, page.limit + 1]
    );
    const total = await this.pool.query(`select count(*)::text total from analysis_observation_assignment_events where project_id=$1 and taxonomy_id=$2 and observation_event_id=$3`, [access.projectId, taxonomyId, observationEventId]);
    const rows = result.rows.slice(0, page.limit);
    return AnalysisObservationAssignmentsPageSchema.parse({ items: rows.map(studySupport.rowToAssignmentEvent),
      totalCount: String(total.rows[0]?.total ?? "0"), nextCursor: result.rows.length > page.limit
        ? studySupport.encodeCursor({ kind: "version", primary: String(rows.at(-1)!.version) }) : null });
  }

  async appendObservationAssignment(
    actor: AnalysisStudyActor,
    taxonomyId: string,
    rawInput: AnalysisObservationAssignmentEventInput
  ): Promise<AnalysisObservationAssignmentEventResult> {
    const input = AnalysisObservationAssignmentEventInputSchema.parse(rawInput);
    const requestDigest = analysisAssignmentRequestDigest(input);
    const replay = await studySupport.transaction(this.pool, async (client) => {
      await studySupport.requireProjectRole(client, actor.projectId, actor.userId);
      return studySupport.findAssignmentReplay(client, actor.projectId, taxonomyId, input.observationEventId,
        input.idempotencyKey, requestDigest);
    });
    if (replay) return AnalysisObservationAssignmentEventResultSchema.parse({ event: replay, replayed: true });
    const observation = await this.pool.query(
      `select study_id from analysis_study_item_events where project_id=$1 and id=$2`,
      [actor.projectId, input.observationEventId]
    );
    if (observation.rows[0]) await studySupport.ensureDueClosure(this.pool, actor.projectId, String(observation.rows[0].study_id));
    let outcome: AnalysisObservationAssignmentEventResult | null;
    try {
      outcome = await studySupport.transaction(this.pool, async (client) => {
        await studySupport.requireProjectRole(client, actor.projectId, actor.userId);
      const subjectId = await studySupport.ensureGovernedSubject(client, actor.projectId, actor.userId);
      const repeated = await studySupport.findAssignmentReplay(client, actor.projectId, taxonomyId,
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
      if (!target.rows[0]) throw studySupport.repoError("analysis_assignment_conflict", "Assignment target observation or taxonomy revision not found");
      if (!(await studySupport.lockOwnedStudy(client, actor.projectId, String(target.rows[0].study_id))) ||
          !(await studySupport.lockOwnedTaxonomy(client, actor.projectId, taxonomyId))) {
        throw studySupport.repoError("analysis_assignment_conflict", "Assignment target is unavailable");
      }
      const lockedReplay = await studySupport.findAssignmentReplay(client, actor.projectId, taxonomyId,
        input.observationEventId, input.idempotencyKey, requestDigest);
      if (lockedReplay) return AnalysisObservationAssignmentEventResultSchema.parse({ event: lockedReplay, replayed: true });
      if (await studySupport.closeIfDue(client, String(target.rows[0].study_id), actor.projectId)) return null;
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
            input.idempotencyKey, requestDigest, studySupport.PLACEHOLDER_DIGEST]
        );
      } catch (error) {
        throw studySupport.mapPgError(error);
      }
        return AnalysisObservationAssignmentEventResultSchema.parse({
          event: studySupport.rowToAssignmentEvent(inserted.rows[0]), replayed: false
        });
      });
    } catch (error) {
      if (observation.rows[0]) {
        await studySupport.ensureDueClosure(this.pool, actor.projectId, String(observation.rows[0].study_id)).catch(() => undefined);
      }
      throw error;
    }
    if (outcome === null) throw studySupport.repoError("analysis_study_state_conflict", "Study deadline closed coding before this assignment");
    return outcome;
  }

  async getTaxonomyCoverage(access: AnalysisStudyAccess, studyId: string, taxonomyRevisionId: string): Promise<AnalysisTaxonomyCoverage | null> {
    await studySupport.requireProjectRole(this.pool, access.projectId, access.userId);
    await studySupport.ensureDueClosure(this.pool, access.projectId, studyId);
    return studySupport.loadCoverage(this.pool, access.projectId, studyId, taxonomyRevisionId);
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
        const didClose = await studySupport.transaction(this.pool, async (client) => {
          const result = await studySupport.closeIfDue(client, String(row.id), String(row.project_id));
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
}
