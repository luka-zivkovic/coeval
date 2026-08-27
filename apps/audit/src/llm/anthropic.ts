import Anthropic from "@anthropic-ai/sdk";
import { JudgeProvider, StructuredJudgeResult } from "./provider.js";
import { JudgePrompt, JudgeVerdict, JudgeVerdictSchema, Trace } from "../schema.js";
import {
  StructuredVerdict,
  VERDICT_TOOL_NAME,
  VerdictSpec,
  type JudgePromptMessages,
  buildLegacyJudgeMessages,
  buildStructuredJudgeMessages,
  buildVerdictToolSchema,
  parseStructuredVerdict,
  traceStepCount
} from "./verdict-spec.js";

// Tool-call schema for the verdict. Anthropic constrains the model's output to
// match this schema via `tool_choice: { type: "tool", name }`, which eliminates
// JSON parsing brittleness. The schema mirrors `JudgeVerdictSchema` so the
// model cannot return a label outside the allowed enum.
// VERDICT_TOOL_NAME is shared with the structured path via verdict-spec.ts.

const VERDICT_TOOL_INPUT_SCHEMA = {
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
      description: "Optional short tag for the failure mode (e.g. 'policy_grounding', 'tone'). Omit on pass."
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

// Narrow shape of `messages.create` we depend on. Injectable so tests can stub
// the network call without standing up the full Anthropic SDK surface.
export interface AnthropicMessagesCreate {
  (params: {
    model: string;
    max_tokens: number;
    // Omitted (not 0) for models that reject the parameter.
    temperature?: number;
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    tools: Array<{ name: string; description?: string; input_schema: unknown }>;
    tool_choice: { type: "tool"; name: string };
  }): Promise<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; name: string; input: unknown }
    >;
    // the messages API reports token usage on every response.
    usage?: { input_tokens?: number; output_tokens?: number };
    id?: unknown;
    model?: unknown;
    _request_id?: unknown;
  }>;
}

export type AnthropicRequestPolicy = "ordinary" | "single_physical_call";

export interface AnthropicClientOptions {
  apiKey: string;
  maxRetries?: number;
}

export type AnthropicMessagesCreateFactory = (
  options: AnthropicClientOptions
) => AnthropicMessagesCreate;

// Newer Anthropic models reject the temperature parameter outright:
// `400 invalid_request_error: 'temperature' is deprecated for this model.`
// There is no capability endpoint to ask up front, and a maintained model
// list would rot — so the provider retries the call once WITHOUT temperature
// on that specific 400 and remembers the incompatibility per model id for
// the process lifetime (module-level, shared across provider instances).
const modelsRejectingTemperature = new Set<string>();

function isTemperatureDeprecatedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  const message = error instanceof Error ? error.message : "";
  const badRequest = status === 400 || /\b400\b/.test(message);
  return badRequest && /temperature/i.test(message) && /deprecat|not supported|unsupported/i.test(message);
}

export class AnthropicJudgeProvider implements JudgeProvider {
  readonly name = "anthropic";
  readonly modelName: string;
  private readonly temperature: number;
  private readonly messagesCreate: AnthropicMessagesCreate;
  private readonly requestPolicy: AnthropicRequestPolicy;

  constructor(input: {
    apiKey?: string;
    model: string;
    temperature?: number;
    messagesCreate?: AnthropicMessagesCreate;
    messagesCreateFactory?: AnthropicMessagesCreateFactory;
    requestPolicy?: AnthropicRequestPolicy;
  }) {
    this.modelName = input.model;
    // Honor the skill version's requested temperature so self-consistency /
    // convergence describe the model as actually run. Defaults to 0.
    this.temperature = input.temperature ?? 0;
    this.requestPolicy = input.requestPolicy ?? "ordinary";
    if (input.messagesCreate) {
      this.messagesCreate = input.messagesCreate;
    } else {
      if (!input.apiKey) throw new Error("AnthropicJudgeProvider requires apiKey or messagesCreate override");
      const factory = input.messagesCreateFactory ?? createAnthropicMessagesCreate;
      this.messagesCreate = factory({
        apiKey: input.apiKey,
        // Ordinary judging retains the SDK's existing retry default. Sealed
        // calibration has already durably counted one physical call, so an
        // SDK retry would make the private ledger false.
        ...(this.requestPolicy === "single_physical_call" ? { maxRetries: 0 } : {})
      });
    }
  }

