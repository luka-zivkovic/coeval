import { afterEach, describe, expect, it } from "vitest";
import type { VerdictSpec } from "../src/llm/verdict-spec.js";
import { buildVerdictProtocolRequest } from "../src/protocols/verdict-protocols.js";
import { endpointBaseUrlDigest, type ExecutionBinding, type PromptedExecutionBinding } from "../src/execution/binding.js";
import { executeVerdict, type ExecutionFetch, type VerdictExecutionInput } from "../src/execution/execute.js";
import { EvaluatorCallError } from "../src/execution/failure.js";

const BINARY: VerdictSpec = { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null };
const TRACE = { id: "trace_1", input: { q: "Refund?" }, output: { a: "Yes, within 30 days." } };
const EVALUATOR = { rubricMarkdown: "Grounded answers pass.", prompt: "Judge the trace against the review guide below.\n\n<review_guide>\n{{rubric_markdown}}\n</review_guide>" };
const VERDICT = { label: "pass", score: 0.9, rationale: "Grounded in policy." };

const ANTHROPIC: ExecutionBinding = {
  provider: "anthropic",
  endpoint: { kind: "managed" },
  modelId: "claude-sonnet-4-6",
  modelVersion: "claude-sonnet-4-6",
  sampling: { temperature: 0, topP: null },
  reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: "high" },
  outputTokenLimit: 1200,
  verdictProtocol: "anthropic.structured-output/v1",
  routing: null
};

const OPENAI: ExecutionBinding = {
  provider: "openai",
  endpoint: { kind: "managed" },
  modelId: "gpt-5",
  modelVersion: "gpt-5-2026-08-01",
  sampling: { temperature: null, topP: null },
  reasoning: { family: "openai", effort: "low" },
  outputTokenLimit: 2000,
  verdictProtocol: "openai.structured-output/v1",
  routing: null
};

const OPENROUTER: ExecutionBinding = {
  ...OPENAI,
  provider: "openrouter",
  modelId: "anthropic/claude-sonnet-4.6",
  modelVersion: "anthropic/claude-sonnet-4.6",
  sampling: { temperature: 0.2, topP: 0.9 },
  reasoning: { family: "openrouter", enabled: true, effort: null, maxTokens: 2048 },
  verdictProtocol: "openai.forced-function/v1",
  routing: { requireParameters: true, allowFallbacks: false }
};

const CUSTOM_URL = "https://llm.internal.example/v1/";
const CUSTOM: ExecutionBinding = {
  ...OPENAI,
  provider: "custom",
  endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(CUSTOM_URL) },
  modelId: "qwen3-32b",
  modelVersion: "qwen3-32b",
  sampling: { temperature: 0, topP: null },
  reasoning: null,
  outputTokenLimit: null,
  verdictProtocol: "prompted-json/v1"
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect: string;
}

function stub(respond: (sent: Sent) => Response | Promise<Response>): { fetch: ExecutionFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      const entry = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown>, redirect: init.redirect };
      sent.push(entry);
      return respond(entry);
    }
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const anthropicText = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  model: "claude-sonnet-4-6-20260801",
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  usage: { input_tokens: 120, output_tokens: 30 },
  ...extra
});

const chatText = (content: unknown, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl_1",
  model: "gpt-5-2026-08-01",
  system_fingerprint: "fp_1",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } },
  ...extra
});

const chatToolCall = (args: string, extra: Record<string, unknown> = {}) => chatText(null, {
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "submit_verdict", arguments: args } }] }, finish_reason: "tool_calls" }],
  ...extra
});

function run(binding: ExecutionBinding, fetchStub: { fetch: ExecutionFetch }, overrides: Partial<VerdictExecutionInput> = {}) {
  return executeVerdict({
    binding,
    apiKey: "test-key",
    customBaseUrl: binding.endpoint.kind === "custom" ? CUSTOM_URL : null,
    ...EVALUATOR,
    trace: TRACE,
    spec: BINARY,
    fetch: fetchStub.fetch,
    ...overrides
  });
}

