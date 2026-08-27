import type { ConvergenceAudit, ConvergenceAuditCase } from "@coeval/shared";

export type ReliabilityHeroProjection = {
  agreementPercent: string | null;
  agreementSentence: string;
  coverageSentence: string;
  sampleCaveat: string;
  nextDisagreementCaseId: string | null;
};

export type ReliabilityHeroAction =
  | { kind: "open_case"; label: string; caseId: string }
  | { kind: "run_uncovered"; label: string; caseId: string }
  | { kind: "open_exceptions"; label: string; caseId: null };

export function reliabilityHeroProjection(audit: ConvergenceAudit): ReliabilityHeroProjection {
  const nextDisagreement = audit.cases.find((item) => item.afterLabel !== item.adjudicatedLabel) ?? null;

  if (audit.adjudicatedTotal === 0) {
    return {
      agreementPercent: null,
      agreementSentence: "No recorded legacy adjudications are available for this evaluator version yet.",
      coverageSentence: "0 adjudicated cases are available to compare.",
      sampleCaveat: "Record rulings from exact exception traces before reading this as an agreement diagnostic.",
      nextDisagreementCaseId: null
    };
  }

  if (audit.comparedCases === 0) {
    return {
      agreementPercent: null,
      agreementSentence: `This evaluator version has not judged any of the ${audit.adjudicatedTotal} recorded legacy adjudication${audit.adjudicatedTotal === 1 ? "" : "s"}.`,
      coverageSentence: `0 of ${audit.adjudicatedTotal} adjudicated cases were covered by this version.`,
      sampleCaveat: "Re-run those exact cases with this version before comparing its output with the recorded rulings.",
      nextDisagreementCaseId: null
    };
  }

  const percent = Math.round((audit.afterAgreed / audit.comparedCases) * 100);
  const currentRate = audit.afterAgreed / audit.comparedCases;
  const rateIfNextMatches = (audit.afterAgreed + 1) / (audit.comparedCases + 1);
  const rateIfNextDiffers = audit.afterAgreed / (audit.comparedCases + 1);
  const oneCasePoints = Math.max(1, Math.round(100 * Math.max(
    Math.abs(rateIfNextMatches - currentRate),
    Math.abs(rateIfNextDiffers - currentRate)
  )));
  return {
    agreementPercent: `${percent}%`,
    agreementSentence: `This evaluator matched the recorded legacy adjudication on ${audit.afterAgreed} of ${audit.comparedCases} adjudicated case${audit.comparedCases === 1 ? "" : "s"} it judged.`,
    coverageSentence: `${audit.comparedCases} of ${audit.adjudicatedTotal} adjudicated case${audit.adjudicatedTotal === 1 ? " was" : "s were"} covered by this version.`,
    sampleCaveat: `Descriptive only: this is an ungoverned, self-selected slice. One additional case can move the displayed rate by up to about ${oneCasePoints} percentage point${oneCasePoints === 1 ? "" : "s"}.`,
    nextDisagreementCaseId: nextDisagreement?.caseId ?? null
  };
}

export function reliabilityHeroAction(
  audit: ConvergenceAudit,
  nextUncoveredCaseId: string | null
): ReliabilityHeroAction {
  const disagreement = audit.cases.find((item) => item.afterLabel !== item.adjudicatedLabel);
  if (disagreement) {
    return { kind: "open_case", label: "Review current-version disagreement", caseId: disagreement.caseId };
  }
  if (audit.adjudicatedTotal === 0) {
    return { kind: "open_exceptions", label: "Rule more exceptions", caseId: null };
  }
  if (nextUncoveredCaseId) {
    return {
      kind: "run_uncovered",
      label: "Run current version on next uncovered case",
      caseId: nextUncoveredCaseId
    };
  }
  return { kind: "open_exceptions", label: "Review exceptions", caseId: null };
}

export function convergenceCaseComparisonLabel(item: ConvergenceAuditCase): string {
  if (item.beforeLabel === null) {
    return item.afterLabel === item.adjudicatedLabel
      ? "No prior judgment; this version matches the recorded ruling"
      : "No prior judgment; this version differs from the recorded ruling";
  }
  if (item.change === "improved") return "Now matches the recorded ruling";
  if (item.change === "regressed") return "Now differs from the recorded ruling";
  if (item.change === "still_agree") return "Still matches the recorded ruling";
  return "Still differs from the recorded ruling";
}
