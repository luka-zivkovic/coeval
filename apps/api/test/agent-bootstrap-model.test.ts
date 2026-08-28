import { describe, expect, it } from "vitest";
import { AgentBootstrapModelInputSchema, AgentBootstrapRequestSchema } from "@coeval/shared";

// Issue #150: the runtime hint for missing provider credentials says to pin
// provider "mock" explicitly, but the bootstrap input schema rejected it —
// the agent-drivable path could not create a mock-judged project at all.
// Mock stays EXPLICIT-ONLY: accepting it here does not loosen the strict
// factory's refusal to silently fall back to mock verdicts.
describe("AgentBootstrapModelInputSchema — explicit mock pin", () => {
  it("accepts provider 'mock' with no modelId and no baseUrl", () => {
    const parsed = AgentBootstrapModelInputSchema.safeParse({ provider: "mock" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider).toBe("mock");
      expect(parsed.data.temperature).toBe(0);
    }
  });

  it("still rejects baseUrl for mock (baseUrl is custom-only)", () => {
    const parsed = AgentBootstrapModelInputSchema.safeParse({
      provider: "mock",
      baseUrl: "https://judge.example/v1"
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps requiring modelId + baseUrl for custom providers", () => {
    const parsed = AgentBootstrapModelInputSchema.safeParse({ provider: "custom" });
    expect(parsed.success).toBe(false);
  });
});

const BASE_REQUEST = {
  owner: { email: "agent@example.com", password: "agent-password" },
  project: { name: "Mock wiring test" },
  check: { name: "Correctness", question: "Was this Run correct?" },
  skill: {
    rubricMarkdown: "# Rubric\n\nPass correct answers.",
    model: { provider: "mock" }
  }
};

describe("AgentBootstrapRequestSchema — mock is credential-less", () => {
  it("accepts a mock-pinned request without providerApiKey", () => {
    expect(AgentBootstrapRequestSchema.safeParse(BASE_REQUEST).success).toBe(true);
  });

  it("rejects providerApiKey alongside provider 'mock' instead of silently ignoring the credential", () => {
    const parsed = AgentBootstrapRequestSchema.safeParse({
      ...BASE_REQUEST,
      providerApiKey: "some-provider-key-123"
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join(".") === "providerApiKey")).toBe(true);
    }
  });
});
