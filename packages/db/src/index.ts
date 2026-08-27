import { MinimumVerdictOutputSchema } from "@coeval/shared";
import type { CapabilityGap, DashboardSummary, ExceptionCase, GoldenSetEntry, Project, Skill, VerdictRecord } from "@coeval/shared";

export { runMigrations } from "./migrate.js";

const now = "2026-04-30T20:00:00.000Z";

export const demoProject: Project = {
  id: "proj_langsmith_support",
  name: "LangSmith Support Agent",
  mode: "tracing",
  traceProvider: "langsmith",
  importedTraceCount: 1248,
  autoJudgedTraceCount: 1196,
  syncBackCoverage: 0.97,
  traceRetentionDays: null,
  updatedAt: now
};

export const demoSkill: Skill = {
  id: "skill_support_quality",
  projectId: demoProject.id,
  criterionId: "criterion_support_quality",
  name: "Support Answer Quality",
  description: "Shared team skill for judging customer-facing support agent answers.",
  ownerName: "Product Lead",
  status: "production",
  isStarter: false,
  currentVersion: {
    id: "skillv_1_2_0",
    skillId: "skill_support_quality",
    criterionVersionId: "criterionv_support_quality",
    version: "1.2.0",
    status: "production",
    rubricMarkdown: "# Support Answer Quality\n\nPass useful, correct, grounded answers. Fail incorrect, unsafe, or unhelpful answers. Mark missing context ambiguous.",
    prompt:
      "Judge support answer quality against the review guide below. Submit exactly one verdict using the provided structured verdict tool.\n\n<review_guide>\n{{rubric_markdown}}\n</review_guide>",
    modelBinding: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelVersion: "2026-04-15",
      temperature: 0
    },
    outputSchema: MinimumVerdictOutputSchema,
    goldenSetAgreement: 0.86,
    tooStrictCount: 5,
    tooLenientCount: 2,
    ambiguousCount: 4,
    knownLimitations: ["borderline tone issues", "missing retrieval context on older traces"],
    verdictKind: "binary",
    scalarRange: null,
    categoricalChoiceScores: null,
    rubricProvenance: "human-authored",
    regressionDatasetRevisionId: null,
    createdAt: now,
    approvedAt: now
  }
};

// The predecessor version, so the convergence audit (A2.2c) has a real
// before→after to compare on the adjudicated slice. v1.1.0 was meaningfully
// worse — it disagreed with the ground truth on cases v1.2.0 later fixed.
const prevVersionAt = "2026-03-15T20:00:00.000Z";
export const demoSkillPrevVersion: Skill["currentVersion"] = {
  ...demoSkill.currentVersion,
  id: "skillv_1_1_0",
  version: "1.1.0",
  status: "deprecated",
  goldenSetAgreement: 0.71,
  tooStrictCount: 9,
  tooLenientCount: 6,
  knownLimitations: ["over-failed grounded answers", "missed policy-contradiction cases"],
  createdAt: prevVersionAt,
  approvedAt: prevVersionAt
};

export const demoExceptions: ExceptionCase[] = [
  {
    id: "case_exc_001",
    traceId: "ls_run_8f31",
    title: "Refund answer cited outdated policy",
    verdict: "fail",
    reason: "The answer used the old 14-day refund policy while retrieved docs say 30 days.",
    capabilityGap: "policy_grounding",
    reviewerState: "needs_review",
    createdAt: now
  },
  {
    id: "case_exc_002",
    traceId: "ls_run_910a",
    title: "Ambiguous account-state handling",
    verdict: "ambiguous",
    reason: "The trace omitted account tier, so the upgrade path cannot be judged confidently.",
    capabilityGap: "missing_context",
    reviewerState: "needs_review",
    createdAt: now
  },
  {
    id: "case_exc_003",
    traceId: "ls_run_b442",
    title: "Tool result ignored in final answer",
    verdict: "fail",
    reason: "The tool returned an active incident, but the final answer said all systems were healthy.",
    capabilityGap: "tool_result_use",
    reviewerState: "needs_review",
    createdAt: now
  }
];

export const demoCapabilityGaps: CapabilityGap[] = [
  { id: "policy_grounding", name: "policy_grounding", count: 1, severity: "low" },
  { id: "tool_result_use", name: "tool_result_use", count: 1, severity: "low" },
  { id: "missing_context", name: "missing_context", count: 1, severity: "low" }
];

