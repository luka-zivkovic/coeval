import { describe, expect, it } from "vitest";
import {
  ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
  ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
  ANALYSIS_MAX_PROMOTION_SUPPORTS,
  AnalysisCriterionPromotionArtifactSchema,
  AnalysisCriterionPromotionCandidatesPageSchema,
  AnalysisCriterionPromotionCreateInputSchema,
  AnalysisCriterionPromotionCreateResultSchema,
  AnalysisCriterionPromotionHandoffSchema,
  CriterionSourceKindSchema,
  type AnalysisCriterionPromotionArtifact,
  type AnalysisCriterionPromotionCreateInput,
  type AnalysisCriterionPromotionHandoff,
  type AnalysisCriterionPromotionSupportArtifact
} from "@coeval/shared";
import {
  ANALYSIS_CRITERION_PROMOTION_CONTENT_DIGEST_BASIS,
  ANALYSIS_CRITERION_PROMOTION_HANDOFF_DIGEST_BASIS,
  ANALYSIS_CRITERION_PROMOTION_REQUEST_DIGEST_BASIS,
  ANALYSIS_CRITERION_PROMOTION_SUPPORT_DIGEST_BASIS,
  ANALYSIS_CRITERION_PROMOTION_SUPPORT_SET_DIGEST_BASIS,
  analysisCriterionPromotionContentDigest,
  analysisCriterionPromotionHandoffDigest,
  analysisCriterionPromotionRequestDigest,
  analysisCriterionPromotionStableKey,
  analysisCriterionPromotionSupportContentDigest,
  analysisCriterionPromotionSupportSetDigest,
  canonicalizeAnalysisCriterionPromotionSupports,
  decideAnalysisCriterionPromotionCommand
} from "../src/lib/analysis-promotion.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
const D5 = `sha256:${"5".repeat(64)}`;
const AT = "2026-08-23T10:11:12.000Z";

function supportInput(observationEventId: string, ordinal: number) {
  return {
    studyItemId: `study_item_${ordinal}`,
    closureItemId: `closure_item_${ordinal}`,
    closureItemDigest: D1,
    observationEventId,
    observationEventDigest: D2,
    assignmentEventId: `assignment_${ordinal}`,
    assignmentEventDigest: D3
  };
}

function createInput(): AnalysisCriterionPromotionCreateInput {
  return {
    studyId: "study_1",
    expectedClosureId: "closure_1",
    expectedClosureDigest: D1,
    taxonomyId: "taxonomy_1",
    taxonomyRevisionId: "taxonomy_revision_3",
    expectedTaxonomyRevisionDigest: D2,
    codeId: "failure_code_1",
    expectedCodeEntryDigest: D3,
    criterionName: "Incorrect refund guidance",
    criterionDefinition: "The response must state the exact applicable refund window.",
    rationale: "This recurring failure has exact closed-study support.",
    supportingObservations: [supportInput("observation_z", 2), supportInput("observation_a", 1)],
    idempotencyKey: "promotion-command-1"
  };
}

function supportArtifact(
  observationEventId: string,
  ordinal: number,
  position: number,
  sourceItemDigest = D4
): AnalysisCriterionPromotionSupportArtifact {
  const content = {
    promotionId: "promotion_1",
    position,
    studyId: "study_1",
    studyItemId: `study_item_${ordinal}`,
    closureId: "closure_1",
    closureItemId: `closure_item_${ordinal}`,
    closureItemDigest: D1,
    sourceDatasetRevisionId: "analysis_revision_1",
    sourceDatasetRevisionItemId: `revision_item_${ordinal}`,
    sourceItemDigest,
    observationEventId,
    observationEventDigest: D2,
    assignmentEventId: `assignment_${ordinal}`,
    assignmentEventDigest: D3,
    observationAuthorSubjectId: `subject_author_${ordinal}`,
    exampleSelectionExposureEventId: `exposure_support_${ordinal}`
  };
  return {
    id: `promotion_support_${ordinal}`,
    projectId: "project_1",
    ...content,
    contentDigest: analysisCriterionPromotionSupportContentDigest(content),
    createdAt: AT
  };
}

