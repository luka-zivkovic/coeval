import { describe, expect, it } from "vitest";
import {
  EVALUATOR_IDENTITY_BASIS,
  EvaluatorDefinitionSchema,
  EvaluatorIdentitySchema,
  EvaluatorItemStateSchema,
  ExecutionBindingSchema,
  ResolutionRecordSchema,
  SkillDigestInputSchema,
  verdictProtocolsFor,
  type CapabilityProbe,
  type EvaluatorIdentity,
  type ExecutionBinding,
  type TypedQuestion
} from "@rubrist/shared";
import {
  evaluatorDefinitionDigest,
  skillDigestInput,
  skillDigestV2,
  skillDigestV2FromInput,
  typedQuestionDigest
} from "../src/lib/evaluator-identity.js";

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

const PROMPTED_DEFINITION = {
  kind: "prompted",
  rubricMarkdown: "# Stays within the refund policy",
  prompt: "Judge the trace against {{rubric}}.",
  verdictKind: "binary",
  outputSchema: { type: "object" },
  scalarRange: null,
  categoricalChoiceScores: null
} as const;

const PROMPTED: EvaluatorIdentity = { basis: EVALUATOR_IDENTITY_BASIS, definition: PROMPTED_DEFINITION, executionBinding: SONNET_46 };

const QUESTION: TypedQuestion = {
  type: "noul",
  instructions: "The reply stays within the stated refund policy.",
  criteria: { true: "Every refund offered is allowed.", false: "A refund is offered outside the policy." }
};

const JEV_DEFINITION = {
  kind: "typed-question",
  question: { type: "noul", digest: typedQuestionDigest(QUESTION) },
  polarity: "true_is_pass",
  threshold: 0.62,
  rationale: "not_provided"
} as const;

