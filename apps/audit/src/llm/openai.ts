import { JudgeProvider, StructuredJudgeResult } from "./provider.js";
import { JudgePrompt, JudgeVerdict, JudgeVerdictSchema, Trace } from "../schema.js";
import {
  StructuredVerdict,
  VerdictSpec,
  type JudgePromptMessages,
  buildLegacyJudgeMessages,
  buildStructuredJudgeMessages,
  buildVerdictToolSchema,
  parseStructuredVerdict,
  traceStepCount
} from "./verdict-spec.js";

// Tool-call schema for the verdict. Same shape as the Anthropic provider
// (apps/audit/src/llm/anthropic.ts) so callers can swap providers without
// touching the rubric or worker code.
const VERDICT_FUNCTION_NAME = "submit_verdict";

const VERDICT_FUNCTION_PARAMETERS = {
  type: "object",
  properties: {
    label: {
      type: "string",
      enum: ["pass", "fail", "ambiguous"],
      description: "The overall verdict. Use 'ambiguous' only when the trace genuinely doesn't have enough information to decide."
    },
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Confidence-weighted score in [0,1]. 1 = strong pass, 0 = strong fail."
    },
    reason: {
      type: "string",
      description: "Short rationale referencing the rubric and the trace evidence."
    },
    failureCategory: {
      type: "string",
      description: "Optional short tag for the failure mode. Omit on pass."
    },
    expectedBehavior: {
      type: "string",
      description: "Optional short description of what the answer should have been."
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "How certain the judge is about its verdict, independent of the score."
    }
  },
  required: ["label", "score", "reason", "confidence"]
} as const;

// Narrow shape of the fetch we depend on. Injectable so tests can stub the
// HTTP call without standing up a real OpenAI server or pulling in the
// `openai` SDK (which adds ~MB of dep weight for one POST).
export type OpenAIFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export class OpenAIJudgeProvider implements JudgeProvider {
  readonly name: string;
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly fetchImpl: OpenAIFetch;

  constructor(input: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    providerName?: string;
    temperature?: number;
    fetchImpl?: OpenAIFetch;
  }) {
    if (!input.apiKey) throw new Error("OpenAIJudgeProvider requires apiKey");
    this.name = input.providerName ?? "openai";
    this.apiKey = input.apiKey;
    this.modelName = input.model;
    // Honor the skill version's requested temperature; defaults to 0.
    this.temperature = input.temperature ?? 0;
    this.baseUrl = (input.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    // Default to the global `fetch` available in Node 18+ / browsers. Tests
    // pass a stub via `fetchImpl`.
    this.fetchImpl =
      input.fetchImpl ??
      ((url, init) => fetch(url, init).then((response) => ({
        ok: response.ok,
        status: response.status,
        json: () => response.json(),
        text: () => response.text(),
        headers: response.headers
      })));
  }

  async judge(input: { prompt: JudgePrompt; trace: Trace; outputSchema: object }): Promise<JudgeVerdict> {
    const args = await this.callVerdictFunction(VERDICT_FUNCTION_PARAMETERS, buildJudgeMessage(input));
    return JudgeVerdictSchema.parse(args);
  }

  async judgeStructured(input: { prompt: JudgePrompt; trace: Trace; spec: VerdictSpec }): Promise<StructuredJudgeResult> {
    const stepCount = traceStepCount(input.trace);
    const { args, usage, providerMetadata } = await this.callVerdictFunctionWithUsage(
      buildVerdictToolSchema(input.spec, stepCount),
      buildStructuredJudgeMessages({ promptContent: input.prompt.content, trace: input.trace, spec: input.spec })
    );
    // Usage attaches AFTER parsing — envelope metadata, never verdict content.
    const verdict = parseStructuredVerdict(input.spec, args, stepCount);
    return { verdict, ...(usage ? { usage } : {}), providerMetadata };
  }

  // Single function-forced chat completion. Both judging paths share it; only
  // the function parameters + message differ. Returns the parsed `arguments`
  // object (OpenAI returns it as a JSON string).
  private async callVerdictFunction(parameters: unknown, messages: JudgePromptMessages): Promise<unknown> {
    return (await this.callVerdictFunctionWithUsage(parameters, messages)).args;
  }

  private async callVerdictFunctionWithUsage(parameters: unknown, messages: JudgePromptMessages): Promise<{
    args: unknown;
    usage?: { inputTokens: number; outputTokens: number };
    providerMetadata: { model: string | null; requestId: string | null; responseId: string | null; systemFingerprint: string | null };
  }> {
    const body = {
      model: this.modelName,
      temperature: this.temperature,
      messages: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: VERDICT_FUNCTION_NAME,
            description: "Submit the structured verdict for the trace under review.",
            parameters
          }
        }
      ],
      tool_choice: { type: "function", function: { name: VERDICT_FUNCTION_NAME } }
    };

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI chat completion failed: ${response.status} ${text.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      // chat completions report token usage on every response.
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      id?: unknown;
      model?: unknown;
      system_fingerprint?: unknown;
    };
    const usage = typeof payload.usage?.prompt_tokens === "number" && typeof payload.usage?.completion_tokens === "number"
      ? { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens }
      : undefined;
    const providerMetadata = {
      model: typeof payload.model === "string" ? payload.model : null,
      requestId: response.headers?.get("x-request-id") ?? null,
      responseId: typeof payload.id === "string" ? payload.id : null,
      systemFingerprint: typeof payload.system_fingerprint === "string" ? payload.system_fingerprint : null
    };

    const toolCall = payload.choices?.[0]?.message?.tool_calls?.find(
      (call) => call.type === "function" && call.function.name === VERDICT_FUNCTION_NAME
    );
    if (!toolCall) {
      throw new Error(`OpenAI response did not include the ${VERDICT_FUNCTION_NAME} tool call`);
    }

    try {
      return { args: JSON.parse(toolCall.function.arguments), ...(usage ? { usage } : {}), providerMetadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI tool-call arguments were not valid JSON: ${message}. Raw: ${toolCall.function.arguments.slice(0, 200)}`);
    }
  }
}

function buildJudgeMessage(input: { prompt: JudgePrompt; trace: Trace; outputSchema: object }): JudgePromptMessages {
  return buildLegacyJudgeMessages({
    promptContent: input.prompt.content,
    trace: input.trace,
    outputSchema: input.outputSchema
  });
}
