import { afterEach, describe, expect, it, vi } from "vitest";
import { AssessmentReceiptV2Schema, type AssessmentReceiptV2, type EvalRunDetail, type VerdictRecord } from "@rubrist/shared";
import { createApp } from "../src/app.js";
import { canonicalJson, contentDigest, sha256Digest } from "../src/lib/canonical-json.js";
import {
  buildAssessmentReceiptV2,
  evidenceDigestForReceiptV2,
  verifyAssessmentReceiptV2
} from "../src/lib/assessment-receipt-v2.js";
import { evaluatorIdentityFor, skillDigestInput, skillDigestV2 } from "../src/lib/evaluator-identity.js";
import { CaseNotFoundError, DemoRepository } from "../src/repository.js";
import { MOCK_BINDING, SEEDED_BINDING, bindingInput } from "./fixtures/execution-binding.js";

// Assessment receipt v2 (ADR-0014 sections 6 and 7): built from a terminal
// release-evidence run, each outcome carrying its verdict's score and what its
// call observed.

const PROJECT = "proj_langsmith_support";
const VERSION = "skillv_1_2_0";
const NOTHING = { model: null, requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null };

async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "release-evidence-test" })
  });
  return (await response.json() as { key: string }).key;
}

/** A mock-bound version, which the demo makes current: its calls report what they observed. */
async function useMockEvaluator(app: ReturnType<typeof createApp>): Promise<string> {
  const created = await app.request("/api/skills/skill_support_quality/versions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rubricMarkdown: "Pass grounded answers.", prompt: "Judge the answer.", executionBinding: bindingInput(MOCK_BINDING) })
  });
  expect(created.status).toBe(201);
  return (await created.json() as { version: { id: string } }).version.id;
}

/** A release-evidence run with pending items, to finish by hand. */
async function pendingRun(repo: DemoRepository, clientItemIds: string[]): Promise<EvalRunDetail> {
  return repo.createEvalRun({
    projectId: PROJECT,
    skillVersionId: VERSION,
    trigger: "release_evidence",
    items: clientItemIds.map((clientItemId) => ({
      caseId: `case_${clientItemId}`,
      clientItemId,
      contentDigest: contentDigest({ q: clientItemId }, { a: clientItemId })
    }))
  });
}

function verdict(id: string, overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return {
    id,
    projectId: PROJECT,
    caseId: `case_${id}`,
    source: "llm_judge",
    skillVersionId: VERSION,
    payload: { kind: "binary", pass: true, rationale: "grounded" },
    observed: { ...NOTHING, model: "claude-sonnet-4-6", requestId: `req_${id}` },
    evaluatorScore: { value: 0.9, kind: "self_reported_score" },
    createdAt: "2026-09-26T00:00:00.000Z",
    ...overrides
  } as VerdictRecord;
}

/** The run finished with one outcome per label, in the order given. */
function finished(run: EvalRunDetail, labels: Array<"pass" | "fail" | "ambiguous">): EvalRunDetail {
  return {
    ...run,
    status: "completed",
    completedItems: labels.length,
    items: run.items.map((item, index) => ({
      ...item,
      status: "completed",
      verdictId: `verdict_${item.clientItemId}`,
      resultLabel: labels[index]!
    }))
  };
}

