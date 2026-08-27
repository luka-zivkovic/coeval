import {
  interpretKappa,
  type ConvergenceAudit,
  type ConvergenceAuditCase,
  type ConvergenceCaseChange,
  type DisagreementCase,
  type DisagreementSummary,
  type JudgeHumanDisagreementCase,
  type JudgeHumanDisagreementSummary,
  type KappaSummary,
  type PairwiseKappa,
  type SelfConsistencyCase,
  type SelfConsistencyReport,
  type UndefinedPairwiseKappa,
  type VerdictPayload,
  type VerdictRecord
} from "@coeval/shared";

/**
 * Compute Cohen's κ summary across human verdicts.
 *
 * Algorithm (Landis & Koch 1977):
 *   p_o = observed agreement = (# cases where raters match) / total cases
 *   p_e = expected agreement by chance = sum over categories of P_A(c) * P_B(c)
 *   κ = (p_o - p_e) / (1 - p_e)
 *
 * Coeval's flagship differentiator — Langfuse community discussion #4348
 * explicitly asks for this and gets a "naming hack" workaround. None of the
 * competitors (Langfuse, Langtrace, Braintrust, Promptfoo, Opik) compute κ.
 *
 * Scope:
 * - Considers only `source = "human"` verdicts (LLM judges are evaluated against
 *   humans separately — see future calibration metric).
 * - First-verdict-wins per (case, reviewer) — verdicts are append-only so the
 *   earliest is the canonical one. Reviewers correct their own work via an
 *   explicit override flow later, not by overwriting their verdict row.
 * - Binary + categorical kinds only. Scalar verdicts can't be reduced to
 *   discrete categories without binning; pairs containing a scalar verdict are
 *   counted in `unsupportedPairs` and surfaced to the operator.
 * - For 3+ reviewers, returns pairwise κ for every pair plus the mean. Fleiss'
 *   κ / Krippendorff's α land in a follow-up; pairwise mean is the conservative
 *   first cut.
 */
export function computeKappaSummary(
  verdicts: VerdictRecord[],
  options?: {
    // Restrict which reviewer pairs participate. Pairs failing the predicate
    // are skipped BEFORE the per-pair case scan, so overlappingCases,
    // unsupportedPairs, and the mean all describe exactly the pairs in the
    // returned array — no post-filtering that leaves the counts describing
    // pairs the caller never sees. raterCount stays "raters with verdicts".
    pairFilter?: (reviewerA: string, reviewerB: string) => boolean;
  }
): KappaSummary {
  const pairFilter = options?.pairFilter;
  const human = verdicts.filter((v) => v.source === "human" && v.actorUserId !== null);
  const byCaseReviewer = new Map<string, Map<string, VerdictRecord>>();
  for (const verdict of human) {
    const actorUserId = verdict.actorUserId;
    if (!actorUserId) continue;
    let inner = byCaseReviewer.get(verdict.caseId);
    if (!inner) {
      inner = new Map();
      byCaseReviewer.set(verdict.caseId, inner);
    }
    // Append-only invariant: only the first verdict per (case, reviewer) counts.
    if (!inner.has(actorUserId)) inner.set(actorUserId, verdict);
  }

  const reviewers = new Set<string>();
  for (const inner of byCaseReviewer.values()) {
    for (const reviewer of inner.keys()) reviewers.add(reviewer);
  }
  const raterCount = reviewers.size;

  if (raterCount < 2) {
    return {
      raterCount,
      overlappingCases: 0,
      pairs: [],
      meanKappa: null,
      meanInterpretation: null,
      undefinedPairs: [],
      unsupportedPairs: 0
    };
  }

  const reviewerList = [...reviewers].sort();
  const pairs: PairwiseKappa[] = [];
  const undefinedPairs: UndefinedPairwiseKappa[] = [];
  const overlappingCaseSet = new Set<string>();
  let unsupportedPairs = 0;

  for (let i = 0; i < reviewerList.length; i += 1) {
    for (let j = i + 1; j < reviewerList.length; j += 1) {
      const a = reviewerList[i]!;
      const b = reviewerList[j]!;
      if (pairFilter && !pairFilter(a, b)) continue;
      const shared: { aPayload: VerdictPayload; bPayload: VerdictPayload }[] = [];
      const sharedCaseIds: string[] = [];
      for (const [caseId, inner] of byCaseReviewer) {
        const aV = inner.get(a);
        const bV = inner.get(b);
        if (aV && bV) {
          shared.push({ aPayload: aV.payload, bPayload: bV.payload });
          sharedCaseIds.push(caseId);
        }
      }
      if (shared.length === 0) continue;

      const pair = computePairwiseKappa(a, b, shared);
      if (pair === null) {
        unsupportedPairs += 1;
        continue;
      }
      if ("reason" in pair) undefinedPairs.push(pair);
      else pairs.push(pair);
      for (const caseId of sharedCaseIds) overlappingCaseSet.add(caseId);
    }
  }

  if (pairs.length === 0) {
    return {
      raterCount,
      overlappingCases: overlappingCaseSet.size,
      pairs: [],
      meanKappa: null,
      meanInterpretation: null,
      undefinedPairs,
      unsupportedPairs
    };
  }

  const meanKappa = pairs.reduce((sum, p) => sum + p.kappa, 0) / pairs.length;
  return {
    raterCount,
    overlappingCases: overlappingCaseSet.size,
    pairs,
    meanKappa,
    meanInterpretation: interpretKappa(meanKappa),
    undefinedPairs,
    unsupportedPairs
  };
}

