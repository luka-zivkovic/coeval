import { describe, expect, it } from "vitest";
import { AssessmentReceiptSchema, type AssessmentReceipt } from "@coeval/shared";
import { createApp } from "../src/app.js";
import {
  buildAssessmentReceipt,
  canonicalJson,
  contentDigest,
  evidenceDigestForReceipt,
  sha256Digest
} from "../src/lib/assessment-receipt.js";
import { CaseNotFoundError, DemoRepository } from "../src/repository.js";

const PROJECT = "proj_langsmith_support";
const VERSION = "skillv_1_2_0";

async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "release-evidence-test" })
  });
  return (await response.json() as { key: string }).key;
}

async function skill(repo: DemoRepository) {
  const version = await repo.getSkillVersion(PROJECT, VERSION);
  if (!version) throw new Error("demo skill version missing");
  return version;
}

describe("assessment receipt canonical evidence", () => {
  it("canonicalizes object keys recursively while retaining array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 1 }, list: [{ d: 4, c: 3 }, 2, 1] }))
      .toBe('{"a":{"b":1,"y":2},"list":[{"c":3,"d":4},2,1],"z":1}');
    expect(sha256Digest({ b: 2, a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sha256Digest({ b: 2, a: 1 })).toBe(sha256Digest({ a: 1, b: 2 }));
  });

  it("builds a schema-valid deterministic receipt sorted by clientItemId", async () => {
    const repo = new DemoRepository();
    const digestA = contentDigest({ q: "a" }, { answer: "a" });
    const digestB = contentDigest({ q: "b" }, { answer: "b" });
    const run = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "release_evidence",
      items: [
        { caseId: "case_b", clientItemId: "b", contentDigest: digestB, status: "completed", verdictId: "verdict_b", resultLabel: "pass", cached: true },
        { caseId: "case_a", clientItemId: "a", contentDigest: digestA, status: "completed", verdictId: "verdict_a", resultLabel: "fail", cached: true }
      ]
    });
    const receipt = buildAssessmentReceipt({ run, skillVersion: await skill(repo) });

    expect(AssessmentReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt.items.map((item) => item.clientItemId)).toEqual(["a", "b"]);
    expect(receipt.datasetDigest).toBe(sha256Digest([
      { clientItemId: "a", contentDigest: digestA },
      { clientItemId: "b", contentDigest: digestB }
    ]));
    expect(receipt.evidenceDigest).toBe(evidenceDigestForReceipt(receipt));
    expect(buildAssessmentReceipt({ run, skillVersion: await skill(repo) })).toEqual(receipt);
  });

  it("detects evidence tampering and exposes no release-policy decision field", async () => {
    const repo = new DemoRepository();
    const run = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "release_evidence",
      items: [{
        caseId: "case_tamper",
        clientItemId: "item_tamper",
        contentDigest: contentDigest({ q: 1 }, { a: 1 }),
        status: "completed",
        verdictId: "verdict_tamper",
        resultLabel: "pass",
        cached: true
      }]
    });
    const receipt = buildAssessmentReceipt({ run, skillVersion: await skill(repo) });
    const tampered: AssessmentReceipt = {
      ...receipt,
      items: receipt.items.map((item) => ({ ...item, judgedLabel: "fail" }))
    };
    expect(evidenceDigestForReceipt(tampered)).not.toBe(receipt.evidenceDigest);

    const forbidden = new Set(["threshold", "decision", "ship", "hold", "deploy", "rolloutPolicy", "maxDisagreements"]);
    function allKeys(value: unknown): string[] {
      if (Array.isArray(value)) return value.flatMap(allKeys);
      if (!value || typeof value !== "object") return [];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...allKeys(child)]);
    }
    expect(allKeys(receipt).filter((key) => forbidden.has(key))).toEqual([]);
  });

  it("changes the evidence digest for every governed evidence class", async () => {
    const repo = new DemoRepository();
    const run = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "release_evidence",
      items: [{
        caseId: "case_property",
        clientItemId: "property-item",
        contentDigest: contentDigest({ q: "stable" }, { a: "stable" }),
        status: "completed",
        verdictId: "verdict_property",
        resultLabel: "pass",
        cached: true,
        providerMetadata: { model: "observed-model", requestId: "req-1", responseId: "resp-1", systemFingerprint: null }
      }]
    });
    const receipt = buildAssessmentReceipt({ run, skillVersion: await skill(repo) });
    const mutations: Array<[string, (candidate: AssessmentReceipt) => void]> = [
      ["receipt identity", (candidate) => { candidate.receiptId = "receipt_tampered"; }],
      ["run counters", (candidate) => { candidate.run.completedItems = 0; }],
      ["requested model binding", (candidate) => { candidate.requestedModelBinding.modelId = "other-model"; }],
      ["skill digest", (candidate) => { candidate.skillDigest = contentDigest("other", "skill"); }],
      ["dataset digest", (candidate) => { candidate.datasetDigest = contentDigest("other", "dataset"); }],
      ["item judgment", (candidate) => { candidate.items[0]!.judgedLabel = "fail"; }],
      ["item content", (candidate) => { candidate.items[0]!.contentDigest = contentDigest("other", "content"); }],
      ["provider provenance", (candidate) => { candidate.items[0]!.providerMetadata.requestId = "req-tampered"; }]
    ];

    for (const [name, mutate] of mutations) {
      const candidate = structuredClone(receipt);
      mutate(candidate);
      expect(evidenceDigestForReceipt(candidate), name).not.toBe(receipt.evidenceDigest);
    }
  });

  it("returns signed incomplete evidence with the item error preserved", async () => {
    const repo = new DemoRepository();
    const created = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "release_evidence",
      items: [{ caseId: "case_error", clientItemId: "error-1", contentDigest: contentDigest(null, null) }]
    });
    await repo.failEvalRunItem({
      projectId: PROJECT,
      evalRunId: created.id,
      evalRunItemId: created.items[0]!.id,
      error: "provider timeout after retries"
    });
    const run = await repo.getEvalRunDetail(PROJECT, created.id);
    if (!run) throw new Error("eval run missing");
    const receipt = buildAssessmentReceipt({ run, skillVersion: await skill(repo) });

    expect(receipt.status).toBe("incomplete");
    expect(receipt.run.status).toBe("failed");
    expect(receipt.items[0]).toMatchObject({ status: "failed", error: "provider timeout after retries" });
    expect(receipt.evidenceDigest).toBe(evidenceDigestForReceipt(receipt));
  });
});

