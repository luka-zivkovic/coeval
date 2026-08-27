import { describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
  ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
  type AnalysisCriterionPromotionCreateInput,
  type AnalysisCriterionPromotionCreateResult
} from "@coeval/shared";
import { createAnalysisPromotionRouter } from "../src/analysis-promotion/routes.js";
import type { AnalysisPromotionRepository } from "../src/analysis-promotion/repository.js";
import { analysisCriterionPromotionRequestDigest } from "../src/lib/analysis-promotion.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const AT = "2026-08-23T12:00:00.000Z";

function input(): AnalysisCriterionPromotionCreateInput {
  return {
    studyId: "study_1",
    expectedClosureId: "closure_1",
    expectedClosureDigest: D1,
    taxonomyId: "taxonomy_1",
    taxonomyRevisionId: "taxonomy_revision_1",
    expectedTaxonomyRevisionDigest: D2,
    codeId: "code_1",
    expectedCodeEntryDigest: D3,
    criterionName: "Incorrect refund guidance",
    criterionDefinition: "The response must state the applicable refund window.",
    rationale: "Closed coding evidence shows a recurring failure.",
    supportingObservations: [{
      studyItemId: "study_item_1",
      closureItemId: "closure_item_1",
      closureItemDigest: D1,
      observationEventId: "observation_1",
      observationEventDigest: D2,
      assignmentEventId: "assignment_1",
      assignmentEventDigest: D3
    }],
    idempotencyKey: "promotion-1"
  };
}

function result(overrides: { projectId?: string; studyId?: string } = {}): AnalysisCriterionPromotionCreateResult {
  const projectId = overrides.projectId ?? "project_1";
  const studyId = overrides.studyId ?? "study_1";
  const promotion = {
    id: "promotion_1", projectId,
    contractVersion: ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
    studyId, studyClosureId: "closure_1", studyClosureDigest: D1,
    populationId: "population_1", drawId: "draw_1",
    sourceDatasetRevisionId: "revision_1", sourceDatasetRevisionContentDigest: D1,
    sourceDatasetRevisionDigest: D2, taxonomyId: "taxonomy_1",
    taxonomyRevisionId: "taxonomy_revision_1", taxonomyRevisionSequence: 1,
    taxonomyRevisionDigest: D2, codeId: "code_1", codeEntryId: "code_entry_1",
    codeEntryDigest: D3, codeLabel: "Incorrect refund guidance", codeDefinition: "Incorrect refund window.",
    criterionId: "criterion_1", criterionVersionId: "criterion_version_1",
    criterionStableKey: "analysis-failure-code:code_1", criterionName: "Incorrect refund guidance",
    criterionDefinition: "The response must state the applicable refund window.", criterionDigest: D3,
    rationale: "Closed coding evidence shows a recurring failure.", supportCount: 1,
    supportSetDigest: D1, criterionAuthoringExposureEventId: "exposure_authoring_1",
    promotedByUserId: "user_1", promotedBySubjectId: "subject_owner", promoterRole: "owner" as const,
    idempotencyKey: "promotion-1", requestDigest: analysisCriterionPromotionRequestDigest(projectId, input()), contentDigest: D3,
    handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION, handoffDigest: D1, createdAt: AT
  };
  return {
    promotion,
    criterion: {
      id: promotion.criterionId, projectId, stableKey: promotion.criterionStableKey,
      sourceKind: "analysis_promotion", createdByUserId: "user_1", createdAt: AT
    },
    criterionVersion: {
      id: promotion.criterionVersionId, projectId, criterionId: promotion.criterionId, revision: 1,
      name: promotion.criterionName, definition: promotion.criterionDefinition,
      criterionDigest: promotion.criterionDigest, sourceKind: "analysis_promotion",
      createdByUserId: "user_1", createdAt: AT
    },
    handoff: {
      handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
      promotionId: promotion.id, projectId, criterionId: promotion.criterionId,
      criterionVersionId: promotion.criterionVersionId, criterionDigest: promotion.criterionDigest,
      sourceDatasetRevisionId: promotion.sourceDatasetRevisionId,
      sourceDatasetRevisionContentDigest: promotion.sourceDatasetRevisionContentDigest,
      sourceDatasetRevisionDigest: promotion.sourceDatasetRevisionDigest,
      roleIntent: "analysis_authoring", sourceKind: "analysis_promotion_handoff",
      evidenceClass: "development_authoring_not_truth", createsTruth: false, createsEvaluator: false,
      handoffDigest: promotion.handoffDigest
    },
    supports: [{
      id: "support_1", projectId, promotionId: promotion.id, position: 0, studyId,
      studyItemId: "study_item_1", closureId: "closure_1", closureItemId: "closure_item_1",
      closureItemDigest: D1, sourceDatasetRevisionId: "revision_1",
      sourceDatasetRevisionItemId: "revision_item_1", sourceItemDigest: D1,
      observationEventId: "observation_1", observationEventDigest: D2,
      assignmentEventId: "assignment_1", assignmentEventDigest: D3,
      observationAuthorSubjectId: "subject_author", exampleSelectionExposureEventId: "exposure_support_1",
      contentDigest: D2, createdAt: AT
    }],
    replayed: false
  };
}

