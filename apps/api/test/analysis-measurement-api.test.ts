import { describe, expect, it, vi } from "vitest";
import type { AnalysisWorkflowMeasurementReport } from "@coeval/shared";
import { createAnalysisMeasurementRouter } from "../src/analysis-measurement/routes.js";
import type { AnalysisMeasurementRepository } from "../src/analysis-measurement/repository.js";
import { analysisWorkflowMeasurementReportDigest } from "../src/lib/analysis-measurement.js";

function report(overrides: Partial<AnalysisWorkflowMeasurementReport> = {}): AnalysisWorkflowMeasurementReport {
  const content = {
    contractVersion: "coeval/analysis-workflow-measurement/v1" as const,
    calculationVersion: "analysis-workflow-components/v1" as const,
    projectId: "project",
    studyId: "study",
    populationId: "population",
    drawId: "draw",
    datasetRevisionId: "revision",
    studyCreatedAt: "2026-08-24T00:00:00.000Z",
    studyState: "coding_open" as const,
    coding: {
      selectedItemCount: 1,
      viewedItemCount: 0,
      inProgressItemCount: 0,
      completedItemCount: 0,
      noFailureObservedItemCount: 0,
      missingItemCount: 1
    },
    taxonomy: { state: "not_requested" as const },
    evaluatorOptions: [],
    evaluator: null
  };
  const exact = { ...content, ...overrides };
  const { reportDigest: _digest, calculatedAt: _time, ...digestContent } = exact as AnalysisWorkflowMeasurementReport;
  return {
    ...exact,
    reportDigest: overrides.reportDigest ?? analysisWorkflowMeasurementReportDigest(digestContent),
    calculatedAt: overrides.calculatedAt ?? "2026-08-24T01:00:00.000Z"
  } as AnalysisWorkflowMeasurementReport;
}

function repository(value: AnalysisWorkflowMeasurementReport | null = report()): AnalysisMeasurementRepository {
  return { getReport: vi.fn(async () => value) };
}

function router(repo: AnalysisMeasurementRepository | null, input: {
  userId?: string | null;
  apiKeyId?: string;
  role?: "owner" | "member" | null;
  projectId?: string;
  databaseMode?: boolean;
} = {}) {
  return createAnalysisMeasurementRouter({
    repository: repo,
    databaseMode: input.databaseMode ?? true,
    requestIdentity: () => ({
      userId: input.userId === undefined ? "member" : input.userId,
      projectId: input.projectId ?? "project",
      apiKeyId: input.apiKeyId
    }),
    resolveProjectRole: async () => input.role === undefined ? "member" : input.role
  });
}

describe("analysis measurement API boundary", () => {
  it("requires database-backed project-member sessions and permits member reads", async () => {
    const demo = router(null, { databaseMode: false });
    expect((await demo.request("/study")).status).toBe(501);
    const repo = repository();
    expect((await router(repo, { userId: null }).request("/study")).status).toBe(401);
    expect((await router(repo, { userId: null, apiKeyId: "key" }).request("/study")).status).toBe(401);
    expect((await router(repo, { role: null }).request("/study")).status).toBe(403);
    const response = await router(repo).request("/study");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(repo.getReport).toHaveBeenCalledWith(expect.objectContaining({ projectRole: "member" }), "study", {
      taxonomyRevisionId: null,
      skillVersionId: null,
      calibrationArtifactId: null
    });
  });

  it("rejects unknown query fields and artifact-without-evaluator before repository access", async () => {
    const repo = repository();
    expect((await router(repo).request("/study?threshold=0.9")).status).toBe(400);
    expect((await router(repo).request("/study?calibrationArtifactId=artifact")).status).toBe(400);
    expect(repo.getReport).not.toHaveBeenCalled();
  });

  it("fails closed on a schema-valid cross-project report", async () => {
    const repo = repository(report({ projectId: "other" }));
    expect((await router(repo).request("/study")).status).toBe(500);
  });

  it("fails closed on a schema-valid report with a stale semantic digest", async () => {
    const repo = repository(report({ reportDigest: `sha256:${"f".repeat(64)}` }));
    expect((await router(repo).request("/study")).status).toBe(500);
  });

  it("binds each optional taxonomy, evaluator, and artifact identity", async () => {
    const repo = repository(report());
    expect((await router(repo).request(
      "/study?taxonomyRevisionId=taxonomy&skillVersionId=version&calibrationArtifactId=artifact"
    )).status).toBe(500);
  });
});
