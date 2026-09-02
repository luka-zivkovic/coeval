import { describe, expect, it } from "vitest";

import { type SkillVersion } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository, runGoldenSetRegression } from "../src/repository.js";

describe("Coeval Hono API", () => {
  it("promotes a non-exception (judge-pass) case and surfaces the latest human label on detail", async () => {
    const repository = new DemoRepository();
    const appWithRepository = createApp(repository);

    const dashboardBeforeRuling = await appWithRepository.request("/api/dashboard");
    const dashboardBeforeRulingBody = await dashboardBeforeRuling.json() as {
      exceptions: Array<{ id: string; capabilityGap?: string }>;
      topCapabilityGaps: Array<{ name: string; count: number }>;
    };
    expect(dashboardBeforeRulingBody.topCapabilityGaps.map(({ name, count }) => ({ name, count }))).toEqual(
      dashboardBeforeRulingBody.exceptions
        .flatMap((exception) => exception.capabilityGap ? [{ name: exception.capabilityGap, count: 1 }] : [])
        .sort((left, right) => left.name.localeCompare(right.name))
    );

    // case_101 is a passing golden case, NOT in the exceptions queue. It must
    // still be promotable — pass anchors are how the golden set catches a
    // version that starts failing good answers.
    const promoteResponse = await appWithRepository.request("/api/cases/case_101/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "pass", reason: "Canonical good answer." })
    });
    expect(promoteResponse.status).toBe(201);
    await expect(promoteResponse.json()).resolves.toMatchObject({
      entry: { caseId: "case_101", agreedLabel: "pass" }
    });

    // A case that was never judged stays a 404 — now with the case-not-found
    // message rather than the misleading "Exception not found".
    const missingResponse = await appWithRepository.request("/api/cases/case_does_not_exist/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "pass", reason: "Nope." })
    });
    expect(missingResponse.status).toBe(404);

    // A recorded human verdict outranks the judge label on the detail payload
    // (review surfaces freeze latestHumanLabel when promoting).
    const overrideResponse = await appWithRepository.request("/api/cases/case_exc_001/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "categorical",
          choice: "pass",
          choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
          rationale: "Judge was over-strict here."
        }
      })
    });
    expect(overrideResponse.status).toBe(201);
    const humanDetailResponse = await appWithRepository.request("/api/cases/case_exc_001");
    const humanDetail = await humanDetailResponse.json() as {
      latestHumanLabel: string | null;
      verdictHistory: Array<{ source: string; payload: { rationale: string } }>;
      goldenSetEntry: unknown;
    };
    expect(humanDetail).toMatchObject({
      exception: { verdict: "fail" },
      latestHumanLabel: "pass",
      goldenSetEntry: null
    });
    expect(humanDetail.verdictHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "human",
        payload: expect.objectContaining({ rationale: "Judge was over-strict here." })
      })
    ]));
    const dashboardAfterRuling = await appWithRepository.request("/api/dashboard");
    const dashboardAfterRulingBody = await dashboardAfterRuling.json() as {
      exceptions: Array<{ id: string; capabilityGap?: string }>;
      topCapabilityGaps: Array<{ name: string; count: number }>;
    };
    expect(dashboardAfterRulingBody.exceptions.map((exception) => exception.id)).not.toContain("case_exc_001");
    expect(dashboardAfterRulingBody.topCapabilityGaps.map(({ name, count }) => ({ name, count }))).toEqual(
      dashboardAfterRulingBody.exceptions
        .flatMap((exception) => exception.capabilityGap ? [{ name: exception.capabilityGap, count: 1 }] : [])
        .sort((left, right) => left.name.localeCompare(right.name))
    );

    // Promotion validates the label SERVER-side: freezing a label that
    // contradicts the recorded human verdict is a 409, not a silent write
    // into the golden set + a fabricated human verdict in the ledger.
    const conflictingPromote = await appWithRepository.request("/api/cases/case_exc_001/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "fail", reason: "Stale tab promoting the overturned judge label." })
    });
    expect(conflictingPromote.status).toBe(409);
    const agreeingPromote = await appWithRepository.request("/api/cases/case_exc_001/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "pass", reason: "Matches the recorded human verdict." })
    });
    expect(agreeingPromote.status).toBe(201);

    const promotedDetailResponse = await appWithRepository.request("/api/cases/case_exc_001");
    await expect(promotedDetailResponse.json()).resolves.toMatchObject({
      latestHumanLabel: "pass",
      goldenSetEntry: {
        caseId: "case_exc_001",
        agreedLabel: "pass",
        reason: "Matches the recorded human verdict."
      },
      verdictHistory: expect.arrayContaining([
        expect.objectContaining({
          source: "human",
          payload: expect.objectContaining({ rationale: "Matches the recorded human verdict." })
        })
      ])
    });
  });

  it("promotes a runtime-judged case in demo mode (PG parity for pass anchors)", async () => {
    // The demo repository must honor the same contract as PG: ANY judged
    // case is promotable, not only seeded exceptions / golden entries.
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "demo_runtime_judged",
      input: { q: "How do I export my data?" },
      output: { a: "Settings → Workspace → Export." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    await repository.recordJudgeRun({
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0",
      verdict: { label: "pass", score: 0.9, reason: "Grounded answer.", confidence: 0.9 }
    });
    const appWithRepository = createApp(repository);
    const promoteResponse = await appWithRepository.request(`/api/cases/${imported.caseId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "pass", reason: "Canonical good answer from runtime judging." })
    });
    expect(promoteResponse.status).toBe(201);
    await expect(promoteResponse.json()).resolves.toMatchObject({
      entry: { caseId: imported.caseId, agreedLabel: "pass" }
    });
  });

  it("drills into an exception and promotes it to the golden set", async () => {
    const repository = new DemoRepository();
    const appWithRepository = createApp(repository);

    const detailResponse = await appWithRepository.request("/api/cases/case_exc_001");
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      exception: {
        id: "case_exc_001",
        verdict: "fail"
      },
      trace: {
        id: "ls_run_8f31"
      },
      judgeRun: {
        skillVersionId: "skillv_1_2_0"
      }
    });

    const tooLongReason = "x".repeat(1001);
    const invalidPromoteResponse = await appWithRepository.request("/api/cases/case_exc_001/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "fail", reason: tooLongReason })
    });
    expect(invalidPromoteResponse.status).toBe(400);

    const promoteResponse = await appWithRepository.request("/api/cases/case_exc_001/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "fail", reason: "Good frozen regression case." })
    });
    expect(promoteResponse.status).toBe(201);
    const promoteBody = (await promoteResponse.json()) as { entry: { id: string; caseId: string } };
    expect(promoteBody).toMatchObject({
      entry: {
        caseId: "case_exc_001",
        agreedLabel: "fail",
        reason: "Good frozen regression case.",
        sourceSkillVersionId: "skillv_1_2_0",
        criterionVersionId: "criterionv_support_quality"
      }
    });

    const goldenResponse = await appWithRepository.request("/api/golden-set");
    const goldenBody = (await goldenResponse.json()) as { entries: Array<{ caseId: string }> };
    expect(goldenBody.entries.some((entry) => entry.caseId === "case_exc_001")).toBe(true);

    // The promotion is a human judgment — it must land in the v2 verdicts
    // ledger (source=human) so κ / calibration count it.
    const promotedVerdicts = await appWithRepository.request("/api/cases/case_exc_001/verdicts?source=human");
    expect(promotedVerdicts.status).toBe(200);
    const promotedVerdictsBody = (await promotedVerdicts.json()) as {
      verdicts: Array<{ source: string; payload: { kind: string; choice?: string; rationale?: string } }>;
    };
    expect(promotedVerdictsBody.verdicts).toHaveLength(1);
    expect(promotedVerdictsBody.verdicts[0]).toMatchObject({
      source: "human",
      payload: { kind: "categorical", choice: "fail", rationale: "Good frozen regression case." }
    });

    const invalidRetireResponse = await appWithRepository.request(`/api/golden-set/${promoteBody.entry.id}/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: tooLongReason })
    });
    expect(invalidRetireResponse.status).toBe(400);

    const retireResponse = await appWithRepository.request(`/api/golden-set/${promoteBody.entry.id}/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "No longer representative." })
    });
    expect(retireResponse.status).toBe(200);
    await expect(retireResponse.json()).resolves.toMatchObject({ retired: true });
    const alreadyRetiredResponse = await appWithRepository.request(`/api/golden-set/${promoteBody.entry.id}/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Accidental retry." })
    });
    expect(alreadyRetiredResponse.status).toBe(409);
    await expect(alreadyRetiredResponse.json()).resolves.toMatchObject({
      error: "Golden-set entry already retired",
      retirement: {
        retiredAt: expect.any(String),
        retiredBy: "Unknown",
        retiredByUserId: null,
        reason: "No longer representative."
      }
    });
    const goldenAfterRetire = await appWithRepository.request("/api/golden-set");
    const retiredBody = (await goldenAfterRetire.json()) as { entries: Array<{ caseId: string }> };
    expect(retiredBody.entries.some((entry) => entry.caseId === "case_exc_001")).toBe(false);

    const repromoteResponse = await appWithRepository.request("/api/cases/case_exc_001/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedLabel: "fail", reason: "Re-promoted as a fresh active case." })
    });
    expect(repromoteResponse.status).toBe(201);
    const repromoteBody = (await repromoteResponse.json()) as { entry: { id: string; caseId: string; reason: string } };
    expect(repromoteBody.entry).toMatchObject({
      caseId: "case_exc_001",
      reason: "Re-promoted as a fresh active case."
    });
    expect(repromoteBody.entry.id).not.toBe(promoteBody.entry.id);
    const goldenAfterRepromote = await appWithRepository.request("/api/golden-set");
    const repromotedBody = (await goldenAfterRepromote.json()) as { entries: Array<{ id: string; caseId: string }> };
    expect(repromotedBody.entries.filter((entry) => entry.caseId === "case_exc_001")).toEqual([
      expect.objectContaining({ id: repromoteBody.entry.id })
    ]);

    const missingRetireResponse = await appWithRepository.request("/api/golden-set/gold_missing/retire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Does not exist." })
    });
    expect(missingRetireResponse.status).toBe(404);
    await expect(missingRetireResponse.json()).resolves.toMatchObject({ error: "Golden-set entry not found" });
  });

  it("returns 500 for unexpected golden-set retirement failures", async () => {
    const repository = new class extends DemoRepository {
      override async retireGoldenSetEntry(): Promise<void> {
        throw new Error("Unexpected retirement failure");
      }
    }();
    const response = await createApp(repository).request("/api/golden-set/gold_1/retire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Trigger unexpected failure." })
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "Internal server error" });
  });
});