export const demoGoldenSet: GoldenSetEntry[] = [
  {
    id: "gold_001",
    caseId: "case_101",
    traceId: "ls_run_101",
    agreedLabel: "pass",
    reason: "Correct, grounded reset-password answer.",
    promotedBy: "Product Lead",
    promotedAt: now,
    sourceSkillVersionId: demoSkill.currentVersion.id,
    criterionVersionId: demoSkill.currentVersion.criterionVersionId
  },
  {
    id: "gold_002",
    caseId: "case_205",
    traceId: "ls_run_205",
    agreedLabel: "fail",
    reason: "Hallucinated invoice amount.",
    promotedBy: "AI Engineer",
    promotedAt: now,
    sourceSkillVersionId: demoSkill.currentVersion.id,
    criterionVersionId: demoSkill.currentVersion.criterionVersionId
  }
];

// Seed verdicts so the reliability loop is visible in demo mode (no Postgres,
// no auth, no worker). Without these, κ / disagreement feeds / calibration are
// all empty because demo has no auto-judge worker (→ no llm_judge verdicts) and
// no auth (→ null human actors). These hand-built rows give:
//   - human-human κ + disagreement: maya/jules/priya overlap on shared cases,
//     agreeing on some and splitting on others;
//   - judge-vs-human disagreement: cases where a reviewer contradicts the judge;
//   - judge-human calibration: judge + human verdicts on the same cases.
// Three reviewers, one judge (skillv_1_2_0), across two golden + two exception
// cases. DemoRepository seeds `this.verdicts` from this array.
const SKILL_V = demoSkill.currentVersion.id;
function judgeVerdict(caseId: string, pass: boolean): VerdictRecord {
  return {
    id: `verdict_judge_${caseId}`,
    projectId: demoProject.id,
    caseId,
    skillVersionId: SKILL_V,
    source: "llm_judge",
    actorUserId: null,
    payload: { kind: "binary", pass, rationale: pass ? "Grounded and correct." : "Contradicts policy / retrieved context." },
    externalRunId: null,
    createdAt: now
  };
}
function humanVerdict(caseId: string, actor: string, pass: boolean): VerdictRecord {
  return {
    id: `verdict_${actor}_${caseId}`,
    projectId: demoProject.id,
    caseId,
    skillVersionId: SKILL_V,
    source: "human",
    actorUserId: actor,
    payload: { kind: "binary", pass, rationale: pass ? "Reads acceptable to me." : "I'd fail this." },
    externalRunId: null,
    createdAt: now
  };
}
// A2.2c: the predecessor version's judge verdict (pinned to skillv_1_1_0,
// stamped earlier so latest-wins still picks v1.2.0 in the disagreement feeds).
const PREV_V = demoSkillPrevVersion.id;
function prevJudgeVerdict(caseId: string, pass: boolean): VerdictRecord {
  return {
    id: `verdict_judge_prev_${caseId}`,
    projectId: demoProject.id,
    caseId,
    skillVersionId: PREV_V,
    source: "llm_judge",
    actorUserId: null,
    payload: { kind: "binary", pass, rationale: pass ? "Looked fine to v1.1.0." : "v1.1.0 failed this." },
    externalRunId: null,
    createdAt: prevVersionAt
  };
}
// an extra judge RUN of the current version on a case, used to measure
// self-consistency. Stamped earlier than the canonical verdict (`now`) so
// latest-wins in the disagreement/convergence feeds still resolves to the
// canonical one — these repeats only feed the consistency computation.
function consistencyRun(caseId: string, pass: boolean, runIndex: number): VerdictRecord {
  // runIndex doubles as the run's hour-of-day; keep it in 0..19 so the run stays
  // before `now` (20:00) and the latest-wins feeds ignore it. padStart avoids the
  // single-digit-only footgun of string-concatenating the hour.
  const hour = String(runIndex).padStart(2, "0");
  return {
    id: `verdict_judge_run_${caseId}_${runIndex}`,
    projectId: demoProject.id,
    caseId,
    skillVersionId: SKILL_V,
    source: "llm_judge",
    actorUserId: null,
    payload: { kind: "binary", pass, rationale: "Re-run of the same judge on identical input." },
    externalRunId: null,
    createdAt: `2026-04-30T${hour}:00:00.000Z`
  };
}
// A2.2c: an adjudicated ground-truth label (the loop-closing decision).
function adjudicatedVerdict(caseId: string, pass: boolean): VerdictRecord {
  return {
    id: `verdict_adj_${caseId}`,
    projectId: demoProject.id,
    caseId,
    // Adjudication is criterion-scoped evidence. Pin the demo fixture to the
    // current evaluator version just like runtime writes do; a NULL binding
    // would be deliberately ignored by the multi-criterion trust reads.
    skillVersionId: SKILL_V,
    source: "adjudicated",
    actorUserId: "user_priya",
    payload: { kind: "binary", pass, rationale: pass ? "Team confirmed: pass." : "Team confirmed: fail." },
    externalRunId: null,
    createdAt: now
  };
}

