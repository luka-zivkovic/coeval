import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { registerDatasetAdministrationRoutes } from "../src/routes/dataset-administration.js";

describe("dataset administration routes", () => {
  it("owns the exact contiguous dataset-administration route family", () => {
    const repository = new DemoRepository();
    const app = new Hono<{ Variables: AppVariables }>();
    registerDatasetAdministrationRoutes(app, {
      repository,
      requestServices: createRequestServices({
        repository,
        ownerAuthorizationEnabled: false,
        rateLimitPerMinute: 60,
        batchMaxItems: 100
      })
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/datasets",
      "POST /api/datasets",
      "GET /api/datasets/:datasetId",
      "GET /api/datasets/:datasetId/revisions",
      "POST /api/datasets/:datasetId/revisions",
      "GET /api/dataset-revisions/:revisionId/metadata",
      "GET /api/dataset-revisions/:revisionId",
      "POST /api/datasets/:datasetId/items",
      "POST /api/datasets/:datasetId/examples",
      "DELETE /api/datasets/:datasetId/items/:itemId",
      "POST /api/datasets/:datasetId/archive"
    ]);
  });
});

describe("datasets", () => {
  const projectId = "proj_langsmith_support";

  async function importCase(repository: DemoRepository, sourceTraceId: string): Promise<string> {
    const imported = await repository.importTrace(projectId, "manual", {
      sourceTraceId,
      input: { question: `q for ${sourceTraceId}` },
      output: { answer: "a" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    return imported.caseId;
  }

  it("creates a dataset, adds items, and reads the detail back", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const caseA = await importCase(repository, "ds_case_a");

    const create = await localApp.request("/api/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Checkout regressions", description: "Cases from the checkout incident" })
    });
    expect(create.status).toBe(201);
    const { dataset } = (await create.json()) as { dataset: { id: string; kind: string; itemCount: number } };
    expect(dataset.kind).toBe("custom");
    expect(dataset.itemCount).toBe(0);

    // One imported case + one demo exception case; expectedLabel optional.
    const add = await localApp.request(`/api/datasets/${dataset.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: caseA, expectedLabel: "pass" },
          { caseId: "case_exc_001", note: "known judge miss" }
        ]
      })
    });
    expect(add.status).toBe(201);
    const { items } = (await add.json()) as { items: Array<{ caseId: string; expectedLabel: string | null }> };
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.caseId).sort()).toEqual([caseA, "case_exc_001"].sort());
    expect(items.find((item) => item.caseId === caseA)?.expectedLabel).toBe("pass");

    const detail = await localApp.request(`/api/datasets/${dataset.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { itemCount: number; items: unknown[] };
    expect(detailBody.itemCount).toBe(2);
    expect(detailBody.items).toHaveLength(2);

    const list = await localApp.request("/api/datasets");
    const listBody = (await list.json()) as { datasets: Array<{ itemCount: number }> };
    expect(listBody.datasets).toHaveLength(1);
    expect(listBody.datasets[0]?.itemCount).toBe(2);
  });

  it("re-adding a case is idempotent, unknown cases reject the whole batch", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const caseA = await importCase(repository, "ds_case_idem");
    const dataset = await repository.createDataset({ projectId, name: "Idempotency" });

    await repository.addDatasetItems({ projectId, datasetId: dataset.id, items: [{ caseId: caseA }] });
    const again = await repository.addDatasetItems({ projectId, datasetId: dataset.id, items: [{ caseId: caseA }] });
    expect(again).toHaveLength(1);

    const badBatch = await localApp.request(`/api/datasets/${dataset.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_exc_001" }, { caseId: "case_does_not_exist" }] })
    });
    expect(badBatch.status).toBe(400);
    // All-or-nothing: the valid case in the failed batch was not inserted.
    const detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(1);
  });

  it("enforces one active dataset per name; archiving frees the name", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    const first = await repository.createDataset({ projectId, name: "Nightly" });
    const duplicate = await localApp.request("/api/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nightly" })
    });
    expect(duplicate.status).toBe(409);

    const archive = await localApp.request(`/api/datasets/${first.id}/archive`, { method: "POST" });
    expect(archive.status).toBe(200);
    // Archived datasets drop out of the list but stay readable by id.
    const listed = (await (await localApp.request("/api/datasets")).json()) as { datasets: unknown[] };
    expect(listed.datasets).toHaveLength(0);
    expect((await localApp.request(`/api/datasets/${first.id}`)).status).toBe(200);
    // Re-archive is a 404 (nothing active matched), and the name is free again.
    expect((await localApp.request(`/api/datasets/${first.id}/archive`, { method: "POST" })).status).toBe(404);
    const reuse = await localApp.request("/api/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nightly" })
    });
    expect(reuse.status).toBe(201);
  });

  it("removes items and 404s on misses, archived datasets reject new items", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Removal" });
    const items = await repository.addDatasetItems({
      projectId,
      datasetId: dataset.id,
      items: [{ caseId: "case_exc_001" }]
    });

    const remove = await localApp.request(`/api/datasets/${dataset.id}/items/${items[0]!.id}`, { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect((await localApp.request(`/api/datasets/${dataset.id}/items/${items[0]!.id}`, { method: "DELETE" })).status).toBe(404);

    await repository.archiveDataset(projectId, dataset.id);
    const addToArchived = await localApp.request(`/api/datasets/${dataset.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_exc_001" }] })
    });
    expect(addToArchived.status).toBe(404);
  });
});