describe("golden-set regression", () => {
  it("uses the injected judge provider instead of local keyword matching", async () => {
    let receivedPrompt = "";
    const regression = await runGoldenSetRegression({
      skillVersion: {
        id: "skillv_provider_test",
        skillId: "skill_test",
        criterionVersionId: "criterionv_test",
        version: "1.0.0",
        status: "calibrating",
        rubricMarkdown: "Neutral rubric with no special keywords.",
        prompt: "Before\n{{rubric_markdown}}\nAfter",
        modelBinding: {
          provider: "mock",
          modelId: "mock",
          modelVersion: "test",
          temperature: 0
        },
        outputSchema: { type: "object" },
        goldenSetAgreement: null,
        tooStrictCount: 0,
        tooLenientCount: 0,
        ambiguousCount: 0,
        knownLimitations: [],
        verdictKind: "binary",
        scalarRange: null,
        categoricalChoiceScores: null,
        rubricProvenance: "human-authored",
        regressionDatasetRevisionId: "revision_test",
        createdAt: new Date().toISOString(),
        approvedAt: null
      },
      goldenSet: [
        {
          id: "gold_provider_test",
          caseId: "case_provider_test",
          traceId: "trace_provider_test",
          agreedLabel: "fail",
          reason: "Human reviewer marked it failed, but trace text is neutral.",
          promotedBy: "Reviewer",
          promotedAt: new Date().toISOString(),
          sourceSkillVersionId: "skillv_previous",
          criterionVersionId: "criterionv_test"
        }
      ],
      traces: new Map([
        [
          "case_provider_test",
          {
            id: "trace_provider_test",
            input: { question: "plain input" },
            output: { answer: "plain output" },
            metadata: {}
          }
        ]
      ]),
      judgeProvider: {
        name: "test-provider",
        async judge(input) {
          receivedPrompt = input.prompt.content;
          return {
            label: "fail",
            score: 0.1,
            reason: "provider-controlled verdict",
            confidence: 0.9
          };
        }
      }
    });

    expect(regression.status).toBe("passed");
    expect(receivedPrompt).toBe("Before\nNeutral rubric with no special keywords.\nAfter");
    expect(regression.compared).toBe(1);
    expect(regression.regressed).toBe(0);
    // per-case diff is populated, not just aggregate counts.
    expect(regression.cases).toHaveLength(1);
    expect(regression.cases[0]).toMatchObject({
      caseId: "case_provider_test",
      traceId: "trace_provider_test",
      agreedLabel: "fail",
      newLabel: "fail",
      change: "agree",
      rationale: "provider-controlled verdict"
    });
  });

  it("records a regress diff row when the new version disagrees with the golden label", async () => {
    const baseVersion: SkillVersion = {
      id: "skillv_regress_diff",
      skillId: "skill_test",
      criterionVersionId: "criterionv_test",
      version: "1.0.0",
      status: "calibrating",
      rubricMarkdown: "Neutral rubric.",
      prompt: "Return structured verdicts.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 },
      outputSchema: { type: "object" },
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: "binary",
      scalarRange: null,
      categoricalChoiceScores: null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: "revision_test",
      createdAt: new Date().toISOString(),
      approvedAt: null
    };
    const regression = await runGoldenSetRegression({
      skillVersion: baseVersion,
      goldenSet: [
        {
          id: "gold_regress",
          caseId: "case_regress",
          traceId: "trace_regress",
          agreedLabel: "pass",
          reason: "Team agreed this is a good reply.",
          promotedBy: "Reviewer",
          promotedAt: new Date().toISOString(),
          sourceSkillVersionId: "skillv_previous",
          criterionVersionId: "criterionv_test"
        }
      ],
      traces: new Map([
        ["case_regress", { id: "trace_regress", input: {}, output: {}, metadata: {} }]
      ]),
      judgeProvider: {
        name: "test-provider",
        async judge() {
          return { label: "fail", score: 0.1, reason: "judge now disagrees", confidence: 0.9 };
        }
      }
    });

    expect(regression.status).toBe("blocked");
    expect(regression.regressed).toBe(1);
    expect(regression.cases).toHaveLength(1);
    expect(regression.cases[0]).toMatchObject({
      caseId: "case_regress",
      agreedLabel: "pass",
      newLabel: "fail",
      change: "regress"
    });
  });

  it("labels a still-agreeing case as agree (not improve) when the prior version also agreed, and reports 0 improved", async () => {
    const baseVersion: SkillVersion = {
      id: "skillv_no_false_improve",
      skillId: "skill_test",
      criterionVersionId: "criterionv_test",
      version: "1.1.0",
      status: "calibrating",
      rubricMarkdown: "Neutral rubric.",
      prompt: "Return structured verdicts.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 },
      outputSchema: { type: "object" },
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: "binary",
      scalarRange: null,
      categoricalChoiceScores: null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: "revision_test",
      createdAt: new Date().toISOString(),
      approvedAt: null
    };
    const regression = await runGoldenSetRegression({
      skillVersion: baseVersion,
      // prior version also returned the agreed label → not an improvement.
      previousVerdicts: new Map([["case_agree", "pass"]]),
      goldenSet: [
        {
          id: "gold_agree",
          caseId: "case_agree",
          traceId: "trace_agree",
          agreedLabel: "pass",
          reason: "Good reply.",
          promotedBy: "Reviewer",
          promotedAt: new Date().toISOString(),
          sourceSkillVersionId: "skillv_previous",
          criterionVersionId: "criterionv_test"
        }
      ],
      traces: new Map([["case_agree", { id: "trace_agree", input: {}, output: {}, metadata: {} }]]),
      judgeProvider: {
        name: "test-provider",
        async judge() {
          return { label: "pass", score: 0.9, reason: "still agrees", confidence: 0.9 };
        }
      }
    });

    expect(regression.status).toBe("passed");
    expect(regression.improved).toBe(0);
    expect(regression.flipped).toBe(0);
    expect(regression.cases[0]).toMatchObject({ change: "agree", newLabel: "pass" });
  });

  it("labels a case the new version fixed (prior disagreed → new agrees) as improve, and counts the flip", async () => {
    const baseVersion: SkillVersion = {
      id: "skillv_real_improve",
      skillId: "skill_test",
      criterionVersionId: "criterionv_test",
      version: "1.3.0",
      status: "calibrating",
      rubricMarkdown: "Neutral rubric.",
      prompt: "Return structured verdicts.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 },
      outputSchema: { type: "object" },
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: "binary",
      scalarRange: null,
      categoricalChoiceScores: null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: "revision_test",
      createdAt: new Date().toISOString(),
      approvedAt: null
    };
    const regression = await runGoldenSetRegression({
      skillVersion: baseVersion,
      // prior version returned "fail" on a case the team agreed is "pass";
      // the new version now returns "pass" → a genuine improvement + flip.
      previousVerdicts: new Map([["case_fix", "fail"]]),
      goldenSet: [
        {
          id: "gold_fix",
          caseId: "case_fix",
          traceId: "trace_fix",
          agreedLabel: "pass",
          reason: "Team agreed this is a good reply.",
          promotedBy: "Reviewer",
          promotedAt: new Date().toISOString(),
          sourceSkillVersionId: "skillv_previous",
          criterionVersionId: "criterionv_test"
        }
      ],
      traces: new Map([["case_fix", { id: "trace_fix", input: {}, output: {}, metadata: {} }]]),
      judgeProvider: {
        name: "test-provider",
        async judge() {
          return { label: "pass", score: 0.9, reason: "now correct", confidence: 0.9 };
        }
      }
    });

    expect(regression.status).toBe("passed");
    expect(regression.improved).toBe(1);
    expect(regression.regressed).toBe(0);
    expect(regression.flipped).toBe(1);
    expect(regression.cases[0]).toMatchObject({ change: "improve", newLabel: "pass" });
  });

  it("caps the persisted per-case rationale length", async () => {
    const baseVersion: SkillVersion = {
      id: "skillv_rationale_cap",
      skillId: "skill_test",
      criterionVersionId: "criterionv_test",
      version: "1.2.0",
      status: "calibrating",
      rubricMarkdown: "Neutral rubric.",
      prompt: "Return structured verdicts.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 },
      outputSchema: { type: "object" },
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: "binary",
      scalarRange: null,
      categoricalChoiceScores: null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: "revision_test",
      createdAt: new Date().toISOString(),
      approvedAt: null
    };
    const regression = await runGoldenSetRegression({
      skillVersion: baseVersion,
      goldenSet: [
        {
          id: "gold_long",
          caseId: "case_long",
          traceId: "trace_long",
          agreedLabel: "pass",
          reason: "Good reply.",
          promotedBy: "Reviewer",
          promotedAt: new Date().toISOString(),
          sourceSkillVersionId: "skillv_previous",
          criterionVersionId: "criterionv_test"
        }
      ],
      traces: new Map([["case_long", { id: "trace_long", input: {}, output: {}, metadata: {} }]]),
      judgeProvider: {
        name: "test-provider",
        async judge() {
          return { label: "pass", score: 0.9, reason: "x".repeat(5000), confidence: 0.9 };
        }
      }
    });

    expect(regression.cases[0]!.rationale.length).toBeLessThanOrEqual(280);
  });
});