function repository(overrides: Partial<AnalysisPromotionRepository> = {}): AnalysisPromotionRepository {
  return new Proxy(overrides as AnalysisPromotionRepository, {
    get(target, property) {
      if (property in target) return target[property as keyof AnalysisPromotionRepository];
      return vi.fn(async () => null);
    }
  });
}

function router(
  repo: AnalysisPromotionRepository | null,
  identity: { userId: string | null; apiKeyId?: string } = { userId: "user_1" },
  role: "owner" | "member" | null = "owner",
  databaseMode = true
) {
  return createAnalysisPromotionRouter({
    repository: repo,
    databaseMode,
    requestIdentity: () => ({ projectId: "project_1", ...identity }),
    resolveProjectRole: async () => role
  });
}

describe("analysis promotion session boundary", () => {
  it("denies demo, API-key, signed-out, and member requests before repository work", async () => {
    const createPromotion = vi.fn();
    const repo = repository({ createPromotion });
    const body = JSON.stringify(input());
    const request = { method: "POST", headers: { "content-type": "application/json" }, body };
    expect((await router(null, { userId: "user_1" }, "owner", false).request("/", request)).status).toBe(501);
    expect((await router(repo, { userId: "user_1", apiKeyId: "key_1" }).request("/", request)).status).toBe(401);
    expect((await router(repo, { userId: null }).request("/", request)).status).toBe(401);
    expect((await router(repo, { userId: "user_1" }, "member").request("/", request)).status).toBe(403);
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it("returns 201 for the exact first promotion and 200 for exact replay", async () => {
    const first = result();
    const createPromotion = vi.fn(async () => first);
    const response = await router(repository({ createPromotion })).request("/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input())
    });
    expect(response.status).toBe(201);
    const replay = { ...first, replayed: true };
    const replayResponse = await router(repository({ createPromotion: vi.fn(async () => replay) })).request("/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input())
    });
    expect(replayResponse.status).toBe(200);
  });

  it("rejects schema-valid create results with swapped project or study lineage", async () => {
    for (const swapped of [result({ projectId: "project_other" }), result({ studyId: "study_other" })]) {
      const response = await router(repository({ createPromotion: vi.fn(async () => swapped) })).request("/", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input())
      });
      expect(response.status).toBe(500);
    }
  });

  it("requires candidates and list rows to bind the exact owner query", async () => {
    const candidate = {
      projectId: "project_other", studyId: "study_1", studyState: "coding_closed" as const,
      closureId: "closure_1", closureDigest: D1, taxonomyId: "taxonomy_1",
      taxonomyRevisionId: "taxonomy_revision_1", taxonomyRevisionSequence: 1,
      taxonomyRevisionDigest: D2, codeId: "code_1", codeEntryId: "entry_1", codeEntryDigest: D3,
      codeLabel: "Incorrect refund guidance", codeDefinition: "Incorrect refund window.", codeStatus: "active" as const,
      studyItemId: "study_item_1", closureItemId: "closure_item_1", closureItemDigest: D1, position: 0,
      sourceDatasetRevisionId: "revision_1", sourceDatasetRevisionItemId: "revision_item_1",
      sourceItemDigest: D1, observationEventId: "observation_1", observationEventDigest: D2,
      failureLabel: "Incorrect refund guidance", observationRationale: "Observed in the output.",
      evidenceAnchor: { kind: "case_output" as const }, assignmentEventId: "assignment_1",
      assignmentEventDigest: D3, assignmentRationale: "Matches the active code.",
      observationAuthorSubjectId: "subject_author"
    };
    const candidateResponse = await router(repository({
      listCandidates: vi.fn(async () => ({ items: [candidate], totalCount: "1", nextCursor: null }))
    })).request("/candidates?studyId=study_1&taxonomyRevisionId=taxonomy_revision_1&codeId=code_1");
    expect(candidateResponse.status).toBe(500);

    const summary = result();
    const listResponse = await router(repository({
      listPromotions: vi.fn(async () => ({
        items: [{ ...summary, supports: undefined, replayed: undefined }], totalCount: "1", nextCursor: null
      } as never))
    })).request("/?studyId=study_other");
    expect(listResponse.status).toBe(500);
  });
});
