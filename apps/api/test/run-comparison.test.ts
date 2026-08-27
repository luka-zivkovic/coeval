import { describe, expect, it, vi } from "vitest";
import type { Queue, QueueName, QueueSendOptions } from "@coeval/queue";
import { CreateSkillVersionInputSchema, type EvalRunItem, type RunComparisonDetail } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { computeRunComparisonDiff, runComparisonStatus } from "../src/lib/run-comparison.js";
import { DatasetRevisionConflictError, DemoRepository } from "../src/repository.js";

const PROJECT = "proj_langsmith_support";
// The demo's current version. resolveSkillVersionId validates requested ids
// through listSkillVersions, so the second comparable version is created per
// test through the real save path (mock-gated in demo).
const CURRENT_VERSION = "skillv_1_2_0";

async function createSecondVersion(repository: DemoRepository): Promise<string> {
  const skill = await repository.getCurrentSkill();
  const { version } = await repository.createSkillVersion(
    skill.id,
    CreateSkillVersionInputSchema.parse({
      rubricMarkdown: "Bisect variant rubric",
      prompt: "Judge the trace against the rubric.",
      modelBinding: skill.currentVersion.modelBinding
    }),
    { projectId: PROJECT }
  );
  return version.id;
}

class StubQueue implements Queue {
  readonly sent: Array<{ name: QueueName; data: object }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work(): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, _options?: QueueSendOptions): Promise<string> {
    this.sent.push({ name, data });
    return `job_${this.sent.length}`;
  }
}

