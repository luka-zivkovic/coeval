import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "@coeval/db";
import { PgAnalysisPopulationRepository } from "../src/analysis-population/repository.pg.js";
import { PgAnalysisStudyRepository } from "../src/analysis-study/repository.pg.js";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; analysis study repository tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

function cursor(kind: "position" | "version" | "sequence", primary: string): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, primary }), "utf8").toString("base64url");
}

async function withSchema(body: (pool: Pool, schema: string, databaseUrl: string) => Promise<void>): Promise<void> {
  const { pool, schema, databaseUrl: testDatabaseUrl, cleanup } = await openPostgresTestDatabase("analysis_study_repo");
  try {
    await runMigrations(pool);
    await body(pool, schema, testDatabaseUrl);
  } finally {
    await cleanup();
  }
}

async function seedProject(pool: Pool, suffix: string) {
  const organizationId = `org_${suffix}`;
  const projectId = `proj_${suffix}`;
  const ownerId = `owner_${suffix}`;
  const memberId = `member_${suffix}`;
  await pool.query(
    `insert into "user" (id,name,email,email_verified) values
       ($1,$2,$3,true),($4,$5,$6,true)`,
    [ownerId, `${suffix} owner`, `${suffix}-owner@example.test`,
      memberId, `${suffix} member`, `${suffix}-member@example.test`]
  );
  await pool.query(`insert into organizations (id,name) values ($1,$2)`, [organizationId, suffix]);
  await pool.query(
    `insert into projects (id,organization_id,name,trace_provider) values ($1,$2,$3,'manual')`,
    [projectId, organizationId, suffix]
  );
  await pool.query(
    `insert into project_members (id,project_id,user_id,role) values
       ($1,$2,$3,'owner'),($4,$2,$5,'member')`,
    [`pm_owner_${suffix}`, projectId, ownerId, `pm_member_${suffix}`, memberId]
  );
  return {
    owner: { projectId, userId: ownerId, projectRole: "owner" as const },
    member: { projectId, userId: memberId, projectRole: "member" as const }
  };
}

async function seedEligibleCase(
  pool: Pool,
  projectId: string,
  suffix: string,
  createdAt = "2026-01-10T12:00:00.123456Z"
): Promise<void> {
  const rawId = `raw_${suffix}`;
  const caseId = `case_${suffix}`;
  const payload = {
    input: { question: `Question ${suffix}?` },
    output: { answer: `Answer ${suffix}` },
    metadata: { retained: true },
    steps: [{ name: "reason", input: { prompt: "explain" }, output: "exact step" }]
  };
  await pool.query(
    `insert into raw_traces
       (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
     values ($1,$2,$3,$4,'manual-v1',$5)`,
    [rawId, projectId, `trace-${suffix}`, JSON.stringify(payload), createdAt]
  );
  await pool.query(
    `insert into cases
       (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
     values ($1,$2,$3,'manual',$4,'analysis_eligible_manual',$5)`,
    [caseId, projectId, rawId, JSON.stringify(payload), createdAt]
  );
  await pool.query(
    `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     values ($1,$2,$3,'authoring_import','input-identity/v1',$4)`,
    [`ciir_${suffix}`, projectId, caseId, datasetInputIdentity({ input: payload.input }).digest]
  );
}

async function seedDeadlineStudy(pool: Pool, suffix: string, closeDelayMs: number) {
  const actors = await seedProject(pool, suffix);
  await seedEligibleCase(pool, actors.owner.projectId, suffix);
  const populations = new PgAnalysisPopulationRepository(pool);
  const population = await populations.createPopulation(actors.owner, {
    windowStart: "2026-01-01T00:00:00.000Z", windowEnd: "2026-02-01T00:00:00.000Z",
    fixedBudget: 1, idempotencyKey: `${suffix}-frame`
  });
  const repository = new PgAnalysisStudyRepository(pool);
  const study = await repository.createStudy(actors.owner, {
    populationId: population.population.id, idempotencyKey: `${suffix}-study`
  });
  await repository.openStudy(actors.owner, study.study.study.id, {
    expectedVersion: "0", stoppingRule: { kind: "server_deadline",
      closeAt: new Date(Date.now() + closeDelayMs).toISOString() },
    idempotencyKey: `${suffix}-open`
  });
  const items = await repository.listStudyItems(actors.owner, study.study.study.id, { limit: 10, cursor: null });
  return { actors, population, repository, study, item: items!.items[0]! };
}

