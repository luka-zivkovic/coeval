import { describe, expect, it } from "vitest";
import {
  CaseSourceSchema,
  IngestionPurposeSchema,
  RuntimeIngestionPurposeSchema
} from "@coeval/shared";
import { createApp } from "../src/app.js";
import {
  assertTraceIngestionPurpose,
  DemoRepository,
  TRACE_INGESTION_PURPOSES_BY_SOURCE
} from "../src/repository.js";

const PROJECT_ID = "proj_langsmith_support";
const TRACE = {
  input: { question: "Can I get a refund?" },
  output: { answer: "Yes, within 30 days." },
  metadata: {}
};

class CapturingRepository extends DemoRepository {
  readonly imported = new Array<{ source: string; purpose: string }>();
  readonly datasetPurposes = new Array<string>();

  override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
    this.imported.push({ source: args[1], purpose: args[3].ingestionPurpose });
    return super.importTrace(...args);
  }

  override async importDatasetExamples(
    input: Parameters<DemoRepository["importDatasetExamples"]>[0]
  ) {
    this.datasetPurposes.push(input.ingestionPurpose);
    return super.importDatasetExamples(input);
  }
}

async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "purpose-test" })
  });
  return ((await response.json()) as { key: string }).key;
}

describe("ingestion-purpose writer contract", () => {
  it("keeps one closed current-writer vocabulary", () => {
    expect(IngestionPurposeSchema.options).toEqual([
      "analysis_eligible_manual",
      "analysis_eligible_langsmith",
      "analysis_eligible_langfuse",
      "analysis_eligible_ironside",
      "judge_api",
      "judge_batch_general",
      "dataset_example",
      "trace_test_synthetic",
      "release_evidence"
    ]);
    expect(RuntimeIngestionPurposeSchema.safeParse("analysis_eligible_manual").success).toBe(true);
    expect(IngestionPurposeSchema.safeParse("new_writer_default").success).toBe(false);
  });

  it("preserves the first origin when another purpose retries the same trace identity", async () => {
    const repository = new DemoRepository();
    const first = await repository.importTrace(PROJECT_ID, "manual", {
      sourceTraceId: "shared-source-id",
      ...TRACE
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const replay = await repository.importTrace(PROJECT_ID, "manual", {
      sourceTraceId: "shared-source-id",
      ...TRACE
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const judge = await repository.importTrace(PROJECT_ID, "manual", {
      sourceTraceId: "shared-source-id",
      ...TRACE
    }, { ingestionPurpose: "judge_api" });

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, caseId: first.caseId, rawTraceId: first.rawTraceId });
    expect(judge).toMatchObject({ created: false, caseId: first.caseId, rawTraceId: first.rawTraceId });
  });

  it("fails closed when a purpose does not match its case source", async () => {
    const repository = new DemoRepository();
    await expect(repository.importTrace(PROJECT_ID, "langsmith", {
      sourceTraceId: "wrong-purpose",
      ...TRACE
    }, { ingestionPurpose: "analysis_eligible_manual" })).rejects.toThrow(
      "Ingestion purpose analysis_eligible_manual is not valid for case source langsmith"
    );
  });

  it("keeps the runtime source-purpose matrix exhaustive and fail-closed", () => {
    const allowed = new Set(Object.entries(TRACE_INGESTION_PURPOSES_BY_SOURCE)
      .flatMap(([source, purposes]) => purposes.map((purpose) => `${source}:${purpose}`)));
    const flattenedPurposes = Object.values(TRACE_INGESTION_PURPOSES_BY_SOURCE).flat();

    expect(flattenedPurposes).toHaveLength(new Set(flattenedPurposes).size);
    expect([...flattenedPurposes].sort()).toEqual([...RuntimeIngestionPurposeSchema.options].sort());

    for (const source of CaseSourceSchema.options) {
      for (const purpose of RuntimeIngestionPurposeSchema.options) {
        const assertion = () => assertTraceIngestionPurpose(source, purpose);
        if (allowed.has(`${source}:${purpose}`)) expect(assertion).not.toThrow();
        else expect(assertion).toThrow(`Ingestion purpose ${purpose} is not valid for case source ${source}`);
      }
    }
  });

  it("assigns explicit purposes across the public ingestion routes", async () => {
    const repository = new CapturingRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    const manual = await app.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceTraceId: "purpose-manual", ...TRACE })
    });
    expect(manual.status).toBe(201);

    const judge = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ trace: { sourceTraceId: "purpose-judge", ...TRACE } })
    });
    expect(judge.status).toBe(201);

    const generalBatch = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ items: [{ sourceTraceId: "purpose-batch", ...TRACE }] })
    });
    expect(generalBatch.status).toBe(202);

    const releaseBatch = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        purpose: "release_evidence",
        items: [{ clientItemId: "release-item-1", sourceTraceId: "ignored-release-id", ...TRACE }]
      })
    });
    expect(releaseBatch.status).toBe(202);

    const dataset = await repository.createDataset({ projectId: PROJECT_ID, name: "Purpose examples" });
    const examples = await app.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ input: "example", output: "answer" }] })
    });
    expect(examples.status).toBe(201);

    expect(repository.imported).toEqual([
      { source: "manual", purpose: "analysis_eligible_manual" },
      { source: "manual", purpose: "judge_api" },
      { source: "manual", purpose: "judge_batch_general" },
      { source: "release_evidence", purpose: "release_evidence" },
      { source: "manual", purpose: "dataset_example" }
    ]);
    expect(repository.datasetPurposes).toEqual(["dataset_example"]);
  });
});
