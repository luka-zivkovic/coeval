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

// A strict object parse assigns an own `__proto__` key as the prototype
// instead of reporting it, so a parsed evidence document would silently
// differ from its raw bytes. v2 evidence contracts refuse the key anywhere.
// Internal to sibling shared modules; omitted from the package root. Both
// helpers are iterative, so hostile nesting fails validation instead of the stack.
export function containsOwnProtoKey(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === null || typeof entry !== "object") continue;
    if (!Array.isArray(entry) && Object.hasOwn(entry, "__proto__")) return true;
    stack.push(...(Array.isArray(entry) ? entry : Object.values(entry)));
  }
  return false;
}

/** v2 evidence documents nest no deeper than this; the root is depth 0. */
export const V2_EVIDENCE_MAX_JSON_DEPTH = 64;

/** Whether any array or object sits at a depth greater than `maxDepth`, counting the root as 0. */
export function exceedsJsonDepth(value: unknown, maxDepth: number = V2_EVIDENCE_MAX_JSON_DEPTH): boolean {
  const stack: Array<{ entry: unknown; depth: number }> = [{ entry: value, depth: 0 }];
  while (stack.length > 0) {
    const { entry, depth } = stack.pop()!;
    if (entry === null || typeof entry !== "object") continue;
    if (depth > maxDepth) return true;
    for (const child of Array.isArray(entry) ? entry : Object.values(entry)) stack.push({ entry: child, depth: depth + 1 });
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

/** Where a judge credential comes from: built in (the mock), the project, or the platform environment. */
export const JudgeProviderCredentialSourceSchema = z.enum(["built_in", "project", "environment"]);
export type JudgeProviderCredentialSource = z.infer<typeof JudgeProviderCredentialSourceSchema>;

// Internal shared schema. It remains absent from the package root exports.
export const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "baseUrl must use http or https" });

// Contract-facing model bindings intentionally mirror the frozen receipt-v1
// schema, where provider and sampling values are not restricted to Rubrist's
// current runtime provider catalog.
export const ModelBindingSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  // Honest limitation: no supported provider catalog exposes an immutable
  // snapshot id separate from the model id, so every pin path today stores
  // modelVersion = modelId. The field records WHAT was requested, not a dated
  // snapshot — an upstream silent model revision is not detectable through it.
  modelVersion: z.string(),
  temperature: z.number(),
  topP: z.number().optional(),
  baseUrl: z.string().optional()
});
export type ModelBinding = z.infer<typeof ModelBindingSchema>;



// Calibration evidence only describes the exact model that produced it, so a
// model id the provider can repoint underneath Rubrist cannot become a
// candidate, be activated, or run sealed calibration. Authoring may still use
// one, with a warning. The list is versioned; widening it is a new version.
export const MUTABLE_MODEL_ALIAS_RULE_VERSION = "rubrist-mutable-model-alias/v1";
const MUTABLE_MODEL_ALIAS_NAMES = new Set(["latest", "default", "auto"]);
const MUTABLE_MODEL_ALIAS_SUFFIXES = ["-latest", ":latest"] as const;

/**
 * The alias pattern a model id matches under MUTABLE_MODEL_ALIAS_RULE_VERSION,
 * or null. Exact names are also matched as the final path segment, so a routed
 * id such as `openrouter/auto` counts. Undated ids such as `gpt-4o` are not
 * aliases under this rule; calibration records the provider-observed model.
 */
export function mutableModelAlias(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase().replace(/\/+$/, "");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (MUTABLE_MODEL_ALIAS_NAMES.has(segment)) return segment;
  return MUTABLE_MODEL_ALIAS_SUFFIXES.find((suffix) => normalized.endsWith(suffix)) ?? null;
}

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

/**
 * How deep a saved output schema may nest: skill-format/v2 carries it four
 * levels below the document root (evaluator.identity.definition.outputSchema).
 */
const OUTPUT_SCHEMA_MAX_JSON_DEPTH = V2_EVIDENCE_MAX_JSON_DEPTH - 4;

// A version's output schema follows skill-format/v2's rules at save, so every
// saved version can be exported (ADR-0014 section 7). The raw input is checked
// first, because a record parse drops an own `__proto__` key without a word.
export const JsonSchemaSchema = z.unknown().superRefine((raw, ctx) => {
  if (exceedsJsonDepth(raw, OUTPUT_SCHEMA_MAX_JSON_DEPTH)) {
    ctx.addIssue({ code: "custom", message: `An output schema must not nest deeper than ${OUTPUT_SCHEMA_MAX_JSON_DEPTH} levels` });
  } else if (containsOwnProtoKey(raw)) {
    ctx.addIssue({ code: "custom", message: "An output schema must not contain a __proto__ key" });
  }
}).pipe(z.record(z.string(), z.unknown()));
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

// The immutable output contract stored with a version must describe the
// verdict shape the runtime actually asks the provider for. The
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
// is injected separately by the verdict protocol's user message, so
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
// and verdict schema are injected separately by the verdict protocol.
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
  return `Judge the ${subject} against the review guide below.\n\n<review_guide>\n${RUBRIC_TEMPLATE_VARIABLE}\n</review_guide>`;
}
