import { EvaluatorIdentitySchema, type EvaluatorIdentity } from "@rubrist/shared";
import { sha256Digest } from "./assessment-receipt.js";

/**
 * skillDigest v2 (Rubrist ADR-0014 section 1): SHA-256 over the canonical JSON
 * of the evaluator definition and execution binding, and nothing else. The
 * resolution record is never identity, so it cannot enter this digest; the
 * strict schema refuses any key it doesn't name, and every unset setting must
 * be present as `null`.
 */
export function skillDigestV2(identity: EvaluatorIdentity): string {
  return sha256Digest(EvaluatorIdentitySchema.parse(identity));
}
