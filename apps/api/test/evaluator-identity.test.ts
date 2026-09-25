import { describe, expect, it } from "vitest";
import {
  EVALUATOR_IDENTITY_BASIS,
  EvaluatorIdentitySchema,
  ExecutionBindingSchema,
  ResolutionRecordSchema,
  verdictProtocolsFor,
  type EvaluatorIdentity,
  type ExecutionBinding
} from "@rubrist/shared";
import { skillDigestV2 } from "../src/lib/evaluator-identity.js";

const SONNET_46: ExecutionBinding = {
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

const OPUS_55: ExecutionBinding = {
  ...SONNET_46,
  modelId: "claude-opus-5-5",
  modelVersion: "claude-opus-5-5",
  sampling: { temperature: null, topP: null },
  reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" }
};

const PROMPTED: EvaluatorIdentity = {
  basis: EVALUATOR_IDENTITY_BASIS,
  definition: {
    kind: "prompted",
    rubricMarkdown: "# Stays within the refund policy",
    prompt: "Judge the trace against {{rubric}}.",
    verdictKind: "binary",
    outputSchema: { type: "object" },
    scalarRange: null,
    categoricalChoiceScores: null
  },
  executionBinding: SONNET_46
};

const JEV: EvaluatorIdentity = {
  basis: EVALUATOR_IDENTITY_BASIS,
  definition: {
    kind: "typed-question",
    question: {
      type: "noul",
      instructions: "The reply stays within the stated refund policy.",
      criteria: { true: "Every refund offered is allowed.", false: "A refund is offered outside the policy." }
    },
    polarity: "true_is_pass",
    threshold: 0.62,
    rationale: "not_provided"
  },
  executionBinding: {
    provider: "typesafe",
    endpoint: { kind: "managed" },
    modelId: "jev-1.13.0",
    modelVersion: "jev-1.13.0",
    sampling: { temperature: null, topP: null },
    reasoning: null,
    outputTokenLimit: null,
    verdictProtocol: "typed-question/v1",
    routing: null
  }
};

type TypedDefinition = Extract<EvaluatorIdentity["definition"], { kind: "typed-question" }>;
const JEV_DEFINITION = JEV.definition as TypedDefinition;

const issues = (value: unknown) => {
  const parsed = ExecutionBindingSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
};

describe("execution binding (ADR-0014 section 2)", () => {
  it("accepts exact bindings for a temperature-accepting model, a model that rejects it, OpenRouter, and a custom endpoint", () => {
    expect(ExecutionBindingSchema.parse(SONNET_46)).toEqual(SONNET_46);
    expect(ExecutionBindingSchema.parse(OPUS_55)).toEqual(OPUS_55);
    expect(issues({
      ...SONNET_46, provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6", modelVersion: "anthropic/claude-sonnet-4.6",
      reasoning: { family: "openrouter", enabled: false, effort: null, maxTokens: null },
      outputTokenLimit: null, verdictProtocol: "openai.structured-output/v1",
      routing: { requireParameters: true, allowFallbacks: false }
    })).toEqual([]);
    expect(issues({
      ...SONNET_46, provider: "custom", endpoint: { kind: "custom", baseUrlDigest: `sha256:${"a".repeat(64)}` },
      modelId: "llama-3.3-70b", modelVersion: "llama-3.3-70b", reasoning: null, outputTokenLimit: null,
      verdictProtocol: "prompted-json/v1"
    })).toEqual([]);
  });

  it("requires every setting to be present, with null meaning not sent", () => {
    const { topP: _omitted, ...sampling } = SONNET_46.sampling;
    expect(issues({ ...SONNET_46, sampling })).toContain("sampling.topP");
    const { reasoning: _reasoning, ...withoutReasoning } = SONNET_46;
    expect(issues(withoutReasoning)).toContain("reasoning");
  });

  it("refuses bindings whose parts contradict each other", () => {
    expect(issues({ ...SONNET_46, verdictProtocol: "openai.forced-function/v1" })).toContain("verdictProtocol");
    expect(issues({ ...SONNET_46, endpoint: { kind: "custom", baseUrlDigest: `sha256:${"b".repeat(64)}` } })).toContain("endpoint");
    expect(issues({ ...SONNET_46, provider: "openrouter", routing: null, verdictProtocol: "openai.structured-output/v1", reasoning: null })).toContain("routing");
    expect(issues({ ...SONNET_46, routing: { requireParameters: true, allowFallbacks: false } })).toContain("routing");
    expect(issues({ ...SONNET_46, outputTokenLimit: null })).toContain("outputTokenLimit");
    expect(issues({ ...SONNET_46, reasoning: { family: "openai", effort: "low" } })).toContain("reasoning");
    expect(issues({ ...JEV.executionBinding, sampling: { temperature: 0, topP: null } })).toContain("sampling");
    expect(issues({ ...SONNET_46, reasoning: { family: "anthropic", thinking: { type: "enabled", budgetTokens: 100 }, effort: null } }))
      .toContain("reasoning.thinking.budgetTokens");
  });

  it("names each provider family's protocols, with prompted-json as the last resort", () => {
    expect(verdictProtocolsFor("anthropic")).toEqual(["anthropic.structured-output/v1", "anthropic.forced-tool/v1", "prompted-json/v1"]);
    expect(verdictProtocolsFor("custom").at(-1)).toBe("prompted-json/v1");
    expect(verdictProtocolsFor("typesafe")).toEqual(["typed-question/v1"]);
  });
});

describe("evaluator identity and skillDigest v2 (ADR-0014 sections 1 and 5)", () => {
  it("accepts a prompted evaluator and a typed-question evaluator with its required threshold", () => {
    expect(EvaluatorIdentitySchema.parse(PROMPTED)).toEqual(PROMPTED);
    expect(EvaluatorIdentitySchema.parse(JEV)).toEqual(JEV);
    const { threshold: _threshold, ...noThreshold } = JEV_DEFINITION;
    expect(EvaluatorIdentitySchema.safeParse({ ...JEV, definition: noThreshold }).success).toBe(false);
    for (const threshold of [0, 1]) {
      expect(EvaluatorIdentitySchema.safeParse({ ...JEV, definition: { ...JEV.definition, threshold } }).success).toBe(false);
    }
  });

  it("ties typed-question definitions to typed-question/v1 in both directions", () => {
    expect(EvaluatorIdentitySchema.safeParse({ ...PROMPTED, executionBinding: JEV.executionBinding }).success).toBe(false);
    expect(EvaluatorIdentitySchema.safeParse({ ...JEV, executionBinding: SONNET_46 }).success).toBe(false);
  });

  it("is deterministic, covers every identity field, and has no room for the resolution record", () => {
    const digest = skillDigestV2(PROMPTED);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reordered = JSON.parse(JSON.stringify({ executionBinding: PROMPTED.executionBinding, definition: PROMPTED.definition, basis: PROMPTED.basis }));
    expect(skillDigestV2(reordered)).toBe(digest);
    expect(skillDigestV2({ ...PROMPTED, executionBinding: { ...SONNET_46, verdictProtocol: "anthropic.forced-tool/v1" } })).not.toBe(digest);
    expect(skillDigestV2({ ...PROMPTED, executionBinding: { ...SONNET_46, reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "high" } } })).not.toBe(digest);
    expect(skillDigestV2({ ...JEV, definition: { ...JEV_DEFINITION, threshold: 0.63 } })).not.toBe(skillDigestV2(JEV));
    expect(() => skillDigestV2({ ...PROMPTED, resolution: { status: "resolved" } } as unknown as EvaluatorIdentity)).toThrow();
  });
});

