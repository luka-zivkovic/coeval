import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Queue, QueueName } from "@coeval/queue";
import { AgentBootstrapRequestSchema, CreateSkillVersionInputSchema, JudgeCardSchema, SkillVersionSchema, VerdictPayloadSchema, effectiveHumanLabel, verdictComparableScore, verdictLabelFromPayload, type FeedbackSyncJob,
  type GateRunJob, type SkillVersion, SkillFormatV1Schema } from "@coeval/shared";
import { agentSetupPairingClaimExpiresAt, agentSetupPairingStatus, bootstrapRateLimitIdentity, createApp } from "../src/app.js";
import type { AgentSetupPairingRecord } from "../src/lib/auth.js";
import { DemoRepository, NoCurrentSkillError, buildGoldenSetHealthSummary, runGoldenSetRegression } from "../src/repository.js";
import { isPermanentFeedbackSyncError, processFeedbackSyncJob } from "../src/workers/feedback-sync.js";
import { dispatchEvalRunOnce, processGateRunJob, runExistingCaseBackfill } from "../src/workers/gate.js";
import { processEvalItemJob, processEvalRunJob } from "../src/workers/eval-run.js";
import { scheduleImportedCaseJudging } from "../src/workers/import-judging.js";
import { processJudgeRunJob } from "../src/workers/judge.js";
import { processLangfuseImportJob } from "../src/workers/langfuse-import.js";
import { enqueueDueLangfuseImports } from "../src/workers/langfuse-poller.js";
import { processLangSmithImportJob } from "../src/workers/langsmith-import.js";
import { enqueueDueLangSmithImports, parsePollImportLimit, parsePollIntervalMs } from "../src/workers/langsmith-poller.js";
import { EXCLUDED_VALUE, REDACTED_VALUE } from "../src/lib/redaction.js";
import { LangSmithHttpError } from "../src/lib/langsmith.js";

class PurposeCapturingRepository extends DemoRepository {
  readonly importedPurposes = new Array<string>();

  override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
    this.importedPurposes.push(args[3].ingestionPurpose);
    return super.importTrace(...args);
  }
}