async function failure(promise: Promise<unknown>): Promise<EvaluatorCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EvaluatorCallError) return error;
    throw error;
  }
  throw new Error("expected an evaluator call failure");
}

afterEach(() => {
  delete process.env.OPENAI_BASE_URL;
});

// The protocol's own rendering, which the adapters send unchanged.
const protocolRequest = (binding: ExecutionBinding) =>
  buildVerdictProtocolRequest((binding as PromptedExecutionBinding).verdictProtocol, { ...EVALUATOR, trace: TRACE, spec: BINARY });

describe("complete request bodies", () => {
  it("pins the Messages body for an Anthropic structured-output binding", async () => {
    const http = stub(() => json(anthropicText(JSON.stringify(VERDICT))));
    await run(ANTHROPIC, http);
    const request = protocolRequest(ANTHROPIC);
    if (request.output.mechanism !== "structured_output") throw new Error("expected structured output");
    expect(http.sent[0]!.body).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      temperature: 0,
      thinking: { type: "disabled" },
      output_config: { effort: "high", format: { type: "json_schema", schema: request.output.schema } }
    });
  });

  it("pins the Chat Completions body for an OpenAI structured-output binding", async () => {
    const http = stub(() => json(chatText(JSON.stringify({ ...VERDICT, failingStep: null }))));
    await run(OPENAI, http);
    const request = protocolRequest(OPENAI);
    if (request.output.mechanism !== "structured_output") throw new Error("expected structured output");
    expect(http.sent[0]!.body).toEqual({
      model: "gpt-5",
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      max_completion_tokens: 2000,
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema: request.output.schema } }
    });
  });

  it("pins the Chat Completions body for an OpenRouter forced-function binding", async () => {
    const http = stub(() => json(chatToolCall(JSON.stringify(VERDICT))));
    await run(OPENROUTER, http);
    const request = protocolRequest(OPENROUTER);
    if (request.output.mechanism !== "forced_tool") throw new Error("expected a forced function");
    expect(http.sent[0]!.body).toEqual({
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 2000,
      reasoning: { enabled: true, max_tokens: 2048 },
      tools: [{ type: "function", function: { name: "submit_verdict", description: request.output.description, parameters: request.output.schema } }],
      tool_choice: { type: "function", function: { name: "submit_verdict" } },
      provider: { require_parameters: true, allow_fallbacks: false }
    });
  });

  it("pins the Messages body for an Anthropic forced-tool binding", async () => {
    const binding: ExecutionBinding = { ...ANTHROPIC, verdictProtocol: "anthropic.forced-tool/v1", reasoning: null };
    const http = stub(() => json(anthropicText("", { content: [{ type: "tool_use", name: "submit_verdict", input: VERDICT }] })));
    await run(binding, http);
    const request = protocolRequest(binding);
    if (request.output.mechanism !== "forced_tool") throw new Error("expected a forced tool");
    expect(http.sent[0]!.body).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      temperature: 0,
      tools: [{ name: "submit_verdict", description: request.output.description, input_schema: request.output.schema }],
      tool_choice: { type: "tool", name: "submit_verdict" }
    });
  });

  it("pins the Messages body for an Anthropic prompted-json binding", async () => {
    const binding: ExecutionBinding = { ...ANTHROPIC, verdictProtocol: "prompted-json/v1", sampling: { temperature: 0.3, topP: 0.9 } };
    const http = stub(() => json(anthropicText(JSON.stringify(VERDICT))));
    await run(binding, http);
    const request = protocolRequest(binding);
    expect(http.sent[0]!.body).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      temperature: 0.3,
      top_p: 0.9,
      thinking: { type: "disabled" },
      output_config: { effort: "high" }
    });
  });

  it("pins the Chat Completions body for a custom forced-function binding with a token limit", async () => {
    const binding: ExecutionBinding = { ...CUSTOM, verdictProtocol: "openai.forced-function/v1", outputTokenLimit: 800, reasoning: { family: "openai", effort: "none" } };
    const http = stub(() => json(chatToolCall(JSON.stringify(VERDICT))));
    await run(binding, http);
    const request = protocolRequest(binding);
    if (request.output.mechanism !== "forced_tool") throw new Error("expected a forced function");
    expect(http.sent[0]!.body).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      temperature: 0,
      max_tokens: 800,
      reasoning_effort: "none",
      tools: [{ type: "function", function: { name: "submit_verdict", description: request.output.description, parameters: request.output.schema } }],
      tool_choice: { type: "function", function: { name: "submit_verdict" } }
    });
  });

  it("sends OpenRouter's disabled reasoning and effort exactly", async () => {
    const http = stub(() => json(chatToolCall(JSON.stringify(VERDICT))));
    await run({ ...OPENROUTER, reasoning: { family: "openrouter", enabled: false, effort: null, maxTokens: null } }, http);
    await run({ ...OPENROUTER, reasoning: { family: "openrouter", enabled: true, effort: "high", maxTokens: null } }, http);
    expect(http.sent[0]!.body.reasoning).toEqual({ enabled: false });
    expect(http.sent[1]!.body.reasoning).toEqual({ enabled: true, effort: "high" });
  });

  it("pins the Chat Completions body for a custom prompted-json binding", async () => {
    const http = stub(() => json(chatText(JSON.stringify(VERDICT))));
    await run(CUSTOM, http);
    const request = protocolRequest(CUSTOM);
    expect(http.sent[0]!.body).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      temperature: 0
    });
  });
});

