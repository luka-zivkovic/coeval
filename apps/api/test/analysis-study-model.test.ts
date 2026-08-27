import { describe, expect, it } from "vitest";
import {
  ANALYSIS_MAX_EVENT_VERSION,
  ANALYSIS_MAX_EXPECTED_EVENT_VERSION,
  ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
  ANALYSIS_STUDY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_CONTRACT_VERSION,
  AnalysisFailureTaxonomyCreateInputSchema,
  AnalysisObservationAssignmentEventInputSchema,
  AnalysisStudyClosureArtifactSchema,
  AnalysisStudyCreateInputSchema,
  AnalysisStudyItemEventArtifactSchema,
  AnalysisStudyItemEventInputSchema,
  AnalysisStudyOpenInputSchema,
  AnalysisStudySummariesPageSchema,
  AnalysisTaxonomyCoverageSchema,
  AnalysisTaxonomyRevisionCreateInputSchema,
  AnalysisTaxonomyRevisionProjectionSchema,
  type AnalysisFailureCodeArtifact,
  type AnalysisFailureTaxonomyArtifact,
  type AnalysisObservationAssignmentEventArtifact,
  type AnalysisStudyArtifact,
  type AnalysisStudyEventArtifact,
  type AnalysisStudyItemArtifact,
  type AnalysisStudyItemEventArtifact,
  type AnalysisStudyItemProjection,
  type AnalysisStudyItemViewArtifact,
  type AnalysisTaxonomyRevisionArtifact,
  type AnalysisTaxonomyRevisionCodeArtifact,
  type AnalysisTaxonomyRevisionProjection
} from "@coeval/shared";
import {
  ANALYSIS_ASSIGNMENT_EVENT_DIGEST_BASIS,
  ANALYSIS_ASSIGNMENT_REQUEST_DIGEST_BASIS,
  ANALYSIS_REPRESENTATIVE_ASSESSMENT_DIGEST_BASIS,
  ANALYSIS_STUDY_CLOSURE_CONTENT_DIGEST_BASIS,
  ANALYSIS_STUDY_CLOSURE_DIGEST_BASIS,
  ANALYSIS_STUDY_CLOSURE_ITEM_DIGEST_BASIS,
  ANALYSIS_STUDY_CONTENT_DIGEST_BASIS,
  ANALYSIS_STUDY_EVENT_DIGEST_BASIS,
  ANALYSIS_STUDY_EVENT_REQUEST_DIGEST_BASIS,
  ANALYSIS_STUDY_ITEM_DIGEST_BASIS,
  ANALYSIS_STUDY_ITEM_EVENT_DIGEST_BASIS,
  ANALYSIS_STUDY_ITEM_EVENT_REQUEST_DIGEST_BASIS,
  ANALYSIS_STUDY_ITEM_VIEW_DIGEST_BASIS,
  ANALYSIS_STUDY_ITEM_VIEW_REQUEST_DIGEST_BASIS,
  ANALYSIS_STUDY_REQUEST_DIGEST_BASIS,
  ANALYSIS_STUDY_VIEW_SET_DIGEST_BASIS,
  ANALYSIS_TAXONOMY_CODE_DIGEST_BASIS,
  ANALYSIS_TAXONOMY_CONTENT_DIGEST_BASIS,
  ANALYSIS_TAXONOMY_REQUEST_DIGEST_BASIS,
  ANALYSIS_TAXONOMY_REVISION_CODE_DIGEST_BASIS,
  ANALYSIS_TAXONOMY_REVISION_DIGEST_BASIS,
  analysisAssignmentEventDigest,
  analysisAssignmentRequestDigest,
  analysisFailureCodeContentDigest,
  analysisFailureTaxonomyContentDigest,
  analysisFailureTaxonomyRequestDigest,
  analysisStudyClosureContentDigest,
  analysisStudyClosureItemContentDigest,
  analysisStudyContentDigest,
  analysisStudyEventDigest,
  analysisStudyEventRequestDigest,
  analysisStudyItemContentDigest,
  analysisStudyItemEventDigest,
  analysisStudyItemEventRequestDigest,
  analysisStudyItemViewContentDigest,
  analysisStudyItemViewRequestDigest,
  analysisStudyRequestDigest,
  analysisStudyViewSetDigest,
  analysisTaxonomyContentDigest,
  analysisTaxonomyRevisionCodeEntryDigest,
  analysisTaxonomyRevisionDigest,
  analysisTaxonomyRevisionRequestDigest,
  applyAnalysisAssignmentEventToItem,
  applyAnalysisStudyEvent,
  applyAnalysisStudyItemEvent,
  applyAnalysisStudyItemView,
  assertAnalysisAssignmentSuccessor,
  assertAnalysisTaxonomyRevision,
  computeAnalysisTaxonomyCoverage,
  deriveAnalysisStudyRepresentativeAssessment,
  initialAnalysisStudyItemProjection,
  initialAnalysisStudyProjection
} from "../src/lib/analysis-study.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
const AT = "2026-08-20T12:00:00.000Z";

