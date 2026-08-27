import { describe, expect, it } from "vitest";
import { OpenAIJudgeProvider, type OpenAIFetch } from "../src/llm/openai.js";

const RUBRIC = `# Skill\n\nPass useful, correct, grounded answers. Fail incorrect ones.`;

const TRACE = {
  id: "trace_test",
  input: { question: "Can I get a refund within 30 days?" },
  output: { answer: "Yes, within 30 days." },
  metadata: {}
};

const OUTPUT_SCHEMA = { type: "object" };

function jsonOk(body: unknown): { ok: true; status: 200; json: () => Promise<unknown>; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

describe("OpenAIJudgeProvider — tool-call enum-constrained output", () => {
  it("returns provider-observed model, request id, and system fingerprint for structured calls", async () => {
    const fetchImpl: OpenAIFetch = async () => ({
      ...jsonOk({
        id: "chatcmpl_observed",
        model: "gpt-5-2026-08-01",
        system_fingerprint: "fp_abc123",
        choices: [{
          message: {
            tool_calls: [{
              type: "function",
              function: {
                name: "submit_verdict",
                arguments: JSON.stringify({ label: "pass", score: 0.91, rationale: "Grounded." })
              }
            }]
          }
        }]
      }),
      headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? "req_observed" : null }
    });
    const provider = new OpenAIJudgeProvider({ apiKey: "sk-test", model: "gpt-5", fetchImpl });

    const result = await provider.judgeStructured({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    });

    expect(result.providerMetadata).toEqual({
      model: "gpt-5-2026-08-01",
      requestId: "req_observed",
      responseId: "chatcmpl_observed",
      systemFingerprint: "fp_abc123"
    });
  });

  it("posts a chat.completions request with the submit_verdict function + forced tool_choice", async () => {
    const calls: Array<{ url: string; init: Parameters<OpenAIFetch>[1] }> = [];
    const fetchImpl: OpenAIFetch = async (url, init) => {
      calls.push({ url, init });
      return jsonOk({
        choices: [{
          message: {
            tool_calls: [{
              type: "function",
              function: {
                name: "submit_verdict",
                arguments: JSON.stringify({
                  label: "pass",
                  score: 0.91,
                  reason: "Answer matches the 30-day refund policy.",
                  confidence: 0.87
                })
              }
            }]
          }
        }]
      });
    };
    const provider = new OpenAIJudgeProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl
    });

    const verdict = await provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    });
    expect(verdict.label).toBe("pass");
    expect(verdict.score).toBeCloseTo(0.91);
    expect(verdict.confidence).toBeCloseTo(0.87);

    // Exactly one HTTP call to the chat completions endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers["authorization"]).toBe("Bearer sk-test");
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");

    const requestBody = JSON.parse(calls[0]!.init.body) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ type: string; function: { name: string; parameters: { properties: { label: { enum: string[] } } } } }>;
      tool_choice: { type: string; function: { name: string } };
    };
    expect(requestBody.model).toBe("gpt-5");
    expect(requestBody.temperature).toBe(0);
    expect(requestBody.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(requestBody.messages[0]!.content).toContain(RUBRIC);
    expect(requestBody.messages[0]!.content).not.toContain(TRACE.id);
    expect(requestBody.messages[1]!.content).toContain(TRACE.id);
    expect(requestBody.messages[1]!.content).not.toContain(RUBRIC);
    expect(requestBody.tools[0]?.function.name).toBe("submit_verdict");
    expect(requestBody.tools[0]?.function.parameters.properties.label.enum).toEqual(["pass", "fail", "ambiguous"]);
    expect(requestBody.tool_choice).toEqual({ type: "function", function: { name: "submit_verdict" } });
  });

  it("rejects responses that omit the submit_verdict tool call", async () => {
    const fetchImpl: OpenAIFetch = async () =>
      jsonOk({ choices: [{ message: { content: "I refuse to call the tool." } }] });
    const provider = new OpenAIJudgeProvider({ apiKey: "sk-test", model: "gpt-5", fetchImpl });
    await expect(provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    })).rejects.toThrow(/did not include the submit_verdict tool call/);
  });

  it("rejects malformed JSON in the tool-call arguments (defensive parse)", async () => {
    const fetchImpl: OpenAIFetch = async () => jsonOk({
      choices: [{
        message: {
          tool_calls: [{
            type: "function",
            function: { name: "submit_verdict", arguments: "this is not json" }
          }]
        }
      }]
    });
    const provider = new OpenAIJudgeProvider({ apiKey: "sk-test", model: "gpt-5", fetchImpl });
    await expect(provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    })).rejects.toThrow(/not valid JSON/);
  });

  it("rejects responses whose tool-call arguments fail JudgeVerdictSchema (label outside enum)", async () => {
    const fetchImpl: OpenAIFetch = async () => jsonOk({
      choices: [{
        message: {
          tool_calls: [{
            type: "function",
            function: {
              name: "submit_verdict",
              arguments: JSON.stringify({ label: "weird", score: 0.5, reason: "x", confidence: 0.5 })
            }
          }]
        }
      }]
    });
    const provider = new OpenAIJudgeProvider({ apiKey: "sk-test", model: "gpt-5", fetchImpl });
    await expect(provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    })).rejects.toThrow();
  });

  it("surfaces HTTP errors with status + truncated body", async () => {
    const fetchImpl: OpenAIFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "rate limited; try again later"
    });
    const provider = new OpenAIJudgeProvider({ apiKey: "sk-test", model: "gpt-5", fetchImpl });
    await expect(provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    })).rejects.toThrow(/OpenAI chat completion failed: 429/);
  });

  it("respects a custom baseUrl (Azure OpenAI / proxy / etc.)", async () => {
    let capturedUrl = "";
    const fetchImpl: OpenAIFetch = async (url) => {
      capturedUrl = url;
      return jsonOk({
        choices: [{
          message: {
            tool_calls: [{
              type: "function",
              function: {
                name: "submit_verdict",
                arguments: JSON.stringify({ label: "fail", score: 0.1, reason: "off", confidence: 0.7 })
              }
            }]
          }
        }]
      });
    };
    const provider = new OpenAIJudgeProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      baseUrl: "https://my-azure-openai.example.com/v1/",
      fetchImpl
    });
    await provider.judge({
      prompt: { id: "p1", name: "skill", content: RUBRIC, format: "markdown", path: "skill.md" },
      trace: TRACE,
      outputSchema: OUTPUT_SCHEMA
    });
    // Trailing slash on the baseUrl is normalized away.
    expect(capturedUrl).toBe("https://my-azure-openai.example.com/v1/chat/completions");
  });

  it("throws when apiKey is missing", () => {
    expect(() => new OpenAIJudgeProvider({ apiKey: "", model: "gpt-5" })).toThrow(/apiKey/);
  });
});
