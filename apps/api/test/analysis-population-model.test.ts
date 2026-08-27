import { describe, expect, it } from "vitest";
import {
  ANALYSIS_POPULATION_API_PAGE_MAX,
  ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
  ANALYSIS_POPULATION_CURSOR_MAX_LENGTH,
  ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
  ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
  ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
  ANALYSIS_POPULATION_MAX_FIXED_BUDGET,
  ANALYSIS_POPULATION_MAX_MEMBERS,
  ANALYSIS_POPULATION_MAX_SNAPSHOT_XID8_BYTES,
  ANALYSIS_POPULATION_ORDERING_VERSION,
  ANALYSIS_POPULATION_RNG_VERSION,
  AnalysisPopulationClaimSchema,
  AnalysisPopulationCreateInputSchema,
  AnalysisPopulationCreateResultSchema,
  AnalysisPopulationDetailSchema,
  AnalysisPopulationDrawSchema,
  AnalysisPopulationDrawSummarySchema,
  AnalysisPopulationExclusionSchema,
  AnalysisPopulationExclusionsPageSchema,
  AnalysisPopulationMemberSchema,
  AnalysisPopulationSchema,
  AnalysisPopulationSummarySchema,
  AnalysisPopulationSelectedItemsPageSchema,
  DatasetRevisionSourceKindSchema
} from "@coeval/shared";
import {
  ANALYSIS_POPULATION_CONTENT_DIGEST_BASIS,
  ANALYSIS_POPULATION_DRAW_CONTENT_DIGEST_BASIS,
  ANALYSIS_POPULATION_DRAW_ITEM_DIGEST_BASIS,
  ANALYSIS_POPULATION_EXCLUSION_DIGEST_BASIS,
  ANALYSIS_POPULATION_FRAME_DIGEST_BASIS,
  ANALYSIS_POPULATION_FRAME_MEMBER_DIGEST_BASIS,
  ANALYSIS_POPULATION_INPUT_IDENTITY_BASIS,
  ANALYSIS_POPULATION_ITEM_DIGEST_BASIS,
  ANALYSIS_POPULATION_MEMBER_LINEAGE_DIGEST_BASIS,
  ANALYSIS_POPULATION_RANK_DIGEST_BASIS,
  ANALYSIS_POPULATION_REFERENCE_BASIS,
  ANALYSIS_POPULATION_REQUEST_DIGEST_BASIS,
  AnalysisPopulationBoundError,
  analysisPopulationClaim,
  analysisPopulationContentDigest,
  analysisPopulationDrawContentDigest,
  analysisPopulationDrawDigest,
  analysisPopulationDrawItemContentDigest,
  analysisPopulationExclusionDigest,
  analysisPopulationFrameDigest,
  analysisPopulationFrameMemberDigest,
  analysisPopulationInclusionProbability,
  analysisPopulationItemDigest,
  analysisPopulationMemberLineageDigest,
  analysisPopulationRankDigest,
  analysisPopulationRequestDigest,
  assertAnalysisPopulationDrawBounds,
  assertAnalysisPopulationWindow,
  compareAnalysisPopulationRanks,
  decideAnalysisPopulationFrameReuse,
  drawAnalysisPopulationSample,
  normalizeAnalysisPopulationTimestamp,
  orderAnalysisPopulationCandidates,
  type AnalysisPopulationRankableMember
} from "../src/lib/analysis-population.js";
import { datasetInputIdentity, decidePublicDatasetRevisionCreation } from "../src/lib/dataset-revision.js";

const DIGEST_A = `sha256:${"1".repeat(64)}`;
const DIGEST_B = `sha256:${"2".repeat(64)}`;
const DIGEST_C = `sha256:${"3".repeat(64)}`;
const SEED = "00".repeat(32);
const WINDOW_START = "2026-08-01T00:00:00.000Z";
const WINDOW_END = "2026-08-02T00:00:00.000Z";