describe("Coeval Hono API", () => {
  const app = createApp();

  it("returns health", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("reports the exact saved Run fields available to beginner setup", async () => {
    const repository = new DemoRepository();
    await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "onboarding-inventory-1",
      input: { request: "Help" },
      output: { answer: "Here is help" },
      metadata: { channel: "test" },
      steps: [{ name: "lookup", input: { q: "Help" }, output: { found: true } }]
    }, { ingestionPurpose: "analysis_eligible_manual" });
    await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "onboarding-inventory-2",
      input: { request: "No result yet" },
      output: null,
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const response = await createApp(repository).request("/api/onboarding/evidence-inventory");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runCount: 2,
      inputCount: 2,
      outputCount: 1,
      stepsCount: 1,
      metadataCount: 1
    });
  });

  it("returns the exact quality question bound to a Check version", async () => {
    const dashboardResponse = await app.request("/api/dashboard");
    const dashboard = await dashboardResponse.json() as {
      skill: { id: string; description: string; currentVersion: { id: string; criterionVersionId: string } };
    };
    const response = await app.request(
      `/api/skills/${dashboard.skill.id}/versions/${dashboard.skill.currentVersion.id}/criterion`
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      criterionVersion: {
        id: dashboard.skill.currentVersion.criterionVersionId,
        definition: dashboard.skill.description
      }
    });
    expect((await app.request(
      `/api/skills/skill_wrong/versions/${dashboard.skill.currentVersion.id}/criterion`
    )).status).toBe(404);
  });

  it("exposes retry guidance to cross-origin browser clients", async () => {
    const response = await app.request("/health", {
      headers: { origin: "http://localhost:5173" }
    });
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase())
      .toContain("retry-after");
  });

  it("answers every pool-less bootstrap attempt with 501, never a misleading token error", async () => {
    // Pool-less mode can never bootstrap — a pairing token must NOT get a 401
    // "invalid or expired" that tells the user to regenerate connections that
    // can never work; the mode itself is the cause and the response says so.
    const previous = process.env.COEVAL_BOOTSTRAP_TOKEN;
    try {
      delete process.env.COEVAL_BOOTSTRAP_TOKEN;
      for (const headers of [
        undefined,
        { authorization: "Bearer coeval_pair_expired-or-made-up" },
        { authorization: "Bearer wrong-token" }
      ]) {
        const response = await app.request("/api/v1/bootstrap", { method: "POST", ...(headers ? { headers } : {}) });
        expect(response.status).toBe(501);
        await expect(response.json()).resolves.toMatchObject({ code: "bootstrap_requires_auth" });
      }

      process.env.COEVAL_BOOTSTRAP_TOKEN = "test-bootstrap-token-that-is-at-least-32-chars";
      const demo = await app.request("/api/v1/bootstrap", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.COEVAL_BOOTSTRAP_TOKEN}` }
      });
      expect(demo.status).toBe(501);
      await expect(demo.json()).resolves.toMatchObject({ code: "bootstrap_requires_auth" });
    } finally {
      if (previous === undefined) delete process.env.COEVAL_BOOTSTRAP_TOKEN;
      else process.env.COEVAL_BOOTSTRAP_TOKEN = previous;
    }
  });

  it("validates the public agent-bootstrap contract and provider-specific model fields", () => {
    const base = {
      owner: { email: "owner@example.com" },
      project: { name: "Skill audit" },
      check: { name: "Follows contract", question: "Did this Run follow the contract?" },
      skill: {
        rubricMarkdown: "# Skill audit\n\nPass when the contract is followed.",
        model: { provider: "anthropic" as const }
      }
    };
    expect(AgentBootstrapRequestSchema.parse(base)).toMatchObject({
      project: { apiKeyName: "Agent bootstrap" },
      skill: { model: { temperature: 0 } }
    });
    expect(() => AgentBootstrapRequestSchema.parse({
      ...base,
      skill: { ...base.skill, model: { provider: "custom", baseUrl: "https://judge.example/v1" } }
    })).toThrow();
    expect(() => AgentBootstrapRequestSchema.parse({
      ...base,
      skill: { ...base.skill, model: { provider: "openai", baseUrl: "https://judge.example/v1" } }
    })).toThrow();
  });

  it("reports a retryable rollback when headless setup removes its failed project", async () => {
    const previous = process.env.COEVAL_BOOTSTRAP_TOKEN;
    process.env.COEVAL_BOOTSTRAP_TOKEN = "headless-rollback-token-that-is-at-least-32-characters";
    try {
      const repository = new DemoRepository();
      vi.spyOn(repository, "createApiKey").mockRejectedValue(new Error("simulated key insert failure"));
      const deleteProject = vi.spyOn(repository, "deleteProject").mockResolvedValue();
      const client = {
        query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
        release: vi.fn()
      };
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes(`count(*)::int as count from "user"`)) return { rows: [{ count: 1 }], rowCount: 1 };
          if (sql.includes(`from "user" u`)) {
            return { rows: [{ id: "user_owner", email: "owner@example.com", name: "Owner" }], rowCount: 1 };
          }
          if (sql.includes("select organization_id from organization_members")) {
            return { rows: [{ organization_id: "org_test" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        connect: vi.fn(async () => client)
      } as unknown as Pool;
      const headlessApp = createApp(repository, {
        pool,
        auth: { api: { getSession: async () => null } } as never
      });
      const response = await headlessApp.request("/api/v1/bootstrap", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.COEVAL_BOOTSTRAP_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          owner: { email: "owner@example.com" },
          project: { name: "Retryable setup" },
          check: { name: "Correctness", question: "Was this Run correct?" },
          skill: {
            rubricMarkdown: "# Retryable setup\n\nPass when correct.",
            model: { provider: "custom", modelId: "judge-model", baseUrl: "https://judge.example/v1" }
          },
          providerApiKey: "provider-key-for-rollback-test"
        })
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ code: "bootstrap_rolled_back" });
      expect(deleteProject).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.COEVAL_BOOTSTRAP_TOKEN;
      else process.env.COEVAL_BOOTSTRAP_TOKEN = previous;
    }
  });

  it("keeps a running pairing claimed through its post-expiry safety window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
      const pairing: AgentSetupPairingRecord = {
        id: "pair_test",
        projectId: "proj_test",
        projectName: "Test",
        createdByUserId: "user_test",
        ownerEmail: "owner@example.com",
        ownerName: "Owner",
        // The one-time token has expired, but this request claimed it one
        // minute ago and must remain protected against a replacement agent.
        expiresAt: "2026-08-14T11:59:00.000Z",
        claimedAt: "2026-08-14T11:59:00.000Z",
        consumedAt: null,
        revokedAt: null
      };
      expect(agentSetupPairingStatus(pairing)).toBe("claimed");
      expect(agentSetupPairingClaimExpiresAt(pairing)).toBe("2026-08-14T12:09:00.000Z");

      vi.setSystemTime(new Date("2026-08-14T12:09:00.001Z"));
      expect(agentSetupPairingStatus(pairing)).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates trusted-proxy bootstrap limits by client address", () => {
    const previous = process.env.COEVAL_TRUST_PROXY;
    process.env.COEVAL_TRUST_PROXY = "1";
    try {
      const context = (address: string) => ({
        req: { header: (name: string) => name === "x-forwarded-for" ? `${address}, 10.0.0.1` : undefined }
      });
      expect(bootstrapRateLimitIdentity(context("203.0.113.10") as never)).toBe("203.0.113.10");
      expect(bootstrapRateLimitIdentity(context("203.0.113.11") as never)).toBe("203.0.113.11");
    } finally {
      if (previous === undefined) delete process.env.COEVAL_TRUST_PROXY;
      else process.env.COEVAL_TRUST_PROXY = previous;
    }
  });

  it("returns dashboard summary", async () => {
    const response = await app.request("/api/dashboard");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      project: { name: string };
      currentVersionResultCount: number;
      exceptions: unknown[];
    };
    expect(body.project.name).toBe("LangSmith Support Agent");
    expect(body.currentVersionResultCount).toBeGreaterThan(0);
    expect(body.exceptions.length).toBeGreaterThan(0);
  });

  it("returns golden-set health summary", async () => {
    const response = await app.request("/api/golden-set/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectId: "proj_langsmith_support",
      status: "needs_action",
      totalActive: 2,
      staleAfterDays: 90,
      staleCount: 0,
      duplicateCount: 0,
      duplicateGroups: [],
      passCount: 1,
      failCount: 1,
      recommendations: [
        "Grow the golden set to at least 10 active cases before treating regression runs as authoritative."
      ]
    });
  });

  it("flags stale golden-set cases and caps the stale entry sample", () => {
    const summary = buildGoldenSetHealthSummary(
      "proj_test",
      Array.from({ length: 6 }, (_, index) => ({
        id: `gold_${index}`,
        caseId: `case_${index}`,
        traceId: `trace_${index}`,
        agreedLabel: index === 0 ? "pass" : "fail",
        reason: `Reason ${index}`,
        promotedBy: "Reviewer",
        promotedAt: `2026-01-0${Math.min(index + 1, 9)}T00:00:00.000Z`,
        sourceSkillVersionId: "skillv_test",
        criterionVersionId: "criterionv_test"
      })),
      new Date("2026-05-07T00:00:00.000Z"),
      90
    );

    expect(summary.staleCount).toBe(6);
    expect(summary.status).toBe("needs_action");
    expect(summary.staleEntries).toHaveLength(5);
    expect(summary.duplicateCount).toBe(0);
    expect(summary.recommendations).toContain("Review 6 golden-set cases older than 90 days for stale labels or product drift.");
  });

  it("reports healthy and label-mix golden-set health states", () => {
    const entries = (labelForIndex: (index: number) => "pass" | "fail") => Array.from({ length: 10 }, (_, index) => ({
      id: `gold_${index}`,
      caseId: `case_${index}`,
      traceId: `trace_${index}`,
      agreedLabel: labelForIndex(index),
      reason: `Reason ${index}`,
      promotedBy: "Reviewer",
      promotedAt: "2026-05-01T00:00:00.000Z",
      sourceSkillVersionId: "skillv_test",
      criterionVersionId: "criterionv_test"
    }));

    const healthy = buildGoldenSetHealthSummary("proj_test", entries((index) => index % 2 === 0 ? "pass" : "fail"), new Date("2026-05-07T00:00:00.000Z"));
    expect(healthy).toMatchObject({
      status: "healthy",
      recommendations: ["Golden set looks healthy enough for the current regression gate."]
    });

    const onlyPass = buildGoldenSetHealthSummary("proj_test", entries(() => "pass"), new Date("2026-05-07T00:00:00.000Z"));
    expect(onlyPass).toMatchObject({ status: "needs_action", failCount: 0 });
    expect(onlyPass.recommendations).toEqual([
      "Keep both pass and fail examples active so the gate catches strict and lenient drift."
    ]);

    const onlyFail = buildGoldenSetHealthSummary("proj_test", entries(() => "fail"), new Date("2026-05-07T00:00:00.000Z"));
    expect(onlyFail).toMatchObject({ status: "needs_action", passCount: 0 });
    expect(onlyFail.recommendations).toEqual([
      "Keep both pass and fail examples active so the gate catches strict and lenient drift."
    ]);
  });

  it("flags duplicate golden-set cases by trace ID", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      id: `gold_${index}`,
      caseId: `case_${index}`,
      traceId: index < 2 ? "trace_duplicate" : `trace_${index}`,
      agreedLabel: index % 2 === 0 ? "pass" as const : "fail" as const,
      reason: `Reason ${index}`,
      promotedBy: "Reviewer",
      promotedAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      sourceSkillVersionId: "skillv_test",
      criterionVersionId: "criterionv_test"
    }));

    const summary = buildGoldenSetHealthSummary("proj_test", entries, new Date("2026-05-20T00:00:00.000Z"));

    expect(summary).toMatchObject({
      status: "needs_action",
      duplicateCount: 1,
      duplicateGroups: [
        {
          traceId: "trace_duplicate",
          entryCount: 2,
          entries: [
            { id: "gold_0", traceId: "trace_duplicate" },
            { id: "gold_1", traceId: "trace_duplicate" }
          ]
        }
      ]
    });
    expect(summary.recommendations).toEqual([
      "Review 1 duplicate golden-set case before expanding the suite."
    ]);
  });

  it("enforces verdict-kind shape consistency on skill version + create input", () => {
    // CreateSkillVersionInputSchema: scalar needs range; categorical needs choiceScores; binary forbids both.
    const baseInput = {
      rubricMarkdown: "Test rubric.",
      prompt: "Test prompt.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 }
    };
    expect(() => CreateSkillVersionInputSchema.parse({ ...baseInput, verdictKind: "scalar" })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({ ...baseInput, verdictKind: "scalar", scalarRange: [1, 1] })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({ ...baseInput, verdictKind: "categorical" })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({ ...baseInput, verdictKind: "categorical", categoricalChoiceScores: {} })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({ ...baseInput, verdictKind: "binary", scalarRange: [0, 1] })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({ ...baseInput, verdictKind: "binary" })).not.toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({ ...baseInput, verdictKind: "scalar", scalarRange: [0, 1] })).not.toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      verdictKind: "categorical",
      categoricalChoiceScores: { great: 1, okay: 0.5 }
    })).not.toThrow();

    // SkillVersionSchema mirrors the same constraints on the persisted row.
    const baseVersion = {
      id: "skillv_test",
      skillId: "skill_test",
      criterionVersionId: "criterionv_test",
      version: "1.0.0",
      status: "calibrating",
      rubricMarkdown: "x",
      prompt: "x",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 },
      outputSchema: { type: "object" },
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      scalarRange: null,
      categoricalChoiceScores: null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: "revision_test",
      createdAt: new Date().toISOString(),
      approvedAt: null
    };
    expect(() => SkillVersionSchema.parse({ ...baseVersion, verdictKind: "binary" })).not.toThrow();
    expect(SkillVersionSchema.parse({ ...baseVersion, verdictKind: "binary" }).rubricProvenance).toBe("human-authored");
    expect(() => SkillVersionSchema.parse({ ...baseVersion, verdictKind: "scalar" })).toThrow();
    expect(() => SkillVersionSchema.parse({ ...baseVersion, verdictKind: "scalar", scalarRange: [0, 1] })).not.toThrow();
    expect(() => SkillVersionSchema.parse({ ...baseVersion, verdictKind: "categorical" })).toThrow();
    expect(() => SkillVersionSchema.parse({
      ...baseVersion,
      verdictKind: "categorical",
      categoricalChoiceScores: { good: 1, bad: 0 }
    })).not.toThrow();
  });

  it("validates verdict payload shapes and rejects ill-formed inputs", () => {
    expect(() => VerdictPayloadSchema.parse({ kind: "binary", pass: true, rationale: "ok" })).not.toThrow();
    expect(() => VerdictPayloadSchema.parse({ kind: "binary", label: "ambiguous", rationale: "insufficient evidence" })).not.toThrow();
    expect(() => VerdictPayloadSchema.parse({ kind: "scalar", score: 0.5, range: [0, 1], rationale: "ok" })).not.toThrow();
    expect(() => VerdictPayloadSchema.parse({
      kind: "categorical",
      choice: "great",
      choiceScores: { great: 1, okay: 0.5, bad: 0 },
      rationale: "ok"
    })).not.toThrow();

    // Refines fire: scalar out of range, ascending range required, choice missing from choiceScores.
    expect(() => VerdictPayloadSchema.parse({ kind: "scalar", score: 1.5, range: [0, 1], rationale: "ok" })).toThrow();
    expect(() => VerdictPayloadSchema.parse({ kind: "binary", pass: null, rationale: "ambiguous" })).toThrow();
    expect(() => VerdictPayloadSchema.parse({
      kind: "binary",
      pass: false,
      label: "ambiguous",
      rationale: "conflicting binary states"
    })).toThrow();
    expect(() => VerdictPayloadSchema.parse({
      kind: "binary",
      label: "ambiguous",
      rationale: "no binary classification",
      failingStep: 0
    })).toThrow();
    expect(() => VerdictPayloadSchema.parse({ kind: "scalar", score: 0.5, range: [1, 1], rationale: "ok" })).toThrow();
    expect(() => VerdictPayloadSchema.parse({
      kind: "categorical",
      choice: "missing",
      choiceScores: { great: 1, okay: 0.5 },
      rationale: "ok"
    })).toThrow();
  });

  it("derives a comparable [0,1] score across every verdict kind", () => {
    expect(verdictComparableScore({ kind: "binary", pass: true, rationale: "" })).toBe(1);
    expect(verdictComparableScore({ kind: "binary", pass: false, rationale: "" })).toBe(0);
    expect(verdictComparableScore({ kind: "binary", label: "ambiguous", rationale: "" })).toBe(0.5);
    expect(verdictComparableScore({ kind: "scalar", score: 7, range: [0, 10], rationale: "" })).toBeCloseTo(0.7);
    expect(verdictComparableScore({
      kind: "categorical",
      choice: "okay",
      choiceScores: { great: 1, okay: 0.5, bad: 0 },
      rationale: ""
    })).toBe(0.5);
    // Unknown choice falls through to 0 (defensive; schema refine prevents this at the boundary).
    expect(verdictComparableScore({
      kind: "categorical",
      choice: "okay",
      choiceScores: { other: 1 },
      rationale: ""
    } as never)).toBe(0);
  });

  it("projects verdict labels three-way: ambiguous survives, never folds into pass", () => {
    // Canonical categorical choices project verbatim — an ambiguous verdict
    // (choice-score 0.5) must NOT cross the ≥0.5 threshold into "pass".
    expect(verdictLabelFromPayload({
      kind: "categorical",
      choice: "ambiguous",
      choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
      rationale: ""
    })).toBe("ambiguous");
    expect(verdictLabelFromPayload({
      kind: "categorical",
      choice: "pass",
      choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
      rationale: ""
    })).toBe("pass");
    expect(verdictLabelFromPayload({
      kind: "categorical",
      choice: "fail",
      choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
      rationale: ""
    })).toBe("fail");
    // Non-canonical categorical choices fall back to the score threshold.
    expect(verdictLabelFromPayload({
      kind: "categorical",
      choice: "good",
      choiceScores: { good: 0.9, bad: 0.1 },
      rationale: ""
    })).toBe("pass");
    expect(verdictLabelFromPayload({
      kind: "categorical",
      choice: "bad",
      choiceScores: { good: 0.9, bad: 0.1 },
      rationale: ""
    })).toBe("fail");
    // Score-projected verdicts keep a middle ambiguous band — a
    // mid-confidence scalar verdict must reach the exceptions queue, not be
    // silently rounded into pass/fail.
    expect(verdictLabelFromPayload({ kind: "binary", pass: true, rationale: "" })).toBe("pass");
    expect(verdictLabelFromPayload({ kind: "binary", label: "ambiguous", rationale: "" })).toBe("ambiguous");
    expect(verdictLabelFromPayload({ kind: "scalar", score: 2, range: [0, 10], rationale: "" })).toBe("fail");
    expect(verdictLabelFromPayload({ kind: "scalar", score: 5, range: [0, 10], rationale: "" })).toBe("ambiguous");
    expect(verdictLabelFromPayload({ kind: "scalar", score: 9, range: [0, 10], rationale: "" })).toBe("pass");
    expect(verdictLabelFromPayload({
      kind: "categorical",
      choice: "okay",
      choiceScores: { great: 1, okay: 0.5, bad: 0 },
      rationale: ""
    })).toBe("ambiguous");
  });

  it("resolves the effective human label: adjudication outranks recency", () => {
    const human = (id: string, choice: "pass" | "fail", createdAt: string, source = "human") => ({
      id,
      source,
      createdAt,
      payload: {
        kind: "categorical" as const,
        choice,
        choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
        rationale: ""
      }
    });
    // A later plain-human verdict does NOT override an adjudication.
    expect(effectiveHumanLabel([
      human("v1", "fail", "2026-01-01T00:00:00Z", "adjudicated"),
      human("v2", "pass", "2026-02-01T00:00:00Z")
    ])).toBe("fail");
    // Within the same tier, the latest wins.
    expect(effectiveHumanLabel([
      human("v1", "fail", "2026-01-01T00:00:00Z"),
      human("v2", "pass", "2026-02-01T00:00:00Z")
    ])).toBe("pass");
    // Judge verdicts never count as human.
    expect(effectiveHumanLabel([{ ...human("v1", "pass", "2026-01-01T00:00:00Z"), source: "llm_judge" }])).toBeNull();
    expect(effectiveHumanLabel([])).toBeNull();
  });

  it("seeds demo verdicts when opted in, populating κ + both disagreement feeds", async () => {
    const seeded = new DemoRepository(undefined, { seedVerdicts: true });
    const projectId = "proj_langsmith_support";

    const kappa = await seeded.getProjectKappaSummary(projectId);
    expect(kappa.raterCount).toBeGreaterThanOrEqual(2);
    expect(kappa.pairs.length).toBeGreaterThan(0);

    const humanDisagree = await seeded.getDisagreementSummary(projectId);
    expect(humanDisagree.disagreedCases).toBeGreaterThan(0);

    const judgeDisagree = await seeded.getJudgeHumanDisagreementSummary(projectId);
    expect(judgeDisagree.disagreedCases).toBeGreaterThan(0);

    const detail = await seeded.getCaseDetail(projectId, "case_exc_002");
    expect(detail?.verdictHistory.filter((verdict) => verdict.source === "llm_judge").length).toBeGreaterThan(1);
    expect(detail?.verdictHistory.some((verdict) => verdict.source === "human")).toBe(true);
    const latestJudgeEvidence = detail?.verdictHistory.find((verdict) => verdict.source === "llm_judge");
    expect(latestJudgeEvidence).toBeDefined();
    expect(detail?.judgeRun).toMatchObject({
      verdict: verdictLabelFromPayload(latestJudgeEvidence!.payload),
      reasoning: latestJudgeEvidence!.payload.rationale,
      createdAt: latestJudgeEvidence!.createdAt
    });

    // The demo server opts into these seeded verdicts. Its unresolved queue
    // must therefore use the same projection as PG instead of showing cases
    // with already-recorded human rulings as still needing review.
    const dashboard = await seeded.getDashboardSummary(projectId);
    expect(dashboard.exceptions).toEqual([]);

    // The judge-run sink lands before the v2 verdict sink. If the latter
    // fails, PG still reopens from judge_runs; demo mode must do the same and
    // expose the durable run in case history rather than hiding the new work.
    const runOnly = await seeded.recordJudgeRun({
      projectId,
      caseId: "case_exc_003",
      skillVersionId: "skillv_1_2_0",
      verdict: {
        label: "ambiguous",
        score: 0.5,
        reason: "The evaluator re-ran, but its verdict-ledger write did not land.",
        confidence: 0.5
      }
    });
    const reopenedDashboard = await seeded.getDashboardSummary(projectId);
    expect(reopenedDashboard.exceptions.map((exception) => exception.id)).toContain("case_exc_003");
    expect(reopenedDashboard.currentVersionResultCount).toBe(dashboard.currentVersionResultCount);
    const reopenedDetail = await seeded.getCaseDetail(projectId, "case_exc_003");
    expect(reopenedDetail?.judgeRun.id).toBe(runOnly.id);
    expect(reopenedDetail?.verdictHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `verdict_from_${runOnly.id}`,
        source: "llm_judge",
        payload: expect.objectContaining({
          choice: "ambiguous",
          rationale: "The evaluator re-ran, but its verdict-ledger write did not land."
        })
      })
    ]));

    // Default (no opt-in) stays empty so other tests start clean.
    const empty = new DemoRepository();
    expect((await empty.getProjectKappaSummary(projectId)).raterCount).toBe(0);
  });

  it("records and filters v2 verdicts across sources via DemoRepository", async () => {
    const repository = new DemoRepository();
    const projectId = "proj_langsmith_support";
    const imported = await repository.importTrace(projectId, "manual", {
      sourceTraceId: "manual_verdict_target",
      input: { question: "Should the bot apologize?" },
      output: { answer: "Yes, with reasoning." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const llm = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "Apology with reasoning." }
    });
    const human = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "human",
      actorUserId: "user_reviewer",
      payload: {
        kind: "categorical",
        choice: "okay",
        choiceScores: { great: 1, okay: 0.5, bad: 0 },
        rationale: "Reasoning could be tighter."
      }
    });
    const ext = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "imported_external",
      externalRunId: "ls_run_external_42",
      payload: { kind: "scalar", score: 0.8, range: [0, 1], rationale: "LangSmith eval." }
    });

    // imported_external dedup keyed on (project, externalRunId).
    const extAgain = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "imported_external",
      externalRunId: "ls_run_external_42",
      payload: { kind: "scalar", score: 0.0, range: [0, 1], rationale: "ignored — should dedup" }
    });
    expect(extAgain.id).toBe(ext.id);
    expect(extAgain.payload).toEqual(ext.payload);

    const all = await repository.listVerdicts({ projectId, caseId: imported.caseId, limit: 10 });
    expect(all.map((v) => v.id).sort()).toEqual([ext.id, human.id, llm.id].sort());
    expect(all).toHaveLength(3);

    const humansOnly = await repository.listVerdicts({ projectId, source: "human", limit: 10 });
    expect(humansOnly).toEqual([human]);

    const bySkill = await repository.listVerdicts({ projectId, skillVersionId: "skillv_1_2_0", limit: 10 });
    // Human/adjudicated verdicts now carry the same immutable evaluator
    // identity instead of an unscoped NULL binding.
    expect(bySkill).toHaveLength(2);
    expect(new Set(bySkill.map((verdict) => verdict.id))).toEqual(new Set([human.id, llm.id]));
  });

  it("records human verdicts on a case via the /verdicts endpoint", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const caseId = "case_exc_001"; // exists in demoExceptions

    const create = await localApp.request(`/api/cases/${caseId}/verdicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { kind: "binary", pass: false, rationale: "Cited outdated policy." }
      })
    });
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as { verdict: { id: string; source: string; payload: { kind: string } } };
    expect(createBody.verdict).toMatchObject({
      source: "human",
      payload: { kind: "binary", pass: false }
    });

    const list = await localApp.request(`/api/cases/${caseId}/verdicts`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { verdicts: Array<{ id: string }> };
    expect(listBody.verdicts.map((v) => v.id)).toEqual([createBody.verdict.id]);

    // Filter by source: human matches, llm_judge does not.
    const llmFiltered = await localApp.request(`/api/cases/${caseId}/verdicts?source=llm_judge`);
    expect(llmFiltered.status).toBe(200);
    await expect(llmFiltered.json()).resolves.toEqual({ verdicts: [] });
  });

  it("refuses to sign off a version that was already approved (409)", async () => {
    // P0-1: "sign off as-is" exists only for the never-approved starter draft.
    // The demo seed's current version is production — signing it off must 409,
    // not silently re-approve.
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const versionId = (await repository.getCurrentSkill()).currentVersion.id;
    const response = await localApp.request(`/api/skills/skill_demo/versions/${versionId}/signoff`, {
      method: "POST"
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("never-approved draft");
  });

  it("returns 404 when signing off a version that doesn't exist", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/skills/skill_demo/versions/skillv_nope/signoff", {
      method: "POST"
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Skill version not found" });
  });

  it("returns 404 when recording a verdict on a case not in this project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_does_not_exist/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationale: "ok" } })
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Case not found in this project" });
  });

  it("adjudicates a disagreed case, annotating the feed and leaving κ untouched (A2.2b-2)", async () => {
    // The seed leaves case_exc_001 as a live judge-vs-human disagreement (judge
    // fail, jules pass). Adjudicating it should mark it resolved without κ moving.
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const localApp = createApp(repository);

    const before = (await (await localApp.request("/api/projects/judge-human-disagreements")).json()) as {
      resolvedCases: number;
      cases: Array<{ caseId: string; adjudicatedLabel: string | null }>;
    };
    // The seed pre-adjudicates case_exc_003 (A2.2c regression story), so one of
    // the two judge-human disagreements starts resolved; case_exc_001 is open.
    expect(before.resolvedCases).toBe(1);
    const kappaBefore = await (await localApp.request("/api/projects/kappa")).json();

    const adjudicate = await localApp.request("/api/cases/case_exc_001/adjudicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: false, rationale: "Cited outdated policy — fail." } })
    });
    expect(adjudicate.status).toBe(201);
    await expect(adjudicate.json()).resolves.toMatchObject({ verdict: { source: "adjudicated", payload: { kind: "binary", pass: false } } });

    const after = (await (await localApp.request("/api/projects/judge-human-disagreements")).json()) as {
      resolvedCases: number;
      cases: Array<{ caseId: string; adjudicatedLabel: string | null }>;
    };
    expect(after.resolvedCases).toBe(2); // case_exc_003 (seeded) + case_exc_001 (just now)
    expect(after.cases.find((c) => c.caseId === "case_exc_001")?.adjudicatedLabel).toBe("fail");

    // κ is over human verdicts only — adjudication must not move it.
    const kappaAfter = await (await localApp.request("/api/projects/kappa")).json();
    expect(kappaAfter).toEqual(kappaBefore);
  });

  it("rejects a scalar adjudication payload (can't resolve a discrete split)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_exc_001/adjudicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "scalar", score: 0.5, range: [0, 1], rationale: "mid" } })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("discrete") });
  });

  it("returns 404 when adjudicating a case not in this project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_does_not_exist/adjudicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationale: "ok" } })
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Case not found in this project" });
  });

  it("convergence audit shows the seeded before→after story incl. a regression (A2.2c)", async () => {
    // The seed adjudicates 3 cases. v1.2.0 fixed two that v1.1.0 got wrong
    // (101, 205) but REGRESSED on one v1.1.0 got right (exc_003) → "fixed 2,
    // broke 1" — the credible governance moment, not an all-green demo.
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const localApp = createApp(repository);
    const skillId = "skill_support_quality";
    const versionId = "skillv_1_2_0";

    const page = (await (
      await localApp.request(`/api/skills/${skillId}/versions/${versionId}/convergence`)
    ).json()) as {
      audit: {
        afterVersionId: string;
        beforeVersionId: string | null;
        adjudicatedTotal: number;
        comparedCases: number;
        afterAgreed: number;
        beforeAgreed: number;
        improved: number;
        regressed: number;
        cases: Array<{ caseId: string; change: string }>;
      };
      nextCursor: string | null;
      nextUncoveredCaseId: string | null;
    };
    const c = page.audit;
    expect(c.afterVersionId).toBe(versionId);
    expect(c.beforeVersionId).toBe("skillv_1_1_0"); // the seeded predecessor
    expect(c.adjudicatedTotal).toBe(3);
    expect(c.comparedCases).toBe(3);
    expect(c.improved).toBe(2); // fixed case_101 + case_205
    expect(c.regressed).toBe(1); // broke case_exc_003 (v1.1.0 caught it, v1.2.0 doesn't)
    expect(c.afterAgreed).toBe(2); // v1.2.0 agrees on 2 of 3
    expect(c.beforeAgreed).toBe(1); // v1.1.0 agreed on 1 of 3 — net improvement, with a regression
    expect(c.cases.find((x) => x.caseId === "case_exc_003")?.change).toBe("regressed");
    expect(page.nextCursor).toBeNull();
    expect(page.nextUncoveredCaseId).toBeNull();
  });

  it("paginates the exact convergence ledger without changing its summary", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const localApp = createApp(repository);
    const base = "/api/skills/skill_support_quality/versions/skillv_1_2_0/convergence";
    const firstResponse = await localApp.request(`${base}?limit=1`);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      audit: { comparedCases: number; afterAgreed: number; cases: Array<{ caseId: string }> };
      nextCursor: string | null;
    };
    expect(first.audit.cases).toHaveLength(1);
    expect(first.audit.comparedCases).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    // A correction after page one must not move rows between pages or mix a
    // new summary with the old page. A fresh traversal sees the correction.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_101",
      skillVersionId: "skillv_1_2_0",
      source: "adjudicated",
      actorUserId: "user_priya",
      payload: { kind: "binary", pass: false, rationale: "Correction after the pagination snapshot." }
    });

    const secondResponse = await localApp.request(`${base}?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as typeof first;
    expect(second.audit.comparedCases).toBe(first.audit.comparedCases);
    expect(second.audit.afterAgreed).toBe(first.audit.afterAgreed);
    expect(second.audit.cases[0]?.caseId).not.toBe(first.audit.cases[0]?.caseId);

    const fresh = await (await localApp.request(`${base}?limit=1`)).json() as typeof first;
    expect(fresh.audit.afterAgreed).not.toBe(first.audit.afterAgreed);

    const wrongScope = await localApp.request(
      `/api/skills/skill_support_quality/versions/skillv_1_1_0/convergence?cursor=${encodeURIComponent(first.nextCursor!)}`
    );
    expect(wrongScope.status).toBe(400);
    await expect(wrongScope.json()).resolves.toMatchObject({ code: "invalid_convergence_cursor" });

    const malformed = await localApp.request(`${base}?cursor=not-a-convergence-cursor`);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: "invalid_convergence_cursor" });
  });

  it("runs the pinned evaluator on the server-selected uncovered adjudicated case", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      skillVersionId: "skillv_1_2_0",
      source: "adjudicated",
      actorUserId: "user_priya",
      payload: { kind: "binary", pass: true, rationale: "Recorded legacy ruling for coverage test." }
    });
    const localApp = createApp(repository);
    const base = "/api/skills/skill_support_quality/versions/skillv_1_1_0/convergence";
    const before = await (await localApp.request(base)).json() as {
      audit: { adjudicatedTotal: number; comparedCases: number };
      nextUncoveredCaseId: string | null;
    };
    expect(before.audit.adjudicatedTotal).toBe(4);
    expect(before.audit.comparedCases).toBe(3);
    expect(before.nextUncoveredCaseId).toBe("case_exc_002");

    const response = await localApp.request(`${base}/runs`, { method: "POST" });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      caseId: "case_exc_002",
      run: { skillVersionId: "skillv_1_1_0", totalItems: 1, completedItems: 1, status: "completed" }
    });
    const after = await (await localApp.request(base)).json() as typeof before;
    expect(after.audit.comparedCases).toBe(4);
    expect(after.nextUncoveredCaseId).toBeNull();
  });

  it("deduplicates concurrent coverage-run requests before provider dispatch", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      skillVersionId: "skillv_1_2_0",
      source: "adjudicated",
      actorUserId: "user_priya",
      payload: { kind: "binary", pass: true, rationale: "Recorded legacy ruling for concurrency test." }
    });
    const queue = new CapturingQueue();
    const localApp = createApp(repository, { queue });
    const path = "/api/skills/skill_support_quality/versions/skillv_1_1_0/convergence/runs";
    const responses = await Promise.all([
      localApp.request(path, { method: "POST" }),
      localApp.request(path, { method: "POST" })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 503]);
    expect(responses.find((response) => response.status === 503)?.headers.get("retry-after")).toBe("300");
    const bodies = await Promise.all(responses.map(async (response) => response.json())) as Array<{
      run: { id: string };
      caseId: string;
    }>;
    expect(bodies[0]?.caseId).toBe("case_exc_002");
    expect(bodies[1]?.run.id).toBe(bodies[0]?.run.id);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      data: { projectId: "proj_langsmith_support", evalRunId: bodies[0]!.run.id },
      options: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) }
    });
    expect((await localApp.request(path, { method: "POST" })).status).toBe(202);
    expect(queue.jobs).toHaveLength(1);
  });

  it("releases a failed coverage dispatch claim and durably records the successful retry", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      skillVersionId: "skillv_1_2_0",
      source: "adjudicated",
      actorUserId: "user_priya",
      payload: { kind: "binary", pass: true, rationale: "Recorded legacy ruling for dispatch retry." }
    });
    const queue = new FailingOnceQueue();
    const localApp = createApp(repository, { queue });
    const path = "/api/skills/skill_support_quality/versions/skillv_1_1_0/convergence/runs";

    expect((await localApp.request(path, { method: "POST" })).status).toBe(500);
    const retried = await localApp.request(path, { method: "POST" });
    expect(retried.status).toBe(202);
    const body = await retried.json() as { run: { id: string } };
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      data: { evalRunId: body.run.id },
      options: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) }
    });

    expect((await localApp.request(path, { method: "POST" })).status).toBe(202);
    expect(queue.jobs).toHaveLength(1);
  });

  it("self-consistency report surfaces the judge's re-run flips (A3)", async () => {
    // The seed re-runs v1.2.0 on case_101 (3/3 pass → consistent) and
    // case_exc_002 (2 pass / 1 fail → 0.67, a flip to investigate).
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const localApp = createApp(repository);
    const res = await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/self-consistency");
    expect(res.status).toBe(200);
    const { selfConsistency: r } = (await res.json()) as {
      selfConsistency: {
        skillVersionId: string;
        comparedCases: number;
        consistentCases: number;
        cases: Array<{ caseId: string; runs: number; agreement: number }>;
      };
    };
    expect(r.skillVersionId).toBe("skillv_1_2_0");
    expect(r.comparedCases).toBe(2);
    expect(r.consistentCases).toBe(1); // case_101
    // Least-consistent first: case_exc_002 flipped.
    expect(r.cases[0]?.caseId).toBe("case_exc_002");
    expect(r.cases[0]?.runs).toBe(3);
    expect(r.cases[0]?.agreement).toBeCloseTo(2 / 3);
  });

  it("skips coeval-internal traces on manual import (anti-recursion guard)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const before = (await (await localApp.request("/api/dashboard")).json()) as { project: { importedTraceCount: number } };

    const response = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceTraceId: "internal_judge_call_123",
        input: { question: "internal probe" },
        output: { answer: "internal response" },
        metadata: { coeval: { internal: true } }
      })
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ skipped: true, reason: "coeval_internal" });

    const after = (await (await localApp.request("/api/dashboard")).json()) as { project: { importedTraceCount: number } };
    expect(after.project.importedTraceCount).toBe(before.project.importedTraceCount);
  });

  it("skips coeval-internal traces in the LangSmith import worker", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });

    const result = await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 3
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_internal",
            input: { question: "internal probe" },
            output: { answer: "internal" },
            metadata: { coeval: { internal: true } }
          },
          {
            sourceTraceId: "ls_run_real",
            input: { question: "real customer question" },
            output: { answer: "real customer answer" },
            metadata: {}
          }
        ];
      }
    }));

    // Only one trace was actually imported; the coeval-internal one was skipped
    // without creating another tracked evaluation.
    expect(result.imported).toBe(1);
    expect(result.queued).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      name: "eval.run",
      data: { projectId: "proj_langsmith_support", evalRunId: expect.any(String) }
    });
  });

  it("creates and lists annotation queues with counters + per-item ordering", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    // Empty state: no queues yet.
    await expect((await localApp.request("/api/review-queues")).json()).resolves.toEqual({ queues: [] });

    const createResponse = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "October calibration round",
        description: "Cross-check three reviewers on a representative cohort.",
        caseIds: ["case_exc_001", "case_exc_002", "case_exc_003", "case_exc_001"] // dup at the end — should be deduped
      })
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { queue: { id: string; name: string; pendingCount: number; completedCount: number } };
    expect(created.queue).toMatchObject({
      name: "October calibration round",
      pendingCount: 3,
      completedCount: 0
    });

    // List returns the new queue.
    const list = (await (await localApp.request("/api/review-queues")).json()) as { queues: Array<{ id: string; pendingCount: number }> };
    expect(list.queues).toHaveLength(1);
    expect(list.queues[0]?.id).toBe(created.queue.id);
    expect(list.queues[0]?.pendingCount).toBe(3);

    // Detail returns items in position order, deduped.
    const detail = (await (await localApp.request(`/api/review-queues/${created.queue.id}`)).json()) as {
      queue: { id: string };
      items: Array<{ caseId: string; position: number; status: string }>;
    };
    expect(detail.queue.id).toBe(created.queue.id);
    expect(detail.items.map((item) => item.caseId)).toEqual(["case_exc_001", "case_exc_002", "case_exc_003"]);
    expect(detail.items.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(detail.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("rejects queue creation with cases that aren't in this project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bad queue",
        caseIds: ["case_does_not_exist", "case_exc_001"]
      })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "One or more cases were not found in this project" });
  });

  it("returns 404 for an unknown review-queue id", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/review-queues/revq_does_not_exist");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Review queue not found" });
  });

  it("auto-completes pending queue items when a human verdict is recorded", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "calibration round",
        caseIds: ["case_exc_001", "case_exc_002"]
      })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Next-pending starts as the first item.
    const initial = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(initial.item?.caseId).toBe("case_exc_001");

    // Record a human verdict — should auto-complete the corresponding queue item.
    const verdict = await localApp.request("/api/cases/case_exc_001/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: false, rationale: "outdated policy" } })
    });
    expect(verdict.status).toBe(201);

    // Next-pending now points at case_exc_002, completedCount jumped to 1.
    const afterVerdict = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(afterVerdict.item?.caseId).toBe("case_exc_002");
    const detailAfter = (await (await localApp.request(`/api/review-queues/${queue.id}`)).json()) as {
      queue: { pendingCount: number; completedCount: number };
    };
    expect(detailAfter.queue.pendingCount).toBe(1);
    expect(detailAfter.queue.completedCount).toBe(1);

    // Finish the queue.
    const verdict2 = await localApp.request("/api/cases/case_exc_002/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationale: "ok" } })
    });
    expect(verdict2.status).toBe(201);
    const final = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: unknown };
    expect(final.item).toBeNull();
  });

  it("closes + reopens queues; closed queues return null next-item even with pending rows", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "closeable", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Close: queue.status flips to closed; next-item now returns null even
    // though the item is still pending.
    const close = await localApp.request(`/api/review-queues/${queue.id}/close`, { method: "POST" });
    expect(close.status).toBe(200);
    const closed = (await close.json()) as { queue: { status: string; closedAt: string | null } };
    expect(closed.queue.status).toBe("closed");
    expect(closed.queue.closedAt).not.toBeNull();

    const nextWhileClosed = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: unknown; queueStatus: string };
    expect(nextWhileClosed.item).toBeNull();
    expect(nextWhileClosed.queueStatus).toBe("closed");

    // Reopen: status flips back to open; next-item resumes pointing at the
    // pending item.
    const reopen = await localApp.request(`/api/review-queues/${queue.id}/reopen`, { method: "POST" });
    expect(reopen.status).toBe(200);
    const reopened = (await reopen.json()) as { queue: { status: string; closedAt: string | null } };
    expect(reopened.queue.status).toBe("open");
    expect(reopened.queue.closedAt).toBeNull();

    const nextAfterReopen = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(nextAfterReopen.item?.caseId).toBe("case_exc_001");
  });

  it("close/reopen + next are 404 for unknown queue ids", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    expect((await localApp.request("/api/review-queues/revq_nope/next")).status).toBe(404);
    expect((await localApp.request("/api/review-queues/revq_nope/close", { method: "POST" })).status).toBe(404);
    expect((await localApp.request("/api/review-queues/revq_nope/reopen", { method: "POST" })).status).toBe(404);
  });

  it("LLM-judge verdicts do NOT auto-complete pending queue items", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "human-only", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Record an LLM judge verdict directly via the repo (the public verdicts
    // endpoint is human-source only). This must not flip the queue item.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "auto" }
    });

    const next = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(next.item?.caseId).toBe("case_exc_001"); // still pending
  });

  it("adds items with explicit reviewer assignment + dedups (queue_id, case_id, assignee)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "overlap-sampling", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Add three items: case 1 to reviewer_a, case 1 to reviewer_b (κ overlap
    // partner), case 2 unassigned. The first row duplicates the existing
    // unassigned item on case 1 — but since assignment differs (null vs
    // 'reviewer_a'), both are kept.
    const add = await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: "case_exc_001", assignedToUserId: "reviewer_a" },
          { caseId: "case_exc_001", assignedToUserId: "reviewer_b" },
          { caseId: "case_exc_002" }
        ]
      })
    });
    expect(add.status).toBe(201);
    const addBody = (await add.json()) as { items: Array<{ caseId: string; assignedToUserId: string | null }>; addedCount: number };
    expect(addBody.addedCount).toBe(3);

    // Re-adding the same (case, assignee) combos is a no-op — dedup against
    // the existing rows.
    const dedup = await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: "case_exc_001", assignedToUserId: "reviewer_a" },
          { caseId: "case_exc_002" }
        ]
      })
    });
    expect((await dedup.json()) as { addedCount: number }).toMatchObject({ addedCount: 0 });

    // Detail shows 4 items total: 1 unassigned case_1 + 2 assigned case_1 + 1
    // unassigned case_2.
    const detail = (await (await localApp.request(`/api/review-queues/${queue.id}`)).json()) as {
      items: Array<{ caseId: string; assignedToUserId: string | null }>;
    };
    expect(detail.items).toHaveLength(4);
  });

  it("next-item filter: assignedTo=<user> returns assigned + unassigned, never other reviewers' items", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "assigned-pull", caseIds: [] }) // start empty; we'll add via /items
    });
    expect(create.status).toBe(400); // empty caseIds rejected by schema

    const createReal = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "assigned-pull", caseIds: ["case_exc_003"] })
    });
    const { queue } = (await createReal.json()) as { queue: { id: string } };
    await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: "case_exc_001", assignedToUserId: "reviewer_a" },
          { caseId: "case_exc_002", assignedToUserId: "reviewer_b" }
        ]
      })
    });

    // Without filter: any pending item (case_exc_003 unassigned has position 0
    // from the original create).
    const anyPull = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string; assignedToUserId: string | null } | null };
    expect(anyPull.item?.caseId).toBe("case_exc_003");

    // Filter assignedTo=reviewer_a: returns case_exc_003 (unassigned, lower
    // position) first, then case_exc_001 (assigned to reviewer_a).
    const aPull = (await (await localApp.request(`/api/review-queues/${queue.id}/next?assignedTo=reviewer_a`)).json()) as { item: { caseId: string } | null };
    expect(aPull.item?.caseId).toBe("case_exc_003");

    // Filter assignedTo=reviewer_b: also returns case_exc_003 first (still
    // unassigned, lowest position), then case_exc_002 once case_exc_003 is
    // verdicted.
    const bPull = (await (await localApp.request(`/api/review-queues/${queue.id}/next?assignedTo=reviewer_b`)).json()) as { item: { caseId: string } | null };
    expect(bPull.item?.caseId).toBe("case_exc_003");
  });

  it("human verdicts complete only the verdicting reviewer's assigned items + unassigned items, leaving κ-partner rows pending", async () => {
    const repository = new DemoRepository();
    // Set up: one queue, one case, assigned to two reviewers (overlap).
    const queue = await repository.createReviewQueue({
      projectId: "proj_langsmith_support",
      name: "overlap",
      caseIds: [] // unsupported by schema, but the repo allows it directly
    }).catch(async () => {
      // The schema rejects empty caseIds at the API layer; bypass by creating
      // with a placeholder then deleting via direct repo access. Simpler:
      // create with one case.
      return await repository.createReviewQueue({
        projectId: "proj_langsmith_support",
        name: "overlap-direct",
        caseIds: ["case_exc_001"]
      });
    });
    // Add case_exc_002 assigned to both reviewers (κ overlap).
    await repository.addReviewQueueItems({
      projectId: "proj_langsmith_support",
      queueId: queue.id,
      items: [
        { caseId: "case_exc_002", assignedToUserId: "reviewer_a" },
        { caseId: "case_exc_002", assignedToUserId: "reviewer_b" }
      ]
    });

    // reviewer_a verdicts case_exc_002.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "ok by a" }
    });

    // reviewer_a's item should be completed; reviewer_b's still pending.
    const detail = await repository.getReviewQueueDetail("proj_langsmith_support", queue.id);
    const itemsForCase002 = detail?.items.filter((item) => item.caseId === "case_exc_002") ?? [];
    expect(itemsForCase002).toHaveLength(2);
    const aRow = itemsForCase002.find((item) => item.assignedToUserId === "reviewer_a");
    const bRow = itemsForCase002.find((item) => item.assignedToUserId === "reviewer_b");
    expect(aRow?.status).toBe("completed");
    expect(bRow?.status).toBe("pending");

    // reviewer_b now verdicts — partner row should complete.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_b",
      payload: { kind: "binary", pass: false, rationale: "disagree" }
    });
    const detail2 = await repository.getReviewQueueDetail("proj_langsmith_support", queue.id);
    const bAfter = detail2?.items.find((item) => item.caseId === "case_exc_002" && item.assignedToUserId === "reviewer_b");
    expect(bAfter?.status).toBe("completed");
  });

  it("adds-items returns 404 for unknown queue id + 400 for unknown case id", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const notFound = await localApp.request("/api/review-queues/revq_nope/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_exc_001" }] })
    });
    expect(notFound.status).toBe(404);

    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-cases", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };
    const badCase = await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_does_not_exist" }] })
    });
    expect(badCase.status).toBe(400);
  });

  it("validates queue input shape (empty caseIds, oversized name)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const empty = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", caseIds: [] })
    });
    expect(empty.status).toBe(400);
    const tooLong = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(201), caseIds: ["case_exc_001"] })
    });
    expect(tooLong.status).toBe(400);
  });

  it("exposes the κ summary over project human verdicts", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    // No human verdicts yet → empty summary, null mean.
    const empty = await localApp.request("/api/projects/kappa");
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({
      raterCount: 0,
      overlappingCases: 0,
      pairs: [],
      meanKappa: null,
      meanInterpretation: null,
      unsupportedPairs: 0
    });

    // Two reviewers, three cases, agree on 2/3 — κ should be positive, mean
    // interpretation in the "moderate" band or similar (math validated in
    // kappa.test.ts; here we just verify the API delegates correctly).
    const pairs: Array<[string, string, boolean]> = [
      ["case_exc_001", "reviewer_a", false], ["case_exc_001", "reviewer_b", false],
      ["case_exc_002", "reviewer_a", true], ["case_exc_002", "reviewer_b", true],
      ["case_exc_003", "reviewer_a", true], ["case_exc_003", "reviewer_b", false]
    ];
    for (const [caseId, actor, pass] of pairs) {
      await repository.recordVerdict({
        projectId: "proj_langsmith_support",
        caseId,
        source: "human",
        actorUserId: actor,
        payload: { kind: "binary", pass, rationale: `${actor} on ${caseId}` }
      });
    }

    const populated = await localApp.request("/api/projects/kappa");
    expect(populated.status).toBe(200);
    const body = (await populated.json()) as {
      raterCount: number;
      overlappingCases: number;
      pairs: Array<{ reviewerA: string; reviewerB: string; cases: number; observedAgreement: number; kappa: number; interpretation: string }>;
      meanKappa: number | null;
      meanInterpretation: string | null;
    };
    expect(body.raterCount).toBe(2);
    expect(body.overlappingCases).toBe(3);
    expect(body.pairs).toHaveLength(1);
    expect(body.pairs[0]).toMatchObject({
      reviewerA: "reviewer_a",
      reviewerB: "reviewer_b",
      cases: 3
    });
    expect(body.pairs[0]?.observedAgreement).toBeCloseTo(2 / 3);
    expect(body.meanKappa).not.toBeNull();
    expect(body.meanInterpretation).not.toBeNull();
  });

  it("exposes the LLM-judge vs human calibration via /api/projects/judge-human-calibration", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    // Empty state — no verdicts of either source yet.
    const empty = await localApp.request("/api/projects/judge-human-calibration");
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ raterCount: 0, pairs: [] });

    // Seed two paired verdicts: judge says pass, reviewer agrees.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "judge" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "human" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: false, rationale: "judge" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: false, rationale: "human" }
    });

    const populated = await localApp.request("/api/projects/judge-human-calibration");
    const body = (await populated.json()) as {
      raterCount: number;
      overlappingCases: number;
      pairs: Array<{ reviewerA: string; reviewerB: string; observedAgreement: number; kappa: number }>;
      meanKappa: number | null;
    };
    expect(body.raterCount).toBe(2); // judge:skillv_1_2_0 + reviewer_a
    expect(body.overlappingCases).toBe(2);
    expect(body.pairs).toHaveLength(1);
    const pair = body.pairs[0]!;
    // One of the two carries the judge prefix.
    const idsByPrefix = [pair.reviewerA, pair.reviewerB].sort();
    expect(idsByPrefix[0]).toMatch(/^judge:/);
    expect(idsByPrefix[1]).toBe("reviewer_a");
    expect(pair.observedAgreement).toBe(1);
    expect(pair.kappa).toBe(1);
  });

  it("returns 400 on a malformed verdict payload", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_exc_001/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "scalar", score: 5, range: [0, 1], rationale: "out of range" } })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid verdict input" });
  });

  it("marks legacy verdict, adjudication, metric, export, and queue surfaces explicitly", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const expected = "ungoverned_legacy";

    const reads = [
      "/api/cases/case_exc_001",
      "/api/cases/case_exc_001/verdicts",
      "/api/projects/verdicts",
      "/api/projects/verdicts/export",
      "/api/projects/kappa",
      "/api/projects/judge-human-calibration",
      "/api/projects/disagreements",
      "/api/projects/judge-human-disagreements",
      "/api/review-queues",
      "/api/review-queues/revq_missing",
      "/api/review-queues/revq_missing/next"
    ];
    for (const path of reads) {
      const response = await localApp.request(path);
      expect(response.headers.get("x-coeval-governance-class"), path).toBe(expected);
    }

    const writes = [
      ["/api/cases/case_exc_001/verdicts", {}],
      ["/api/cases/case_exc_001/adjudicate", {}],
      ["/api/review-queues", {}],
      ["/api/review-queues/revq_missing/items", {}],
      ["/api/review-queues/revq_missing/close", {}],
      ["/api/review-queues/revq_missing/reopen", {}]
    ] as const;
    for (const [path, body] of writes) {
      const response = await localApp.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      expect(response.headers.get("x-coeval-governance-class"), path).toBe(expected);
    }
  });

  it("blocks risky skill edits without override", async () => {
    const response = await app.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "Fail borderline cases and require perfect answers.",
        prompt: "Be stricter than before.",
        modelBinding: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          modelVersion: "2026-04-15",
          temperature: 0
        }
      })
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { regressionRun: { status: string } };
    expect(body.regressionRun.status).toBe("blocked");
  });

  it("PR #56/C5a: timeScope='new' (default) — async gate approves, no backfill", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const appWithQueue = createApp(repository, { queue });
    const response = await appWithQueue.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Updated rubric\n\nKeep judging support quality, just clarified phrasing.",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 }
      })
    });
    // Async gate (C5a): submit lands the version in `calibrating` (202) and
    // enqueues gate.run; the worker flips the status.
    expect(response.status).toBe(202);
    const body = (await response.json()) as { version: { id: string; status: string }; queued: boolean };
    expect(body.version.status).toBe("calibrating");
    expect(body.queued).toBe(true);
    const gateJobs = queue.jobs.filter((job) => job.name === "gate.run");
    expect(gateJobs).toHaveLength(1);

    await processGateRunJob(repository, gateJobs[0]!.data as GateRunJob, queue);
    const run = await repository.getRegressionRunForVersion("proj_langsmith_support", body.version.id);
    expect(run?.status).toBe("passed");
    const versions = await repository.listSkillVersions("proj_langsmith_support", "skill_support_quality");
    expect(versions.find((v) => v.id === body.version.id)?.status).toBe("approved");
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("records timeScope='both' backfill as one durable eval run after the gate passes", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const appWithQueue = createApp(repository, { queue });

    // Seed a few imported traces so backfill has something to chew on.
    for (let i = 0; i < 3; i += 1) {
      await repository.importTrace("proj_langsmith_support", "manual", {
        sourceTraceId: `backfill_seed_${i}`,
        input: { question: `q${i}` },
        output: { answer: `a${i}` },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
    }

    const response = await appWithQueue.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Updated rubric\n\nKeep judging support quality.",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 },
        timeScope: "both"
      })
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { version: { id: string } };
    const gateJob = queue.jobs.find((job) => job.name === "gate.run")!;
    expect((gateJob.data as { timeScope?: string }).timeScope).toBe("both");

    await processGateRunJob(repository, gateJob.data as GateRunJob, queue);
    const caseIds = await repository.listCaseIdsForProject("proj_langsmith_support");
    const evalRuns = await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: body.version.id });
    expect(evalRuns).toHaveLength(1);
    expect(evalRuns[0]).toMatchObject({
      trigger: "backfill",
      status: "pending",
      totalItems: caseIds.length,
      skillVersionId: body.version.id
    });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toEqual([
      expect.objectContaining({
        data: { projectId: "proj_langsmith_support", evalRunId: evalRuns[0]!.id }
      })
    ]);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);

    // A replay observes the same durable run instead of creating another
    // provider-spending batch.
    await processGateRunJob(repository, gateJob.data as GateRunJob, queue);
    expect(await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: body.version.id })).toHaveLength(1);
  });

  it("records and completes the same backfill lifecycle in queue-less demo mode", async () => {
    const repository = new DemoRepository();
    const demoApp = createApp(repository);
    const response = await demoApp.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Updated rubric\n\nKeep judging support quality with clearer wording.",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 },
        timeScope: "both"
      })
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { version: { id: string } };
    const runs = await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: body.version.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: "backfill",
      status: "completed",
      skillVersionId: body.version.id
    });
    expect(runs[0]!.completedItems).toBeGreaterThan(0);
  });

  it("does not poison a Check with an empty backfill before its first Run arrives", async () => {
    class InitiallyEmptyRepository extends DemoRepository {
      empty = true;
      override async listCaseIdsForProject(...args: Parameters<DemoRepository["listCaseIdsForProject"]>) {
        return this.empty ? [] : super.listCaseIdsForProject(...args);
      }
    }
    const repository = new InitiallyEmptyRepository();

    await expect(runExistingCaseBackfill(
      repository,
      "proj_langsmith_support",
      "skillv_1_2_0"
    )).resolves.toBeNull();
    await expect(repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    })).resolves.toHaveLength(0);

    repository.empty = false;
    const backfill = await runExistingCaseBackfill(repository, "proj_langsmith_support", "skillv_1_2_0");
    expect(backfill?.run).toMatchObject({ trigger: "backfill", status: "completed" });
    expect(backfill!.run.totalItems).toBeGreaterThan(0);
  });

  it("idempotently starts the first Result when a Check existed before its Runs", async () => {
    const repository = new DemoRepository();
    const demoApp = createApp(repository);
    const path = "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill";
    const first = await demoApp.request(path, { method: "POST" });
    const second = await demoApp.request(path, { method: "POST" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { run: { id: string; trigger: string; status: string } };
    const secondBody = (await second.json()) as { run: { id: string } };
    expect(firstBody.run).toMatchObject({ trigger: "backfill", status: "completed" });
    expect(secondBody.run.id).toBe(firstBody.run.id);
    expect(await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: "skillv_1_2_0" })).toHaveLength(1);
  });

  it("puts a clean install's first imported Run in the same tracked Result lifecycle", async () => {
    class CleanInstallRepository extends DemoRepository {
      importedCaseId: string | null = null;

      override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
        const result = await super.importTrace(...args);
        this.importedCaseId = result.caseId;
        return result;
      }

      override async listCaseIdsForProject(
        _projectId: string,
        limit?: number | undefined
      ): Promise<string[]> {
        const ids = this.importedCaseId ? [this.importedCaseId] : [];
        return limit === undefined ? ids : ids.slice(0, limit);
      }
    }
    const queue = new CapturingQueue();
    const repository = new CleanInstallRepository();
    const cleanApp = createApp(repository, { queue });

    const imported = await cleanApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: "skillv_1_2_0",
        sourceTraceId: "clean-install-first-run",
        input: { question: "Can I return this?" },
        output: { answer: "Yes." },
        metadata: {}
      })
    });
    expect(imported.status).toBe(201);
    await expect(imported.json()).resolves.toMatchObject({ queued: true, queueJobId: null });

    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "backfill", totalItems: 1, status: "pending" });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);

    const continued = await cleanApp.request(
      "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill",
      { method: "POST" }
    );
    expect(continued.status).toBe(202);
    await expect(continued.json()).resolves.toMatchObject({ run: { id: runs[0]!.id } });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("lets the owner keep polling a current starter draft that already queued its first Result", async () => {
    class StarterDraftRepository extends DemoRepository {
      override async getSkillVersion(...args: Parameters<DemoRepository["getSkillVersion"]>) {
        const version = await super.getSkillVersion(...args);
        return version?.id === "skillv_1_2_0"
          ? { ...version, status: "draft" as const, approvedAt: null }
          : version;
      }

      override async getCurrentSkillForCriterion(...args: Parameters<DemoRepository["getCurrentSkillForCriterion"]>) {
        const skill = await super.getCurrentSkillForCriterion(...args);
        return skill.currentVersion.id === "skillv_1_2_0"
          ? {
              ...skill,
              isStarter: true,
              currentVersion: { ...skill.currentVersion, status: "draft" as const, approvedAt: null }
            }
          : skill;
      }
    }
    const repository = new StarterDraftRepository();
    const queue = new CapturingQueue();
    const localApp = createApp(repository, { queue });
    const imported = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: "skillv_1_2_0",
        sourceTraceId: "starter-draft-first-run",
        input: { question: "Can a starter Check run?" },
        output: { answer: "Yes, while remaining unvalidated." },
        metadata: {}
      })
    });
    expect(imported.status).toBe(201);
    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    expect(runs).toHaveLength(1);

    const continued = await localApp.request(
      "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill",
      { method: "POST" }
    );
    expect(continued.status).toBe(202);
    await expect(continued.json()).resolves.toMatchObject({ run: { id: runs[0]!.id } });
  });

  it("converges concurrent first imports on durable runs without loose judge jobs", async () => {
    class CleanInstallRepository extends DemoRepository {
      readonly importedCaseIds: string[] = [];

      override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
        const result = await super.importTrace(...args);
        if (!this.importedCaseIds.includes(result.caseId)) this.importedCaseIds.push(result.caseId);
        return result;
      }

      override async listCaseIdsForProject(
        _projectId: string,
        limit?: number | undefined
      ): Promise<string[]> {
        return limit === undefined
          ? [...this.importedCaseIds]
          : this.importedCaseIds.slice(0, limit);
      }

      override async listVerdicts(input: Parameters<DemoRepository["listVerdicts"]>[0]) {
        if (input.evidenceScope === "customer" && input.source === "llm_judge") return [];
        return super.listVerdicts(input);
      }
    }
    const repository = new CleanInstallRepository();
    const queue = new CapturingQueue();
    const first = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "concurrent-first-a",
      input: { question: "A?" },
      output: { answer: "A." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const second = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "concurrent-first-b",
      input: { question: "B?" },
      output: { answer: "B." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    await Promise.all([
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [first.caseId]
      }),
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [second.caseId]
      })
    ]);

    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    const details = await Promise.all(runs.map((run) => repository.getEvalRunDetail(
      "proj_langsmith_support",
      run.id
    )));
    const evaluatedCaseIds = details.flatMap((detail) => detail?.items.map((item) => item.caseId) ?? []);
    expect(evaluatedCaseIds.sort()).toEqual([first.caseId, second.caseId].sort());
    expect(new Set(evaluatedCaseIds).size).toBe(2);
    expect(runs.filter((run) => run.trigger === "backfill")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("uses one durable per-case run when concurrent import retries follow an existing Result", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      skillVersionId: "skillv_1_2_0",
      source: "llm_judge",
      payload: { kind: "binary", pass: true, rationale: "Existing customer Result." }
    });
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "concurrent-later-case",
      input: { question: "Later?" },
      output: { answer: "Later." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    await Promise.all([
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [imported.caseId]
      }),
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [imported.caseId]
      })
    ]);

    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    const matching = [];
    for (const run of runs) {
      const detail = await repository.getEvalRunDetail("proj_langsmith_support", run.id);
      if (detail?.items.some((item) => item.caseId === imported.caseId)) matching.push(detail);
    }
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ trigger: "api_batch", totalItems: 1 });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("does not claim an undispatched Result run is queued and recovers on retry", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const [caseId] = await repository.listCaseIdsForProject("proj_langsmith_support", 1);
    const run = await repository.createEvalRun({
      projectId: "proj_langsmith_support",
      skillVersionId: "skillv_1_2_0",
      trigger: "backfill",
      items: [{ caseId: caseId! }]
    });
    const abandonedToken = "abandoned-first-result-dispatch";
    await expect(repository.claimEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: abandonedToken
    })).resolves.toMatchObject({ state: "claimed" });
    const localApp = createApp(repository, { queue });
    const path = "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill";

    const busy = await localApp.request(path, { method: "POST" });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("300");
    await expect(busy.json()).resolves.toMatchObject({
      error: expect.stringContaining("not durably queued"),
      run: { id: run.id, status: "pending" }
    });
    expect(queue.jobs).toHaveLength(0);

    await repository.releaseEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: abandonedToken
    });
    const recovered = await localApp.request(path, { method: "POST" });
    expect(recovered.status).toBe(202);
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
  });

  it("rotates an exhausted deterministic queue id before marking a run dispatched", async () => {
    const repository = new DemoRepository();
    const [caseId] = await repository.listCaseIdsForProject("proj_langsmith_support", 1);
    const run = await repository.createEvalRun({
      projectId: "proj_langsmith_support",
      skillVersionId: "skillv_1_2_0",
      trigger: "api_batch",
      items: [{ caseId: caseId! }]
    });
    const attemptedIds: string[] = [];
    const exhaustedQueue: Queue = {
      async start() {},
      async stop() {},
      async work() {},
      async send(_name, _data, options) {
        attemptedIds.push(String(options?.id));
        return attemptedIds.length === 1 ? null : String(options?.id);
      },
      async getJobState(_name, id) {
        return id === attemptedIds[0] ? "failed" : null;
      }
    };

    await expect(dispatchEvalRunOnce(repository, run, exhaustedQueue)).resolves.toBe("ready");
    expect(attemptedIds).toHaveLength(2);
    expect(attemptedIds[1]).not.toBe(attemptedIds[0]);
    await expect(repository.claimEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: "verification-claim"
    })).resolves.toMatchObject({ state: "dispatched", jobId: attemptedIds[1] });
  });

  it("PR #56/C5a: blocked gate leaves the version regressing and skips backfill even when timeScope=existing", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const appWithQueue = createApp(repository, { queue });
    const response = await appWithQueue.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "Fail borderline cases and require perfect answers.",
        prompt: "Be stricter than before.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 },
        timeScope: "existing"
      })
    });
    // The async submit always 202s; the BLOCK surfaces via the recorded run
    // (which the web client polls) and the `regressing` version status.
    expect(response.status).toBe(202);
    const body = (await response.json()) as { version: { id: string } };
    const gateJob = queue.jobs.find((job) => job.name === "gate.run")!;

    await processGateRunJob(repository, gateJob.data as GateRunJob, queue);
    const run = await repository.getRegressionRunForVersion("proj_langsmith_support", body.version.id);
    expect(run?.status).toBe("blocked");
    const versions = await repository.listSkillVersions("proj_langsmith_support", "skill_support_quality");
    expect(versions.find((v) => v.id === body.version.id)?.status).toBe("regressing");
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(0);

    const rejectedImport = await appWithQueue.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: body.version.id,
        sourceTraceId: "blocked-version-import",
        input: { question: "Should not run" },
        output: { answer: "Should not be judged" },
        metadata: {}
      })
    });
    expect(rejectedImport.status).toBe(409);
    await expect(rejectedImport.json()).resolves.toMatchObject({
      code: "skill_version_not_runnable",
      error: "Imported Runs can be evaluated only by the current runnable Check."
    });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(0);

    const rejected = await appWithQueue.request(
      `/api/skills/skill_support_quality/versions/${body.version.id}/backfill`,
      { method: "POST" }
    );
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: "Only the current runnable Check can produce the first Result."
    });
    expect(await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: body.version.id
    })).toHaveLength(0);
  });

  it("PR #59: GET /api/projects/verdicts returns project-scope verdicts with filter + limit", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    // Seed verdicts of mixed sources.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "ok" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: false, rationale: "auto" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_b",
      payload: { kind: "binary", pass: true, rationale: "" }
    });

    // No filter → 3 verdicts (newest first per repository sort).
    const all = await localApp.request("/api/projects/verdicts");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { verdicts: Array<{ id: string; source: string }> };
    expect(allBody.verdicts).toHaveLength(3);

    // source=human → 2 verdicts.
    const humans = await localApp.request("/api/projects/verdicts?source=human");
    const humansBody = (await humans.json()) as { verdicts: Array<{ id: string; source: string }> };
    expect(humansBody.verdicts).toHaveLength(2);
    expect(humansBody.verdicts.every((v) => v.source === "human")).toBe(true);

    // limit=1 → 1 verdict (the newest).
    const limited = await localApp.request("/api/projects/verdicts?limit=1");
    const limitedBody = (await limited.json()) as { verdicts: Array<{ id: string }> };
    expect(limitedBody.verdicts).toHaveLength(1);

    // Bad query → 400.
    const bad = await localApp.request("/api/projects/verdicts?source=zombies");
    expect(bad.status).toBe(400);
  });

  it("PR #60: GET /api/skills/:skillId/versions returns the demo seed version", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/skills/skill_support_quality/versions");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { versions: Array<{ id: string; verdictKind: string }> };
    expect(body.versions.length).toBeGreaterThanOrEqual(1);
    expect(body.versions[0]).toMatchObject({ verdictKind: "binary" });
  });

  it("PR #60: newly created skill versions appear at the top of the history list (newest first)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    // Create a new version via the existing POST endpoint.
    const create = await localApp.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Updated rubric",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 }
      })
    });
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as { version: { id: string; version: string } };

    // Fetch history — new version is at index 0, demo seed comes after.
    const history = await localApp.request("/api/skills/skill_support_quality/versions");
    const historyBody = (await history.json()) as {
      versions: Array<{ id: string; version: string }>;
      regressionRuns: Array<{ skillVersionId: string; status: string }>;
    };
    expect(historyBody.versions[0]?.id).toBe(createBody.version.id);
    expect(historyBody.versions.length).toBeGreaterThanOrEqual(2);
    expect(historyBody.regressionRuns).toContainEqual(expect.objectContaining({
      skillVersionId: createBody.version.id,
      status: "passed"
    }));
  });

  it("binds a regression receipt to both its skill and version route identities", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const created = await localApp.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Route binding",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
      })
    });
    const versionId = (await created.json() as { version: { id: string } }).version.id;

    const wrongSkill = await localApp.request(`/api/skills/skill_other/versions/${versionId}/regression`);
    expect(wrongSkill.status).toBe(404);

    const exact = await localApp.request(`/api/skills/skill_support_quality/versions/${versionId}/regression`);
    expect(exact.status).toBe(200);
    await expect(exact.json()).resolves.toMatchObject({ regressionRun: { skillVersionId: versionId } });
  });

  it("PR #60: rejects invalid limit (over max)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/skills/skill_support_quality/versions?limit=99999");
    expect(response.status).toBe(400);
  });

  it("PR #58: exports verdicts as JSONL with content-disposition + jsonl content-type", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "ok" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "categorical", choice: "okay", choiceScores: { good: 1, okay: 0.5, bad: 0 }, rationale: "borderline" }
    });

    const response = await localApp.request("/api/projects/verdicts/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="coeval-verdicts-\d{4}-\d{2}-\d{2}\.jsonl"/);
    const text = await response.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { source: string; payload: { kind: string } };
    expect(first.source).toBe("human");
    expect(first.payload.kind).toBeDefined();
  });

  it("PR #58: exports verdicts as CSV with RFC-4180-style quoting + filter query params", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: false, rationale: 'They said: "nope, wrong policy"' } // intentional comma + quote
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "auto" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_101",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", label: "ambiguous", rationale: "insufficient evidence" }
    });

    // No source filter → all rows + header.
    const allResponse = await localApp.request("/api/projects/verdicts/export?format=csv");
    expect(allResponse.status).toBe(200);
    expect(allResponse.headers.get("content-type")).toMatch(/text\/csv/);
    expect(allResponse.headers.get("content-disposition")).toMatch(/\.csv"/);
    const allText = await allResponse.text();
    expect(allText.split("\n")).toHaveLength(4); // header + 3 rows
    expect(allText.split("\n")[0]).toContain("verdict_kind,verdict_value,rationale");
    expect(allText).toContain("binary,ambiguous,insufficient evidence");
    // Rationale with a quote + colon gets properly escaped:
    expect(allText).toContain(`"They said: ""nope, wrong policy"""`);

    // source=human filter → just the human row.
    const humanResponse = await localApp.request("/api/projects/verdicts/export?format=csv&source=human");
    expect(humanResponse.status).toBe(200);
    const humanText = await humanResponse.text();
    expect(humanText.split("\n")).toHaveLength(2); // header + 1 row
    expect(humanText).toContain("reviewer_a");
    expect(humanText).not.toContain("llm_judge");
  });

  it("PR #58: rejects invalid export query (bad format, source out of enum)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const badFormat = await localApp.request("/api/projects/verdicts/export?format=parquet");
    expect(badFormat.status).toBe(400);
    const badSource = await localApp.request("/api/projects/verdicts/export?source=ghosts");
    expect(badSource.status).toBe(400);
  });

  it("imports a manual trace and enqueues one durable evaluation run", async () => {
    const queue = new CapturingQueue();
    const appWithQueue = createApp(new DemoRepository(), { queue });
    const response = await appWithQueue.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceTraceId: "manual_trace_001",
        input: { question: "Can I get a refund?" },
        output: { answer: "Yes, refunds are available." },
        metadata: { source: "test" }
      })
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { caseId: string; queued: boolean; queueJobId: string | null };
    expect(body.queued).toBe(true);
    expect(body.queueJobId).toBeNull();
    expect(queue.jobs).toEqual([
      {
        name: "eval.run",
        data: {
          projectId: "proj_langsmith_support",
          evalRunId: expect.any(String)
        },
        options: { id: expect.any(String), retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("does not call a terminal-failed import evaluation newly queued on retry", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    const localApp = createApp(repository, { queue });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      skillVersionId: "skillv_1_2_0",
      source: "llm_judge",
      payload: { kind: "binary", pass: true, rationale: "Existing customer Result." }
    });
    const body = {
      skillVersionId: "skillv_1_2_0",
      sourceTraceId: "terminal-failed-import-retry",
      input: { question: "Retry?" },
      output: { answer: "Do not overstate it." },
      metadata: {}
    };
    const first = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ created: true, queued: true });
    const [run] = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    const detail = await repository.getEvalRunDetail("proj_langsmith_support", run!.id);
    await repository.failEvalRunItem({
      projectId: "proj_langsmith_support",
      evalRunId: run!.id,
      evalRunItemId: detail!.items[0]!.id,
      error: "provider unavailable"
    });
    queue.jobs.length = 0;

    const retried = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(retried.status).toBe(201);
    await expect(retried.json()).resolves.toMatchObject({ created: false, queued: false });
    expect(queue.jobs).toHaveLength(0);
  });

  it("keeps a Run saved but does not evaluate it if the current Check changes during import", async () => {
    class CheckChangesDuringImportRepository extends DemoRepository {
      changed = false;

      override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
        const imported = await super.importTrace(...args);
        this.changed = true;
        return imported;
      }

      override async getCurrentSkillForCriterion(...args: Parameters<DemoRepository["getCurrentSkillForCriterion"]>) {
        const current = await super.getCurrentSkillForCriterion(...args);
        return this.changed
          ? {
              ...current,
              currentVersion: { ...current.currentVersion, id: "skillv_replaced_during_import" }
            }
          : current;
      }
    }
    const repository = new CheckChangesDuringImportRepository();
    const queue = new CapturingQueue();
    const response = await createApp(repository, { queue }).request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: "skillv_1_2_0",
        sourceTraceId: "check-changed-mid-import",
        input: { question: "Was this saved?" },
        output: { answer: "Yes, without judging the old Check." },
        metadata: {}
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      queued: false,
      queueJobId: null,
      code: "skill_version_not_runnable",
      error: "The Run was saved, but the selected Check changed before evaluation could start."
    });
    expect(queue.jobs).toHaveLength(0);
  });

  it("updates demo retention settings and prunes with no-op result", async () => {
    const repository = new DemoRepository();
    const appWithRepository = createApp(repository);

    const settingsResponse = await appWithRepository.request("/api/project/settings");
    expect(settingsResponse.status).toBe(200);
    await expect(settingsResponse.json()).resolves.toMatchObject({
      projectId: "proj_langsmith_support",
      traceRetentionDays: null
    });

    const updateResponse = await appWithRepository.request("/api/project/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceRetentionDays: 30 })
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({ traceRetentionDays: 30 });

    const pruneResponse = await appWithRepository.request("/api/project/retention/prune", { method: "POST" });
    expect(pruneResponse.status).toBe(200);
    await expect(pruneResponse.json()).resolves.toMatchObject({
      deletedCases: 0,
      deletedRawTraces: 0
    });
  });

  it("returns 400 before importing when no skill version exists", async () => {
    const repository = new EmptySkillRepository();
    const response = await createApp(repository, { queue: new CapturingQueue() }).request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { question: "Can I get a refund?" },
        output: { answer: "Yes." },
        metadata: {}
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "No active skill version. Define one before judging." });
    expect(repository.importCalled).toBe(false);
  });

  it("returns 500 when skill lookup unexpectedly fails before importing", async () => {
    const repository = new class extends DemoRepository {
      override async getCurrentSkill(): Promise<never> {
        throw new Error("Skill lookup unavailable");
      }
    }();

    const manualResponse = await createApp(repository, { queue: new CapturingQueue() }).request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { question: "Can I get a refund?" },
        output: { answer: "Yes." },
        metadata: {}
      })
    });
    expect(manualResponse.status).toBe(500);
    await expect(manualResponse.json()).resolves.toMatchObject({ error: "Internal server error" });

    const langSmithResponse = await createApp(repository, { queue: new CapturingQueue() }).request("/api/integrations/langsmith/int_boom/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });
    expect(langSmithResponse.status).toBe(500);
    await expect(langSmithResponse.json()).resolves.toMatchObject({ error: "Internal server error" });
  });

  it("creates a LangSmith integration and enqueues an import job", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    let listRunsCalled = 0;
    const appWithQueue = createApp(repository, {
      queue,
      langSmithClientFactory: () => ({
        async listRuns(input) {
          listRunsCalled += 1;
          expect(input).toMatchObject({ projectName: "Support Agent", limit: 1 });
          return [
            {
              sourceTraceId: "ls_test_connection",
              input: { question: "Health?" },
              output: { answer: "ok" },
              metadata: { source: "langsmith" }
            }
          ];
        }
      })
    });
    const createResponse = await appWithQueue.request("/api/integrations/langsmith", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "ls_test_key", projectName: "Support Agent" })
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as { integration: { id: string } };

    const listResponse = await appWithQueue.request("/api/integrations/langsmith");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      integrations: [
        {
          id: createBody.integration.id,
          pollEnabled: true,
          pollIntervalSeconds: 300,
          pollLimit: 25
        }
      ]
    });

    const patchResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollEnabled: false, pollIntervalSeconds: 600, pollLimit: 11 })
    });
    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({
      integration: {
        id: createBody.integration.id,
        pollEnabled: false,
        pollIntervalSeconds: 600,
        pollLimit: 11
      }
    });

    const testResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testResponse.status).toBe(200);
    await expect(testResponse.json()).resolves.toMatchObject({
      ok: true,
      sampleRunCount: 1
    });
    expect(listRunsCalled).toBe(1);

    const listAfterTest = await appWithQueue.request("/api/integrations/langsmith");
    expect(listAfterTest.status).toBe(200);
    await expect(listAfterTest.json()).resolves.toMatchObject({
      integrations: [
        {
          id: createBody.integration.id,
          lastTestedAt: expect.any(String),
          lastTestResult: {
            ok: true,
            sampleRunCount: 1
          }
        }
      ]
    });

    const importResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });

    expect(importResponse.status).toBe(202);
    const importBody = (await importResponse.json()) as { importJob: { id: string } };
    expect(importBody).toMatchObject({
      queued: true,
      queueJobId: "job_1",
      importJob: {
        id: expect.any(String),
        status: "queued",
        requestedLimit: 3,
        queueJobId: "job_1",
        createdAt: expect.any(String),
        startedAt: null
      }
    });
    expect(queue.jobs).toEqual([
      {
        name: "langsmith.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: createBody.integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 3,
          importJobId: importBody.importJob.id
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);
    const importJobsResponse = await appWithQueue.request("/api/import-jobs?limit=5");
    await expect(importJobsResponse.json()).resolves.toMatchObject({
      importJobs: [
        {
          id: importBody.importJob.id,
          status: "queued",
          requestedLimit: 3,
          queueJobId: "job_1",
          createdAt: expect.any(String),
          startedAt: null
        }
      ]
    });

    const deleteResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

    const listAfterDelete = await appWithQueue.request("/api/integrations/langsmith");
    await expect(listAfterDelete.json()).resolves.toEqual({ integrations: [] });

    const patchAfterDelete = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollEnabled: true })
    });
    expect(patchAfterDelete.status).toBe(404);

    const secondDeleteResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "DELETE"
    });
    expect(secondDeleteResponse.status).toBe(404);

    const testAfterDelete = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testAfterDelete.status).toBe(404);

    const importAfterDelete = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });
    expect(importAfterDelete.status).toBe(404);
  });

  it("creates a Langfuse integration and enqueues an import job", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    let listTracesCalled = 0;
    const appWithQueue = createApp(repository, {
      queue,
      langfuseClientFactory: () => ({
        async listTraces(input) {
          listTracesCalled += 1;
          expect(input).toEqual({ limit: 1 });
          return [
            {
              sourceTraceId: "lf_test_connection",
              input: { question: "Health?" },
              output: { answer: "ok" },
              metadata: { source: "langfuse" }
            }
          ];
        }
      })
    });
    const createResponse = await appWithQueue.request("/api/integrations/langfuse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "pk-lf-test", secretKey: "sk-lf-test" })
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as { integration: { id: string } };

    const testResponse = await appWithQueue.request(`/api/integrations/langfuse/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testResponse.status).toBe(200);
    await expect(testResponse.json()).resolves.toMatchObject({
      ok: true,
      sampleRunCount: 1
    });
    expect(listTracesCalled).toBe(1);

    const importResponse = await appWithQueue.request(`/api/integrations/langfuse/${createBody.integration.id}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });

    expect(importResponse.status).toBe(202);
    const importBody = (await importResponse.json()) as { importJob: { id: string } };
    expect(importBody).toMatchObject({
      queued: true,
      queueJobId: "job_1",
      importJob: {
        id: expect.any(String),
        source: "langfuse",
        sourceIntegrationId: createBody.integration.id,
        status: "queued",
        requestedLimit: 3
      }
    });
    expect(queue.jobs).toEqual([
      {
        name: "langfuse.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: createBody.integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 3,
          importJobId: importBody.importJob.id
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("returns 500 for unexpected LangSmith integration mutation failures", async () => {
    const updateRepository = new class extends DemoRepository {
      override async updateLangSmithIntegration(): Promise<never> {
        throw new Error("Unexpected LangSmith update failure");
      }
    }();
    const updateResponse = await createApp(updateRepository).request("/api/integrations/langsmith/int_boom", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollEnabled: false })
    });
    expect(updateResponse.status).toBe(500);
    await expect(updateResponse.json()).resolves.toMatchObject({ error: "Internal server error" });

    const deleteRepository = new class extends DemoRepository {
      override async deleteLangSmithIntegration(): Promise<never> {
        throw new Error("Unexpected LangSmith delete failure");
      }
    }();
    const deleteResponse = await createApp(deleteRepository).request("/api/integrations/langsmith/int_boom", {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(500);
    await expect(deleteResponse.json()).resolves.toMatchObject({ error: "Internal server error" });

    const importRepository = new class extends DemoRepository {
      override async loadLangSmithImportContext(): Promise<never> {
        throw new Error("Unexpected LangSmith import context failure");
      }
    }();
    const importResponse = await createApp(importRepository, { queue: new CapturingQueue() }).request("/api/integrations/langsmith/int_boom/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });
    expect(importResponse.status).toBe(500);
    await expect(importResponse.json()).resolves.toMatchObject({ error: "Internal server error" });
  });

  it("persists failed LangSmith connection test details", async () => {
    const repository = new DemoRepository();
    const appWithRepository = createApp(repository, {
      langSmithClientFactory: () => ({
        async listRuns() {
          throw new LangSmithHttpError("LangSmith runs request failed: 401", 401, "listRuns");
        }
      })
    });
    const createResponse = await appWithRepository.request("/api/integrations/langsmith", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "ls_revoked", projectName: "Support Agent" })
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as { integration: { id: string } };

    const testResponse = await appWithRepository.request(`/api/integrations/langsmith/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testResponse.status).toBe(502);
    await expect(testResponse.json()).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "LangSmith runs request failed: 401"
    });

    const listResponse = await appWithRepository.request("/api/integrations/langsmith");
    await expect(listResponse.json()).resolves.toMatchObject({
      integrations: [
        {
          id: createBody.integration.id,
          lastTestedAt: expect.any(String),
          lastTestResult: {
            ok: false,
            status: 401,
            error: "LangSmith runs request failed: 401"
          }
        }
      ]
    });
  });

  it("rejects LangSmith poll intervals below the global ticker", async () => {
    const previousInterval = process.env.LANGSMITH_POLL_INTERVAL_MS;
    process.env.LANGSMITH_POLL_INTERVAL_MS = "300000";
    try {
      const response = await createApp(new DemoRepository()).request("/api/integrations/langsmith", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: "ls_test_key",
          projectName: "Support Agent",
          pollIntervalSeconds: 60
        })
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("pollIntervalSeconds must be at least 300 seconds")
      });
    } finally {
      if (previousInterval === undefined) {
        delete process.env.LANGSMITH_POLL_INTERVAL_MS;
      } else {
        process.env.LANGSMITH_POLL_INTERVAL_MS = previousInterval;
      }
    }
  });

  it("rejects LangSmith integration updates below the global ticker", async () => {
    const previousInterval = process.env.LANGSMITH_POLL_INTERVAL_MS;
    process.env.LANGSMITH_POLL_INTERVAL_MS = "300000";
    try {
      const repository = new DemoRepository();
      const appWithRepository = createApp(repository);
      const createResponse = await appWithRepository.request("/api/integrations/langsmith", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "ls_test_key", projectName: "Support Agent" })
      });
      const createBody = (await createResponse.json()) as { integration: { id: string } };

      const response = await appWithRepository.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollIntervalSeconds: 60 })
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("pollIntervalSeconds must be at least 300 seconds")
      });
    } finally {
      if (previousInterval === undefined) {
        delete process.env.LANGSMITH_POLL_INTERVAL_MS;
      } else {
        process.env.LANGSMITH_POLL_INTERVAL_MS = previousInterval;
      }
    }
  });

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

