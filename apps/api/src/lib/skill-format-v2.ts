import {
  SKILL_FORMAT_V2,
  SkillFormatV2Schema,
  type EvaluatorIdentity,
  type SkillFormatV2,
  type SkillFormatV2Example,
  type SkillStatus,
  type TypedQuestion
} from "@rubrist/shared";
import { evaluatorDefinitionDigest, evaluatorOutputContractDigestV2, skillDigestV2, typedQuestionDigest } from "./evaluator-identity.js";

// skill-format/v2 (contracts/skill-format-v2.md). The export route moves here
// in 8D, when the skill-format/v1 export is removed.

export interface BuildSkillFormatV2Input {
  name: string;
  description: string;
  owner: string;
  version: string;
  status: SkillStatus;
  identity: EvaluatorIdentity;
  question: TypedQuestion | null;
  examples: SkillFormatV2Example[];
  notes: string[];
}

export function buildSkillFormatV2(input: BuildSkillFormatV2Input): SkillFormatV2 {
  return verifySkillFormatV2({
    formatVersion: SKILL_FORMAT_V2,
    name: input.name,
    description: input.description,
    owner: input.owner,
    version: input.version,
    status: input.status,
    evaluator: { identity: input.identity, question: input.question },
    digests: {
      definitionDigest: evaluatorDefinitionDigest(input.identity.definition),
      skillDigest: skillDigestV2(input.identity),
      outputContractDigest: evaluatorOutputContractDigestV2(input.identity.definition)
    },
    examples: input.examples,
    notes: input.notes
  });
}

/**
 * Parse a skill-format/v2 document and recompute every digest it states, so an
 * importer accepts exactly the evaluator identity the exporter had.
 */
export function verifySkillFormatV2(raw: unknown, expected: { skillDigest?: string | undefined } = {}): SkillFormatV2 {
  const doc = SkillFormatV2Schema.parse(raw);
  const { identity, question } = doc.evaluator;
  if (question !== null && identity.definition.kind === "typed-question" &&
      typedQuestionDigest(question) !== identity.definition.question.digest) {
    throw new Error("skill-format question text does not match the definition's question digest");
  }
  if (doc.digests.definitionDigest !== evaluatorDefinitionDigest(identity.definition)) {
    throw new Error("skill-format definitionDigest does not match its definition");
  }
  if (doc.digests.skillDigest !== skillDigestV2(identity)) {
    throw new Error("skill-format skillDigest does not match its evaluator identity");
  }
  if (doc.digests.outputContractDigest !== evaluatorOutputContractDigestV2(identity.definition)) {
    throw new Error("skill-format outputContractDigest does not match its definition");
  }
  if (expected.skillDigest !== undefined && doc.digests.skillDigest !== expected.skillDigest) {
    throw new Error(`skill-format evaluator does not match the expected skillDigest ${expected.skillDigest}`);
  }
  return doc;
}