// Tuned so the demo reads as a healthy team with a couple of genuine
// disagreements worth surfacing — not "reviewers worse than chance." maya &
// jules overlap on all 5 cases and agree on 4 → their pairwise κ ≈ 0.62
// (substantial). The surfaced *mean*-pairwise κ is higher (≈0.87) because
// priya overlaps on only the agreeing case_205, and a perfectly-agreeing pair
// scores κ=1 regardless of overlap count — an inflation inherent to
// mean-of-pairwise κ that Krippendorff's α (roadmap B1) will replace. A high
// human-human κ is the right backdrop here: the humans are aligned and the
// JUDGE is the thing that's miscalibrated (see case_exc_003). The two
// interesting cases are the convergence-loop hooks.
export const demoVerdicts: VerdictRecord[] = [
  // Clean agreements (judge + both humans aligned) — the bulk of the work.
  judgeVerdict("case_101", true),
  humanVerdict("case_101", "user_maya", true),
  humanVerdict("case_101", "user_jules", true),

  judgeVerdict("case_205", false),
  humanVerdict("case_205", "user_maya", false),
  humanVerdict("case_205", "user_jules", false),
  humanVerdict("case_205", "user_priya", false),

  judgeVerdict("case_exc_002", true),
  humanVerdict("case_exc_002", "user_maya", true),
  humanVerdict("case_exc_002", "user_jules", true),

  // case_exc_001 — humans split (maya fail, jules pass) AND the judge (fail)
  // disagrees with jules → shows in both feeds. severity 0.5.
  judgeVerdict("case_exc_001", false),
  humanVerdict("case_exc_001", "user_maya", false),
  humanVerdict("case_exc_001", "user_jules", true),

  // case_exc_003 — the strongest convergence hook: the judge says PASS but
  // both reviewers say FAIL. Judge-human disagreement at severity 1.0 (the
  // judge is miscalibrated here), yet human-human agreement is perfect — so it
  // surfaces in the PRIMARY feed only. This is the case to adjudicate + refine.
  judgeVerdict("case_exc_003", true),
  humanVerdict("case_exc_003", "user_maya", false),
  humanVerdict("case_exc_003", "user_jules", false),

  // --- A2.2c convergence story --------------------------------------------
  // The team adjudicated ground truth on three cases. v1.2.0 is better overall
  // than the predecessor v1.1.0 (agrees on 2/3 vs 1/3) — but it also REGRESSED
  // on one: case_exc_003, which v1.1.0 correctly failed and v1.2.0 now wrongly
  // passes. So v1.2.0's Judge Card reads "fixed 2, broke 1 vs v1.1.0" — a
  // credible governance moment (a pure all-green demo would undercut the whole
  // "don't trust the rosy number, audit it" pitch). case_exc_001 is left
  // UN-adjudicated so the Reliability screen keeps a live disagreement to
  // adjudicate.
  adjudicatedVerdict("case_101", true), // truth pass — v1.2.0 pass ✓, v1.1.0 fail ✗ → fixed
  adjudicatedVerdict("case_205", false), // truth fail — v1.2.0 fail ✓, v1.1.0 pass ✗ → fixed
  adjudicatedVerdict("case_exc_003", false), // truth fail — v1.2.0 pass ✗, v1.1.0 fail ✓ → REGRESSED
  prevJudgeVerdict("case_101", false),
  prevJudgeVerdict("case_205", true),
  prevJudgeVerdict("case_exc_003", false),

  // --- A3 self-consistency probe ------------------------------------------
  // The current judge (v1.2.0) was re-run on identical input. case_101 is
  // rock-solid (3/3 pass); case_exc_002 flips (2 pass, 1 fail → 0.67) — a
  // reliability red flag the trust report surfaces. Repeats are stamped before
  // `now`, so they don't change which verdict the other feeds treat as latest.
  consistencyRun("case_101", true, 8),
  consistencyRun("case_101", true, 9),
  consistencyRun("case_exc_002", true, 8),
  consistencyRun("case_exc_002", false, 9)
];

export function getDemoDashboardSummary(): DashboardSummary {
  return {
    project: demoProject,
    skill: demoSkill,
    viewerRole: "owner",
    verdictDistribution: {
      pass: 1037,
      fail: 121,
      ambiguous: 38
    },
    exceptions: demoExceptions,
    topCapabilityGaps: demoCapabilityGaps,
    goldenSetSize: 50
  };
}
