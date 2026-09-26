import { z } from "zod";
import { ExecutionBindingSchema, TypedQuestionSchema } from "./evaluator-execution.js";
import {
  JsonSchemaSchema,
  MinimumVerdictOutputSchema,
  RubricProvenanceSchema,
  SkillStatusSchema,
  TypedQuestionOutputSchema,
  VerdictKindSchema,
  isTypedQuestionOutputSchema
} from "./judge.js";

/**
 * The definition-kind rules for evaluator input (ADR-0014 section 5). A
 * typed-question/v1 binding takes a question and a decision threshold and no
 * rubric or prompt, is binary, and may send only the fixed output contract;
 * every other binding takes a rubric and a prompt and no question or
 * threshold. Each issue is the field it names and why.
 */
export function evaluatorDefinitionInputIssues(input: {
  executionBinding: { verdictProtocol: string };
  rubricMarkdown?: string | undefined;
  prompt?: string | undefined;
  typedQuestion?: unknown;
  decisionThreshold?: number | undefined;
  verdictKind?: string | undefined;
  outputSchema?: unknown;
}): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  // PostgreSQL text and jsonb can't hold a NUL character.
  const question = typeof input.typedQuestion === "object" && input.typedQuestion !== null
    ? input.typedQuestion as { instructions?: unknown; criteria?: { true?: unknown; false?: unknown } }
    : null;
  for (const [path, text] of [
    ["rubricMarkdown", input.rubricMarkdown],
    ["prompt", input.prompt],
    ["typedQuestion", question?.instructions],
    ["typedQuestion", question?.criteria?.true],
    ["typedQuestion", question?.criteria?.false]
  ] as const) {
    if (typeof text === "string" && text.includes("\u0000")) issue(path, "evaluator text must not contain a NUL character");
  }
  if (input.executionBinding.verdictProtocol === "typed-question/v1") {
    if (input.typedQuestion === undefined) issue("typedQuestion", "a typed-question evaluator names its question");
    if (input.decisionThreshold === undefined) issue("decisionThreshold", "a typed-question evaluator declares its decision threshold; there is no default");
    if (input.rubricMarkdown !== undefined) issue("rubricMarkdown", "a typed-question evaluator has no rubric");
    if (input.prompt !== undefined) issue("prompt", "a typed-question evaluator has no prompt");
    if (input.verdictKind !== undefined && input.verdictKind !== "binary") issue("verdictKind", "a typed-question evaluator is binary");
    // The contract is fixed, so it may be left out or sent back unchanged.
    if (input.outputSchema !== undefined && !isTypedQuestionOutputSchema(input.outputSchema)) {
      issue("outputSchema", "a typed-question evaluator's output contract is the fixed probability schema");
    }
  } else {
    if (input.rubricMarkdown === undefined) issue("rubricMarkdown", "a prompted evaluator needs a rubric");
    if (input.prompt === undefined) issue("prompt", "a prompted evaluator needs a prompt");
    if (input.typedQuestion !== undefined) issue("typedQuestion", "only a typed-question evaluator names a question");
    if (input.decisionThreshold !== undefined) issue("decisionThreshold", "only a typed-question evaluator declares a decision threshold");
  }
  return issues;
}

/** The output contract an evaluator's input defaults to: the typed-question contract, or the minimum verdict schema. */
export function defaultEvaluatorOutputSchema(verdictProtocol: string): Record<string, unknown> {
  return verdictProtocol === "typed-question/v1" ? TypedQuestionOutputSchema : MinimumVerdictOutputSchema;
}