function studyArtifact(): AnalysisStudyArtifact {
  const partial = {
    id: "study_1", projectId: "project_1", populationId: "population_1", drawId: "draw_1",
    datasetRevisionId: "revision_1", contractVersion: ANALYSIS_STUDY_CONTRACT_VERSION,
    idempotencyKey: "create-1", requestDigest: D1,
    createdByUserId: "user_owner", createdBySubjectId: "subject_owner", createdAt: AT
  } as const;
  return { ...partial, contentDigest: analysisStudyContentDigest(partial) };
}

function itemArtifact(id = "item_1", position = 0): AnalysisStudyItemArtifact {
  const partial = {
    studyId: "study_1", drawItemId: `draw_item_${position}`, memberId: `member_${position}`,
    revisionItemId: `revision_item_${position}`, caseId: `case_${position}`, position
  };
  return {
    id, projectId: "project_1", ...partial,
    contentDigest: analysisStudyItemContentDigest(partial), createdAt: AT
  };
}

function itemEvent(
  projection: AnalysisStudyItemProjection,
  id: string,
  payload: Record<string, unknown>,
  occurredAt = AT
): AnalysisStudyItemEventArtifact {
  const withoutDigest = {
    id, projectId: projection.item.projectId, studyId: projection.item.studyId, studyItemId: projection.item.id,
    version: String(BigInt(projection.currentVersion) + 1n),
    predecessorEventId: projection.currentEventId, predecessorEventDigest: projection.currentEventDigest,
    actorUserId: "user_member", actorSubjectId: "subject_member", actorRole: "member" as const,
    idempotencyKey: `key-${id}`, requestDigest: D1, occurredAt, ...payload
  } as any;
  return AnalysisStudyItemEventArtifactSchema.parse({
    ...withoutDigest,
    eventDigest: analysisStudyItemEventDigest(withoutDigest)
  });
}

function studyEvent(
  projection: ReturnType<typeof initialAnalysisStudyProjection>,
  id: string,
  payload: Record<string, unknown>,
  occurredAt = AT
): AnalysisStudyEventArtifact {
  const withoutDigest = {
    id, projectId: projection.study.projectId, studyId: projection.study.id,
    version: String(BigInt(projection.currentVersion) + 1n),
    predecessorEventId: projection.currentEventId, predecessorEventDigest: projection.currentEventDigest,
    actorUserId: "user_owner", actorSubjectId: "subject_owner", actorRole: "owner" as const,
    idempotencyKey: `key-${id}`, requestDigest: D1, occurredAt, ...payload
  } as any;
  return { ...withoutDigest, eventDigest: analysisStudyEventDigest(withoutDigest) } as AnalysisStudyEventArtifact;
}

function taxonomyArtifact(): AnalysisFailureTaxonomyArtifact {
  return {
    id: "taxonomy_1", projectId: "project_1", contractVersion: ANALYSIS_TAXONOMY_CONTRACT_VERSION,
    name: "Failure taxonomy", description: "Flat human-authored failures.", idempotencyKey: "taxonomy-1",
    requestDigest: D1, contentDigest: D2, createdByUserId: "user_owner",
    createdBySubjectId: "subject_owner", createdAt: AT
  };
}

function stableCode(id: string, revisionId: string): AnalysisFailureCodeArtifact {
  const partial = { projectId: "project_1", taxonomyId: "taxonomy_1", createdInRevisionId: revisionId, codeId: id };
  return {
    id, projectId: partial.projectId, taxonomyId: partial.taxonomyId, createdInRevisionId: revisionId,
    contentDigest: analysisFailureCodeContentDigest(partial), createdByUserId: "user_owner",
    createdBySubjectId: "subject_owner", createdAt: AT
  };
}

function revisionCode(
  revisionId: string,
  codeId: string,
  position: number,
  label: string,
  status: "active" | "retired" = "active",
  definition = `${label} definition`
): AnalysisTaxonomyRevisionCodeArtifact {
  const partial = { taxonomyId: "taxonomy_1", taxonomyRevisionId: revisionId, codeId, position, label, definition, status };
  return {
    id: `${revisionId}_${codeId}`, projectId: "project_1", ...partial,
    entryDigest: analysisTaxonomyRevisionCodeEntryDigest(partial), createdAt: AT
  };
}