const JEV: EvaluatorIdentity = {
  basis: EVALUATOR_IDENTITY_BASIS,
  definition: JEV_DEFINITION,
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

const CUSTOM_ENDPOINT = { kind: "custom", baseUrlDigest: `sha256:${"a".repeat(64)}` } as const;

const issues = (value: unknown) => {
  const parsed = ExecutionBindingSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
};
const identityIssues = (value: unknown) => {
  const parsed = EvaluatorIdentitySchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
};

describe("execution binding (ADR-0014 section 2)", () => {
  it("accepts exact bindings for a temperature-accepting model, a model that rejects it, OpenRouter, and custom endpoints", () => {
    expect(ExecutionBindingSchema.parse(SONNET_46)).toEqual(SONNET_46);
    expect(ExecutionBindingSchema.parse(OPUS_55)).toEqual(OPUS_55);
    expect(issues({
      ...SONNET_46, provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6", modelVersion: "anthropic/claude-sonnet-4.6",
      reasoning: { family: "openrouter", enabled: false, effort: null, maxTokens: null },
      outputTokenLimit: null, verdictProtocol: "openai.structured-output/v1",
      routing: { requireParameters: true, allowFallbacks: false }
    })).toEqual([]);
    expect(issues({
      ...SONNET_46, provider: "custom", endpoint: CUSTOM_ENDPOINT,
      modelId: "llama-3.3-70b", modelVersion: "llama-3.3-70b", reasoning: null, outputTokenLimit: null,
      verdictProtocol: "prompted-json/v1"
    })).toEqual([]);
  });

  it("records a platform OpenAI base-URL override as the endpoint, and allows no other provider a custom endpoint", () => {
    const openai = { ...SONNET_46, provider: "openai", modelId: "gpt-5", modelVersion: "gpt-5", reasoning: { family: "openai", effort: "low" }, verdictProtocol: "openai.structured-output/v1" };
    expect(issues(openai)).toEqual([]);
    expect(issues({ ...openai, endpoint: CUSTOM_ENDPOINT })).toEqual([]);
    expect(issues({ ...SONNET_46, endpoint: CUSTOM_ENDPOINT })).toContain("endpoint");
    expect(issues({ ...openai, provider: "custom", reasoning: null })).toContain("endpoint");
  });

  it("requires every setting to be present, with null meaning not sent", () => {
    const { topP: _omitted, ...sampling } = SONNET_46.sampling;
    expect(issues({ ...SONNET_46, sampling })).toContain("sampling.topP");
    const { reasoning: _reasoning, ...withoutReasoning } = SONNET_46;
    expect(issues(withoutReasoning)).toContain("reasoning");
  });

  it("refuses bindings whose parts contradict each other", () => {
    expect(issues({ ...SONNET_46, verdictProtocol: "openai.forced-function/v1" })).toContain("verdictProtocol");
    expect(issues({ ...SONNET_46, provider: "openrouter", routing: null, verdictProtocol: "openai.structured-output/v1", reasoning: null })).toContain("routing");
    expect(issues({ ...SONNET_46, routing: { requireParameters: true, allowFallbacks: false } })).toContain("routing");
    expect(issues({ ...SONNET_46, outputTokenLimit: null })).toContain("outputTokenLimit");
    expect(issues({ ...SONNET_46, reasoning: { family: "openai", effort: "low" } })).toContain("reasoning");
    expect(issues({ ...JEV.executionBinding, sampling: { temperature: 0, topP: null } })).toContain("sampling");
    expect(issues({ ...JEV.executionBinding, outputTokenLimit: 100 })).toEqual(["outputTokenLimit"]);
    expect(issues({ ...SONNET_46, reasoning: { family: "anthropic", thinking: { type: "enabled", budgetTokens: 100 }, effort: null } }))
      .toContain("reasoning.thinking.budgetTokens");
  });

  it("states OpenRouter reasoning without contradictions", () => {
    const openrouter = {
      ...SONNET_46, provider: "openrouter", outputTokenLimit: null, verdictProtocol: "openai.structured-output/v1",
      routing: { requireParameters: true, allowFallbacks: false }
    };
    const reasoning = (value: object) => issues({ ...openrouter, reasoning: { family: "openrouter", ...value } });
    expect(reasoning({ enabled: true, effort: "high", maxTokens: null })).toEqual([]);
    expect(reasoning({ enabled: true, effort: null, maxTokens: 4000 })).toEqual([]);
    expect(reasoning({ enabled: true, effort: "high", maxTokens: 4000 })).toContain("reasoning.maxTokens");
    expect(reasoning({ enabled: false, effort: "high", maxTokens: null })).toContain("reasoning.enabled");
  });

  it("names each provider family's protocols, with prompted-json as the last resort", () => {
    expect(verdictProtocolsFor("anthropic")).toEqual(["anthropic.structured-output/v1", "anthropic.forced-tool/v1", "prompted-json/v1"]);
    expect(verdictProtocolsFor("custom").at(-1)).toBe("prompted-json/v1");
    expect(verdictProtocolsFor("typesafe")).toEqual(["typed-question/v1"]);
  });
});

describe("evaluator definition (ADR-0014 sections 1 and 5)", () => {
  it("accepts a prompted evaluator and a typed-question evaluator with its required threshold", () => {
    expect(EvaluatorIdentitySchema.parse(PROMPTED)).toEqual(PROMPTED);
    expect(EvaluatorIdentitySchema.parse(JEV)).toEqual(JEV);
    const { threshold: _threshold, ...noThreshold } = JEV_DEFINITION;
    expect(identityIssues({ ...JEV, definition: noThreshold })).toContain("definition.threshold");
    for (const threshold of [0, 1]) {
      expect(identityIssues({ ...JEV, definition: { ...JEV_DEFINITION, threshold } })).toContain("definition.threshold");
    }
  });

  it("holds the typed question as a digest of its text", () => {
    expect(JEV_DEFINITION.question.digest).toBe(typedQuestionDigest(structuredClone(QUESTION)));
    expect(typedQuestionDigest({ ...QUESTION, criteria: { ...QUESTION.criteria, false: "Any refund at all." } })).not.toBe(JEV_DEFINITION.question.digest);
    expect(identityIssues({ ...JEV, definition: { ...JEV_DEFINITION, question: QUESTION } })).not.toEqual([]);
  });

  it("keeps the v1 skill-version invariants for prompted definitions", () => {
    const prompted = (patch: object) => identityIssues({ ...PROMPTED, definition: { ...PROMPTED_DEFINITION, ...patch } });
    expect(prompted({ verdictKind: "scalar", scalarRange: [1, 5] })).toEqual([]);
    expect(prompted({ verdictKind: "scalar" })).toContain("definition.scalarRange");
    expect(prompted({ verdictKind: "scalar", scalarRange: [5, 1] })).toContain("definition.scalarRange");
    expect(prompted({ scalarRange: [1, 5] })).toContain("definition.scalarRange");
    expect(prompted({ verdictKind: "categorical", categoricalChoiceScores: { good: 1, bad: 0 } })).toEqual([]);
    expect(prompted({ verdictKind: "categorical", categoricalChoiceScores: {} })).toContain("definition.categoricalChoiceScores");
    expect(prompted({ categoricalChoiceScores: { good: 1 } })).toContain("definition.categoricalChoiceScores");
    expect(prompted({ verdictKind: "categorical", categoricalChoiceScores: { good: 1.5 } })).toContain("definition.categoricalChoiceScores.good");
  });

  it("refuses lone surrogates anywhere in the definition, keys included, even parsed on its own", () => {
    expect(identityIssues({ ...PROMPTED, definition: { ...PROMPTED_DEFINITION, rubricMarkdown: "\ud800" } })).not.toEqual([]);
    expect(identityIssues({ ...PROMPTED, definition: { ...PROMPTED_DEFINITION, outputSchema: { properties: { "\ud800": {} } } } })).not.toEqual([]);
    expect(EvaluatorDefinitionSchema.safeParse({ ...PROMPTED_DEFINITION, prompt: "\udc00" }).success).toBe(false);
  });

  it("refuses an own __proto__ key in identity records instead of dropping it", () => {
    const withProto = (json: string) => ({ ...PROMPTED_DEFINITION, ...JSON.parse(json) });
    expect(EvaluatorDefinitionSchema.safeParse(withProto(`{"outputSchema":{"type":"object","__proto__":{"x":1}}}`)).success).toBe(false);
    expect(EvaluatorDefinitionSchema.safeParse(withProto(`{"verdictKind":"categorical","categoricalChoiceScores":{"good":1,"__proto__":0}}`)).success).toBe(false);
    expect(EvaluatorDefinitionSchema.safeParse(withProto(`{"verdictKind":"categorical","categoricalChoiceScores":{"good":1}}`)).success).toBe(true);
  });

  it("ties typed-question definitions to typed-question/v1 in both directions", () => {
    expect(identityIssues({ ...PROMPTED, executionBinding: JEV.executionBinding })).toContain("executionBinding.verdictProtocol");
    expect(identityIssues({ ...JEV, executionBinding: SONNET_46 })).toContain("executionBinding.verdictProtocol");
  });
});

describe("skillDigest v2 (ADR-0014 section 1 and decision 5)", () => {
  // Conformance vectors, cross-checked against an independent canonical-JSON SHA-256.
  it("is pinned, so a change to the basis, a field name, or canonical JSON is visible", () => {
    expect(evaluatorDefinitionDigest(PROMPTED_DEFINITION)).toBe("sha256:6fae541fcc112aa46455f2b5da1a4554e925597ebe81e8d6168489228537594e");
    expect(skillDigestV2(PROMPTED)).toBe("sha256:55d92fe5a2fb99b58f6a66bd91df818cdc2ca7c1ae7a216329e59835c2238695");
    expect(evaluatorDefinitionDigest(JEV_DEFINITION)).toBe("sha256:4ce367b4c6511c98e6a0ea6dd5d142dfa379b7523c7fb9b8aba0f76ebae4e3dc");
    expect(skillDigestV2(JEV)).toBe("sha256:44a3d7d6f4bb07dcb57dafe33c50ce905bde19e4ab583eaf304ea96d9e662497");
  });

  it("is computed from the binding and a definition digest, so evidence never needs the definition's text", () => {
    const input = skillDigestInput(PROMPTED);
    expect(input).toEqual({ basis: EVALUATOR_IDENTITY_BASIS, definitionDigest: evaluatorDefinitionDigest(PROMPTED_DEFINITION), executionBinding: SONNET_46 });
    expect(JSON.stringify(input)).not.toContain(PROMPTED_DEFINITION.rubricMarkdown);
    expect(JSON.stringify(input)).not.toContain(PROMPTED_DEFINITION.prompt);
    expect(skillDigestV2FromInput(input)).toBe(skillDigestV2(PROMPTED));
    expect(SkillDigestInputSchema.safeParse({ ...input, definition: PROMPTED_DEFINITION }).success).toBe(false);
    expect(() => skillDigestV2FromInput({ ...input, definitionDigest: "sha256:short" })).toThrow();
  });

  it("refuses to digest a definition that isn't exactly a valid definition", () => {
    expect(() => evaluatorDefinitionDigest({ ...PROMPTED_DEFINITION, extra: 1 } as never)).toThrow();
    const withProto = { ...PROMPTED_DEFINITION, ...JSON.parse(`{"outputSchema":{"type":"object","__proto__":{"x":1}}}`) };
    expect(() => evaluatorDefinitionDigest(withProto)).toThrow();
    const inherited = Object.create({ scalarRange: null });
    Object.assign(inherited, { ...PROMPTED_DEFINITION });
    delete inherited.scalarRange;
    expect(() => evaluatorDefinitionDigest(inherited)).toThrow();
  });

  it("still applies whole-identity rules before producing a digest input", () => {
    expect(() => skillDigestInput({ ...JEV, executionBinding: SONNET_46 })).toThrow();
  });

  it("is deterministic and covers every identity field", () => {
    const digest = skillDigestV2(PROMPTED);
    const reordered = JSON.parse(JSON.stringify({ executionBinding: PROMPTED.executionBinding, definition: PROMPTED.definition, basis: PROMPTED.basis }));
    expect(skillDigestV2(reordered)).toBe(digest);
    const variants: EvaluatorIdentity[] = [
      { ...PROMPTED, executionBinding: { ...SONNET_46, verdictProtocol: "anthropic.forced-tool/v1" } },
      { ...PROMPTED, executionBinding: { ...SONNET_46, reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "high" } } },
      { ...PROMPTED, executionBinding: { ...SONNET_46, sampling: { temperature: 0, topP: 0 } } },
      { ...PROMPTED, executionBinding: { ...SONNET_46, outputTokenLimit: 1201 } },
      { ...PROMPTED, executionBinding: { ...SONNET_46, modelVersion: "claude-sonnet-4-6-20260101" } },
      { ...PROMPTED, definition: { ...PROMPTED_DEFINITION, prompt: "Judge {{rubric}}." } }
    ];
    const digests = new Set([digest, ...variants.map(skillDigestV2)]);
    expect(digests.size).toBe(variants.length + 1);
    expect(skillDigestV2({ ...JEV, definition: { ...JEV_DEFINITION, threshold: 0.63 } })).not.toBe(skillDigestV2(JEV));
  });

  it("covers the custom endpoint digest", () => {
    const custom: EvaluatorIdentity = {
      ...PROMPTED,
      executionBinding: { ...SONNET_46, provider: "custom", endpoint: CUSTOM_ENDPOINT, reasoning: null, verdictProtocol: "prompted-json/v1" }
    };
    const other: EvaluatorIdentity = { ...custom, executionBinding: { ...custom.executionBinding, endpoint: { kind: "custom", baseUrlDigest: `sha256:${"b".repeat(64)}` } } };
    expect(skillDigestV2(custom)).not.toBe(skillDigestV2(other));
  });

  it("refuses to digest anything the stored document would not match", () => {
    expect(() => skillDigestV2({ ...PROMPTED, resolution: { status: "resolved" } } as unknown as EvaluatorIdentity)).toThrow();
    const withProto = JSON.parse(`{"basis":"${EVALUATOR_IDENTITY_BASIS}","definition":{"kind":"prompted","rubricMarkdown":"","prompt":"","verdictKind":"binary",`
      + `"outputSchema":{"type":"object","__proto__":{"x":1}},"scalarRange":null,"categoricalChoiceScores":null},"executionBinding":${JSON.stringify(SONNET_46)}}`);
    expect(Object.keys(withProto.definition.outputSchema)).toContain("__proto__");
    expect(() => skillDigestV2(withProto)).toThrow();
  });
});