function computePairwiseKappa(
  reviewerA: string,
  reviewerB: string,
  shared: { aPayload: VerdictPayload; bPayload: VerdictPayload }[]
): PairwiseKappa | UndefinedPairwiseKappa | null {
  const labels: { a: string; b: string }[] = [];
  for (const { aPayload, bPayload } of shared) {
    const aLabel = toDiscreteCategory(aPayload);
    const bLabel = toDiscreteCategory(bPayload);
    if (aLabel === null || bLabel === null) return null;
    labels.push({ a: aLabel, b: bLabel });
  }

  const categories = new Set<string>();
  for (const { a, b } of labels) {
    categories.add(a);
    categories.add(b);
  }

  // All observations occupy one category. Observed agreement is perfect, but
  // kappa is 0/0 because p_e = 1. Preserve the observation and the named
  // reason instead of converting an undefined statistic into favorable κ=1.
  if (categories.size === 1) {
    return {
      reviewerA,
      reviewerB,
      cases: labels.length,
      observedAgreement: 1,
      expectedAgreement: 1,
      kappa: null,
      interpretation: null,
      reason: "expected_agreement_one"
    };
  }

  const total = labels.length;
  const agreementCount = labels.filter(({ a, b }) => a === b).length;
  const observedAgreement = agreementCount / total;

  let expectedAgreement = 0;
  for (const category of categories) {
    const pA = labels.filter((l) => l.a === category).length / total;
    const pB = labels.filter((l) => l.b === category).length / total;
    expectedAgreement += pA * pB;
  }

  if (expectedAgreement === 1) {
    return {
      reviewerA,
      reviewerB,
      cases: total,
      observedAgreement,
      expectedAgreement: 1,
      kappa: null,
      interpretation: null,
      reason: "expected_agreement_one"
    };
  }
  const kappa = (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
  return {
    reviewerA,
    reviewerB,
    cases: total,
    observedAgreement,
    expectedAgreement,
    kappa,
    interpretation: interpretKappa(kappa)
  };
}

export function toDiscreteCategory(payload: VerdictPayload): string | null {
  if (payload.kind === "binary") return "pass" in payload ? (payload.pass ? "pass" : "fail") : payload.label;
  if (payload.kind === "categorical") return payload.choice;
  return null;
}

/**
 * surface the specific cases where human reviewers disagreed — the cases
 * that drag κ down. While `computeKappaSummary` gives a single agreement
 * number, this names the cases so they can be routed into skill refinement
 * (the convergence loop): "your reviewers split on these; tighten the rubric."
 *
 * Human verdicts only; a case is "compared" once ≥2 reviewers gave it a
 * discrete (binary/categorical) verdict; single-reviewer and scalar-only cases
 * are ignored (no pair to disagree).
 *
 * Scoping note — this is *first DISCRETE verdict wins* per (case, reviewer):
 * scalar verdicts are skipped at selection, so a reviewer whose first verdict
 * is scalar but who later gave a discrete one contributes the discrete one.
 * This deliberately differs from `computeKappaSummary`, whose unit is the
 * reviewer *pair*: κ records the literal first verdict and drops the whole pair
 * to `unsupportedPairs` if any shared verdict is scalar. The units differ (κ =
 * pair, disagreement = case), so exact parity isn't meaningful; both ignore
 * scalar from their agreement math.
 *
 * Severity = 1 - (largest agreeing bloc / reviewerCount): 0 when unanimous,
 * approaching 1 as reviewers split evenly. NOTE (A2.2b): this is statistical
 * evenness only — the UI ranking should compose it with case importance
 * (capability cluster / golden membership), not sort on evenness alone.
 */
/**
 * the recorded legacy adjudication per case (latest `adjudicated`
 * verdict wins, by createdAt then id). This is an ungoverned loop-closing decision — it is
 * deliberately NOT a rater (the κ / disagreement math filters on human/judge),
 * so this map only ANNOTATES which disagreements have been resolved and to what.
 * Discrete labels only (an adjudicated scalar can't resolve a discrete split).
 */
function adjudicatedLabelByCase(verdicts: VerdictRecord[]): Map<string, string> {
  const latest = new Map<string, { id: string; label: string; createdAt: string }>();
  for (const verdict of verdicts) {
    if (verdict.source !== "adjudicated") continue;
    const category = toDiscreteCategory(verdict.payload);
    if (category === null) continue;
    const existing = latest.get(verdict.caseId);
    if (!existing || verdict.createdAt > existing.createdAt || (
      verdict.createdAt === existing.createdAt && verdict.id > existing.id
    )) {
      latest.set(verdict.caseId, { id: verdict.id, label: category, createdAt: verdict.createdAt });
    }
  }
  const out = new Map<string, string>();
  for (const [caseId, { label }] of latest) out.set(caseId, label);
  return out;
}

/**
 * The latest discrete judge label per case for ONE specific skill version.
 * Pinned to `skillVersionId` (not latest-wins across versions) so the
 * convergence audit measures exactly the version under review — see the A2.2c
 * version-pinning requirement. Returns an empty map when versionId is null.
 */
function judgeLabelByCaseForVersion(
  verdicts: VerdictRecord[],
  skillVersionId: string | null
): Map<string, string> {
  const latest = new Map<string, { id: string; label: string; createdAt: string }>();
  if (skillVersionId === null) return new Map();
  for (const verdict of verdicts) {
    if (verdict.source !== "llm_judge" || verdict.skillVersionId !== skillVersionId) continue;
    const category = toDiscreteCategory(verdict.payload);
    if (category === null) continue;
    const existing = latest.get(verdict.caseId);
    if (!existing || verdict.createdAt > existing.createdAt || (
      verdict.createdAt === existing.createdAt && verdict.id > existing.id
    )) {
      latest.set(verdict.caseId, { id: verdict.id, label: category, createdAt: verdict.createdAt });
    }
  }
  const out = new Map<string, string>();
  for (const [caseId, { label }] of latest) out.set(caseId, label);
  return out;
}

/**
 * A2.2c: the ungoverned legacy convergence audit — did a skill edit move the
 * judge toward recorded adjudications? On that slice, compare the audited
 * version's judge label (`afterVersionId`) against the prior version's
 * (`beforeVersionId`), both measured vs the adjudicated label.
 *
 * A case is "compared" once it's adjudicated AND the audited version has judged
 * it. The prior version may not have judged every such case (it may predate the
 * case), so `beforeKnown` is tracked separately as the before-denominator. When
 * `beforeVersionId` is null (the audited version is the baseline) there's no
 * delta — only the current agreement (`afterAgreed`) is meaningful.
 */
export function computeConvergenceAudit(
  verdicts: VerdictRecord[],
  versions: { beforeVersionId: string | null; afterVersionId: string }
): ConvergenceAudit {
  const adjudicated = adjudicatedLabelByCase(verdicts);
  const afterByCase = judgeLabelByCaseForVersion(verdicts, versions.afterVersionId);
  const beforeByCase = judgeLabelByCaseForVersion(verdicts, versions.beforeVersionId);

  const cases: ConvergenceAuditCase[] = [];
  let afterAgreed = 0;
  let beforeKnown = 0;
  let beforeAgreed = 0;
  let improved = 0;
  let regressed = 0;

  for (const [caseId, truth] of adjudicated) {
    const afterLabel = afterByCase.get(caseId);
    if (afterLabel === undefined) continue; // audited version hasn't judged it → can't compare
    const beforeLabel = beforeByCase.get(caseId) ?? null;

    const afterAgrees = afterLabel === truth;
    const beforeIsKnown = beforeLabel !== null;
    const beforeAgrees = beforeIsKnown && beforeLabel === truth;

    if (afterAgrees) afterAgreed += 1;
    if (beforeIsKnown) {
      beforeKnown += 1;
      if (beforeAgrees) beforeAgreed += 1;
    }

    let change: ConvergenceCaseChange;
    if (afterAgrees && beforeIsKnown && !beforeAgrees) {
      change = "improved";
      improved += 1;
    } else if (!afterAgrees && beforeIsKnown && beforeAgrees) {
      change = "regressed";
      regressed += 1;
    } else if (afterAgrees) {
      change = "still_agree";
    } else {
      change = "still_disagree";
    }

    cases.push({ caseId, adjudicatedLabel: truth, beforeLabel, afterLabel, change });
  }

  // Stable, useful ordering: regressions first (most alarming), then
  // improvements (the wins), then the unchanged, then by caseId.
  const rank: Record<ConvergenceCaseChange, number> = {
    regressed: 0,
    improved: 1,
    still_disagree: 2,
    still_agree: 3
  };
  cases.sort((a, b) => rank[a.change] - rank[b.change] || a.caseId.localeCompare(b.caseId));

  return {
    afterVersionId: versions.afterVersionId,
    beforeVersionId: versions.beforeVersionId,
    adjudicatedTotal: adjudicated.size,
    comparedCases: cases.length,
    afterAgreed,
    beforeKnown,
    beforeAgreed,
    improved,
    regressed,
    cases
  };
}

/**
 * judge self-consistency for one skill version. Groups that version's
 * `llm_judge` verdicts by case and, for cases judged 2+ times, measures how
 * often the judge agreed with itself (largest label bloc / runs). A judge at
 * temperature 0 should score ≈1; flips are a reliability red flag. Discrete
 * labels only. Pinned to the version — a re-run by a different version isn't a
 * consistency sample for this one.
 */
export function computeSelfConsistency(verdicts: VerdictRecord[], skillVersionId: string): SelfConsistencyReport {
  const labelsByCase = new Map<string, string[]>();
  for (const verdict of verdicts) {
    if (verdict.source !== "llm_judge" || verdict.skillVersionId !== skillVersionId) continue;
    const category = toDiscreteCategory(verdict.payload);
    if (category === null) continue;
    const list = labelsByCase.get(verdict.caseId);
    if (list) list.push(category);
    else labelsByCase.set(verdict.caseId, [category]);
  }

  const cases: SelfConsistencyCase[] = [];
  let consistentCases = 0;
  let agreementSum = 0;

  for (const [caseId, labels] of labelsByCase) {
    if (labels.length < 2) continue; // a single run is trivially consistent
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    const largest = Math.max(...counts.values());
    // Majority label; ties broken alphabetically for a stable result.
    const majorityLabel = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const agreement = largest / labels.length;
    if (agreement === 1) consistentCases += 1;
    agreementSum += agreement;
    cases.push({ caseId, runs: labels.length, distinctLabels: counts.size, majorityLabel, agreement });
  }

  cases.sort((a, b) => a.agreement - b.agreement || a.caseId.localeCompare(b.caseId));

  return {
    skillVersionId,
    comparedCases: cases.length,
    consistentCases,
    meanAgreement: cases.length === 0 ? null : agreementSum / cases.length,
    cases
  };
}

export function computeDisagreementSummary(verdicts: VerdictRecord[]): DisagreementSummary {
  const byCaseReviewer = new Map<string, Map<string, string>>();
  for (const verdict of verdicts) {
    if (verdict.source !== "human" || verdict.actorUserId === null) continue;
    const category = toDiscreteCategory(verdict.payload);
    if (category === null) continue; // scalar — not comparable
    let inner = byCaseReviewer.get(verdict.caseId);
    if (!inner) {
      inner = new Map();
      byCaseReviewer.set(verdict.caseId, inner);
    }
    // Append-only: first verdict per (case, reviewer) is canonical.
    if (!inner.has(verdict.actorUserId)) inner.set(verdict.actorUserId, category);
  }

  const adjudicated = adjudicatedLabelByCase(verdicts);
  let comparedCases = 0;
  const cases: DisagreementCase[] = [];

  for (const [caseId, inner] of byCaseReviewer) {
    if (inner.size < 2) continue; // need ≥2 reviewers to disagree
    comparedCases += 1;

    const counts = new Map<string, number>();
    for (const category of inner.values()) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    if (counts.size < 2) continue; // unanimous — not a disagreement

    const reviewerCount = inner.size;
    const largestBloc = Math.max(...counts.values());
    const severity = 1 - largestBloc / reviewerCount;
    const labels = [...inner.entries()]
      .map(([actorUserId, label]) => ({ actorUserId, label }))
      .sort((a, b) => a.actorUserId.localeCompare(b.actorUserId));

    cases.push({
      caseId,
      reviewerCount,
      distinctLabels: counts.size,
      labels,
      severity,
      adjudicatedLabel: adjudicated.get(caseId) ?? null
    });
  }

  cases.sort(
    (a, b) =>
      b.severity - a.severity ||
      b.distinctLabels - a.distinctLabels ||
      b.reviewerCount - a.reviewerCount ||
      a.caseId.localeCompare(b.caseId)
  );

  return {
    comparedCases,
    disagreedCases: cases.length,
    resolvedCases: cases.filter((c) => c.adjudicatedLabel !== null).length,
    cases
  };
}

/**
 * A2.2 PRIMARY disagreement feed: where the LLM judge and human reviewers
 * disagree on the same case. Unlike human-human disagreement (which needs ≥2
 * humans on one case — rare under single-reviewer exception triage), this is
 * non-empty whenever a human reviewed a case the judge also verdicted, which is
 * every reviewed exception. So it's the cold-start-proof entry to the
 * convergence loop.
 *
 * Per case: the judge's verdict = the LATEST llm_judge verdict (most recent
 * skill version to touch the case); human verdicts = first-verdict-wins per
 * reviewer. Discrete (binary/categorical) only — scalar verdicts are skipped.
 * A case is "compared" once it has both a judge label and ≥1 human label; it
 * "disagrees" when ≥1 human differs from the judge. Severity = fraction of
 * humans contradicting the judge (1 = unanimous "judge is wrong here").
 */
export function computeJudgeHumanDisagreement(verdicts: VerdictRecord[]): JudgeHumanDisagreementSummary {
  // Latest judge label per case (by createdAt; ties broken by later array
  // position, which the asc-ordered load makes "most recent wins").
  const judgeLabelByCase = new Map<string, { label: string; createdAt: string }>();
  const humanByCaseReviewer = new Map<string, Map<string, string>>();

  for (const verdict of verdicts) {
    const category = toDiscreteCategory(verdict.payload);
    if (category === null) continue; // scalar — not comparable
    if (verdict.source === "llm_judge") {
      const existing = judgeLabelByCase.get(verdict.caseId);
      if (!existing || verdict.createdAt >= existing.createdAt) {
        judgeLabelByCase.set(verdict.caseId, { label: category, createdAt: verdict.createdAt });
      }
    } else if (verdict.source === "human" && verdict.actorUserId !== null) {
      let inner = humanByCaseReviewer.get(verdict.caseId);
      if (!inner) {
        inner = new Map();
        humanByCaseReviewer.set(verdict.caseId, inner);
      }
      if (!inner.has(verdict.actorUserId)) inner.set(verdict.actorUserId, category);
    }
  }

  const adjudicated = adjudicatedLabelByCase(verdicts);
  let comparedCases = 0;
  const cases: JudgeHumanDisagreementCase[] = [];

  for (const [caseId, judge] of judgeLabelByCase) {
    const humans = humanByCaseReviewer.get(caseId);
    if (!humans || humans.size === 0) continue; // need ≥1 human verdict
    comparedCases += 1;

    const humanLabels = [...humans.entries()]
      .map(([actorUserId, label]) => ({ actorUserId, label }))
      .sort((a, b) => a.actorUserId.localeCompare(b.actorUserId));
    const disagreeingHumans = humanLabels.filter((h) => h.label !== judge.label).length;
    if (disagreeingHumans === 0) continue; // judge agrees with every human

    const agreeingHumans = humanLabels.length - disagreeingHumans;
    cases.push({
      caseId,
      judgeLabel: judge.label,
      humanLabels,
      agreeingHumans,
      disagreeingHumans,
      severity: disagreeingHumans / humanLabels.length,
      adjudicatedLabel: adjudicated.get(caseId) ?? null
    });
  }

  cases.sort(
    (a, b) =>
      b.severity - a.severity ||
      b.disagreeingHumans - a.disagreeingHumans ||
      a.caseId.localeCompare(b.caseId)
  );

  return {
    comparedCases,
    disagreedCases: cases.length,
    resolvedCases: cases.filter((c) => c.adjudicatedLabel !== null).length,
    cases
  };
}

/**
 * Compute LLM-judge ↔ human-reviewer agreement using the same κ machinery as
 * `computeKappaSummary`. The trick is to treat each LLM-judge skill-version as
 * a synthetic "reviewer" keyed by `judge:<skillVersionId>` so the existing
 * pairwise-κ logic flows unchanged.
 *
 * Coeval's second κ-shaped wedge: not just "do humans agree with each other?"
 * but "does the LLM judge agree with our team?" — a calibration metric none of
 * the surveyed competitors compute. Builds on PR #42 (Cohen's κ math) + PR #43
 * (human verdicts) + PR #54 (full verdict-shape UI).
 *
 * The synthetic-actor trick: any verdict with `source = 'llm_judge'` gets
 * rewritten with `source: 'human'` and `actorUserId: 'judge:<skillVersionId>'`
 * before being fed into `computeKappaSummary`. Real humans pass through
 * unchanged. The resulting pairs[] include (judge:..., real_user_id) entries
 * that the UI renders as "Judge skillv_X · reviewer_a" rows.
 */
export function computeJudgeHumanCalibration(verdicts: VerdictRecord[]): KappaSummary {
  const transformed: VerdictRecord[] = verdicts.map((verdict) => {
    if (verdict.source !== "llm_judge") return verdict;
    return {
      ...verdict,
      source: "human",
      // Keyed by skill version so calibration is per-version (a new skill
      // shouldn't poison the calibration history of the old one). Falls back
      // to a literal "current" if a verdict somehow lacks a skill version.
      actorUserId: `judge:${verdict.skillVersionId ?? "current"}`
    };
  });
  // Calibration asks ONE question: does the judge agree with the team? Only
  // judge×human pairs participate. human×human rows are the κ surface's job,
  // and judge-version×judge-version rows usually score highest (a model
  // agreeing with its own previous prompt) — they would inflate the
  // calibration mean exactly when a new version changed nothing. Filtering
  // INSIDE the summary keeps overlappingCases/unsupportedPairs/mean
  // describing the returned pairs (and skips the wasted per-pair case scans).
  return computeKappaSummary(transformed, {
    pairFilter: (a, b) => isJudgeActorId(a) !== isJudgeActorId(b)
  });
}

/**
 * Returns true if the synthetic-actor id was produced by computeJudgeHuman-
 * Calibration. The dashboard uses this to render judge rows differently.
 */
export function isJudgeActorId(actorId: string): boolean {
  return actorId.startsWith("judge:");
}
