import { z } from "zod";
import { EvaluatorSuiteApplicabilitySchema, EvaluatorSuiteTrialPlanSchema } from "./criterion-governance.js";
import { containsLoneUtf16Surrogate, containsOwnProtoKey } from "./judge.js";

// Evaluator suite manifest v2 (Rubrist ADR-0014 section 7). The shape is v1's;
// what changes is what the evaluator digests mean: `skillDigest` is v2 (over
// the evaluator identity) and `outputContractDigest` is the v2 output-contract
// digest, which keeps v1's formula for prompted definitions.

export const EVALUATOR_SUITE_MANIFEST_V2_CONTRACT = "rubrist/evaluator-suite-manifest/v2" as const;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IdentifierSchema = z.string().min(1);

export const EvaluatorSuiteManifestV2MemberSchema = z.object({
  position: z.number().int().nonnegative(),
  criterionId: IdentifierSchema,
  criterionVersionId: IdentifierSchema,
  criterionName: IdentifierSchema,
  criterionDefinition: IdentifierSchema,
  criterionDigest: Sha256DigestSchema,
  skillId: IdentifierSchema,
  skillVersionId: IdentifierSchema,
  skillDigest: Sha256DigestSchema,
  outputContractDigest: Sha256DigestSchema,
  applicability: EvaluatorSuiteApplicabilitySchema
}).strict();
export type EvaluatorSuiteManifestV2Member = z.infer<typeof EvaluatorSuiteManifestV2MemberSchema>;

const EvaluatorSuiteManifestV2ObjectSchema = z.object({
  contract: z.literal(EVALUATOR_SUITE_MANIFEST_V2_CONTRACT),
  schemaVersion: z.literal(2),
  manifestId: IdentifierSchema,
  suiteId: IdentifierSchema,
  projectId: IdentifierSchema,
  revision: z.number().int().positive(),
  members: z.array(EvaluatorSuiteManifestV2MemberSchema).min(1),
  trialPlan: EvaluatorSuiteTrialPlanSchema.nullable(),
  manifestDigest: Sha256DigestSchema
}).strict();

/** The raw document is checked first: no `__proto__` key and no lone surrogate anywhere. */
export const EvaluatorSuiteManifestV2Schema = z.unknown().superRefine((raw, ctx) => {
  if (containsOwnProtoKey(raw)) {
    ctx.addIssue({ code: "custom", message: "suite manifests must not contain a __proto__ key" });
  }
  if (containsLoneUtf16Surrogate(raw)) {
    ctx.addIssue({ code: "custom", message: "suite manifests must not contain lone UTF-16 surrogates" });
  }
}).pipe(EvaluatorSuiteManifestV2ObjectSchema);
export type EvaluatorSuiteManifestV2 = z.infer<typeof EvaluatorSuiteManifestV2Schema>;
