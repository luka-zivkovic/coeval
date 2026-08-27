import { describe, expect, it } from "vitest";
import {
  AnthropicJudgeProvider,
  type AnthropicClientOptions,
  type AnthropicMessagesCreate
} from "../src/llm/anthropic.js";

const RUBRIC = `# Skill\n\nPass useful, correct, grounded answers. Fail incorrect ones.`;

const TRACE = {
  id: "trace_test",
  input: { question: "Can I get a refund within 30 days?" },
  output: { answer: "Yes, within 30 days." },
  metadata: {}
};

const OUTPUT_SCHEMA = { type: "object" };

describe("AnthropicJudgeProvider — tool-call enum-constrained output", () => {
  it("returns provider-observed model and request id, with unavailable fingerprint as null", async () => {
    const messagesCreate: AnthropicMessagesCreate = async () => ({
      id: "msg_observed",
      _request_id: "req_observed",
      model: "claude-sonnet-4-6-20260801",
      content: [{
        type: "tool_use",
        name: "submit_verdict",
        input: { label: "pass", score: 0.9, rationale: "Grounded." }
      }]
    });
    const provider = new AnthropicJudgeProvider({ model: "claude-sonnet-4-6", messagesCreate });

    const result = await provider.judgeStructured({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    });

    expect(result.providerMetadata).toEqual({
      model: "claude-sonnet-4-6-20260801",
      requestId: "req_observed",
      responseId: "msg_observed",
      systemFingerprint: null
    });
  });

  it("calls messages.create with the submit_verdict tool + forced tool_choice", async () => {
    const calls: Array<Parameters<AnthropicMessagesCreate>[0]> = [];
    const messagesCreate: AnthropicMessagesCreate = async (params) => {
      calls.push(params);
      return {
        content: [
          {
            type: "tool_use",
            name: "submit_verdict",
            input: {
              label: "pass",
              score: 0.92,
              reason: "Answer matches the 30-day refund policy.",
              confidence: 0.88
            }
          }
        ]
      };
    };
    const provider = new AnthropicJudgeProvider({
      model: "claude-sonnet-4-6",
      messagesCreate
    });

    const verdict = await provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    });

    expect(verdict.label).toBe("pass");
    expect(verdict.score).toBeCloseTo(0.92);
    expect(verdict.confidence).toBeCloseTo(0.88);
    expect(calls).toHaveLength(1);

    const params = calls[0]!;
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.temperature).toBe(0);
    expect(params.tool_choice).toEqual({ type: "tool", name: "submit_verdict" });
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0]?.name).toBe("submit_verdict");
    // The enum constraint is the most important schema bit — verify it's
    // actually wired through to the model.
    const inputSchema = params.tools[0]?.input_schema as { properties: { label: { enum: unknown[] } } };
    expect(inputSchema.properties.label.enum).toEqual(["pass", "fail", "ambiguous"]);
  });

  it("rejects responses that omit the tool_use block", async () => {
    const messagesCreate: AnthropicMessagesCreate = async () => ({
      content: [
        { type: "text", text: "I refuse to call the tool. The answer is fine." }
      ]
    });
    const provider = new AnthropicJudgeProvider({ model: "claude-sonnet-4-6", messagesCreate });
    await expect(provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    })).rejects.toThrow(/did not include the submit_verdict tool_use/);
  });

  it("rejects responses whose tool_use input fails JudgeVerdictSchema (defense in depth — Anthropic should already enforce enum)", async () => {
    const messagesCreate: AnthropicMessagesCreate = async () => ({
      content: [
        {
          type: "tool_use",
          name: "submit_verdict",
          input: {
            label: "weird", // not in the enum — schema validation must still catch
            score: 0.5,
            reason: "x",
            confidence: 0.5
          }
        }
      ]
    });
    const provider = new AnthropicJudgeProvider({ model: "claude-sonnet-4-6", messagesCreate });
    await expect(provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    })).rejects.toThrow();
  });

  // Issue #151: newer Anthropic models 400 with "'temperature' is deprecated
  // for this model". The provider must retry once WITHOUT temperature and
  // remember the incompatibility per-model for the process lifetime — no
  // maintained model list.
  it("retries once without temperature when the model 400s it as deprecated", async () => {
    const calls: Array<Parameters<AnthropicMessagesCreate>[0]> = [];
    const messagesCreate: AnthropicMessagesCreate = async (params) => {
      calls.push(params);
      if ("temperature" in params && params.temperature !== undefined) {
        throw Object.assign(
          new Error("400 {\"type\":\"invalid_request_error\",\"message\":\"'temperature' is deprecated for this model.\"}"),
          { status: 400 }
        );
      }
      return {
        content: [{
          type: "tool_use",
          name: "submit_verdict",
          input: { label: "pass", score: 0.9, reason: "fine", confidence: 0.8 }
        }]
      };
    };
    const provider = new AnthropicJudgeProvider({ model: "claude-test-temp-deprecated-a", temperature: 0, messagesCreate });

    const verdict = await provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    });

    expect(verdict.label).toBe("pass");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.temperature).toBe(0);
    expect(calls[1]!.temperature).toBeUndefined();
  });

  it("remembers the temperature-rejecting model for the process lifetime (new instance, no retry round-trip)", async () => {
    const model = "claude-test-temp-deprecated-b";
    const rejectThenAccept: AnthropicMessagesCreate = async (params) => {
      if ("temperature" in params && params.temperature !== undefined) {
        throw Object.assign(
          new Error("400 {\"type\":\"invalid_request_error\",\"message\":\"'temperature' is deprecated for this model.\"}"),
          { status: 400 }
        );
      }
      return {
        content: [{
          type: "tool_use",
          name: "submit_verdict",
          input: { label: "pass", score: 0.9, reason: "fine", confidence: 0.8 }
        }]
      };
    };
    const first = new AnthropicJudgeProvider({ model, temperature: 0, messagesCreate: rejectThenAccept });
    await first.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    });

    // A FRESH instance for the same model must go straight to the
    // temperature-less request: exactly one call, no wasted 400.
    const calls: Array<Parameters<AnthropicMessagesCreate>[0]> = [];
    const counting: AnthropicMessagesCreate = async (params) => {
      calls.push(params);
      return {
        content: [{
          type: "tool_use",
          name: "submit_verdict",
          input: { label: "pass", score: 0.9, reason: "fine", confidence: 0.8 }
        }]
      };
    };
    const second = new AnthropicJudgeProvider({ model, temperature: 0, messagesCreate: counting });
    await second.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.temperature).toBeUndefined();
  });

  it("does NOT retry other 400s without temperature (only the deprecation shape triggers the retry)", async () => {
    let callCount = 0;
    const messagesCreate: AnthropicMessagesCreate = async () => {
      callCount += 1;
      throw Object.assign(
        new Error("400 {\"type\":\"invalid_request_error\",\"message\":\"max_tokens is too large\"}"),
        { status: 400 }
      );
    };
    const provider = new AnthropicJudgeProvider({ model: "claude-test-temp-deprecated-c", messagesCreate });
    await expect(provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    })).rejects.toThrow(/max_tokens/);
    expect(callCount).toBe(1);
  });

  it("uses one exact request and disables SDK retries under the sealed calibration policy", async () => {
    const clientOptions: AnthropicClientOptions[] = [];
    const calls: Array<Parameters<AnthropicMessagesCreate>[0]> = [];
    const provider = new AnthropicJudgeProvider({
      apiKey: "sk-sealed-test",
      model: "claude-sealed-no-fallback",
      temperature: 0.25,
      requestPolicy: "single_physical_call",
      messagesCreateFactory: (options) => {
        clientOptions.push(options);
        return async (params) => {
          calls.push(params);
          throw Object.assign(
            new Error("400 temperature is deprecated for this model"),
            { status: 400 }
          );
        };
      }
    });

    await expect(provider.judgeStructured({
      prompt: { id: "p1", name: "skill", content: RUBRIC, kind: "unified" },
      trace: TRACE,
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    })).rejects.toThrow(/temperature is deprecated/);

    expect(clientOptions).toEqual([{ apiKey: "sk-sealed-test", maxRetries: 0 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("claude-sealed-no-fallback");
    expect(calls[0]?.temperature).toBe(0.25);
  });

  it("keeps the ordinary SDK retry configuration and temperature fallback unchanged", async () => {
    const clientOptions: AnthropicClientOptions[] = [];
    const calls: Array<Parameters<AnthropicMessagesCreate>[0]> = [];
    const provider = new AnthropicJudgeProvider({
      apiKey: "sk-ordinary-test",
      model: "claude-ordinary-compatible-proof",
      temperature: 0.5,
      messagesCreateFactory: (options) => {
        clientOptions.push(options);
        return async (params) => {
          calls.push(params);
          if (params.temperature !== undefined) {
            throw Object.assign(new Error("400 temperature is unsupported"), { status: 400 });
          }
          return {
            content: [{
              type: "tool_use",
              name: "submit_verdict",
              input: { label: "pass", score: 0.9, rationale: "Grounded." }
            }]
          };
        };
      }
    });

    await expect(provider.judgeStructured({
      prompt: { id: "p1", name: "skill", content: RUBRIC, kind: "unified" },
      trace: TRACE,
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    })).resolves.toMatchObject({ verdict: { kind: "binary", label: "pass" } });

    expect(clientOptions).toEqual([{ apiKey: "sk-ordinary-test" }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.temperature).toBe(0.5);
    expect(calls[1]?.temperature).toBeUndefined();
  });

  it("throws helpfully when constructed without apiKey or messagesCreate", () => {
    expect(() => new AnthropicJudgeProvider({ model: "claude-sonnet-4-6" })).toThrow(/requires apiKey or messagesCreate/);
  });

  it("separates trusted prompt instructions from untrusted trace evidence", async () => {
    let captured: Parameters<AnthropicMessagesCreate>[0] | undefined;
    const messagesCreate: AnthropicMessagesCreate = async (params) => {
      captured = params;
      return {
        content: [{
          type: "tool_use",
          name: "submit_verdict",
          input: { label: "fail", score: 0.1, reason: "off-policy", confidence: 0.7 }
        }]
      };
    };
    const provider = new AnthropicJudgeProvider({ model: "claude-sonnet-4-6", messagesCreate });
    await provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    });
    expect(captured?.system).toContain("Pass useful, correct, grounded answers");
    expect(captured?.system).toContain("submit_verdict");
    expect(captured?.system).not.toContain(TRACE.id);
    expect(captured?.messages[0]!.content).toContain(TRACE.id);
    expect(captured?.messages[0]!.content).not.toContain("Pass useful, correct, grounded answers");
  });
});
