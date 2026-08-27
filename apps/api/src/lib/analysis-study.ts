import { createHash } from "node:crypto";
import {
  ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
  ANALYSIS_STUDY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_COVERAGE_VERSION,
  AnalysisStudyItemEventArtifactSchema,
  type AnalysisFailureCodeArtifact,
  type AnalysisFailureTaxonomyCreateInput,
  type AnalysisFailureTaxonomyArtifact,
  type AnalysisObservationAssignmentEventArtifact,
  type AnalysisObservationAssignmentEventInput,
  type AnalysisRepresentativeReason,
  type AnalysisStudyArtifact,
  type AnalysisStudyClosureItemArtifact,
  type AnalysisStudyClosureArtifact,
  type AnalysisStudyEventArtifact,
  type AnalysisStudyItemArtifact,
  type AnalysisStudyItemEventArtifact,
  type AnalysisStudyItemEventInput,
  type AnalysisStudyItemProjection,
  type AnalysisStudyItemState,
  type AnalysisStudyItemViewArtifact,
  type AnalysisStudyProjection,
  type AnalysisTaxonomyCoverage,
  type AnalysisTaxonomyRevisionArtifact,
  type AnalysisTaxonomyRevisionCodeArtifact,
  type AnalysisTaxonomyRevisionCreateInput,
  type AnalysisTaxonomyRevisionProjection
} from "@coeval/shared";
import { canonicalGovernedJsonV1 } from "./governed-content-digest.js";
import { compareCodeUnits, normalizeAnalysisPopulationTimestamp } from "./analysis-population.js";

export const ANALYSIS_STUDY_REQUEST_DIGEST_BASIS = "analysis-study-request/v1" as const;
export const ANALYSIS_STUDY_CONTENT_DIGEST_BASIS = "analysis-study/v1" as const;
export const ANALYSIS_STUDY_ITEM_DIGEST_BASIS = "analysis-study-item/v1" as const;
export const ANALYSIS_STUDY_EVENT_DIGEST_BASIS = "analysis-study-event/v1" as const;
export const ANALYSIS_STUDY_EVENT_REQUEST_DIGEST_BASIS = "analysis-study-event-request/v1" as const;
export const ANALYSIS_STUDY_ITEM_EVENT_DIGEST_BASIS = "analysis-study-item-event/v1" as const;
export const ANALYSIS_STUDY_ITEM_EVENT_REQUEST_DIGEST_BASIS = "analysis-study-item-event-request/v1" as const;
export const ANALYSIS_STUDY_ITEM_VIEW_DIGEST_BASIS = "analysis-study-item-view/v1" as const;
export const ANALYSIS_STUDY_ITEM_VIEW_REQUEST_DIGEST_BASIS = "analysis-study-item-view-request/v1" as const;
export const ANALYSIS_STUDY_VIEW_SET_DIGEST_BASIS = "analysis-study-view-set/v1" as const;
export const ANALYSIS_STUDY_CLOSURE_ITEM_DIGEST_BASIS = "analysis-study-closure-item/v1" as const;
export const ANALYSIS_STUDY_CLOSURE_CONTENT_DIGEST_BASIS = "analysis-study-closure-content/v1" as const;
export const ANALYSIS_REPRESENTATIVE_ASSESSMENT_DIGEST_BASIS = "representative-assessment-time/v1" as const;
export const ANALYSIS_STUDY_CLOSURE_DIGEST_BASIS = "analysis-study-closure/v1" as const;
export const ANALYSIS_TAXONOMY_CONTENT_DIGEST_BASIS = "analysis-taxonomy-content/v1" as const;
export const ANALYSIS_TAXONOMY_REVISION_CODE_DIGEST_BASIS = "analysis-taxonomy-revision-code/v1" as const;
export const ANALYSIS_TAXONOMY_REVISION_DIGEST_BASIS = "analysis-taxonomy-revision/v1" as const;
export const ANALYSIS_TAXONOMY_REQUEST_DIGEST_BASIS = "analysis-taxonomy-request/v1" as const;
export const ANALYSIS_TAXONOMY_CODE_DIGEST_BASIS = "analysis-taxonomy-code/v1" as const;
export const ANALYSIS_ASSIGNMENT_REQUEST_DIGEST_BASIS = "analysis-observation-assignment-request/v1" as const;
export const ANALYSIS_ASSIGNMENT_EVENT_DIGEST_BASIS = "analysis-observation-assignment/v1" as const;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface AnalysisStudyRepresentativeAssessmentInput {
  populationId: string;
  methodEligible: boolean;
  frozenFrameDigest: string;
  recomputedFrameDigest: string | null;
  frozenDrawDigest: string;
  recomputedDrawDigest: string | null;
  selectedItemCount: number;
  closureItems: readonly Pick<AnalysisStudyClosureItemArtifact, "studyItemId" | "position" | "itemState">[];
}

export interface AnalysisStudyRepresentativeAssessment {
  assessmentVersion: typeof ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION;
  methodEligible: boolean;
  frameReproducible: boolean;
  drawComplete: boolean;
  codingComplete: boolean;
  drawnFromPopulationId: string;
  representativeOfPopulationId: string | null;
  representativeReason: AnalysisRepresentativeReason | null;
  assessmentDigest: string;
}