function revision(
  id: string,
  sequence: number,
  codes: AnalysisTaxonomyRevisionCodeArtifact[],
  previous?: AnalysisTaxonomyRevisionProjection
): AnalysisTaxonomyRevisionProjection {
  const contentDigest = analysisTaxonomyContentDigest(codes.map((code) => code.entryDigest));
  const partial = {
    taxonomyId: "taxonomy_1", sequence,
    predecessorRevisionId: previous?.revision.id ?? null,
    predecessorRevisionDigest: previous?.revision.revisionDigest ?? null,
    reason: sequence === 1 ? "Initial codes" : "Revise codes", contentDigest
  };
  const artifact: AnalysisTaxonomyRevisionArtifact = {
    id, projectId: "project_1", ...partial, codeCount: codes.length,
    revisionDigest: analysisTaxonomyRevisionDigest(partial), createdByUserId: "user_owner",
    createdBySubjectId: "subject_owner", idempotencyKey: `revision-${sequence}`,
    requestDigest: D1, createdAt: AT
  };
  return AnalysisTaxonomyRevisionProjectionSchema.parse({ revision: artifact, codes });
}

function assignment(
  item: AnalysisStudyItemProjection,
  revisionValue: AnalysisTaxonomyRevisionProjection,
  id: string,
  observationEventId: string,
  codeId: string | null,
  previous: AnalysisObservationAssignmentEventArtifact | null = null
): AnalysisObservationAssignmentEventArtifact {
  const withoutDigest = {
    id, projectId: "project_1", taxonomyId: "taxonomy_1",
    taxonomyRevisionId: revisionValue.revision.id, taxonomyRevisionSequence: revisionValue.revision.sequence,
    studyId: "study_1", studyItemId: item.item.id, observationEventId,
    version: String(previous ? BigInt(previous.version) + 1n : 1n),
    predecessorEventId: previous?.id ?? null, predecessorEventDigest: previous?.eventDigest ?? null,
    eventType: codeId === null ? "withdrawn" as const : "assigned" as const, codeId,
    rationale: codeId === null ? "Withdraw assignment" : "Assign exact code",
    actorUserId: "user_member", actorSubjectId: "subject_member", actorRole: "member" as const,
    idempotencyKey: `assignment-${id}`, requestDigest: D1, occurredAt: AT
  } as any;
  return { ...withoutDigest, eventDigest: analysisAssignmentEventDigest(withoutDigest) };
}