function verdictsFor(run: EvalRunDetail): Map<string, VerdictRecord> {
  return new Map(run.items.flatMap((item) => item.verdictId ? [[item.verdictId, verdict(item.verdictId)] as const] : []));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("assessment receipt v2 evidence", () => {
  it("canonicalizes object keys recursively while retaining array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 1 }, list: [{ d: 4, c: 3 }, 2, 1] }))
      .toBe('{"a":{"b":1,"y":2},"list":[{"c":3,"d":4},2,1],"z":1}');
    expect(sha256Digest({ b: 2, a: 1 })).toBe(sha256Digest({ a: 1, b: 2 }));
  });

  it("builds a verified, deterministic receipt of each outcome's verdict score and observation, sorted by clientItemId", async () => {
    const repo = new DemoRepository();
    const version = (await repo.getSkillVersion(PROJECT, VERSION))!;
    const run = finished(await pendingRun(repo, ["c", "a", "b"]), ["pass", "fail", "ambiguous"]);
    const verdicts = verdictsFor(run);
    const receipt = buildAssessmentReceiptV2({ run, skillVersion: version, verdicts });

    expect(AssessmentReceiptV2Schema.parse(receipt)).toEqual(receipt);
    expect(() => verifyAssessmentReceiptV2(receipt, { evalRunId: run.id, skillVersionId: VERSION, skillDigest: skillDigestV2(evaluatorIdentityFor(version)) })).not.toThrow();
    expect(receipt).toMatchObject({
      contract: "rubrist/assessment-receipt/v2",
      schemaVersion: 2,
      receiptId: `receipt_${run.id}`,
      status: "complete",
      evaluator: skillDigestInput(evaluatorIdentityFor(version)),
      run: { status: "completed", totalItems: 3, passItems: 1, failItems: 1, abstainedItems: 1, failedItems: 0, notAttemptedItems: 0 }
    });
    // Receipts carry the definition digest, never its text.
    expect(JSON.stringify(receipt)).not.toContain(version.rubricMarkdown);
    expect(receipt.items.map((item) => [item.clientItemId, item.result])).toEqual([
      ["a", { state: "outcome", outcome: "fail" }],
      ["b", { state: "outcome", outcome: "abstain" }],
      ["c", { state: "outcome", outcome: "pass" }]
    ]);
    expect(receipt.items[0]).toMatchObject({
      verdictId: "verdict_a",
      evaluatorScore: { value: 0.9, kind: "self_reported_score" },
      observed: { ...NOTHING, model: "claude-sonnet-4-6", requestId: "req_verdict_a" }
    });
    expect(receipt.datasetDigest).toBe(sha256Digest(receipt.items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest }))));
    expect(buildAssessmentReceiptV2({ run, skillVersion: version, verdicts })).toEqual(receipt);
  });

  it("states a failure's kind and observation and each item never attempted, which leave it incomplete", async () => {
    const repo = new DemoRepository();
    const version = (await repo.getSkillVersion(PROJECT, VERSION))!;
    const run = await pendingRun(repo, ["done", "timed_out", "refused", "never_started"]);
    const observed = { ...NOTHING, requestId: "req_timeout" };
    const ended: EvalRunDetail = {
      ...run,
      status: "canceled",
      items: run.items.map((item) => {
        if (item.clientItemId === "done") return { ...item, status: "completed", verdictId: "verdict_done", resultLabel: "pass" };
        if (item.clientItemId === "timed_out") return { ...item, status: "failed", failureKind: "provider_timeout", observed, error: "timed out" };
        if (item.clientItemId === "refused") return { ...item, status: "failed", notAttempted: true, error: "no key" };
        return item;
      })
    };
    const receipt = buildAssessmentReceiptV2({ run: ended, skillVersion: version, verdicts: verdictsFor(ended) });
    expect(receipt.status).toBe("incomplete");
    expect(receipt.run).toMatchObject({ status: "canceled", totalItems: 4, passItems: 1, failedItems: 1, notAttemptedItems: 2 });
    expect(Object.fromEntries(receipt.items.map((item) => [item.clientItemId, [item.result, item.observed, item.verdictId]]))).toEqual({
      done: [{ state: "outcome", outcome: "pass" }, expect.any(Object), "verdict_done"],
      timed_out: [{ state: "failure", failureKind: "provider_timeout" }, observed, null],
      refused: [{ state: "not_attempted" }, null, null],
      never_started: [{ state: "not_attempted" }, null, null]
    });
  });

  it("refuses an outcome whose verdict recorded no observation, never synthesizing one", async () => {
    const repo = new DemoRepository();
    const version = (await repo.getSkillVersion(PROJECT, VERSION))!;
    const run = finished(await pendingRun(repo, ["a"]), ["pass"]);
    const unobserved = new Map([["verdict_a", verdict("verdict_a", { observed: null, evaluatorScore: null })]]);
    expect(() => buildAssessmentReceiptV2({ run, skillVersion: version, verdicts: unobserved })).toThrow(/recorded no call observation/);
    expect(() => buildAssessmentReceiptV2({ run, skillVersion: version, verdicts: new Map() })).toThrow(/has no recorded verdict/);
  });

  it("changes the evidence digest for every evidence class and exposes no release-policy decision field", async () => {
    const repo = new DemoRepository();
    const version = (await repo.getSkillVersion(PROJECT, VERSION))!;
    const run = finished(await pendingRun(repo, ["a"]), ["pass"]);
    const receipt = buildAssessmentReceiptV2({ run, skillVersion: version, verdicts: verdictsFor(run) });
    const mutations: Array<[string, (candidate: AssessmentReceiptV2) => void]> = [
      ["receipt identity", (candidate) => { candidate.receiptId = "receipt_tampered"; }],
      ["run counters", (candidate) => { candidate.run.passItems = 0; }],
      ["execution binding", (candidate) => { candidate.evaluator.executionBinding.modelId = "other-model"; }],
      ["definition digest", (candidate) => { candidate.evaluator.definitionDigest = contentDigest("other", "definition"); }],
      ["dataset digest", (candidate) => { candidate.datasetDigest = contentDigest("other", "dataset"); }],
      ["item result", (candidate) => { candidate.items[0]!.result = { state: "outcome", outcome: "fail" }; }],
      ["item content", (candidate) => { candidate.items[0]!.contentDigest = contentDigest("other", "content"); }],
      ["evaluator score", (candidate) => { candidate.items[0]!.evaluatorScore = { value: 0.1, kind: "self_reported_score" }; }],
      ["observation", (candidate) => { candidate.items[0]!.observed!.requestId = "req-tampered"; }]
    ];
    for (const [name, mutate] of mutations) {
      const candidate = structuredClone(receipt);
      mutate(candidate);
      expect(evidenceDigestForReceiptV2(candidate), name).not.toBe(receipt.evidenceDigest);
    }

    const forbidden = new Set(["threshold", "decision", "ship", "hold", "deploy", "rolloutPolicy", "maxDisagreements"]);
    const allKeys = (value: unknown): string[] => Array.isArray(value)
      ? value.flatMap(allKeys)
      : value && typeof value === "object"
        ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...allKeys(child)])
        : [];
    expect(allKeys(receipt).filter((key) => forbidden.has(key))).toEqual([]);
  });
});

