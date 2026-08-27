import { createHash } from "node:crypto";
import {
  ANALYSIS_MAX_PROMOTION_SUPPORTS,
  AnalysisCriterionPromotionArtifactSchema,
  AnalysisCriterionPromotionCreateInputSchema,
  AnalysisCriterionPromotionHandoffSchema,
  AnalysisCriterionPromotionSupportInputSchema,
  AnalysisCriterionPromotionSupportArtifactSchema,
  type AnalysisCriterionPromotionArtifact,
  type AnalysisCriterionPromotionCreateInput,
  type AnalysisCriterionPromotionHandoff,
  type AnalysisCriterionPromotionSupportArtifact,
  type AnalysisCriterionPromotionSupportInput
} from "@coeval/shared";
import { canonicalGovernedJsonV1 } from "./governed-content-digest.js";
import { compareCodeUnits } from "./analysis-population.js";

export const ANALYSIS_CRITERION_PROMOTION_REQUEST_DIGEST_BASIS =
  "analysis-criterion-promotion-request/v1" as const;
export const ANALYSIS_CRITERION_PROMOTION_SUPPORT_DIGEST_BASIS =
  "analysis-criterion-promotion-support/v1" as const;
export const ANALYSIS_CRITERION_PROMOTION_SUPPORT_SET_DIGEST_BASIS =
  "analysis-criterion-promotion-support-set/v1" as const;
export const ANALYSIS_CRITERION_PROMOTION_HANDOFF_DIGEST_BASIS =
  "analysis-criterion-promotion-handoff/v1" as const;
export const ANALYSIS_CRITERION_PROMOTION_CONTENT_DIGEST_BASIS =
  "analysis-criterion-promotion-content/v1" as const;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type AnalysisCriterionPromotionContentDigestInput = Pick<
  AnalysisCriterionPromotionArtifact,
  | "contractVersion"
  | "projectId"
  | "studyId"
  | "studyClosureId"
  | "studyClosureDigest"
  | "populationId"
  | "drawId"
  | "sourceDatasetRevisionId"
  | "sourceDatasetRevisionContentDigest"
  | "sourceDatasetRevisionDigest"
  | "taxonomyId"
  | "taxonomyRevisionId"
  | "taxonomyRevisionSequence"
  | "taxonomyRevisionDigest"
  | "codeId"
  | "codeEntryId"
  | "codeEntryDigest"
  | "codeLabel"
  | "codeDefinition"
  | "criterionId"
  | "criterionVersionId"
  | "criterionStableKey"
  | "criterionName"
  | "criterionDefinition"
  | "criterionDigest"
  | "rationale"
  | "supportCount"
  | "supportSetDigest"
  | "criterionAuthoringExposureEventId"
  | "promotedBySubjectId"
  | "handoffVersion"
  | "handoffDigest"
>;

export type AnalysisCriterionPromotionSupportDigestInput = Omit<
  AnalysisCriterionPromotionSupportArtifact,
  "id" | "projectId" | "contentDigest" | "createdAt"
>;

export interface AnalysisCriterionPromotionExistingCommand {
  promotionId: string;
  idempotencyKey: string;
  requestDigest: string;
}

export type AnalysisCriterionPromotionCommandDecision =
  | { kind: "create" }
  | { kind: "replay"; promotionId: string }
  | {
    kind: "conflict";
    code: "analysis_promotion_idempotency_conflict" | "analysis_promotion_code_already_promoted";
  };

