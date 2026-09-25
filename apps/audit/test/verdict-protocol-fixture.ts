import {
  PROMPTED_VERDICT_PROTOCOLS,
  buildVerdictProtocolRequest,
  verdictProtocolRunsOn,
  verdictProtocolTokenLimitParameter,
  type PromptedProviderId
} from "../src/protocols/verdict-protocols.js";
import type { VerdictSpec } from "../src/llm/verdict-spec.js";

// The rendered material every prompted protocol version pins, over fixed
// inputs covering each verdict kind with and without trajectory steps.
// test/fixtures/verdict-protocols-v1.json holds the reviewed rendering;
// scripts/write-verdict-protocol-fixture.ts rewrites it.

const PROMPT_CONTENT = "Judge the trace against the review guide below.\n\n<review_guide>\nPass answers grounded in the refund policy.\n</review_guide>";
const TRACE = { id: "trace_1", input: { question: "Can I get a refund?" }, output: { answer: "Yes, within 30 days." } };
const TRACE_WITH_STEPS = { ...TRACE, steps: [{ name: "lookup_policy" }, { name: "reply" }] };

const SAMPLES: Array<{ name: string; trace: unknown; spec: VerdictSpec }> = [
  { name: "binary", trace: TRACE, spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null } },
  { name: "binary-with-steps", trace: TRACE_WITH_STEPS, spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null } },
  { name: "scalar", trace: TRACE, spec: { verdictKind: "scalar", scalarRange: [1, 5], categoricalChoiceScores: null } },
  { name: "categorical", trace: TRACE, spec: { verdictKind: "categorical", scalarRange: null, categoricalChoiceScores: { good: 1, partial: 0.5, bad: 0 } } }
];

const PROVIDERS: PromptedProviderId[] = ["mock", "anthropic", "openai", "openrouter", "custom"];

export function renderVerdictProtocolFixture(): unknown {
  return {
    note: "Rendered material of each prompted verdict protocol version (Rubrist ADR-0014 section 3). A change here is a new protocol version.",
    protocols: Object.fromEntries(PROMPTED_VERDICT_PROTOCOLS.map((protocol) => [protocol, {
      tokenLimitParameter: Object.fromEntries(PROVIDERS
        .filter((provider) => verdictProtocolRunsOn(protocol, provider))
        .map((provider) => [provider, verdictProtocolTokenLimitParameter(protocol, provider)])),
      samples: Object.fromEntries(SAMPLES.map((sample) => [
        sample.name,
        buildVerdictProtocolRequest(protocol, { promptContent: PROMPT_CONTENT, trace: sample.trace, spec: sample.spec })
      ]))
    }]))
  };
}

export function verdictProtocolFixtureText(): string {
  return `${JSON.stringify(renderVerdictProtocolFixture(), null, 2)}\n`;
}