// Crafted eval-run items for the pure bucketing function — only the fields
// the diff reads vary per test.
function item(overrides: Partial<EvalRunItem> & { caseId: string }): EvalRunItem {
  return {
    id: `evi_${overrides.caseId}_${Math.random().toString(36).slice(2, 8)}`,
    evalRunId: "evr_test",
    datasetItemId: null,
    clientItemId: null,
    contentDigest: null,
    status: "completed",
    verdictId: "verdict_1",
    expectedLabel: null,
    expectedFailStep: null,
    failingStep: null,
    resultLabel: "pass",
    agreement: null,
    stepAgreement: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    cached: false,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("run comparisons — bucketing (pure)", () => {
  it("buckets same/flip cases by the pass projection of both labels", () => {
    const itemsA = [
      item({ caseId: "case_same_pass", resultLabel: "pass" }),
      item({ caseId: "case_same_fail", resultLabel: "fail" }),
      item({ caseId: "case_now_failing", resultLabel: "pass" }),
      item({ caseId: "case_now_passing", resultLabel: "fail" })
    ];
    const itemsB = [
      item({ caseId: "case_same_pass", resultLabel: "pass" }),
      item({ caseId: "case_same_fail", resultLabel: "fail" }),
      item({ caseId: "case_now_failing", resultLabel: "fail" }),
      item({ caseId: "case_now_passing", resultLabel: "pass" })
    ];

    const diff = computeRunComparisonDiff(itemsA, itemsB);
    expect(diff.buckets).toEqual({
      "same-pass": 1,
      "same-fail": 1,
      "flipped-now-failing": 1,
      "flipped-now-passing": 1,
      pending: 0,
      missing: 0
    });
    const byCase = new Map(diff.cases.map((row) => [row.caseId, row.bucket]));
    expect(byCase.get("case_same_pass")).toBe("same-pass");
    expect(byCase.get("case_same_fail")).toBe("same-fail");
    expect(byCase.get("case_now_failing")).toBe("flipped-now-failing");
    expect(byCase.get("case_now_passing")).toBe("flipped-now-passing");
    // Flips lead the list — the incident reader wants what changed first.
    expect(diff.cases[0]?.bucket).toBe("flipped-now-failing");
    expect(diff.cases[1]?.bucket).toBe("flipped-now-passing");
  });

  it("treats ambiguous as non-pass: fail↔ambiguous is same-fail, pass→ambiguous is now-failing", () => {
    const itemsA = [
      item({ caseId: "case_ambig_fail", resultLabel: "fail" }),
      item({ caseId: "case_pass_ambig", resultLabel: "pass" })
    ];
    const itemsB = [
      item({ caseId: "case_ambig_fail", resultLabel: "ambiguous" }),
      item({ caseId: "case_pass_ambig", resultLabel: "ambiguous" })
    ];

    const diff = computeRunComparisonDiff(itemsA, itemsB);
    expect(diff.buckets["same-fail"]).toBe(1);
    expect(diff.buckets["flipped-now-failing"]).toBe(1);
    expect(diff.buckets["flipped-now-passing"]).toBe(0);
  });

  it("pending wins over everything: an unjudged item can never be claimed as a flip", () => {
    const itemsA = [item({ caseId: "case_pending", resultLabel: "pass" })];
    const itemsB = [item({ caseId: "case_pending", status: "pending", resultLabel: null, verdictId: null })];

    const diff = computeRunComparisonDiff(itemsA, itemsB);
    expect(diff.buckets.pending).toBe(1);
    expect(diff.cases[0]?.bucket).toBe("pending");
    expect(diff.cases[0]?.labelA).toBe("pass");
    expect(diff.cases[0]?.labelB).toBeNull();
    expect(diff.cases[0]?.statusB).toBe("pending");
  });

  it("missing covers absent-in-one-run, failed, and skipped items — named, not dropped", () => {
    const itemsA = [
      item({ caseId: "case_a_only", resultLabel: "pass" }),
      item({ caseId: "case_failed_in_b", resultLabel: "pass" }),
      item({ caseId: "case_skipped_in_b", resultLabel: "fail" })
    ];
    const itemsB = [
      item({ caseId: "case_b_only", resultLabel: "fail" }),
      item({ caseId: "case_failed_in_b", status: "failed", resultLabel: null, verdictId: null, error: "provider 500" }),
      item({ caseId: "case_skipped_in_b", status: "skipped", resultLabel: null, verdictId: null })
    ];

    const diff = computeRunComparisonDiff(itemsA, itemsB);
    expect(diff.buckets.missing).toBe(4);
    expect(diff.cases).toHaveLength(4);
    const aOnly = diff.cases.find((row) => row.caseId === "case_a_only");
    expect(aOnly?.bucket).toBe("missing");
    expect(aOnly?.statusB).toBeNull();
    const bOnly = diff.cases.find((row) => row.caseId === "case_b_only");
    expect(bOnly?.statusA).toBeNull();
    expect(bOnly?.labelB).toBe("fail");
    // A failed item's label is null even though the row carries a status.
    const failed = diff.cases.find((row) => row.caseId === "case_failed_in_b");
    expect(failed?.bucket).toBe("missing");
    expect(failed?.labelA).toBe("pass");
    expect(failed?.labelB).toBeNull();
    expect(failed?.statusB).toBe("failed");
  });

  it("carries the expected label from either run's snapshot", () => {
    const diff = computeRunComparisonDiff(
      [item({ caseId: "case_exp", expectedLabel: "pass", resultLabel: "pass" })],
      [item({ caseId: "case_exp", expectedLabel: "pass", resultLabel: "fail" })]
    );
    expect(diff.cases[0]?.expectedLabel).toBe("pass");
    expect(diff.cases[0]?.bucket).toBe("flipped-now-failing");
  });

  it("empty runs diff to zero everything", () => {
    const diff = computeRunComparisonDiff([], []);
    expect(diff.cases).toHaveLength(0);
    expect(Object.values(diff.buckets).every((count) => count === 0)).toBe(true);
  });
});

// Endpoint tests run against the DemoRepository. Queue-less, both runs judge
// inline before the POST responds; the mock judge is content-deterministic
// (fail terms fail, clean answers pass) and version-independent, so endpoint
// diffs land in the same-* buckets — flips are covered by the pure tests.
async function importCase(repository: DemoRepository, sourceTraceId: string, answer: string): Promise<string> {
  const imported = await repository.importTrace(PROJECT, "manual", {
    sourceTraceId,
    input: { question: "Is the refund policy honored?" },
    output: { answer },
    metadata: {}
  }, { ingestionPurpose: "analysis_eligible_manual" });
  return imported.caseId;
}

async function seedDataset(repository: DemoRepository, name: string): Promise<string> {
  const passing = await importCase(repository, `${name}_pass`, "A correct, helpful answer.");
  const failing = await importCase(repository, `${name}_fail`, "This answer is wrong and incorrect.");
  const dataset = await repository.createDataset({ projectId: PROJECT, name });
  await repository.addDatasetItems({
    projectId: PROJECT,
    datasetId: dataset.id,
    items: [
      { caseId: passing, expectedLabel: "pass" },
      { caseId: failing, expectedLabel: "pass" }
    ]
  });
  return dataset.id;
}

function postComparison(app: ReturnType<typeof createApp>, body: object) {
  return app.request("/api/run-comparisons", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("run comparisons — session endpoints", () => {
  it("POST creates TWO eval runs through the standard path and persists the pairing", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect endpoint");

    const response = await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
    expect(response.status).toBe(202);
    const { comparison } = (await response.json()) as { comparison: { id: string; runAId: string; runBId: string; versionAId: string; versionBId: string; datasetRevisionId: string } };
    expect(comparison.versionAId).toBe(CURRENT_VERSION);
    expect(comparison.versionBId).toBe(versionB);

    // Both runs are ordinary eval runs, listed alongside manual ones, each
    // pinned to its version and the same immutable collection revision.
    const runs = await repository.listEvalRuns(PROJECT);
    expect(runs).toHaveLength(2);
    const runA = await repository.getEvalRun(PROJECT, comparison.runAId);
    const runB = await repository.getEvalRun(PROJECT, comparison.runBId);
    expect(runA?.skillVersionId).toBe(CURRENT_VERSION);
    expect(runB?.skillVersionId).toBe(versionB);
    expect(runA?.datasetId).toBeNull();
    expect(comparison.datasetRevisionId).toBeTruthy();
    expect(runA?.datasetRevisionId).toBe(comparison.datasetRevisionId);
    expect(runB?.datasetRevisionId).toBe(comparison.datasetRevisionId);
    expect(runA?.status).toBe("completed"); // queue-less → judged inline
    expect(runB?.status).toBe("completed");
    expect(runA?.totalItems).toBe(2);
    await expect(repository.createRunComparison({
      projectId: PROJECT,
      datasetId: "ds_wrong",
      datasetRevisionId: comparison.datasetRevisionId,
      versionAId: CURRENT_VERSION,
      versionBId: versionB,
      runAId: comparison.runAId,
      runBId: comparison.runBId
    })).rejects.toBeInstanceOf(DatasetRevisionConflictError);
  });

  it("GET :id joins both runs' items into buckets with per-version agreement", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect detail");

    const created = await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
    const { comparison } = (await created.json()) as { comparison: { id: string } };

    const response = await app.request(`/api/run-comparisons/${comparison.id}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as RunComparisonDetail;
    expect(detail.id).toBe(comparison.id);
    expect(detail.status).toBe("completed");
    expect(detail.datasetId).toBe(datasetId);
    expect(detail.datasetRevisionId).toBeTruthy();
    expect(detail.runA.datasetRevisionId).toBe(detail.datasetRevisionId);
    expect(detail.runB.datasetRevisionId).toBe(detail.datasetRevisionId);
    // The mock judge is version-independent: the clean answer passes under
    // both versions, the "wrong and incorrect" one fails under both.
    expect(detail.buckets).toEqual({
      "same-pass": 1,
      "same-fail": 1,
      "flipped-now-failing": 0,
      "flipped-now-passing": 0,
      pending: 0,
      missing: 0
    });
    expect(detail.cases).toHaveLength(2);
    for (const row of detail.cases) {
      expect(row.expectedLabel).toBe("pass");
      expect(row.statusA).toBe("completed");
      expect(row.statusB).toBe("completed");
    }
    // Both items carried expectedLabel "pass"; only the clean answer agreed.
    expect(detail.agreementA).toEqual({ agreed: 1, labeled: 2 });
    expect(detail.agreementB).toEqual({ agreed: 1, labeled: 2 });
    expect(detail.runA.skillVersionId).toBe(CURRENT_VERSION);
    expect(detail.runB.skillVersionId).toBe(versionB);
  });

  it("reuses identical comparison evidence but mints a new revision when review provenance changes", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect revision reuse");

    const firstResponse = await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
    const secondResponse = await postComparison(app, { datasetId, versionAId: versionB, versionBId: CURRENT_VERSION });
    const first = (await firstResponse.json()) as { comparison: { datasetRevisionId: string } };
    const second = (await secondResponse.json()) as { comparison: { datasetRevisionId: string } };
    expect(second.comparison.datasetRevisionId).toBe(first.comparison.datasetRevisionId);

    const dataset = await repository.getDatasetDetail(PROJECT, datasetId);
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId: dataset!.items[0]!.caseId,
      source: "human",
      actorUserId: "user_review_after_freeze",
      payload: {
        kind: "categorical",
        choice: "pass",
        choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
        rationale: "New review evidence"
      }
    });
    const thirdResponse = await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
    const third = (await thirdResponse.json()) as { comparison: { datasetRevisionId: string } };
    expect(third.comparison.datasetRevisionId).not.toBe(first.comparison.datasetRevisionId);
    expect(await repository.listDatasetRevisions(PROJECT, datasetId)).toHaveLength(2);
  });

  it("GET list returns comparisons newest first; GET :id 404s on unknown ids", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect list");

    expect((await app.request("/api/run-comparisons/rcmp_missing")).status).toBe(404);

    await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
    await postComparison(app, { datasetId, versionAId: versionB, versionBId: CURRENT_VERSION });

    const response = await app.request("/api/run-comparisons");
    expect(response.status).toBe(200);
    const { comparisons } = (await response.json()) as { comparisons: Array<{ versionAId: string }> };
    expect(comparisons).toHaveLength(2);
    expect(await repository.listDatasetRevisions(PROJECT, datasetId)).toHaveLength(1);
    // Both pairings are on record (same-millisecond createdAt makes strict
    // ordering unassertable here; the sort itself is createdAt desc).
    expect(new Set(comparisons.map((c) => c.versionAId))).toEqual(new Set([CURRENT_VERSION, versionB]));
  });

  it("validates input: same version, unknown version, missing/empty dataset, malformed body", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect validation");

    expect((await postComparison(app, { datasetId, versionAId: versionB, versionBId: versionB })).status).toBe(400);
    expect((await postComparison(app, { datasetId, versionAId: "skillv_other_project", versionBId: versionB })).status).toBe(400);
    expect((await postComparison(app, { datasetId: "ds_missing", versionAId: CURRENT_VERSION, versionBId: versionB })).status).toBe(404);
    expect((await postComparison(app, { datasetId })).status).toBe(400);

    const empty = await repository.createDataset({ projectId: PROJECT, name: "Empty bisect" });
    expect((await postComparison(app, { datasetId: empty.id, versionAId: CURRENT_VERSION, versionBId: versionB })).status).toBe(400);

    // Nothing was persisted by the rejected attempts.
    const { comparisons } = (await (await app.request("/api/run-comparisons")).json()) as { comparisons: unknown[] };
    expect(comparisons).toHaveLength(0);
  });

  it("reports pending buckets while queued runs are still executing", async () => {
    const repository = new DemoRepository();
    const queue = new StubQueue();
    // With a queue configured, POST enqueues eval.run instead of judging
    // inline — the runs stay pending, exactly like PG mode mid-flight.
    const app = createApp(repository, { queue });
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect pending");

    const created = await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
    expect(created.status).toBe(202);
    const { comparison } = (await created.json()) as { comparison: { id: string } };
    expect(queue.sent.filter((job) => job.name === "eval.run")).toHaveLength(2);

    const response = await app.request(`/api/run-comparisons/${comparison.id}`);
    const detail = (await response.json()) as RunComparisonDetail;
    expect(detail.status).toBe("pending");
    expect(detail.buckets.pending).toBe(2);
    expect(detail.buckets["flipped-now-failing"]).toBe(0);
    for (const row of detail.cases) {
      expect(row.bucket).toBe("pending");
      expect(row.labelA).toBeNull();
      expect(row.labelB).toBeNull();
    }
  });

  it("fans out NOTHING when the second run creation fails — no tokens spent midway", async () => {
    const repository = new DemoRepository();
    const queue = new StubQueue();
    const app = createApp(repository, { queue });
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect midway failure");

    // Run A's row persists, run B's creation throws — exactly the midway
    // failure the create/dispatch split guards: dispatch must never have run.
    const originalCreate = repository.createEvalRun.bind(repository);
    vi.spyOn(repository, "createEvalRun")
      .mockImplementationOnce(originalCreate)
      .mockImplementationOnce(() => Promise.reject(new Error("simulated run-B creation failure")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
      expect(response.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
      vi.mocked(repository.createEvalRun).mockRestore();
    }

    // No fan-out reached the queue, so no provider tokens were spent…
    expect(queue.sent.filter((job) => job.name === "eval.run")).toHaveLength(0);
    // …and no comparison row was persisted for the half-created pair.
    const { comparisons } = (await (await app.request("/api/run-comparisons")).json()) as { comparisons: unknown[] };
    expect(comparisons).toHaveLength(0);
    // …and run A's never-dispatched row was cleaned up rather than stranded
    // as a forever-pending run in the eval-runs history (it had no verdicts,
    // so deleting it keeps append-only intact).
    expect(await repository.listEvalRuns(PROJECT)).toHaveLength(0);
  });

  it("maps immutable-freeze conflicts to 409 before creating or dispatching runs", async () => {
    const repository = new DemoRepository();
    const queue = new StubQueue();
    const app = createApp(repository, { queue });
    const versionB = await createSecondVersion(repository);
    const datasetId = await seedDataset(repository, "Bisect freeze conflict");
    vi.spyOn(repository, "createDatasetRevision").mockRejectedValueOnce(
      new DatasetRevisionConflictError("simulated immutable freeze conflict")
    );

    const response = await postComparison(app, { datasetId, versionAId: CURRENT_VERSION, versionBId: versionB });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "simulated immutable freeze conflict" });
    expect(await repository.listEvalRuns(PROJECT)).toHaveLength(0);
    expect(queue.sent).toHaveLength(0);
  });

  it("runComparisonStatus: completed only when BOTH runs are terminal", async () => {
    const repository = new DemoRepository();
    const runA = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: CURRENT_VERSION,
      trigger: "manual",
      items: [{ caseId: await importCase(repository, "rcs_a", "Fine.") }]
    });
    const runB = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: CURRENT_VERSION,
      trigger: "manual",
      items: [{ caseId: await importCase(repository, "rcs_b", "Fine too."), status: "completed", verdictId: "v_x", resultLabel: "pass" }]
    });
    expect(runComparisonStatus(runA, runB)).toBe("pending"); // A still pending
    expect(runComparisonStatus(runB, runB)).toBe("completed");
  });
});
