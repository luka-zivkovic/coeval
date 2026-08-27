// coeval MCP server — SDK-free client core (issue #10).
//
// Every tool is a thin wrapper over the existing HTTP API: the six functions
// returned by createCoevalClient map 1:1 onto the six MCP tools registered in
// index.mjs. Keeping them here (plain functions, injectable fetch) means the
// contract is testable with `node --test` and reusable against localhost or a
// hosted instance — the MCP layer is deliberately hosting-agnostic.
//
// The API key is only ever placed in the authorization header; it never
// appears in thrown errors or returned payloads.
import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Validate one example row and mint its batch item.
 *
 * DRIFT GUARD: the validation rules and the `ci_` content-hash recipe are
 * shared with tools/ci/gate.mjs and skills/coeval-audit/scripts/
 * coeval-submit.mjs (and the server's ex_ hash) — identical content must keep
 * minting identical sourceTraceIds across all three clients, or idempotency
 * breaks (unchanged examples would re-judge and re-spend). steps join the
 * hash ONLY when present; metadata never joins.
 */
export function exampleToBatchItem(row, index) {
  const where = `examples[${index}]`;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${where} must be an object`);
  }
  const label = row.expectedLabel ?? row.expected;
  if (label !== undefined && label !== null && label !== "pass" && label !== "fail") {
    throw new Error(`${where} expected label must be "pass" or "fail" (got ${JSON.stringify(label)})`);
  }
  if (row.steps !== undefined && !Array.isArray(row.steps)) {
    throw new Error(`${where} steps must be an array of {name?, input, output, metadata?}`);
  }
  const rawStep = row.expectedFailStep;
  if (rawStep !== undefined && rawStep !== null) {
    if (!Number.isInteger(rawStep) || rawStep < 0) {
      throw new Error(`${where} expectedFailStep must be a non-negative integer (got ${JSON.stringify(rawStep)})`);
    }
    if (label !== "fail") {
      throw new Error(`${where} expectedFailStep is only valid alongside "expected": "fail"`);
    }
    if (!Array.isArray(row.steps) || rawStep >= row.steps.length) {
      throw new Error(`${where} expectedFailStep ${rawStep} must index (0-based) this row's steps`);
    }
  }
  const contentHash = createHash("sha256")
    .update(JSON.stringify({
      input: row.input ?? null,
      output: row.output ?? null,
      ...(row.steps ? { steps: row.steps } : {})
    }))
    .digest("hex")
    .slice(0, 32);
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? { ...row.metadata }
    : {};
  if (typeof row.name === "string" && row.name) metadata.name = row.name;
  return {
    sourceTraceId: `ci_${contentHash}`,
    input: row.input ?? null,
    output: row.output ?? null,
    metadata,
    ...(row.steps ? { steps: row.steps } : {}),
    ...(label ? { expectedLabel: label } : {}),
    ...(rawStep !== undefined && rawStep !== null ? { expectedFailStep: rawStep } : {})
  };
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : "";
}