function populationItem(caseId: string, position: number, ingestionTime = "2026-08-01T12:00:00.000Z") {
  const inputIdentity = datasetInputIdentity({ input: { question: "Refund?", tenant: 7 } });
  const itemDigest = analysisPopulationItemDigest({
    caseId,
    inputIdentity,
    payloadSnapshot: {
      input: { question: "Refund?", tenant: "[REDACTED]" },
      output: { answer: "Within 30 days." },
      metadata: { provider: "fixture" }
    }
  });
  const frameMemberDigest = analysisPopulationFrameMemberDigest({
    caseId,
    inputDigest: inputIdentity.digest,
    itemDigest,
    ingestionTime,
    position
  });
  return { caseId, inputIdentity, itemDigest, frameMemberDigest, ingestionTime, position };
}

function rankable(caseId: string, position: number): AnalysisPopulationRankableMember {
  const item = populationItem(caseId, position);
  return {
    memberId: `apm_${caseId}`,
    revisionItemId: `dsri_${caseId}`,
    caseId,
    frameMemberDigest: item.frameMemberDigest
  };
}

function populationSummaryFixture() {
  const population = {
    id: "ap_1", projectId: "proj_1", datasetRevisionId: "dsr_1",
    windowStart: WINDOW_START, windowEnd: WINDOW_END,
    eligibleSources: ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
    eligibleIngestionPurposes: ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
    canonicalizationVersion: ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
    orderingVersion: ANALYSIS_POPULATION_ORDERING_VERSION,
    populationSize: 2, exclusionCount: "0", frameDigest: DIGEST_A, contentDigest: DIGEST_B,
    snapshotXid8: "1:2:", snapshotTakenAt: WINDOW_END,
    createdByUserId: "user_1", createdBySubjectId: "subject_1", createdAt: WINDOW_END
  } as const;
  const draw = {
    id: "apd_1", projectId: "proj_1", populationId: "ap_1", datasetRevisionId: "dsr_1",
    method: "simple_random", stoppingRule: "fixed", drawExecutor: "coeval_server",
    seed: SEED, rngVersion: ANALYSIS_POPULATION_RNG_VERSION,
    algorithmVersion: ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
    fixedBudget: 1, populationSize: 2, inclusionProbability: { numerator: 1, denominator: 2 },
    drawDigest: DIGEST_A, contentDigest: DIGEST_B, executedBySubjectId: "subject_1", executedAt: WINDOW_END
  } as const;
  return {
    population,
    draw,
    claim: analysisPopulationClaim(population.id)
  };
}

