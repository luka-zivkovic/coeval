import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnalysisStudies, fetchAnalysisStudyItemContent } from "../src/lib/analysis-study-api.js";
import { AnalysisStudyRequestCoordinator } from "../src/lib/analysis-study-request-coordinator.js";
import { AnalysisMutationCoordinator } from "../src/lib/analysis-mutation-coordinator.js";
import {
  analysisStudyUiCapabilities,
  loadAllUsedAnalysisPopulationIds,
  loadExactActiveFailureObservationCount,
  loadHistoryThroughRequiredIds,
  replaceAnalysisStudyItemProjection
} from "../src/lib/analysis-study-ui.js";
import { AnalysisPromotionApiError } from "../src/lib/analysis-promotion-api.js";
import { AnalysisStudyApiError } from "../src/lib/analysis-study-api.js";
import {
  analysisMutationFailureKind,
  analysisPromotionContextMatches,
  analysisPromotionHandoffInstructionHref
} from "../src/lib/analysis-promotion-ui.js";
import {
  analysisCodingCardKey,
  analyzeJourneyFindingSnapshot,
  buildAnalyzeJourneySteps,
  defaultAnalysisWindowEnd
} from "../src/lib/analyze-journey.js";
import { ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS } from "@coeval/shared";
import { readFeatureSource } from "./support/web-extraction-contracts.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;

