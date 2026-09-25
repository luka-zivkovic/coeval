import type { ExecutionProviderId, ReasoningSettings } from "./evaluator-execution.js";

// The dated, versioned table of documented provider reasoning defaults
// (Rubrist ADR-0014 section 2). Capability data can't say what a model does
// when reasoning is left unset, so the model picker pre-fills this default and
// the author saves it explicitly. It is a source of suggestions, never of
// capability truth: the capability check decides what the model accepts, and
// the saved value is what is sent. Changing an entry is a new table version.

export const REASONING_DEFAULTS_VERSION = "rubrist-reasoning-defaults/v1" as const;

export interface DocumentedReasoningDefault {
  provider: ExecutionProviderId;
  modelId: string;
  reasoning: ReasoningSettings;
  /** Where the provider documents it. */
  sources: readonly string[];
  /** When those sources were reviewed (YYYY-MM-DD). */
  reviewedOn: string;
}

// ASSUMPTION, per Anthropic's documentation as reviewed on 2026-09-25 and
// recorded in ADR-0014 section 2.
const REASONING_DEFAULTS_V1: readonly DocumentedReasoningDefault[] = [
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: "high" },
    sources: [
      "https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices",
      "https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6"
    ],
    reviewedOn: "2026-09-25"
  },
  {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
    reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" },
    sources: ["Anthropic model documentation for Claude Opus 5.5, as reviewed for Rubrist ADR-0014 on 2026-09-25"],
    reviewedOn: "2026-09-25"
  }
];

/** The documented default reasoning for a model, or `null` where the table has no entry and the author chooses. */
export function documentedReasoningDefault(provider: ExecutionProviderId, modelId: string): DocumentedReasoningDefault | null {
  return REASONING_DEFAULTS_V1.find((entry) => entry.provider === provider && entry.modelId === modelId) ?? null;
}

/** Every entry of the current table, for display and review. */
export function reasoningDefaultsTable(): readonly DocumentedReasoningDefault[] {
  return REASONING_DEFAULTS_V1;
}