describe("analysis population strict contracts", () => {
  it("accepts only the four bounded caller fields and fixes the server-owned vocabulary", () => {
    expect(AnalysisPopulationCreateInputSchema.parse({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      fixedBudget: 100,
      idempotencyKey: "retry-1"
    })).toEqual({ windowStart: WINDOW_START, windowEnd: WINDOW_END, fixedBudget: 100, idempotencyKey: "retry-1" });
    expect(AnalysisPopulationCreateInputSchema.safeParse({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      fixedBudget: 100,
      idempotencyKey: "retry-1",
      seed: SEED
    }).success).toBe(false);
    expect(AnalysisPopulationCreateInputSchema.safeParse({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      fixedBudget: 100,
      idempotencyKey: " retry-1 "
    }).success).toBe(false);
    expect(AnalysisPopulationCreateInputSchema.parse({
      windowStart: "2026-08-01T00:00:00.0009Z",
      windowEnd: "2026-08-02T02:00:00.0001+02:00",
      fixedBudget: 100,
      idempotencyKey: "retry-sub-ms"
    })).toMatchObject({
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-02T00:00:00.000Z"
    });
    expect(AnalysisPopulationCreateInputSchema.safeParse({
      windowStart: WINDOW_END,
      windowEnd: WINDOW_START,
      fixedBudget: 100,
      idempotencyKey: "retry-1"
    }).success).toBe(false);
    expect(ANALYSIS_POPULATION_ELIGIBLE_SOURCES).toEqual(["manual", "langsmith", "langfuse", "ironside"]);
    expect(ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES).toEqual([
      "analysis_eligible_manual",
      "analysis_eligible_langsmith",
      "analysis_eligible_langfuse",
      "analysis_eligible_ironside"
    ]);
    expect(ANALYSIS_POPULATION_CANONICALIZATION_VERSION).toBe("governed-content-json/v1");
    expect(ANALYSIS_POPULATION_ORDERING_VERSION).toBe("cases-created-at-id/v1");
    expect(ANALYSIS_POPULATION_RNG_VERSION).toBe("sha256-rank/v1");
    expect(ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION).toBe("coeval-analysis-draw/v1");
  });

  it("adds the internal analysis source kind without opening public source-kind selection", () => {
    expect(DatasetRevisionSourceKindSchema.parse("analysis_population")).toBe("analysis_population");
    expect(decidePublicDatasetRevisionCreation("analysis_authoring"))
      .toEqual({ allowed: true, code: "allowed_public_nonsealed_creation" });
    expect(decidePublicDatasetRevisionCreation("analysis_population"))
      .toEqual({ allowed: false, code: "rejected_unknown_role" });
  });

  it("keeps list/detail projections bounded and never embeds every selected or excluded row", () => {
    const claim = analysisPopulationClaim("ap_1");
    expect(AnalysisPopulationClaimSchema.parse(claim)).toEqual({
      drawnFromPopulationId: "ap_1",
      representativeOfPopulationId: null,
      representativeReason: "coding_not_complete"
    });
    expect(AnalysisPopulationDetailSchema.keyof().options).toEqual([
      "population", "draw", "claim", "overlapCount"
    ]);
    expect(AnalysisPopulationDrawSummarySchema.keyof().options).not.toContain("selections");
    expect(AnalysisPopulationExclusionsPageSchema.safeParse({
      items: [], totalCount: "0", nextCursor: "x".repeat(ANALYSIS_POPULATION_CURSOR_MAX_LENGTH + 1)
    }).success).toBe(false);
  });

  it("binds every summary and create-reuse flag to one exact population and draw", () => {
    const summary = populationSummaryFixture();
    expect(AnalysisPopulationSummarySchema.safeParse(summary).success).toBe(true);
    expect(AnalysisPopulationSummarySchema.safeParse({
      ...summary,
      draw: { ...summary.draw, populationId: "ap_other" }
    }).success).toBe(false);
    expect(AnalysisPopulationSummarySchema.safeParse({
      ...summary,
      claim: analysisPopulationClaim("ap_other")
    }).success).toBe(false);
    expect(AnalysisPopulationCreateResultSchema.safeParse({
      ...summary,
      reusedPopulation: true,
      reusedDraw: false
    }).success).toBe(false);
  });

  it("accepts a long PostgreSQL snapshot projection up to the migration byte bound", () => {
    const snapshot = `1:20000:${Array.from({ length: 4_000 }, (_, index) => index + 2).join(",")}`;
    expect(snapshot.length).toBeGreaterThan(10_000);
    expect(AnalysisPopulationSchema.shape.snapshotXid8.parse(snapshot)).toBe(snapshot);
    const oversizedSnapshot = `1:2:${"3,".repeat(Math.ceil(ANALYSIS_POPULATION_MAX_SNAPSHOT_XID8_BYTES / 2))}3`;
    expect(AnalysisPopulationSchema.shape.snapshotXid8.safeParse(oversizedSnapshot).success).toBe(false);
  });

  it("models every explicit ineligible case shape without capping exclusion positions at eligible N", () => {
    const common = {
      id: "ape_1",
      projectId: "proj_1",
      populationId: "ap_1",
      caseId: "case_1",
      position: String(ANALYSIS_POPULATION_MAX_MEMBERS + 25),
      ingestionTime: "2026-08-01T12:00:00.000Z",
      reason: "ineligible_ingestion_purpose" as const,
      contentDigest: DIGEST_A,
      createdAt: "2026-08-03T00:00:00.000Z"
    };
    expect(AnalysisPopulationExclusionSchema.safeParse({
      ...common,
      rawTraceId: "raw_1",
      sourceTraceId: "source-with-no-artificial-length-cap",
      caseType: "manual",
      ingestionPurpose: "judge_api"
    }).success).toBe(true);
    expect(AnalysisPopulationExclusionSchema.safeParse({
      ...common,
      rawTraceId: null,
      sourceTraceId: null,
      caseType: "release_evidence",
      ingestionPurpose: "release_evidence"
    }).success).toBe(true);
    expect(AnalysisPopulationExclusionSchema.safeParse({
      ...common,
      rawTraceId: null,
      sourceTraceId: null,
      caseType: "manual",
      ingestionPurpose: "release_evidence"
    }).success).toBe(false);
    expect(AnalysisPopulationExclusionsPageSchema.safeParse({
      items: Array.from({ length: ANALYSIS_POPULATION_API_PAGE_MAX + 1 }, () => ({
        ...common,
        rawTraceId: "raw_1",
        sourceTraceId: "source_1",
        caseType: "manual",
        ingestionPurpose: "judge_api"
      })),
      totalCount: String(ANALYSIS_POPULATION_MAX_MEMBERS + 50_000),
      nextCursor: null
    }).success).toBe(false);
  });

  it("fails closed on an eligible member whose source and purpose disagree", () => {
    const member = {
      id: "apm_1",
      projectId: "proj_1",
      populationId: "ap_1",
      revisionItemId: "dsri_1",
      caseId: "case_1",
      caseType: "manual",
      ingestionPurpose: "analysis_eligible_langsmith",
      position: 0,
      ingestionTime: WINDOW_START,
      inputDigest: DIGEST_A,
      itemDigest: DIGEST_B,
      frameMemberDigest: DIGEST_C,
      lineageDigest: DIGEST_A,
      createdAt: WINDOW_END
    };
    expect(AnalysisPopulationMemberSchema.safeParse(member).success).toBe(false);
    expect(AnalysisPopulationMemberSchema.safeParse({
      ...member,
      ingestionPurpose: "analysis_eligible_manual"
    }).success).toBe(true);
  });
});

