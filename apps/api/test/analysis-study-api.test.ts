import { describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_STUDY_CONTRACT_VERSION,
  type AnalysisStudyArtifact,
  type AnalysisStudyItemArtifact
} from "@coeval/shared";
import {
  analysisStudyContentDigest,
  analysisStudyEventDigest,
  analysisStudyItemContentDigest,
  applyAnalysisStudyEvent,
  initialAnalysisStudyItemProjection,
  initialAnalysisStudyProjection
} from "../src/lib/analysis-study.js";
import { createAnalysisStudyRouter } from "../src/analysis-study/routes.js";
import type { AnalysisStudyRepository } from "../src/analysis-study/repository.js";

const AT = "2026-08-20T12:00:00.000Z";
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

function study(populationId = "population_1") {
  const partial = {
    id: "study_1", projectId: "project_1", populationId, drawId: "draw_1",
    datasetRevisionId: "revision_1", contractVersion: ANALYSIS_STUDY_CONTRACT_VERSION,
    idempotencyKey: "create-1", requestDigest: D1,
    createdByUserId: "user_1", createdBySubjectId: "subject_1", createdAt: AT
  } as const;
  const artifact: AnalysisStudyArtifact = { ...partial, contentDigest: analysisStudyContentDigest(partial) };
  return initialAnalysisStudyProjection(artifact);
}

function item() {
  const partial = {
    studyId: "study_1", drawItemId: "draw_item_1", memberId: "member_1",
    revisionItemId: "revision_item_1", caseId: "case_1", position: 0
  } as const;
  const artifact: AnalysisStudyItemArtifact = {
    id: "study_item_1", projectId: "project_1", ...partial,
    contentDigest: analysisStudyItemContentDigest(partial), createdAt: AT
  };
  return initialAnalysisStudyItemProjection(artifact);
}

function repository(overrides: Partial<AnalysisStudyRepository> = {}): AnalysisStudyRepository {
  return new Proxy(overrides as AnalysisStudyRepository, {
    get(target, property) {
      if (property in target) return target[property as keyof AnalysisStudyRepository];
      return vi.fn(async () => null);
    }
  });
}

function router(repo: AnalysisStudyRepository | null, identity: { userId: string | null; apiKeyId?: string } = { userId: "user_1" }, role: "owner" | "member" | null = "owner") {
  return createAnalysisStudyRouter({
    repository: repo,
    databaseMode: true,
    requestIdentity: () => ({ projectId: "project_1", ...identity }),
    resolveProjectRole: async () => role
  });
}

describe("analysis study session boundary", () => {
  it("denies API keys, signed-out sessions, members creating studies, and demo mode before repository work", async () => {
    const createStudy = vi.fn();
    const repo = repository({ createStudy });
    const body = JSON.stringify({ populationId: "population_1", idempotencyKey: "create-1" });

    expect((await router(repo, { userId: "user_1", apiKeyId: "key_1" }).request("/", { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(401);
    expect((await router(repo, { userId: null }).request("/", { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(401);
    expect((await router(repo, { userId: "user_1" }, "member").request("/", { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(403);
    expect((await createAnalysisStudyRouter({
      repository: null, databaseMode: false,
      requestIdentity: () => ({ projectId: "project_1", userId: "user_1" }),
      resolveProjectRole: async () => "owner"
    }).request("/", { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(501);
    expect(createStudy).not.toHaveBeenCalled();
  });

  it("rejects a schema-valid create result bound to another population", async () => {
    const repo = repository({ createStudy: vi.fn(async () => ({ study: study("population_other"), reused: false })) });
    const response = await router(repo).request("/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ populationId: "population_1", idempotencyKey: "create-1" })
    });
    expect(response.status).toBe(500);
  });

  it("rejects a schema-valid transition result for the wrong command", async () => {
    const draft = study();
    const withoutDigest = {
      id: "event_open", projectId: "project_1", studyId: "study_1", version: "1",
      predecessorEventId: null, predecessorEventDigest: null,
      eventType: "coding_opened" as const, fromState: "draft" as const, toState: "coding_open" as const,
      stoppingRule: { kind: "explicit_owner_close" as const, closeAt: null }, closeCause: null,
      closureId: null, closureDigest: null, expectedClosureDigest: null, reason: null,
      actorUserId: "user_1", actorSubjectId: "subject_1", actorRole: "owner" as const,
      idempotencyKey: "open-1", requestDigest: D1, occurredAt: AT
    };
    const event = { ...withoutDigest, eventDigest: analysisStudyEventDigest(withoutDigest) };
    const repo = repository({
      abandonStudy: vi.fn(async () => ({ study: applyAnalysisStudyEvent(draft, event), event, replayed: false }))
    });
    const response = await router(repo).request("/study_1/abandon", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: "0", reason: "Stop this draft", idempotencyKey: "abandon-1" })
    });
    expect(response.status).toBe(500);
  });

  it("keeps metadata payload-free and records content only on the explicit item route", async () => {
    const projection = study();
    const itemProjection = item();
    const listStudyItems = vi.fn(async () => ({ items: [itemProjection], totalCount: 1, nextCursor: null }));
    const getStudyItem = vi.fn(async () => ({ study: projection, item: itemProjection }));
    const getStudyItemContent = vi.fn(async () => ({
      projectId: "project_1", studyId: "study_1", populationId: "population_1", drawId: "draw_1",
      datasetRevisionId: "revision_1", studyItemId: "study_item_1", drawItemId: "draw_item_1",
      memberId: "member_1", revisionItemId: "revision_item_1", caseId: "case_1", position: 0,
      inputDigest: D1, itemDigest: D2, viewEventId: "view_1", datasetExposureEventId: "exposure_1",
      payloadSnapshot: { input: { prompt: "hello" }, output: { answer: "world" }, metadata: {} }
    }));
    const app = router(repository({ listStudyItems, getStudyItem, getStudyItemContent }), { userId: "user_1" }, "member");

    expect((await app.request("/study_1/items?limit=50")).status).toBe(200);
    expect(getStudyItemContent).not.toHaveBeenCalled();
    const content = await app.request("/study_1/items/study_item_1/content");
    expect(content.status).toBe(200);
    expect(getStudyItemContent).toHaveBeenCalledTimes(1);
  });

  it("returns the server-resolved member role without delegating it to persistence", async () => {
    const repo = repository({
      listStudies: vi.fn(async () => ({
        items: [], totalCount: "0", unavailableDueClosureCount: 0, nextCursor: null
      }))
    });
    const response = await router(repo, { userId: "user_1" }, "member").request("/?limit=50");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ projectRole: "member" });
  });
});
