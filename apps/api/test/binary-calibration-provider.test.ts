import { buildVerdictHttpRequest, buildVerdictProtocolRequest, type ExecutionFetch, type PromptedExecutionBinding } from "@rubrist/audit/runtime";
import type { ExecutionBinding } from "@rubrist/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  BinaryCalibrationProviderError,
  createBinaryCalibrationProviderExecutor
} from "../src/binary-calibration/provider.js";
import type {
  BinaryCalibrationAttemptWorkItem,
  BinaryCalibrationAuthorizedRun
} from "../src/binary-calibration/repository.js";
import { endpointBaseUrlDigest } from "../src/lib/evaluator-identity.js";
import { SEEDED_BINDING } from "./fixtures/execution-binding.js";

// Sealed calibration runs each attempt as one call of the evaluator's executor
// with the run's pinned binding (ADR-0014 sections 2, 5, and 6).

const DIGEST = `sha256:${"a".repeat(64)}`;
const VERDICT = { label: "pass", score: 0.99, rationale: "RATIONALE_CANARY" };
const OPENROUTER: ExecutionBinding = {
  ...SEEDED_BINDING,
  provider: "openrouter",
  modelId: "anthropic/claude-sonnet-4.6",
  modelVersion: "anthropic/claude-sonnet-4.6",
  reasoning: null,
  outputTokenLimit: null,
  verdictProtocol: "openai.forced-function/v1",
  routing: { requireParameters: true, allowFallbacks: false }
};

const JEV: ExecutionBinding = {
  provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
  sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
  verdictProtocol: "typed-question/v1", routing: null
};
const TYPED_EVALUATOR: BinaryCalibrationAuthorizedRun["evaluator"] = {
  kind: "typed-question",
  question: { type: "noul", instructions: "Is QUESTION_CANARY answered?", criteria: { true: "Answered.", false: "Not answered." } },
  threshold: 0.62
};

function authorizedRun(overrides: Partial<BinaryCalibrationAuthorizedRun> = {}): BinaryCalibrationAuthorizedRun {
  return {
    claim: { runId: "cal_run_1", workerId: "worker_1", claimToken: "claim_1", claimExpiresAt: "2026-08-23T12:15:00.000Z" },
    projectId: "project_1",
    datasetRevisionId: "revision_1",
    revisionDigest: DIGEST,
    itemCount: 1,
    skillVersionId: "skill_version_1",
    executionBinding: SEEDED_BINDING,
    customEndpointUrl: null,
    providerDataHandling: {
      executionEnvironment: "external_provider",
      policyId: "policy_1",
      policyDigest: DIGEST,
      payloadTransmission: "sealed_payload_to_pinned_provider"
    },
    evaluator: { kind: "prompted", rubricMarkdown: "Never persist PROMPT_CANARY.", prompt: "Judge against {{rubric_markdown}}." },
    authorization: { snapshotDigest: DIGEST, eventId: "event_1", recordedAt: "2026-08-23T12:00:00.000Z" },
    ...overrides
  };
}

const ATTEMPT: BinaryCalibrationAttemptWorkItem = {
  attemptId: "attempt_1",
  runId: "cal_run_1",
  datasetRevisionItemDigest: DIGEST,
  trialIndex: 0,
  payloadSnapshot: { input: { question: "INPUT_CANARY" }, output: { answer: "OUTPUT_CANARY" } },
  physicalProviderCalls: 0
};

interface Sent { url: string; body: string }

function anthropicAnswer(verdict: unknown = VERDICT) {
  return new Response(JSON.stringify({
    id: "msg_1",
    model: "claude-sonnet-4-6-observed",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(verdict) }],
    usage: { input_tokens: 10, output_tokens: 5 }
  }), { status: 200, headers: { "request-id": "REQUEST_ID_CANARY" } });
}

function stub(respond: () => Response | Promise<Response>, onSend: () => void = () => undefined) {
  const sent: Sent[] = [];
  const fetch: ExecutionFetch = async (url, init) => {
    onSend();
    sent.push({ url, body: init.body });
    return respond();
  };
  return { fetch, sent };
}