describe("analysis population canonical digests", () => {
  it("freezes every versioned basis and a full golden vector", () => {
    expect({
      request: ANALYSIS_POPULATION_REQUEST_DIGEST_BASIS,
      item: ANALYSIS_POPULATION_ITEM_DIGEST_BASIS,
      input: ANALYSIS_POPULATION_INPUT_IDENTITY_BASIS,
      frameMember: ANALYSIS_POPULATION_FRAME_MEMBER_DIGEST_BASIS,
      lineage: ANALYSIS_POPULATION_MEMBER_LINEAGE_DIGEST_BASIS,
      exclusion: ANALYSIS_POPULATION_EXCLUSION_DIGEST_BASIS,
      content: ANALYSIS_POPULATION_CONTENT_DIGEST_BASIS,
      frame: ANALYSIS_POPULATION_FRAME_DIGEST_BASIS,
      rank: ANALYSIS_POPULATION_RANK_DIGEST_BASIS,
      drawItem: ANALYSIS_POPULATION_DRAW_ITEM_DIGEST_BASIS,
      drawContent: ANALYSIS_POPULATION_DRAW_CONTENT_DIGEST_BASIS,
      draw: ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
      reference: ANALYSIS_POPULATION_REFERENCE_BASIS
    }).toEqual({
      request: "analysis-population-request/v1",
      item: "dataset-revision-item/v1",
      input: "input-identity/v1",
      frameMember: "analysis-population-frame-member/v1",
      lineage: "analysis-population-member/v1",
      exclusion: "analysis-population-exclusion/v1",
      content: "analysis-population-content/v1",
      frame: "analysis-population-frame/v1",
      rank: "coeval-analysis-rank/v1",
      drawItem: "analysis-population-draw-item/v1",
      drawContent: "analysis-population-draw-content/v1",
      draw: "coeval-analysis-draw/v1",
      reference: "Analysis population member; no reference label."
    });

    const item = populationItem("case_alpha", 0);
    const lineageDigest = analysisPopulationMemberLineageDigest({
      caseId: item.caseId,
      revisionItemId: "dsri_alpha",
      inputDigest: item.inputIdentity.digest,
      itemDigest: item.itemDigest,
      ingestionTime: item.ingestionTime,
      position: 0
    });
    const requestDigest = analysisPopulationRequestDigest({
      projectId: "proj_1",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      fixedBudget: 2
    });
    const frameDigest = analysisPopulationFrameDigest({
      projectId: "proj_1",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      frameMemberDigests: [item.frameMemberDigest]
    });
    const exclusionDigest = analysisPopulationExclusionDigest({
      caseId: "case_release",
      rawTraceId: null,
      sourceTraceId: null,
      caseType: "release_evidence",
      ingestionPurpose: "release_evidence",
      ingestionTime: item.ingestionTime,
      position: "0",
      reason: "ineligible_ingestion_purpose"
    });

    expect({
      inputDigest: item.inputIdentity.digest,
      itemDigest: item.itemDigest,
      frameMemberDigest: item.frameMemberDigest,
      lineageDigest,
      requestDigest,
      frameDigest,
      exclusionDigest
    }).toEqual({
      inputDigest: "sha256:8b7899cf1a706e5940609193e9fb77c34f07de81a06867a35cdf0175eed1f2c4",
      itemDigest: "sha256:79a5d0e22a0298e2beecd0ecc23626e9302a565547eec649000e5e5d9e9bf12c",
      frameMemberDigest: "sha256:69df3af75ecc198d7b5cea58deb6e28fb133805e205148ae63bb0a04279cabc9",
      lineageDigest: "sha256:0c8299f40b5d7bc4471004dc7701f1c44d75b38e35fa4f5dc918b2ff085544df",
      requestDigest: "sha256:810118ffaa0ad691313fc932c940c332436bd9b03bb4ca01fa39a15ef429a54d",
      frameDigest: "sha256:f0c731ee5d21fbca142a5db8c4226437de24d02377fa6b274b62c4666f5edd7a",
      exclusionDigest: "sha256:b79452e044f18177f0e1d04a00a0b33ceab1f602d97b0d8afaa9e57a8d6772cd"
    });
  });

  it("normalizes timestamp offsets but preserves ordered members and duplicate item evidence", () => {
    expect(normalizeAnalysisPopulationTimestamp("2026-08-01T00:00:00.0001Z"))
      .toBe("2026-08-01T00:00:00.000Z");
    expect(normalizeAnalysisPopulationTimestamp("2026-08-01T00:00:00.0009Z"))
      .toBe("2026-08-01T00:00:00.000Z");
    const first = analysisPopulationFrameMemberDigest({
      caseId: "case_1", inputDigest: DIGEST_A, itemDigest: DIGEST_B,
      ingestionTime: "2026-08-01T14:00:00+02:00", position: 0
    });
    const sameInstant = analysisPopulationFrameMemberDigest({
      caseId: "case_1", inputDigest: DIGEST_A, itemDigest: DIGEST_B,
      ingestionTime: "2026-08-01T12:00:00Z", position: 0
    });
    expect(first).toBe(sameInstant);
    expect(analysisPopulationContentDigest([DIGEST_A, DIGEST_B])).not.toBe(
      analysisPopulationContentDigest([DIGEST_B, DIGEST_A])
    );
    expect(analysisPopulationContentDigest([DIGEST_A, DIGEST_A])).not.toBe(
      analysisPopulationContentDigest([DIGEST_A])
    );
  });

  it("rejects raw/non-JSON evidence instead of hashing a normalized or stripped substitute", () => {
    const inputIdentity = datasetInputIdentity({ input: { q: 1 } });
    expect(() => analysisPopulationItemDigest({
      caseId: "case_1",
      inputIdentity,
      payloadSnapshot: {
        input: { q: 1 }, output: { a: 1 }, metadata: { missing: undefined }
      }
    })).toThrow(/cannot encode undefined/);
    expect(() => analysisPopulationFrameMemberDigest({
      caseId: "bad\u0000case",
      inputDigest: DIGEST_A,
      itemDigest: DIGEST_B,
      ingestionTime: WINDOW_START,
      position: 0
    })).toThrow(/cannot encode NUL/);
    expect(() => analysisPopulationRankDigest({
      seed: "AB".repeat(32), caseId: "case_1", frameMemberDigest: DIGEST_A
    })).toThrow(/lowercase-hex/);
  });

  it("keeps revision lineage out of frame identity and fixedBudget out of frame digest", () => {
    const member = populationItem("case_1", 0);
    const frame = analysisPopulationFrameDigest({
      projectId: "proj_1", windowStart: WINDOW_START, windowEnd: WINDOW_END,
      frameMemberDigests: [member.frameMemberDigest]
    });
    const changedRevision = analysisPopulationMemberLineageDigest({
      caseId: member.caseId,
      revisionItemId: "dsri_other",
      inputDigest: member.inputIdentity.digest,
      itemDigest: member.itemDigest,
      ingestionTime: member.ingestionTime,
      position: member.position
    });
    expect(changedRevision).not.toBe(member.frameMemberDigest);
    expect(frame).toBe(analysisPopulationFrameDigest({
      projectId: "proj_1", windowStart: WINDOW_START, windowEnd: WINDOW_END,
      frameMemberDigests: [member.frameMemberDigest]
    }));
    expect(analysisPopulationRequestDigest({
      projectId: "proj_1", windowStart: WINDOW_START, windowEnd: WINDOW_END, fixedBudget: 1
    })).not.toBe(analysisPopulationRequestDigest({
      projectId: "proj_1", windowStart: WINDOW_START, windowEnd: WINDOW_END, fixedBudget: 2
    }));
    expect(decideAnalysisPopulationFrameReuse(2, 2)).toEqual({ kind: "reuse" });
    expect(decideAnalysisPopulationFrameReuse(2, 3)).toEqual({
      kind: "conflict",
      code: "analysis_population_draw_conflict",
      existingFixedBudget: 2,
      requestedFixedBudget: 3
    });
  });
});

