import { KAPPA_MIN_SHARED_CASES } from "@coeval/shared";
import type {
  GoldenSetHealthSummary,
  KappaSummary,
  SelfConsistencyReport,
  SkillVersion,
  TrustDigest,
  TrustDigestSpend,
  TrustNudge
} from "@coeval/shared";

// assemble the trust digest from RECORDED evidence only. Nudges fire
// exclusively on the locked thresholds; absent signals become explicit
// "no signal yet" facts. No composite score, no severity ranking — the
// nudges are a list, each carrying its own falsifier.

export const SPEND_WINDOW_RUNS = 10;

const BELOW_MODERATE = new Set(["poor", "slight", "fair"]);

export function buildTrustDigest(input: {
  generatedAt: string;
  version: SkillVersion;
  goldenSetHealth: GoldenSetHealthSummary;
  calibration: KappaSummary;
  selfConsistency: SelfConsistencyReport;
  spend: TrustDigestSpend;
}): TrustDigest {
  const nudges: TrustNudge[] = [];
  const noSignal: string[] = [];

  // κ pairs for THIS version's judge rater (A2.2c: version-pinned).
  const judgeRater = `judge:${input.version.id}`;
  const undefinedJudgeHumanPairs = (input.calibration.undefinedPairs ?? []).filter(
    (pair) => pair.reviewerA === judgeRater || pair.reviewerB === judgeRater
  );
  const judgeHumanKappa = input.calibration.pairs
    .filter((pair) => pair.reviewerA === judgeRater || pair.reviewerB === judgeRater)
    .map((pair) => ({
      humanRater: pair.reviewerA === judgeRater ? pair.reviewerB : pair.reviewerA,
      kappa: pair.kappa,
      interpretation: pair.interpretation,
      cases: pair.cases
    }));

  // Golden-set health: an EMPTY set is "no signal yet", never a nudge (the
  // health builder marks empty sets needs_action — gate on totalActive > 0).
  if (input.goldenSetHealth.totalActive === 0) {
    noSignal.push("golden set: no active entries yet — promote reviewed cases to light this signal up.");
  } else if (input.goldenSetHealth.status === "needs_action") {
    // needs_action has THREE independent drivers (small set, staleness,
    // duplicates) — the nudge must name the REAL one(s), and the falsifier
    // must actually clear it (review finding: a staleness-worded nudge on a
    // merely-small set gave guidance that could never resolve it).
    const health = input.goldenSetHealth;
    const causes: string[] = [];
    const falsifiers: string[] = [];
    if (health.staleCount > 0) {
      causes.push(`${health.staleCount} of ${health.totalActive} active entr${health.totalActive === 1 ? "y" : "ies"} stale (older than ${health.staleAfterDays} days)`);
      falsifiers.push("re-review or retire the stale entries");
    }
    if (health.duplicateCount > 0) {
      causes.push(`${health.duplicateCount} duplicate(s)`);
      falsifiers.push("retire the duplicate entries");
    }
    if (causes.length === 0) {
      // Small-set driver: the only remaining reason the builder flags.
      causes.push(`only ${health.totalActive} active entr${health.totalActive === 1 ? "y" : "ies"} — a small set gates weakly`);
      falsifiers.push("promote more reviewed cases");
    }
    nudges.push({
      signal: "golden_health",
      sentence: `Golden set needs action: ${causes.join("; ")}.`,
      falsifier: `What would prove this wrong: ${falsifiers.join("; ")} — the signal clears when the recorded set is current and large enough to gate.`
    });
  }

  // Judge–human κ: below moderate over the shared minimum sample.
  const weakPairs = judgeHumanKappa.filter(
    (pair) => BELOW_MODERATE.has(pair.interpretation) && pair.cases >= KAPPA_MIN_SHARED_CASES
  );
  if (judgeHumanKappa.length === 0) {
    noSignal.push(undefinedJudgeHumanPairs.length > 0
      ? `judge–human κ: undefined for ${undefinedJudgeHumanPairs.length} reviewer pair(s) because expected agreement is 1; raw agreement is not converted to favorable κ.`
      : "judge–human κ: no human verdicts overlap this version yet — record reviews on judged cases to light this signal up."
    );
  } else {
    for (const pair of weakPairs) {
      nudges.push({
        signal: "judge_human_kappa",
        sentence:
          `Judge–human agreement is ${pair.interpretation.replace("_", " ")} (κ ${pair.kappa.toFixed(2)}) vs ` +
          `${pair.humanRater} over ${pair.cases} overlapping case(s).`,
        falsifier:
          "What would prove this wrong: more overlapping reviews that agree — κ rises as recorded human verdicts and judge verdicts align; a handful of cases can swing it."
      });
    }
  }

  // Self-consistency: < 1.0 over ≥3 repeat-judged cases.
  if (input.selfConsistency.comparedCases === 0) {
    noSignal.push("self-consistency: no case has been judged twice by this version — repeat runs populate it.");
  } else if (
    input.selfConsistency.comparedCases >= 3 &&
    input.selfConsistency.meanAgreement !== null &&
    input.selfConsistency.meanAgreement < 1
  ) {
    nudges.push({
      signal: "self_consistency",
      sentence:
        `Self-consistency: ${input.selfConsistency.consistentCases} of ${input.selfConsistency.comparedCases} ` +
        `repeat-judged case(s) fully consistent (mean per-case agreement ${input.selfConsistency.meanAgreement.toFixed(2)}). ` +
        "Consistent ≠ correct — this only measures whether the judge repeats itself.",
      falsifier:
        "What would prove this wrong: repeat runs that agree — probe the least-consistent cases; a tighter rubric usually closes the gap."
    });
  }

  if (input.spend.runsCounted === 0) {
    noSignal.push("spend: no eval runs recorded yet.");
  }

  return {
    generatedAt: input.generatedAt,
    skillVersionId: input.version.id,
    version: input.version.version,
    goldenSetHealth: input.goldenSetHealth,
    judgeHumanKappa,
    selfConsistency: input.selfConsistency,
    spend: input.spend,
    nudges,
    noSignal
  };
}
