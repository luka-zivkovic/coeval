import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { AgentBootstrapRequestSchema, CreateSkillVersionInputSchema, SkillVersionSchema, VerdictPayloadSchema, effectiveHumanLabel, verdictComparableScore, verdictLabelFromPayload } from "@coeval/shared";
import { bootstrapRateLimitIdentity, createApp } from "../src/app.js";
import { DemoRepository, buildGoldenSetHealthSummary } from "../src/repository.js";

describe("Coeval Hono API", () => {
  const app = createApp();

  it("returns health", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
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
});