describe("dataset examples (Skill Bench ingestion)", () => {
  const projectId = "proj_langsmith_support";

  it("imports pasted examples: mints cases, sets labels, never auto-judges", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Bench examples" });

    const response = await localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { input: "Where is my refund??", output: "Can't help.", expectedLabel: "fail", name: "angry-refund" },
          { input: "Thanks, that fixed it!", output: "Glad to hear it." }
        ]
      })
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      items: Array<{ caseId: string; datasetItemId: string | null; created: boolean }>;
      reusedCount: number;
      skippedCount: number;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.created && item.datasetItemId)).toBe(true);
    expect(body.reusedCount).toBe(0);

    const detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(2);
    const labeled = detail?.items.find((item) => item.expectedLabel === "fail");
    expect(labeled).toBeDefined();

    // No judge verdicts anywhere — bench ingestion never auto-judges.
    for (const item of body.items) {
      const verdicts = await repository.listVerdicts({ projectId, caseId: item.caseId, source: "llm_judge", limit: 5 });
      expect(verdicts).toHaveLength(0);
    }
  });

  it("T2: pass-clears-step upsert invariant on dataset examples", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Step expectations" });
    const post = (items: unknown[]) => localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    const EXAMPLE = {
      input: "trajectory q",
      output: "trajectory a",
      steps: [
        { name: "s0", input: 0, output: 0 },
        { name: "s1", input: 1, output: 1 }
      ]
    };

    // fail + step stores both.
    const first = await post([{ ...EXAMPLE, expectedLabel: "fail", expectedFailStep: 1 }]);
    expect(first.status).toBe(201);
    let detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items[0]).toMatchObject({ expectedLabel: "fail", expectedFailStep: 1 });

    // fail→fail WITHOUT a step keeps the stored step.
    await post([{ ...EXAMPLE, expectedLabel: "fail" }]);
    detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items[0]).toMatchObject({ expectedLabel: "fail", expectedFailStep: 1 });

    // Re-label to pass CLEARS the stored step.
    await post([{ ...EXAMPLE, expectedLabel: "pass" }]);
    detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items[0]).toMatchObject({ expectedLabel: "pass", expectedFailStep: null });

    // Examples route rejects the same cross-field rules as the batch route.
    const invalid = await post([{ ...EXAMPLE, expectedLabel: "fail", expectedFailStep: 2 }]);
    expect(invalid.status).toBe(400);
  });

  it("T4: case detail lists every dataset's expectation by name", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const first = await repository.createDataset({ projectId, name: "Traj set A" });
    const second = await repository.createDataset({ projectId, name: "Traj set B" });
    const EXAMPLE = {
      input: "traj input",
      output: "This is incorrect.",
      steps: [
        { name: "s0", input: 0, output: 0 },
        { name: "s1", input: 1, output: "wrong step" }
      ]
    };
    const post = (datasetId: string, items: unknown[]) => localApp.request(`/api/datasets/${datasetId}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    const firstRes = await post(first.id, [{ ...EXAMPLE, expectedLabel: "fail", expectedFailStep: 1 }]);
    const firstBody = (await firstRes.json()) as { items: Array<{ caseId: string }> };
    const caseId = firstBody.items[0]!.caseId;
    await post(second.id, [{ ...EXAMPLE, expectedLabel: "fail" }]);

    // A judged case is required for case detail — run an eval over dataset A.
    await localApp.request("/api/eval-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId: first.id })
    });

    const detailRes = await localApp.request(`/api/cases/${caseId}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      trace: { steps?: unknown[] };
      datasetExpectations: Array<{ datasetName: string; expectedLabel: string | null; expectedFailStep: number | null }>;
    };
    expect(detail.trace.steps).toHaveLength(2);
    expect(detail.datasetExpectations).toEqual([
      { datasetName: "Traj set A", expectedLabel: "fail", expectedFailStep: 1 },
      { datasetName: "Traj set B", expectedLabel: "fail", expectedFailStep: null }
    ]);
  });

  it("content-hash dedup: unchanged re-paste reuses the case, an edit mints a new one; labels upsert", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Bench dedup" });
    const post = (items: unknown[]) => localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });

    const first = await post([{ input: "q1", output: "a1", expectedLabel: "pass" }]);
    const firstBody = (await first.json()) as { items: Array<{ caseId: string }>; reusedCount: number };

    // Identical content → same case, reused, label flipped by the upsert.
    const again = await post([{ input: "q1", output: "a1", expectedLabel: "fail" }]);
    const againBody = (await again.json()) as { items: Array<{ caseId: string; created: boolean }>; reusedCount: number };
    expect(againBody.reusedCount).toBe(1);
    expect(againBody.items[0]?.caseId).toBe(firstBody.items[0]?.caseId);
    expect(againBody.items[0]?.created).toBe(false);

    // Label-less re-add must NOT null the stored label.
    await post([{ input: "q1", output: "a1" }]);
    let detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0]?.expectedLabel).toBe("fail");

    // Within one batch: a label-less duplicate of identical content must not
    // erase the labeled occurrence (last-labeled-wins coalescing).
    await post([{ input: "q2", output: "a2", expectedLabel: "pass" }, { input: "q2", output: "a2" }]);
    const withDup = await repository.getDatasetDetail(projectId, dataset.id);
    expect(withDup?.items.find((item) => item.expectedLabel === "pass")).toBeDefined();
    expect(withDup?.items).toHaveLength(2);

    // steps join the content hash only when present — a step-less
    // example keeps its pre-M2 case; the same input/output WITH steps is a
    // different case; identical steps re-paste is a reuse; an edited step
    // mints a fresh case.
    const stepped = await post([{
      input: "q1", output: "a1",
      steps: [{ name: "lookup", input: { order: 1 }, output: { found: true } }],
      expectedLabel: "pass"
    }]);
    const steppedBody = (await stepped.json()) as { items: Array<{ caseId: string; created: boolean }> };
    expect(steppedBody.items[0]?.created).toBe(true);
    expect(steppedBody.items[0]?.caseId).not.toBe(firstBody.items[0]?.caseId);

    const steppedAgain = await post([{
      input: "q1", output: "a1",
      steps: [{ name: "lookup", input: { order: 1 }, output: { found: true } }]
    }]);
    const steppedAgainBody = (await steppedAgain.json()) as { items: Array<{ caseId: string; created: boolean }>; reusedCount: number };
    expect(steppedAgainBody.items[0]?.created).toBe(false);
    expect(steppedAgainBody.items[0]?.caseId).toBe(steppedBody.items[0]?.caseId);

    const steppedEdited = await post([{
      input: "q1", output: "a1",
      steps: [{ name: "lookup", input: { order: 2 }, output: { found: true } }]
    }]);
    const steppedEditedBody = (await steppedEdited.json()) as { items: Array<{ caseId: string; created: boolean }> };
    expect(steppedEditedBody.items[0]?.created).toBe(true);
    expect(steppedEditedBody.items[0]?.caseId).not.toBe(steppedBody.items[0]?.caseId);

    // Edited content → a fresh case (the stale-payload dedup trap).
    const edited = await post([{ input: "q1", output: "a1 — corrected", expectedLabel: "pass" }]);
    const editedBody = (await edited.json()) as { items: Array<{ caseId: string; created: boolean }>; reusedCount: number };
    expect(editedBody.items[0]?.created).toBe(true);
    expect(editedBody.items[0]?.caseId).not.toBe(firstBody.items[0]?.caseId);
    detail = await repository.getDatasetDetail(projectId, dataset.id);
    // q1 + q2 + the edited q1 variant + the two stepped q1 variants.
    expect(detail?.items).toHaveLength(5);
  });

  it("rolls back everything when ingestion fails mid-flow — no orphaned cases (C2)", async () => {
    class FailingRepository extends DemoRepository {
      private addCalls = 0;
      override async addDatasetItems(...args: Parameters<DemoRepository["addDatasetItems"]>): ReturnType<DemoRepository["addDatasetItems"]> {
        this.addCalls += 1;
        if (this.addCalls === 2) throw new Error("induced mid-flow failure");
        return super.addDatasetItems(...args);
      }
    }
    const repository = new FailingRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Atomicity" });
    const items = [
      { input: "q-atomic-1", output: "a1", expectedLabel: "pass" },
      { input: "q-atomic-2", output: "a2", expectedLabel: "fail" }
    ];

    const failed = await localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    expect(failed.status).toBe(500);

    // Nothing half-landed: the dataset is empty AND the first item's case was
    // rolled back too — a clean retry mints BOTH cases fresh (created: true;
    // a leaked case would come back created: false / reused).
    const detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(0);
    const retry = await localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    expect(retry.status).toBe(201);
    const retryBody = (await retry.json()) as { items: Array<{ created: boolean }>; reusedCount: number };
    expect(retryBody.items.every((item) => item.created)).toBe(true);
    expect(retryBody.reusedCount).toBe(0);
  });

  it("404s on a missing dataset without minting cases", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const before = (await repository.listProjects())[0]?.importedTraceCount ?? 0;
    const response = await localApp.request("/api/datasets/ds_missing/examples", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ input: "q", output: "a" }] })
    });
    expect(response.status).toBe(404);
    const after = (await repository.listProjects())[0]?.importedTraceCount ?? 0;
    expect(after).toBe(before);
  });
});