describe("Anthropic requests send exactly the binding", () => {
  it("sends structured output with the binding's settings, and nothing unset", async () => {
    const http = stub(() => json(anthropicText(JSON.stringify(VERDICT)), 200, { "request-id": "req_1" }));
    const result = await run(ANTHROPIC, http);

    expect(http.sent).toHaveLength(1);
    const [sent] = http.sent;
    expect(sent!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent!.headers).toEqual({ "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": "test-key" });
    expect(Object.keys(sent!.body)).toEqual(["model", "max_tokens", "system", "messages", "temperature", "thinking", "output_config"]);
    expect(sent!.body).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      temperature: 0,
      thinking: { type: "disabled" },
      output_config: { effort: "high", format: { type: "json_schema" } }
    });
    expect(result.verdict).toMatchObject({ kind: "binary", label: "pass", score: 0.9 });
    expect(result.observed).toEqual({
      model: "claude-sonnet-4-6-20260801",
      requestId: "req_1",
      responseId: "msg_1",
      systemFingerprint: null,
      upstreamProvider: null,
      thinkingReturned: false,
      reasoningTokens: null
    });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it("sends no temperature, top_p, thinking, or effort the binding leaves unset", async () => {
    const http = stub(() => json(anthropicText(JSON.stringify(VERDICT))));
    await run({ ...ANTHROPIC, sampling: { temperature: null, topP: null }, reasoning: null }, http);
    const body = http.sent[0]!.body;
    for (const key of ["temperature", "top_p", "thinking"]) expect(body).not.toHaveProperty(key);
    expect(body.output_config).toEqual({ format: expect.any(Object) });
  });

  it("sends top_p, enabled thinking with its budget, and adaptive thinking as stated", async () => {
    const http = stub(() => json(anthropicText(JSON.stringify(VERDICT))));
    await run({ ...ANTHROPIC, sampling: { temperature: 1, topP: 0.8 }, reasoning: { family: "anthropic", thinking: { type: "enabled", budgetTokens: 2048 }, effort: null } }, http);
    await run({ ...ANTHROPIC, reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" } }, http);
    expect(http.sent[0]!.body).toMatchObject({ temperature: 1, top_p: 0.8, thinking: { type: "enabled", budget_tokens: 2048 } });
    expect(http.sent[0]!.body.output_config).toEqual({ format: expect.any(Object) });
    expect(http.sent[1]!.body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
  });

  it("forces the verdict tool for anthropic.forced-tool/v1, and asks for plain JSON for prompted-json/v1", async () => {
    const http = stub(({ body }) => body.tools
      ? json(anthropicText("", { content: [{ type: "tool_use", name: "submit_verdict", input: VERDICT }] }))
      : json(anthropicText(JSON.stringify(VERDICT))));
    await run({ ...ANTHROPIC, verdictProtocol: "anthropic.forced-tool/v1", reasoning: null }, http);
    await run({ ...ANTHROPIC, verdictProtocol: "prompted-json/v1", reasoning: null }, http);
    expect(http.sent[0]!.body).toMatchObject({ tool_choice: { type: "tool", name: "submit_verdict" } });
    expect(http.sent[0]!.body).not.toHaveProperty("output_config");
    expect(http.sent[1]!.body).not.toHaveProperty("tools");
    expect(http.sent[1]!.body).not.toHaveProperty("output_config");
    expect(http.sent[1]!.body.system).toContain("<verdict_schema>");
  });

  it("records returned thinking, and reads the verdict from the text after it", async () => {
    const http = stub(() => json(anthropicText("", {
      content: [{ type: "thinking", thinking: "…" }, { type: "text", text: JSON.stringify(VERDICT) }]
    })));
    const result = await run({ ...ANTHROPIC, reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: null } }, http);
    expect(result.observed.thinkingReturned).toBe(true);
    expect(result.verdict).toMatchObject({ label: "pass" });
  });
});

describe("OpenAI-compatible requests send exactly the binding", () => {
  it("sends strict structured output and max_completion_tokens to OpenAI, with no unset sampling", async () => {
    const http = stub(() => json(chatText(JSON.stringify({ ...VERDICT, failingStep: null })), 200, { "x-request-id": "req_oa" }));
    const result = await run(OPENAI, http);
    const [sent] = http.sent;
    expect(sent!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent!.headers).toEqual({ "content-type": "application/json", authorization: "Bearer test-key" });
    expect(Object.keys(sent!.body)).toEqual(["model", "messages", "max_completion_tokens", "reasoning_effort", "response_format"]);
    expect(sent!.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "verdict", strict: true } });
    expect(result.observed).toEqual({
      model: "gpt-5-2026-08-01",
      requestId: "req_oa",
      responseId: "chatcmpl_1",
      systemFingerprint: "fp_1",
      upstreamProvider: null,
      thinkingReturned: false,
      reasoningTokens: 12
    });
  });

  it("never follows OPENAI_BASE_URL for a managed OpenAI binding", async () => {
    process.env.OPENAI_BASE_URL = "https://proxy.example/v1";
    const http = stub(() => json(chatText(JSON.stringify(VERDICT))));
    await run(OPENAI, http);
    expect(http.sent[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sends OpenRouter its reasoning object, routing requirements, and max_completion_tokens, and records the upstream", async () => {
    const http = stub(() => json(chatToolCall(JSON.stringify(VERDICT), { provider: "Anthropic" })));
    const result = await run(OPENROUTER, http);
    const body = http.sent[0]!.body;
    expect(http.sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 2000,
      reasoning: { enabled: true, max_tokens: 2048 },
      tool_choice: { type: "function", function: { name: "submit_verdict" } },
      provider: { require_parameters: true, allow_fallbacks: false }
    });
    expect(body.reasoning).not.toHaveProperty("effort");
    expect(result.observed.upstreamProvider).toBe("Anthropic");
  });

  it("records an upstream only for OpenRouter", async () => {
    const http = stub(() => json(chatText(JSON.stringify(VERDICT), { provider: "SomeHost" })));
    expect((await run(OPENAI, http)).observed.upstreamProvider).toBeNull();
  });

  it("calls a custom endpoint only at the URL whose digest the binding names", async () => {
    const http = stub(() => json(chatText(JSON.stringify(VERDICT))));
    await run(CUSTOM, http);
    expect(http.sent[0]!.url).toBe("https://llm.internal.example/v1/chat/completions");
    expect(http.sent[0]!.body).not.toHaveProperty("max_tokens");

    const wrong = await failure(run(CUSTOM, http, { customBaseUrl: "https://elsewhere.example/v1" }));
    expect(wrong).toMatchObject({ failureKind: "internal", physicalCall: false });
    const missing = await failure(run(CUSTOM, http, { customBaseUrl: null }));
    expect(missing).toMatchObject({ failureKind: "provider_unavailable", physicalCall: false });
    expect(http.sent).toHaveLength(1);
  });

  it("names an OpenAI endpoint override by digest instead of applying it implicitly", async () => {
    const override = "https://proxy.example/v1";
    const http = stub(() => json(chatText(JSON.stringify(VERDICT))));
    await run({ ...OPENAI, endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(override) } }, http, { customBaseUrl: override });
    expect(http.sent[0]!.url).toBe("https://proxy.example/v1/chat/completions");
    const managed = await failure(run(OPENAI, http, { customBaseUrl: override }));
    expect(managed).toMatchObject({ failureKind: "internal", physicalCall: false });
  });
});