  async judge(input: { prompt: JudgePrompt; trace: Trace; outputSchema: object }): Promise<JudgeVerdict> {
    const toolInput = await this.callVerdictTool(VERDICT_TOOL_INPUT_SCHEMA, buildJudgeMessage(input));
    return JudgeVerdictSchema.parse(toolInput);
  }

  async judgeStructured(input: { prompt: JudgePrompt; trace: Trace; spec: VerdictSpec }): Promise<StructuredJudgeResult> {
    const stepCount = traceStepCount(input.trace);
    const { toolInput, usage, providerMetadata } = await this.callVerdictToolWithUsage(
      buildVerdictToolSchema(input.spec, stepCount),
      buildStructuredJudgeMessages({ promptContent: input.prompt.content, trace: input.trace, spec: input.spec })
    );
    // Usage attaches AFTER parsing — never on the verdict payload (zod strips
    // unknown keys anyway; the envelope is transport metadata, not verdict).
    const verdict = parseStructuredVerdict(input.spec, toolInput, stepCount);
    return { verdict, ...(usage ? { usage } : {}), providerMetadata };
  }

  // Single tool-forced call. Both judging paths share it; only the tool schema
  // + message differ.
  private async callVerdictTool(inputSchema: unknown, messages: JudgePromptMessages): Promise<unknown> {
    return (await this.callVerdictToolWithUsage(inputSchema, messages)).toolInput;
  }

  private async callVerdictToolWithUsage(inputSchema: unknown, messages: JudgePromptMessages): Promise<{
    toolInput: unknown;
    usage?: { inputTokens: number; outputTokens: number };
    providerMetadata: { model: string | null; requestId: string | null; responseId: string | null; systemFingerprint: null };
  }> {
    const params = {
      model: this.modelName,
      max_tokens: 1200,
      system: messages.system,
      tools: [
        {
          name: VERDICT_TOOL_NAME,
          description: "Submit the structured verdict for the trace under review.",
          input_schema: inputSchema
        }
      ],
      tool_choice: { type: "tool", name: VERDICT_TOOL_NAME } as const,
      messages: [{ role: "user" as const, content: messages.user }]
    };

    let response;
    if (this.requestPolicy === "single_physical_call") {
      // Exact calibration bindings never mutate parameters after a rejection.
      // In particular, do not use or update the ordinary-path compatibility
      // cache and do not retry without temperature.
      response = await this.messagesCreate({ ...params, temperature: this.temperature });
    } else if (modelsRejectingTemperature.has(this.modelName)) {
      response = await this.messagesCreate(params);
    } else {
      try {
        response = await this.messagesCreate({ ...params, temperature: this.temperature });
      } catch (error) {
        if (!isTemperatureDeprecatedError(error)) throw error;
        modelsRejectingTemperature.add(this.modelName);
        response = await this.messagesCreate(params);
      }
    }

    const toolUse = response.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> =>
        block.type === "tool_use" && block.name === VERDICT_TOOL_NAME
    );
    if (!toolUse) {
      const stitched = response.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").slice(0, 200);
      throw new Error(`Anthropic response did not include the ${VERDICT_TOOL_NAME} tool_use block. Text fallback: ${stitched}`);
    }
    const usage = typeof response.usage?.input_tokens === "number" && typeof response.usage?.output_tokens === "number"
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : undefined;
    return {
      toolInput: toolUse.input,
      ...(usage ? { usage } : {}),
      providerMetadata: {
        model: typeof response.model === "string" ? response.model : null,
        requestId: typeof response._request_id === "string" ? response._request_id : null,
        responseId: typeof response.id === "string" ? response.id : null,
        systemFingerprint: null
      }
    };
  }
}

function createAnthropicMessagesCreate(options: AnthropicClientOptions): AnthropicMessagesCreate {
  const client = new Anthropic(options);
  // The SDK's overloads make full type alignment painful; we cast at the edge
  // because the runtime shape we care about is the tool_use response block.
  return (params) =>
    (client.messages.create(params as unknown as Parameters<typeof client.messages.create>[0]) as unknown) as ReturnType<AnthropicMessagesCreate>;
}

function buildJudgeMessage(input: { prompt: JudgePrompt; trace: Trace; outputSchema: object }): JudgePromptMessages {
  return buildLegacyJudgeMessages({
    promptContent: input.prompt.content,
    trace: input.trace,
    outputSchema: input.outputSchema
  });
}