export function analysisCriterionPromotionDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalGovernedJsonV1(value)).digest("hex")}`;
}

export function canonicalizeAnalysisCriterionPromotionSupports(
  supports: readonly AnalysisCriterionPromotionSupportInput[]
): AnalysisCriterionPromotionSupportInput[] {
  if (supports.length === 0 || supports.length > ANALYSIS_MAX_PROMOTION_SUPPORTS) {
    throw new Error(`Promotion supports must contain between 1 and ${ANALYSIS_MAX_PROMOTION_SUPPORTS} observations`);
  }
  const parsed = supports.map((support) => AnalysisCriterionPromotionSupportInputSchema.parse(support));
  const observationIds = new Set<string>();
  for (const support of parsed) {
    nonBlank(support.studyItemId, "studyItemId");
    nonBlank(support.closureItemId, "closureItemId");
    digest(support.closureItemDigest, "closureItemDigest");
    nonBlank(support.observationEventId, "observationEventId");
    digest(support.observationEventDigest, "observationEventDigest");
    nonBlank(support.assignmentEventId, "assignmentEventId");
    digest(support.assignmentEventDigest, "assignmentEventDigest");
    if (observationIds.has(support.observationEventId)) {
      throw new Error("Supporting observation identities must be unique");
    }
    observationIds.add(support.observationEventId);
  }
  return parsed.sort((left, right) => comparePromotionSupportInputs(left, right));
}

export function analysisCriterionPromotionStableKey(codeId: string): string {
  const value = `analysis-failure-code:${nonBlank(codeId, "codeId")}`;
  if (value.length > 200) throw new Error("Promoted criterion stable key exceeds the criterion domain");
  return value;
}

export function analysisCriterionPromotionRequestDigest(
  projectId: string,
  input: AnalysisCriterionPromotionCreateInput
): string {
  const parsed = AnalysisCriterionPromotionCreateInputSchema.parse(input);
  const { idempotencyKey: _idempotencyKey, supportingObservations, ...request } = parsed;
  return analysisCriterionPromotionDigest({
    basis: ANALYSIS_CRITERION_PROMOTION_REQUEST_DIGEST_BASIS,
    projectId: nonBlank(projectId, "projectId"),
    ...request,
    supportingObservations: canonicalizeAnalysisCriterionPromotionSupports(supportingObservations)
  });
}

export function analysisCriterionPromotionSupportContentDigest(
  input: AnalysisCriterionPromotionSupportDigestInput
): string {
  const parsed = AnalysisCriterionPromotionSupportArtifactSchema.parse({
    id: "digest_projection",
    projectId: "digest_projection",
    contentDigest: zeroDigest(),
    createdAt: "1970-01-01T00:00:00.000Z",
    ...input
  });
  return analysisCriterionPromotionDigest({
    basis: ANALYSIS_CRITERION_PROMOTION_SUPPORT_DIGEST_BASIS,
    promotionId: parsed.promotionId,
    position: parsed.position,
    studyId: parsed.studyId,
    studyItemId: parsed.studyItemId,
    closureId: parsed.closureId,
    closureItemId: parsed.closureItemId,
    closureItemDigest: parsed.closureItemDigest,
    sourceDatasetRevisionId: parsed.sourceDatasetRevisionId,
    sourceDatasetRevisionItemId: parsed.sourceDatasetRevisionItemId,
    sourceItemDigest: parsed.sourceItemDigest,
    observationEventId: parsed.observationEventId,
    observationEventDigest: parsed.observationEventDigest,
    assignmentEventId: parsed.assignmentEventId,
    assignmentEventDigest: parsed.assignmentEventDigest,
    observationAuthorSubjectId: parsed.observationAuthorSubjectId,
    exampleSelectionExposureEventId: parsed.exampleSelectionExposureEventId
  });
}

export function analysisCriterionPromotionSupportSetDigest(
  promotionId: string,
  supports: readonly Pick<AnalysisCriterionPromotionSupportArtifact, "id" | "position" | "contentDigest">[]
): string {
  const ordered = supports.map((support) => ({
    position: safeInteger(support.position, "position"),
    supportId: nonBlank(support.id, "supportId"),
    contentDigest: digest(support.contentDigest, "contentDigest")
  })).sort((left, right) => left.position - right.position || compareCodeUnits(left.supportId, right.supportId));
  if (ordered.length > ANALYSIS_MAX_PROMOTION_SUPPORTS) {
    throw new Error(`Promotion support set cannot exceed ${ANALYSIS_MAX_PROMOTION_SUPPORTS} observations`);
  }
  const ids = new Set<string>();
  ordered.forEach((support, index) => {
    if (support.position !== index) throw new Error("Promotion support positions must be exactly contiguous");
    if (ids.has(support.supportId)) throw new Error("Promotion support identities must be unique");
    ids.add(support.supportId);
  });
  if (ordered.length === 0) throw new Error("Promotion requires at least one supporting observation");
  return analysisCriterionPromotionDigest({
    basis: ANALYSIS_CRITERION_PROMOTION_SUPPORT_SET_DIGEST_BASIS,
    promotionId: nonBlank(promotionId, "promotionId"),
    supports: ordered
  });
}

export function analysisCriterionPromotionHandoffDigest(
  handoff: Omit<AnalysisCriterionPromotionHandoff, "handoffDigest">
): string {
  const parsed = AnalysisCriterionPromotionHandoffSchema.parse({ ...handoff, handoffDigest: zeroDigest() });
  const { handoffDigest: _handoffDigest, ...content } = parsed;
  return analysisCriterionPromotionDigest({
    basis: ANALYSIS_CRITERION_PROMOTION_HANDOFF_DIGEST_BASIS,
    ...content
  });
}

export function analysisCriterionPromotionContentDigest(
  input: AnalysisCriterionPromotionContentDigestInput
): string {
  const parsed = AnalysisCriterionPromotionArtifactSchema.parse({
    id: "digest_projection",
    promotedByUserId: "digest_projection",
    promoterRole: "owner",
    idempotencyKey: "digest_projection",
    requestDigest: zeroDigest(),
    contentDigest: zeroDigest(),
    createdAt: "1970-01-01T00:00:00.000Z",
    ...input
  });
  return analysisCriterionPromotionDigest({
    basis: ANALYSIS_CRITERION_PROMOTION_CONTENT_DIGEST_BASIS,
    contractVersion: parsed.contractVersion,
    projectId: parsed.projectId,
    studyId: parsed.studyId,
    studyClosureId: parsed.studyClosureId,
    studyClosureDigest: parsed.studyClosureDigest,
    populationId: parsed.populationId,
    drawId: parsed.drawId,
    sourceDatasetRevisionId: parsed.sourceDatasetRevisionId,
    sourceDatasetRevisionContentDigest: parsed.sourceDatasetRevisionContentDigest,
    sourceDatasetRevisionDigest: parsed.sourceDatasetRevisionDigest,
    taxonomyId: parsed.taxonomyId,
    taxonomyRevisionId: parsed.taxonomyRevisionId,
    taxonomyRevisionSequence: parsed.taxonomyRevisionSequence,
    taxonomyRevisionDigest: parsed.taxonomyRevisionDigest,
    codeId: parsed.codeId,
    codeEntryId: parsed.codeEntryId,
    codeEntryDigest: parsed.codeEntryDigest,
    codeLabel: parsed.codeLabel,
    codeDefinition: parsed.codeDefinition,
    criterionId: parsed.criterionId,
    criterionVersionId: parsed.criterionVersionId,
    criterionStableKey: parsed.criterionStableKey,
    criterionName: parsed.criterionName,
    criterionDefinition: parsed.criterionDefinition,
    criterionDigest: parsed.criterionDigest,
    rationale: parsed.rationale,
    supportCount: parsed.supportCount,
    supportSetDigest: parsed.supportSetDigest,
    criterionAuthoringExposureEventId: parsed.criterionAuthoringExposureEventId,
    promotedBySubjectId: parsed.promotedBySubjectId,
    handoffVersion: parsed.handoffVersion,
    handoffDigest: parsed.handoffDigest
  });
}

export function decideAnalysisCriterionPromotionCommand(input: Readonly<{
  idempotencyKey: string;
  requestDigest: string;
  existingByIdempotencyKey: AnalysisCriterionPromotionExistingCommand | null;
  existingForCode: AnalysisCriterionPromotionExistingCommand | null;
}>): AnalysisCriterionPromotionCommandDecision {
  const idempotencyKey = nonBlank(input.idempotencyKey, "idempotencyKey");
  const requestDigest = digest(input.requestDigest, "requestDigest");
  if (input.existingByIdempotencyKey !== null) {
    const existing = validateExistingCommand(input.existingByIdempotencyKey);
    if (existing.idempotencyKey !== idempotencyKey) {
      throw new Error("Idempotency lookup returned a different key");
    }
    return existing.requestDigest === requestDigest
      ? { kind: "replay", promotionId: existing.promotionId }
      : { kind: "conflict", code: "analysis_promotion_idempotency_conflict" };
  }
  if (input.existingForCode !== null) {
    validateExistingCommand(input.existingForCode);
    return { kind: "conflict", code: "analysis_promotion_code_already_promoted" };
  }
  return { kind: "create" };
}

function comparePromotionSupportInputs(
  left: AnalysisCriterionPromotionSupportInput,
  right: AnalysisCriterionPromotionSupportInput
): number {
  for (const key of ["observationEventId", "studyItemId", "closureItemId", "assignmentEventId"] as const) {
    const comparison = compareCodeUnits(left[key], right[key]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function validateExistingCommand(
  command: AnalysisCriterionPromotionExistingCommand
): AnalysisCriterionPromotionExistingCommand {
  return {
    promotionId: nonBlank(command.promotionId, "promotionId"),
    idempotencyKey: nonBlank(command.idempotencyKey, "idempotencyKey"),
    requestDigest: digest(command.requestDigest, "requestDigest")
  };
}

function nonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be canonical nonblank text`);
  }
  return value;
}

function digest(value: string, field: string): string {
  if (!SHA256_DIGEST.test(value)) throw new Error(`${field} must be a sha256 digest`);
  return value;
}

function safeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a nonnegative safe integer`);
  return value;
}

function zeroDigest(): string {
  return `sha256:${"0".repeat(64)}`;
}