describe("resolution record (ADR-0014 section 4)", () => {
  const protocolProbe = {
    stage: "capability_check", purpose: "protocol", verdictProtocol: "anthropic.structured-output/v1",
    sent: { temperature: null, reasoning: null }, outcome: "accepted", rejection: null, failureKind: null, providerMessage: null, costMicroUsd: 9
  } as const;
  const temperatureProbe = {
    ...protocolProbe, purpose: "temperature", sent: { temperature: 0, reasoning: OPUS_55.reasoning }, outcome: "rejected",
    rejection: "parameter", failureKind: "provider_rejected_request", providerMessage: "`temperature` is deprecated for this model.", costMicroUsd: 12
  } as const;
  const record = {
    status: "resolved", capabilitySnapshotDigest: `sha256:${"c".repeat(64)}`, reasoningDefaultsVersion: "rubrist-reasoning-defaults/v1",
    credentialSource: "project", temperatureSupport: "parameter_rejected", reasoningSupport: "accepted",
    probes: [protocolProbe, temperatureProbe], checkedAt: "2026-09-25T10:00:00.000Z"
  };
  const probeIssues = (probe: unknown) => {
    const parsed = ResolutionRecordSchema.safeParse({ ...record, probes: [probe] });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.slice(2).join("."));
  };

  it("records each probe's sent settings and outcome, capped at a check plus one resolution attempt", () => {
    expect(ResolutionRecordSchema.parse(record)).toEqual(record);
    expect(ResolutionRecordSchema.safeParse({ ...record, probes: Array(10).fill(protocolProbe) }).success).toBe(false);
  });

  it("keeps re-check probes out of the record", () => {
    expect(probeIssues({ ...protocolProbe, stage: "recheck", purpose: "confirm" })).toEqual(["stage"]);
  });

  it("keeps rejection attribution, failure kind, and outcome consistent", () => {
    expect(probeIssues({ ...temperatureProbe, rejection: null })).toContain("rejection");
    expect(probeIssues({ ...protocolProbe, rejection: "value" })).toContain("rejection");
    expect(probeIssues({ ...temperatureProbe, failureKind: "provider_rate_limit" })).toContain("failureKind");
    expect(probeIssues({ ...protocolProbe, outcome: "error", failureKind: "provider_rejected_request" })).toContain("failureKind");
    expect(probeIssues({ ...protocolProbe, outcome: "error", failureKind: "provider_timeout" })).toEqual([]);
    expect(probeIssues({ ...protocolProbe, failureKind: "internal" })).toContain("failureKind");
  });

  it("refuses a protocol probe that sent optional settings", () => {
    expect(probeIssues({ ...protocolProbe, sent: { temperature: 0, reasoning: null } })).toContain("sent");
  });
});
