import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGovernedBatch,
  fetchGovernedBlindTaskView,
  fetchGovernedBatches,
  fetchGovernedPostBarrierItem,
  fetchGovernedTasks,
  submitGovernedLabel
} from "../src/lib/governed-review-api.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

const safeView = {
  contract: "coeval/governed-blind-task-view/v1",
  schemaVersion: 1,
  canonicalizationVersion: "coeval-canonical-json/v1",
  taskId: "task_blind_1",
  batchId: "batch_1",
  servePosition: 0,
  criterion: {
    criterionId: "criterion_1",
    criterionVersionId: "criterion_version_1",
    name: "Groundedness",
    definition: "Use only supplied evidence.",
    criterionDigest: sha("1")
  },
  instruction: {
    instructionVersionId: "instruction_1",
    title: "Review groundedness",
    instructions: "Review only the frozen evidence.",
    failureCodeGuidance: "Write open codes.",
    allowedLabels: ["pass", "fail", "cannot_determine"],
    instructionDigest: sha("2")
  },
  payloadSnapshot: {
    input: { question: "What is the refund window?" },
    output: { answer: "Thirty days." }
  }
};

function blindResponse(value: unknown): Response {
  const bytes = JSON.stringify(value);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return new Response(bytes, {
    headers: {
      "content-type": "application/json",
      "x-coeval-view-digest": digest
    }
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("governed review web API boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads exact blind bytes and their exposed digest without caching the payload", async () => {
    const storage = { getItem: vi.fn(() => "project_1"), setItem: vi.fn(), removeItem: vi.fn() };
    const fetchMock = vi.fn(async () => blindResponse(safeView));
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", fetchMock);

    const artifact = await fetchGovernedBlindTaskView("task_blind_1");

    expect(artifact.view).toMatchObject({ taskId: "task_blind_1", criterion: { name: "Groundedness" } });
    expect(artifact.canonicalText).toBe(JSON.stringify(safeView));
    expect(artifact.viewDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/governed-review/tasks/task_blind_1/view",
      expect.objectContaining({ credentials: "include" })
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("x-coeval-project")).toBe("project_1");
  });

  it.each([
    ["expected label", { expected_label: "pass" }],
    ["peer label", { nested: { peerLabels: [{ label: "fail" }] } }],
    ["evaluator output", { result: { evaluator_output: { label: "pass" } } }],
    ["mutable identity", { context: { trace_id: "trace_secret" } }]
  ])("fails closed on recursive forbidden canary: %s", async (_name, canary) => {
    const fetchMock = vi.fn(async () => blindResponse({
      ...safeView,
      payloadSnapshot: { ...safeView.payloadSnapshot, output: canary }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGovernedBlindTaskView("task_blind_1")).rejects.toThrow(
      "evidence that is not allowed before the barrier"
    );
  });

  it("rejects a missing or byte-swapped digest before rendering", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(safeView), {
      headers: { "x-coeval-view-digest": sha("f") }
    })));
    await expect(fetchGovernedBlindTaskView("task_blind_1")).rejects.toThrow("do not match");
  });

  it("uses only governed endpoints for the blind task flow and sends the exact view digest with the label", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(input);
      if (input.endsWith("/view")) return blindResponse(safeView);
      if (input.endsWith("/tasks")) {
        return json({ tasks: [{
          taskId: "task_blind_1",
          batchId: "batch_1",
          criterionVersionId: "criterion_version_1",
          instructionVersionId: "instruction_1",
          criterionName: "Groundedness",
          instructionTitle: "Review groundedness",
          state: "viewed",
          stateVersion: 1,
          servePosition: 0,
          fixedStopAt: "2030-01-01T00:00:00.000Z",
          activeLabelId: null
        }] });
      }
      if (input.endsWith("/labels")) {
        const body = JSON.parse(String(init?.body));
        expect(body.viewDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(body).toMatchObject({
          expectedStreamVersion: 1,
          label: "cannot_determine",
          rationale: "The policy text is not supplied.",
          failureCodes: ["missing_policy"]
        });
        return json({ task: { taskId: "task_blind_1", state: "submitted", stateVersion: 2, activeLabelId: "label_1" } }, 201);
      }
      throw new Error(`Unexpected fetch ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const artifact = await fetchGovernedBlindTaskView("task_blind_1");
    const [task] = await fetchGovernedTasks();
    await submitGovernedLabel({
      taskId: task!.taskId,
      expectedStreamVersion: task!.stateVersion!,
      viewDigest: artifact.viewDigest,
      label: "cannot_determine",
      rationale: "The policy text is not supplied.",
      failureCodes: ["missing_policy"]
    });

    expect(calls).toEqual([
      "/api/governed-review/tasks/task_blind_1/view",
      "/api/governed-review/tasks",
      "/api/governed-review/tasks/task_blind_1/labels"
    ]);
    expect(calls.some((path) => /dashboard|cases|verdicts|review-queues/.test(path))).toBe(false);
  });

  it("preserves server-derived selection, completeness, item, and resolution projections", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ batches: [{
        batchId: "batch_1",
        criterionVersionId: "criterion_version_1",
        instructionVersionId: "instruction_1",
        roleIntent: "sealed_validation",
        sourcePopulationKind: "sealed_intake",
        sourcePopulationId: "sealed_intake_1",
        evaluatorBlind: true,
        peerBlindUntilLabelingClosed: true,
        selectionMethod: "simple_random",
        batchDigest: sha("3"),
        populationDigest: sha("4"),
        drawDigest: sha("5"),
        fixedBudget: 1,
        requiredIndependentLabels: 2,
        state: "labeling_closed",
        stateVersion: 2,
        fixedStopAt: "2030-01-01T00:00:00.000Z",
        itemCount: 1,
        items: [{ batchItemId: "batch_item_1", servePosition: 0, resolutionKind: "conflict", resolvedLabel: null }],
        completeness: { totalTasks: 2, submittedTasks: 2, deferredTasks: 0, expiredTasks: 0, pendingTasks: 0 },
        representativeness: { status: "not_evaluated", populationId: null, reasons: ["resolution_incomplete"] },
        datasetRevisionId: null,
        evidenceClass: null,
        createdAt: "2026-08-23T00:00:00.000Z"
      }] }))
      .mockResolvedValueOnce(json({ item: {
        batchId: "batch_1",
        batchItemId: "batch_item_1",
        alignmentVersion: 3,
        criterion: { criterionVersionId: "criterion_version_1", name: "Groundedness", definition: "Use supplied evidence." },
        instruction: { instructionVersionId: "instruction_1", title: "Review", instructions: "Review it.", failureCodeGuidance: "Write codes." },
        payloadSnapshot: { input: { q: "Refund?" }, output: { a: "Thirty days" } },
        activeLabels: [
          { labelId: "label_1", reviewerSubjectId: "subject_a", label: "pass", rationale: "Supported.", failureCodes: [] },
          { labelId: "label_2", reviewerSubjectId: "subject_b", label: "fail", rationale: "Not supported.", failureCodes: ["missing_support"] }
        ],
        resolution: { kind: "conflict", resolvedLabel: null, adjudicationId: null }
      } }));
    vi.stubGlobal("fetch", fetchMock);

    const [batch] = await fetchGovernedBatches();
    const item = await fetchGovernedPostBarrierItem("batch_1", "batch_item_1", "adjudication");

    expect(batch).toMatchObject({
      batchDigest: sha("3"),
      sourcePopulationId: "sealed_intake_1",
      evaluatorBlind: true,
      peerBlindUntilLabelingClosed: true,
      populationDigest: sha("4"),
      drawDigest: sha("5"),
      coverage: { totalTasks: 2, submittedTasks: 2, deferredTasks: 0, expiredTasks: 0 },
      representativeness: { status: "not_evaluated", reasons: ["resolution_incomplete"] },
      members: [{ batchItemId: "batch_item_1", resolutionKind: "conflict", resolvedLabel: null }]
    });
    expect(item).toMatchObject({
      reviewItemId: "batch_item_1",
      alignmentVersion: 3,
      labels: [
        { labelId: "label_1", value: "pass" },
        { labelId: "label_2", value: "fail", failureCodes: ["missing_support"] }
      ],
      resolution: { basis: "conflict", referenceLabel: null }
    });
  });

  it("preserves and emits an exact analysis promotion handoff", async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        roleIntent: "analysis_authoring",
        source: { kind: "analysis_promotion_handoff", promotionId: "promotion_1" }
      });
      return json({ batch: {
        batchId: "batch_handoff_1",
        criterionVersionId: "criterion_version_1",
        instructionVersionId: "instruction_1",
        roleIntent: "analysis_authoring",
        sourcePopulationKind: "analysis_promotion_handoff",
        sourcePopulationId: "promotion_1",
        state: "draft",
        stateVersion: 0,
        selectionMethod: "simple_random",
        fixedBudget: 1,
        itemCount: 1,
        items: [],
        representativeness: { status: "not_evaluated", populationId: null, reasons: [] },
        createdAt: "2026-08-23T00:00:00.000Z"
      } }, 201);
    });
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "project_1") });
    vi.stubGlobal("fetch", fetchMock);

    const batch = await createGovernedBatch({
      instructionVersionId: "instruction_1",
      roleIntent: "analysis_authoring",
      source: { kind: "analysis_promotion_handoff", promotionId: "promotion_1" },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: ["reviewer_1"],
      fixedStopAt: "2030-01-01T00:00:00.000Z",
      idempotencyKey: "handoff-web-1"
    });

    expect(batch).toMatchObject({
      sourcePopulationKind: "analysis_promotion_handoff",
      sourcePopulationId: "promotion_1",
      roleIntent: "analysis_authoring"
    });
  });

  it("describes the handoff separately from later independently governed truth", async () => {
    const source = await readFile(new URL("../src/screens/human-truth-create.tsx", import.meta.url), "utf8");
    expect(source).toContain("its analysis labels are not truth");
    expect(source).toContain("Independent governed review may produce truth only when resolved and frozen");
    expect(source).toContain("No evaluator is created");
    expect(source).not.toContain("governed batch creates neither human truth");
  });

  it("does not manufacture pre-barrier completeness or item resolution", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ batches: [{
      batchId: "batch_open",
      criterionVersionId: "criterion_version_1",
      instructionVersionId: "instruction_1",
      roleIntent: "analysis_authoring",
      sourcePopulationKind: "dataset_revision",
      sourcePopulationId: "revision_1",
      evaluatorBlind: true,
      peerBlindUntilLabelingClosed: true,
      selectionMethod: "simple_random",
      batchDigest: sha("6"),
      populationDigest: sha("7"),
      drawDigest: sha("8"),
      fixedBudget: 1,
      requiredIndependentLabels: 2,
      state: "open",
      stateVersion: 1,
      fixedStopAt: "2030-01-01T00:00:00.000Z",
      itemCount: 1,
      items: [{ batchItemId: "batch_item_1", servePosition: 0, resolutionKind: null, resolvedLabel: null }],
      completeness: null,
      representativeness: { status: "not_evaluated", populationId: null, reasons: [] },
      datasetRevisionId: null,
      evidenceClass: null,
      createdAt: "2026-08-23T00:00:00.000Z"
    }] })));

    const [batch] = await fetchGovernedBatches();
    expect(batch?.coverage).toEqual({
      totalTasks: null,
      submittedTasks: null,
      deferredTasks: null,
      expiredTasks: null,
      resolvedItems: null,
      unresolvedItems: null,
      complete: null
    });
    expect(batch?.members[0]).toMatchObject({ resolutionKind: null, resolvedLabel: null });
  });
});