export function createCoevalClient({ baseUrl, apiKey, fetchImpl = fetch, sleep } = {}) {
  const url = (baseUrl ?? "").replace(/\/$/, "");
  if (!url) throw new Error("COEVAL_URL is not set — point it at the Coeval API (e.g. http://localhost:3001)");
  if (!apiKey) throw new Error("COEVAL_API_KEY is not set — mint a project key in Settings → API keys");
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function api(path, init = {}) {
    let response;
    try {
      response = await fetchImpl(`${url}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(init.headers ?? {})
        }
      });
    } catch (error) {
      throw new Error(`could not reach ${url}${path}: ${error instanceof Error ? error.message : error}`);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? body.error : "request failed";
      const retry = response.status === 429 ? " (rate limited — back off and retry)" : "";
      throw new Error(`${path} failed: HTTP ${response.status} — ${message}${retry}`);
    }
    return body;
  }

  async function submitAndPoll(items, { timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
    const submitted = await api("/api/v1/judge/batch", {
      method: "POST",
      body: JSON.stringify({ items })
    });
    const deadline = Date.now() + timeoutSeconds * 1000;
    let run;
    for (;;) {
      run = await api(submitted.pollUrl);
      if (run.status === "completed" || run.status === "failed") break;
      if (Date.now() > deadline) {
        throw new Error(`run ${submitted.evalRunId} still ${run.status} after the ${timeoutSeconds}s timeout — raise timeoutSeconds or check the API`);
      }
      await wait(pollIntervalMs);
    }
    return { submitted, run };
  }

  function runCounts(run) {
    const labeledCompleted = run.items.filter((item) => item.expectedLabel !== null && item.expectedLabel !== undefined && item.status === "completed").length;
    const failedItems = run.items.filter((item) => item.status === "failed").length;
    return { labeledCompleted, failedItems };
  }

  return {
    getProject: () => api("/api/v1/project"),

    getFindings: ({ since } = {}) => api(`/api/v1/findings${buildQuery({ since })}`),

    getCases: ({ verdict, stratum, since, limit } = {}) =>
      api(`/api/v1/cases${buildQuery({ verdict, stratum, since, limit })}`),

    getGolden: ({ since, criterionVersionId } = {}) =>
      api(`/api/v1/golden-set${buildQuery({ since, criterionVersionId })}`),

    // Plain submission via the existing batch contract: labels are optional
    // and agreement is informational. No thresholds, no verdict on the skill.
    async submitRuns({ items, timeoutSeconds, pollIntervalMs } = {}) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("items must be a non-empty array of { input, output, expected?, steps?, name?, metadata? }");
      }
      const batchItems = items.map((row, index) => exampleToBatchItem(row, index));
      const { submitted, run } = await submitAndPoll(batchItems, { timeoutSeconds, pollIntervalMs });
      const { labeledCompleted, failedItems } = runCounts(run);
      return {
        evalRunId: submitted.evalRunId,
        status: run.status,
        skillVersionId: run.skillVersionId,
        totalItems: submitted.totalItems,
        cachedItems: submitted.cachedItems,
        skippedItems: submitted.skippedItems,
        agreedItems: run.agreedItems,
        labeledCompleted,
        failedItems,
        items: run.items,
        ...(run.spend ? { spend: run.spend } : {})
      };
    },

    // The gate-check contract from tools/ci/gate.mjs, as a tool: candidate
    // outputs on labeled (typically golden) inputs, disagreements counted,
    // and a gate that could not judge must never pass. This is the
    // skill-patch validation primitive — NOT a write to human truth.
    async runGateCheck({ examples, minAgreement = 1.0, timeoutSeconds, pollIntervalMs } = {}) {
      if (!Array.isArray(examples) || examples.length === 0) {
        throw new Error("examples must be a non-empty array of { input, output, expected, steps?, name? }");
      }
      if (!Number.isFinite(minAgreement) || minAgreement < 0 || minAgreement > 1) {
        throw new Error("minAgreement must be a number in [0, 1]");
      }
      const items = examples.map((row, index) => exampleToBatchItem(row, index));
      if (!items.some((item) => item.expectedLabel)) {
        throw new Error('no example carries an expected label — nothing to gate (add "expected": "pass"|"fail")');
      }
      const { submitted, run } = await submitAndPoll(items, { timeoutSeconds, pollIntervalMs });
      const { labeledCompleted, failedItems } = runCounts(run);
      const agreement = labeledCompleted === 0 ? 0 : run.agreedItems / labeledCompleted;
      let blockedReason = null;
      if (run.status === "failed" || failedItems > 0) {
        blockedReason = "the run had infrastructure failures; a gate that could not judge must not pass";
      } else if ((submitted.skippedItems ?? 0) > 0) {
        // The submitter controls the metadata that can trigger server-side
        // skips — a gate judged over fewer examples than proposed must not
        // silently pass with a shrunken denominator.
        blockedReason = `${submitted.skippedItems} proposed example(s) were skipped by the server; a gate must judge everything it was given`;
      } else if (labeledCompleted === 0) {
        blockedReason = "no labeled example completed — nothing was gated";
      } else if (agreement < minAgreement) {
        blockedReason = `agreement ${run.agreedItems}/${labeledCompleted} is below the minAgreement ${minAgreement} threshold`;
      }
      return {
        passed: blockedReason === null,
        blockedReason,
        skippedItems: submitted.skippedItems ?? 0,
        evalRunId: submitted.evalRunId,
        skillVersionId: run.skillVersionId,
        agreement: { agreed: run.agreedItems, labeled: labeledCompleted },
        failedItems,
        items: run.items,
        ...(run.spend ? { spend: run.spend } : {})
      };
    }
  };
}
