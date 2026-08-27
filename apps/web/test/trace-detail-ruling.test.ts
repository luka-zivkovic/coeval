import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ExceptionDetail, VerdictRecord } from "@coeval/shared";
import { TraceDetail } from "../src/components/trace-detail.js";

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children?: unknown }) => createElement("section", props, children as never),
  CardHeader: ({ children, ...props }: { children?: unknown }) => createElement("header", props, children as never),
  CardTitle: ({ children, ...props }: { children?: unknown }) => createElement("h2", props, children as never),
  CardDescription: ({ children, ...props }: { children?: unknown }) => createElement("p", props, children as never),
  CardContent: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never)
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/components/ui/separator", () => ({
  Separator: (props: Record<string, unknown>) => createElement("hr", props)
}));
vi.mock("@/components/coeval", () => ({
  Eyebrow: ({ children, ...props }: { children?: unknown }) => createElement("span", props, children as never),
  SectionHead: ({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) =>
    createElement("header", null, `${eyebrow} ${title} ${sub ?? ""}`),
  VerdictChip: ({ verdict }: { verdict: string }) => createElement("span", null, verdict),
  Chip: ({ children, ...props }: { children?: unknown }) => createElement("span", props, children as never),
  MarginNote: ({ children, ...props }: { children?: unknown }) => createElement("aside", props, children as never),
  JudgeCallPanel: () => createElement("div")
}));
vi.mock("@/lib/api", () => ({
  promoteExceptionToGoldenSet: vi.fn(),
  recordHumanVerdict: vi.fn()
}));

const humanRuling: VerdictRecord = {
  id: "verdict_human",
  projectId: "project_1",
  caseId: "case_1",
  skillVersionId: "skillv_1",
  source: "human",
  actorUserId: "user_maya",
  actorName: "Maya",
  payload: {
    kind: "categorical",
    choice: "pass",
    choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
    rationale: "The response follows the review guide."
  },
  externalRunId: null,
  createdAt: "2026-08-26T10:00:00.000Z"
};

const judgeBeforeRuling: VerdictRecord = {
  ...humanRuling,
  id: "verdict_judge_before",
  source: "llm_judge",
  actorUserId: null,
  actorName: null,
  payload: {
    kind: "categorical",
    choice: "fail",
    choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
    rationale: "The answer omitted a direct link."
  },
  createdAt: "2026-08-26T09:00:00.000Z"
};

const detail: ExceptionDetail = {
  exception: {
    id: "case_1",
    traceId: "trace_1",
    title: "A disputed support answer",
    verdict: "fail",
    reason: "The evaluator considered the response too vague.",
    skillVersionId: "skillv_1",
    criterionVersionId: "criterionv_1",
    reviewerState: "needs_review",
    createdAt: "2026-08-26T09:00:00.000Z"
  },
  trace: {
    id: "trace_1",
    input: { question: "Can I export my data?" },
    output: { answer: "Use Workspace settings." },
    metadata: {}
  },
  judgeRun: {
    id: "judge_1",
    projectId: "project_1",
    caseId: "case_1",
    skillVersionId: "skillv_1",
    verdict: "fail",
    score: 0.2,
    reasoning: "The answer omitted a direct link.",
    createdAt: "2026-08-26T09:00:00.000Z"
  },
  datasetExpectations: [],
  latestHumanLabel: "pass",
  verdictHistory: [humanRuling, judgeBeforeRuling],
  goldenSetEntry: null
};

describe("case-detail human ruling state", () => {
  it("makes the durable human ruling primary and the evaluator opinion secondary", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, { detail }));

    expect(html).toContain("Recorded human ruling");
    expect(html).toContain("Ungoverned legacy review evidence");
    expect(html).toContain("not governed human truth");
    expect(html).toContain("At review time, overrode the evaluator");
    expect(html).toContain("The response follows the review guide.");
    expect(html).toContain("Maya");
    expect(html).toContain("Latest evaluator opinion");
    expect(html).toContain("overridden by ruling");
    expect(html).toContain("Ruled pass");
    expect(html).toContain("Change ruling");
    expect(html).toContain("Add to golden set");
    expect(html).toContain("Decision history · 2 append-only records");
    expect(html).toContain("Evaluator output");
    expect(html).not.toContain("Accept evaluator opinion");
    expect(html).not.toContain("next week");
  });

  it("keeps an owner ruling effective over a later ordinary review", () => {
    const ownerRuling: VerdictRecord = {
      ...humanRuling,
      id: "verdict_owner",
      source: "adjudicated",
      actorUserId: "user_owner",
      actorName: "Owner Ada",
      payload: {
        ...humanRuling.payload,
        choice: "fail",
        rationale: "Owner reviewed the full case and ruled fail."
      },
      createdAt: "2026-08-26T09:30:00.000Z"
    };
    const laterReview: VerdictRecord = {
      ...humanRuling,
      id: "verdict_later",
      createdAt: "2026-08-26T11:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: {
        ...detail,
        latestHumanLabel: "fail",
        verdictHistory: [laterReview, ownerRuling]
      }
    }));

    expect(html).toContain("Owner ruling");
    expect(html).toContain("Owner Ada");
    expect(html).toContain("Owner reviewed the full case and ruled fail.");
    expect(html).toContain("does not override owner ruling");
    expect(html).toContain("Add another review");
    expect(html).not.toContain("Change ruling");
  });

  it("keeps the ruling comparison pinned to the evaluator output available at review time", () => {
    const laterJudge: VerdictRecord = {
      ...judgeBeforeRuling,
      id: "verdict_judge_after",
      payload: {
        ...judgeBeforeRuling.payload,
        choice: "pass",
        rationale: "A later evaluator version accepted the answer."
      },
      createdAt: "2026-08-26T11:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: {
        ...detail,
        exception: { ...detail.exception, verdict: "pass" },
        judgeRun: {
          ...detail.judgeRun,
          id: "judge_2",
          verdict: "pass",
          score: 0.9,
          reasoning: "A later evaluator version accepted the answer.",
          createdAt: "2026-08-26T11:00:00.000Z"
        },
        verdictHistory: [laterJudge, humanRuling, judgeBeforeRuling]
      }
    }));

    expect(html).toContain("At review time, overrode the evaluator");
    expect(html).toContain("fail output");
    expect(html).not.toContain("At review time, agreed with the evaluator");
  });

  it("shows the active golden-set reference as a separate durable state", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: {
        ...detail,
        goldenSetEntry: {
          id: "gold_1",
          caseId: "case_1",
          traceId: "trace_1",
          agreedLabel: "pass",
          reason: "Protect this known-good export answer.",
          promotedBy: "Maya",
          promotedAt: "2026-08-26T12:00:00.000Z",
          sourceSkillVersionId: "skillv_1",
          criterionVersionId: "criterionv_1"
        }
      }
    }));

    expect(html).toContain("in golden set");
    expect(html).toContain("Golden-set expectation: pass");
    expect(html).toContain("Protect this known-good export answer.");
    expect(html).not.toContain("Add to golden set");
  });

  it("refreshes the shared dashboard after standalone and player decisions", async () => {
    const [traceSource, playerSource] = await Promise.all([
      readFile(new URL("../src/screens/trace.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/review-player.tsx", import.meta.url), "utf8")
    ]);

    expect(traceSource).toMatch(/onChanged=\{\(\) => \{[\s\S]*load\(caseId\);[\s\S]*void refresh\(\);/);
    expect(playerSource).toMatch(/onChanged=\{\(kind\) => \{[\s\S]*void refresh\(\);[\s\S]*advanceCursor\(\);/);
  });
});
