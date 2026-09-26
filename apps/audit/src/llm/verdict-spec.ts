import { z } from "zod";

// Verdict-kind-aware judging. A skill version pins a verdict shape — binary
// (pass/fail classification with explicit ambiguity abstention), scalar (a
// number in a range), or categorical (a named choice).
// The provider must therefore build a `submit_verdict` tool whose schema matches
// the pinned kind, and return a structured result the platform can persist as a
// tagged-union verdict payload.
//
// This module stays inside `@rubrist/audit` (no `@rubrist/shared` dependency, in
// keeping with the package's standalone schema.ts). The API layer maps the
// audit-local `StructuredVerdict` below onto the shared `VerdictPayload`.

export interface VerdictSpec {
  verdictKind: "binary" | "scalar" | "categorical";
  // Required (ascending) when verdictKind === "scalar".
  scalarRange: [number, number] | null;
  // Required (non-empty) when verdictKind === "categorical".
  categoricalChoiceScores: Record<string, number> | null;
}

// Discriminated union mirroring the three verdict kinds. `binary` carries a
// `score` in [0,1] in addition to its explicit label so the legacy judge_runs
// row keeps the provider-produced number. `ambiguous` is an abstention from
// binary classification, not a third class in calibration metrics.
// optional failingStep — the 0-based index of the supplied trajectory
// step the judge attributes a failure to. Parsed defensively (drop, never
// invent) in parseStructuredVerdict.
const FailingStepSchema = z.number().int().nonnegative();

export const StructuredVerdictSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("binary"),
    label: z.enum(["pass", "fail", "ambiguous"]),
    score: z.number().min(0).max(1),
    rationale: z.string().min(1),
    failingStep: FailingStepSchema.optional()
  }),
  z.object({
    kind: z.literal("scalar"),
    score: z.number(),
    range: z.tuple([z.number(), z.number()]),
    rationale: z.string().min(1),
    failingStep: FailingStepSchema.optional()
  }),
  z.object({
    kind: z.literal("categorical"),
    choice: z.string().min(1),
    choiceScores: z.record(z.string(), z.number()),
    rationale: z.string().min(1),
    failingStep: FailingStepSchema.optional()
  })
]);
export type StructuredVerdict = z.infer<typeof StructuredVerdictSchema>;

