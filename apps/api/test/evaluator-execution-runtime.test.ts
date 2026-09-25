import {
  EvaluatorFailureKindSchema,
  ExecutionBindingSchema,
  verdictProtocolsFor,
  type EvaluatorFailureKind,
  type ExecutionBinding,
  type ReceiptObservedCall
} from "@rubrist/shared";
import {
  PROMPTED_VERDICT_PROTOCOLS,
  assertPromptedBinding,
  endpointBaseUrlDigest as runtimeEndpointBaseUrlDigest,
  failureKindForStatus,
  verdictProtocolRunsOn,
  type EvaluatorFailureKind as RuntimeFailureKind,
  type ExecutionBinding as RuntimeExecutionBinding,
  type ObservedProvenance,
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
    expectTypeOf<ObservedProvenance>().toEqualTypeOf<ReceiptObservedCall>();
  });

  it("accepts exactly the prompted bindings the shared schema accepts, across providers, endpoints, reasoning, and routing", () => {
    const reasonings: ExecutionBinding["reasoning"][] = [
      null,
      { family: "anthropic", thinking: { type: "disabled" }, effort: null },
      { family: "openai", effort: "low" },
      { family: "openrouter", enabled: true, effort: null, maxTokens: null }
    ];
    const endpoints: ExecutionBinding["endpoint"][] = [{ kind: "managed" }, { kind: "custom", baseUrlDigest: runtimeEndpointBaseUrlDigest("https://llm.example/v1") }];
    const providers: PromptedProviderId[] = ["mock", "anthropic", "openai", "openrouter", "custom"];
    let compared = 0;
    for (const provider of providers) {
      for (const verdictProtocol of verdictProtocolsFor(provider)) {
        for (const endpoint of endpoints) {
          for (const reasoning of reasonings) {
            for (const routing of [null, { requireParameters: true as const, allowFallbacks: false as const }]) {
              const sampling = provider === "mock" ? { temperature: null, topP: null } : { temperature: 0, topP: null };
              const binding: ExecutionBinding = {
                provider, endpoint, modelId: "m", modelVersion: "m", sampling, reasoning,
                outputTokenLimit: provider === "mock" ? null : 1000, verdictProtocol, routing
              };
              const shared = ExecutionBindingSchema.safeParse(binding).success;
              let runtime = true;
              try {
                assertPromptedBinding(binding);
              } catch {
                runtime = false;
              }
              expect(runtime, JSON.stringify(binding)).toBe(shared);
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
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
