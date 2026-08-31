import { z } from "zod";

export const VerdictLabelSchema = z.enum(["pass", "fail", "ambiguous"]);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const VerdictKindSchema = z.enum(["binary", "scalar", "categorical"]);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

export const SkillStatusSchema = z.enum([
  "draft",
  "calibrating",
  "validated",
  "approved",
  "production",
  "regressing",
  "failed",
  "needs_review",
  "deprecated"
]);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

export const JudgeProviderIdSchema = z.enum(["mock", "anthropic", "openai", "openrouter", "custom"]);
export type JudgeProviderId = z.infer<typeof JudgeProviderIdSchema>;

// Canonical JSON identities operate on Unicode scalar values. JavaScript can
// represent isolated UTF-16 surrogate code units, but UTF-8 encoders replace
// them with U+FFFD, making two distinct inputs collapse to the same bytes.
// Reject them on every new criterion/evaluator/suite write instead.
export function containsLoneUtf16Surrogate(value: unknown): boolean {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(containsLoneUtf16Surrogate);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) =>
      containsLoneUtf16Surrogate(key) || containsLoneUtf16Surrogate(nested)
    );
  }
  return false;
}

// Internal shared schema. It is exported only for sibling shared modules and
// is intentionally omitted from the package root's public export map.
export const UnicodeScalarValueSchema = z.string().refine((value) => !containsLoneUtf16Surrogate(value), {
  message: "Text must not contain an unpaired UTF-16 surrogate"
});

// Canonicalize raw provider identifiers at explicit input or protocol-check
// boundaries. Persisted bindings use StoredModelBindingSchema and are already
// canonical.
export function normalizeJudgeProviderId(value: string): JudgeProviderId | null {
  const parsed = JudgeProviderIdSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

// Internal shared schema. It remains absent from the package root exports.
export const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "baseUrl must use http or https" });

// Contract-facing model bindings intentionally mirror the frozen receipt-v1
// and skill-format/v1 schemas, where provider and sampling values are not
// restricted to Coeval's current runtime provider catalog.
export const ModelBindingSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  // Honest limitation: no supported provider catalog exposes an immutable
  // snapshot id separate from the model id, so every pin path today stores
  // modelVersion = modelId. The field records WHAT was requested, not a dated
  // snapshot — an upstream silent model revision is not detectable through it
  // (see spec/skill-format-v1.md § Model binding).
  modelVersion: z.string(),
  temperature: z.number(),
  topP: z.number().optional(),
  baseUrl: z.string().optional()
});
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

const StoredHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "baseUrl must use http or https" });

// Database-backed bindings are produced only by current, validated writers.
// Keep this separate from ModelBindingSchema so frozen external contracts are
// not reinterpreted when the runtime provider catalog changes.
export const StoredModelBindingSchema = z
  .object({
    provider: JudgeProviderIdSchema,
    modelId: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1).optional(),
    baseUrl: StoredHttpUrlSchema.optional()
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.provider === "custom" && !binding.baseUrl) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "custom providers require an OpenAI-compatible baseUrl" });
    }
    if (binding.provider !== "custom" && binding.baseUrl !== undefined) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is only valid for custom providers" });
    }
  });
export type StoredModelBinding = z.infer<typeof StoredModelBindingSchema>;

export const ModelBindingInputSchema = z
  .object({
    provider: z.preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      JudgeProviderIdSchema
    ),
    modelId: z.string().trim().min(1).max(240),
    modelVersion: z.string().trim().min(1).max(240),
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1).optional(),
    baseUrl: HttpUrlSchema.optional()
  })
  .superRefine((binding, ctx) => {
    if (binding.provider === "custom" && !binding.baseUrl) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "custom providers require an OpenAI-compatible baseUrl" });
    }
    if (binding.provider !== "custom" && binding.baseUrl !== undefined) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is only valid for custom providers" });
    }
  });
export type ModelBindingInput = z.infer<typeof ModelBindingInputSchema>;

