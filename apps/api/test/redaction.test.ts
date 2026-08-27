import { describe, expect, it } from "vitest";
import type { JudgeProvider } from "@coeval/audit/runtime";
import { DemoRepository } from "../src/repository.js";
import { processJudgeRunJob } from "../src/workers/judge.js";
import { CYCLE_VALUE, EXCLUDED_VALUE, MAX_DEPTH_VALUE, REDACTED_VALUE, TRUNCATED_SUFFIX, redactJson } from "../src/lib/redaction.js";

describe("trace redaction", () => {
  it("redacts sensitive keys, excludes configured paths, and truncates large strings", () => {
    const redacted = redactJson({
      input: {
        question: "Can I get a refund?",
        authorization: "Bearer secret-token",
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "internal retrieval context" }
        ]
      },
      output: {
        answer: "x".repeat(12),
        apiKey: "sk-test"
      },
      metadata: {
        extra: {
          headers: {
            cookie: "session=abc"
          }
        }
      }
    }, {
      excludedPaths: ["input.messages[1].content"],
      maxStringChars: 5
    });

    expect(redacted).toMatchObject({
      input: {
        question: "Can I get a refund?".slice(0, 5) + TRUNCATED_SUFFIX,
        authorization: REDACTED_VALUE,
        messages: [
          { role: "user", content: "hello" },
          { role: "syste" + TRUNCATED_SUFFIX, content: EXCLUDED_VALUE }
        ]
      },
      output: {
        answer: "xxxxx" + TRUNCATED_SUFFIX,
        apiKey: REDACTED_VALUE
      },
      metadata: {
        extra: {
          headers: {
            cookie: REDACTED_VALUE
          }
        }
      }
    });
  });

  it("does not redact token telemetry keys as secrets", () => {
    expect(redactJson({
      usage: {
        total_tokens: 1234,
        prompt_tokens: 567,
        completionTokens: 667,
        token_count: 42,
        tokenizer: "cl100k_base"
      },
      authToken: "secret",
      access_token: "secret",
      apiKey: "secret"
    })).toEqual({
      usage: {
        total_tokens: 1234,
        prompt_tokens: 567,
        completionTokens: 667,
        token_count: 42,
        tokenizer: "cl100k_base"
      },
      authToken: REDACTED_VALUE,
      access_token: REDACTED_VALUE,
      apiKey: REDACTED_VALUE
    });
  });

  it("handles cycles, deep objects, malformed paths, and idempotent re-redaction", () => {
    const cyclic: Record<string, unknown> = { api_key: "secret" };
    cyclic.self = cyclic;
    expect(redactJson(cyclic)).toEqual({ api_key: REDACTED_VALUE, self: CYCLE_VALUE });

    let deep: Record<string, unknown> = { value: "bottom" };
    for (let index = 0; index < 205; index += 1) deep = { nested: deep };
    expect(JSON.stringify(redactJson(deep))).toContain(MAX_DEPTH_VALUE);

    expect(() => redactJson({ input: { headers: { authorization: "secret" } } }, {
      excludedPaths: ["input.[headers].authorization"]
    })).toThrow(/Bracket notation supports only numeric indexes/);

    const once = redactJson({ token: "secret", keep: "value" });
    expect(redactJson(once)).toEqual(once);
  });

  it("passes only redacted trace payloads to judge providers", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "manual_sensitive_trace",
      input: {
        question: "Can I get a refund?",
        api_key: "sk-live-secret",
        context: { raw: "do not send" }
      },
      output: {
        answer: "Yes.",
        token: "customer-token"
      },
      metadata: {
        headers: { authorization: "Bearer customer-token" }
      }
    }, {
      ingestionPurpose: "analysis_eligible_manual",
      redactionConfig: {
        excludedPaths: ["input.context.raw"]
      }
    });

    let capturedTrace: unknown;
    const judgeProvider: JudgeProvider = {
      name: "capture",
      modelName: "capture-model",
      async judge(input) {
        capturedTrace = input.trace;
        return { label: "pass", score: 1, reason: "ok", confidence: 1 };
      },
      async judgeStructured(input) {
        capturedTrace = input.trace;
        return { verdict: { kind: "binary", label: "pass", score: 1, rationale: "ok" } };
      }
    };

    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider);

    expect(capturedTrace).toMatchObject({
      id: "manual_sensitive_trace",
      input: {
        question: "Can I get a refund?",
        api_key: REDACTED_VALUE,
        context: { raw: EXCLUDED_VALUE }
      },
      output: {
        answer: "Yes.",
        token: REDACTED_VALUE
      },
      metadata: {
        headers: { authorization: REDACTED_VALUE }
      }
    });
  });

  // steps ride inside the payload — redaction must walk each step with
  // the same rules as the top level, and the judge-bound trace must carry them.
  it("redacts each trajectory step's input/output/metadata and keeps step order", async () => {
    const { redactNormalizedTracePayload } = await import("../src/lib/redaction.js");
    const redacted = redactNormalizedTracePayload({
      input: { goal: "book a flight" },
      output: { summary: "booked" },
      metadata: {},
      steps: [
        {
          name: "search",
          input: { query: "flights", api_key: "sk-live-1" },
          output: { results: 3 },
          metadata: { headers: { authorization: "Bearer x" } }
        },
        {
          name: "book",
          input: { card: "4111-1111", passenger: "Ada" },
          output: { token: "conf-secret", confirmation: "OK-1" }
        }
      ]
    }, {
      // Paths are absolute from the payload root — steps[N] addressing, no re-rooting.
      excludedPaths: ["steps[1].input.card"]
    });

    expect(redacted.steps).toEqual([
      {
        name: "search",
        input: { query: "flights", api_key: REDACTED_VALUE },
        output: { results: 3 },
        metadata: { headers: { authorization: REDACTED_VALUE } }
      },
      {
        name: "book",
        input: { card: EXCLUDED_VALUE, passenger: "Ada" },
        output: { token: REDACTED_VALUE, confirmation: "OK-1" }
      }
    ]);
    // A top-level path must NOT re-root into steps.
    const rerooted = redactNormalizedTracePayload({
      input: { card: "top" },
      output: null,
      metadata: {},
      steps: [{ input: { card: "step" }, output: null }]
    }, { excludedPaths: ["input.card"] });
    expect(rerooted.input).toEqual({ card: EXCLUDED_VALUE });
    expect((rerooted.steps?.[0]?.input as { card: string }).card).toBe("step");
  });

  it("delivers redacted steps on the judge-bound trace (loadJudgeRunContext path)", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "manual_trajectory_trace",
      input: { goal: "refund the customer" },
      output: { summary: "refunded" },
      metadata: {},
      steps: [
        { name: "lookup", input: { order: 4512 }, output: { found: true } },
        { name: "refund", input: { amount: 12, api_key: "sk-live-2" }, output: { ok: true } }
      ]
    }, { ingestionPurpose: "analysis_eligible_manual" });

    let capturedTrace: unknown;
    const judgeProvider: JudgeProvider = {
      name: "capture",
      modelName: "capture-model",
      async judge(input) {
        capturedTrace = input.trace;
        return { label: "pass", score: 1, reason: "ok", confidence: 1 };
      },
      async judgeStructured(input) {
        capturedTrace = input.trace;
        return { verdict: { kind: "binary", label: "pass", score: 1, rationale: "ok" } };
      }
    };

    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider);

    expect(capturedTrace).toMatchObject({
      id: "manual_trajectory_trace",
      steps: [
        { name: "lookup", input: { order: 4512 } },
        { name: "refund", input: { amount: 12, api_key: REDACTED_VALUE } }
      ]
    });
  });
});
