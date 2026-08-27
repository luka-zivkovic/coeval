import { Hono } from "hono";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  AnalysisPopulationSummarySchema,
  type AnalysisPopulationCreateInput,
  type AnalysisPopulationSummary
} from "@coeval/shared";
import { createAnalysisPopulationRouter } from "../src/analysis-population/routes.js";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import {
  AnalysisPopulationRepositoryError,
  type AnalysisPopulationAccess,
  type AnalysisPopulationActor,
  type AnalysisPopulationPageInput,
  type AnalysisPopulationRepository
} from "../src/analysis-population/repository.js";

const PROJECT_ID = "project_analysis";
const CREATED_AT = "2026-08-23T00:00:00.000Z";
const DIGEST = `sha256:${"1".repeat(64)}`;
const JSON_HEADERS = { "content-type": "application/json" };
const OWNER_HEADERS = { "x-test-user": "owner", "x-test-project": PROJECT_ID };
const MEMBER_HEADERS = { "x-test-user": "member", "x-test-project": PROJECT_ID };

function summary(populationId = "population_1"): AnalysisPopulationSummary {
  return AnalysisPopulationSummarySchema.parse({
    population: {
      id: populationId,
      projectId: PROJECT_ID,
      datasetRevisionId: "revision_1",
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-02T00:00:00.000Z",
      eligibleSources: ["manual", "langsmith", "langfuse", "ironside"],
      eligibleIngestionPurposes: [
        "analysis_eligible_manual",
        "analysis_eligible_langsmith",
        "analysis_eligible_langfuse",
        "analysis_eligible_ironside"
      ],
      canonicalizationVersion: "governed-content-json/v1" as const,
      orderingVersion: "cases-created-at-id/v1" as const,
      populationSize: 1,
      exclusionCount: "0",
      frameDigest: DIGEST,
      contentDigest: DIGEST,
      snapshotXid8: "100:100:",
      snapshotTakenAt: CREATED_AT,
      createdByUserId: "owner",
      createdBySubjectId: "subject_owner",
      createdAt: CREATED_AT
    },
    draw: {
      id: "draw_1",
      projectId: PROJECT_ID,
      populationId,
      datasetRevisionId: "revision_1",
      method: "simple_random" as const,
      stoppingRule: "fixed" as const,
      drawExecutor: "coeval_server" as const,
      seed: "00".repeat(32),
      rngVersion: "sha256-rank/v1" as const,
      algorithmVersion: "coeval-analysis-draw/v1" as const,
      fixedBudget: 1,
      populationSize: 1,
      inclusionProbability: { numerator: 1, denominator: 1 },
      drawDigest: DIGEST,
      contentDigest: DIGEST,
      executedBySubjectId: "subject_owner",
      executedAt: CREATED_AT
    },
    claim: {
      drawnFromPopulationId: populationId,
      representativeOfPopulationId: null,
      representativeReason: "coding_not_complete" as const
    }
  });
}

class FakeAnalysisPopulationRepository implements AnalysisPopulationRepository {
  readonly calls: string[] = [];
  error: AnalysisPopulationRepositoryError | null = null;
  wrongPath = false;

  async createPopulation(actor: AnalysisPopulationActor, _input: AnalysisPopulationCreateInput) {
    this.record("create", actor);
    return { ...summary(), reusedPopulation: false, reusedDraw: false };
  }
  async listPopulations(access: AnalysisPopulationAccess, page: AnalysisPopulationPageInput) {
    this.record("list", { access, page });
    return { items: [summary()], totalCount: "1", nextCursor: null };
  }
  async getPopulation(access: AnalysisPopulationAccess, populationId: string) {
    this.record("detail", { access, populationId });
    return { ...summary(this.wrongPath ? "other_population" : populationId), overlapCount: "0" };
  }
  async listMembers(access: AnalysisPopulationAccess, populationId: string) {
    this.record("members", { access, populationId });
    return { items: [], totalCount: 0, nextCursor: null };
  }
  async listSelections(access: AnalysisPopulationAccess, populationId: string) {
    this.record("selections", { access, populationId });
    return { items: [], totalCount: 1, nextCursor: null };
  }
  async listExclusions(access: AnalysisPopulationAccess, populationId: string) {
    this.record("exclusions", { access, populationId });
    return { items: [], totalCount: "0", nextCursor: null };
  }
  async listOverlaps(access: AnalysisPopulationAccess, populationId: string) {
    this.record("overlaps", { access, populationId });
    return { items: [], totalCount: "0", nextCursor: null };
  }
  async getSelectedContent(access: AnalysisPopulationAccess, populationId: string, drawPosition: number) {
    this.record("content", { access, populationId, drawPosition });
    return {
      populationId: this.wrongPath ? "other_population" : populationId,
      datasetRevisionId: "revision_1",
      memberId: "member_1",
      revisionItemId: "revision_item_1",
      caseId: "case_1",
      drawPosition,
      inputDigest: DIGEST,
      itemDigest: DIGEST,
      payloadSnapshot: { input: { q: 1 }, output: { a: 1 }, metadata: {} }
    };
  }
  private record(method: string, value: unknown): void {
    this.calls.push(method);
    if (this.error) throw this.error;
    void value;
  }
}

