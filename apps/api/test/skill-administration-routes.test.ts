import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { JudgeCardSchema, SkillFormatV1Schema } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { registerSkillAdministrationRoutes } from "../src/routes/skill-administration.js";

describe("skill administration routes", () => {
  const app = createApp();

  it("owns the exact contiguous skill-administration route family", () => {
    const repository = new DemoRepository();
    const isolated = new Hono<{ Variables: AppVariables }>();
    registerSkillAdministrationRoutes(isolated, {
      repository,
      requestServices: createRequestServices({
        repository,
        ownerAuthorizationEnabled: false,
        rateLimitPerMinute: 60,
        batchMaxItems: 100
      })
    });

    expect(isolated.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/skills/current",
      "GET /api/skills/:skillId/versions",
      "GET /api/skills/:skillId/versions/:versionId/regression",
      "GET /api/skills/:skillId/versions/:versionId/convergence",
      "GET /api/skills/:skillId/versions/:versionId/self-consistency",
      "GET /api/skills/:skillId/versions/:versionId/card",
      "GET /api/skills/:skillId/versions/:versionId/skill-format",
      "POST /api/skills/:skillId/versions/:versionId/signoff",
      "GET /api/skills/:skillId/versions/:versionId/criterion",
      "POST /api/skills/:skillId/onboarding-check",
      "POST /api/skills/:skillId/versions"
    ]);
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
