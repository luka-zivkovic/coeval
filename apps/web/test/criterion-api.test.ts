import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLangSmithIntegration,
  fetchCriteria,
  fetchCriterionDetail,
  fetchCurrentSkill,
  fetchDashboard,
  fetchDisagreements,
  fetchGoldenSet,
  fetchGoldenSetHealth,
  fetchJudgeHumanCalibration,
  fetchKappaSummary,
  fetchLatestSkill,
  fetchProjectVerdicts,
  fetchTrustDigest,
  importTrace,
  recordHumanVerdict,
  triggerLangSmithImport,
  updateLangSmithIntegration,
} from "../src/lib/api.js";

const criterion = {
  id: "criterion_correctness",
  projectId: "project_1",
  stableKey: "correctness",
  sourceKind: "native",
  createdByUserId: null,
  createdAt: "2026-08-23T00:00:00.000Z",
};

describe("criterion-scoped web API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads criterion inventory and immutable definition history", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ criteria: [criterion] }))
      .mockResolvedValueOnce(jsonResponse({
        criterion,
        versions: [{
          id: "criterionv_correctness_1",
          projectId: "project_1",
          criterionId: criterion.id,
          revision: 1,
          name: "Correctness",
          definition: "The response is factually correct.",
          criterionDigest: `sha256:${"a".repeat(64)}`,
          sourceKind: "native",
          createdByUserId: null,
          createdAt: "2026-08-23T00:00:00.000Z",
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCriteria()).resolves.toEqual([criterion]);
    await expect(fetchCriterionDetail(criterion.id)).resolves.toMatchObject({
      versions: [{ name: "Correctness", revision: 1 }],
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/criteria",
      "/api/v1/criteria/criterion_correctness",
    ]);
  });

  it("unwraps the criterion current-skill response without losing lineage", async () => {
    const skill = {
      id: "skill_correctness",
      projectId: "project_1",
      criterionId: criterion.id,
      name: "Correctness evaluator",
      description: "Judges correctness.",
      ownerName: "Owner",
      status: "approved",
      isStarter: false,
      currentVersion: {
        id: "skillv_correctness_3",
        skillId: "skill_correctness",
        criterionVersionId: "criterionv_correctness_1",
        version: "1.0.0",
        status: "approved",
        rubricMarkdown: "Pass when correct.",
        prompt: "Judge correctness.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
        outputSchema: { type: "object" },
        goldenSetAgreement: 1,
        tooStrictCount: 0,
        tooLenientCount: 0,
        ambiguousCount: 0,
        knownLimitations: [],
        verdictKind: "binary",
        scalarRange: null,
        categoricalChoiceScores: null,
        rubricProvenance: "human-authored",
        regressionDatasetRevisionId: "revision_correctness",
        createdAt: "2026-08-23T00:00:00.000Z",
        approvedAt: "2026-08-23T00:00:00.000Z",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ skill })));

    await expect(fetchCurrentSkill(criterion.id)).resolves.toMatchObject({
      criterionId: criterion.id,
      currentVersion: { criterionVersionId: "criterionv_correctness_1" },
    });
  });

  it("pins read surfaces to criterion or evaluator identity", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "fixture stop" }, 418));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.allSettled([
      fetchCurrentSkill("criterion_correctness"),
      fetchLatestSkill("criterion_correctness"),
      fetchDashboard("criterion_correctness"),
      fetchGoldenSet("criterionv_correctness_1"),
      fetchGoldenSetHealth("criterionv_correctness_1"),
      fetchKappaSummary("criterionv_correctness_1"),
      fetchDisagreements("criterionv_correctness_1"),
      fetchJudgeHumanCalibration("criterionv_correctness_1"),
      fetchProjectVerdicts({ criterionId: "criterion_correctness" }),
      fetchTrustDigest("skillv_correctness_3"),
    ]);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/criteria/criterion_correctness/current-skill",
      "/api/v1/criteria/criterion_correctness/current-skill?scope=latest",
      "/api/dashboard?criterionId=criterion_correctness",
      "/api/golden-set?criterionVersionId=criterionv_correctness_1",
      "/api/golden-set/health?criterionVersionId=criterionv_correctness_1",
      "/api/projects/kappa?criterionVersionId=criterionv_correctness_1",
      "/api/projects/disagreements?criterionVersionId=criterionv_correctness_1",
      "/api/projects/judge-human-calibration?criterionVersionId=criterionv_correctness_1",
      "/api/projects/verdicts?criterionId=criterion_correctness",
      "/api/trust-digest?skillVersionId=skillv_correctness_3",
    ]);
  });

  it("pins manual, integration, and human-review writes to an evaluator version", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "fixture stop" }, 418));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.allSettled([
      createLangSmithIntegration({ apiKey: "secret", skillVersionId: "skillv_correctness_3" }),
      updateLangSmithIntegration("integration_1", { skillVersionId: "skillv_correctness_3" }),
      importTrace({ input: { q: 1 }, output: { a: 1 }, skillVersionId: "skillv_correctness_3" }),
      triggerLangSmithImport("integration_1", 25, "skillv_correctness_3"),
      recordHumanVerdict(
        "case_1",
        { kind: "binary", pass: true, rationale: "Correct for this criterion." },
        "skillv_correctness_3",
      ),
    ]);

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies).toEqual([
      expect.objectContaining({ skillVersionId: "skillv_correctness_3" }),
      { skillVersionId: "skillv_correctness_3" },
      expect.objectContaining({ skillVersionId: "skillv_correctness_3" }),
      { skillVersionId: "skillv_correctness_3", limit: 25 },
      expect.objectContaining({ skillVersionId: "skillv_correctness_3" }),
    ]);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