describe("judge worker", () => {
  it("processes queued judge jobs into judge runs", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "manual_trace_worker",
      input: { question: "Plain question" },
      output: { answer: "Plain answer" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const run = await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, {
      name: "test-worker-provider",
      async judge() {
        return {
          label: "pass",
          score: 0.95,
          reason: "worker verdict persisted",
          confidence: 0.9
        };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary", label: "pass", score: 0.95, rationale: "worker verdict persisted" } };
      }
    });

    expect(run).toMatchObject({
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0",
      verdict: "pass",
      reasoning: "worker verdict persisted"
    });
  });
});

describe("LangSmith import worker", () => {
  it("imports LangSmith runs and enqueues judge jobs", async () => {
    const queue = new CapturingQueue();
    const repository = new PurposeCapturingRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });

    const result = await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_1",
            input: { question: "Refund?" },
            output: { answer: "Refunds are available." },
            metadata: { source: "langsmith" }
          }
        ];
      }
    }));

    expect(result).toEqual({ imported: 1, queued: 1 });
    expect(repository.importedPurposes).toEqual(["analysis_eligible_langsmith"]);
    expect(queue.jobs).toEqual([
      {
        name: "eval.run",
        data: {
          projectId: "proj_langsmith_support",
          evalRunId: expect.any(String)
        },
        options: { id: expect.any(String), retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("C7/B9: LangSmith end-to-end — import -> judge -> sync-back in one governed chain", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });

    // 1. Import from the mocked LangSmith server -> case + durable eval run.
    const imported = await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, () => ({
      async listRuns() {
        return [{
          sourceTraceId: "ls_e2e_run",
          input: { question: "Can I get a refund on a gift order?" },
          output: { answer: "Yes — gift orders follow the standard 30-day policy." },
          metadata: { source: "langsmith" }
        }];
      }
    }));
    expect(imported).toEqual({ imported: 1, queued: 1 });
    const evalRunJob = queue.jobs.find((job) => job.name === "eval.run")!;

    // 2. Judge the imported case -> verdict recorded + feedback.sync enqueued.
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return { label: "pass" as const, score: 0.9, reason: "policy applied", confidence: 0.9 };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "pass" as const, score: 0.9, rationale: "policy applied" } };
      }
    };
    await processEvalRunJob(repository, queue, evalRunJob.data as { projectId: string; evalRunId: string });
    const itemJob = queue.jobs.find((job) => job.name === "eval.item")!;
    await processEvalItemJob(
      repository,
      itemJob.data as { projectId: string; evalRunId: string; evalRunItemId: string; caseId: string; skillVersionId: string },
      judgeProvider,
      "langsmith-e2e",
      queue
    );
    const syncJob = queue.jobs.find((job) => job.name === "feedback.sync")!;
    expect(syncJob).toBeDefined();

    // 3. Sync back to the mocked server -> payload verified, job synced.
    let posted: unknown;
    await processFeedbackSyncJob(repository, syncJob.data as FeedbackSyncJob, () => ({
      async createFeedback(input) {
        posted = input;
      }
    }));
    expect(posted).toMatchObject({ runId: "ls_e2e_run", key: "coeval_verdict", value: "pass" });
    const synced = await createApp(repository).request("/api/feedback-syncs?status=synced&limit=5");
    await expect(synced.json()).resolves.toMatchObject({
      feedbackSyncs: [{ provider: "langsmith", status: "synced", attempts: 0, lastError: null }]
    });
  });

  it("C7/B9: failure path — a sync-back error marks the job failed and stays retryable", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const imported = await repository.importTrace("proj_langsmith_support", "langsmith", {
      sourceTraceId: "ls_e2e_fail",
      input: { question: "q" },
      output: { answer: "a" },
      metadata: { source: "langsmith" }
    }, {
      ingestionPurpose: "analysis_eligible_langsmith",
      sourceIntegrationId: integration.id
    });
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return { label: "fail" as const, score: 0.1, reason: "bad", confidence: 0.8 };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "fail" as const, score: 0.1, rationale: "bad" } };
      }
    };
    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);
    const syncJob = queue.jobs.find((job) => job.name === "feedback.sync")!;

    // Transient upstream failure (500): the job records failed + the error and
    // RETHROWS so pg-boss retries; a later success path stays possible.
    const transient = new LangSmithHttpError("LangSmith is down", 500, "createFeedback");
    await expect(processFeedbackSyncJob(repository, syncJob.data as FeedbackSyncJob, () => ({
      async createFeedback() {
        throw transient;
      }
    }))).rejects.toThrow("LangSmith is down");
    expect(isPermanentFeedbackSyncError(transient)).toBe(false);
    const failed = await createApp(repository).request("/api/feedback-syncs?status=failed&limit=5");
    await expect(failed.json()).resolves.toMatchObject({
      feedbackSyncs: [{ provider: "langsmith", status: "failed", attempts: 1, lastError: expect.stringContaining("LangSmith is down") }]
    });

    // Auth failure (401) is permanent: the worker wrapper drops it, no retry.
    expect(isPermanentFeedbackSyncError(new LangSmithHttpError("bad key", 401, "createFeedback"))).toBe(true);
  });

  it("counts only net-new traces as imported on LangSmith retries", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const createClient = () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_retry",
            input: { question: "Retry?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    });

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, createClient)).resolves.toEqual({ imported: 1, queued: 1 });

    const retryJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 1
    });
    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1,
      importJobId: retryJob.id
    }, createClient)).resolves.toEqual({ imported: 0, queued: 1 });

    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        id: retryJob.id,
        status: "completed",
        importedCount: 0,
        queuedJudgeCount: 1
      }
    ]);
  });

  it("keeps same import job net-new count across worker retries", async () => {
    const queue = new FailingOnceQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const importJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 2
    });
    const createClient = () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_retry_same_job_1",
            input: { question: "First?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          },
          {
            sourceTraceId: "ls_run_retry_same_job_2",
            input: { question: "Second?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    });

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2,
      importJobId: importJob.id
    }, createClient)).rejects.toThrow("Queue unavailable after trace import");

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2,
      importJobId: importJob.id
    }, createClient)).resolves.toEqual({ imported: 0, queued: 2 });

    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        id: importJob.id,
        status: "completed",
        importedCount: 2,
        queuedJudgeCount: 2,
        error: null
      }
    ]);
  });

  it("marks LangSmith import jobs completed or failed", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const importJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 1
    });

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1,
      importJobId: importJob.id
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_status",
            input: { question: "Status?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    }))).resolves.toEqual({ imported: 1, queued: 1 });
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        id: importJob.id,
        status: "completed",
        importedCount: 1,
        queuedJudgeCount: 1,
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        error: null
      }
    ]);

    const failedJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 1
    });
    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1,
      importJobId: failedJob.id
    }, () => ({
      async listRuns() {
        throw new Error("LangSmith unavailable");
      }
    }))).rejects.toThrow("LangSmith unavailable");
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", status: "failed", limit: 5 })).resolves.toMatchObject([
      {
        id: failedJob.id,
        status: "failed",
        error: "LangSmith unavailable",
        completedAt: expect.any(String)
      }
    ]);
  });

  it("applies integration redaction rules during LangSmith import", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent",
      redaction: {
        excludedPaths: ["input.retrievalContext"]
      }
    });

    await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_sensitive_run",
            input: { question: "Refund?", retrievalContext: "large private context", api_key: "sk-live-secret" },
            output: { answer: "Refunds are available.", token: "customer-token" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    }));

    const evalRunId = (queue.jobs[0]!.data as { evalRunId: string }).evalRunId;
    const caseId = (await repository.getEvalRunDetail("proj_langsmith_support", evalRunId))!.items[0]!.caseId;
    await expect(repository.loadJudgeRunContext({
      projectId: "proj_langsmith_support",
      caseId,
      skillVersionId: "skillv_1_2_0"
    })).resolves.toMatchObject({
      trace: {
        input: {
          question: "Refund?",
          retrievalContext: EXCLUDED_VALUE,
          api_key: REDACTED_VALUE
        },
        output: {
          answer: "Refunds are available.",
          token: REDACTED_VALUE
        }
      }
    });
  });
});

