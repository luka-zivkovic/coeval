import type {
  AnalysisCriterionPromotionCandidatesPage,
  AnalysisCriterionPromotionCreateInput,
  AnalysisCriterionPromotionCreateResult,
  AnalysisCriterionPromotionDetail,
  AnalysisCriterionPromotionSummariesPage,
  AnalysisCriterionPromotionSupportsPage
} from "@coeval/shared";

export type AnalysisPromotionProjectRole = "owner" | "member";

export interface AnalysisPromotionAccess {
  projectId: string;
  userId: string;
  projectRole: AnalysisPromotionProjectRole;
}

export interface AnalysisPromotionActor extends AnalysisPromotionAccess {}

export interface AnalysisPromotionPageInput {
  limit: number;
  cursor: string | null;
}

export interface AnalysisPromotionCandidatePageInput extends AnalysisPromotionPageInput {
  studyId: string;
  taxonomyRevisionId: string;
  codeId: string;
}

export interface AnalysisPromotionRepository {
  createPromotion(
    actor: AnalysisPromotionActor,
    input: AnalysisCriterionPromotionCreateInput
  ): Promise<AnalysisCriterionPromotionCreateResult>;
  listPromotions(
    access: AnalysisPromotionAccess,
    studyId: string,
    page: AnalysisPromotionPageInput
  ): Promise<AnalysisCriterionPromotionSummariesPage>;
  listCandidates(
    access: AnalysisPromotionAccess,
    input: AnalysisPromotionCandidatePageInput
  ): Promise<AnalysisCriterionPromotionCandidatesPage>;
  getPromotion(
    access: AnalysisPromotionAccess,
    promotionId: string
  ): Promise<AnalysisCriterionPromotionDetail | null>;
  listSupports(
    access: AnalysisPromotionAccess,
    promotionId: string,
    page: AnalysisPromotionPageInput
  ): Promise<AnalysisCriterionPromotionSupportsPage | null>;
}

export const ANALYSIS_PROMOTION_ERROR_CODES = [
  "analysis_promotion_not_found",
  "analysis_promotion_forbidden",
  "analysis_promotion_invalid_cursor",
  "analysis_promotion_idempotency_conflict",
  "analysis_promotion_code_already_promoted",
  "analysis_promotion_state_conflict",
  "analysis_promotion_closure_conflict",
  "analysis_promotion_taxonomy_conflict",
  "analysis_promotion_code_conflict",
  "analysis_promotion_support_conflict",
  "analysis_promotion_subject_unavailable"
] as const;

export type AnalysisPromotionErrorCode = (typeof ANALYSIS_PROMOTION_ERROR_CODES)[number];

export class AnalysisPromotionRepositoryError extends Error {
  constructor(
    readonly code: AnalysisPromotionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "AnalysisPromotionRepositoryError";
  }
}
