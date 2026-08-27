import type {
  AnalysisFailureTaxonomyCreateInput,
  AnalysisObservationAssignmentEventInput,
  AnalysisObservationAssignmentEventResult,
  AnalysisObservationAssignmentsPage,
  AnalysisStudyAbandonInput,
  AnalysisStudyCloseInput,
  AnalysisStudyCompleteInput,
  AnalysisStudyCreateInput,
  AnalysisStudyCreateResult,
  AnalysisStudyDetail,
  AnalysisStudyEventResult,
  AnalysisStudyItemEventInput,
  AnalysisStudyItemEventResult,
  AnalysisStudyItemEventsPage,
  AnalysisStudyItemProjection,
  AnalysisStudyItemsPage,
  AnalysisStudyOpenInput,
  AnalysisStudyProjection,
  AnalysisStudySummariesPage,
  AnalysisTaxonomyCoverage,
  AnalysisTaxonomyDetail,
  AnalysisTaxonomyRevisionCreateInput,
  AnalysisTaxonomyRevisionProjection,
  AnalysisTaxonomyRevisionResult,
  AnalysisTaxonomyRevisionsPage,
  DatasetRevisionPayloadSnapshot
} from "@coeval/shared";
import type { AnalysisStudyDeadlineRepository } from "./deadline.js";

export type AnalysisStudyProjectRole = "owner" | "member";

export interface AnalysisStudyAccess {
  projectId: string;
  userId: string;
  projectRole: AnalysisStudyProjectRole;
}

export interface AnalysisStudyActor extends AnalysisStudyAccess {}

export interface AnalysisStudyPageInput {
  limit: number;
  cursor: string | null;
}

export interface AnalysisStudyItemContent {
  projectId: string;
  studyId: string;
  populationId: string;
  drawId: string;
  datasetRevisionId: string;
  studyItemId: string;
  drawItemId: string;
  memberId: string;
  revisionItemId: string;
  caseId: string;
  position: number;
  inputDigest: string;
  itemDigest: string;
  viewEventId: string;
  datasetExposureEventId: string;
  payloadSnapshot: DatasetRevisionPayloadSnapshot;
}

export interface AnalysisStudyItemContext {
  study: AnalysisStudyProjection;
  item: AnalysisStudyItemProjection;
}

export interface AnalysisStudyRepository extends AnalysisStudyDeadlineRepository {
  createStudy(actor: AnalysisStudyActor, input: AnalysisStudyCreateInput): Promise<AnalysisStudyCreateResult>;
  listStudies(access: AnalysisStudyAccess, page: AnalysisStudyPageInput): Promise<AnalysisStudySummariesPage>;
  getStudy(access: AnalysisStudyAccess, studyId: string): Promise<AnalysisStudyDetail | null>;
  openStudy(actor: AnalysisStudyActor, studyId: string, input: AnalysisStudyOpenInput): Promise<AnalysisStudyEventResult>;
  closeStudy(actor: AnalysisStudyActor, studyId: string, input: AnalysisStudyCloseInput): Promise<AnalysisStudyEventResult>;
  completeStudy(actor: AnalysisStudyActor, studyId: string, input: AnalysisStudyCompleteInput): Promise<AnalysisStudyEventResult>;
  abandonStudy(actor: AnalysisStudyActor, studyId: string, input: AnalysisStudyAbandonInput): Promise<AnalysisStudyEventResult>;
  listStudyItems(
    access: AnalysisStudyAccess,
    studyId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisStudyItemsPage | null>;
  listStudyItemEvents(
    access: AnalysisStudyAccess,
    studyId: string,
    studyItemId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisStudyItemEventsPage | null>;
  getStudyItem(
    access: AnalysisStudyAccess,
    studyId: string,
    studyItemId: string
  ): Promise<AnalysisStudyItemContext | null>;
  appendStudyItemEvent(
    actor: AnalysisStudyActor,
    studyId: string,
    studyItemId: string,
    input: AnalysisStudyItemEventInput
  ): Promise<AnalysisStudyItemEventResult>;
  getStudyItemContent(
    access: AnalysisStudyAccess,
    studyId: string,
    studyItemId: string
  ): Promise<AnalysisStudyItemContent | null>;
  createTaxonomy(
    actor: AnalysisStudyActor,
    input: AnalysisFailureTaxonomyCreateInput
  ): Promise<AnalysisTaxonomyRevisionResult>;
  getTaxonomy(access: AnalysisStudyAccess): Promise<AnalysisTaxonomyDetail | null>;
  listTaxonomyRevisions(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisTaxonomyRevisionsPage | null>;
  getTaxonomyRevision(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    revisionId: string
  ): Promise<AnalysisTaxonomyRevisionProjection | null>;
  createTaxonomyRevision(
    actor: AnalysisStudyActor,
    taxonomyId: string,
    input: AnalysisTaxonomyRevisionCreateInput
  ): Promise<AnalysisTaxonomyRevisionResult>;
  listObservationAssignments(
    access: AnalysisStudyAccess,
    taxonomyId: string,
    observationEventId: string,
    page: AnalysisStudyPageInput
  ): Promise<AnalysisObservationAssignmentsPage | null>;
  appendObservationAssignment(
    actor: AnalysisStudyActor,
    taxonomyId: string,
    input: AnalysisObservationAssignmentEventInput
  ): Promise<AnalysisObservationAssignmentEventResult>;
  getTaxonomyCoverage(
    access: AnalysisStudyAccess,
    studyId: string,
    taxonomyRevisionId: string
  ): Promise<AnalysisTaxonomyCoverage | null>;
}

export const ANALYSIS_STUDY_ERROR_CODES = [
  "analysis_study_not_found",
  "analysis_study_forbidden",
  "analysis_study_invalid_cursor",
  "analysis_study_idempotency_conflict",
  "analysis_study_draw_conflict",
  "analysis_study_state_conflict",
  "analysis_study_version_conflict",
  "analysis_study_deadline_invalid",
  "analysis_study_closure_conflict",
  "analysis_study_anchor_invalid",
  "analysis_study_evidence_conflict",
  "analysis_taxonomy_not_found",
  "analysis_taxonomy_conflict",
  "analysis_assignment_conflict"
] as const;

export type AnalysisStudyErrorCode = (typeof ANALYSIS_STUDY_ERROR_CODES)[number];

export class AnalysisStudyRepositoryError extends Error {
  constructor(
    readonly code: AnalysisStudyErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "AnalysisStudyRepositoryError";
  }
}