describe("item state (ADR-0014 section 6)", () => {
  it("is exactly one of an outcome, a failure, or not attempted", () => {
    expect(EvaluatorItemStateSchema.safeParse({ state: "outcome", outcome: "abstain" }).success).toBe(true);
    expect(EvaluatorItemStateSchema.safeParse({ state: "failure", failureKind: "provider_timeout" }).success).toBe(true);
    expect(EvaluatorItemStateSchema.safeParse({ state: "not_attempted" }).success).toBe(true);
    expect(EvaluatorItemStateSchema.safeParse({ state: "failure", failureKind: "provider_timeout", outcome: "pass" }).success).toBe(false);
    expect(EvaluatorItemStateSchema.safeParse({ state: "failure", failureKind: "abstain" }).success).toBe(false);
  });
});

describe("resolution record (ADR-0014 section 4)", () => {
  const NOTHING_SENT = { temperature: null, topP: null, reasoning: null, outputTokenLimit: 1200 };
  const probe = (patch: Partial<CapabilityProbe>): CapabilityProbe => ({
    stage: "capability_check", purpose: "protocol", verdictProtocol: "anthropic.structured-output/v1", sent: NOTHING_SENT,
    outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null, costMicroUsd: 9, ...patch
  });
  const rejectedBy = (rejection: CapabilityProbe["rejection"], rejectedParameter: CapabilityProbe["rejectedParameter"]) =>
    ({ outcome: "rejected", rejection, rejectedParameter, failureKind: "provider_rejected_request" } as const);
  const protocolProbe = probe({});
  const temperatureProbe = probe({
    purpose: "temperature", sent: { ...NOTHING_SENT, temperature: 0, reasoning: OPUS_55.reasoning }, ...rejectedBy("parameter", "temperature"),
    providerMessage: "`temperature` is deprecated for this model.", costMicroUsd: 12
  });
  const reasoningProbe = probe({ purpose: "reasoning", sent: { ...NOTHING_SENT, reasoning: OPUS_55.reasoning } });
  const confirmProbe = probe({ stage: "resolution", purpose: "confirm", sent: { ...NOTHING_SENT, reasoning: OPUS_55.reasoning } });
  const record = {
    status: "resolved", capabilitySnapshotDigest: `sha256:${"c".repeat(64)}`, reasoningDefaultsVersion: "rubrist-reasoning-defaults/v1",
    credentialSource: "project", temperatureSupport: "parameter_rejected", reasoningSupport: "accepted",
    probes: [protocolProbe, temperatureProbe, reasoningProbe, confirmProbe], checkedAt: "2026-09-25T10:00:00.000Z"
  };
  const recordIssues = (patch: object) => {
    const parsed = ResolutionRecordSchema.safeParse({ ...record, ...patch });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
  };
  const probeIssues = (candidate: object) => recordIssues({ status: "unresolved", temperatureSupport: null, reasoningSupport: null, probes: [candidate] })
    .map((path) => path.replace(/^probes\.0\.?/, ""));

  it("records each probe's sent settings and outcome", () => {
    expect(ResolutionRecordSchema.parse(record)).toEqual(record);
  });

  it("holds at most a capability check of 6 probes and one resolution attempt of 3, with one confirming probe", () => {
    expect(recordIssues({ probes: [...Array(7).fill(protocolProbe), confirmProbe] })).toContain("probes");
    expect(recordIssues({ probes: [protocolProbe, protocolProbe, protocolProbe, protocolProbe, temperatureProbe, confirmProbe] })).toContain("probes.3.purpose");
    expect(recordIssues({ probes: [protocolProbe, temperatureProbe, temperatureProbe, confirmProbe] })).toContain("probes.2.purpose");
    expect(recordIssues({ probes: [protocolProbe, reasoningProbe, reasoningProbe, reasoningProbe, temperatureProbe, confirmProbe] })).toContain("probes.3.purpose");
    expect(recordIssues({ status: "unresolved", probes: [protocolProbe, temperatureProbe, reasoningProbe, { ...temperatureProbe, stage: "resolution" }] })).toContain("probes");
    expect(recordIssues({ probes: [...record.probes, { ...reasoningProbe, stage: "resolution" }, { ...reasoningProbe, stage: "resolution" }, { ...reasoningProbe, stage: "resolution" }] })).toContain("probes");
    expect(recordIssues({ probes: [...record.probes, confirmProbe] })).toContain("probes.4.purpose");
    expect(probeIssues({ ...protocolProbe, stage: "resolution" })).toContain("purpose");
    expect(probeIssues({ ...confirmProbe, stage: "capability_check" })).toContain("purpose");
  });

  it("keeps re-check probes out of the record", () => {
    expect(probeIssues({ ...confirmProbe, stage: "recheck" })).toContain("stage");
  });

  it("derives status from the confirming probe only", () => {
    expect(recordIssues({ probes: [protocolProbe] })).toContain("status");
    const rejectedConfirm = { ...confirmProbe, ...rejectedBy("value", "reasoning") };
    expect(recordIssues({ status: "failed", reasoningSupport: null, probes: [protocolProbe, temperatureProbe, rejectedConfirm] })).toEqual([]);
    expect(recordIssues({ status: "failed" })).toContain("status");
    const timedOut = { ...confirmProbe, outcome: "error", failureKind: "provider_timeout" };
    expect(recordIssues({ status: "unresolved", reasoningSupport: null, probes: [protocolProbe, temperatureProbe, timedOut] })).toEqual([]);
    expect(recordIssues({ status: "failed", reasoningSupport: null, probes: [protocolProbe, temperatureProbe, timedOut] })).toContain("status");
  });

  it("reads temperature support only from a probe sent with the saved reasoning", () => {
    // The check probed temperature with adaptive thinking; the author saved thinking disabled.
    const disabled = { family: "anthropic", thinking: { type: "disabled" }, effort: "high" } as const;
    const savedConfirm = { ...confirmProbe, sent: { ...NOTHING_SENT, reasoning: disabled } };
    expect(recordIssues({ probes: [protocolProbe, temperatureProbe, reasoningProbe, savedConfirm] })).toContain("temperatureSupport");
    const resolutionTemperature = { ...temperatureProbe, stage: "resolution", sent: { ...NOTHING_SENT, temperature: 0, reasoning: { effort: "high", thinking: { type: "disabled" }, family: "anthropic" } } };
    expect(recordIssues({ probes: [protocolProbe, temperatureProbe, reasoningProbe, savedConfirm, resolutionTemperature] })).toEqual([]);
  });

  it("keeps the gate-facing support fields backed by a probe that names that setting", () => {
    expect(recordIssues({ probes: [protocolProbe, reasoningProbe, confirmProbe] })).toContain("temperatureSupport");
    const reasoningNamed = { ...temperatureProbe, ...rejectedBy("parameter", "reasoning") };
    expect(recordIssues({ probes: [protocolProbe, reasoningNamed, reasoningProbe, confirmProbe] })).toContain("temperatureSupport");
    const unattributed = { ...temperatureProbe, ...rejectedBy("unattributed", null) };
    expect(recordIssues({ probes: [protocolProbe, unattributed, reasoningProbe, confirmProbe] })).toContain("temperatureSupport");
    expect(recordIssues({ temperatureSupport: "value_rejected", probes: [protocolProbe, unattributed, reasoningProbe, confirmProbe] })).toEqual([]);
  });

  it("keeps rejection attribution, failure kind, and outcome consistent", () => {
    expect(probeIssues({ ...temperatureProbe, rejection: null })).toContain("rejection");
    expect(probeIssues({ ...protocolProbe, rejection: "value", rejectedParameter: "temperature" })).toContain("rejection");
    expect(probeIssues({ ...temperatureProbe, rejectedParameter: null })).toContain("rejectedParameter");
    expect(probeIssues({ ...protocolProbe, ...rejectedBy("mechanism", "temperature") })).toContain("rejectedParameter");
    expect(probeIssues({ ...temperatureProbe, failureKind: "provider_rate_limit" })).toContain("failureKind");
    expect(probeIssues({ ...protocolProbe, outcome: "error", failureKind: "provider_rejected_request" })).toContain("failureKind");
    expect(probeIssues({ ...protocolProbe, outcome: "error", failureKind: "provider_timeout" })).toEqual([]);
    expect(probeIssues({ ...protocolProbe, failureKind: "internal" })).toContain("failureKind");
  });

  it("sends nothing optional on a protocol probe and the probed setting on a setting probe", () => {
    expect(probeIssues({ ...protocolProbe, sent: { ...NOTHING_SENT, topP: 1 } })).toContain("sent");
    expect(probeIssues({ ...temperatureProbe, sent: NOTHING_SENT })).toContain("sent");
    expect(probeIssues({ ...reasoningProbe, sent: NOTHING_SENT })).toContain("sent");
  });
});