describe("6B-2 strict shared contracts", () => {
  it("keeps draft creation separate from opening and rejects caller-owned extras", () => {
    expect(AnalysisStudyCreateInputSchema.parse({ populationId: "population_1", idempotencyKey: "create-1" }))
      .toEqual({ populationId: "population_1", idempotencyKey: "create-1" });
    expect(AnalysisStudyCreateInputSchema.safeParse({
      populationId: "population_1", idempotencyKey: "create-1", stoppingRule: { kind: "explicit_owner_close", closeAt: null }
    }).success).toBe(false);
    expect(AnalysisStudyOpenInputSchema.parse({
      expectedVersion: "0", idempotencyKey: "open-1",
      stoppingRule: { kind: "server_deadline", closeAt: "2026-08-21T14:00:00.0009+02:00" }
    }).stoppingRule).toEqual({ kind: "server_deadline", closeAt: "2026-08-21T12:00:00.000Z" });
    expect(AnalysisStudyOpenInputSchema.safeParse({
      expectedVersion: "0",
      idempotencyKey: `analysis-deadline-close_${"a".repeat(32)}`,
      stoppingRule: { kind: "explicit_owner_close", closeAt: null }
    }).success).toBe(false);
  });

  it("bounds command event versions to PostgreSQL bigint before persistence", () => {
    const input = {
      expectedVersion: ANALYSIS_MAX_EXPECTED_EVENT_VERSION,
      idempotencyKey: "open-bigint-boundary",
      stoppingRule: { kind: "explicit_owner_close" as const, closeAt: null }
    };
    expect(AnalysisStudyOpenInputSchema.safeParse(input).success).toBe(true);
    expect(AnalysisStudyOpenInputSchema.safeParse({
      ...input, expectedVersion: ANALYSIS_MAX_EVENT_VERSION
    }).success).toBe(false);
    expect(AnalysisObservationAssignmentEventInputSchema.safeParse({
      eventType: "assigned", observationEventId: "event_1", taxonomyRevisionId: "revision_1",
      codeId: "code_1", expectedVersion: ANALYSIS_MAX_EVENT_VERSION,
      expectedPredecessorEventId: "assignment_previous", expectedPredecessorEventDigest: D1,
      rationale: "Assignment at the numeric boundary.", idempotencyKey: "assignment-bigint-boundary"
    }).success).toBe(false);
    const artifact = itemEvent(initialAnalysisStudyItemProjection(itemArtifact()), "event_bigint_max", {
      eventType: "failure_observed", failureLabel: "Boundary", rationale: "Exact boundary artifact.",
      evidenceAnchor: { kind: "case_output" }
    });
    expect(AnalysisStudyItemEventArtifactSchema.safeParse({
      ...artifact, version: ANALYSIS_MAX_EVENT_VERSION,
      predecessorEventId: "event_previous", predecessorEventDigest: D1
    }).success).toBe(true);
  });

  it("bounds available and unavailable study-list rows as one raw page", () => {
    const summary = {
      study: initialAnalysisStudyProjection(studyArtifact()),
      selectedItemCount: 1,
      viewedItemCount: 0,
      completedItemCount: 0,
      closure: null
    };
    expect(AnalysisStudySummariesPageSchema.safeParse({
      items: Array.from({ length: 200 }, () => summary),
      totalCount: "201",
      unavailableDueClosureCount: 1,
      nextCursor: "next-page"
    }).success).toBe(false);
  });

  it("requires exact failure anchors and whole-item no-failure rationale", () => {
    expect(AnalysisStudyItemEventInputSchema.safeParse({
      eventType: "failure_observed", expectedVersion: "0", idempotencyKey: "observe-1",
      failureLabel: "Wrong refund period", rationale: "Output contradicts policy.",
      evidenceAnchor: { kind: "step", stepIndex: 2 }
    }).success).toBe(true);
    expect(AnalysisStudyItemEventInputSchema.safeParse({
      eventType: "no_failure_observed", expectedVersion: "0", idempotencyKey: "none-1",
      rationale: "Reviewed the whole item.", evidenceAnchor: { kind: "case_output" }
    }).success).toBe(false);
  });

  it("rejects unsafe taxonomy identities/labels and malformed assignment CAS", () => {
    const duplicate = {
      name: "Failures", description: "Human authored.", reason: "Initial",
      codes: [
        { kind: "new", clientToken: "a", label: "Incorrect", definition: "First" },
        { kind: "new", clientToken: "a", label: "Incorrect", definition: "Second" }
      ], idempotencyKey: "taxonomy-1"
    };
    expect(AnalysisFailureTaxonomyCreateInputSchema.safeParse(duplicate).success).toBe(false);
    expect(AnalysisTaxonomyRevisionCreateInputSchema.safeParse({
      expectedPredecessorRevisionId: "tr_1", expectedPredecessorRevisionDigest: D1,
      expectedPredecessorSequence: 1, reason: "Change", idempotencyKey: "rev-2",
      codes: [
        { kind: "existing", codeId: "code_1", label: "A", definition: "A", status: "active" },
        { kind: "existing", codeId: "code_1", label: "B", definition: "B", status: "active" }
      ]
    }).success).toBe(false);
    expect(AnalysisObservationAssignmentEventInputSchema.safeParse({
      eventType: "assigned", observationEventId: "event_1", taxonomyRevisionId: "tr_1", codeId: "code_1",
      expectedVersion: "0", expectedPredecessorEventId: "assignment_0", expectedPredecessorEventDigest: D1,
      rationale: "Assign", idempotencyKey: "assign-1"
    }).success).toBe(false);
  });

  it("parses every closed item-event artifact variant", () => {
    let state = initialAnalysisStudyItemProjection(itemArtifact());
    const events = [
      itemEvent(state, "failure_1", { eventType: "failure_observed", failureLabel: "Wrong", rationale: "Evidence", evidenceAnchor: { kind: "case_output" } }),
      itemEvent({ ...state, currentVersion: "1", currentEventId: "failure_1", currentEventDigest: D1 }, "withdraw_1",
        { eventType: "failure_withdrawn", targetEventId: "failure_1", targetEventDigest: D1, rationale: "Correction" }),
      itemEvent(state, "none_1", { eventType: "no_failure_observed", rationale: "No failure" }),
      itemEvent({ ...state, currentVersion: "1", currentEventId: "none_1", currentEventDigest: D1 }, "withdraw_none",
        { eventType: "no_failure_withdrawn", targetEventId: "none_1", targetEventDigest: D1, rationale: "Recheck" }),
      itemEvent(state, "complete_1", { eventType: "coding_completed" }),
      itemEvent({ ...state, currentVersion: "1", currentEventId: "complete_1", currentEventDigest: D1 }, "reopen_1",
        { eventType: "coding_reopened", targetEventId: "complete_1", targetEventDigest: D1, rationale: "Revisit" })
    ];
    expect(events.map((event) => event.eventType)).toEqual([
      "failure_observed", "failure_withdrawn", "no_failure_observed", "no_failure_withdrawn", "coding_completed", "coding_reopened"
    ]);
  });
});

