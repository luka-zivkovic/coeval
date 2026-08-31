import { z } from "zod";
import {
  JsonSchemaSchema,
  RubricProvenanceSchema,
  SkillStatusSchema,
  StoredModelBindingSchema,
  VerdictKindSchema
} from "./judge.js";

export const SkillVersionSchema = z
  .object({
    id: z.string(),
    skillId: z.string(),
    criterionVersionId: z.string(),
    version: z.string(),
    status: SkillStatusSchema,
    rubricMarkdown: z.string(),
    prompt: z.string(),
    modelBinding: StoredModelBindingSchema,
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
  .refine((v) => v.verdictKind === "categorical" || v.categoricalChoiceScores === null, { message: "categoricalChoiceScores is only valid for categorical kinds" });
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
