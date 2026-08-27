import type { AnalysisWorkflowMeasurementReport } from "@coeval/shared";

export type AnalysisMeasurementProjectRole = "owner" | "member";

export interface AnalysisMeasurementAccess {
  projectId: string;
  userId: string;
  projectRole: AnalysisMeasurementProjectRole;
}

export interface AnalysisMeasurementQuery {
  taxonomyRevisionId: string | null;
  skillVersionId: string | null;
  calibrationArtifactId: string | null;
}

export interface AnalysisMeasurementRepository {
  getReport(
    access: AnalysisMeasurementAccess,
    studyId: string,
    query: AnalysisMeasurementQuery
  ): Promise<AnalysisWorkflowMeasurementReport | null>;
}

export type AnalysisMeasurementErrorCode =
  | "not_found"
  | "invalid_binding"
  | "evidence_unavailable";

export class AnalysisMeasurementRepositoryError extends Error {
  constructor(
    readonly code: AnalysisMeasurementErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "AnalysisMeasurementRepositoryError";
  }
}
