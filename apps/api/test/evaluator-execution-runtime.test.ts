import {
  EvaluatorFailureKindSchema,
  verdictProtocolsFor,
  type EvaluatorFailureKind,
  type ExecutionBinding
} from "@rubrist/shared";
import {
  PROMPTED_VERDICT_PROTOCOLS,
  endpointBaseUrlDigest as runtimeEndpointBaseUrlDigest,
  failureKindForStatus,
  verdictProtocolRunsOn,
  type EvaluatorFailureKind as RuntimeFailureKind,
  type ExecutionBinding as RuntimeExecutionBinding,
  type PromptedProviderId
} from "@rubrist/audit/runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import { endpointBaseUrlDigest } from "../src/lib/evaluator-identity.js";

// The judge runtime (@rubrist/audit) keeps no dependency on @rubrist/shared,
// so it restates the execution-binding contract. These checks hold the two
// equal (ADR-0014 sections 2, 3, and 6).
describe("judge runtime and shared execution contract", () => {
  it("types the execution binding and failure kinds identically", () => {
    expectTypeOf<RuntimeExecutionBinding>().toEqualTypeOf<ExecutionBinding>();
    expectTypeOf<RuntimeFailureKind>().toEqualTypeOf<EvaluatorFailureKind>();
  });

  it("pairs providers and prompted protocols as the shared binding does", () => {
    const providers: PromptedProviderId[] = ["mock", "anthropic", "openai", "openrouter", "custom"];
    for (const provider of providers) {
      expect(PROMPTED_VERDICT_PROTOCOLS.filter((protocol) => verdictProtocolRunsOn(protocol, provider)), provider)
        .toEqual(verdictProtocolsFor(provider).filter((protocol) => protocol !== "typed-question/v1"));
    }
    expect(verdictProtocolsFor("typesafe")).toEqual(["typed-question/v1"]);
  });

  it("classifies HTTP statuses only into shared failure kinds", () => {
    for (let status = 100; status < 600; status += 1) {
      expect(EvaluatorFailureKindSchema.options).toContain(failureKindForStatus(status));
    }
  });

  it("names custom endpoints with the same digest", () => {
    for (const url of ["https://llm.internal.example/v1", "https://llm.internal.example/v1/", "http://localhost:8000/v1", "https://例え.example/v1"]) {
      expect(runtimeEndpointBaseUrlDigest(url)).toBe(endpointBaseUrlDigest(url));
    }
  });
});