// Deterministic JSON for untrusted evidence: object keys sort recursively and
// arrays retain order. HTML-significant code points are escaped after JSON
// encoding, so a trace string can never close or open the surrounding
// XML-like data envelope. JSON.parse recovers the original semantic value.
export function serializeUntrustedJudgeEvidence(value: unknown): string {
  return canonicalEvidenceJson(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

function canonicalEvidenceJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Judge evidence cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Judge evidence cannot contain a cycle");
    const next = new Set(ancestors).add(value);
    return `[${value.map((entry) => entry === undefined ? "null" : canonicalEvidenceJson(entry, next)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (ancestors.has(object)) throw new Error("Judge evidence cannot contain a cycle");
    const next = new Set(ancestors).add(object);
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(object[key], next)}`).join(",")}}`;
  }
  throw new Error(`Judge evidence cannot encode ${typeof value}`);
}

const VERDICT_TOOL_NAME = "submit_verdict";
export { VERDICT_TOOL_NAME };

type JsonSchema = Record<string, unknown>;

// Build the tool's `input_schema` (Anthropic) / function `parameters` (OpenAI)
// from the pinned verdict kind. The model is forced to call this tool, so the
// schema is what constrains the output shape.
export function buildVerdictToolSchema(spec: VerdictSpec, stepCount = 0): JsonSchema {
  const rationale = {
    type: "string",
    description: "Short rationale referencing the rubric and the trace evidence."
  };
  // only trajectory cases (steps supplied) expose the failingStep
  // field — a step-less case's tool schema is byte-identical to before.
  const failingStep = stepCount > 0
    ? {
        failingStep: {
          type: "integer",
          minimum: 0,
          maximum: stepCount - 1,
          description:
            `0-based index of the single trajectory step where the failure occurred (0..${stepCount - 1}). ` +
            "Set ONLY when the verdict is fail and the failure is attributable to one supplied step; otherwise omit."
        }
      }
    : {};

  if (spec.verdictKind === "scalar") {
    const [min, max] = spec.scalarRange ?? [0, 1];
    return {
      type: "object",
      properties: {
        score: {
          type: "number",
          minimum: min,
          maximum: max,
          description: `The score for this trace, in [${min}, ${max}]. Higher is better.`
        },
        rationale,
        ...failingStep
      },
      required: ["score", "rationale"]
    };
  }

  if (spec.verdictKind === "categorical") {
    const choices = Object.keys(spec.categoricalChoiceScores ?? {});
    if (choices.length === 0) {
      throw new Error("Categorical verdict spec has no choices; categoricalChoiceScores must be a non-empty map.");
    }
    return {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: choices,
          description: "The single category that best describes this trace."
        },
        rationale,
        ...failingStep
      },
      required: ["choice", "rationale"]
    };
  }

  // binary
  return {
    type: "object",
    properties: {
      label: {
        type: "string",
        enum: ["pass", "fail", "ambiguous"],
        description:
          "pass if the trace satisfies the rubric, fail if it violates the rubric, or ambiguous when the rubric does not support either classification."
      },
      score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Score in [0,1] for how strongly the trace passes: 1 = strong pass, 0 = strong fail."
      },
      rationale,
      ...failingStep
    },
    required: ["label", "score", "rationale"]
  };
}

// A model-supplied value quoted in a note or an error: bounded, and safe for
// values whose own toString or valueOf would throw.
function describeModelValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// Validate + normalize a raw tool-call result into a StructuredVerdict. Throws
// (loudly) on drift — the tool schema enforces shape server-side, this is
// defense in depth and the seam where range/choiceScores get reattached.
export function parseStructuredVerdict(spec: VerdictSpec, raw: unknown, stepCount = 0): StructuredVerdict {
  const r = (raw ?? {}) as Record<string, unknown>;
  // drop-never-invent. An out-of-range / non-integer / step-less
  // failingStep is dropped and the drop is APPENDED TO THE RATIONALE so the
  // record says what happened; a valid one is attached. A failingStep on a
  // non-failing binary verdict is also dropped (the field means "where the
  // failure occurred").
  const extractFailingStep = (label: "pass" | "fail" | "ambiguous"): { value?: number; note?: string } => {
    const candidate = r.failingStep;
    if (candidate === undefined || candidate === null) return {};
    if (stepCount <= 0) {
      return { note: `judge named failing step ${describeModelValue(candidate)} but the case has no supplied steps — dropped` };
    }
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0 || candidate >= stepCount) {
      return { note: `judge named failing step ${describeModelValue(candidate)}, outside the supplied 0..${stepCount - 1} step range — dropped` };
    }
    if (label !== "fail") {
      const article = label === "ambiguous" ? "an" : "a";
      return { note: `judge named failing step ${candidate} on ${article} ${label} verdict — dropped` };
    }
    return { value: candidate };
  };
  const withNote = (rationale: unknown, note: string | undefined): unknown =>
    note && typeof rationale === "string" ? `${rationale} (${note})` : rationale;

  if (spec.verdictKind === "scalar") {
    const range = spec.scalarRange ?? [0, 1];
    const step = extractFailingStep("fail");
    const verdict = StructuredVerdictSchema.parse({
      kind: "scalar",
      score: r.score,
      range,
      rationale: withNote(r.rationale, step.note),
      ...(step.value !== undefined ? { failingStep: step.value } : {})
    });
    if (verdict.kind === "scalar" && (verdict.score < range[0] || verdict.score > range[1])) {
      throw new Error(`Scalar verdict score ${verdict.score} is outside the pinned range [${range[0]}, ${range[1]}].`);
    }
    return verdict;
  }
  if (spec.verdictKind === "categorical") {
    const choiceScores = spec.categoricalChoiceScores ?? {};
    // Own keys only: a choice such as "constructor" must not match through the prototype.
    if (typeof r.choice !== "string" || !Object.hasOwn(choiceScores, r.choice)) {
      throw new Error(`Categorical verdict choice "${describeModelValue(r.choice)}" is not one of: ${Object.keys(choiceScores).join(", ")}.`);
    }
    const step = extractFailingStep("fail");
    return StructuredVerdictSchema.parse({
      kind: "categorical",
      choice: r.choice,
      choiceScores,
      rationale: withNote(r.rationale, step.note),
      ...(step.value !== undefined ? { failingStep: step.value } : {})
    });
  }
  // Strict: don't infer classification from score or coerce an arbitrary
  // value. The provider-enforced enum and this defensive parse must agree.
  if (r.label !== "pass" && r.label !== "fail" && r.label !== "ambiguous") {
    throw new Error(`Binary verdict "label" must be pass, fail, or ambiguous, got ${describeModelValue(r.label)}.`);
  }
  const step = extractFailingStep(r.label);
  return StructuredVerdictSchema.parse({
    kind: "binary",
    label: r.label,
    // Score is part of the required provider contract. Reject protocol drift
    // rather than inventing confidence for an otherwise valid label.
    score: r.score,
    rationale: withNote(r.rationale, step.note),
    ...(step.value !== undefined ? { failingStep: step.value } : {})
  });
}

// How many trajectory steps the trace carries (0 for step-less cases).
export function traceStepCount(trace: unknown): number {
  if (typeof trace !== "object" || trace === null) return 0;
  const steps = (trace as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps.length : 0;
}