export interface AnalysisStudyClosureItemDigestInput {
  studyId: string;
  studyItemId: string;
  drawItemId: string;
  caseId: string;
  position: number;
  itemState: AnalysisStudyItemState;
  itemEventVersion: string;
  currentEventId: string | null;
  currentEventDigest: string | null;
  viewEventIds: readonly string[];
  viewEventDigests: readonly string[];
  activeFailureObservationEventIds: readonly string[];
  activeFailureObservationEventDigests: readonly string[];
  activeFailureAssignmentEventIds: readonly (string | null)[];
  activeFailureAssignmentEventDigests: readonly (string | null)[];
  activeNoFailureEventId: string | null;
  activeNoFailureEventDigest: string | null;
  completionEventId: string | null;
  completionEventDigest: string | null;
}

export interface AnalysisStudyCoverageInput {
  studyId: string;
  taxonomy: AnalysisFailureTaxonomyArtifact;
  targetRevision: AnalysisTaxonomyRevisionProjection;
  revisionAncestry: readonly Pick<AnalysisTaxonomyRevisionArtifact, "id" | "sequence">[];
  items: readonly AnalysisStudyItemProjection[];
  assignmentEvents: readonly AnalysisObservationAssignmentEventArtifact[];
}

export type AnalysisStudyEventRequestDigestInput =
  | { studyId: string; expectedVersion: string; eventType: "coding_opened"; stoppingRule: unknown }
  | { studyId: string; expectedVersion: string; eventType: "coding_closed"; reason: string | null }
  | { studyId: string; expectedVersion: string; eventType: "study_completed"; expectedClosureDigest: string }
  | { studyId: string; expectedVersion: string; eventType: "study_abandoned"; reason: string };

export interface AnalysisTaxonomyRevisionDigestInput {
  taxonomyId: string;
  sequence: number;
  predecessorRevisionId: string | null;
  predecessorRevisionDigest: string | null;
  reason: string;
  contentDigest: string;
}