export const MinimumVerdictOutputSchema = {
  type: "object",
  required: ["label", "score", "reason", "confidence"],
  additionalProperties: false,
  properties: {
    label: { type: "string", enum: ["pass", "fail", "ambiguous"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    failureCategory: { type: "string" },
    expectedBehavior: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    criteria: { type: "object" }
  }
} as const;

export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

// The immutable output contract stored with a version must describe the
// verdict tool that the runtime actually asks the provider to complete. The
// legacy MinimumVerdictOutputSchema remains available for historical imports;
// new guided Checks use this kind-aware contract instead of copying the
// seeded binary schema into categorical or scalar versions.
export function verdictOutputSchema(input: {
  verdictKind: VerdictKind;
  scalarRange?: [number, number] | null;
  categoricalChoiceScores?: Record<string, number> | null;
}): JsonSchema {
  const rationale = { type: "string", description: "Short rationale grounded in the Review guide and recorded Run." };
  const failingStep = {
    type: "integer",
    minimum: 0,
    description: "Optional 0-based recorded step where the failure occurred."
  };
  if (input.verdictKind === "scalar") {
    const [minimum, maximum] = input.scalarRange ?? [0, 1];
    return {
      type: "object",
      additionalProperties: false,
      required: ["score", "rationale"],
      properties: {
        score: { type: "number", minimum, maximum },
        rationale,
        failingStep
      }
    };
  }
  if (input.verdictKind === "categorical") {
    const choices = Object.keys(input.categoricalChoiceScores ?? {});
    return {
      type: "object",
      additionalProperties: false,
      required: ["choice", "rationale"],
      properties: {
        choice: { type: "string", enum: choices },
        rationale,
        failingStep
      }
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["label", "score", "rationale"],
    properties: {
      label: { type: "string", enum: ["pass", "fail", "ambiguous"] },
      score: { type: "number", minimum: 0, maximum: 1 },
      rationale,
      failingStep
    }
  };
}

// The one template variable a compiled prompt may reference. The trace itself
// is injected separately by the judge message builder (<trace_to_judge>), so
// prompts must not carry their own trace placeholders.
export const RUBRIC_TEMPLATE_VARIABLE = "{{rubric_markdown}}";

export type JudgePromptDiagnostic =
  | { code: "implicit-rubric" }
  | { code: "unknown-variable"; variable: string };

export interface CompiledJudgePrompt {
  content: string;
  rubricMode: "template" | "legacy-prepend";
  diagnostics: JudgePromptDiagnostic[];
}

const JUDGE_PROMPT_VARIABLE_PATTERN = /{{[^{}\r\n]+}}/g;

export function promptReferencesRubric(prompt: string): boolean {
  return prompt.includes(RUBRIC_TEMPLATE_VARIABLE);
}

// Compile the stored prompt template into judge-facing instructions and report
// anything the editor should surface. Unknown variables deliberately remain
// literal: {{rubric_markdown}} is the only supported variable, while the trace
// and verdict schema are injected separately by the judge message builder.
export function compileJudgePrompt(input: { rubricMarkdown: string; prompt: string }): CompiledJudgePrompt {
  const referencesRubric = promptReferencesRubric(input.prompt);
  const diagnostics: JudgePromptDiagnostic[] = [];

  if (input.rubricMarkdown.trim() && !referencesRubric) {
    diagnostics.push({ code: "implicit-rubric" });
  }

  const variables = new Set(input.prompt.match(JUDGE_PROMPT_VARIABLE_PATTERN) ?? []);
  for (const variable of variables) {
    if (variable !== RUBRIC_TEMPLATE_VARIABLE) {
      diagnostics.push({ code: "unknown-variable", variable });
    }
  }

  return {
    content: referencesRubric
      ? input.prompt.split(RUBRIC_TEMPLATE_VARIABLE).join(input.rubricMarkdown)
      : `${input.rubricMarkdown}\n\n${input.prompt}`,
    rubricMode: referencesRubric ? "template" : "legacy-prepend",
    diagnostics
  };
}

// Stable rendering entry point used by both judge execution paths, including
// the live implicit-rubric prompt mode retained by ADR-0011.
export function renderJudgePromptContent(input: { rubricMarkdown: string; prompt: string }): string {
  return compileJudgePrompt(input).content;
}

export const RubricProvenanceSchema = z.enum(["human-authored", "agent-drafted"]);
export type RubricProvenance = z.infer<typeof RubricProvenanceSchema>;

// Seed text only. Whether a skill is still the untouched starter is persisted
// separately on the skill row; content matching must never authorize setup.
export const STARTER_RUBRIC_MARKER = "Define pass, fail, and ambiguous criteria before production use";

// The default compiled-prompt template, parameterized by what the judge is
// looking at ("trace" for tracing projects, "case" for bench, "captured
// agent-skill run" for agent bootstrap). Single-sourced so the seed and the
// bootstrap default can't diverge.
export function defaultJudgePromptTemplate(subject: string): string {
  return `Judge the ${subject} against the review guide below. Submit exactly one verdict using the provided structured verdict tool.\n\n<review_guide>\n${RUBRIC_TEMPLATE_VARIABLE}\n</review_guide>`;
}
