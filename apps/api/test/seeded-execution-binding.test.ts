import {
  ExecutionBindingSchema,
  SEEDED_DEFAULT_EXECUTION_BINDING,
  documentedReasoningDefault
} from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import { BINDINGS } from "./fixtures/evaluator-v2-vectors.js";

describe("seeded default execution binding", () => {
  it("is the binding ADR-0014 section 2 states, which the v2 vectors pin", () => {
    expect(ExecutionBindingSchema.parse(SEEDED_DEFAULT_EXECUTION_BINDING)).toEqual(SEEDED_DEFAULT_EXECUTION_BINDING);
    expect(SEEDED_DEFAULT_EXECUTION_BINDING).toEqual(BINDINGS.sonnet);
  });

  it("is frozen at every level, so no consumer can change the identity projects are seeded with", () => {
    expect(Object.isFrozen(SEEDED_DEFAULT_EXECUTION_BINDING)).toBe(true);
    expect(Object.isFrozen(SEEDED_DEFAULT_EXECUTION_BINDING.reasoning)).toBe(true);
    expect(Object.isFrozen(SEEDED_DEFAULT_EXECUTION_BINDING.sampling)).toBe(true);
    const copy = { ...SEEDED_DEFAULT_EXECUTION_BINDING };
    expect(() => { (copy.sampling as { temperature: number | null }).temperature = 1; }).toThrow(TypeError);
    const clone = structuredClone(SEEDED_DEFAULT_EXECUTION_BINDING);
    clone.sampling.temperature = 1;
    expect(SEEDED_DEFAULT_EXECUTION_BINDING.sampling.temperature).toBe(0);
  });

  it("saves the documented default reasoning explicitly", () => {
    expect(SEEDED_DEFAULT_EXECUTION_BINDING.reasoning)
      .toEqual(documentedReasoningDefault("anthropic", SEEDED_DEFAULT_EXECUTION_BINDING.modelId)?.reasoning);
  });
});
