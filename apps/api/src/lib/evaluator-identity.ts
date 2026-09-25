import { EvaluatorIdentitySchema, TypedQuestionSchema, type EvaluatorIdentity, type TypedQuestion } from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "./assessment-receipt.js";

/**
 * skillDigest v2 (Rubrist ADR-0014 section 1): SHA-256 over the canonical JSON
 * of the evaluator definition and execution binding, and nothing else. The
 * resolution record is never identity, so it cannot enter this digest; the
 * strict schema refuses any key it doesn't name, and every unset setting must
 * be present as `null`. The digest covers exactly the document it was given:
 * if parsing would change its canonical form, it refuses instead.
 */
export function skillDigestV2(identity: EvaluatorIdentity): string {
  const parsed = EvaluatorIdentitySchema.parse(identity);
  if (canonicalJson(parsed) !== canonicalJson(identity)) {
    throw new Error("evaluator identity changes when parsed, so its digest would not cover the stored document");
  }
  return sha256Digest(parsed);
}

/** The question digest a typed-question definition holds in place of its text (ADR-0014 section 5). */
export function typedQuestionDigest(question: TypedQuestion): string {
  return sha256Digest(TypedQuestionSchema.parse(question));
}
