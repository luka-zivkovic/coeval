// node --test coverage for the SDK-free client core of the coeval MCP server.
// The stdio entry (index.mjs) only registers these functions as tools, so the
// contract lives here where it can run without installing the MCP SDK.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoevalClient, exampleToBatchItem } from "./lib.mjs";

const KEY = "coeval_sk_mcp-test-key";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function recordingFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, respond] of routes) {
      if (String(url).includes(match)) return respond(calls.length);
    }
    return jsonResponse(404, { error: "not found" });
  };
  return { calls, fetchImpl };
}

function client(fetchImpl) {
  return createCoevalClient({
    baseUrl: "https://coeval.example",
    apiKey: KEY,
    fetchImpl,
    sleep: async () => {}
  });
}

test("requires COEVAL_URL and COEVAL_API_KEY without printing values", () => {
  assert.throws(() => createCoevalClient({ baseUrl: "", apiKey: KEY }), /COEVAL_URL/);
  const error = (() => {
    try {
      createCoevalClient({ baseUrl: "https://coeval.example", apiKey: "" });
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.match(error.message, /COEVAL_API_KEY/);
  assert.ok(!error.message.includes(KEY));
});

test("read tools hit the expected endpoints with bearer auth and query params", async () => {
  const { calls, fetchImpl } = recordingFetch([
    ["/api/v1/project", () => jsonResponse(200, { projectId: "proj_1" })],
    ["/api/v1/findings", () => jsonResponse(200, { goldenSet: { size: 1 } })],
    ["/api/v1/cases", () => jsonResponse(200, { cases: [] })],
    ["/api/v1/golden-set", () => jsonResponse(200, { entries: [], totalEntries: 0 })]
  ]);
  const coeval = client(fetchImpl);

  await coeval.getProject();
  await coeval.getFindings({ since: "2026-08-01T00:00:00Z" });
  await coeval.getCases({ verdict: "fail", stratum: "billing", limit: 10 });
  await coeval.getGolden({});

  assert.equal(calls[0].url, "https://coeval.example/api/v1/project");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[1].url, `https://coeval.example/api/v1/findings?since=${encodeURIComponent("2026-08-01T00:00:00Z")}`);
  assert.equal(calls[2].url, "https://coeval.example/api/v1/cases?verdict=fail&stratum=billing&limit=10");
  assert.equal(calls[3].url, "https://coeval.example/api/v1/golden-set");
});

test("HTTP errors surface status + server message, never the key", async () => {
  const { fetchImpl } = recordingFetch([
    ["/api/v1/findings", () => jsonResponse(401, { error: "Invalid or revoked API key." })]
  ]);
  await assert.rejects(
    () => client(fetchImpl).getFindings({}),
    (error) => {
      assert.match(error.message, /401/);
      assert.match(error.message, /Invalid or revoked API key/);
      assert.ok(!error.message.includes(KEY));
      return true;
    }
  );
});

// DRIFT GUARD companion: identical content must mint the identical
// sourceTraceId that tools/ci/gate.mjs and coeval-submit.mjs mint, or
// idempotency breaks across clients (re-submitting unchanged examples would
// re-judge and re-spend).
test("exampleToBatchItem mints the shared ci_ content hash", () => {
  const item = exampleToBatchItem({ input: "q", output: "a", expected: "pass", name: "n" }, 0);
  assert.match(item.sourceTraceId, /^ci_[0-9a-f]{32}$/);
  assert.equal(item.expectedLabel, "pass");
  assert.equal(item.metadata.name, "n");
  // steps join the hash only when present — a step-less example keeps its hash.
  const again = exampleToBatchItem({ input: "q", output: "a" }, 0);
  assert.equal(again.sourceTraceId, item.sourceTraceId);
  const stepped = exampleToBatchItem({ input: "q", output: "a", steps: [{ input: "s", output: "t" }] }, 0);
  assert.notEqual(stepped.sourceTraceId, item.sourceTraceId);
});

test("exampleToBatchItem rejects malformed rows loudly", () => {
  assert.throws(() => exampleToBatchItem({ input: "q", output: "a", expected: "maybe" }, 3), /pass/);
  assert.throws(() => exampleToBatchItem({ input: "q", output: "a", steps: "not-an-array" }, 1), /steps/);
  assert.throws(
    () => exampleToBatchItem({ input: "q", output: "a", expected: "pass", expectedFailStep: 0, steps: [{ input: "s", output: "t" }] }, 2),
    /expectedFailStep/
  );
});

test("submitRuns posts the batch and polls until terminal", async () => {
  const run = {
    status: "completed",
    skillVersionId: "skillv_1",
    agreedItems: 1,
    items: [
      { caseId: "case_1", status: "completed", expectedLabel: "pass", resultLabel: "pass", agreement: true }
    ]
  };
  let polls = 0;
  const { calls, fetchImpl } = recordingFetch([
    ["/api/v1/judge/batch", () => jsonResponse(202, {
      evalRunId: "eval_1", status: "running", totalItems: 1, cachedItems: 0, skippedItems: 0,
      pollUrl: "/api/v1/eval-runs/eval_1"
    })],
    ["/api/v1/eval-runs/eval_1", () => {
      polls += 1;
      return jsonResponse(200, polls === 1 ? { ...run, status: "running" } : run);
    }]
  ]);
  const result = await client(fetchImpl).submitRuns({
    items: [{ input: "q", output: "a", expected: "pass" }]
  });
  assert.equal(result.evalRunId, "eval_1");
  assert.equal(result.status, "completed");
  assert.equal(result.agreedItems, 1);
  assert.equal(polls, 2);
  const posted = JSON.parse(calls[0].init.body);
  assert.match(posted.items[0].sourceTraceId, /^ci_/);
});

test("run_gate_check passes only when agreement meets the threshold", async () => {
  const run = {
    status: "completed",
    skillVersionId: "skillv_1",
    agreedItems: 2,
    items: [
      { caseId: "case_1", status: "completed", expectedLabel: "pass", resultLabel: "pass", agreement: true },
      { caseId: "case_2", status: "completed", expectedLabel: "fail", resultLabel: "fail", agreement: true }
    ]
  };
  const { fetchImpl } = recordingFetch([
    ["/api/v1/judge/batch", () => jsonResponse(202, { evalRunId: "eval_g", status: "completed", totalItems: 2, cachedItems: 2, skippedItems: 0, pollUrl: "/api/v1/eval-runs/eval_g" })],
    ["/api/v1/eval-runs/eval_g", () => jsonResponse(200, run)]
  ]);
  const result = await client(fetchImpl).runGateCheck({
    examples: [
      { input: "q1", output: "a1", expected: "pass" },
      { input: "q2", output: "a2", expected: "fail" }
    ]
  });
  assert.equal(result.passed, true);
  assert.equal(result.agreement.agreed, 2);
  assert.equal(result.agreement.labeled, 2);
});

test("run_gate_check blocks on disagreement and requires labels", async () => {
  const run = {
    status: "completed",
    skillVersionId: "skillv_1",
    agreedItems: 1,
    items: [
      { caseId: "case_1", status: "completed", expectedLabel: "pass", resultLabel: "pass", agreement: true },
      { caseId: "case_2", status: "completed", expectedLabel: "fail", resultLabel: "pass", agreement: false }
    ]
  };
  const { fetchImpl } = recordingFetch([
    ["/api/v1/judge/batch", () => jsonResponse(202, { evalRunId: "eval_b", status: "completed", totalItems: 2, cachedItems: 0, skippedItems: 0, pollUrl: "/api/v1/eval-runs/eval_b" })],
    ["/api/v1/eval-runs/eval_b", () => jsonResponse(200, run)]
  ]);
  const coeval = client(fetchImpl);
  const blocked = await coeval.runGateCheck({
    examples: [
      { input: "q1", output: "a1", expected: "pass" },
      { input: "q2", output: "a2", expected: "fail" }
    ]
  });
  assert.equal(blocked.passed, false);
  assert.match(blocked.blockedReason, /agreement/i);

  await assert.rejects(
    () => coeval.runGateCheck({ examples: [{ input: "q", output: "a" }] }),
    /label/
  );
});

test("a gate that could not judge must not pass (infra failure)", async () => {
  const run = {
    status: "completed",
    skillVersionId: "skillv_1",
    agreedItems: 1,
    items: [
      { caseId: "case_1", status: "completed", expectedLabel: "pass", resultLabel: "pass", agreement: true },
      { caseId: "case_2", status: "failed", expectedLabel: "fail", resultLabel: null, agreement: null }
    ]
  };
  const { fetchImpl } = recordingFetch([
    ["/api/v1/judge/batch", () => jsonResponse(202, { evalRunId: "eval_f", status: "completed", totalItems: 2, cachedItems: 0, skippedItems: 0, pollUrl: "/api/v1/eval-runs/eval_f" })],
    ["/api/v1/eval-runs/eval_f", () => jsonResponse(200, run)]
  ]);
  const result = await client(fetchImpl).runGateCheck({
    examples: [
      { input: "q1", output: "a1", expected: "pass" },
      { input: "q2", output: "a2", expected: "fail" }
    ]
  });
  assert.equal(result.passed, false);
  assert.match(result.blockedReason, /infrastructure/i);
});

test("submitRuns times out with a config-shaped error", async () => {
  const { fetchImpl } = recordingFetch([
    ["/api/v1/judge/batch", () => jsonResponse(202, { evalRunId: "eval_t", status: "running", totalItems: 1, cachedItems: 0, skippedItems: 0, pollUrl: "/api/v1/eval-runs/eval_t" })],
    ["/api/v1/eval-runs/eval_t", () => jsonResponse(200, { status: "running", items: [] })]
  ]);
  await assert.rejects(
    () => client(fetchImpl).submitRuns({
      items: [{ input: "q", output: "a" }],
      timeoutSeconds: 0
    }),
    /timeout|still running/i
  );
});

test("run_gate_check blocks when the server skipped proposed examples", async () => {
  const run = {
    status: "completed",
    skillVersionId: "skillv_1",
    agreedItems: 1,
    items: [
      { caseId: "case_1", status: "completed", expectedLabel: "pass", resultLabel: "pass", agreement: true }
    ]
  };
  const { fetchImpl } = recordingFetch([
    ["/api/v1/judge/batch", () => jsonResponse(202, { evalRunId: "eval_s", status: "completed", totalItems: 1, cachedItems: 0, skippedItems: 1, pollUrl: "/api/v1/eval-runs/eval_s" })],
    ["/api/v1/eval-runs/eval_s", () => jsonResponse(200, run)]
  ]);
  const result = await client(fetchImpl).runGateCheck({
    examples: [
      { input: "q1", output: "a1", expected: "pass" },
      { input: "q2", output: "a2", expected: "fail" }
    ]
  });
  assert.equal(result.passed, false);
  assert.equal(result.skippedItems, 1);
  assert.match(result.blockedReason, /skipped/);
});