run("PostgreSQL analysis study repository", () => {
  it("preserves idempotent study/coding/taxonomy evidence and freezes closure before post-close views", async () => {
    await withSchema(async (pool) => {
      const actors = await seedProject(pool, "study_happy");
      await seedEligibleCase(pool, actors.owner.projectId, "study_happy");
      const populationRepository = new PgAnalysisPopulationRepository(pool);
      const population = await populationRepository.createPopulation(actors.owner, {
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-02-01T00:00:00.000Z",
        fixedBudget: 1,
        idempotencyKey: "study-frame"
      });
      const repository = new PgAnalysisStudyRepository(pool);

      const [first, replay] = await Promise.all([
        repository.createStudy(actors.owner, {
          populationId: population.population.id, idempotencyKey: "study-create"
        }),
        repository.createStudy(actors.owner, {
          populationId: population.population.id, idempotencyKey: "study-create"
        })
      ]);
      expect(first.study.study.id).toBe(replay.study.study.id);
      expect([first.reused, replay.reused].sort()).toEqual([false, true]);

      const openInput = {
        expectedVersion: "0", stoppingRule: { kind: "explicit_owner_close", closeAt: null },
        idempotencyKey: "study-open"
      } as const;
      const openedPair = await Promise.all([
        repository.openStudy(actors.owner, first.study.study.id, openInput),
        repository.openStudy(actors.owner, first.study.study.id, openInput)
      ]);
      expect(openedPair.map((result) => result.replayed).sort()).toEqual([false, true]);
      const opened = openedPair[0]!;
      const items = await repository.listStudyItems(actors.owner, first.study.study.id, { limit: 10, cursor: null });
      const item = items!.items[0]!;
      await expect(repository.listStudyItems(actors.owner, first.study.study.id, {
        limit: 10, cursor: cursor("position", "10000")
      })).rejects.toMatchObject({ code: "analysis_study_invalid_cursor" });
      const observationInput = { eventType: "failure_observed" as const, expectedVersion: "0", failureLabel: "Incorrect answer",
          rationale: "The frozen output is incorrect.", evidenceAnchor: { kind: "case_output" },
          idempotencyKey: "observe-failure" } as const;
      const observedPair = await Promise.all([
        repository.appendStudyItemEvent(actors.member, first.study.study.id, item.item.id, observationInput),
        repository.appendStudyItemEvent(actors.member, first.study.study.id, item.item.id, observationInput)
      ]);
      expect(observedPair.map((result) => result.replayed).sort()).toEqual([false, true]);
      const observed = observedPair[0]!;
      await expect(repository.listStudyItemEvents(actors.owner, first.study.study.id, item.item.id, {
        limit: 10, cursor: cursor("version", "9223372036854775808")
      })).rejects.toMatchObject({ code: "analysis_study_invalid_cursor" });
      const taxonomyInput = {
        name: "Failure taxonomy", description: "Flat exact failure codes.", reason: "Initial coding taxonomy",
        codes: [{ kind: "new" as const, clientToken: "incorrect-answer", label: "Incorrect answer",
          definition: "The final answer is substantively incorrect." }],
        idempotencyKey: "taxonomy-create"
      };
      const taxonomyPair = await Promise.all([
        repository.createTaxonomy(actors.owner, taxonomyInput),
        repository.createTaxonomy(actors.owner, taxonomyInput)
      ]);
      expect(taxonomyPair.map((result) => result.replayed).sort()).toEqual([false, true]);
      const taxonomy = taxonomyPair[0]!;
      const assignmentInput = {
        eventType: "assigned", observationEventId: observed.event.id,
        taxonomyRevisionId: taxonomy.revision.revision.id, codeId: taxonomy.revision.codes[0]!.codeId,
        expectedVersion: "0", expectedPredecessorEventId: null,
        expectedPredecessorEventDigest: null, rationale: "Exact active code.",
        idempotencyKey: "assignment-create"
      } as const;
      const assignedPair = await Promise.all([
        repository.appendObservationAssignment(actors.member, taxonomy.taxonomy.id, assignmentInput),
        repository.appendObservationAssignment(actors.member, taxonomy.taxonomy.id, assignmentInput)
      ]);
      expect(assignedPair.map((result) => result.replayed).sort()).toEqual([false, true]);
      const revisionInput = {
        expectedPredecessorRevisionId: taxonomy.revision.revision.id,
        expectedPredecessorRevisionDigest: taxonomy.revision.revision.revisionDigest,
        expectedPredecessorSequence: 1,
        reason: "Clarify active code without changing identity.",
        codes: [{ kind: "existing" as const, codeId: taxonomy.revision.codes[0]!.codeId,
          label: "Incorrect answer", definition: "The final answer is substantively incorrect.",
          status: "active" as const }], idempotencyKey: "taxonomy-revision-2"
      };
      const revisionPair = await Promise.all([
        repository.createTaxonomyRevision(actors.owner, taxonomy.taxonomy.id, revisionInput),
        repository.createTaxonomyRevision(actors.owner, taxonomy.taxonomy.id, revisionInput)
      ]);
      expect(revisionPair.map((result) => result.replayed).sort()).toEqual([false, true]);
      await expect(repository.listTaxonomyRevisions(actors.owner, taxonomy.taxonomy.id, {
        limit: 10, cursor: cursor("sequence", "10001")
      })).rejects.toMatchObject({ code: "analysis_study_invalid_cursor" });
      const completedItem = await repository.appendStudyItemEvent(
        actors.member, first.study.study.id, item.item.id,
        { eventType: "coding_completed", expectedVersion: "1", idempotencyKey: "item-complete" }
      );
      expect(completedItem.item.state).toBe("completed");
      const coverage = await repository.getTaxonomyCoverage(
        actors.owner, first.study.study.id, taxonomy.revision.revision.id
      );
      expect(coverage).toMatchObject({
        projectId: actors.owner.projectId, activeFailureObservationCount: "1",
        categorized: "1", assignedToRetiredCode: "0", uncategorized: "0"
      });

      const closeInput = {
        expectedVersion: opened.event.version, reason: "Coding is complete.", idempotencyKey: "study-close"
      };
      const closedPair = await Promise.all([
        repository.closeStudy(actors.owner, first.study.study.id, closeInput),
        repository.closeStudy(actors.owner, first.study.study.id, closeInput)
      ]);
      expect(closedPair.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(new Set(closedPair.map((result) => result.event.id)).size).toBe(1);
      expect(new Set(closedPair.map((result) => result.study.closureDigest)).size).toBe(1);
      const closed = closedPair[0]!;
      expect(closed.study.state).toBe("coding_closed");
      const closureBeforeView = await repository.getStudy(actors.owner, first.study.study.id);
      expect(closureBeforeView!.summary).toMatchObject({ viewedItemCount: 0, completedItemCount: 1 });
      expect(closureBeforeView!.summary.closure).toMatchObject({
        viewedItemCount: 0, completedItemCount: 1,
        representativeOfPopulationId: population.population.id, representativeReason: null
      });

      const content = await repository.getStudyItemContent(actors.member, first.study.study.id, item.item.id);
      expect(content).toMatchObject({
        projectId: actors.owner.projectId, studyId: first.study.study.id,
        studyItemId: item.item.id, populationId: population.population.id
      });
      const view = await pool.query(
        `select counts_toward_closure from analysis_study_item_views where id=$1`,
        [content!.viewEventId]
      );
      expect(view.rows).toEqual([{ counts_toward_closure: false }]);
      const afterView = await repository.getStudy(actors.owner, first.study.study.id);
      expect(afterView!.summary.viewedItemCount).toBe(0);
      expect(afterView!.summary.closure!.viewedItemCount).toBe(0);

      const finished = await repository.completeStudy(actors.owner, first.study.study.id, {
        expectedVersion: closed.event.version,
        expectedClosureDigest: closed.study.closureDigest!, idempotencyKey: "study-complete"
      });
      expect(finished.study.state).toBe("completed");

      const historicalOpenReplay = await repository.openStudy(actors.owner, first.study.study.id, {
        expectedVersion: "0", stoppingRule: { kind: "explicit_owner_close", closeAt: null },
        idempotencyKey: "study-open"
      });
      expect(historicalOpenReplay).toMatchObject({ replayed: true, study: { state: "completed" },
        event: { id: opened.event.id, eventType: "coding_opened" } });
      const historicalItemReplay = await repository.appendStudyItemEvent(
        actors.member, first.study.study.id, item.item.id,
        { eventType: "failure_observed", expectedVersion: "0", failureLabel: "Incorrect answer",
          rationale: "The frozen output is incorrect.", evidenceAnchor: { kind: "case_output" },
          idempotencyKey: "observe-failure" }
      );
      expect(historicalItemReplay).toMatchObject({ replayed: true,
        item: { state: "completed", currentVersion: "2" }, event: { id: observed.event.id, version: "1" } });
    });
  });

  it("does not close another project's overdue study through a request-scoped lookup", async () => {
    await withSchema(async (pool, schema, testDatabaseUrl) => {
      const left = await seedProject(pool, "study_left");
      const right = await seedProject(pool, "study_right");
      await seedEligibleCase(pool, right.owner.projectId, "study_right");
      const populations = new PgAnalysisPopulationRepository(pool);
      const population = await populations.createPopulation(right.owner, {
        windowStart: "2026-01-01T00:00:00.000Z", windowEnd: "2026-02-01T00:00:00.000Z",
        fixedBudget: 1, idempotencyKey: "right-frame"
      });
      const repository = new PgAnalysisStudyRepository(pool);
      const study = await repository.createStudy(right.owner, {
        populationId: population.population.id, idempotencyKey: "right-study"
      });
      await repository.openStudy(right.owner, study.study.study.id, {
        expectedVersion: "0", stoppingRule: { kind: "server_deadline",
          closeAt: new Date(Date.now() + 2_000).toISOString() }, idempotencyKey: "right-open"
      });
      const taxonomy = await repository.createTaxonomy(right.owner, {
        name: "Right project taxonomy", description: "Must not be locked by another project.",
        reason: "Cross-project lock regression",
        codes: [{ kind: "new", clientToken: "right-code", label: "Right code", definition: "Right only." }],
        idempotencyKey: "right-taxonomy"
      });
      const revisionInput = {
        expectedPredecessorRevisionId: taxonomy.revision.revision.id,
        expectedPredecessorRevisionDigest: taxonomy.revision.revision.revisionDigest,
        expectedPredecessorSequence: 1,
        reason: "Foreign caller must fail before the taxonomy lock.",
        codes: [{ kind: "existing" as const, codeId: taxonomy.revision.codes[0]!.codeId,
          label: "Right code", definition: "Right only.", status: "active" as const }],
        idempotencyKey: "foreign-taxonomy-revision"
      };
      const blocker = await pool.connect();
      const guardedPool = new Pool({
        connectionString: testDatabaseUrl,
        options: `-c search_path=${schema} -c lock_timeout=250ms`
      });
      const guardedRepository = new PgAnalysisStudyRepository(guardedPool);
      await blocker.query("begin");
      await blocker.query(`select analysis_study_lock_v1($1)`, [study.study.study.id]);
      await blocker.query(`select analysis_taxonomy_lock_v1($1)`, [taxonomy.taxonomy.id]);
      const attempts = [
        guardedRepository.closeStudy(left.owner, study.study.study.id, {
          expectedVersion: "1", reason: "Foreign guessed study.", idempotencyKey: "foreign-study-close"
        }),
        guardedRepository.createTaxonomyRevision(left.owner, taxonomy.taxonomy.id, revisionInput)
      ];
      let quick: "settled" | "timeout";
      try {
        quick = await Promise.race([
          Promise.allSettled(attempts).then(() => "settled" as const),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500))
        ]);
      } finally {
        await blocker.query("rollback");
        blocker.release();
        await guardedPool.end();
      }
      const settled = await Promise.allSettled(attempts);
      expect(quick).toBe("settled");
      expect(settled).toEqual([
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "analysis_study_not_found" }) }),
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "analysis_taxonomy_not_found" }) })
      ]);
      await new Promise((resolve) => setTimeout(resolve, 2_050));

      await expect(repository.getStudy(left.owner, study.study.study.id)).resolves.toBeNull();
      const state = await pool.query(`select analysis_study_state_v1($1) state`, [study.study.study.id]);
      expect(state.rows[0].state).toBe("coding_open");
      expect(await repository.closeDueStudies(10)).toBe(1);
      const closed = await repository.getStudy(right.owner, study.study.study.id);
      expect(closed!.summary.study.state).toBe("coding_closed");
    });
  }, 15_000);

  it("commits deadline closure across trigger-time races, then returns typed conflicts or an excluded content view", async () => {
    await withSchema(async (pool) => {
      const mutation = await seedDeadlineStudy(pool, "deadline_mutation", 3_000);
      await pool.query(`
        create function analysis_test_delay_item_event() returns trigger language plpgsql as $$
        begin perform pg_sleep(3.5); return new; end $$;
        create trigger aaa_analysis_test_delay_item_event
          before insert on analysis_study_item_events
          for each row execute function analysis_test_delay_item_event()`);
      await expect(mutation.repository.appendStudyItemEvent(
        mutation.actors.member, mutation.study.study.study.id, mutation.item.item.id,
        { eventType: "no_failure_observed", expectedVersion: "0",
          rationale: "No failure in frozen evidence.", idempotencyKey: "deadline-race-item" }
      )).rejects.toMatchObject({ code: "analysis_study_state_conflict" });
      expect((await mutation.repository.getStudy(
        mutation.actors.owner, mutation.study.study.study.id
      ))!.summary.study.state).toBe("coding_closed");
      await pool.query(`drop trigger aaa_analysis_test_delay_item_event on analysis_study_item_events`);

      const content = await seedDeadlineStudy(pool, "deadline_content", 3_000);
      await pool.query(`
        create function analysis_test_delay_view() returns trigger language plpgsql as $$
        begin perform pg_sleep(3.5); return new; end $$;
        create trigger aaa_analysis_test_delay_view
          before insert on analysis_study_item_views
          for each row execute function analysis_test_delay_view()`);
      const viewed = await content.repository.getStudyItemContent(
        content.actors.member, content.study.study.study.id, content.item.item.id
      );
      expect(viewed).not.toBeNull();
      const view = await pool.query(`select counts_toward_closure from analysis_study_item_views where id=$1`, [viewed!.viewEventId]);
      expect(view.rows).toEqual([{ counts_toward_closure: false }]);
      expect((await content.repository.getStudy(
        content.actors.owner, content.study.study.study.id
      ))!.summary.closure!.viewedItemCount).toBe(0);
      await pool.query(`drop trigger aaa_analysis_test_delay_view on analysis_study_item_views`);

      const explicit = await seedDeadlineStudy(pool, "deadline_owner_close", 1_000);
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      await expect(explicit.repository.closeStudy(explicit.actors.owner, explicit.study.study.study.id, {
        expectedVersion: "1", reason: "Owner close arrived after deadline.",
        idempotencyKey: "late-owner-close"
      })).rejects.toMatchObject({ code: "analysis_study_state_conflict" });
      expect((await explicit.repository.getStudy(
        explicit.actors.owner, explicit.study.study.study.id
      ))!.summary.study.state).toBe("coding_closed");

      const healthy = await seedDeadlineStudy(pool, "deadline_backoff", 2_000);
      await seedEligibleCase(
        pool, healthy.actors.owner.projectId, "deadline_poisoned", "2026-03-10T12:00:00.123456Z"
      );
      const poisonedPopulation = await new PgAnalysisPopulationRepository(pool).createPopulation(
        healthy.actors.owner,
        { windowStart: "2026-03-01T00:00:00.000Z", windowEnd: "2026-04-01T00:00:00.000Z",
          fixedBudget: 1, idempotencyKey: "deadline-poisoned-frame" }
      );
      const poisonedStudy = await healthy.repository.createStudy(healthy.actors.owner, {
        populationId: poisonedPopulation.population.id, idempotencyKey: "deadline-poisoned-study"
      });
      await healthy.repository.openStudy(healthy.actors.owner, poisonedStudy.study.study.id, {
        expectedVersion: "0", stoppingRule: {
          kind: "server_deadline", closeAt: new Date(Date.now() + 1_500).toISOString()
        }, idempotencyKey: "deadline-poisoned-open"
      });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await pool.query(`create table analysis_test_poisoned_closure (study_id text primary key)`);
      await pool.query(`insert into analysis_test_poisoned_closure (study_id) values ($1)`, [poisonedStudy.study.study.id]);
      await pool.query(`
        create function analysis_test_reject_poisoned_closure() returns trigger language plpgsql as $$
        begin
          if exists (select 1 from analysis_test_poisoned_closure where study_id=new.study_id) then
            raise exception 'test poisoned closure' using errcode='23514';
          end if;
          return new;
        end $$;
        create trigger aaa_analysis_test_reject_poisoned_closure
          before insert on analysis_study_closures
          for each row execute function analysis_test_reject_poisoned_closure()`);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await healthy.repository.closeDueStudies(1)).toBe(0);
      expect(await healthy.repository.closeDueStudies(1)).toBe(1);
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith("analysis study deadline closure partial failure");
      error.mockRestore();
      const states = await pool.query(
        `select id,analysis_study_state_v1(id) state from analysis_studies where id=any($1::text[]) order by id`,
        [[poisonedStudy.study.study.id, healthy.study.study.study.id]]
      );
      expect(states.rows.map((row) => row.state).sort()).toEqual(["coding_closed", "coding_open"]);
      const retry = await pool.query(
        `select failure_count,last_error_code,next_retry_at>last_failed_at deferred
         from analysis_study_deadline_retry_state where study_id=$1`,
        [poisonedStudy.study.study.id]
      );
      expect(retry.rows).toEqual([{
        failure_count: 1, last_error_code: "closure_failed", deferred: true
      }]);
      const firstPage = await healthy.repository.listStudies(healthy.actors.owner, { limit: 1, cursor: null });
      expect(firstPage).toMatchObject({
        items: [], totalCount: "2", unavailableDueClosureCount: 1
      });
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await healthy.repository.listStudies(healthy.actors.owner, {
        limit: 1, cursor: firstPage.nextCursor
      });
      expect(secondPage).toMatchObject({
        totalCount: "2", unavailableDueClosureCount: 0,
        items: [{ study: { study: { id: healthy.study.study.study.id }, state: "coding_closed" } }]
      });
    });
  }, 30_000);
});