describe("append-only study and item state", () => {
  it("enforces the study state graph, frozen stopping rule, closure digest, and terminal states", () => {
    let state = initialAnalysisStudyProjection(studyArtifact());
    const open = studyEvent(state, "study_event_1", {
      eventType: "coding_opened", fromState: "draft", toState: "coding_open",
      stoppingRule: { kind: "explicit_owner_close", closeAt: null }, closeCause: null,
      closureId: null, closureDigest: null, expectedClosureDigest: null, reason: null
    });
    state = applyAnalysisStudyEvent(state, open);
    const close = studyEvent(state, "study_event_2", {
      eventType: "coding_closed", fromState: "coding_open", toState: "coding_closed",
      stoppingRule: null, closeCause: "explicit_owner_close", closureId: "closure_1",
      closureDigest: D2, expectedClosureDigest: null, reason: "Owner completed coding window"
    });
    state = applyAnalysisStudyEvent(state, close);
    expect(() => applyAnalysisStudyEvent(state, studyEvent(state, "bad_complete", {
      eventType: "study_completed", fromState: "coding_closed", toState: "completed",
      stoppingRule: null, closeCause: null, closureId: null, closureDigest: null,
      expectedClosureDigest: D3, reason: null
    }))).toThrow(/closure digest mismatch/);
    state = applyAnalysisStudyEvent(state, studyEvent(state, "study_event_3", {
      eventType: "study_completed", fromState: "coding_closed", toState: "completed",
      stoppingRule: null, closeCause: null, closureId: null, closureDigest: null,
      expectedClosureDigest: D2, reason: null
    }));
    expect(state.state).toBe("completed");
  });

  it("uses DB-deadline semantics with effective closeAt and system actor", () => {
    let state = initialAnalysisStudyProjection(studyArtifact());
    state = applyAnalysisStudyEvent(state, studyEvent(state, "open_deadline", {
      eventType: "coding_opened", fromState: "draft", toState: "coding_open",
      stoppingRule: { kind: "server_deadline", closeAt: "2026-08-20T13:00:00.000Z" }, closeCause: null,
      closureId: null, closureDigest: null, expectedClosureDigest: null, reason: null
    }));
    const base = studyEvent(state, "deadline_close", {
      eventType: "coding_closed", fromState: "coding_open", toState: "coding_closed", stoppingRule: null,
      closeCause: "server_deadline", closureId: "closure_1", closureDigest: D2,
      expectedClosureDigest: null, reason: null
    }, "2026-08-20T13:00:01.000Z");
    const system = { ...base, actorUserId: null, actorSubjectId: null, actorRole: "system" as const };
    expect(applyAnalysisStudyEvent(state, system).state).toBe("coding_closed");
    expect(() => applyAnalysisStudyEvent(state, { ...system, occurredAt: "2026-08-20T12:59:59.999Z" }))
      .toThrow(/before closeAt/);
  });

  it("requires reopen before coding changes and retains evidence across reopen", () => {
    let item = initialAnalysisStudyItemProjection(itemArtifact());
    const observed = itemEvent(item, "observation_z", {
      eventType: "failure_observed", failureLabel: "Wrong", rationale: "Output is wrong", evidenceAnchor: { kind: "case_output" }
    });
    item = applyAnalysisStudyItemEvent(item, observed, "coding_open");
    const completed = itemEvent(item, "completion_1", { eventType: "coding_completed" });
    item = applyAnalysisStudyItemEvent(item, completed, "coding_open");
    expect(() => applyAnalysisStudyItemEvent(item, itemEvent(item, "withdraw_illegal", {
      eventType: "failure_withdrawn", targetEventId: observed.id, targetEventDigest: observed.eventDigest, rationale: "Change"
    }), "coding_open")).toThrow(/reopened/);
    item = applyAnalysisStudyItemEvent(item, itemEvent(item, "reopen_1", {
      eventType: "coding_reopened", targetEventId: completed.id, targetEventDigest: completed.eventDigest, rationale: "Recheck"
    }), "coding_open");
    expect(item.activeFailureObservationEventIds).toEqual([observed.id]);
    item = applyAnalysisStudyItemEvent(item, itemEvent(item, "withdraw_1", {
      eventType: "failure_withdrawn", targetEventId: observed.id, targetEventDigest: observed.eventDigest, rationale: "Not a failure"
    }), "coding_open");
    const noFailure = itemEvent(item, "no_failure_1", { eventType: "no_failure_observed", rationale: "No failure remains" });
    item = applyAnalysisStudyItemEvent(item, noFailure, "coding_open");
    expect(item.activeNoFailureEventId).toBe(noFailure.id);
  });

  it("orders pre-close view evidence by viewedAt then ID, not random ID", () => {
    let item = initialAnalysisStudyItemProjection(itemArtifact());
    const later: AnalysisStudyItemViewArtifact = {
      id: "view_a", projectId: "project_1", studyId: "study_1", studyItemId: "item_1",
      viewerUserId: "user_2", viewerSubjectId: "subject_2", datasetExposureEventId: "exposure_2", countsTowardClosure: true,
      idempotencyKey: "view-2", requestDigest: D1, contentDigest: D2, viewedAt: "2026-08-20T12:00:01.000Z"
    };
    const earlier = { ...later, id: "view_z", viewerUserId: "user_1", viewerSubjectId: "subject_1",
      datasetExposureEventId: "exposure_1", countsTowardClosure: true, idempotencyKey: "view-1", contentDigest: D3, viewedAt: AT };
    item = applyAnalysisStudyItemView(item, later, []);
    item = applyAnalysisStudyItemView(item, earlier, [later]);
    expect(item.viewEventIds).toEqual(["view_z", "view_a"]);
    expect(analysisStudyViewSetDigest(item.viewEventDigests)).toBe(
      analysisStudyViewSetDigest([D3, D2])
    );
    const postClose = { ...later, id: "view_post_close", countsTowardClosure: false,
      idempotencyKey: "view-post-close", contentDigest: D1, viewedAt: "2026-08-20T12:00:02.000Z" };
    expect(applyAnalysisStudyItemView(item, postClose, [earlier, later])).toEqual(item);
  });
});