function executor(fetch: ExecutionFetch, credential: string | null = "sk-project") {
  const reads: string[] = [];
  const execute = createBinaryCalibrationProviderExecutor({
    resolveProjectCredential: async (_projectId, provider) => {
      reads.push(provider);
      return credential;
    },
    fetch
  });
  return { execute, reads };
}

async function providerError(promise: Promise<unknown>): Promise<BinaryCalibrationProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BinaryCalibrationProviderError) return error;
    throw error;
  }
  throw new Error("expected a calibration provider error");
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

describe("sealed binary calibration provider execution", () => {
  it("sends the pinned binding in one call, with call-start immediately before it", async () => {
    const order: string[] = [];
    const http = stub(() => anthropicAnswer(), () => order.push("sent"));
    const { execute } = executor(http.fetch);
    const result = await execute({
      authorizedRun: authorizedRun(),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { order.push("call-start"); }
    });
    expect(order).toEqual(["call-start", "sent"]);
    expect(http.sent).toHaveLength(1);
    expect(http.sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    // Exactly what the pinned binding and its protocol send, nothing added or dropped.
    const binding = SEEDED_BINDING as PromptedExecutionBinding;
    const expected = buildVerdictHttpRequest(binding, buildVerdictProtocolRequest(binding.verdictProtocol, {
      rubricMarkdown: "Never persist PROMPT_CANARY.",
      prompt: "Judge against {{rubric_markdown}}.",
      trace: { id: "sealed-observation", input: { question: "INPUT_CANARY" }, output: { answer: "OUTPUT_CANARY" } },
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    }), null);
    expect(JSON.parse(http.sent[0]!.body)).toEqual(expected.body);
    expect(http.sent[0]!.body).toContain("PROMPT_CANARY");
    expect(http.sent[0]!.body).toContain("INPUT_CANARY");
    // The ledger result carries no rationale, request id, or prompt.
    expect(result).toEqual({
      outcome: "pass",
      providerObservation: {
        provider: "anthropic",
        observedModel: "claude-sonnet-4-6-observed",
        observedVersion: null,
        systemFingerprint: null,
        upstreamProvider: null
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/CANARY/);
  });

  it("maps explicit binary ambiguity to an abstention", async () => {
    const http = stub(() => anthropicAnswer({ label: "ambiguous", score: 0.5, rationale: "unclear" }));
    const result = await executor(http.fetch).execute({ authorizedRun: authorizedRun(), attempt: ATTEMPT, beforePhysicalCall: async () => {} });
    expect(result.outcome).toBe("abstain");
  });

  it("uses the project credential, and the platform key only when the project has none", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-platform";
    const keys: string[] = [];
    const fetch: ExecutionFetch = async (_url, init) => {
      keys.push(init.headers["x-api-key"]!);
      return anthropicAnswer();
    };
    await executor(fetch).execute({ authorizedRun: authorizedRun(), attempt: ATTEMPT, beforePhysicalCall: async () => {} });
    await executor(fetch, null).execute({ authorizedRun: authorizedRun(), attempt: ATTEMPT, beforePhysicalCall: async () => {} });
    expect(keys).toEqual(["sk-project", "sk-platform"]);
  });

  it("refuses before call-start when no credential exists, and records no call", async () => {
    let callStarts = 0;
    const http = stub(() => anthropicAnswer());
    const error = await providerError(executor(http.fetch, null).execute({
      authorizedRun: authorizedRun(),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { callStarts += 1; }
    }));
    expect(error).toMatchObject({ code: "provider_unavailable", physicalCall: false });
    expect(callStarts).toBe(0);
    expect(http.sent).toHaveLength(0);
  });

  it("never sends when the durable call-start record fails, and passes that failure through", async () => {
    const http = stub(() => anthropicAnswer());
    const callStartFailure = new Error("call-start could not be written");
    await expect(executor(http.fetch).execute({
      authorizedRun: authorizedRun(),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { throw callStartFailure; }
    })).rejects.toBe(callStartFailure);
    expect(http.sent).toHaveLength(0);
  });

  it("refuses the mock binding without a call", async () => {
    const http = stub(() => anthropicAnswer());
    const error = await providerError(executor(http.fetch).execute({
      authorizedRun: authorizedRun({ executionBinding: { ...SEEDED_BINDING, provider: "mock" } }),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { throw new Error("must not start"); }
    }));
    expect(error).toMatchObject({ code: "internal", physicalCall: false });
    expect(http.sent).toHaveLength(0);
  });

  it("asks a typed-question evaluator's question in one call, and records its label with no probability or question", async () => {
    const order: string[] = [];
    const answer = (noul: number) => new Response(JSON.stringify({
      model: "jev-1.13.0", answers: { verdict: { type: "noul", noul } }, usage: { input_tokens: 40, output_tokens: 2 }
    }), { status: 200, headers: { "x-typesafe-request-id": "REQUEST_ID_CANARY" } });
    const typedRun = authorizedRun({ executionBinding: JEV, evaluator: TYPED_EVALUATOR });
    for (const [noul, outcome] of [[0.62, "pass"], [0.61, "fail"]] as const) {
      const http = stub(() => answer(noul), () => order.push("sent"));
      const { execute, reads } = executor(http.fetch, "typesafe-project-key");
      const result = await execute({ authorizedRun: typedRun, attempt: ATTEMPT, beforePhysicalCall: async () => { order.push("call-start"); } });
      expect(reads).toEqual(["typesafe"]);
      expect(http.sent).toHaveLength(1);
      expect(http.sent[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(JSON.parse(http.sent[0]!.body)).toEqual({
        state: { input: { question: "INPUT_CANARY" }, output: { answer: "OUTPUT_CANARY" } },
        questions: { verdict: TYPED_EVALUATOR.question },
        model: "jev-1.13.0"
      });
      expect(result).toEqual({
        outcome,
        providerObservation: { provider: "typesafe", observedModel: "jev-1.13.0", observedVersion: null, systemFingerprint: null, upstreamProvider: null }
      });
      expect(JSON.stringify(result)).not.toMatch(/CANARY|0\.6/);
    }
    expect(order).toEqual(["call-start", "sent", "call-start", "sent"]);
  });

  it("refuses a prompted evaluator on a TypeSafe binding, and a typed item with no key, before call-start", async () => {
    const http = stub(() => anthropicAnswer());
    const promptedOnTypeSafe = await providerError(executor(http.fetch).execute({
      authorizedRun: authorizedRun({ executionBinding: JEV }),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { throw new Error("must not start"); }
    }));
    expect(promptedOnTypeSafe).toMatchObject({ code: "internal", physicalCall: false });
    process.env.TYPESAFE_API_KEY = "";
    const keyless = await providerError(executor(http.fetch, null).execute({
      authorizedRun: authorizedRun({ executionBinding: JEV, evaluator: TYPED_EVALUATOR }),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { throw new Error("must not start"); }
    }));
    expect(keyless).toMatchObject({ code: "provider_unavailable", physicalCall: false });
    expect(http.sent).toHaveLength(0);
  });

  it("classifies a TypeSafe rate limit or outage once, after the call, keeping no request id", async () => {
    for (const [status, code] of [[429, "provider_rate_limit"], [503, "provider_unavailable"]] as const) {
      const http = stub(() => new Response(JSON.stringify({ detail: "busy" }), { status, headers: { "x-typesafe-request-id": "REQUEST_ID_CANARY" } }));
      let started = 0;
      const error = await providerError(executor(http.fetch, "typesafe-project-key").execute({
        authorizedRun: authorizedRun({ executionBinding: JEV, evaluator: TYPED_EVALUATOR }),
        attempt: ATTEMPT,
        beforePhysicalCall: async () => { started += 1; }
      }));
      expect({ status, code: error.code, physicalCall: error.physicalCall, started }).toEqual({ status, code, physicalCall: true, started: 1 });
      expect(JSON.stringify(error.observed)).not.toContain("CANARY");
    }
  });

  it("refuses a typed-question evaluator on a prompted binding before call-start", async () => {
    const http = stub(() => anthropicAnswer());
    const error = await providerError(executor(http.fetch).execute({
      authorizedRun: authorizedRun({ evaluator: TYPED_EVALUATOR }),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { throw new Error("must not start"); }
    }));
    expect(error).toMatchObject({ code: "internal", physicalCall: false });
    expect(http.sent).toHaveLength(0);
  });

  it("refuses metadata outside the frozen sealed payload projection", async () => {
    const http = stub(() => anthropicAnswer());
    const error = await providerError(executor(http.fetch).execute({
      authorizedRun: authorizedRun(),
      attempt: { ...ATTEMPT, payloadSnapshot: { input: {}, output: {}, metadata: { secret: 1 } } },
      beforePhysicalCall: async () => {}
    }));
    expect(error).toMatchObject({ code: "internal", physicalCall: false });
    expect(http.sent).toHaveLength(0);
  });

  it("calls a custom endpoint only at the URL whose digest the run pins", async () => {
    const url = "https://llm.example/v1";
    const custom: ExecutionBinding = {
      ...SEEDED_BINDING,
      provider: "custom",
      endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(url) },
      reasoning: null,
      outputTokenLimit: null,
      verdictProtocol: "openai.forced-function/v1"
    };
    const chat = () => new Response(JSON.stringify({
      id: "c", model: "llama-observed",
      choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_verdict", arguments: JSON.stringify(VERDICT) } }] }, finish_reason: "tool_calls" }]
    }));
    const http = stub(chat);
    await executor(http.fetch).execute({ authorizedRun: authorizedRun({ executionBinding: custom, customEndpointUrl: url }), attempt: ATTEMPT, beforePhysicalCall: async () => {} });
    expect(http.sent[0]!.url).toBe(`${url}/chat/completions`);

    const moved = stub(chat);
    const error = await providerError(executor(moved.fetch).execute({
      authorizedRun: authorizedRun({ executionBinding: custom, customEndpointUrl: "https://elsewhere.example/v1" }),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => { throw new Error("must not start"); }
    }));
    expect(error.physicalCall).toBe(false);
    expect(moved.sent).toHaveLength(0);
  });

  it("classifies a failed call once, keeping what the provider returned and the OpenRouter upstream", async () => {
    const rejected = stub(() => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "temperature is deprecated" } }), { status: 400 }));
    expect(await providerError(executor(rejected.fetch).execute({ authorizedRun: authorizedRun(), attempt: ATTEMPT, beforePhysicalCall: async () => {} })))
      .toMatchObject({ code: "provider_rejected_request", physicalCall: true });

    const limited = stub(() => new Response("{}", { status: 429 }));
    expect(await providerError(executor(limited.fetch).execute({ authorizedRun: authorizedRun(), attempt: ATTEMPT, beforePhysicalCall: async () => {} })))
      .toMatchObject({ code: "provider_rate_limit", physicalCall: true });

    const upstreamError = stub(() => new Response(JSON.stringify({
      error: { code: 400, message: "Provider returned error", metadata: { provider_name: "Anthropic", raw: "{}" } }
    }), { status: 400 }));
    const failed = await providerError(executor(upstreamError.fetch).execute({ authorizedRun: authorizedRun({ executionBinding: OPENROUTER }), attempt: ATTEMPT, beforePhysicalCall: async () => {} }));
    expect(failed).toMatchObject({ code: "provider_rejected_request", physicalCall: true, observed: { upstreamProvider: "Anthropic" } });

    const routed = stub(() => new Response(JSON.stringify({
      id: "c", model: "anthropic/claude-sonnet-4.6", provider: "Anthropic",
      choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_verdict", arguments: JSON.stringify(VERDICT) } }] }, finish_reason: "tool_calls" }]
    })));
    const result = await executor(routed.fetch).execute({ authorizedRun: authorizedRun({ executionBinding: OPENROUTER }), attempt: ATTEMPT, beforePhysicalCall: async () => {} });
    expect(result.providerObservation).toEqual({
      provider: "openrouter",
      observedModel: "anthropic/claude-sonnet-4.6",
      observedVersion: null,
      systemFingerprint: null,
      upstreamProvider: "Anthropic"
    });
  });
});