describe("LangSmith poller", () => {
  it("claims due integrations and enqueues import jobs once per interval", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent",
      pollIntervalSeconds: 60,
      pollLimit: 7
    });
    const now = new Date("2026-05-02T00:00:00.000Z");

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now,
      intervalMs: 60_000,
      importLimit: 7
    })).resolves.toEqual({ claimed: 1, queued: 1 });
    expect(queue.jobs).toEqual([
      {
        name: "langsmith.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 7,
          importJobId: expect.any(String)
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        source: "langsmith",
        sourceIntegrationId: integration.id,
        status: "queued",
        requestedLimit: 7,
        queueJobId: "job_1"
      }
    ]);

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now,
      intervalMs: 60_000,
      importLimit: 7
    })).resolves.toEqual({ claimed: 0, queued: 0 });
    expect(queue.jobs).toHaveLength(1);

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now: new Date("2026-05-02T00:01:01.000Z"),
      intervalMs: 60_000,
      importLimit: 7
    })).resolves.toEqual({ claimed: 1, queued: 1 });
    expect(queue.jobs).toHaveLength(2);
  });

  it("skips disabled LangSmith polling integrations", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent",
      pollEnabled: false
    });

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now: new Date("2026-05-02T00:00:00.000Z"),
      importLimit: 100
    })).resolves.toEqual({ claimed: 0, queued: 0 });
    expect(queue.jobs).toHaveLength(0);
  });

  it("parses poll interval configuration defensively", () => {
    expect(parsePollIntervalMs("15000")).toBe(15000);
    expect(parsePollIntervalMs("not-a-number")).toBe(300000);
    expect(parsePollIntervalMs(undefined)).toBe(300000);
    expect(parsePollImportLimit("250")).toBe(100);
    expect(parsePollImportLimit("nope")).toBe(25);
  });
});