function testApp(input: { repository?: FakeAnalysisPopulationRepository | null; databaseMode?: boolean } = {}) {
  const repository = input.repository === undefined ? new FakeAnalysisPopulationRepository() : input.repository;
  const app = new Hono();
  app.onError(() => new Response("Internal Server Error", { status: 500 }));
  app.route("/api/analysis-populations", createAnalysisPopulationRouter({
    repository,
    databaseMode: input.databaseMode ?? true,
    requestIdentity: (c) => ({
      userId: c.req.header("x-test-user") ?? null,
      projectId: c.req.header("x-test-project") ?? "",
      ...(c.req.header("x-test-api-key") ? { apiKeyId: c.req.header("x-test-api-key") } : {})
    }),
    resolveProjectRole: async ({ userId }) =>
      userId === "owner" ? "owner" : userId === "member" ? "member" : null
  }));
  return { app, repository };
}

function membershipPool(): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("select role from project_members")) {
        const matches = values[0] === "owner" && values[1] === PROJECT_ID;
        return { rows: matches ? [{ role: "owner" }] : [], rowCount: matches ? 1 : 0 };
      }
      if (sql.includes("select project_id from project_members")) {
        const matches = values[0] === "owner";
        return { rows: matches ? [{ project_id: PROJECT_ID }] : [], rowCount: matches ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as Pool;
}

const createInput = {
  windowStart: "2026-08-01T00:00:00.000Z",
  windowEnd: "2026-08-02T00:00:00.000Z",
  fixedBudget: 1,
  idempotencyKey: "freeze-1"
};

describe("analysis population session API", () => {
  it("mounts after the full application session/project boundary and stays unavailable in demo mode", async () => {
    const repository = new FakeAnalysisPopulationRepository();
    const app = createApp(new DemoRepository(), {
      pool: membershipPool(),
      auth: {
        api: {
          getSession: async () => ({
            user: { id: "owner", email: "owner@example.test", name: "Owner" },
            session: { id: "session_analysis" }
          })
        }
      } as never,
      analysisPopulationRepository: repository
    });
    const list = await app.request("/api/analysis-populations", {
      headers: { "x-coeval-project": PROJECT_ID }
    });
    expect(list.status).toBe(200);
    expect(repository.calls).toEqual(["list"]);

    const demo = await createApp(new DemoRepository()).request("/api/analysis-populations");
    expect(demo.status).toBe(501);
    await expect(demo.json()).resolves.toMatchObject({
      code: "analysis_population_database_required"
    });
  });

  it("allows owner creation and member metadata/content reads while rejecting non-session and demo paths", async () => {
    const { app, repository } = testApp();
    const created = await app.request("/api/analysis-populations", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...OWNER_HEADERS },
      body: JSON.stringify(createInput)
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { result: { claim: { representativeOfPopulationId: null } } })
      .result.claim.representativeOfPopulationId).toBeNull();

    const memberCreate = await app.request("/api/analysis-populations", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify(createInput)
    });
    expect(memberCreate.status).toBe(403);
    const list = await app.request("/api/analysis-populations", { headers: MEMBER_HEADERS });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { page: { totalCount: string } }).page.totalCount).toBe("1");
    const content = await app.request(
      "/api/analysis-populations/population_1/selections/0/content",
      { headers: MEMBER_HEADERS }
    );
    expect(content.status).toBe(200);
    expect(repository?.calls).toContain("content");

    const signedOut = await app.request("/api/analysis-populations");
    expect(signedOut.status).toBe(401);
    const apiKey = await app.request("/api/analysis-populations", {
      headers: { ...OWNER_HEADERS, "x-test-api-key": "key_1" }
    });
    expect(apiKey.status).toBe(401);
    const demo = testApp({ repository: null, databaseMode: false });
    expect((await demo.app.request("/api/analysis-populations", { headers: OWNER_HEADERS })).status).toBe(501);
  });

  it("rejects caller-owned evidence fields, maps typed cursor errors, and fails closed on path/result swaps", async () => {
    const { app, repository } = testApp();
    const injected = await app.request("/api/analysis-populations", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...OWNER_HEADERS },
      body: JSON.stringify({ ...createInput, seed: "00".repeat(32) })
    });
    expect(injected.status).toBe(400);

    repository!.error = new AnalysisPopulationRepositoryError(
      "analysis_population_invalid_cursor",
      "Invalid population cursor"
    );
    const cursor = await app.request("/api/analysis-populations?cursor=bounded-but-invalid", {
      headers: OWNER_HEADERS
    });
    expect(cursor.status).toBe(400);
    repository!.error = null;
    const nonDecimalPosition = await app.request(
      "/api/analysis-populations/population_1/selections/0x10/content",
      { headers: OWNER_HEADERS }
    );
    expect(nonDecimalPosition.status).toBe(400);

    repository!.error = new AnalysisPopulationRepositoryError(
      "analysis_population_budget_invalid",
      "Budget exceeds the exact frame",
      { limit: 1, observed: 2 }
    );
    const invalidBudget = await app.request("/api/analysis-populations", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...OWNER_HEADERS },
      body: JSON.stringify(createInput)
    });
    expect(invalidBudget.status).toBe(400);
    repository!.error = null;
    repository!.wrongPath = true;
    const detail = await app.request("/api/analysis-populations/population_1", { headers: OWNER_HEADERS });
    expect(detail.status).toBe(500);
    const content = await app.request(
      "/api/analysis-populations/population_1/selections/0/content",
      { headers: OWNER_HEADERS }
    );
    expect(content.status).toBe(500);
  });
});