describe("analysis study web boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches frozen content only through the explicit item action", async () => {
    const calls: string[] = [];
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "project_1") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      calls.push(input);
      return new Response(JSON.stringify({ content: {
        projectId: "project_1",
        studyId: "study_1",
        populationId: "population_1",
        drawId: "draw_1",
        datasetRevisionId: "revision_1",
        studyItemId: "study_item_1",
        drawItemId: "draw_item_1",
        memberId: "member_1",
        revisionItemId: "revision_item_1",
        caseId: "case_1",
        position: 0,
        inputDigest: digest("1"),
        itemDigest: digest("2"),
        viewEventId: "view_1",
        datasetExposureEventId: "exposure_1",
        payloadSnapshot: { input: { prompt: "hello" }, output: { answer: "world" }, metadata: {} }
      } }), { headers: { "content-type": "application/json" } });
    }));

    expect(calls).toEqual([]);
    const content = await fetchAnalysisStudyItemContent("study_1", "study_item_1");
    expect(content).toMatchObject({ studyId: "study_1", studyItemId: "study_item_1", position: 0 });
    expect(calls).toEqual(["/api/analysis-studies/study_1/items/study_item_1/content"]);
  });

  it("retains the exact server-resolved project role on the list envelope", async () => {
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "project_1") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      page: { items: [], totalCount: "0", unavailableDueClosureCount: 0, nextCursor: null },
      projectRole: "member"
    }), { headers: { "content-type": "application/json" } })));
    await expect(fetchAnalysisStudies()).resolves.toEqual({
      items: [], totalCount: "0", unavailableDueClosureCount: 0,
      nextCursor: null, projectRole: "member"
    });
  });

  it("rejects stale study, item, content, and duplicate-page responses", () => {
    const coordinator = new AnalysisStudyRequestCoordinator();
    const studyA = coordinator.selectStudy("study_A");
    const itemA = coordinator.selectItem("study_A", "item_A")!;
    const contentA = coordinator.beginContent("study_A", "item_A")!;
    const pageA = coordinator.beginPage("study_A", "cursor_A")!;
    expect(coordinator.beginPage("study_A", "cursor_A")).toBeNull();

    const studyB = coordinator.selectStudy("study_B");
    const itemB = coordinator.selectItem("study_B", "item_B")!;
    const contentBFirst = coordinator.beginContent("study_B", "item_B")!;
    const contentBLast = coordinator.beginContent("study_B", "item_B")!;

    expect(coordinator.isStudyCurrent(studyA)).toBe(false);
    expect(coordinator.isItemCurrent(itemA)).toBe(false);
    expect(coordinator.isContentCurrent(contentA)).toBe(false);
    expect(coordinator.isStudyCurrent(pageA)).toBe(false);
    expect(coordinator.isStudyCurrent(studyB)).toBe(true);
    expect(coordinator.isItemCurrent(itemB)).toBe(true);
    expect(coordinator.isContentCurrent(contentBFirst)).toBe(false);
    expect(coordinator.isContentCurrent(contentBLast)).toBe(true);
  });

  it("deduplicates double clicks and reuses one key after an ambiguous response", () => {
    let sequence = 0;
    const coordinator = new AnalysisMutationCoordinator(() => `key_${++sequence}`);
    const first = coordinator.begin("close:reason");
    expect(first).toBe("key_1");
    expect(coordinator.begin("close:reason")).toBeNull();
    coordinator.finish("close:reason", "ambiguous_failure");
    expect(coordinator.begin("close:reason")).toBe("key_1");
    coordinator.finish("close:reason", "definitive_failure");
    expect(coordinator.begin("close:reason")).toBe("key_2");
    coordinator.finish("close:reason", "success");
  });

  it("states the guided, human-authored analysis boundary without release claims", async () => {
    const [workspace, analyze, journey, sidebar] = await Promise.all([
      readFeatureSource("analysis-study-workspace"),
      readFile(new URL("../src/screens/analyze.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../../docs/analyze-journey.md", import.meta.url), "utf8"),
      readFile(new URL("../src/components/layout/sidebar.tsx", import.meta.url), "utf8")
    ]);
    expect(analyze).toContain("<AnalysisStudyWorkspace populations={populations}");
    expect(analyze).toContain("1. Choose runs to review");
    expect(analyze).toContain("Sample size");
    expect(analyze).not.toContain('label="Fixed K"');
    expect(analyze).not.toContain('label="Idempotency key"');
    expect(workspace).toContain("metadata only until View");
    expect(workspace).toContain("temporarily unavailable while durable deadline closure retries");
    expect(workspace).toContain("Complete for this exact frozen set only");
    expect(workspace).toContain("Coeval does not cluster, merge, split, or generate categories");
    expect(workspace).toContain("Findings by failure type");
    expect(workspace).toContain("Per-type promotion evidence is owner-only");
    expect(workspace).toContain("Open reviewed run");
    expect(workspace).toContain("analysis exists — resume below");
    expect(workspace).toContain("key={analysisCodingCardKey(selectedItem)}");
    expect(workspace).not.toMatch(/release[- ]ready|trusted evaluator|prevalence estimate/i);
    expect(journey).toContain("The first-value moment is seeing human-authored findings");
    expect(journey).toContain("It does not cluster");
    expect(journey).toContain("Creates a criterion and review handoff only");
    expect(sidebar).toContain('label: "Analyze · find failures"');
  });

  it("keeps missing and unorganized work explicit without blocking a valid criterion action", () => {
    const steps = buildAnalyzeJourneySteps({
      reviewSampleCount: 1,
      analysisState: "coding_closed",
      selectedItemCount: 20,
      completedItemCount: 3,
      activeFailureTypeCount: 2,
      activeFailureObservationCount: "5",
      organizationCountsAvailable: true,
      categorizedObservationCount: "2",
      retiredAssignmentCount: "1",
      uncategorizedObservationCount: "2",
      canCreateCriterion: true,
      criterionCreated: false
    });
    expect(steps.map((step) => step.status)).toEqual(["complete", "incomplete", "incomplete", "current"]);
    expect(steps[1]!.detail).toContain("17 unfinished at close");
    expect(steps[2]!.detail).toContain("3 need a current type");
  });

  it("does not treat an all-retired taxonomy as a promotable findings state", () => {
    const steps = buildAnalyzeJourneySteps({
      reviewSampleCount: 1,
      analysisState: "completed",
      selectedItemCount: 2,
      completedItemCount: 2,
      activeFailureTypeCount: 0,
      activeFailureObservationCount: "2",
      organizationCountsAvailable: true,
      categorizedObservationCount: "0",
      retiredAssignmentCount: "2",
      uncategorizedObservationCount: "0",
      canCreateCriterion: true,
      criterionCreated: false
    });
    expect(steps[2]).toMatchObject({ status: "current" });
    expect(steps[3]).toMatchObject({ status: "blocked", detail: "Name a failure type first" });
  });

  it("defaults the sample end safely behind the mandatory ingestion lag", () => {
    const now = Date.parse("2026-08-27T12:34:45.000Z");
    expect(defaultAnalysisWindowEnd(now).getTime()).toBeLessThanOrEqual(
      now - ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS * 1_000
    );
  });

  it("keeps a run draft mounted across versions but isolates different runs", () => {
    const runA = analysisCodingCardKey({ item: { studyId: "study_1", id: "item_A" }, currentVersion: "3" });
    expect(runA).toBe("study_1:item_A");
    expect(analysisCodingCardKey({ item: { studyId: "study_1", id: "item_B" }, currentVersion: "3" })).not.toBe(runA);
    expect(analysisCodingCardKey({ item: { studyId: "study_1", id: "item_A" }, currentVersion: "4" })).toBe(runA);
    expect(analysisCodingCardKey({ item: { studyId: "study_2", id: "item_A" }, currentVersion: "4" })).not.toBe(runA);
  });

  it("shows honest terminal progress for stopped, no-issue, and promoted analyses", () => {
    const base = {
      reviewSampleCount: 1,
      selectedItemCount: 2,
      completedItemCount: 2,
      activeFailureTypeCount: 0,
      activeFailureObservationCount: "0",
      organizationCountsAvailable: true,
      categorizedObservationCount: "0",
      retiredAssignmentCount: "0",
      uncategorizedObservationCount: "0",
      canCreateCriterion: true,
      criterionCreated: false
    } as const;
    const noIssue = buildAnalyzeJourneySteps({ ...base, analysisState: "coding_closed" });
    expect(noIssue[2]).toMatchObject({ status: "complete", detail: "No issue observations to organize" });
    expect(noIssue[3]).toMatchObject({ status: "blocked", detail: "No failure finding to turn into a criterion" });

    const stopped = buildAnalyzeJourneySteps({ ...base, analysisState: "abandoned", completedItemCount: 1 });
    expect(stopped.map((step) => step.status)).toEqual(["complete", "incomplete", "complete", "blocked"]);

    const promoted = buildAnalyzeJourneySteps({
      ...base,
      analysisState: "completed",
      activeFailureTypeCount: 1,
      activeFailureObservationCount: "1",
      categorizedObservationCount: "1",
      criterionCreated: true
    });
    expect(promoted[3]).toMatchObject({ status: "complete" });
  });

  it("keeps unknown, zero, stopped, and member-owned finding states distinct", () => {
    const withoutTaxonomy = analyzeJourneyFindingSnapshot({
      coverage: null,
      exactActiveFailureObservationCount: "0"
    });
    const noIssue = buildAnalyzeJourneySteps({
      reviewSampleCount: 1,
      analysisState: "coding_closed",
      selectedItemCount: 2,
      completedItemCount: 2,
      activeFailureTypeCount: 0,
      ...withoutTaxonomy,
      canCreateCriterion: true,
      criterionCreated: false
    });
    expect(noIssue[2]).toMatchObject({ status: "complete", detail: "No issue observations to organize" });
    expect(noIssue[3]).toMatchObject({ status: "blocked", detail: "No failure finding to turn into a criterion" });

    const pending = buildAnalyzeJourneySteps({
      reviewSampleCount: 1,
      analysisState: "coding_closed",
      selectedItemCount: 2,
      completedItemCount: 2,
      activeFailureTypeCount: 0,
      ...analyzeJourneyFindingSnapshot({ coverage: null, exactActiveFailureObservationCount: null }),
      canCreateCriterion: true,
      criterionCreated: false
    });
    expect(pending[3]!.detail).toContain("Checking exact findings");

    const preserved = buildAnalyzeJourneySteps({
      reviewSampleCount: 1,
      analysisState: "abandoned",
      selectedItemCount: 2,
      completedItemCount: 1,
      activeFailureTypeCount: 1,
      activeFailureObservationCount: "2",
      organizationCountsAvailable: true,
      categorizedObservationCount: "1",
      retiredAssignmentCount: "0",
      uncategorizedObservationCount: "1",
      canCreateCriterion: true,
      criterionCreated: false
    });
    expect(preserved[2]).toMatchObject({ status: "incomplete" });
    expect(preserved[2]!.detail).toContain("1/2 preserved observations organized");

    const member = buildAnalyzeJourneySteps({
      reviewSampleCount: 1,
      analysisState: "completed",
      selectedItemCount: 2,
      completedItemCount: 2,
      activeFailureTypeCount: 1,
      activeFailureObservationCount: "1",
      organizationCountsAvailable: true,
      categorizedObservationCount: "1",
      retiredAssignmentCount: "0",
      uncategorizedObservationCount: "0",
      canCreateCriterion: false,
      criterionCreated: null
    });
    expect(member[3]!.detail).toContain("managed by a project owner");
  });

  it("pages every analysis before allowing a used sample to be submitted again", async () => {
    const first = {
      items: [{ study: { study: { populationId: "population_1" } } }],
      nextCursor: "page_2",
      unavailableDueClosureCount: 0
    };
    const used = await loadAllUsedAnalysisPopulationIds(first, async (cursor) => {
      expect(cursor).toBe("page_2");
      return {
        items: [{ study: { study: { populationId: "population_2" } } }],
        nextCursor: null,
        unavailableDueClosureCount: 0
      };
    });
    expect([...used.populationIds]).toEqual(["population_1", "population_2"]);
    expect(used.unavailableDueClosureCount).toBe(0);
  });

  it("counts active findings across every item metadata page without a taxonomy", async () => {
    const count = await loadExactActiveFailureObservationCount(async (cursor) => cursor === null ? {
      items: [
        { activeFailureObservationEventIds: ["observation_1", "observation_2"] },
        { activeFailureObservationEventIds: [] }
      ],
      nextCursor: "page_2"
    } : {
      items: [{ activeFailureObservationEventIds: ["observation_3"] }],
      nextCursor: null
    });
    expect(count).toBe("3");
  });

  it("keeps owner administration distinct from member coding authority", () => {
    expect(analysisStudyUiCapabilities("owner")).toEqual({ canAdminister: true, canCode: true });
    expect(analysisStudyUiCapabilities("member")).toEqual({ canAdminister: false, canCode: true });
    expect(analysisStudyUiCapabilities(null)).toEqual({ canAdminister: false, canCode: false });
  });

  it("automatically pages until an old active observation is actionable", async () => {
    const cursors: Array<string | null> = [];
    const result = await loadHistoryThroughRequiredIds(["active_v1"], async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? { items: Array.from({ length: 100 }, (_, index) => ({ id: `new_${index}` })), nextCursor: "older" }
        : { items: [{ id: "active_v1" }], nextCursor: null };
    });

    expect(cursors).toEqual([null, "older"]);
    expect(result.items).toHaveLength(101);
    expect(result.items.at(-1)).toEqual({ id: "active_v1" });
  });

  it("updates an item beyond page one without dropping its loaded page or coding context", () => {
    const rows = Array.from({ length: 150 }, (_, position) => ({
      item: { id: `item_${position}` },
      currentVersion: "0"
    }));
    const replacement = { item: { id: "item_149" }, currentVersion: "1" };

    const updated = replaceAnalysisStudyItemProjection(rows, replacement);

    expect(updated).toHaveLength(150);
    expect(updated[0]).toBe(rows[0]);
    expect(updated[149]).toBe(replacement);
    expect(rows[149]!.currentVersion).toBe("0");
  });

  it("rejects a delayed promotion result after the study or code context changes", async () => {
    type Context = { studyId: string; taxonomyRevisionId: string; codeId: string };
    let current: Context = { studyId: "study_A", taxonomyRevisionId: "taxonomy_revision_1", codeId: "code_A" };
    const expected = { ...current };
    let resolve!: (value: string) => void;
    const deferred = new Promise<string>((next) => { resolve = next; });
    let visibleReceipt: string | null = null;
    const commit = deferred.then((receipt) => {
      if (analysisPromotionContextMatches(current, expected)) visibleReceipt = receipt;
    });

    current = { studyId: "study_B", taxonomyRevisionId: "taxonomy_revision_1", codeId: "code_A" };
    resolve("promotion_A");
    await commit;
    expect(visibleReceipt).toBeNull();

    current = { studyId: "study_B", taxonomyRevisionId: "taxonomy_revision_1", codeId: "code_B" };
    expect(analysisPromotionContextMatches(current, {
      studyId: "study_B", taxonomyRevisionId: "taxonomy_revision_1", codeId: "code_A"
    })).toBe(false);
  });

  it("retires promotion and study keys after definitive 4xx failures", () => {
    expect(analysisMutationFailureKind(
      new AnalysisPromotionApiError("conflict", 409, "analysis_promotion_code_already_promoted")
    )).toBe("definitive_failure");
    expect(analysisMutationFailureKind(
      new AnalysisStudyApiError("conflict", 409, "analysis_study_state_conflict")
    )).toBe("definitive_failure");
    expect(analysisMutationFailureKind(
      new AnalysisPromotionApiError("unavailable", 503, null)
    )).toBe("ambiguous_failure");
    expect(analysisMutationFailureKind(new TypeError("network reset"))).toBe("ambiguous_failure");
  });

  it("carries the exact promoted criterion and handoff into instruction authoring", () => {
    expect(analysisPromotionHandoffInstructionHref("criterion promoted", "promotion/1")).toBe(
      "/human-truth/new/instruction?criterionId=criterion%20promoted&promotionId=promotion%2F1"
    );
  });
});