describe("failures are classified once and never retried", () => {
  it.each([
    [400, "provider_rejected_request"],
    [401, "provider_authentication"],
    [402, "provider_authentication"],
    [403, "provider_authentication"],
    [404, "provider_rejected_request"],
    [408, "provider_timeout"],
    [413, "provider_rejected_request"],
    [429, "provider_rate_limit"],
    [500, "provider_unavailable"],
    [504, "provider_timeout"],
    [529, "provider_unavailable"]
  ])("HTTP %i is %s, after exactly one call", async (status, kind) => {
    const http = stub(() => json({ error: { type: "invalid_request_error", message: "temperature is deprecated for this model", param: "temperature" } }, status));
    const error = await failure(run(ANTHROPIC, http));
    expect(error).toMatchObject({ failureKind: kind, physicalCall: true, status });
    expect(error.providerError).toEqual({
      type: "invalid_request_error", code: null, param: "temperature", message: "temperature is deprecated for this model", raw: null, upstreamProvider: null
    });
    expect(http.sent).toHaveLength(1);
  });

  it("classifies transport errors and timeouts", async () => {
    const broken = stub(() => { throw new TypeError("fetch failed"); });
    expect(await failure(run(OPENAI, broken))).toMatchObject({ failureKind: "provider_transport", physicalCall: true });

    const slow: ExecutionFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    expect(await failure(run(OPENAI, { fetch: slow }, { timeoutMs: 5 }))).toMatchObject({ failureKind: "provider_timeout", physicalCall: true });
  });

  it("treats a response without the protocol's carrier as a protocol failure", async () => {
    const noTool = stub(() => json(anthropicText(JSON.stringify(VERDICT))));
    expect(await failure(run({ ...ANTHROPIC, verdictProtocol: "anthropic.forced-tool/v1", reasoning: null }, noTool)))
      .toMatchObject({ failureKind: "provider_protocol", physicalCall: true });
    const noContent = stub(() => json(chatText(null)));
    expect(await failure(run(OPENAI, noContent))).toMatchObject({ failureKind: "provider_protocol" });
    // Structured output is provider-enforced, so prose there breaks the protocol.
    const ignoredFormat = stub(() => json(chatText(`Verdict: ${JSON.stringify(VERDICT)}`)));
    expect(await failure(run(OPENAI, ignoredFormat))).toMatchObject({ failureKind: "provider_protocol" });
    const notJson = stub(() => new Response("<html>gateway</html>", { status: 200 }));
    expect(await failure(run(OPENAI, notJson))).toMatchObject({ failureKind: "provider_protocol" });
  });

  it("treats refusals, truncation, and malformed verdicts as invalid evaluator output, keeping provenance", async () => {
    const refused = stub(() => json(anthropicText("", { stop_reason: "refusal" })));
    const truncated = stub(() => json(chatText("{\"label\":", { choices: [{ message: { content: "{\"label\":" }, finish_reason: "length" }] })));
    const badArgs = stub(() => json(chatToolCall("{not json")));
    const badLabel = stub(() => json(chatText(JSON.stringify({ ...VERDICT, label: "maybe", failingStep: null }))));
    const prose = stub(() => json(chatText(`Verdict: ${JSON.stringify(VERDICT)}`)));

    expect(await failure(run(ANTHROPIC, refused))).toMatchObject({ failureKind: "invalid_evaluator_output" });
    expect(await failure(run(OPENAI, truncated))).toMatchObject({ failureKind: "invalid_evaluator_output" });
    expect(await failure(run(OPENROUTER, badArgs))).toMatchObject({ failureKind: "invalid_evaluator_output" });
    const invalid = await failure(run(OPENAI, badLabel));
    expect(invalid).toMatchObject({ failureKind: "invalid_evaluator_output", physicalCall: true });
    expect(invalid.observed).toMatchObject({ model: "gpt-5-2026-08-01", responseId: "chatcmpl_1" });
    expect(await failure(run(CUSTOM, prose))).toMatchObject({ failureKind: "invalid_evaluator_output" });
  });

  it("classifies an OpenRouter error reported inside a 200 by its code", async () => {
    const http = stub(() => json({ id: "gen_1", choices: [{ message: { content: "" }, finish_reason: "error", error: { code: 502, message: "Provider disconnected" } }] }));
    expect(await failure(run(OPENROUTER, http))).toMatchObject({ failureKind: "provider_unavailable", physicalCall: true });
  });
});