export function analysisStudyDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalGovernedJsonV1(value)).digest("hex")}`;
}

export function analysisStudyRequestDigest(projectId: string, populationId: string): string {
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_REQUEST_DIGEST_BASIS,
    projectId: nonBlank(projectId, "projectId"),
    populationId: nonBlank(populationId, "populationId")
  });
}

export function analysisStudyContentDigest(study: Pick<AnalysisStudyArtifact,
  "projectId" | "populationId" | "drawId" | "datasetRevisionId" | "contractVersion">): string {
  if (study.contractVersion !== ANALYSIS_STUDY_CONTRACT_VERSION) throw new Error("Unknown analysis study contract");
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_CONTENT_DIGEST_BASIS,
    projectId: nonBlank(study.projectId, "projectId"),
    populationId: nonBlank(study.populationId, "populationId"),
    drawId: nonBlank(study.drawId, "drawId"),
    datasetRevisionId: nonBlank(study.datasetRevisionId, "datasetRevisionId"),
    contractVersion: study.contractVersion
  });
}

export function analysisStudyItemContentDigest(item: Omit<AnalysisStudyItemArtifact, "id" | "projectId" | "createdAt" | "contentDigest">): string {
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_ITEM_DIGEST_BASIS,
    studyId: nonBlank(item.studyId, "studyId"),
    drawItemId: nonBlank(item.drawItemId, "drawItemId"),
    memberId: nonBlank(item.memberId, "memberId"),
    revisionItemId: nonBlank(item.revisionItemId, "revisionItemId"),
    caseId: nonBlank(item.caseId, "caseId"),
    position: safePosition(item.position)
  });
}

export function analysisStudyEventRequestDigest(input: Readonly<AnalysisStudyEventRequestDigestInput>): string {
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_EVENT_REQUEST_DIGEST_BASIS,
    ...input,
    studyId: nonBlank(input.studyId, "studyId"),
    expectedVersion: exactCount(input.expectedVersion, "expectedVersion")
  });
}

type AnalysisStudyEventDigestInput = AnalysisStudyEventArtifact extends infer Event
  ? Event extends unknown ? Omit<Event, "eventDigest"> : never
  : never;

export function analysisStudyEventDigest(event: AnalysisStudyEventDigestInput): string {
  const content = { ...event, occurredAt: normalizeAnalysisPopulationTimestamp(event.occurredAt) };
  return analysisStudyDigest({ basis: ANALYSIS_STUDY_EVENT_DIGEST_BASIS, ...content });
}

type AnalysisStudyItemEventDigestInput = AnalysisStudyItemEventArtifact extends infer Event
  ? Event extends unknown ? Omit<Event, "eventDigest"> : never
  : never;

export function analysisStudyItemEventDigest(event: AnalysisStudyItemEventDigestInput): string {
  const parsed = AnalysisStudyItemEventArtifactSchema.parse({
    ...event,
    eventDigest: `sha256:${"0".repeat(64)}`
  });
  const { eventDigest: _eventDigest, ...content } = parsed;
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_ITEM_EVENT_DIGEST_BASIS,
    ...content,
    occurredAt: normalizeAnalysisPopulationTimestamp(parsed.occurredAt)
  });
}

export function analysisStudyItemEventRequestDigest(
  projectId: string,
  studyId: string,
  studyItemId: string,
  input: AnalysisStudyItemEventInput
): string {
  const { idempotencyKey: _idempotencyKey, ...request } = input;
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_ITEM_EVENT_REQUEST_DIGEST_BASIS,
    projectId: nonBlank(projectId, "projectId"),
    studyId: nonBlank(studyId, "studyId"),
    studyItemId: nonBlank(studyItemId, "studyItemId"),
    ...request
  });
}

export function analysisStudyItemViewContentDigest(view: Omit<AnalysisStudyItemViewArtifact, "contentDigest">): string {
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_ITEM_VIEW_DIGEST_BASIS,
    projectId: view.projectId,
    studyId: view.studyId,
    studyItemId: view.studyItemId,
    viewerUserId: view.viewerUserId,
    viewerSubjectId: view.viewerSubjectId,
    datasetExposureEventId: view.datasetExposureEventId,
    countsTowardClosure: view.countsTowardClosure,
    requestDigest: digest(view.requestDigest, "requestDigest"),
    viewedAt: normalizeAnalysisPopulationTimestamp(view.viewedAt)
  });
}

export function analysisStudyItemViewRequestDigest(input: Readonly<{
  projectId: string;
  studyId: string;
  studyItemId: string;
  viewerUserId: string;
  viewerSubjectId: string;
  datasetRevisionId: string;
}>): string {
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_ITEM_VIEW_REQUEST_DIGEST_BASIS,
    projectId: nonBlank(input.projectId, "projectId"),
    studyId: nonBlank(input.studyId, "studyId"),
    studyItemId: nonBlank(input.studyItemId, "studyItemId"),
    viewerUserId: nonBlank(input.viewerUserId, "viewerUserId"),
    viewerSubjectId: nonBlank(input.viewerSubjectId, "viewerSubjectId"),
    datasetRevisionId: nonBlank(input.datasetRevisionId, "datasetRevisionId")
  });
}

export function analysisFailureTaxonomyRequestDigest(projectId: string, input: AnalysisFailureTaxonomyCreateInput): string {
  const { idempotencyKey: _idempotencyKey, ...request } = input;
  return analysisStudyDigest({ basis: ANALYSIS_TAXONOMY_REQUEST_DIGEST_BASIS,
    projectId: nonBlank(projectId, "projectId"), ...request });
}

export function analysisFailureTaxonomyContentDigest(input: Pick<AnalysisFailureTaxonomyArtifact,
  "projectId" | "contractVersion" | "name" | "description">): string {
  return analysisStudyDigest({
    basis: ANALYSIS_TAXONOMY_CONTENT_DIGEST_BASIS,
    projectId: input.projectId,
    contractVersion: input.contractVersion,
    name: input.name,
    description: input.description
  });
}

export function analysisFailureCodeContentDigest(input: Pick<AnalysisFailureCodeArtifact,
  "projectId" | "taxonomyId" | "createdInRevisionId"> & { codeId: string }): string {
  return analysisStudyDigest({ basis: ANALYSIS_TAXONOMY_CODE_DIGEST_BASIS,
    projectId: input.projectId, taxonomyId: input.taxonomyId,
    codeId: input.codeId, createdInRevisionId: input.createdInRevisionId });
}

export function analysisTaxonomyRevisionCodeEntryDigest(input: Omit<AnalysisTaxonomyRevisionCodeArtifact,
  "id" | "projectId" | "entryDigest" | "createdAt">): string {
  return analysisStudyDigest({
    basis: ANALYSIS_TAXONOMY_REVISION_CODE_DIGEST_BASIS,
    taxonomyId: input.taxonomyId,
    taxonomyRevisionId: input.taxonomyRevisionId,
    codeId: input.codeId,
    position: input.position,
    label: input.label,
    definition: input.definition,
    status: input.status
  });
}

export function analysisTaxonomyContentDigest(orderedEntryDigests: readonly string[]): string {
  if (orderedEntryDigests.length === 0) throw new Error("Taxonomy revision must contain at least one code");
  return analysisStudyDigest({ basis: ANALYSIS_TAXONOMY_CONTENT_DIGEST_BASIS,
    entryDigests: orderedEntryDigests.map((value) => digest(value, "entryDigest")) });
}

export function analysisTaxonomyRevisionRequestDigest(
  taxonomyId: string,
  input: AnalysisTaxonomyRevisionCreateInput
): string {
  const { idempotencyKey: _idempotencyKey, ...request } = input;
  return analysisStudyDigest({ basis: ANALYSIS_TAXONOMY_REQUEST_DIGEST_BASIS,
    taxonomyId: nonBlank(taxonomyId, "taxonomyId"), ...request });
}

export function analysisTaxonomyRevisionDigest(input: Readonly<AnalysisTaxonomyRevisionDigestInput>): string {
  return analysisStudyDigest({
    basis: ANALYSIS_TAXONOMY_REVISION_DIGEST_BASIS,
    taxonomyId: input.taxonomyId,
    sequence: input.sequence,
    predecessorRevisionId: input.predecessorRevisionId,
    predecessorRevisionDigest: nullableDigest(input.predecessorRevisionDigest, "predecessorRevisionDigest"),
    reason: input.reason,
    contentDigest: digest(input.contentDigest, "contentDigest")
  });
}

export function analysisAssignmentRequestDigest(input: AnalysisObservationAssignmentEventInput): string {
  const { idempotencyKey: _idempotencyKey, ...request } = input;
  return analysisStudyDigest({ basis: ANALYSIS_ASSIGNMENT_REQUEST_DIGEST_BASIS, ...request });
}

type AnalysisAssignmentEventDigestInput = AnalysisObservationAssignmentEventArtifact extends infer Event
  ? Event extends unknown ? Omit<Event, "eventDigest"> : never
  : never;

export function analysisAssignmentEventDigest(event: AnalysisAssignmentEventDigestInput): string {
  return analysisStudyDigest({ basis: ANALYSIS_ASSIGNMENT_EVENT_DIGEST_BASIS,
    ...event, occurredAt: normalizeAnalysisPopulationTimestamp(event.occurredAt) });
}

export function analysisStudyViewSetDigest(orderedViewDigests: readonly string[]): string {
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_VIEW_SET_DIGEST_BASIS,
    viewEventDigests: orderedViewDigests.map((value) => digest(value, "viewEventDigest"))
  });
}

export function analysisStudyClosureItemContentDigest(input: Readonly<AnalysisStudyClosureItemDigestInput>): string {
  assertAlignedItemEvidence(input);
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_CLOSURE_ITEM_DIGEST_BASIS,
    studyId: input.studyId,
    studyItemId: input.studyItemId,
    drawItemId: input.drawItemId,
    caseId: input.caseId,
    position: safePosition(input.position),
    itemState: input.itemState,
    itemEventVersion: exactCount(input.itemEventVersion, "itemEventVersion"),
    currentEventId: input.currentEventId,
    currentEventDigest: nullableDigest(input.currentEventDigest, "currentEventDigest"),
    viewEventIds: [...input.viewEventIds],
    viewEventDigests: input.viewEventDigests.map((value) => digest(value, "viewEventDigest")),
    activeFailureObservationEventIds: [...input.activeFailureObservationEventIds],
    activeFailureObservationEventDigests: input.activeFailureObservationEventDigests.map((value) => digest(value, "observationDigest")),
    activeFailureAssignmentEventIds: [...input.activeFailureAssignmentEventIds],
    activeFailureAssignmentEventDigests: input.activeFailureAssignmentEventDigests.map((value) => nullableDigest(value, "assignmentDigest")),
    activeNoFailureEventId: input.activeNoFailureEventId,
    activeNoFailureEventDigest: nullableDigest(input.activeNoFailureEventDigest, "noFailureDigest"),
    completionEventId: input.completionEventId,
    completionEventDigest: nullableDigest(input.completionEventDigest, "completionDigest")
  });
}

export function analysisStudyClosureContentDigest(orderedItemDigests: readonly string[]): string {
  if (orderedItemDigests.length === 0) throw new Error("Analysis study closure must contain selected items");
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_CLOSURE_CONTENT_DIGEST_BASIS,
    closureItemContentDigests: orderedItemDigests.map((value) => digest(value, "closureItemDigest"))
  });
}

export function analysisStudyClosureDigest(
  closure: Omit<AnalysisStudyClosureArtifact, "id" | "projectId" | "closureDigest" | "createdAt">
): string {
  return analysisStudyDigest({
    basis: ANALYSIS_STUDY_CLOSURE_DIGEST_BASIS,
    ...closure,
    effectiveClosedAt: normalizeAnalysisPopulationTimestamp(closure.effectiveClosedAt),
    recordedAt: normalizeAnalysisPopulationTimestamp(closure.recordedAt)
  });
}

export function deriveAnalysisStudyRepresentativeAssessment(
  input: Readonly<AnalysisStudyRepresentativeAssessmentInput>
): AnalysisStudyRepresentativeAssessment {
  if (!Number.isSafeInteger(input.selectedItemCount) || input.selectedItemCount < 1) {
    throw new Error("selectedItemCount must be positive");
  }
  const positions = new Set<number>();
  const itemIds = new Set<string>();
  for (const item of input.closureItems) {
    if (positions.has(item.position) || item.position < 0 || item.position >= input.selectedItemCount) {
      throw new Error("Closure item positions must be unique and cover the selected draw");
    }
    if (itemIds.has(item.studyItemId)) throw new Error("Closure study items must be unique");
    positions.add(item.position);
    itemIds.add(item.studyItemId);
  }
  const frozenFrameDigest = digest(input.frozenFrameDigest, "frozenFrameDigest");
  const recomputedFrameDigest = nullableDigest(input.recomputedFrameDigest, "recomputedFrameDigest");
  const frameReproducible = recomputedFrameDigest !== null && frozenFrameDigest === recomputedFrameDigest;
  const frozenDrawDigest = digest(input.frozenDrawDigest, "frozenDrawDigest");
  const recomputedDrawDigest = nullableDigest(input.recomputedDrawDigest, "recomputedDrawDigest");
  if (input.closureItems.length !== input.selectedItemCount || positions.size !== input.selectedItemCount) {
    throw new Error("Closure must snapshot every selected item exactly once");
  }
  const drawComplete = recomputedDrawDigest !== null && frozenDrawDigest === recomputedDrawDigest;
  const codingComplete = drawComplete && input.closureItems.every((item) => item.itemState === "completed");
  const representativeReason: AnalysisRepresentativeReason | null = !input.methodEligible
    ? "method_not_eligible"
    : !frameReproducible
      ? "frame_not_reproducible"
      : !drawComplete
        ? "draw_not_complete"
        : !codingComplete
          ? "coding_not_complete"
          : null;
  const assessment = {
    assessmentVersion: ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
    methodEligible: input.methodEligible,
    frameReproducible,
    drawComplete,
    codingComplete,
    drawnFromPopulationId: nonBlank(input.populationId, "populationId"),
    representativeOfPopulationId: representativeReason === null ? input.populationId : null,
    representativeReason
  } as const;
  return Object.freeze({
    ...assessment,
    assessmentDigest: analysisStudyDigest({
      basis: ANALYSIS_REPRESENTATIVE_ASSESSMENT_DIGEST_BASIS,
      ...assessment,
      frozenFrameDigest,
      recomputedFrameDigest,
      frozenDrawDigest,
      recomputedDrawDigest,
      selectedItemCount: input.selectedItemCount,
      completedItemCount: input.closureItems.filter((item) => item.itemState === "completed").length
    })
  });
}

export function initialAnalysisStudyProjection(study: AnalysisStudyArtifact): AnalysisStudyProjection {
  return { study, state: "draft", currentVersion: "0", currentEventId: null, currentEventDigest: null,
    stoppingRule: null, closureId: null, closureDigest: null };
}

export function applyAnalysisStudyEvent(
  projection: Readonly<AnalysisStudyProjection>,
  event: Readonly<AnalysisStudyEventArtifact>
): AnalysisStudyProjection {
  assertEventSuccessor(projection.currentVersion, projection.currentEventId, projection.currentEventDigest, event);
  if (event.projectId !== projection.study.projectId || event.studyId !== projection.study.id || event.fromState !== projection.state) {
    throw new Error("Analysis study event owner/state mismatch");
  }
  let stoppingRule = projection.stoppingRule;
  let closureId = projection.closureId;
  let closureDigest = projection.closureDigest;
  if (event.eventType === "coding_opened") {
    stoppingRule = event.stoppingRule;
    assertHumanActor(event.actorUserId, event.actorSubjectId, event.actorRole);
  } else if (event.eventType === "coding_closed") {
    if (!stoppingRule || event.closeCause !== stoppingRule.kind) throw new Error("Closure cause must match the frozen stopping rule");
    if (event.closeCause === "server_deadline") {
      if (event.actorUserId !== null || event.actorSubjectId !== null || event.actorRole !== "system" || event.reason !== null) {
        throw new Error("Deadline closure must be a reasonless system event");
      }
      if (Date.parse(event.occurredAt) < Date.parse(stoppingRule.closeAt!)) throw new Error("Deadline closure occurred before closeAt");
    } else {
      assertHumanActor(event.actorUserId, event.actorSubjectId, event.actorRole);
      if (event.reason === null) throw new Error("Owner closure requires a reason");
    }
    closureId = event.closureId;
    closureDigest = event.closureDigest;
  } else {
    assertHumanActor(event.actorUserId, event.actorSubjectId, event.actorRole);
    if (event.eventType === "study_completed" && event.expectedClosureDigest !== projection.closureDigest) {
      throw new Error("Study completion closure digest mismatch");
    }
  }
  return {
    study: projection.study,
    state: event.toState,
    currentVersion: event.version,
    currentEventId: event.id,
    currentEventDigest: event.eventDigest,
    stoppingRule,
    closureId,
    closureDigest
  };
}

export function initialAnalysisStudyItemProjection(item: AnalysisStudyItemArtifact): AnalysisStudyItemProjection {
  return { item, state: "uncoded", currentVersion: "0", currentEventId: null, currentEventDigest: null,
    viewEventIds: [], viewEventDigests: [], activeFailureObservationEventIds: [],
    activeFailureObservationEventDigests: [], activeFailureAssignmentEventIds: [],
    activeFailureAssignmentEventDigests: [], activeNoFailureEventId: null,
    activeNoFailureEventDigest: null, completionEventId: null, completionEventDigest: null };
}

export function applyAnalysisStudyItemView(
  projection: Readonly<AnalysisStudyItemProjection>,
  view: Readonly<AnalysisStudyItemViewArtifact>,
  existingViews: readonly Readonly<AnalysisStudyItemViewArtifact>[]
): AnalysisStudyItemProjection {
  if (view.projectId !== projection.item.projectId || view.studyId !== projection.item.studyId || view.studyItemId !== projection.item.id) {
    throw new Error("Analysis study item view owner mismatch");
  }
  if (!view.countsTowardClosure) return { ...projection };
  const existing = projection.viewEventIds.indexOf(view.id);
  if (existing >= 0) {
    if (projection.viewEventDigests[existing] !== view.contentDigest) throw new Error("Analysis view identity digest conflict");
    return { ...projection };
  }
  if (existingViews.length !== projection.viewEventIds.length || existingViews.some((prior, index) =>
    prior.id !== projection.viewEventIds[index] || prior.contentDigest !== projection.viewEventDigests[index])) {
    throw new Error("Existing view artifacts must match the projected view set");
  }
  const pairs = [...existingViews, view].sort((left, right) =>
    compareCodeUnits(normalizeAnalysisPopulationTimestamp(left.viewedAt), normalizeAnalysisPopulationTimestamp(right.viewedAt)) ||
    compareCodeUnits(left.id, right.id)
  );
  return { ...projection, state: projection.state === "uncoded" ? "in_progress" : projection.state,
    viewEventIds: pairs.map((pair) => pair.id), viewEventDigests: pairs.map((pair) => pair.contentDigest) };
}

export function applyAnalysisStudyItemEvent(
  projection: Readonly<AnalysisStudyItemProjection>,
  event: Readonly<AnalysisStudyItemEventArtifact>,
  studyState: "coding_open" | Exclude<AnalysisStudyProjection["state"], "coding_open">
): AnalysisStudyItemProjection {
  if (studyState !== "coding_open") throw new Error("Coding events require an open study");
  assertEventSuccessor(projection.currentVersion, projection.currentEventId, projection.currentEventDigest, event);
  if (event.projectId !== projection.item.projectId || event.studyId !== projection.item.studyId || event.studyItemId !== projection.item.id) {
    throw new Error("Analysis study item event owner mismatch");
  }
  assertHumanActor(event.actorUserId, event.actorSubjectId, event.actorRole);
  const next: AnalysisStudyItemProjection = { ...projection, currentVersion: event.version,
    currentEventId: event.id, currentEventDigest: event.eventDigest,
    viewEventIds: [...projection.viewEventIds], viewEventDigests: [...projection.viewEventDigests],
    activeFailureObservationEventIds: [...projection.activeFailureObservationEventIds],
    activeFailureObservationEventDigests: [...projection.activeFailureObservationEventDigests],
    activeFailureAssignmentEventIds: [...projection.activeFailureAssignmentEventIds],
    activeFailureAssignmentEventDigests: [...projection.activeFailureAssignmentEventDigests] };
  if (event.eventType !== "coding_reopened" && projection.state === "completed") {
    throw new Error("Completed coding must be reopened before evidence changes");
  }
  switch (event.eventType) {
    case "failure_observed":
      if (next.activeNoFailureEventId !== null) throw new Error("Failure evidence conflicts with active no-failure evidence");
      next.activeFailureObservationEventIds.push(event.id);
      next.activeFailureObservationEventDigests.push(event.eventDigest);
      next.activeFailureAssignmentEventIds.push(null);
      next.activeFailureAssignmentEventDigests.push(null);
      next.state = "in_progress";
      break;
    case "failure_withdrawn": {
      const index = next.activeFailureObservationEventIds.indexOf(event.targetEventId);
      if (index < 0 || next.activeFailureObservationEventDigests[index] !== event.targetEventDigest) {
        throw new Error("Failure withdrawal must name the exact active observation head");
      }
      next.activeFailureObservationEventIds.splice(index, 1);
      next.activeFailureObservationEventDigests.splice(index, 1);
      next.activeFailureAssignmentEventIds.splice(index, 1);
      next.activeFailureAssignmentEventDigests.splice(index, 1);
      next.state = "in_progress";
      break;
    }
    case "no_failure_observed":
      if (next.activeFailureObservationEventIds.length > 0 || next.activeNoFailureEventId !== null) {
        throw new Error("No-failure evidence is mutually exclusive with active failure evidence");
      }
      next.activeNoFailureEventId = event.id;
      next.activeNoFailureEventDigest = event.eventDigest;
      next.state = "in_progress";
      break;
    case "no_failure_withdrawn":
      if (next.activeNoFailureEventId !== event.targetEventId || next.activeNoFailureEventDigest !== event.targetEventDigest) {
        throw new Error("No-failure withdrawal must name the exact active event");
      }
      next.activeNoFailureEventId = null;
      next.activeNoFailureEventDigest = null;
      next.state = "in_progress";
      break;
    case "coding_completed":
      if (next.activeFailureObservationEventIds.length === 0 && next.activeNoFailureEventId === null) {
        throw new Error("Coding completion requires active failure or no-failure evidence");
      }
      next.state = "completed";
      next.completionEventId = event.id;
      next.completionEventDigest = event.eventDigest;
      break;
    case "coding_reopened":
      if (projection.state !== "completed" || projection.completionEventId !== event.targetEventId ||
          projection.completionEventDigest !== event.targetEventDigest) {
        throw new Error("Coding reopen must name the exact active completion event");
      }
      next.state = "in_progress";
      next.completionEventId = null;
      next.completionEventDigest = null;
      break;
  }
  return next;
}

export function assertAnalysisTaxonomyRevision(
  taxonomy: AnalysisFailureTaxonomyArtifact,
  revision: AnalysisTaxonomyRevisionArtifact,
  codes: readonly AnalysisTaxonomyRevisionCodeArtifact[],
  previous?: AnalysisTaxonomyRevisionProjection
): void {
  if (taxonomy.contractVersion !== ANALYSIS_TAXONOMY_CONTRACT_VERSION || revision.taxonomyId !== taxonomy.id ||
      revision.projectId !== taxonomy.projectId || codes.length !== revision.codeCount || codes.length === 0) {
    throw new Error("Taxonomy revision owner/count mismatch");
  }
  const current = codeMap(revision, codes);
  if (!previous) {
    if (revision.sequence !== 1 || revision.predecessorRevisionId !== null || revision.predecessorRevisionDigest !== null) {
      throw new Error("Initial taxonomy revision must be sequence 1 without predecessor");
    }
    for (const code of codes) if (code.status !== "active") throw new Error("New taxonomy codes must begin active");
    return;
  }
  if (previous.revision.taxonomyId !== taxonomy.id || revision.sequence !== previous.revision.sequence + 1 ||
      revision.predecessorRevisionId !== previous.revision.id ||
      revision.predecessorRevisionDigest !== previous.revision.revisionDigest) {
    throw new Error("Taxonomy revisions must form one exact nonbranching successor chain");
  }
  const prior = codeMap(previous.revision, previous.codes);
  for (const [codeId, oldCode] of prior) {
    const nextCode = current.get(codeId);
    if (!nextCode) throw new Error("Taxonomy successor must retain every prior stable code ID");
    if (oldCode.status === "retired" && (nextCode.status !== "retired" || nextCode.label !== oldCode.label || nextCode.definition !== oldCode.definition)) {
      throw new Error("Retired taxonomy code status and text are immutable");
    }
    if (oldCode.status === "active" && nextCode.status === "retired" &&
        (nextCode.label !== oldCode.label || nextCode.definition !== oldCode.definition)) {
      throw new Error("Taxonomy retirement changes status only; label and definition are frozen from the predecessor");
    }
  }
  for (const [codeId, code] of current) {
    if (!prior.has(codeId) && code.status !== "active") throw new Error("New taxonomy codes must begin active");
  }
}

export function assertAnalysisAssignmentSuccessor(input: Readonly<{
  previous: AnalysisObservationAssignmentEventArtifact | null;
  next: AnalysisObservationAssignmentEventArtifact;
  currentRevision: AnalysisTaxonomyRevisionProjection;
}>): void {
  const { previous, next, currentRevision } = input;
  if (next.taxonomyRevisionId !== currentRevision.revision.id ||
      next.taxonomyRevisionSequence !== currentRevision.revision.sequence ||
      next.projectId !== currentRevision.revision.projectId ||
      next.taxonomyId !== currentRevision.revision.taxonomyId) {
    throw new Error("Assignments may change only against the current taxonomy head revision");
  }
  if (previous === null) {
    if (next.version !== "1" || next.predecessorEventId !== null || next.predecessorEventDigest !== null) {
      throw new Error("Initial assignment event must start at version 1 without predecessor");
    }
  } else {
    if (next.projectId !== previous.projectId || next.taxonomyId !== previous.taxonomyId ||
        next.studyId !== previous.studyId || next.studyItemId !== previous.studyItemId ||
        next.observationEventId !== previous.observationEventId || BigInt(next.version) !== BigInt(previous.version) + 1n ||
        next.predecessorEventId !== previous.id || next.predecessorEventDigest !== previous.eventDigest ||
        next.taxonomyRevisionSequence < previous.taxonomyRevisionSequence) {
      throw new Error("Assignment successor must CAS the exact nonbranching head without moving backward");
    }
  }
  if (next.eventType === "assigned") {
    const code = currentRevision.codes.find((candidate) => candidate.codeId === next.codeId);
    if (!code || code.status !== "active") throw new Error("New assignments require an active code in the exact revision");
  }
}

export function applyAnalysisAssignmentEventToItem(
  projection: Readonly<AnalysisStudyItemProjection>,
  event: Readonly<AnalysisObservationAssignmentEventArtifact>,
  studyState: AnalysisStudyProjection["state"]
): AnalysisStudyItemProjection {
  if (studyState !== "coding_open") throw new Error("Assignments require an open study");
  if (event.projectId !== projection.item.projectId || event.studyId !== projection.item.studyId ||
      event.studyItemId !== projection.item.id) throw new Error("Assignment item owner mismatch");
  const index = projection.activeFailureObservationEventIds.indexOf(event.observationEventId);
  if (index < 0) throw new Error("Assignment must target an active failure observation");
  const next = {
    ...projection,
    viewEventIds: [...projection.viewEventIds],
    viewEventDigests: [...projection.viewEventDigests],
    activeFailureObservationEventIds: [...projection.activeFailureObservationEventIds],
    activeFailureObservationEventDigests: [...projection.activeFailureObservationEventDigests],
    activeFailureAssignmentEventIds: [...projection.activeFailureAssignmentEventIds],
    activeFailureAssignmentEventDigests: [...projection.activeFailureAssignmentEventDigests]
  };
  next.activeFailureAssignmentEventIds[index] = event.id;
  next.activeFailureAssignmentEventDigests[index] = event.eventDigest;
  return next;
}

export function computeAnalysisTaxonomyCoverage(input: Readonly<AnalysisStudyCoverageInput>): AnalysisTaxonomyCoverage {
  const target = input.targetRevision;
  if (target.revision.projectId !== input.taxonomy.projectId || target.revision.taxonomyId !== input.taxonomy.id) {
    throw new Error("Coverage taxonomy revision owner mismatch");
  }
  codeMap(target.revision, target.codes);
  const revisionIds = new Map<number, string>();
  for (const revision of input.revisionAncestry) {
    if (revision.sequence < 1 || revision.sequence > target.revision.sequence || revisionIds.has(revision.sequence)) {
      throw new Error("Coverage revision ancestry must contain unique bounded sequences");
    }
    revisionIds.set(revision.sequence, revision.id);
  }
  for (let sequence = 1; sequence <= target.revision.sequence; sequence += 1) {
    if (!revisionIds.has(sequence)) throw new Error("Coverage revision ancestry must be contiguous through target");
  }
  if (revisionIds.get(target.revision.sequence) !== target.revision.id) throw new Error("Coverage target ancestry mismatch");
  const codeStatuses = new Map(target.codes.map((code) => [code.codeId, code.status]));
  const observations = new Map<string, { itemId: string }>();
  const itemIds = new Set<string>();
  let completedItemCount = 0;
  let noFailureObservedItemCount = 0;
  for (const item of input.items) {
    if (item.item.studyId !== input.studyId) throw new Error("Coverage item study mismatch");
    if (itemIds.has(item.item.id)) throw new Error("Coverage study items must be unique");
    itemIds.add(item.item.id);
    if (item.state === "completed") completedItemCount += 1;
    if (item.activeNoFailureEventId !== null) noFailureObservedItemCount += 1;
    for (const observationId of item.activeFailureObservationEventIds) {
      if (observations.has(observationId)) throw new Error("Active failure observation appears on multiple items");
      observations.set(observationId, { itemId: item.item.id });
    }
  }
  const heads = new Map<string, AnalysisObservationAssignmentEventArtifact>();
  for (const event of input.assignmentEvents) {
    if (!observations.has(event.observationEventId)) continue;
    const observation = observations.get(event.observationEventId)!;
    if (event.projectId !== input.taxonomy.projectId || event.taxonomyId !== input.taxonomy.id ||
        event.studyId !== input.studyId || event.studyItemId !== observation.itemId) {
      throw new Error("Coverage assignment owner/revision lineage mismatch");
    }
    if (event.taxonomyRevisionSequence > target.revision.sequence) continue;
    if (revisionIds.get(event.taxonomyRevisionSequence) !== event.taxonomyRevisionId) {
      throw new Error("Coverage assignment revision lineage mismatch");
    }
    const prior = heads.get(event.observationEventId);
    if (!prior || BigInt(event.version) > BigInt(prior.version)) heads.set(event.observationEventId, event);
  }
  let categorized = 0n, retired = 0n, uncategorized = 0n;
  const categorizedItems = new Set<string>(), retiredItems = new Set<string>(), uncategorizedItems = new Set<string>();
  for (const [observationId, observation] of observations) {
    const head = heads.get(observationId);
    if (!head || head.eventType === "withdrawn") {
      uncategorized += 1n; uncategorizedItems.add(observation.itemId); continue;
    }
    const status = codeStatuses.get(head.codeId);
    if (status === "active") { categorized += 1n; categorizedItems.add(observation.itemId); }
    else if (status === "retired") { retired += 1n; retiredItems.add(observation.itemId); }
    else throw new Error("Assignment code is absent from the target taxonomy revision");
  }
  return {
    projectId: input.taxonomy.projectId,
    studyId: input.studyId,
    taxonomyId: input.taxonomy.id,
    taxonomyRevisionId: target.revision.id,
    taxonomyRevisionSequence: target.revision.sequence,
    calculationVersion: ANALYSIS_TAXONOMY_COVERAGE_VERSION,
    selectedItemCount: input.items.length,
    completedItemCount,
    noFailureObservedItemCount,
    activeFailureObservationCount: String(observations.size),
    categorized: String(categorized),
    assignedToRetiredCode: String(retired),
    uncategorized: String(uncategorized),
    categorizedItemCount: categorizedItems.size,
    assignedToRetiredCodeItemCount: retiredItems.size,
    uncategorizedItemCount: uncategorizedItems.size
  };
}

function codeMap(revision: AnalysisTaxonomyRevisionArtifact, codes: readonly AnalysisTaxonomyRevisionCodeArtifact[]) {
  const result = new Map<string, AnalysisTaxonomyRevisionCodeArtifact>();
  const labels = new Set<string>();
  codes.forEach((code, position) => {
    if (code.projectId !== revision.projectId || code.taxonomyId !== revision.taxonomyId ||
        code.taxonomyRevisionId !== revision.id || code.position !== position || result.has(code.codeId)) {
      throw new Error("Taxonomy revision codes must be exactly owned, unique, and contiguously ordered");
    }
    if (code.status === "active" && labels.has(code.label)) throw new Error("Active taxonomy labels must be exact-string unique");
    if (code.status === "active") labels.add(code.label);
    result.set(code.codeId, code);
  });
  return result;
}

function assertEventSuccessor(
  currentVersion: string,
  currentEventId: string | null,
  currentEventDigest: string | null,
  next: { version: string; predecessorEventId: string | null; predecessorEventDigest: string | null }
): void {
  if (BigInt(next.version) !== BigInt(exactCount(currentVersion, "currentVersion")) + 1n ||
      next.predecessorEventId !== currentEventId || next.predecessorEventDigest !== currentEventDigest) {
    throw new Error("Event must CAS the exact current nonbranching head");
  }
}

function assertAlignedItemEvidence(input: AnalysisStudyClosureItemDigestInput): void {
  const failureCount = input.activeFailureObservationEventIds.length;
  if (input.activeFailureObservationEventDigests.length !== failureCount ||
      input.activeFailureAssignmentEventIds.length !== failureCount ||
      input.activeFailureAssignmentEventDigests.length !== failureCount ||
      input.viewEventIds.length !== input.viewEventDigests.length) {
    throw new Error("Analysis item evidence ID/digest arrays must be aligned");
  }
  if (new Set(input.activeFailureObservationEventIds).size !== failureCount || new Set(input.viewEventIds).size !== input.viewEventIds.length) {
    throw new Error("Analysis item evidence IDs must be unique");
  }
  for (let index = 0; index < failureCount; index += 1) {
    if ((input.activeFailureAssignmentEventIds[index] === null) !== (input.activeFailureAssignmentEventDigests[index] === null)) {
      throw new Error("Assignment event ID/digest must be present together");
    }
  }
  if ((input.currentEventId === null) !== (input.currentEventDigest === null) ||
      (input.activeNoFailureEventId === null) !== (input.activeNoFailureEventDigest === null) ||
      (input.completionEventId === null) !== (input.completionEventDigest === null)) {
    throw new Error("Analysis item evidence ID/digest pairs must be present together");
  }
  if (failureCount > 0 && input.activeNoFailureEventId !== null) throw new Error("Failure and no-failure evidence are mutually exclusive");
  if (input.itemState === "completed" && input.completionEventId === null) throw new Error("Completed item requires completion evidence");
  if (input.itemState !== "completed" && input.completionEventId !== null) throw new Error("Only a completed item may retain completion evidence");
}

function assertHumanActor(userId: string | null, subjectId: string | null, role: string): void {
  if (userId === null || subjectId === null || role === "system") throw new Error("Human event requires durable user, subject, and role");
}

function nonBlank(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) throw new Error(`${name} must be nonblank`);
  canonicalGovernedJsonV1(value);
  return value;
}

function digest(value: string, name: string): string {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function nullableDigest(value: string | null, name: string): string | null {
  return value === null ? null : digest(value, name);
}

function exactCount(value: string, name: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a canonical decimal`);
  return value;
}

function safePosition(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("position must be a nonnegative safe integer");
  return value;
}