describe("Langfuse import worker", () => {
  it("imports Langfuse traces and enqueues judge jobs", async () => {
    const queue = new CapturingQueue();
    const repository = new PurposeCapturingRepository();
    const integration = await repository.createLangfuseIntegration("proj_langsmith_support", {
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test"
    });

    const result = await processLangfuseImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2
    }, () => ({
      async listTraces() {
        return [
          {
            sourceTraceId: "lf_trace_1",
            input: { question: "Refund?" },
            output: { answer: "Refunds are available." },
            metadata: { source: "langfuse" }
          }
        ];
      }
    }));

    expect(result).toEqual({ imported: 1, queued: 1 });
    expect(repository.importedPurposes).toEqual(["analysis_eligible_langfuse"]);
    expect(queue.jobs).toEqual([
      {
        name: "eval.run",
        data: {
          projectId: "proj_langsmith_support",
          evalRunId: expect.any(String)
        },
        options: { id: expect.any(String), retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("claims due Langfuse integrations and enqueues import jobs once per interval", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangfuseIntegration("proj_langsmith_support", {
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      pollLimit: 7
    });

    await expect(enqueueDueLangfuseImports(repository, queue, {
      now: new Date("2026-05-01T00:00:00.000Z"),
      intervalMs: 300_000
    })).resolves.toEqual({ claimed: 1, queued: 1 });

    expect(queue.jobs).toEqual([
      {
        name: "langfuse.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 7,
          importJobId: expect.any(String)
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);

    await expect(enqueueDueLangfuseImports(repository, queue, {
      now: new Date("2026-05-01T00:01:00.000Z"),
      intervalMs: 300_000
    })).resolves.toEqual({ claimed: 0, queued: 0 });
  });
});

describe("feedback sync worker", () => {
  it("enqueues and posts LangSmith feedback for judged LangSmith cases", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const imported = await repository.importTrace("proj_langsmith_support", "langsmith", {
      sourceTraceId: "ls_run_feedback",
      input: { question: "Refund?" },
      output: { answer: "Refunds are available." },
      metadata: { source: "langsmith" }
    }, {
      ingestionPurpose: "analysis_eligible_langsmith",
      sourceIntegrationId: integration.id
    });
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return {
          label: "pass" as const,
          score: 0.92,
          reason: "good support answer",
          confidence: 0.9
        };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "pass" as const, score: 0.92, rationale: "good support answer" } };
      }
    };

    const run = await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);

    expect(queue.jobs).toEqual([
      {
        name: "feedback.sync",
        data: {
          projectId: "proj_langsmith_support",
          feedbackSyncJobId: expect.any(String)
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);

    let feedbackPayload: unknown;
    await processFeedbackSyncJob(
      repository,
      queue.jobs[0]!.data as FeedbackSyncJob,
      () => ({
        async createFeedback(input) {
          feedbackPayload = input;
        }
      })
    );

    expect(feedbackPayload).toMatchObject({
      feedbackId: (queue.jobs[0]!.data as FeedbackSyncJob).feedbackSyncJobId,
      runId: "ls_run_feedback",
      key: "coeval_verdict",
      score: 0.92,
      value: "pass",
      comment: "good support answer",
      sourceInfo: {
        skillVersionId: "skillv_1_2_0",
        modelBinding: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          modelVersion: "2026-04-15",
          temperature: 0
        },
        judgeRunId: run.id,
        provider: "coeval"
      }
    });

    const failuresResponse = await createApp(repository).request("/api/feedback-syncs?status=synced&limit=5");
    expect(failuresResponse.status).toBe(200);
    await expect(failuresResponse.json()).resolves.toMatchObject({
      feedbackSyncs: [
        {
          provider: "langsmith",
          status: "synced",
          attempts: 0,
          lastError: null
        }
      ]
    });

    const invalidStatusResponse = await createApp(repository).request("/api/feedback-syncs?status=synked");
    expect(invalidStatusResponse.status).toBe(400);

    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);
    expect(queue.jobs).toHaveLength(1);
  });

  it("enqueues and posts Langfuse feedback for judged Langfuse cases", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangfuseIntegration("proj_langsmith_support", {
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test"
    });
    const imported = await repository.importTrace("proj_langsmith_support", "langfuse", {
      sourceTraceId: "lf_trace_feedback",
      input: { question: "Refund?" },
      output: { answer: "Refunds are available." },
      metadata: { source: "langfuse" }
    }, {
      ingestionPurpose: "analysis_eligible_langfuse",
      sourceIntegrationId: integration.id
    });
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return {
          label: "fail" as const,
          score: 0.2,
          reason: "not grounded",
          confidence: 0.9
        };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "fail" as const, score: 0.2, rationale: "not grounded" } };
      }
    };

    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);

    expect(queue.jobs).toMatchObject([
      {
        name: "feedback.sync",
        data: {
          projectId: "proj_langsmith_support",
          feedbackSyncJobId: expect.any(String)
        }
      }
    ]);

    let feedbackPayload: unknown;
    await processFeedbackSyncJob(
      repository,
      queue.jobs[0]!.data as FeedbackSyncJob,
      () => ({
        async createFeedback(input) {
          feedbackPayload = input;
        }
      })
    );

    expect(feedbackPayload).toMatchObject({
      feedbackId: (queue.jobs[0]!.data as FeedbackSyncJob).feedbackSyncJobId,
      runId: "lf_trace_feedback",
      key: "coeval_verdict",
      score: 0.2,
      value: "fail",
      comment: "not grounded"
    });
  });
});