describe("sha256-rank/v1 server draw", () => {
  it("orders the frame by ingestion time then case id in code-unit order", () => {
    const candidates = [
      { caseId: "case_b", ingestionTime: "2026-08-01T12:00:00Z" },
      { caseId: "case_a", ingestionTime: "2026-08-01T14:00:00+02:00" },
      { caseId: "case_earlier", ingestionTime: "2026-08-01T11:59:59Z" }
    ];
    expect(orderAnalysisPopulationCandidates(candidates).map((item) => item.caseId))
      .toEqual(["case_earlier", "case_a", "case_b"]);

    const subMillisecond = [
      { caseId: "case_a", ingestionTime: "2026-08-01T12:00:00.0009Z" },
      { caseId: "case_z", ingestionTime: "2026-08-01T14:00:00.0001+02:00" }
    ];
    expect(orderAnalysisPopulationCandidates(subMillisecond).map((item) => item.caseId))
      .toEqual(["case_z", "case_a"]);
  });

  it("uses the exact rank, deterministic tie-break, K/N, and golden draw vector", () => {
    const members = [rankable("case_alpha", 0), rankable("case_beta", 1), rankable("case_gamma", 2)];
    const frameDigest = analysisPopulationFrameDigest({
      projectId: "proj_1",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      frameMemberDigests: members.map((member) => member.frameMemberDigest)
    });
    const draw = drawAnalysisPopulationSample({
      populationId: "ap_1",
      datasetRevisionId: "dsr_1",
      frameDigest,
      seed: SEED,
      fixedBudget: 2,
      members
    });
    expect(draw.inclusionProbability).toEqual({ numerator: 2, denominator: 3 });
    expect(draw.selections.map(({ caseId, rankDigest, contentDigest, position }) => ({
      caseId, rankDigest, contentDigest, position
    }))).toEqual([
      {
        caseId: "case_alpha",
        rankDigest: "sha256:1756367608de1ef15a1085d9955a47c2770817a9ad24203a35bb67d405183554",
        contentDigest: "sha256:2999546342e814f990c28551e52e77625a5658bf9ecdcb36fa80ef3e8e0a34fa",
        position: 0
      },
      {
        caseId: "case_beta",
        rankDigest: "sha256:b5d790139689bac510f844fc5cd828bc472c97beac303749866f9394f71de819",
        contentDigest: "sha256:20e24c8ff3f88657033f9d7922b5079c28c56baa59c9b74d98d0993787cd167e",
        position: 1
      }
    ]);
    expect(draw.contentDigest).toBe("sha256:d721c0410ad760f7f91103ab7936b09767cc4474e5eaf88f1fd6d7a7dc492200");
    expect(draw.drawDigest).toBe("sha256:d2541a6d63f50d2d4c3df44a3f4d9c46dbb75d445f2a2f6baf776d41eb9ea502");
    expect(drawAnalysisPopulationSample({
      populationId: "ap_1",
      datasetRevisionId: "dsr_1",
      frameDigest,
      seed: SEED,
      fixedBudget: 2,
      members: [...members].reverse()
    })).toEqual(draw);

    const tied = [
      { rankDigest: DIGEST_A, frameMemberDigest: DIGEST_C, caseId: "case_a" },
      { rankDigest: DIGEST_A, frameMemberDigest: DIGEST_B, caseId: "case_z" },
      { rankDigest: DIGEST_A, frameMemberDigest: DIGEST_B, caseId: "case_a" }
    ].sort(compareAnalysisPopulationRanks);
    expect(tied.map((item) => item.caseId)).toEqual(["case_a", "case_z", "case_a"]);
  });

  it("treats duplicate payloads as distinct case sampling units without replacement", () => {
    const first = populationItem("case_duplicate_a", 0);
    const second = populationItem("case_duplicate_b", 1);
    expect(first.inputIdentity.digest).toBe(second.inputIdentity.digest);
    expect(first.itemDigest).not.toBe(second.itemDigest);
    expect(first.frameMemberDigest).not.toBe(second.frameMemberDigest);
    const members = [rankable(first.caseId, 0), rankable(second.caseId, 1)];
    const draw = drawAnalysisPopulationSample({
      populationId: "ap_duplicates",
      datasetRevisionId: "dsr_duplicates",
      frameDigest: analysisPopulationFrameDigest({
        projectId: "proj_1", windowStart: WINDOW_START, windowEnd: WINDOW_END,
        frameMemberDigests: members.map((member) => member.frameMemberDigest)
      }),
      seed: "ab".repeat(32),
      fixedBudget: 2,
      members
    });
    expect(new Set(draw.selections.map((selection) => selection.caseId))).toEqual(
      new Set(["case_duplicate_a", "case_duplicate_b"])
    );
  });

  it("retains deterministic no-replacement properties across seeds and member permutations", () => {
    const members = Array.from({ length: 25 }, (_, index) => rankable(`case_${String(index).padStart(2, "0")}`, index));
    const frameDigest = analysisPopulationFrameDigest({
      projectId: "proj_property", windowStart: WINDOW_START, windowEnd: WINDOW_END,
      frameMemberDigests: members.map((member) => member.frameMemberDigest)
    });
    for (let index = 0; index < 32; index += 1) {
      const seed = index.toString(16).padStart(64, "0");
      const forward = drawAnalysisPopulationSample({
        populationId: "ap_property", datasetRevisionId: "dsr_property", frameDigest,
        seed, fixedBudget: 7, members
      });
      const permuted = drawAnalysisPopulationSample({
        populationId: "ap_property", datasetRevisionId: "dsr_property", frameDigest,
        seed, fixedBudget: 7, members: [...members.slice(index % 25), ...members.slice(0, index % 25)].reverse()
      });
      expect(permuted).toEqual(forward);
      expect(forward.selections).toHaveLength(7);
      expect(new Set(forward.selections.map((selection) => selection.caseId)).size).toBe(7);
      expect(forward.selections.map((selection) => selection.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it("handles the exact K=1 and K=N boundaries", () => {
    const members = [rankable("case_boundary_a", 0), rankable("case_boundary_b", 1)];
    const common = {
      populationId: "ap_boundary",
      datasetRevisionId: "dsr_boundary",
      frameDigest: DIGEST_A,
      seed: "cd".repeat(32),
      members
    };
    expect(drawAnalysisPopulationSample({ ...common, fixedBudget: 1 }).selections).toHaveLength(1);
    expect(drawAnalysisPopulationSample({ ...common, fixedBudget: members.length }).selections).toHaveLength(2);
  });
});

describe("analysis population bounds and persisted draw shape", () => {
  it("reports exact limit and observed values without truncating the frame", () => {
    expect(() => assertAnalysisPopulationDrawBounds(0, 1)).toThrow(AnalysisPopulationBoundError);
    try {
      assertAnalysisPopulationDrawBounds(ANALYSIS_POPULATION_MAX_MEMBERS + 1, 1);
      throw new Error("expected frame error");
    } catch (error) {
      expect(error).toMatchObject({
        code: "analysis_population_frame_too_large",
        limit: ANALYSIS_POPULATION_MAX_MEMBERS,
        observed: ANALYSIS_POPULATION_MAX_MEMBERS + 1
      });
    }
    try {
      assertAnalysisPopulationDrawBounds(5, 6);
      throw new Error("expected budget error");
    } catch (error) {
      expect(error).toMatchObject({ code: "analysis_population_budget_invalid", limit: 5, observed: 6 });
    }
    expect(() => assertAnalysisPopulationDrawBounds(ANALYSIS_POPULATION_MAX_MEMBERS, ANALYSIS_POPULATION_MAX_FIXED_BUDGET))
      .not.toThrow();
    expect(analysisPopulationInclusionProbability(100, 1_000)).toEqual({ numerator: 100, denominator: 1_000 });
  });

  it("enforces the 60-second settled boundary without inventing a maximum span", () => {
    expect(() => assertAnalysisPopulationWindow({
      windowStart: "2000-01-01T00:00:00Z",
      windowEnd: "2026-08-23T11:59:00Z"
    }, "2026-08-23T12:00:00Z")).not.toThrow();
    expect(() => assertAnalysisPopulationWindow({
      windowStart: "2026-08-23T11:00:00Z",
      windowEnd: "2026-08-23T11:59:00.001Z"
    }, "2026-08-23T12:00:00Z")).toThrow(/at least 60 seconds/);
  });

  it("validates a full persisted draw while its summary and page remain bounded", () => {
    const selection = {
      id: "apdi_1", projectId: "proj_1", drawId: "apd_1", populationId: "ap_1",
      memberId: "apm_1", revisionItemId: "dsri_1", caseId: "case_1", position: 0,
      frameMemberDigest: DIGEST_A, rankDigest: DIGEST_B, contentDigest: DIGEST_C,
      createdAt: "2026-08-03T00:00:00.000Z"
    };
    const persisted = {
      id: "apd_1", projectId: "proj_1", populationId: "ap_1", datasetRevisionId: "dsr_1",
      method: "simple_random", stoppingRule: "fixed", drawExecutor: "coeval_server",
      seed: SEED, rngVersion: "sha256-rank/v1", algorithmVersion: "coeval-analysis-draw/v1",
      fixedBudget: 1, populationSize: 2, inclusionProbability: { numerator: 1, denominator: 2 },
      drawDigest: DIGEST_A, contentDigest: DIGEST_B, executedBySubjectId: "subject_1",
      executedAt: "2026-08-03T00:00:00.000Z", selections: [selection]
    };
    expect(AnalysisPopulationDrawSchema.safeParse(persisted).success).toBe(true);
    const { selections: _selections, ...summary } = persisted;
    expect(AnalysisPopulationDrawSummarySchema.safeParse(summary).success).toBe(true);
    expect(AnalysisPopulationDrawSummarySchema.safeParse(persisted).success).toBe(false);
    expect(AnalysisPopulationSelectedItemsPageSchema.safeParse({
      items: [selection], totalCount: 1, nextCursor: null
    }).success).toBe(true);
  });

  it("binds draw item/content/draw projections independently", () => {
    const item = analysisPopulationDrawItemContentDigest({
      memberId: "apm_1", revisionItemId: "dsri_1", caseId: "case_1",
      frameMemberDigest: DIGEST_A, rankDigest: DIGEST_B, position: 0
    });
    const content = analysisPopulationDrawContentDigest([item]);
    const draw = analysisPopulationDrawDigest({
      populationId: "ap_1", datasetRevisionId: "dsr_1", frameDigest: DIGEST_C,
      contentDigest: content, seed: SEED, fixedBudget: 1, populationSize: 2,
      drawItemContentDigests: [item]
    });
    expect(item).not.toBe(content);
    expect(content).not.toBe(draw);
    expect(() => analysisPopulationDrawDigest({
      populationId: "ap_1", datasetRevisionId: "dsr_1", frameDigest: DIGEST_C,
      contentDigest: DIGEST_A, seed: SEED, fixedBudget: 1, populationSize: 2,
      drawItemContentDigests: [item]
    })).toThrow(/contentDigest must bind/);
  });
});
