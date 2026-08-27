import { describe, expect, it } from "vitest";
import { CreateSkillVersionInputSchema, type GoldenSetEntry } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

const PROJECT = "proj_langsmith_support";

async function createWorkingCollection(app: ReturnType<typeof createApp>) {
  const created = await app.request("/api/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Revision fixture ${Math.random()}` })
  });
  const datasetId = (await created.json() as { dataset: { id: string } }).dataset.id;
  const imported = await app.request(`/api/datasets/${datasetId}/examples`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{
      input: { question: "What is the refund window?" },
      output: { answer: "Thirty days." },
      expectedLabel: "pass",
      note: "reviewed example"
    }] })
  });
  expect(imported.status).toBe(201);
  return datasetId;
}

describe("immutable dataset revision routes", () => {
  it("returns an exact metadata-only item count without recording content exposure", async () => {
    class MetadataOnlyRepository extends DemoRepository {
      contentViewCalls = 0;

      override async recordDatasetRevisionContentView(input: Parameters<DemoRepository["recordDatasetRevisionContentView"]>[0]) {
        this.contentViewCalls += 1;
        return super.recordDatasetRevisionContentView(input);
      }
    }

    const repository = new MetadataOnlyRepository();
    const app = createApp(repository);
    const datasetId = await createWorkingCollection(app);
    const frozen = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "iterative_development", idempotencyKey: "metadata-count" })
    });
    const revision = (await frozen.json() as { revision: { id: string; itemCount: number } }).revision;

    const metadata = await app.request(`/api/dataset-revisions/${revision.id}/metadata`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      revision: { id: revision.id, itemCount: revision.itemCount }
    });
    expect(repository.contentViewCalls).toBe(0);
  });

  it("keeps analysis-population payloads and evaluator execution behind the dedicated Analyze boundary", async () => {
    class AnalysisPopulationBoundaryRepository extends DemoRepository {
      analysisRevisionId: string | null = null;
      contentViewCalls = 0;
      detailCalls = 0;

      override async listDatasetRevisions(projectId: string, sourceDatasetId?: string) {
        const revisions = await super.listDatasetRevisions(projectId, sourceDatasetId);
        return revisions.map((revision) => revision.id === this.analysisRevisionId
          ? { ...revision, sourceKind: "analysis_population" as const }
          : revision);
      }

      override async recordDatasetRevisionContentView(input: Parameters<DemoRepository["recordDatasetRevisionContentView"]>[0]) {
        this.contentViewCalls += 1;
        return super.recordDatasetRevisionContentView(input);
      }

      override async getDatasetRevisionDetail(projectId: string, revisionId: string) {
        this.detailCalls += 1;
        return super.getDatasetRevisionDetail(projectId, revisionId);
      }
    }

    const repository = new AnalysisPopulationBoundaryRepository();
    const app = createApp(repository);
    const datasetId = await createWorkingCollection(app);
    const frozen = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "analysis_authoring", idempotencyKey: "analysis-boundary" })
    });
    const revisionId = (await frozen.json() as { revision: { id: string } }).revision.id;
    repository.analysisRevisionId = revisionId;

    const ordinaryContent = await app.request(`/api/dataset-revisions/${revisionId}`);
    expect(ordinaryContent.status).toBe(403);
    await expect(ordinaryContent.json()).resolves.toMatchObject({
      code: "analysis_population_content_route_required"
    });
    expect(repository.contentViewCalls).toBe(0);
    expect(repository.detailCalls).toBe(0);

    const ordinaryEval = await app.request("/api/eval-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetRevisionId: revisionId })
    });
    expect(ordinaryEval.status).toBe(409);
    await expect(ordinaryEval.json()).resolves.toMatchObject({
      code: "analysis_population_eval_unavailable"
    });
    expect(repository.detailCalls).toBe(0);
  });

  it("freezes a stable revision while its working collection remains mutable", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const datasetId = await createWorkingCollection(app);

    const frozen = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "analysis_authoring", idempotencyKey: "fixture-v1" })
    });
    expect(frozen.status).toBe(201);
    const first = (await frozen.json() as { revision: { id: string; itemCount: number; revisionNumber: number; role: string; contentDigest: string } }).revision;
    expect(first).toMatchObject({ itemCount: 1, revisionNumber: 1, role: "analysis_authoring" });
    expect(first.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const retry = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "analysis_authoring", idempotencyKey: "fixture-v1" })
    });
    expect((await retry.json() as { revision: { id: string } }).revision.id).toBe(first.id);

    const added = await app.request(`/api/datasets/${datasetId}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{
        input: { question: "Can I cancel?" },
        output: { answer: "Yes." },
        expectedLabel: "pass"
      }] })
    });
    expect(added.status).toBe(201);

    const retained = await app.request(`/api/dataset-revisions/${first.id}`);
    expect(retained.status).toBe(200);
    const retainedRevision = (await retained.json() as { revision: { items: unknown[]; exposures: Array<{ kind: string }> } }).revision;
    expect(retainedRevision.items).toHaveLength(1);
    expect(retainedRevision.exposures.some((exposure) => exposure.kind === "human_access")).toBe(true);

    const listed = await app.request(`/api/datasets/${datasetId}/revisions`);
    const listing = await listed.json() as {
      collection: { itemCount: number; mutability: string };
      revisions: Array<{ id: string }>;
    };
    expect(listing.collection).toMatchObject({ itemCount: 2, mutability: "working_collection" });
    expect(listing.revisions.map((revision) => revision.id)).toContain(first.id);

    const successor = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "iterative_development", expectedParentRevisionId: first.id })
    });
    expect(successor.status).toBe(201);
    expect((await successor.json() as { revision: { parentRevisionId: string; revisionNumber: number; itemCount: number } }).revision)
      .toMatchObject({ parentRevisionId: first.id, revisionNumber: 2, itemCount: 2 });
  });

  it("rejects public sealed/regression claims and stale parent expectations", async () => {
    const app = createApp(new DemoRepository());
    const datasetId = await createWorkingCollection(app);
    const sealed = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "sealed_validation" })
    });
    expect(sealed.status).toBe(409);
    expect(await sealed.json()).toMatchObject({ code: "sealed_validation_unavailable" });

    const launderedRegression = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "regression_golden" })
    });
    expect(launderedRegression.status).toBe(409);
    expect(await launderedRegression.json()).toMatchObject({
      error: expect.stringContaining("only by promotion and retirement")
    });

    const stale = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "analysis_authoring", expectedParentRevisionId: "dsr_stale" })
    });
    expect(stale.status).toBe(409);
  });

  it("runs the frozen revision and records revision/item bindings plus development exposure", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const datasetId = await createWorkingCollection(app);
    const frozen = await app.request(`/api/datasets/${datasetId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "iterative_development" })
    });
    const revision = (await frozen.json() as { revision: { id: string; items: Array<{ id: string }> } }).revision;

    const started = await app.request("/api/eval-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetRevisionId: revision.id })
    });
    expect(started.status).toBe(202);
    const run = (await started.json() as {
      run: { id: string; datasetId: null; datasetRevisionId: string };
    }).run;
    expect(run.datasetId).toBeNull();
    expect(run.datasetRevisionId).toBe(revision.id);
    const runDetail = await app.request(`/api/eval-runs/${run.id}`);
    expect((await runDetail.json() as { items: Array<{ datasetRevisionItemId: string }> }).items
      .map((item) => item.datasetRevisionItemId)).toEqual([revision.items[0]!.id]);

    const detail = await repository.getDatasetRevisionDetail(PROJECT, revision.id);
    expect(detail?.exposures.some((event) =>
      event.kind === "development_use" && event.evidenceRefId === run.id
    )).toBe(true);

    await expect(repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: "skillv_1_2_0",
      trigger: "manual",
      datasetRevisionId: revision.id,
      items: [{ caseId: "case_wrong", datasetRevisionItemId: revision.items[0]!.id }]
    })).rejects.toThrow(/does not bind case/);
  });

  it("derives reviewed reference provenance in demo exactly as PostgreSQL does", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace(PROJECT, "manual", {
      sourceTraceId: "reviewed-provenance",
      input: { question: "Reviewed?" },
      output: { answer: "Yes." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId: imported.caseId,
      source: "human",
      actorUserId: "user_reviewer",
      payload: {
        kind: "categorical",
        choice: "pass",
        choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
        rationale: "Reviewed evidence"
      }
    });
    const dataset = await repository.createDataset({ projectId: PROJECT, name: "Reviewed provenance" });
    await repository.addDatasetItems({
      projectId: PROJECT,
      datasetId: dataset.id,
      items: [{ caseId: imported.caseId, expectedLabel: "pass" }]
    });
    const revision = await repository.createDatasetRevision({
      projectId: PROJECT,
      datasetId: dataset.id,
      role: "analysis_authoring"
    });
    expect(revision.items[0]?.referenceProvenance).toMatchObject({
      kind: "human_verdict",
      actorUserIds: ["user_reviewer"]
    });
    expect(revision.items[0]?.referenceProvenance.verdictIds).toHaveLength(1);
  });
});

describe("regression corpus pinning", () => {
  it("judges the revision pinned at version creation even if the live golden registry changes", async () => {
    class MutableGoldenRepository extends DemoRepository {
      empty = false;
      override async listGoldenSet(): Promise<GoldenSetEntry[]> {
        return this.empty ? [] : super.listGoldenSet();
      }
    }
    const repository = new MutableGoldenRepository();
    const skill = await repository.getCurrentSkill();
    const pending = await repository.createSkillVersionPending(
      skill.id,
      CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "Judge support quality.",
        prompt: "Judge the answer.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
      }),
      { projectId: PROJECT }
    );
    expect(pending.regressionDatasetRevisionId).toBeTruthy();
    repository.empty = true;

    const { regressionRun } = await repository.runRegressionGateForVersion({
      projectId: PROJECT,
      skillVersionId: pending.id,
      datasetRevisionId: pending.regressionDatasetRevisionId!,
      timeScope: "new"
    });
    expect(regressionRun.datasetRevisionId).toBe(pending.regressionDatasetRevisionId);
    expect(regressionRun.compared).toBe(2);
    expect(regressionRun.goldenSetMissing).toBe(false);
  });
});