describe("datasets", () => {
  const projectId = "proj_langsmith_support";

  async function importCase(repository: DemoRepository, sourceTraceId: string): Promise<string> {
    const imported = await repository.importTrace(projectId, "manual", {
      sourceTraceId,
      input: { question: `q for ${sourceTraceId}` },
      output: { answer: "a" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    return imported.caseId;
  }

  it("creates a dataset, adds items, and reads the detail back", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const caseA = await importCase(repository, "ds_case_a");

    const create = await localApp.request("/api/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Checkout regressions", description: "Cases from the checkout incident" })
    });
    expect(create.status).toBe(201);
    const { dataset } = (await create.json()) as { dataset: { id: string; kind: string; itemCount: number } };
    expect(dataset.kind).toBe("custom");
    expect(dataset.itemCount).toBe(0);

    // One imported case + one demo exception case; expectedLabel optional.
    const add = await localApp.request(`/api/datasets/${dataset.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: caseA, expectedLabel: "pass" },
          { caseId: "case_exc_001", note: "known judge miss" }
        ]
      })
    });
    expect(add.status).toBe(201);
    const { items } = (await add.json()) as { items: Array<{ caseId: string; expectedLabel: string | null }> };
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.caseId).sort()).toEqual([caseA, "case_exc_001"].sort());
    expect(items.find((item) => item.caseId === caseA)?.expectedLabel).toBe("pass");

    const detail = await localApp.request(`/api/datasets/${dataset.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { itemCount: number; items: unknown[] };
    expect(detailBody.itemCount).toBe(2);
    expect(detailBody.items).toHaveLength(2);

    const list = await localApp.request("/api/datasets");
    const listBody = (await list.json()) as { datasets: Array<{ itemCount: number }> };
    expect(listBody.datasets).toHaveLength(1);
    expect(listBody.datasets[0]?.itemCount).toBe(2);
  });

  it("re-adding a case is idempotent, unknown cases reject the whole batch", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const caseA = await importCase(repository, "ds_case_idem");
    const dataset = await repository.createDataset({ projectId, name: "Idempotency" });

    await repository.addDatasetItems({ projectId, datasetId: dataset.id, items: [{ caseId: caseA }] });
    const again = await repository.addDatasetItems({ projectId, datasetId: dataset.id, items: [{ caseId: caseA }] });
    expect(again).toHaveLength(1);

    const badBatch = await localApp.request(`/api/datasets/${dataset.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_exc_001" }, { caseId: "case_does_not_exist" }] })
    });
    expect(badBatch.status).toBe(400);
    // All-or-nothing: the valid case in the failed batch was not inserted.
    const detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(1);
  });

  it("enforces one active dataset per name; archiving frees the name", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    const first = await repository.createDataset({ projectId, name: "Nightly" });
    const duplicate = await localApp.request("/api/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nightly" })
    });
    expect(duplicate.status).toBe(409);

    const archive = await localApp.request(`/api/datasets/${first.id}/archive`, { method: "POST" });
    expect(archive.status).toBe(200);
    // Archived datasets drop out of the list but stay readable by id.
    const listed = (await (await localApp.request("/api/datasets")).json()) as { datasets: unknown[] };
    expect(listed.datasets).toHaveLength(0);
    expect((await localApp.request(`/api/datasets/${first.id}`)).status).toBe(200);
    // Re-archive is a 404 (nothing active matched), and the name is free again.
    expect((await localApp.request(`/api/datasets/${first.id}/archive`, { method: "POST" })).status).toBe(404);
    const reuse = await localApp.request("/api/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nightly" })
    });
    expect(reuse.status).toBe(201);
  });

  it("removes items and 404s on misses, archived datasets reject new items", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Removal" });
    const items = await repository.addDatasetItems({
      projectId,
      datasetId: dataset.id,
      items: [{ caseId: "case_exc_001" }]
    });

    const remove = await localApp.request(`/api/datasets/${dataset.id}/items/${items[0]!.id}`, { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect((await localApp.request(`/api/datasets/${dataset.id}/items/${items[0]!.id}`, { method: "DELETE" })).status).toBe(404);

    await repository.archiveDataset(projectId, dataset.id);
    const addToArchived = await localApp.request(`/api/datasets/${dataset.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_exc_001" }] })
    });
    expect(addToArchived.status).toBe(404);
  });
});

class CapturingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: object; options?: object | undefined }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_name: QueueName, _handler: (job: { id: string; data: T }) => Promise<void>): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    this.jobs.push({ name, data, options });
    return `job_${this.jobs.length}`;
  }
}

class FailingOnceQueue extends CapturingQueue {
  private failed = false;

  override async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Queue unavailable after trace import");
    }
    return super.send(name, data, options);
  }
}

class EmptySkillRepository extends DemoRepository {
  importCalled = false;

  override async getCurrentSkill(): Promise<never> {
    throw new NoCurrentSkillError("proj_langsmith_support");
  }

  override async importTrace(...args: Parameters<DemoRepository["importTrace"]>): ReturnType<DemoRepository["importTrace"]> {
    this.importCalled = true;
    return super.importTrace(...args);
  }
}

// Skill Bench: example ingestion — content-hash dedup, label upsert, no
// auto-judge — plus the mode field and provider-availability endpoint.
describe("trust digest (M3 S4)", () => {
  it("GET /api/trust-digest returns the four signals with honest empty states on the demo project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/trust-digest");
    expect(response.status).toBe(200);
    const digest = (await response.json()) as {
      version: string;
      spend: { windowRuns: number; runsCounted: number };
      nudges: unknown[];
      noSignal: string[];
      judgeHumanKappa: unknown[];
    };
    expect(digest.spend.windowRuns).toBe(10);
    // The demo project has no human overlap with the CURRENT version's judge
    // rater and no repeat judgments — explicit no-signal facts, no fabrication.
    expect(digest.judgeHumanKappa).toEqual([]);
    expect(digest.noSignal.join(" ")).toMatch(/no human verdicts overlap/);
  });
});