describe("calls that never leave Rubrist", () => {
  it("runs the mock locally", async () => {
    const http = stub(() => { throw new Error("the mock must not call out"); });
    const result = await run({
      provider: "mock",
      endpoint: { kind: "managed" },
      modelId: "mock-heuristic-v1",
      modelVersion: "mock-heuristic-v1",
      sampling: { temperature: null, topP: null },
      reasoning: null,
      outputTokenLimit: null,
      verdictProtocol: "mock/v1",
      routing: null
    }, http, { apiKey: null });
    expect(result.verdict.kind).toBe("binary");
    expect(result.observed.model).toBe("mock-heuristic-v1");
    expect(http.sent).toHaveLength(0);
  });

  it("refuses before sending when there is no credential or the binding can't be sent as stated", async () => {
    const http = stub(() => json(chatText(JSON.stringify(VERDICT))));
    expect(await failure(run(OPENAI, http, { apiKey: null }))).toMatchObject({ failureKind: "provider_unavailable", physicalCall: false });
    expect(await failure(run({ ...OPENAI, verdictProtocol: "anthropic.forced-tool/v1" }, http)))
      .toMatchObject({ failureKind: "internal", physicalCall: false });
    expect(await failure(run({ ...ANTHROPIC, reasoning: { family: "openai", effort: "low" } }, http)))
      .toMatchObject({ failureKind: "internal", physicalCall: false });
    expect(await failure(run({ ...OPENROUTER, routing: null }, http))).toMatchObject({ failureKind: "internal", physicalCall: false });
    expect(await failure(run({ ...OPENAI, provider: "typesafe", verdictProtocol: "typed-question/v1", reasoning: null, outputTokenLimit: null }, http)))
      .toMatchObject({ failureKind: "internal", physicalCall: false });
    expect(http.sent).toHaveLength(0);
  });

  it("runs the dispatch hook only once every check has passed, just before the call", async () => {
    const order: string[] = [];
    const http = stub(() => {
      order.push("sent");
      return json(chatText(JSON.stringify(VERDICT)));
    });
    const beforeDispatch = async () => { order.push("dispatch"); };
    await run(OPENAI, http, { beforeDispatch });
    expect(order).toEqual(["dispatch", "sent"]);

    order.length = 0;
    expect(await failure(run(OPENAI, http, { apiKey: null, beforeDispatch }))).toMatchObject({ physicalCall: false });
    expect(await failure(run({ ...OPENROUTER, routing: null }, http, { beforeDispatch }))).toMatchObject({ physicalCall: false });
    expect(await failure(run(CUSTOM, http, { customBaseUrl: "https://elsewhere.example/v1", beforeDispatch }))).toMatchObject({ physicalCall: false });
    expect(order).toEqual([]);
  });

  it("sends nothing when the dispatch hook fails, and passes its error through", async () => {
    const http = stub(() => json(chatText(JSON.stringify(VERDICT))));
    const hookError = new Error("the call-start record could not be written");
    await expect(run(OPENAI, http, { beforeDispatch: async () => { throw hookError; } })).rejects.toBe(hookError);
    expect(http.sent).toHaveLength(0);
  });
});

