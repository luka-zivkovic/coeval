import { describe, expect, it } from "vitest";
import type { VerdictPayload, VerdictRecord } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import { buildFindings, normalizeFirstSentence } from "../src/lib/findings.js";

const PROJECT = "proj_langsmith_support";

function verdict(overrides: {
  caseId: string;
  source: VerdictRecord["source"];
  payload: VerdictPayload;
  createdAt: string;
  skillVersionId?: string | null;
  actorUserId?: string | null;
}): VerdictRecord {
  return {
    id: `verdict_${overrides.caseId}_${overrides.source}_${overrides.createdAt}`,
    projectId: PROJECT,
    caseId: overrides.caseId,
    skillVersionId: overrides.skillVersionId ?? "skillv_1_2_0",
    source: overrides.source,
    actorUserId: overrides.actorUserId ?? (overrides.source === "llm_judge" ? null : "user_rev"),
    payload: overrides.payload,
    externalRunId: null,
    createdAt: overrides.createdAt
  };
}

const judgeFail = (caseId: string, rationale: string, createdAt: string): VerdictRecord =>
  verdict({ caseId, source: "llm_judge", payload: { kind: "binary", pass: false, rationale }, createdAt });
const judgePass = (caseId: string, rationale: string, createdAt: string): VerdictRecord =>
  verdict({ caseId, source: "llm_judge", payload: { kind: "binary", pass: true, rationale }, createdAt });

describe("normalizeFirstSentence", () => {
  it("keeps only the first sentence, lowercased, whitespace-collapsed", () => {
    expect(normalizeFirstSentence("Missing citation.  The answer skipped the source list."))
      .toBe("missing citation");
    expect(normalizeFirstSentence("  Missing   CITATION!\nmore text")).toBe("missing citation");
    expect(normalizeFirstSentence("missing citation")).toBe("missing citation");
  });

  it("is deterministic on empty and punctuation-only input", () => {
    expect(normalizeFirstSentence("")).toBe("");
    expect(normalizeFirstSentence("...")).toBe("");
  });
});

