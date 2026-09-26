import { z } from "zod";
import { EvalRunStatusSchema } from "./evaluation-runs.js";
import { containsLoneUtf16Surrogate, containsOwnProtoKey, exceedsJsonDepth } from "./judge.js";
import {
  EvaluatorItemStateSchema,
  EvaluatorScoreSchema,
  ObservedCallSchema,
  SkillDigestInputSchema
} from "./evaluator-execution.js";

// Assessment receipt v2 (Rubrist ADR-0014 section 7). The structural contract
// only: canonical bytes, digests, counters, completeness, and the rules that
// span an item and the evaluator are semantic checks in the API's verifier
// and in contracts/assessment-receipt-v2.md.

export const ASSESSMENT_RECEIPT_V2_CONTRACT = "rubrist/assessment-receipt/v2" as const;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IdentifierSchema = z.string().min(1);

/**
 * What the provider reported back for one attempted call. Every field is
 * `null` when the provider didn't report it; the whole object is `null` only
 * for an item that was never attempted.
 */
export const ReceiptObservedCallSchema = ObservedCallSchema;
export type ReceiptObservedCall = z.infer<typeof ReceiptObservedCallSchema>;

export const AssessmentReceiptV2ItemSchema = z.object({
  clientItemId: IdentifierSchema,
  caseId: IdentifierSchema,
  contentDigest: Sha256DigestSchema,
  result: EvaluatorItemStateSchema,
  verdictId: IdentifierSchema.nullable(),
  evaluatorScore: EvaluatorScoreSchema.nullable(),
  observed: ReceiptObservedCallSchema.nullable()
}).strict();
export type AssessmentReceiptV2Item = z.infer<typeof AssessmentReceiptV2ItemSchema>;

const CountSchema = z.number().int().nonnegative();

const AssessmentReceiptV2ObjectSchema = z.object({
  contract: z.literal(ASSESSMENT_RECEIPT_V2_CONTRACT),
  schemaVersion: z.literal(2),
  receiptId: IdentifierSchema,
  evalRunId: IdentifierSchema,
  projectId: IdentifierSchema,
  skillId: IdentifierSchema,
  skillVersionId: IdentifierSchema,
  status: z.enum(["complete", "incomplete"]),
  run: z.object({
    status: EvalRunStatusSchema,
    totalItems: CountSchema,
    passItems: CountSchema,
    failItems: CountSchema,
    abstainedItems: CountSchema,
    failedItems: CountSchema,
    notAttemptedItems: CountSchema,
    agreedItems: CountSchema
  }).strict(),
  // The execution binding and the definition digest, never the definition's
  // text (ADR-0014 decision 5); skillDigest is recomputed from exactly this.
  evaluator: SkillDigestInputSchema,
  skillDigest: Sha256DigestSchema,
  datasetDigest: Sha256DigestSchema,
  items: z.array(AssessmentReceiptV2ItemSchema).min(1),
  evidenceDigest: Sha256DigestSchema
}).strict();

/**
 * The raw document is checked before the object parse: a strict object parse
 * silently drops an own `__proto__` key, and canonical identities operate on
 * Unicode scalar values, so both are refused wherever they appear.
 */
export const AssessmentReceiptV2Schema = z.unknown().superRefine((raw, ctx) => {
  if (exceedsJsonDepth(raw)) {
    ctx.addIssue({ code: "custom", message: "assessment receipts must not nest deeper than 64 levels" });
    return;
  }
  if (containsOwnProtoKey(raw)) {
    ctx.addIssue({ code: "custom", message: "assessment receipts must not contain a __proto__ key" });
  }
  if (containsLoneUtf16Surrogate(raw)) {
    ctx.addIssue({ code: "custom", message: "assessment receipts must not contain lone UTF-16 surrogates" });
  }
}).pipe(AssessmentReceiptV2ObjectSchema);
export type AssessmentReceiptV2 = z.infer<typeof AssessmentReceiptV2Schema>;