describe("release_evidence batch and receipt routes", () => {
  it("requires unique clientItemIds and forbids dataset promotion", async () => {
    const repo = new DemoRepository();
    const app = createApp(repo);
    const key = await mintKey(app);
    const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
    const item = { input: { q: 1 }, output: { a: 1 }, metadata: {} };

    for (const body of [
      { purpose: "release_evidence", items: [item] },
      { purpose: "release_evidence", items: [{ ...item, clientItemId: "dup" }, { ...item, clientItemId: "dup" }] }
    ]) {
      const response = await app.request("/api/v1/judge/batch", { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }

    const dataset = await repo.createDataset({ projectId: PROJECT, name: "must-not-receive-release-evidence" });
    const withDataset = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({ purpose: "release_evidence", datasetId: dataset.id, items: [{ ...item, clientItemId: "one" }] })
    });
    expect(withDataset.status).toBe(400);

    const exactId = "  caller-owned id  ";
    const accepted = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({ purpose: "release_evidence", items: [{ ...item, clientItemId: exactId }] })
    });
    expect(accepted.status).toBe(202);
    const acceptedId = (await accepted.json() as { evalRunId: string }).evalRunId;
    const receipt = AssessmentReceiptSchema.parse(await (await app.request(
      `/api/v1/eval-runs/${acceptedId}/assessment-receipt`,
      { headers: { authorization: `Bearer ${key}` } }
    )).json());
    expect(receipt.items[0]!.clientItemId).toBe(exactId);
  });

  it("retains two identical submissions, verifies pre-redaction digests, and captures provider metadata", async () => {
    const repo = new DemoRepository();
    const app = createApp(repo);
    const key = await mintKey(app);
    const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
    const input = { question: "Can I return this?", api_key: "sk-caller-secret" };
    const output = { answer: "Yes, within 30 days.", token: "caller-output-secret" };
    const submitted = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({
        purpose: "release_evidence",
        items: [
          { clientItemId: "dailies-b", input, output, metadata: {} },
          { clientItemId: "dailies-a", input, output, metadata: {} }
        ]
      })
    });
    expect(submitted.status).toBe(202);
    const { evalRunId } = await submitted.json() as { evalRunId: string };

    const response = await app.request(`/api/v1/eval-runs/${evalRunId}/assessment-receipt`, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(response.status).toBe(200);
    const receipt = AssessmentReceiptSchema.parse(await response.json());
    expect(receipt.status).toBe("complete");
    expect(receipt.items.map((item) => item.clientItemId)).toEqual(["dailies-a", "dailies-b"]);
    expect(new Set(receipt.items.map((item) => item.caseId)).size).toBe(2);
    expect(receipt.items.every((item) => item.contentDigest === contentDigest(input, output))).toBe(true);
    expect(receipt.items.every((item) => item.providerMetadata.model === "mock-heuristic-v1")).toBe(true);
    expect(receipt.evidenceDigest).toBe(evidenceDigestForReceipt(receipt));

    // Prove import changed the stored judge content without changing the
    // caller-verifiable digest recorded before that import.
    for (const item of receipt.items) {
      const stored = await (await app.request(`/api/cases/${item.caseId}`)).json() as {
        trace: { input: { api_key: string }; output: { token: string } };
      };
      expect(stored.trace.input.api_key).toBe("[REDACTED]");
      expect(stored.trace.output.token).toBe("[REDACTED]");
    }
  });

  it("rejects receipts for general eval runs and keeps release evidence out of product surfaces", async () => {
    const repo = new DemoRepository();
    const app = createApp(repo);
    const key = await mintKey(app);
    const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
    const general = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ sourceTraceId: "general-no-receipt", input: {}, output: {}, metadata: {} }] })
    });
    const generalId = (await general.json() as { evalRunId: string }).evalRunId;
    const unavailable = await app.request(`/api/v1/eval-runs/${generalId}/assessment-receipt`, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(unavailable.status).toBe(409);

    const before = await repo.getDashboardSummary();
    const release = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({ purpose: "release_evidence", items: [{
        clientItemId: "isolated",
        input: { q: "bad" },
        output: { answer: "wrong and incorrect" },
        metadata: {}
      }] })
    });
    const releaseId = (await release.json() as { evalRunId: string }).evalRunId;
    const run = await repo.getEvalRunDetail(PROJECT, releaseId);
    if (!run) throw new Error("release run missing");
    const after = await repo.getDashboardSummary();
    expect(after.project.importedTraceCount).toBe(before.project.importedTraceCount);
    expect(after.project.autoJudgedTraceCount).toBe(before.project.autoJudgedTraceCount);
    expect(after.verdictDistribution).toEqual(before.verdictDistribution);
    expect(await repo.listCaseIdsForProject(PROJECT)).not.toContain(run.items[0]!.caseId);
    await expect(repo.promoteExceptionToGoldenSet({
      projectId: PROJECT,
      caseId: run.items[0]!.caseId,
      agreedLabel: "fail",
      reason: "must stay isolated"
    })).rejects.toBeInstanceOf(CaseNotFoundError);
  });
});