describe("buildFindings", () => {
  const emptyDisagreements = { comparedCases: 0, disagreedCases: 0, resolvedCases: 0, cases: [] };

  it("lists human overrides only where the human contradicts the judge", () => {
    const findings = buildFindings({
      generatedAt: "2026-09-01T00:00:00.000Z",
      since: null,
      verdicts: [
        judgeFail("case_a", "Missing citation. Detail A.", "2026-08-01T00:00:00.000Z"),
        verdict({
          caseId: "case_a",
          source: "human",
          payload: { kind: "binary", pass: true, rationale: "Judge too strict. Citation was inline." },
          createdAt: "2026-08-02T00:00:00.000Z"
        }),
        judgePass("case_b", "Looks complete.", "2026-08-01T00:00:00.000Z"),
        verdict({
          caseId: "case_b",
          source: "human",
          payload: { kind: "binary", pass: true, rationale: "Agree with the judge." },
          createdAt: "2026-08-02T00:00:00.000Z"
        }),
        verdict({
          caseId: "case_a",
          source: "adjudicated",
          payload: { kind: "binary", pass: true, rationale: "Ground truth: pass." },
          createdAt: "2026-08-03T00:00:00.000Z"
        })
      ],
      disagreements: emptyDisagreements,
      golden: [],
      cases: []
    });

    expect(findings.humanOverrides).toHaveLength(2);
    expect(findings.humanOverrides.map((entry) => entry.source).sort()).toEqual(["adjudicated", "human"]);
    for (const entry of findings.humanOverrides) {
      expect(entry.caseId).toBe("case_a");
      expect(entry.label).toBe("pass");
      expect(entry.judgeLabel).toBe("fail");
    }
    // Newest first.
    expect(findings.humanOverrides[0]!.source).toBe("adjudicated");
  });

  it("clusters judge fail rationales and override rationales by normalized first sentence", () => {
    const findings = buildFindings({
      generatedAt: "2026-09-01T00:00:00.000Z",
      since: null,
      verdicts: [
        judgeFail("case_1", "Missing citation. Variant one.", "2026-08-01T00:00:00.000Z"),
        judgeFail("case_2", "missing   Citation!  Variant two.", "2026-08-02T00:00:00.000Z"),
        judgeFail("case_3", "Wrong tone. Too casual.", "2026-08-03T00:00:00.000Z"),
        verdict({
          caseId: "case_3",
          source: "human",
          payload: { kind: "binary", pass: true, rationale: "Tone is fine here. Casual is on-brand." },
          createdAt: "2026-08-04T00:00:00.000Z"
        })
      ],
      disagreements: emptyDisagreements,
      golden: [],
      cases: []
    });

    const judgeClusters = findings.failureClusters.filter((cluster) => cluster.source === "judge");
    expect(judgeClusters[0]).toMatchObject({
      key: "missing citation",
      count: 2,
      caseIds: ["case_1", "case_2"],
      sampleRationale: "Missing citation. Variant one."
    });
    const overrideClusters = findings.failureClusters.filter((cluster) => cluster.source === "human_override");
    expect(overrideClusters).toHaveLength(1);
    expect(overrideClusters[0]!.key).toBe("tone is fine here");
    // Deterministic ordering: count desc, then key asc.
    const counts = findings.failureClusters.map((cluster) => cluster.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("computes the verdict distribution per stratum from case metadata", () => {
    const findings = buildFindings({
      generatedAt: "2026-09-01T00:00:00.000Z",
      since: null,
      verdicts: [
        judgeFail("case_s1", "Missing citation.", "2026-08-01T00:00:00.000Z"),
        judgePass("case_s2", "Fine.", "2026-08-01T00:00:00.000Z"),
        judgePass("case_u1", "Fine.", "2026-08-01T00:00:00.000Z"),
        verdict({
          caseId: "case_s1",
          source: "human",
          payload: { kind: "binary", pass: true, rationale: "Override." },
          createdAt: "2026-08-02T00:00:00.000Z"
        })
      ],
      disagreements: emptyDisagreements,
      golden: [],
      cases: [
        { caseId: "case_s1", sourceTraceId: "t1", createdAt: "2026-07-01T00:00:00.000Z", trace: { input: "i", output: "o", metadata: { stratum: "billing" } } },
        { caseId: "case_s2", sourceTraceId: "t2", createdAt: "2026-07-02T00:00:00.000Z", trace: { input: "i", output: "o", metadata: { stratum: "billing" } } },
        { caseId: "case_u1", sourceTraceId: "t3", createdAt: "2026-07-03T00:00:00.000Z", trace: { input: "i", output: "o", metadata: {} } }
      ]
    });

    expect(findings.verdictDistribution).toEqual([
      { stratum: "billing", cases: 2, judge: { fail: 1, pass: 1 }, human: { pass: 1 } },
      { stratum: null, cases: 1, judge: { pass: 1 }, human: {} }
    ]);
  });

    it("summarizes the golden set with an entries-since cursor", () => {
    const golden = [
      { id: "g1", caseId: "c1", traceId: "t1", agreedLabel: "pass" as const, reason: "anchor", promotedBy: "o", promotedAt: "2026-07-01T00:00:00.000Z", sourceSkillVersionId: "sv", criterionVersionId: "cv" },
      { id: "g2", caseId: "c2", traceId: "t2", agreedLabel: "fail" as const, reason: "trap", promotedBy: "o", promotedAt: "2026-08-15T00:00:00.000Z", sourceSkillVersionId: "sv", criterionVersionId: "cv" }
    ];
    const withCursor = buildFindings({
      generatedAt: "2026-09-01T00:00:00.000Z",
      since: "2026-08-01T00:00:00.000Z",
      verdicts: [],
      disagreements: emptyDisagreements,
      golden,
      cases: []
    });
    expect(withCursor.goldenSet).toEqual({
      size: 2,
      entriesSince: 1,
      latestPromotedAt: "2026-08-15T00:00:00.000Z"
    });

    const withoutCursor = buildFindings({
      generatedAt: "2026-09-01T00:00:00.000Z",
      since: null,
      verdicts: [],
      disagreements: emptyDisagreements,
      golden,
      cases: []
    });
    // Absent cursor is null, never zero-as-unknown.
    expect(withoutCursor.goldenSet.entriesSince).toBeNull();
  });
});

describe("GET /api/v1 machine reads (findings, cases, golden-set)", () => {
  async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "findings" })
    });
    return ((await res.json()) as { key: string }).key;
  }

  async function seedCase(
    repository: DemoRepository,
    sourceTraceId: string,
    metadata: Record<string, unknown>
  ): Promise<string> {
    const imported = await repository.importTrace(PROJECT, "manual", {
      sourceTraceId,
      input: { question: `q-${sourceTraceId}` },
      output: { answer: `a-${sourceTraceId}` },
      metadata
    }, { ingestionPurpose: "analysis_eligible_manual" });
    return imported.caseId;
  }

  it("normalizes offset-bearing since cursors before filtering", async () => {
    const app = createApp(new DemoRepository());
    const key = await mintKey(app);
    const res = await app.request(
      "/api/v1/findings?since=" + encodeURIComponent("2026-08-01T05:00:00+06:00"),
      { headers: { authorization: `Bearer ${key}` } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string };
    // 2026-08-01T05:00:00+06:00 === 2026-07-31T23:00:00Z
    expect(body.since).toBe("2026-07-31T23:00:00.000Z");
  });

  it("requires an API key on all three endpoints", async () => {
    const app = createApp(new DemoRepository());
    for (const path of ["/api/v1/findings", "/api/v1/cases", "/api/v1/golden-set"]) {
      const response = await app.request(path);
      expect(response.status).toBe(401);
    }
  });

  it("rejects an invalid since cursor", async () => {
    const app = createApp(new DemoRepository());
    const key = await mintKey(app);
    const response = await app.request("/api/v1/findings?since=yesterday", {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(response.status).toBe(400);
  });

  it("aggregates findings for the project", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    const caseId = await seedCase(repository, "findings_case_1", { stratum: "billing" });
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId,
      source: "llm_judge",
      payload: { kind: "binary", pass: false, rationale: "Missing citation. No sources listed." },
      skillVersionId: "skillv_1_2_0"
    });
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId,
      source: "human",
      payload: { kind: "binary", pass: true, rationale: "Citation was inline. Judge too strict." },
      actorUserId: "user_reviewer"
    });

    const response = await app.request("/api/v1/findings", {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      humanOverrides: Array<{ caseId: string; label: string; judgeLabel: string }>;
      verdictDistribution: Array<{ stratum: string | null }>;
      failureClusters: Array<{ source: string; key: string }>;
      judgeHumanDisagreements: { disagreedCases: number };
      goldenSet: { size: number; entriesSince: number | null };
      since: string | null;
    };

    const override = body.humanOverrides.find((entry) => entry.caseId === caseId);
    expect(override).toMatchObject({ label: "pass", judgeLabel: "fail" });
    expect(body.verdictDistribution.some((row) => row.stratum === "billing")).toBe(true);
    expect(body.failureClusters.some((cluster) => cluster.source === "judge" && cluster.key === "missing citation")).toBe(true);
    expect(body.judgeHumanDisagreements.disagreedCases).toBeGreaterThanOrEqual(1);
    // Demo golden fixtures exist; no cursor given.
    expect(body.goldenSet.size).toBeGreaterThan(0);
    expect(body.goldenSet.entriesSince).toBeNull();
    expect(body.since).toBeNull();
  });

  it("counts golden entries after the since cursor", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    const all = await repository.listGoldenSet(PROJECT);
    const newestPromotedAt = all.map((entry) => entry.promotedAt).sort().at(-1)!;
    const justBefore = new Date(new Date(newestPromotedAt).getTime() - 1000).toISOString();

    const response = await app.request(`/api/v1/findings?since=${encodeURIComponent(justBefore)}`, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { goldenSet: { entriesSince: number | null }; since: string | null };
    expect(body.since).toBe(justBefore);
    expect(body.goldenSet.entriesSince).toBeGreaterThanOrEqual(1);
  });

  it("returns cases with full stored inputs and verdicts, filterable by verdict/stratum/since", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    const failing = await seedCase(repository, "cases_fail", { stratum: "billing" });
    const passing = await seedCase(repository, "cases_pass", { stratum: "refunds" });
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId: failing,
      source: "llm_judge",
      payload: { kind: "binary", pass: false, rationale: "Missing citation." },
      skillVersionId: "skillv_1_2_0"
    });
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId: passing,
      source: "llm_judge",
      payload: { kind: "binary", pass: true, rationale: "Complete." },
      skillVersionId: "skillv_1_2_0"
    });

    const headers = { authorization: `Bearer ${key}` };
    const unfiltered = await app.request("/api/v1/cases", { headers });
    expect(unfiltered.status).toBe(200);
    const { cases } = await unfiltered.json() as { cases: Array<{ caseId: string; input: unknown; output: unknown; stratum: string | null; effectiveLabel: string | null; judge: { rationale: string } | null }> };
    const failEntry = cases.find((entry) => entry.caseId === failing)!;
    // Full stored payloads, not summaries.
    expect(failEntry.input).toEqual({ question: "q-cases_fail" });
    expect(failEntry.output).toEqual({ answer: "a-cases_fail" });
    expect(failEntry.stratum).toBe("billing");
    expect(failEntry.effectiveLabel).toBe("fail");
    expect(failEntry.judge!.rationale).toBe("Missing citation.");

    const byVerdict = await app.request("/api/v1/cases?verdict=fail", { headers });
    const failOnly = await byVerdict.json() as { cases: Array<{ caseId: string }> };
    expect(failOnly.cases.map((entry) => entry.caseId)).toEqual([failing]);

    const byStratum = await app.request("/api/v1/cases?stratum=refunds", { headers });
    const refundsOnly = await byStratum.json() as { cases: Array<{ caseId: string }> };
    expect(refundsOnly.cases.map((entry) => entry.caseId)).toEqual([passing]);

    const future = new Date(Date.now() + 60_000).toISOString();
    const bySince = await app.request(`/api/v1/cases?since=${encodeURIComponent(future)}`, { headers });
    const none = await bySince.json() as { cases: unknown[] };
    expect(none.cases).toEqual([]);

    const badLimit = await app.request("/api/v1/cases?limit=100000", { headers });
    expect(badLimit.status).toBe(400);
  });

  it("prefers the human label over the judge label in effectiveLabel", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    const caseId = await seedCase(repository, "cases_override", {});
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId,
      source: "llm_judge",
      payload: { kind: "binary", pass: false, rationale: "Too short." },
      skillVersionId: "skillv_1_2_0"
    });
    await repository.recordVerdict({
      projectId: PROJECT,
      caseId,
      source: "human",
      payload: { kind: "binary", pass: true, rationale: "Short is correct here." },
      actorUserId: "user_reviewer"
    });

    const response = await app.request("/api/v1/cases?verdict=pass", {
      headers: { authorization: `Bearer ${key}` }
    });
    const body = await response.json() as { cases: Array<{ caseId: string; effectiveLabel: string | null; human: { source: string } | null }> };
    const entry = body.cases.find((candidate) => candidate.caseId === caseId)!;
    expect(entry.effectiveLabel).toBe("pass");
    expect(entry.human!.source).toBe("human");
  });

  it("returns golden entries with their stored traces", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    const response = await app.request("/api/v1/golden-set", {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      entries: Array<{ id: string; agreedLabel: string; trace: { input: unknown } | null }>;
      totalEntries: number;
    };
    expect(body.totalEntries).toBeGreaterThan(0);
    expect(body.entries).toHaveLength(body.totalEntries);
    // Demo golden fixtures carry synthesized traces — inputs must be present.
    expect(body.entries.every((entry) => entry.trace !== null)).toBe(true);

    const future = new Date(Date.now() + 60_000).toISOString();
    const since = await app.request(`/api/v1/golden-set?since=${encodeURIComponent(future)}`, {
      headers: { authorization: `Bearer ${key}` }
    });
    const sinceBody = await since.json() as { entries: unknown[]; totalEntries: number };
    expect(sinceBody.entries).toEqual([]);
    expect(sinceBody.totalEntries).toBe(body.totalEntries);
  });
});