describe("taxonomy chain, assignments, coverage, and claims", () => {
  it("keeps stable code identity, allows reorder/retirement, and forbids disappearance/unretirement", () => {
    const taxonomy = taxonomyArtifact();
    stableCode("code_a", "tr_1");
    stableCode("code_b", "tr_1");
    const r1 = revision("tr_1", 1, [revisionCode("tr_1", "code_a", 0, "A"), revisionCode("tr_1", "code_b", 1, "B")]);
    assertAnalysisTaxonomyRevision(taxonomy, r1.revision, r1.codes);
    const r2 = revision("tr_2", 2, [
      revisionCode("tr_2", "code_b", 0, "B", "retired"),
      revisionCode("tr_2", "code_a", 1, "A renamed", "active", "A revised")
    ], r1);
    expect(() => assertAnalysisTaxonomyRevision(taxonomy, r2.revision, r2.codes, r1)).not.toThrow();
    const changedWhileRetiring = revision("tr_changed", 2, [
      revisionCode("tr_changed", "code_a", 0, "A"),
      revisionCode("tr_changed", "code_b", 1, "B changed while retiring", "retired")
    ], r1);
    expect(() => assertAnalysisTaxonomyRevision(taxonomy, changedWhileRetiring.revision, changedWhileRetiring.codes, r1))
      .toThrow(/status only/);
    const missing = revision("tr_bad", 2, [revisionCode("tr_bad", "code_a", 0, "A")], r1);
    expect(() => assertAnalysisTaxonomyRevision(taxonomy, missing.revision, missing.codes, r1)).toThrow(/retain every/);
    const r3Unretired = revision("tr_3", 3, [
      revisionCode("tr_3", "code_a", 0, "A renamed", "active", "A revised"),
      revisionCode("tr_3", "code_b", 1, "B", "active")
    ], r2);
    expect(() => assertAnalysisTaxonomyRevision(taxonomy, r3Unretired.revision, r3Unretired.codes, r2)).toThrow(/Retired/);
  });

  it("projects assignment heads as-of R without later heads rewriting earlier coverage", () => {
    const taxonomy = taxonomyArtifact();
    const r1 = revision("tr_1", 1, [revisionCode("tr_1", "code_a", 0, "A")]);
    const r2 = revision("tr_2", 2, [revisionCode("tr_2", "code_a", 0, "A", "retired")], r1);
    let item = initialAnalysisStudyItemProjection(itemArtifact());
    const observed = itemEvent(item, "observation_1", {
      eventType: "failure_observed", failureLabel: "A", rationale: "Evidence", evidenceAnchor: { kind: "case_output" }
    });
    item = applyAnalysisStudyItemEvent(item, observed, "coding_open");
    const a1 = assignment(item, r1, "assignment_1", observed.id, "code_a");
    assertAnalysisAssignmentSuccessor({ previous: null, next: a1, currentRevision: r1 });
    item = applyAnalysisAssignmentEventToItem(item, a1, "coding_open");
    const a2 = assignment(item, r2, "assignment_2", observed.id, null, a1);
    assertAnalysisAssignmentSuccessor({ previous: a1, next: a2, currentRevision: r2 });
    const atR1 = computeAnalysisTaxonomyCoverage({
      studyId: "study_1", taxonomy, targetRevision: r1, revisionAncestry: [{ id: "tr_1", sequence: 1 }],
      items: [item], assignmentEvents: [a1, a2]
    });
    expect(atR1).toMatchObject({ categorized: "1", assignedToRetiredCode: "0", uncategorized: "0" });
    const atR2BeforeWithdrawal = computeAnalysisTaxonomyCoverage({
      studyId: "study_1", taxonomy, targetRevision: r2,
      revisionAncestry: [{ id: "tr_1", sequence: 1 }, { id: "tr_2", sequence: 2 }],
      items: [item], assignmentEvents: [a1]
    });
    expect(atR2BeforeWithdrawal).toMatchObject({ categorized: "0", assignedToRetiredCode: "1", uncategorized: "0" });
    const atR2 = computeAnalysisTaxonomyCoverage({
      studyId: "study_1", taxonomy, targetRevision: r2,
      revisionAncestry: [{ id: "tr_1", sequence: 1 }, { id: "tr_2", sequence: 2 }],
      items: [item], assignmentEvents: [a1, a2]
    });
    expect(atR2).toMatchObject({ activeFailureObservationCount: "1", categorized: "0", assignedToRetiredCode: "0", uncategorized: "1" });
    expect(AnalysisTaxonomyCoverageSchema.safeParse({ ...atR2, uncategorized: "0" }).success).toBe(false);
  });

  it("derives the exact claim precedence independently of taxonomy coverage", () => {
    const complete = [{ studyItemId: "item_1", position: 0, itemState: "completed" as const }];
    const base = {
      populationId: "population_1", methodEligible: true,
      frozenFrameDigest: D1, recomputedFrameDigest: D1,
      frozenDrawDigest: D2, recomputedDrawDigest: D2,
      selectedItemCount: 1, closureItems: complete
    };
    expect(deriveAnalysisStudyRepresentativeAssessment(base)).toMatchObject({
      representativeOfPopulationId: "population_1", representativeReason: null
    });
    expect(deriveAnalysisStudyRepresentativeAssessment({ ...base, methodEligible: false }).representativeReason)
      .toBe("method_not_eligible");
    expect(deriveAnalysisStudyRepresentativeAssessment({ ...base, recomputedFrameDigest: null }).representativeReason)
      .toBe("frame_not_reproducible");
    expect(deriveAnalysisStudyRepresentativeAssessment({ ...base, recomputedDrawDigest: null }).representativeReason)
      .toBe("draw_not_complete");
    expect(deriveAnalysisStudyRepresentativeAssessment({
      ...base, closureItems: [{ ...complete[0]!, itemState: "in_progress" as const }]
    }).representativeReason).toBe("coding_not_complete");
    expect(() => deriveAnalysisStudyRepresentativeAssessment({ ...base, selectedItemCount: 2 })).toThrow(/every selected/);
  });
});

