import { JudgePrompt, JudgeVerdict, Trace } from "../schema.js";
import { StructuredVerdict, VerdictSpec } from "./verdict-spec.js";

export interface JudgeProvider {
  readonly name: string;
  readonly modelName?: string | undefined;
  // Binary judging (pass/fail/ambiguous). Used by the Phase-0 audit CLI.
  judge(input: {
    prompt: JudgePrompt;
    trace: Trace;
    outputSchema: object;
  }): Promise<JudgeVerdict>;
  // Verdict-kind-aware judging (binary | scalar | categorical). Used by the
  // platform judge worker + eval-as-a-service endpoint, where each skill
  // version pins its verdict shape via `spec`.
  judgeStructured(input: {
    prompt: JudgePrompt;
    trace: Trace;
    spec: VerdictSpec;
  }): Promise<StructuredJudgeResult>;
}

// token usage from the provider's response envelope. Optional — a
// provider (or an older stub) that doesn't report usage yields undefined and
// the platform records "usage unavailable", never zero-as-unknown.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// Identity observed on the provider response, not inferred from the request.
// Providers that omit a field report null so callers never confuse catalog
// configuration with execution provenance.
export interface ProviderResponseMetadata {
  model: string | null;
  requestId: string | null;
  responseId: string | null;
  systemFingerprint: string | null;
}

export interface StructuredJudgeResult {
  verdict: StructuredVerdict;
  usage?: TokenUsage;
  providerMetadata?: ProviderResponseMetadata;
}
