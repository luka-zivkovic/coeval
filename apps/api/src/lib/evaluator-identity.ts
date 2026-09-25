import {
  EvaluatorDefinitionSchema,
  EvaluatorIdentitySchema,
  SkillDigestInputSchema,
  TypedQuestionSchema,
  type EvaluatorDefinition,
  type EvaluatorIdentity,
  type SkillDigestInput,
  type TypedQuestion
} from "@rubrist/shared";
import { createHash } from "node:crypto";
import { type ZodType } from "zod";
import { canonicalJson, sha256Digest } from "./assessment-receipt.js";

/**
 * Parses a document and refuses it if parsing would change its canonical
 * form, so a digest always covers exactly the document it was given.
 */
function parseExactly<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.parse(value);
  if (canonicalJson(parsed) !== canonicalJson(value)) {
    throw new Error(`${what} changes when parsed, so its digest would not cover the stored document`);
  }
  return parsed;
}

/** SHA-256 of the canonical evaluator definition (ADR-0014 section 1). */
export function evaluatorDefinitionDigest(definition: EvaluatorDefinition): string {
  return sha256Digest(parseExactly(EvaluatorDefinitionSchema, definition, "evaluator definition"));
}

/**
 * The digest input evidence carries (ADR-0014 decision 5): the binding and the
 * definition digest, never the definition's text. The identity is parsed
 * whole first, so the typed-question and protocol rules still apply.
 */
export function skillDigestInput(identity: EvaluatorIdentity): SkillDigestInput {
  const parsed = parseExactly(EvaluatorIdentitySchema, identity, "evaluator identity");
  return {
    basis: parsed.basis,
    definitionDigest: evaluatorDefinitionDigest(parsed.definition),
    executionBinding: parsed.executionBinding
  };
}

/**
 * skillDigest v2 from what a receipt carries: SHA-256 over the canonical
 * basis, definition digest, and execution binding. A verifier needs nothing
 * else; it needs the definition only to check the definition digest.
 */
export function skillDigestV2FromInput(input: SkillDigestInput): string {
  return sha256Digest(parseExactly(SkillDigestInputSchema, input, "skillDigest input"));
}

/**
 * skillDigest v2 (ADR-0014 section 1) of a whole identity. The resolution
 * record is never identity, so it can't enter this digest: the strict schemas
 * refuse any key they don't name, and every unset setting is present as `null`.
 */
export function skillDigestV2(identity: EvaluatorIdentity): string {
  return skillDigestV2FromInput(skillDigestInput(identity));
}

/**
 * The output-contract digest calibration and suite manifests bind beside
 * skillDigest. For a prompted definition it is v1's formula over the output
 * schema, verdict kind, scalar range, and categorical scores; a typed-question
 * definition's output contract is its question type, polarity, and the
 * absence of a rationale (ADR-0014 section 5).
 */
export function evaluatorOutputContractDigestV2(definition: EvaluatorDefinition): string {
  const parsed = parseExactly(EvaluatorDefinitionSchema, definition, "evaluator definition");
  return parsed.kind === "prompted"
    ? sha256Digest({
        outputSchema: parsed.outputSchema,
        verdictKind: parsed.verdictKind,
        scalarRange: parsed.scalarRange,
        categoricalChoiceScores: parsed.categoricalChoiceScores
      })
    : sha256Digest({
        kind: "typed-question",
        questionType: parsed.question.type,
        polarity: parsed.polarity,
        rationale: parsed.rationale
      });
}

/**
 * The digest a binding uses to name a custom endpoint (ADR-0014 section 2):
 * SHA-256 over the UTF-8 bytes of a domain-separation prefix and the base URL
 * exactly as configured, with no normalization. The URL itself stays out of
 * identity and evidence.
 */
export function endpointBaseUrlDigest(baseUrl: string): string {
  return `sha256:${createHash("sha256").update("rubrist/endpoint-base-url/v1\0", "utf8").update(baseUrl, "utf8").digest("hex")}`;
}

/** The question digest a typed-question definition holds in place of its text (ADR-0014 section 5). */
export function typedQuestionDigest(question: TypedQuestion): string {
  return sha256Digest(parseExactly(TypedQuestionSchema, question, "typed question"));
}
