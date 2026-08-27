import { AnalysisPromotionApiError } from "./analysis-promotion-api.js";
import { AnalysisStudyApiError } from "./analysis-study-api.js";
import { CRITERION_QUERY_PARAM } from "./criterion-selection.js";

export interface AnalysisPromotionUiContext {
  studyId: string;
  taxonomyRevisionId: string;
  codeId: string;
}

export function analysisMutationFailureKind(
  cause: unknown
): "definitive_failure" | "ambiguous_failure" {
  return (cause instanceof AnalysisStudyApiError || cause instanceof AnalysisPromotionApiError) && cause.status < 500
    ? "definitive_failure"
    : "ambiguous_failure";
}

export function analysisPromotionHandoffInstructionHref(
  criterionId: string,
  promotionId: string
): string {
  return `/human-truth/new/instruction?${CRITERION_QUERY_PARAM}=${encodeURIComponent(criterionId)}` +
    `&promotionId=${encodeURIComponent(promotionId)}`;
}

export function analysisPromotionContextMatches(
  current: AnalysisPromotionUiContext,
  expected: AnalysisPromotionUiContext
): boolean {
  return current.studyId === expected.studyId &&
    current.taxonomyRevisionId === expected.taxonomyRevisionId &&
    current.codeId === expected.codeId;
}
