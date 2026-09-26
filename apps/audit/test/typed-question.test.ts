import { describe, expect, it } from "vitest";
import type { ExecutionBinding } from "../src/execution/binding.js";
import { executeTypedQuestion, type ExecutionFetch, type TypedQuestionExecutionInput } from "../src/execution/execute.js";
import { EvaluatorCallError } from "../src/execution/failure.js";
import {
  TYPED_QUESTION_KEY,
  TypedQuestionStateError,
  parseTypedQuestionResponse,
  typedQuestionRequestText,
  type TypedQuestionEvaluator
} from "../src/protocols/typed-question.js";
import { VerdictProtocolError } from "../src/protocols/verdict-protocols.js";

// typed-question/v1 (ADR-0014 section 5) and its TypeSafe adapter. The request
// bodies below are the protocol's pinned material: a released version never
// changes, so a change to any of them is a new protocol version.

const JEV: ExecutionBinding = {
  provider: "typesafe",
  endpoint: { kind: "managed" },
  modelId: "jev-1.13.0",
  modelVersion: "jev-1.13.0",
  sampling: { temperature: null, topP: null },
  reasoning: null,
  outputTokenLimit: null,
  verdictProtocol: "typed-question/v1",
  routing: null
};

const EVALUATOR: TypedQuestionEvaluator = {
  question: {
    type: "noul",
    instructions: "Is the answer grounded in the refund policy?",
    criteria: { true: "The answer follows the policy.", false: "The answer contradicts or ignores the policy." }
  },
  threshold: 0.6
};

const TRACE = {
  id: "trace_1",
  input: { question: "Can I get a refund?" },
  output: { answer: "Yes, within 30 days." },
  metadata: { tenant: "acme" }
};

const QUESTIONS =
  '"questions":{"verdict":{"type":"noul","instructions":"Is the answer grounded in the refund policy?",' +
  '"criteria":{"true":"The answer follows the policy.","false":"The answer contradicts or ignores the policy."}}}';

const TRACE_BODY =
  '{"state":{"input":{"question":"Can I get a refund?"},"output":{"answer":"Yes, within 30 days."}},' +
  `${QUESTIONS},"model":"jev-1.13.0"}`;

interface Sent {
  url: string;
  headers: Record<string, string>;
  /** The exact bytes sent. */
  body: string;
  redirect: string;
}

function stub(respond: (sent: Sent) => Response | Promise<Response>): { fetch: ExecutionFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      const entry = { url, headers: init.headers, body: init.body, redirect: init.redirect };
      sent.push(entry);
      return respond(entry);
    }
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const answer = (noul: unknown, extra: Record<string, unknown> = {}) => ({
  model: "jev-1.13.0",
  answers: { [TYPED_QUESTION_KEY]: { type: "noul", noul } },
  usage: { input_tokens: 322, output_tokens: 21 },
  ...extra
});