describe("review hardening", () => {
  it("never follows a redirect, and treats one as a protocol failure", async () => {
    const http = stub(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/v1/chat/completions" } }));
    const error = await failure(run(CUSTOM, http));
    expect(http.sent[0]!.redirect).toBe("manual");
    expect(error).toMatchObject({ failureKind: "provider_protocol", physicalCall: true, status: 307 });
    expect(http.sent).toHaveLength(1);
  });

  it("classifies malformed successful bodies instead of throwing raw errors", async () => {
    const nullBlock = stub(() => json({ id: "m", content: [null, { type: "text", text: JSON.stringify(VERDICT) }], stop_reason: "end_turn" }));
    expect((await run(ANTHROPIC, nullBlock)).verdict).toMatchObject({ label: "pass" });
    const nullCall = stub(() => json(chatText(null, { choices: [{ message: { content: null, tool_calls: [null] }, finish_reason: "tool_calls" }] })));
    expect(await failure(run(OPENROUTER, nullCall))).toMatchObject({ failureKind: "provider_protocol", physicalCall: true });
    const noContent = stub(() => json({ id: "m", model: "claude-sonnet-4-6" }));
    const error = await failure(run(ANTHROPIC, noContent));
    expect(error).toMatchObject({ failureKind: "provider_protocol" });
    expect(error.observed).toMatchObject({ thinkingReturned: null, responseId: "m" });
  });

  it("reads a response cut off at the context window as a cut-off answer", async () => {
    const http = stub(() => json(anthropicText("{\"label\":", { stop_reason: "model_context_window_exceeded" })));
    expect(await failure(run(ANTHROPIC, http))).toMatchObject({ failureKind: "invalid_evaluator_output" });
  });

  it("reads an in-body error without a status code, or an error finish, as the provider being unavailable", async () => {
    for (const body of [
      { error: { message: "upstream blew up" } },
      { error: "upstream blew up" },
      { id: "gen", choices: [{ message: { content: "" }, finish_reason: "error" }] },
      { id: "gen", choices: [{ message: { content: "" }, finish_reason: "error", error: { code: "", message: "x" } }] }
    ]) {
      expect(await failure(run(OPENROUTER, stub(() => json(body)))), JSON.stringify(body)).toMatchObject({ failureKind: "provider_unavailable" });
    }
  });

  it("keeps OpenRouter's upstream error detail for attribution", async () => {
    const http = stub(() => json({ error: { code: 400, message: "Provider returned error", metadata: { raw: "{\"error\":\"temperature is not supported\"}", provider_name: "Anthropic" } } }, 400));
    const error = await failure(run(OPENROUTER, http));
    expect(error.providerError).toMatchObject({ message: "Provider returned error", raw: "{\"error\":\"temperature is not supported\"}", upstreamProvider: "Anthropic" });
  });

  it("never lets the credential reach an error, even when a server echoes it", async () => {
    const key = "SECRET-KEY-123";
    const echo = stub(() => json({ error: { message: `Invalid API key: ${key}`, metadata: { raw: `bad ${key}` } } }, 401));
    const echoed = await failure(run(CUSTOM, echo, { apiKey: key }));
    expect(JSON.stringify({ message: echoed.message, detail: echoed.providerError, observed: echoed.observed })).not.toContain(key);
    expect(echoed.providerError?.message).toBe("Invalid API key: [redacted]");

    const broken = stub(() => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); });
    const transport = await failure(run(CUSTOM, broken, { apiKey: key }));
    expect(transport.message).toBe("the request failed in transport (ECONNREFUSED)");
    expect(transport.cause).toBeUndefined();

    const newline = await failure(run(CUSTOM, echo, { apiKey: `${key}\nX-Other: 1` }));
    expect(newline).toMatchObject({ failureKind: "provider_unavailable", physicalCall: false });
    expect(newline.message).not.toContain(key);
    expect(echo.sent).toHaveLength(1);
  });

  it("keeps usage when a billed response fails", async () => {
    const http = stub(() => json(anthropicText("not json")));
    const error = await failure(run({ ...ANTHROPIC, verdictProtocol: "prompted-json/v1" }, http));
    expect(error).toMatchObject({ failureKind: "invalid_evaluator_output", usage: { inputTokens: 120, outputTokens: 30 } });
  });

  it("refuses a custom endpoint on a provider that only has a managed one", async () => {
    const http = stub(() => json(anthropicText(JSON.stringify(VERDICT))));
    const binding: ExecutionBinding = { ...ANTHROPIC, endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest("https://collector.example/v1") } };
    expect(await failure(run(binding, http, { customBaseUrl: "https://collector.example/v1" }))).toMatchObject({ failureKind: "internal", physicalCall: false });
    expect(http.sent).toHaveLength(0);
  });

  it("refuses a custom base URL that isn't a plain http(s) base", async () => {
    for (const url of ["not a url", "https://user:pass@llm.example/v1", "https://llm.example/v1?api-version=1", "ftp://llm.example/v1", "https://llm.example/v1#x"]) {
      const http = stub(() => json(chatText(JSON.stringify(VERDICT))));
      const binding: ExecutionBinding = { ...CUSTOM, endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(url) } };
      expect(await failure(run(binding, http, { customBaseUrl: url })), url).toMatchObject({ failureKind: "internal", physicalCall: false });
      expect(http.sent).toHaveLength(0);
    }
  });

  it("joins text parts from compatible servers", async () => {
    const http = stub(() => json(chatText([{ type: "text", text: JSON.stringify(VERDICT).slice(0, 10) }, { type: "text", text: JSON.stringify(VERDICT).slice(10) }])));
    expect((await run(CUSTOM, http)).verdict).toMatchObject({ label: "pass" });
    const empty = stub(() => json(chatText([])));
    expect(await failure(run(CUSTOM, empty))).toMatchObject({ failureKind: "provider_protocol" });
  });

  it("records observed identifiers only when evidence can carry them", async () => {
    const http = stub(() => json(chatText(JSON.stringify({ ...VERDICT, failingStep: null }), { model: "gpt-5\ud800", id: "x".repeat(5_000) })));
    const result = await run(OPENAI, http);
    expect(result.observed).toMatchObject({ model: null, responseId: null, systemFingerprint: "fp_1" });
  });

  it("refuses a response over the size limit, and keeps the request id when the body times out", async () => {
    const huge = stub(() => new Response("x".repeat(9 * 1024 * 1024), { status: 200, headers: { "x-request-id": "req_big" } }));
    expect(await failure(run(OPENAI, huge))).toMatchObject({ failureKind: "provider_protocol", observed: { requestId: "req_big" } });

    const stalled: ExecutionFetch = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        }
      });
      return new Response(body, { status: 200, headers: { "x-request-id": "req_slow" } });
    };
    expect(await failure(run(OPENAI, { fetch: stalled }, { timeoutMs: 5 }))).toMatchObject({ failureKind: "provider_timeout", observed: { requestId: "req_slow" } });
  });
});