describe("6B-2 canonical digest envelope", () => {
  it("freezes every basis and one cross-artifact golden vector", () => {
    expect([
      ANALYSIS_STUDY_REQUEST_DIGEST_BASIS, ANALYSIS_STUDY_CONTENT_DIGEST_BASIS,
      ANALYSIS_STUDY_EVENT_REQUEST_DIGEST_BASIS, ANALYSIS_STUDY_EVENT_DIGEST_BASIS,
      ANALYSIS_STUDY_ITEM_DIGEST_BASIS, ANALYSIS_STUDY_ITEM_EVENT_REQUEST_DIGEST_BASIS,
      ANALYSIS_STUDY_ITEM_EVENT_DIGEST_BASIS, ANALYSIS_STUDY_ITEM_VIEW_REQUEST_DIGEST_BASIS,
      ANALYSIS_STUDY_ITEM_VIEW_DIGEST_BASIS, ANALYSIS_STUDY_VIEW_SET_DIGEST_BASIS,
      ANALYSIS_STUDY_CLOSURE_ITEM_DIGEST_BASIS, ANALYSIS_STUDY_CLOSURE_CONTENT_DIGEST_BASIS,
      ANALYSIS_REPRESENTATIVE_ASSESSMENT_DIGEST_BASIS, ANALYSIS_STUDY_CLOSURE_DIGEST_BASIS,
      ANALYSIS_TAXONOMY_REQUEST_DIGEST_BASIS, ANALYSIS_TAXONOMY_CONTENT_DIGEST_BASIS,
      ANALYSIS_TAXONOMY_CODE_DIGEST_BASIS, ANALYSIS_TAXONOMY_REVISION_CODE_DIGEST_BASIS,
      ANALYSIS_TAXONOMY_REVISION_DIGEST_BASIS, ANALYSIS_ASSIGNMENT_REQUEST_DIGEST_BASIS,
      ANALYSIS_ASSIGNMENT_EVENT_DIGEST_BASIS
    ]).toHaveLength(21);

    const createInput = {
      name: "Failures", description: "Human-authored failure taxonomy.", reason: "Initial taxonomy",
      codes: [{ kind: "new" as const, clientToken: "code-a", label: "Incorrect", definition: "Incorrect answer." }],
      idempotencyKey: "taxonomy-1"
    };
    const itemRequest = {
      eventType: "failure_observed" as const, expectedVersion: "0", idempotencyKey: "observe-1",
      failureLabel: "Incorrect", rationale: "The final output is false.", evidenceAnchor: { kind: "case_output" as const }
    };
    const values = {
      studyRequest: analysisStudyRequestDigest("project_1", "population_1"),
      deadlineCloseRequest: analysisStudyEventRequestDigest({
        studyId: "study_1", expectedVersion: "1", eventType: "coding_closed", reason: null
      }),
      itemRequest: analysisStudyItemEventRequestDigest("project_1", "study_1", "item_1", itemRequest),
      taxonomyRequest: analysisFailureTaxonomyRequestDigest("project_1", createInput),
      viewRequest: analysisStudyItemViewRequestDigest({
        projectId: "project_1", studyId: "study_1", studyItemId: "item_1",
        viewerUserId: "user_1", viewerSubjectId: "subject_1", datasetRevisionId: "revision_1"
      }),
      closureItem: analysisStudyClosureItemContentDigest({
        studyId: "study_1", studyItemId: "item_1", drawItemId: "draw_item_1", caseId: "case_1", position: 0,
        itemState: "completed", itemEventVersion: "2", currentEventId: "complete_1", currentEventDigest: D1,
        viewEventIds: ["view_1"], viewEventDigests: [D2],
        activeFailureObservationEventIds: ["observation_1"], activeFailureObservationEventDigests: [D3],
        activeFailureAssignmentEventIds: [null], activeFailureAssignmentEventDigests: [null],
        activeNoFailureEventId: null, activeNoFailureEventDigest: null,
        completionEventId: "complete_1", completionEventDigest: D1
      })
    };
    expect(values).toEqual({
      studyRequest: "sha256:42e10373e4c2f1d6898d25ae643edc6a232c398a43a0afab2e6c675da6bcb680",
      deadlineCloseRequest: "sha256:61c8dbae6ce2fef928919964770960366e25ea5217a245ec43f8d44bb0a2a729",
      itemRequest: "sha256:72013777d32dcd30f07706e5d5fe18dfab06550186b7da7c9262a0d3e8ea5bb4",
      taxonomyRequest: "sha256:1a0b990dcd0a141c143ef7727a3b0c84f79af69fc249bfa32ba0392391c4c271",
      viewRequest: "sha256:d1d0a630823623ed415719f00ffd6567259dda0fa16f7c04c6189feec656bdda",
      closureItem: "sha256:7795dec7faf3b036d5d51b1c71538ca53a51167b91fc0af4c54438a610efb61e"
    });
  });

  it("binds request bodies while excluding only idempotency keys", () => {
    const first = analysisStudyItemEventRequestDigest("project_1", "study_1", "item_1", {
      eventType: "no_failure_observed", expectedVersion: "0", idempotencyKey: "key-a", rationale: "No failure"
    });
    const replay = analysisStudyItemEventRequestDigest("project_1", "study_1", "item_1", {
      eventType: "no_failure_observed", expectedVersion: "0", idempotencyKey: "key-b", rationale: "No failure"
    });
    expect(replay).toBe(first);
    expect(analysisStudyItemEventRequestDigest("project_1", "study_1", "item_1", {
      eventType: "no_failure_observed", expectedVersion: "0", idempotencyKey: "key-b", rationale: "Different"
    })).not.toBe(first);
  });
});