function promotionBundle() {
  const supports = [
    supportArtifact("observation_a", 1, 0),
    supportArtifact("observation_z", 2, 1)
  ];
  const supportSetDigest = analysisCriterionPromotionSupportSetDigest("promotion_1", supports);
  const handoffWithoutDigest: Omit<AnalysisCriterionPromotionHandoff, "handoffDigest"> = {
    handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    promotionId: "promotion_1",
    projectId: "project_1",
    criterionId: "criterion_1",
    criterionVersionId: "criterion_version_1",
    criterionDigest: D5,
    sourceDatasetRevisionId: "analysis_revision_1",
    sourceDatasetRevisionContentDigest: D3,
    sourceDatasetRevisionDigest: D4,
    roleIntent: "analysis_authoring",
    sourceKind: "analysis_promotion_handoff",
    evidenceClass: "development_authoring_not_truth",
    createsTruth: false,
    createsEvaluator: false
  };
  const handoff: AnalysisCriterionPromotionHandoff = {
    ...handoffWithoutDigest,
    handoffDigest: analysisCriterionPromotionHandoffDigest(handoffWithoutDigest)
  };
  const promotionContent = {
    contractVersion: ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
    projectId: "project_1",
    studyId: "study_1",
    studyClosureId: "closure_1",
    studyClosureDigest: D1,
    populationId: "population_1",
    drawId: "draw_1",
    sourceDatasetRevisionId: "analysis_revision_1",
    sourceDatasetRevisionContentDigest: D3,
    sourceDatasetRevisionDigest: D4,
    taxonomyId: "taxonomy_1",
    taxonomyRevisionId: "taxonomy_revision_3",
    taxonomyRevisionSequence: 3,
    taxonomyRevisionDigest: D2,
    codeId: "failure_code_1",
    codeEntryId: "code_entry_1",
    codeEntryDigest: D3,
    codeLabel: "Incorrect refund guidance",
    codeDefinition: "The response gives a refund window that does not apply.",
    criterionId: "criterion_1",
    criterionVersionId: "criterion_version_1",
    criterionStableKey: analysisCriterionPromotionStableKey("failure_code_1"),
    criterionName: "Incorrect refund guidance",
    criterionDefinition: "The response must state the exact applicable refund window.",
    criterionDigest: D5,
    rationale: "This recurring failure has exact closed-study support.",
    supportCount: supports.length,
    supportSetDigest,
    criterionAuthoringExposureEventId: "exposure_authoring_1",
    promotedBySubjectId: "subject_owner",
    handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    handoffDigest: handoff.handoffDigest
  } as const;
  const promotion: AnalysisCriterionPromotionArtifact = {
    id: "promotion_1",
    ...promotionContent,
    promotedByUserId: "user_owner",
    promoterRole: "owner",
    idempotencyKey: "promotion-command-1",
    requestDigest: analysisCriterionPromotionRequestDigest("project_1", createInput()),
    contentDigest: analysisCriterionPromotionContentDigest(promotionContent),
    createdAt: AT
  };
  const criterion = {
    id: promotion.criterionId,
    projectId: promotion.projectId,
    stableKey: promotion.criterionStableKey,
    sourceKind: "analysis_promotion" as const,
    createdByUserId: promotion.promotedByUserId,
    createdAt: AT
  };
  const criterionVersion = {
    id: promotion.criterionVersionId,
    projectId: promotion.projectId,
    criterionId: promotion.criterionId,
    revision: 1,
    name: promotion.criterionName,
    definition: promotion.criterionDefinition,
    criterionDigest: promotion.criterionDigest,
    sourceKind: "analysis_promotion" as const,
    createdByUserId: promotion.promotedByUserId,
    createdAt: AT
  };
  return { promotion, criterion, criterionVersion, handoff, supports };
}