describe("release_evidence batch and receipt routes", () => {
  it("requires unique clientItemIds and forbids dataset promotion", async () => {
    const repo = new DemoRepository();
    const app = createApp(repo);
    await useMockEvaluator(app);
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
    const receipt = AssessmentReceiptV2Schema.parse(await (await app.request(
      `/api/v1/eval-runs/${acceptedId}/assessment-receipt`,
      { headers: { authorization: `Bearer ${key}` } }
    )).json());
    expect(receipt.items[0]!.clientItemId).toBe(exactId);
  });

  it("retains two identical submissions, verifies pre-redaction digests, and records each call's observation", async () => {
    const repo = new DemoRepository();
    const app = createApp(repo);
    const versionId = await useMockEvaluator(app);
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
    const receipt = AssessmentReceiptV2Schema.parse(await response.json());
    const version = (await repo.getSkillVersion(PROJECT, versionId))!;
    expect(() => verifyAssessmentReceiptV2(receipt, { evalRunId, skillVersionId: versionId, skillDigest: skillDigestV2(evaluatorIdentityFor(version)) }))
      .not.toThrow();
    expect(receipt.status).toBe("complete");
    expect(receipt.evaluator.executionBinding).toEqual(MOCK_BINDING);
    expect(receipt.items.map((item) => item.clientItemId)).toEqual(["dailies-a", "dailies-b"]);
    expect(new Set(receipt.items.map((item) => item.caseId)).size).toBe(2);
    expect(receipt.items.every((item) => item.contentDigest === contentDigest(input, output))).toBe(true);
    expect(receipt.items.every((item) => item.observed?.model === "mock-heuristic-v1" && item.evaluatorScore !== null)).toBe(true);

    // Import changed the stored judge content without changing the
    // caller-verifiable digest recorded before that import.
    for (const item of receipt.items) {
      const stored = await (await app.request(`/api/cases/${item.caseId}`)).json() as {
        trace: { input: { api_key: string }; output: { token: string } };
      };
      expect(stored.trace.input.api_key).toBe("[REDACTED]");
      expect(stored.trace.output.token).toBe("[REDACTED]");
    }
  });

  it("judges release evidence only with the bound evaluator: without its key nothing is attempted", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const app = createApp(new DemoRepository());
    const key = await mintKey(app);
    const submitted = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ purpose: "release_evidence", items: [{ clientItemId: "one", input: { q: 1 }, output: { a: 1 }, metadata: {} }] })
    });
    const { evalRunId } = await submitted.json() as { evalRunId: string };
    const receipt = AssessmentReceiptV2Schema.parse(await (await app.request(
      `/api/v1/eval-runs/${evalRunId}/assessment-receipt`,
      { headers: { authorization: `Bearer ${key}` } }
    )).json());
    expect(receipt.status).toBe("incomplete");
    expect(receipt.evaluator.executionBinding.provider).toBe("anthropic");
    expect(receipt.items[0]).toMatchObject({ result: { state: "not_attempted" }, observed: null, verdictId: null });
  });

  it("reuses only a recorded verdict that states its call's observation", async () => {
    const repo = new DemoRepository();
    const app = createApp(repo);
    const versionId = await useMockEvaluator(app);
    const key = await mintKey(app);
    const submit = async () => (await (await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ purpose: "release_evidence", items: [{ clientItemId: "same", input: { q: "same" }, output: { a: "same" }, metadata: {} }] })
    })).json()) as { evalRunId: string; cachedItems: number };

    const first = await submit();
    expect(first.cachedItems).toBe(0);
    expect((await submit()).cachedItems).toBe(1);

    const caseId = (await repo.getEvalRunDetail(PROJECT, first.evalRunId))!.items[0]!.caseId;
    await repo.recordVerdict({
      projectId: PROJECT, caseId, source: "llm_judge", skillVersionId: versionId,
      payload: { kind: "binary", pass: true, rationale: "recorded without an observation" }
    });
    const rejudged = await submit();
    expect(rejudged.cachedItems).toBe(0);
    const receipt = AssessmentReceiptV2Schema.parse(await (await app.request(
      `/api/v1/eval-runs/${rejudged.evalRunId}/assessment-receipt`,
      { headers: { authorization: `Bearer ${key}` } }
    )).json());
    expect(receipt.status).toBe("complete");
    expect(receipt.items[0]!.observed?.model).toBe("mock-heuristic-v1");
  });

  it("finishes a run whose gateway names an upstream in an error, with no upstream in the receipt", async () => {
    class KeyedRepository extends DemoRepository {
      override async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
        return provider === "custom" ? "sk-gateway" : super.getJudgeProviderCredential(projectId, provider);
      }
    }
    const repo = new KeyedRepository();
    const app = createApp(repo);
    const created = await app.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "Pass grounded answers.",
        prompt: "Judge the answer.",
        executionBinding: bindingInput(SEEDED_BINDING, {
          provider: "custom",
          endpoint: { kind: "custom", baseUrl: "https://models.example.test/v1" },
          reasoning: null,
          verdictProtocol: "openai.forced-function/v1"
        })
      })
    });
    expect(created.status).toBe(201);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) {
        // An OpenRouter-shaped error from a gateway that isn't OpenRouter.
        return new Response(JSON.stringify({ error: { code: 400, message: "Provider returned error", metadata: { provider_name: "Azure" } } }), { status: 400 });
      }
      return new Response(JSON.stringify({
        id: "c",
        model: "llama-observed",
        choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_verdict", arguments: JSON.stringify({ label: "pass", score: 0.9, rationale: "ok" }) } }] }, finish_reason: "tool_calls" }]
      }));
    });
    const key = await mintKey(app);
    const submitted = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ purpose: "release_evidence", items: [
        { clientItemId: "first", input: { q: 1 }, output: { a: 1 }, metadata: {} },
        { clientItemId: "second", input: { q: 2 }, output: { a: 2 }, metadata: {} }
      ] })
    });
    const { evalRunId } = await submitted.json() as { evalRunId: string };
    expect(calls).toBe(2);
    const response = await app.request(`/api/v1/eval-runs/${evalRunId}/assessment-receipt`, { headers: { authorization: `Bearer ${key}` } });
    expect(response.status).toBe(200);
    const receipt = AssessmentReceiptV2Schema.parse(await response.json());
    expect(receipt.status).toBe("incomplete");
    expect(receipt.items.map((item) => [item.clientItemId, item.result, item.observed?.upstreamProvider ?? null])).toEqual([
      ["first", { state: "failure", failureKind: "provider_rejected_request" }, null],
      ["second", { state: "outcome", outcome: "pass" }, null]
    ]);
  });

  it("refuses a version without an evaluator identity before importing anything", async () => {
    class BrokenIdentityRepository extends DemoRepository {
      override async getSkillVersion(projectId: string, versionId: string) {
        const version = await super.getSkillVersion(projectId, versionId);
        return version && { ...version, executionBinding: { ...version.executionBinding, modelId: "" } };
      }
    }
    const repo = new BrokenIdentityRepository();
    const app = createApp(repo);
    const key = await mintKey(app);
    const before = await repo.listCaseIdsForProject(PROJECT);
    const refused = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ purpose: "release_evidence", items: [{ clientItemId: "one", input: { q: 1 }, output: { a: 1 }, metadata: {} }] })
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "evaluator_identity_invalid" });
    expect(await repo.listCaseIdsForProject(PROJECT)).toEqual(before);
  });

  it("rejects receipts for general eval runs and keeps release evidence out of product surfaces", async () => {
    const repo = new DemoRepository();
    const app = createApp(repo);
    await useMockEvaluator(app);
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