export const SkillVersionSchema = z
  .object({
    id: z.string(),
    skillId: z.string(),
    criterionVersionId: z.string(),
    version: z.string(),
    status: SkillStatusSchema,
    // A prompted version's rubric and prompt; null for a typed-question version.
    rubricMarkdown: z.string().nullable(),
    prompt: z.string().nullable(),
    // A typed-question version (ADR-0014 section 5) asks a question instead:
    // its text, and the decision threshold on P(pass), chosen on nonsealed data
    // and part of its identity. Both null for a prompted version.
    typedQuestion: TypedQuestionSchema.nullable(),
    decisionThreshold: z.number().gt(0).lt(1).nullable(),
    // Identity (ADR-0014 section 1): exactly what every call sends.
    executionBinding: ExecutionBindingSchema,
    // A custom provider's configured base URL, which the binding names only by
    // digest. Not identity; null for every other binding.
    customEndpointUrl: z.string().nullable(),
    outputSchema: JsonSchemaSchema,
    goldenSetAgreement: z.number().min(0).max(1).nullable(),
    tooStrictCount: z.number().int().nonnegative(),
    tooLenientCount: z.number().int().nonnegative(),
    ambiguousCount: z.number().int().nonnegative(),
    knownLimitations: z.array(z.string()),
    // v2: every skill version is bound to a verdict shape. Binary classifies
    // pass/fail and supports explicit ambiguous abstention. Scalar + categorical
    // kinds carry their range or choiceScores; refine below enforces shape
    // consistency at the boundary.
    verdictKind: VerdictKindSchema,
    scalarRange: z.tuple([z.number(), z.number()]).nullable(),
    categoricalChoiceScores: z.record(z.string(), z.number().min(0).max(1)).nullable(),
    rubricProvenance: RubricProvenanceSchema,
    // Beginner assurance is independent from the legacy regression lifecycle:
    // an empty known-failure gate may approve execution, but it cannot validate
    // the Check. This marker survives that transition until a future governed
    // calibration flow replaces it with a scoped assurance state.
    onboardingAssurance: z.literal("starter_unvalidated").nullable().optional(),
    // Draft and starter-sign-off versions can legitimately have no regression
    // corpus. Every calibrating or gated version carries an immutable pin.
    regressionDatasetRevisionId: z.string().nullable(),
    createdAt: z.string(),
    approvedAt: z.string().nullable()
  })
  .refine(
    (v) => v.verdictKind !== "scalar" || (v.scalarRange !== null && v.scalarRange[0] < v.scalarRange[1]),
    { message: "scalar skill versions require an ascending scalarRange" }
  )
  .refine(
    (v) => v.verdictKind !== "categorical" || (v.categoricalChoiceScores !== null && Object.keys(v.categoricalChoiceScores).length > 0),
    { message: "categorical skill versions require a non-empty categoricalChoiceScores map" }
  )
  .refine((v) => v.verdictKind === "scalar" || v.scalarRange === null, { message: "scalarRange is only valid for scalar kinds" })
  .refine((v) => v.verdictKind === "categorical" || v.categoricalChoiceScores === null, { message: "categoricalChoiceScores is only valid for categorical kinds" })
  .refine((v) => (v.executionBinding.provider === "custom") === (v.customEndpointUrl !== null), {
    message: "custom bindings keep their endpoint URL, and only they do"
  })
  .refine((v) => v.executionBinding.verdictProtocol === "typed-question/v1"
    ? v.typedQuestion !== null && v.decisionThreshold !== null && v.rubricMarkdown === null && v.prompt === null &&
      v.verdictKind === "binary" && isTypedQuestionOutputSchema(v.outputSchema)
    : v.typedQuestion === null && v.decisionThreshold === null && v.rubricMarkdown !== null && v.prompt !== null, {
    message: "a typed-question version holds a question, a threshold, and the fixed probability contract and no rubric or prompt, and a prompted version a rubric and prompt and no question or threshold"
  });
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  criterionId: z.string(),
  name: z.string(),
  description: z.string(),
  ownerName: z.string(),
  status: SkillStatusSchema,
  // Durable onboarding state. It is cleared transactionally by the first
  // human sign-off/edit or by agent bootstrap; rubric text is not authority.
  isStarter: z.boolean(),
  currentVersion: SkillVersionSchema
});
export type Skill = z.infer<typeof SkillSchema>;