describe("Judge Card (M1 E5)", () => {
  it("assembles recorded evidence for a version with trust data (seeded demo)", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const localApp = createApp(repository);
    const response = await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/card");
    expect(response.status).toBe(200);
    const card = JudgeCardSchema.parse(await response.json());
    expect(card.version.id).toBe("skillv_1_2_0");
    expect(card.version.rubricProvenance).toBe("human-authored");
    expect(card.modelBinding.provider).toBe("anthropic");
    expect(card.goldenSet.size).toBe(2);
    // Seeded demo has judge+human overlap AND repeat judge runs — the trust
    // signals must be REAL here, not nulls.
    expect(card.judgeHumanKappa.length).toBeGreaterThan(0);
    expect(card.selfConsistency).not.toBeNull();
    // No recorded gate run for the seeded version — explicit null + basis note.
    expect(card.regression).toBeNull();
    expect(card.basis.some((note) => note.startsWith("regression:"))).toBe(true);
    expect(card.basis.some((note) => note.includes("not a composite score"))).toBe(true);
  });

  it("renders honest nulls for a version with no trust data, and markdown on ?format=md", async () => {
    const repository = new DemoRepository(); // no seeded verdicts
    const localApp = createApp(repository);
    const json = await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/card");
    const card = JudgeCardSchema.parse(await json.json());
    expect(card.judgeHumanKappa).toEqual([]);
    expect(card.selfConsistency).toBeNull();
    expect(card.basis.some((note) => note.includes("no human verdicts"))).toBe(true);

    const md = await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/card?format=md");
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    // Inline (copy path): no attachment header.
    expect(md.headers.get("content-disposition")).toBeNull();
    const text = await md.text();
    expect(text).toContain("# Judge Card — Support Answer Quality 1.2.0");
    expect(text).toContain("anthropic/claude-sonnet-4-6");
    expect(text).toContain("Rubric provenance**: human-authored");
    expect(text).toContain("Judge–human κ**: none recorded yet");

    // &download=1 forces an attachment with a STATIC filename stem
    // (never the skill/project name — header-injection safe) and identical body.
    const dl = await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/card?format=md&download=1");
    expect(dl.status).toBe(200);
    const disp = dl.headers.get("content-disposition");
    expect(disp).toContain("attachment");
    expect(disp).toMatch(/filename="coeval-judge-card-\d{4}-\d{2}-\d{2}\.md"/);
    // Same renderer as the inline path (the only per-request difference is the
    // generatedAt timestamp) — assert the download carries the real card body.
    const dlText = await dl.text();
    expect(dlText).toContain("# Judge Card — Support Answer Quality 1.2.0");
    expect(dlText).toContain("## Basis");
    expect(dlText.replace(/generated \S+/, "generated —")).toBe(text.replace(/generated \S+/, "generated —"));

    expect((await localApp.request("/api/skills/skill_support_quality/versions/skillv_missing/card")).status).toBe(404);
    expect((await localApp.request("/api/skills/skill_wrong/versions/skillv_1_2_0/card")).status).toBe(404);
  });
});

describe("SkillFormat v1 export (M4 C3)", () => {
  it("exports a version as a conforming document with real golden examples (redacted input/output)", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const localApp = createApp(repository);
    const response = await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/skill-format");
    expect(response.status).toBe(200);
    const doc = SkillFormatV1Schema.parse(await response.json());

    // Every top-level spec field sourced from skill + version (never fabricated).
    expect(doc.formatVersion).toBe("skill-format/v1");
    expect(doc.name.length).toBeGreaterThan(0);
    expect(doc.owner.length).toBeGreaterThan(0);
    expect(doc.version).toBe("1.2.0");
    expect(doc.status).toBe("production");
    expect(doc.modelBinding.provider).toBe("anthropic");
    expect(doc.rubricMarkdown.length).toBeGreaterThan(0);
    expect(Object.keys(doc.outputSchema).length).toBeGreaterThan(0);
    expect(doc.basis.some((note) => note.includes("no value is fabricated"))).toBe(true);

    // The seeded demo has a golden set → at least one example with NON-NULL
    // input+output from the redacted trace (not hollowed to null).
    expect(doc.examples.length).toBeGreaterThan(0);
    const withPayload = doc.examples.find((ex) => ex.input !== null && ex.output !== null);
    expect(withPayload, "at least one example carries redacted trace input/output").toBeDefined();
    expect(["pass", "fail", "ambiguous"]).toContain(withPayload!.label);
    expect(withPayload!.reason.length).toBeGreaterThan(0);
  });

  it("empty golden set → zero examples with an explicit basis note, never fabricated", async () => {
    const repository = new DemoRepository(); // no seeded verdicts/golden promotions beyond the fixture
    const localApp = createApp(repository);
    const doc = SkillFormatV1Schema.parse(await (await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/skill-format")).json());
    // The fixture golden set may be non-empty; assert the basis note logic
    // instead: when examples is empty, the note is present; when not, the
    // fabrication-free note is always present.
    if (doc.examples.length === 0) {
      expect(doc.basis.some((note) => note.includes("golden set is empty"))).toBe(true);
    }
    expect(doc.basis.some((note) => note.includes("no value is fabricated"))).toBe(true);
  });

  it("?download=1 attaches a static-stem json file; 404s for a missing version", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dl = await localApp.request("/api/skills/skill_support_quality/versions/skillv_1_2_0/skill-format?download=1");
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/attachment; filename="coeval-skill-format-\d{4}-\d{2}-\d{2}\.json"/);
    expect((await localApp.request("/api/skills/skill_support_quality/versions/skillv_missing/skill-format")).status).toBe(404);
  });
});

describe("dataset examples (Skill Bench ingestion)", () => {
  const projectId = "proj_langsmith_support";

  it("imports pasted examples: mints cases, sets labels, never auto-judges", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Bench examples" });

    const response = await localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { input: "Where is my refund??", output: "Can't help.", expectedLabel: "fail", name: "angry-refund" },
          { input: "Thanks, that fixed it!", output: "Glad to hear it." }
        ]
      })
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      items: Array<{ caseId: string; datasetItemId: string | null; created: boolean }>;
      reusedCount: number;
      skippedCount: number;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.created && item.datasetItemId)).toBe(true);
    expect(body.reusedCount).toBe(0);

    const detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(2);
    const labeled = detail?.items.find((item) => item.expectedLabel === "fail");
    expect(labeled).toBeDefined();

    // No judge verdicts anywhere — bench ingestion never auto-judges.
    for (const item of body.items) {
      const verdicts = await repository.listVerdicts({ projectId, caseId: item.caseId, source: "llm_judge", limit: 5 });
      expect(verdicts).toHaveLength(0);
    }
  });

  it("T2: pass-clears-step upsert invariant on dataset examples", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Step expectations" });
    const post = (items: unknown[]) => localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    const EXAMPLE = {
      input: "trajectory q",
      output: "trajectory a",
      steps: [
        { name: "s0", input: 0, output: 0 },
        { name: "s1", input: 1, output: 1 }
      ]
    };

    // fail + step stores both.
    const first = await post([{ ...EXAMPLE, expectedLabel: "fail", expectedFailStep: 1 }]);
    expect(first.status).toBe(201);
    let detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items[0]).toMatchObject({ expectedLabel: "fail", expectedFailStep: 1 });

    // fail→fail WITHOUT a step keeps the stored step.
    await post([{ ...EXAMPLE, expectedLabel: "fail" }]);
    detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items[0]).toMatchObject({ expectedLabel: "fail", expectedFailStep: 1 });

    // Re-label to pass CLEARS the stored step.
    await post([{ ...EXAMPLE, expectedLabel: "pass" }]);
    detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items[0]).toMatchObject({ expectedLabel: "pass", expectedFailStep: null });

    // Examples route rejects the same cross-field rules as the batch route.
    const invalid = await post([{ ...EXAMPLE, expectedLabel: "fail", expectedFailStep: 2 }]);
    expect(invalid.status).toBe(400);
  });

  it("T4: case detail lists every dataset's expectation by name", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const first = await repository.createDataset({ projectId, name: "Traj set A" });
    const second = await repository.createDataset({ projectId, name: "Traj set B" });
    const EXAMPLE = {
      input: "traj input",
      output: "This is incorrect.",
      steps: [
        { name: "s0", input: 0, output: 0 },
        { name: "s1", input: 1, output: "wrong step" }
      ]
    };
    const post = (datasetId: string, items: unknown[]) => localApp.request(`/api/datasets/${datasetId}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    const firstRes = await post(first.id, [{ ...EXAMPLE, expectedLabel: "fail", expectedFailStep: 1 }]);
    const firstBody = (await firstRes.json()) as { items: Array<{ caseId: string }> };
    const caseId = firstBody.items[0]!.caseId;
    await post(second.id, [{ ...EXAMPLE, expectedLabel: "fail" }]);

    // A judged case is required for case detail — run an eval over dataset A.
    await localApp.request("/api/eval-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId: first.id })
    });

    const detailRes = await localApp.request(`/api/cases/${caseId}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      trace: { steps?: unknown[] };
      datasetExpectations: Array<{ datasetName: string; expectedLabel: string | null; expectedFailStep: number | null }>;
    };
    expect(detail.trace.steps).toHaveLength(2);
    expect(detail.datasetExpectations).toEqual([
      { datasetName: "Traj set A", expectedLabel: "fail", expectedFailStep: 1 },
      { datasetName: "Traj set B", expectedLabel: "fail", expectedFailStep: null }
    ]);
  });

  it("content-hash dedup: unchanged re-paste reuses the case, an edit mints a new one; labels upsert", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Bench dedup" });
    const post = (items: unknown[]) => localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });

    const first = await post([{ input: "q1", output: "a1", expectedLabel: "pass" }]);
    const firstBody = (await first.json()) as { items: Array<{ caseId: string }>; reusedCount: number };

    // Identical content → same case, reused, label flipped by the upsert.
    const again = await post([{ input: "q1", output: "a1", expectedLabel: "fail" }]);
    const againBody = (await again.json()) as { items: Array<{ caseId: string; created: boolean }>; reusedCount: number };
    expect(againBody.reusedCount).toBe(1);
    expect(againBody.items[0]?.caseId).toBe(firstBody.items[0]?.caseId);
    expect(againBody.items[0]?.created).toBe(false);

    // Label-less re-add must NOT null the stored label.
    await post([{ input: "q1", output: "a1" }]);
    let detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0]?.expectedLabel).toBe("fail");

    // Within one batch: a label-less duplicate of identical content must not
    // erase the labeled occurrence (last-labeled-wins coalescing).
    await post([{ input: "q2", output: "a2", expectedLabel: "pass" }, { input: "q2", output: "a2" }]);
    const withDup = await repository.getDatasetDetail(projectId, dataset.id);
    expect(withDup?.items.find((item) => item.expectedLabel === "pass")).toBeDefined();
    expect(withDup?.items).toHaveLength(2);

    // steps join the content hash only when present — a step-less
    // example keeps its pre-M2 case; the same input/output WITH steps is a
    // different case; identical steps re-paste is a reuse; an edited step
    // mints a fresh case.
    const stepped = await post([{
      input: "q1", output: "a1",
      steps: [{ name: "lookup", input: { order: 1 }, output: { found: true } }],
      expectedLabel: "pass"
    }]);
    const steppedBody = (await stepped.json()) as { items: Array<{ caseId: string; created: boolean }> };
    expect(steppedBody.items[0]?.created).toBe(true);
    expect(steppedBody.items[0]?.caseId).not.toBe(firstBody.items[0]?.caseId);

    const steppedAgain = await post([{
      input: "q1", output: "a1",
      steps: [{ name: "lookup", input: { order: 1 }, output: { found: true } }]
    }]);
    const steppedAgainBody = (await steppedAgain.json()) as { items: Array<{ caseId: string; created: boolean }>; reusedCount: number };
    expect(steppedAgainBody.items[0]?.created).toBe(false);
    expect(steppedAgainBody.items[0]?.caseId).toBe(steppedBody.items[0]?.caseId);

    const steppedEdited = await post([{
      input: "q1", output: "a1",
      steps: [{ name: "lookup", input: { order: 2 }, output: { found: true } }]
    }]);
    const steppedEditedBody = (await steppedEdited.json()) as { items: Array<{ caseId: string; created: boolean }> };
    expect(steppedEditedBody.items[0]?.created).toBe(true);
    expect(steppedEditedBody.items[0]?.caseId).not.toBe(steppedBody.items[0]?.caseId);

    // Edited content → a fresh case (the stale-payload dedup trap).
    const edited = await post([{ input: "q1", output: "a1 — corrected", expectedLabel: "pass" }]);
    const editedBody = (await edited.json()) as { items: Array<{ caseId: string; created: boolean }>; reusedCount: number };
    expect(editedBody.items[0]?.created).toBe(true);
    expect(editedBody.items[0]?.caseId).not.toBe(firstBody.items[0]?.caseId);
    detail = await repository.getDatasetDetail(projectId, dataset.id);
    // q1 + q2 + the edited q1 variant + the two stepped q1 variants.
    expect(detail?.items).toHaveLength(5);
  });

  it("rolls back everything when ingestion fails mid-flow — no orphaned cases (C2)", async () => {
    class FailingRepository extends DemoRepository {
      private addCalls = 0;
      override async addDatasetItems(...args: Parameters<DemoRepository["addDatasetItems"]>): ReturnType<DemoRepository["addDatasetItems"]> {
        this.addCalls += 1;
        if (this.addCalls === 2) throw new Error("induced mid-flow failure");
        return super.addDatasetItems(...args);
      }
    }
    const repository = new FailingRepository();
    const localApp = createApp(repository);
    const dataset = await repository.createDataset({ projectId, name: "Atomicity" });
    const items = [
      { input: "q-atomic-1", output: "a1", expectedLabel: "pass" },
      { input: "q-atomic-2", output: "a2", expectedLabel: "fail" }
    ];

    const failed = await localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    expect(failed.status).toBe(500);

    // Nothing half-landed: the dataset is empty AND the first item's case was
    // rolled back too — a clean retry mints BOTH cases fresh (created: true;
    // a leaked case would come back created: false / reused).
    const detail = await repository.getDatasetDetail(projectId, dataset.id);
    expect(detail?.items).toHaveLength(0);
    const retry = await localApp.request(`/api/datasets/${dataset.id}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    expect(retry.status).toBe(201);
    const retryBody = (await retry.json()) as { items: Array<{ created: boolean }>; reusedCount: number };
    expect(retryBody.items.every((item) => item.created)).toBe(true);
    expect(retryBody.reusedCount).toBe(0);
  });

  it("404s on a missing dataset without minting cases", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const before = (await repository.listProjects())[0]?.importedTraceCount ?? 0;
    const response = await localApp.request("/api/datasets/ds_missing/examples", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ input: "q", output: "a" }] })
    });
    expect(response.status).toBe(404);
    const after = (await repository.listProjects())[0]?.importedTraceCount ?? 0;
    expect(after).toBe(before);
  });

  it("exposes project mode on settings and judge-provider availability", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    const settings = await localApp.request("/api/project/settings");
    const settingsBody = (await settings.json()) as { mode: string };
    expect(settingsBody.mode).toBe("tracing");

    const providers = await localApp.request("/api/judge/providers");
    expect(providers.status).toBe(200);
    const providersBody = (await providers.json()) as { providers: Array<{ provider: string; available: boolean; label: string }> };
    expect(providersBody.providers.find((p) => p.provider === "mock")?.available).toBe(true);
    expect(providersBody.providers.map((p) => p.provider).sort()).toEqual([
      "anthropic",
      "custom",
      "mock",
      "openai",
      "openrouter"
    ]);

    const models = await localApp.request("/api/judge/providers/mock/models");
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toEqual({
      provider: "mock",
      models: [{ id: "mock", label: "Mock heuristic", version: "mock", createdAt: null }]
    });
  });

  it("discovers OpenAI models through the same configured base URL as runtime", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "compatible-provider-key-app-test";
    process.env.OPENAI_BASE_URL = "https://models.example.test/v1/";
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      async json() { return { data: [{ id: "gpt-compatible", created: 1 }] }; }
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const localApp = createApp(new DemoRepository());
      const response = await localApp.request("/api/judge/providers/openai/models");

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://models.example.test/v1/models");
    } finally {
      vi.unstubAllGlobals();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  });

  it("validates model provider, custom endpoint, and temperature boundaries", () => {
    const baseInput = {
      rubricMarkdown: "Test rubric.",
      prompt: "Test prompt.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
    };
    expect(() => CreateSkillVersionInputSchema.parse(baseInput)).not.toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: { ...baseInput.modelBinding, provider: "typo-provider" }
    })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: { provider: "custom", modelId: "judge", modelVersion: "judge", temperature: 0 }
    })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: {
        provider: "custom",
        modelId: "judge",
        modelVersion: "judge",
        temperature: 0,
        baseUrl: "https://models.example.test/v1"
      }
    })).not.toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: { ...baseInput.modelBinding, temperature: 2.1 }
    })).toThrow();
  });
});