describe("analysis criterion promotion pure contract", () => {
  it("freezes strict bounded create input and distinct observation identities", () => {
    const input = createInput();
    expect(AnalysisCriterionPromotionCreateInputSchema.parse(input)).toEqual(input);
    expect(AnalysisCriterionPromotionCreateInputSchema.safeParse({ ...input, unknown: true }).success).toBe(false);
    expect(AnalysisCriterionPromotionCreateInputSchema.safeParse({ ...input, criterionName: " padded " }).success).toBe(false);
    expect(AnalysisCriterionPromotionCreateInputSchema.safeParse({
      ...input,
      supportingObservations: [input.supportingObservations[0], input.supportingObservations[0]]
    }).success).toBe(false);
    expect(AnalysisCriterionPromotionCreateInputSchema.safeParse({
      ...input,
      supportingObservations: Array.from(
        { length: ANALYSIS_MAX_PROMOTION_SUPPORTS + 1 },
        (_, index) => supportInput(`observation_${index}`, index)
      )
    }).success).toBe(false);
    expect(CriterionSourceKindSchema.parse("analysis_promotion")).toBe("analysis_promotion");
  });

  it("canonicalizes support-set request semantics and locks the request golden", () => {
    const input = createInput();
    const canonical = canonicalizeAnalysisCriterionPromotionSupports(input.supportingObservations);
    expect(canonical.map((support) => support.observationEventId)).toEqual(["observation_a", "observation_z"]);
    const digest = analysisCriterionPromotionRequestDigest("project_1", input);
    const reversed = analysisCriterionPromotionRequestDigest("project_1", {
      ...input,
      supportingObservations: [...input.supportingObservations].reverse(),
      idempotencyKey: "a-different-retry-key"
    });
    expect(digest).toBe(reversed);
    expect(digest).toBe("sha256:e8f103cf0041ea974c114abc305148b5f8ee5b4629dc9472e5afd545242b73d2");
    expect(ANALYSIS_CRITERION_PROMOTION_REQUEST_DIGEST_BASIS).toBe("analysis-criterion-promotion-request/v1");
  });

  it("binds duplicate payloads to distinct supporting observation identities", () => {
    const first = supportArtifact("observation_a", 1, 0, D4);
    const second = supportArtifact("observation_b", 2, 1, D4);
    expect(first.sourceItemDigest).toBe(second.sourceItemDigest);
    expect(first.contentDigest).not.toBe(second.contentDigest);
    expect(analysisCriterionPromotionSupportSetDigest("promotion_1", [second, first]))
      .toBe(analysisCriterionPromotionSupportSetDigest("promotion_1", [first, second]));
    expect(() => analysisCriterionPromotionSupportSetDigest("promotion_1", [first, { ...second, position: 0 }]))
      .toThrow("contiguous");
  });

  it("locks support, handoff, support-set, and promotion-content golden vectors", () => {
    const bundle = promotionBundle();
    expect(bundle.supports[0]!.contentDigest).toBe("sha256:e5992131761953c1a42e4a768ca04b3ea6df6813abd3c8e1d5ed8131964a0faa");
    expect(bundle.promotion.supportSetDigest).toBe("sha256:5b93dcdfff326e1e59a2fc0567b9f2ae1906df5ee6ae20e9ab98e3f54654b473");
    expect(bundle.handoff.handoffDigest).toBe("sha256:5182e2d51fe6355e77689689bfc5e8ff43eca9d5e437d0766be7962e88a9913e");
    expect(bundle.promotion.contentDigest).toBe("sha256:c0a4c6810773c06e15dff9aa587d354054f89d6408e749e85551a5dde040a77d");
    expect(ANALYSIS_CRITERION_PROMOTION_SUPPORT_DIGEST_BASIS).toBe("analysis-criterion-promotion-support/v1");
    expect(ANALYSIS_CRITERION_PROMOTION_SUPPORT_SET_DIGEST_BASIS).toBe("analysis-criterion-promotion-support-set/v1");
    expect(ANALYSIS_CRITERION_PROMOTION_HANDOFF_DIGEST_BASIS).toBe("analysis-criterion-promotion-handoff/v1");
    expect(ANALYSIS_CRITERION_PROMOTION_CONTENT_DIGEST_BASIS).toBe("analysis-criterion-promotion-content/v1");
  });

  it("cross-binds criterion, version, handoff, supports, and exposure identities", () => {
    const bundle = promotionBundle();
    const valid = { ...bundle, replayed: false };
    expect(AnalysisCriterionPromotionCreateResultSchema.parse(valid)).toEqual(valid);
    expect(AnalysisCriterionPromotionArtifactSchema.parse(bundle.promotion)).toEqual(bundle.promotion);
    expect(AnalysisCriterionPromotionHandoffSchema.parse(bundle.handoff)).toEqual(bundle.handoff);
    expect(AnalysisCriterionPromotionCreateResultSchema.safeParse({
      ...valid,
      criterionVersion: { ...bundle.criterionVersion, id: "swapped_version" }
    }).success).toBe(false);
    expect(AnalysisCriterionPromotionCreateResultSchema.safeParse({
      ...valid,
      criterion: { ...bundle.criterion, createdByUserId: "swapped_user" }
    }).success).toBe(false);
    expect(AnalysisCriterionPromotionCreateResultSchema.safeParse({
      ...valid,
      supports: [{ ...bundle.supports[0]!, createdAt: "2026-08-23T10:11:13.000Z" }, bundle.supports[1]!]
    }).success).toBe(false);
    expect(AnalysisCriterionPromotionCreateResultSchema.safeParse({
      ...valid,
      supports: [bundle.supports[0]!, {
        ...bundle.supports[1]!,
        exampleSelectionExposureEventId: bundle.supports[0]!.exampleSelectionExposureEventId
      }]
    }).success).toBe(false);
    expect(AnalysisCriterionPromotionCreateResultSchema.safeParse({
      ...valid,
      handoff: { ...bundle.handoff, sourceDatasetRevisionId: "swapped_revision" }
    }).success).toBe(false);
  });

  it("rejects duplicate candidate observations within a page", () => {
    const candidate = {
      projectId: "project_1", studyId: "study_1", studyState: "coding_closed" as const,
      closureId: "closure_1", closureDigest: D1,
      taxonomyId: "taxonomy_1", taxonomyRevisionId: "taxonomy_revision_3",
      taxonomyRevisionSequence: 3, taxonomyRevisionDigest: D2,
      codeId: "failure_code_1", codeEntryId: "code_entry_1", codeEntryDigest: D3,
      codeLabel: "Incorrect refund guidance", codeDefinition: "Incorrect window.", codeStatus: "active" as const,
      studyItemId: "study_item_1", closureItemId: "closure_item_1", closureItemDigest: D1, position: 0,
      sourceDatasetRevisionId: "analysis_revision_1", sourceDatasetRevisionItemId: "revision_item_1",
      sourceItemDigest: D4, observationEventId: "observation_1", observationEventDigest: D2,
      failureLabel: "Incorrect refund guidance", observationRationale: "Observed in the output.",
      evidenceAnchor: { kind: "case_output" as const }, assignmentEventId: "assignment_1",
      assignmentEventDigest: D3, assignmentRationale: "Matches the active code.",
      observationAuthorSubjectId: "subject_author_1"
    };
    expect(AnalysisCriterionPromotionCandidatesPageSchema.safeParse({
      items: [candidate, { ...candidate, studyItemId: "study_item_2" }],
      totalCount: "2", nextCursor: null
    }).success).toBe(false);
  });

  it("enforces exact stable-key and no-alias command semantics", () => {
    expect(analysisCriterionPromotionStableKey("failure_code_1")).toBe("analysis-failure-code:failure_code_1");
    expect(() => analysisCriterionPromotionStableKey("x".repeat(200))).toThrow("exceeds");
    expect(decideAnalysisCriterionPromotionCommand({
      idempotencyKey: "key-1", requestDigest: D1,
      existingByIdempotencyKey: null, existingForCode: null
    })).toEqual({ kind: "create" });
    expect(decideAnalysisCriterionPromotionCommand({
      idempotencyKey: "key-1", requestDigest: D1,
      existingByIdempotencyKey: { promotionId: "promotion_1", idempotencyKey: "key-1", requestDigest: D1 },
      existingForCode: { promotionId: "promotion_1", idempotencyKey: "key-1", requestDigest: D1 }
    })).toEqual({ kind: "replay", promotionId: "promotion_1" });
    expect(decideAnalysisCriterionPromotionCommand({
      idempotencyKey: "key-1", requestDigest: D2,
      existingByIdempotencyKey: { promotionId: "promotion_1", idempotencyKey: "key-1", requestDigest: D1 },
      existingForCode: null
    })).toEqual({ kind: "conflict", code: "analysis_promotion_idempotency_conflict" });
    expect(decideAnalysisCriterionPromotionCommand({
      idempotencyKey: "key-2", requestDigest: D1,
      existingByIdempotencyKey: null,
      existingForCode: { promotionId: "promotion_1", idempotencyKey: "key-1", requestDigest: D1 }
    })).toEqual({ kind: "conflict", code: "analysis_promotion_code_already_promoted" });
  });
});
