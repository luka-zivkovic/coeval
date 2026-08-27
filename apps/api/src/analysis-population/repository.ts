import type {
  AnalysisPopulationCreateInput,
  AnalysisPopulationCreateResult,
  AnalysisPopulationDetail,
  AnalysisPopulationExclusionsPage,
  AnalysisPopulationMembersPage,
  AnalysisPopulationOverlapsPage,
  AnalysisPopulationSelectedItemsPage,
  AnalysisPopulationSummariesPage,
  DatasetRevisionPayloadSnapshot
} from "@coeval/shared";

export type AnalysisPopulationProjectRole = "owner" | "member";

export interface AnalysisPopulationActor {
  projectId: string;
  userId: string;
  projectRole: AnalysisPopulationProjectRole;
}

export interface AnalysisPopulationAccess {
  projectId: string;
  userId: string;
  projectRole: AnalysisPopulationProjectRole;
}

export interface AnalysisPopulationPageInput {
  limit: number;
  cursor: string | null;
}

export interface AnalysisPopulationSelectedContent {
  populationId: string;
  datasetRevisionId: string;
  memberId: string;
  revisionItemId: string;
  caseId: string;
  drawPosition: number;
  inputDigest: string;
  itemDigest: string;
  payloadSnapshot: DatasetRevisionPayloadSnapshot;
}

export interface AnalysisPopulationRepository {
  createPopulation(
    actor: AnalysisPopulationActor,
    input: AnalysisPopulationCreateInput
  ): Promise<AnalysisPopulationCreateResult>;
  listPopulations(
    access: AnalysisPopulationAccess,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationSummariesPage>;
  getPopulation(
    access: AnalysisPopulationAccess,
    populationId: string
  ): Promise<AnalysisPopulationDetail | null>;
  listMembers(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationMembersPage | null>;
  listSelections(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationSelectedItemsPage | null>;
  listExclusions(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationExclusionsPage | null>;
  listOverlaps(
    access: AnalysisPopulationAccess,
    populationId: string,
    page: AnalysisPopulationPageInput
  ): Promise<AnalysisPopulationOverlapsPage | null>;
  getSelectedContent(
    access: AnalysisPopulationAccess,
    populationId: string,
    drawPosition: number
  ): Promise<AnalysisPopulationSelectedContent | null>;
}

export const ANALYSIS_POPULATION_ERROR_CODES = [
  "analysis_population_not_found",
  "analysis_population_forbidden",
  "analysis_population_invalid_cursor",
  "analysis_population_idempotency_conflict",
  "analysis_population_identity_unresolved",
  "analysis_population_sealed_overlap",
  "analysis_population_revision_conflict",
  "analysis_population_frame_too_large",
  "analysis_population_frame_empty",
  "analysis_population_budget_invalid",
  "analysis_population_window_too_recent",
  "analysis_population_draw_conflict",
  "analysis_population_state_conflict"
] as const;

export type AnalysisPopulationErrorCode = (typeof ANALYSIS_POPULATION_ERROR_CODES)[number];

export class AnalysisPopulationRepositoryError extends Error {
  constructor(
    readonly code: AnalysisPopulationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "AnalysisPopulationRepositoryError";
  }
}