function run(binding: ExecutionBinding, fetchStub: { fetch: ExecutionFetch }, overrides: Partial<TypedQuestionExecutionInput> = {}) {
  return executeTypedQuestion({ binding, apiKey: "test-key", evaluator: EVALUATOR, trace: TRACE, fetch: fetchStub.fetch, ...overrides });
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

describe("typed-question/v1 pins its request", () => {
  it("shows the model the trace's input and output, with its model, and nothing else", () => {
    expect(typedQuestionRequestText("jev-1.13.0", EVALUATOR, TRACE)).toBe(TRACE_BODY);
  });

  it("adds the steps' names, inputs, and outputs when the trace has steps, never their metadata", () => {
    const withSteps = {
      ...TRACE,
      steps: [
        { name: "lookup_policy", input: { id: "refunds" }, output: { days: 30 }, metadata: { latencyMs: 12 } },
        { input: "reply", output: "sent" }
      ]
    };
    const state = (trace: unknown) => typedQuestionRequestText("jev-1.13.0", EVALUATOR, trace).split(`,${QUESTIONS}`)[0];
    expect(state(withSteps)).toBe(
      '{"state":{"input":{"question":"Can I get a refund?"},"output":{"answer":"Yes, within 30 days."},' +
      '"steps":[{"name":"lookup_policy","input":{"id":"refunds"},"output":{"days":30}},{"input":"reply","output":"sent"}]}'
    );
    expect(state({ ...TRACE, steps: [] })).toBe('{"state":{"input":{"question":"Can I get a refund?"},"output":{"answer":"Yes, within 30 days."}}');
    expect(state({ id: "bare" })).toBe('{"state":{"input":null,"output":null}');
  });

  it("sends every trace value as canonical JSON, so the same trace is always the same bytes", () => {
    const shuffled = {
      output: "naïve ✓ 日本",
      input: { zeta: 1, alpha: { b: [3, undefined, "é"], a: -0 }, gone: undefined, Z: true },
      steps: [{ output: { y: 2, x: 1 }, input: [], name: "step" }]
    };
    const expected =
      '{"state":{"input":{"Z":true,"alpha":{"a":0,"b":[3,null,"é"]},"zeta":1},"output":"naïve ✓ 日本",' +
      '"steps":[{"name":"step","input":[],"output":{"x":1,"y":2}}]},' +
      `${QUESTIONS},"model":"jev-1.13.0"}`;
    expect(typedQuestionRequestText("jev-1.13.0", EVALUATOR, shuffled)).toBe(expected);
    const reordered = { steps: shuffled.steps, input: { Z: true, zeta: 1, alpha: { a: 0, b: [3, null, "é"] } }, output: shuffled.output };
    expect(typedQuestionRequestText("jev-1.13.0", EVALUATOR, reordered)).toBe(expected);
  });

  it("refuses a trace JSON can't hold exactly, naming none of its content", () => {
    const cycle: Record<string, unknown> = { secret: "do-not-echo" };
    cycle.self = cycle;
    const refused: Array<[string, unknown]> = [
      ["a string trace", "do-not-echo"],
      ["an array trace", ["do-not-echo"]],
      ["a null trace", null],
      ["steps that aren't a list", { input: "do-not-echo", steps: { name: "do-not-echo" } }],
      ["a step that isn't an object", { input: "do-not-echo", steps: ["do-not-echo"] }],
      ["NaN", { input: { secret: "do-not-echo", score: Number.NaN } }],
      ["Infinity", { output: [Number.POSITIVE_INFINITY] }],
      ["a cycle", { input: cycle }],
      ["a bigint", { input: { count: 1n } }],
      ["a function", { output: { run: () => "do-not-echo" } }]
    ];
    for (const [name, trace] of refused) {
      let error: unknown = null;
      try {
        typedQuestionRequestText("jev-1.13.0", EVALUATOR, trace);
      } catch (caught) {
        error = caught;
      }
      expect(error, name).toBeInstanceOf(TypedQuestionStateError);
      expect((error as Error).message, name).not.toContain("do-not-echo");
    }
    // A value repeated without a cycle is not one.
    const shared = { a: 1 };
    expect(typedQuestionRequestText("jev-1.13.0", EVALUATOR, { input: [shared, shared] })).toContain('"input":[{"a":1},{"a":1}]');
  });
});

describe("typed-question/v1 reads the answer", () => {
  it("passes at or above the threshold, fails below it, and never abstains or states a rationale", () => {
    expect(parseTypedQuestionResponse(answer(0.6), EVALUATOR)).toEqual({
      kind: "typed-question", label: "pass", probability: 0.6, threshold: 0.6, rationaleStatus: "not_provided"
    });
    expect(parseTypedQuestionResponse(answer(0.59), EVALUATOR)).toMatchObject({ label: "fail", probability: 0.59 });
    expect(parseTypedQuestionResponse(answer(0), EVALUATOR).label).toBe("fail");
    expect(parseTypedQuestionResponse(answer(1), EVALUATOR).label).toBe("pass");
  });

  it("treats a missing answer as the provider breaking the protocol, and a non-probability as invalid output", () => {
    const kind = (body: unknown) => {
      try {
        parseTypedQuestionResponse(body, EVALUATOR);
        return "parsed";
      } catch (error) {
        return error instanceof VerdictProtocolError ? error.failureKind : "other";
      }
    };
    expect(kind({ model: "jev-1.13.0" })).toBe("provider_protocol");
    expect(kind({ answers: {} })).toBe("provider_protocol");
    expect(kind({ answers: { [TYPED_QUESTION_KEY]: { type: "choice", probabilities: {} } } })).toBe("provider_protocol");
    for (const noul of [1.5, -0.1, "0.9", null, Number.NaN]) expect(kind(answer(noul)), String(noul)).toBe("invalid_evaluator_output");
  });
});

describe("the TypeSafe adapter", () => {
  it("sends exactly one POST to the managed endpoint with the pinned body, and records what came back", async () => {
    const http = stub(() => json(answer(0.83), 200, { "x-typesafe-request-id": "req_jev_1" }));
    let dispatched = 0;
    const result = await run(JEV, http, { beforeDispatch: async () => { dispatched += 1; } });
    expect(dispatched).toBe(1);
    // No sampling, reasoning, or token-limit field reaches the provider.
    expect(http.sent).toEqual([{
      url: "https://api.typesafe.ai/v1/systemone",
      headers: { authorization: "Bearer test-key", "content-type": "application/json", accept: "application/json" },
      body: TRACE_BODY,
      redirect: "manual"
    }]);
    expect(result).toEqual({
      verdict: { kind: "typed-question", label: "pass", probability: 0.83, threshold: 0.6, rationaleStatus: "not_provided" },
      observed: {
        model: "jev-1.13.0", requestId: "req_jev_1", responseId: null, systemFingerprint: null,
        upstreamProvider: null, thinkingReturned: null, reasoningTokens: null
      },
      usage: { inputTokens: 322, outputTokens: 21 }
    });
  });

  it("records the model that served the call, which an alias can hide", async () => {
    const http = stub(() => json(answer(0.2)));
    const result = await run({ ...JEV, modelId: "jev-latest", modelVersion: "jev-latest" }, http);
    expect(http.sent[0]!.body.endsWith(',"model":"jev-latest"}')).toBe(true);
    expect(result.observed.model).toBe("jev-1.13.0");
  });

  it("refuses a binding it can't send exactly, an evaluator without a usable question or threshold, and an unsendable trace, before any call", async () => {
    const http = stub(() => json(answer(0.5)));
    let dispatched = 0;
    const question = EVALUATOR.question;
    const refusals: Array<[string, Partial<TypedQuestionExecutionInput>]> = [
      ["a prompted binding", { binding: { ...JEV, provider: "anthropic", verdictProtocol: "anthropic.structured-output/v1" } }],
      ["another protocol", { binding: { ...JEV, verdictProtocol: "mock/v1" } }],
      ["a custom endpoint", { binding: { ...JEV, endpoint: { kind: "custom", baseUrlDigest: `sha256:${"a".repeat(64)}` } } }],
      ["a temperature", { binding: { ...JEV, sampling: { temperature: 0, topP: null } } }],
      ["a top-p", { binding: { ...JEV, sampling: { temperature: null, topP: 0.9 } } }],
      ["reasoning", { binding: { ...JEV, reasoning: { family: "openai", effort: "low" } } }],
      ["a token limit", { binding: { ...JEV, outputTokenLimit: 100 } }],
      ["routing", { binding: { ...JEV, routing: { requireParameters: true, allowFallbacks: false } } }],
      ["threshold 0", { evaluator: { ...EVALUATOR, threshold: 0 } }],
      ["threshold 1", { evaluator: { ...EVALUATOR, threshold: 1 } }],
      ["threshold NaN", { evaluator: { ...EVALUATOR, threshold: Number.NaN } }],
      ["a threshold that isn't a number", { evaluator: { ...EVALUATOR, threshold: "0.5" as unknown as number } }],
      ["no instructions", { evaluator: { ...EVALUATOR, question: { ...question, instructions: "" } } }],
      ["an empty criterion", { evaluator: { ...EVALUATOR, question: { ...question, criteria: { true: "", false: "No." } } } }],
      ["a question that isn't noul", { evaluator: { ...EVALUATOR, question: { ...question, type: "choice" as "noul" } } }],
      ["a trace that isn't an object", { trace: "Can I get a refund?" }],
      ["a trace holding NaN", { trace: { input: Number.NaN } }]
    ];
    for (const [name, overrides] of refusals) {
      const error = await failure(run(JEV, http, { beforeDispatch: async () => { dispatched += 1; }, ...overrides }));
      expect({ name, kind: error.failureKind, physicalCall: error.physicalCall }).toEqual({ name, kind: "internal", physicalCall: false });
    }
    expect(http.sent).toHaveLength(0);
    expect(dispatched).toBe(0);
  });

  it("makes no call without a credential", async () => {
    const http = stub(() => json(answer(0.5)));
    let dispatched = 0;
    const error = await failure(run(JEV, http, { apiKey: null, beforeDispatch: async () => { dispatched += 1; } }));
    expect(error).toMatchObject({ failureKind: "provider_unavailable", physicalCall: false });
    expect(http.sent).toHaveLength(0);
    expect(dispatched).toBe(0);
  });

  it("reads TypeSafe's error bodies without keeping the request they echo or the credential", async () => {
    const cases: Array<[Response, string, RegExp | null]> = [
      [json({ detail: { error_type: "authentication_error", message: "Must supply an API key!" } }, 403), "provider_authentication", /Must supply an API key!/],
      [json({ detail: "Out of credits" }, 402), "provider_authentication", /Out of credits/],
      [json({ detail: { error_type: "authentication_error", message: "Key test-key is revoked" } }, 401), "provider_authentication", /^Key \[redacted\] is revoked$/],
      [json({ detail: "Slow down" }, 429), "provider_rate_limit", /Slow down/],
      [json({ detail: "Noul question must have criteria or instructions: verdict" }, 400), "provider_rejected_request", /Noul question must have/],
      [json({ detail: "upstream failure" }, 503), "provider_unavailable", /upstream failure/],
      [new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }), "provider_protocol", null]
    ];
    for (const [response, kind, message] of cases) {
      const error = await failure(run(JEV, stub(() => response)));
      expect(error.failureKind).toBe(kind);
      expect(error.physicalCall).toBe(true);
      if (message) expect(error.providerError?.message).toMatch(message);
    }

    const echo = stub(() => json({
      detail: [
        { type: "missing", loc: ["body", "model"], msg: "Field required", input: { state: TRACE, secret: "test-key" } },
        { type: "string_type", loc: ["body", "state", "input", "Can I get a refund?"], msg: "Input should be a valid string", input: 1 }
      ]
    }, 422, { "x-typesafe-request-id": "req_422" }));
    const rejected = await failure(run(JEV, echo));
    expect(rejected).toMatchObject({ failureKind: "provider_rejected_request", observed: { requestId: "req_422" } });
    // A location stops at `state`: what follows it names the trace.
    expect(rejected.providerError).toEqual({
      type: null, code: null, param: null,
      message: "body.model: Field required; body.state: Input should be a valid string",
      raw: null, upstreamProvider: null
    });
    const everything = JSON.stringify({ message: rejected.message, detail: rejected.providerError, observed: rejected.observed });
    expect(everything).not.toContain("Can I get a refund?");
    expect(everything).not.toContain("test-key");
  });

  it("classifies an answer that isn't a probability, and a response that isn't the protocol's, after the call", async () => {
    expect(await failure(run(JEV, stub(() => json(answer(7)))))).toMatchObject({ failureKind: "invalid_evaluator_output", physicalCall: true, observed: { model: "jev-1.13.0" } });
    expect(await failure(run(JEV, stub(() => json({ model: "jev-1.13.0" }))))).toMatchObject({ failureKind: "provider_protocol", physicalCall: true });
    const notJson = stub(() => new Response("not json", { status: 200 }));
    expect(await failure(run(JEV, notJson))).toMatchObject({ failureKind: "provider_protocol" });
    const broken = stub(() => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); });
    expect(await failure(run(JEV, broken))).toMatchObject({ failureKind: "provider_transport", physicalCall: true });
  });
});
