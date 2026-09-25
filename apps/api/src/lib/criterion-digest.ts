import { sha256Digest } from "./canonical-json.js";

// The digest that names one criterion version's definition wherever evidence
// refers to it: suite manifests, governed review, promotion, and seeds.

export interface CriterionDigestInput {
  criterionId: string;
  criterionVersionId: string;
  criterionName: string;
  criterionDefinition: string;
}

export function criterionVersionDigest(input: CriterionDigestInput): string {
  return sha256Digest({
    criterionId: input.criterionId,
    criterionVersionId: input.criterionVersionId,
    criterionName: input.criterionName,
    criterionDefinition: input.criterionDefinition
  });
}
