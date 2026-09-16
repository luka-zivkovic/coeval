// The three experiments. Each returns a plain report object with a verdict
// and the per-item rows behind it, so a run can be written to disk and
// compared with a later run. None of this is governed evidence: it runs on
// nonsealed development fixtures and its outputs are ASSUMPTION-class
// diagnostics, never a calibration claim under ADR-0004 or ADR-0009.

import { criterionQuestion, questionDigest } from "./questions.mjs";
import {
  brierScore,
  confusionAt,
  distributionShift,
  expectedCalibrationError,
  overlapPermutationTest,
  rocAuc,
  round
} from "./metrics.mjs";

function probabilityOf(result, key) {
  const answer = result.answers?.[key];
  if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") {
    throw new Error(`provider did not return a noul probability for "${key}"`);
  }
  return answer.noul;
}

/**
 * Experiment 3 from the lateral pass: split-view disagreement.
 * Ask the same yes/no question twice per case, once with only the assistant
 * output as state and once with the full trace (input, output, steps). Where
 * the two views disagree, the criterion is ambiguous about which evidence
 * matters. The test: do disagreements concentrate on the cases where human
 * reviewers also disagreed, more than a random subset of the same size would?
 */
export async function runSplitView({ provider, criterion, cases, delta = 0.25, permutations = 2000, seed = 7 }) {
  const questions = criterionQuestion(criterion);
  const rows = [];
  let usage = 0;
  for (const item of cases) {
    const outputOnly = await provider.systemOne({ state: { output: item.output }, questions });
    const full = await provider.systemOne({ state: { input: item.input, output: item.output, steps: item.steps ?? [] }, questions });
    usage += (outputOnly.usage?.input_tokens ?? 0) + (full.usage?.input_tokens ?? 0);
    const pOutput = probabilityOf(outputOnly, criterion.key);
    const pFull = probabilityOf(full, criterion.key);
    const flipped = pOutput >= 0.5 !== pFull >= 0.5;
    const disagreement = flipped || Math.abs(pFull - pOutput) >= delta;
    rows.push({
      caseId: item.id,
      pOutputOnly: round(pOutput),
      pFullTrace: round(pFull),
      absDelta: round(Math.abs(pFull - pOutput)),
      flipped,
      disagreement,
      reviewerDisagreement: Boolean(item.reviewerDisagreement),
      humanLabel: item.humanLabel
    });
  }
  const test = overlapPermutationTest(rows.map((r) => r.disagreement), rows.map((r) => r.reviewerDisagreement), { permutations, seed });
  const fullView = rows.map((r) => ({ p: r.pFullTrace, label: r.humanLabel === "pass" ? 1 : 0 }));
  const outputView = rows.map((r) => ({ p: r.pOutputOnly, label: r.humanLabel === "pass" ? 1 : 0 }));
  const verdict = test.observed === null
    ? "inconclusive_no_disagreements"
    : test.lift !== null && test.lift > 1 && test.pValue <= 0.05
      ? "pass"
      : "fail";
  return {
    experiment: "split_view_disagreement",
    provider: provider.name,
    model: null,
    criterion: criterion.key,
    questionDigest: await questionDigest(questions),
    parameters: { delta, permutations, seed, cases: cases.length },
    summary: {
      disagreements: test.selectedCount,
      overlapWithReviewerDisagreement: round(test.observed),
      expectedOverlapUnderShuffle: round(test.expected),
      lift: round(test.lift, 2),
      pValue: round(test.pValue, 4),
      fullViewAuc: round(rocAuc(fullView)),
      outputOnlyAuc: round(rocAuc(outputView)),
      inputTokens: usage
    },
    verdict,
    rule: "pass when disagreements overlap reviewer disagreement more than shuffled (lift > 1) with one-sided p <= 0.05",
    rows
  };
}

/**
 * Experiment 4 from the lateral pass: minimal-pair probes.
 * Each pair is one real passing trace and a copy edited to fail the criterion
 * in exactly one way. The edit is the label, so no human review is needed.
 * The probe measures sensitivity to the named failure, not accuracy on the
 * production distribution, and is filed as its own evidence class.
 */
export async function runMinimalPairs({ provider, criterion, pairs, margin = 0.3 }) {
  const questions = criterionQuestion(criterion);
  const rows = [];
  let usage = 0;
  for (const pair of pairs) {
    const passing = await provider.systemOne({ state: { input: pair.input, output: pair.passOutput, steps: pair.steps ?? [] }, questions });
    const failing = await provider.systemOne({ state: { input: pair.input, output: pair.failOutput, steps: pair.steps ?? [] }, questions });
    usage += (passing.usage?.input_tokens ?? 0) + (failing.usage?.input_tokens ?? 0);
    const pPass = probabilityOf(passing, criterion.key);
    const pFail = probabilityOf(failing, criterion.key);
    rows.push({
      pairId: pair.id,
      edit: pair.edit,
      pPassingTrace: round(pPass),
      pFailingTrace: round(pFail),
      separation: round(pPass - pFail),
      ordered: pPass > pFail,
      separatedByMargin: pPass - pFail >= margin
    });
  }
  const pairwiseAuc = rows.length === 0 ? null : rows.filter((r) => r.ordered).length / rows.length;
  const marginRate = rows.length === 0 ? null : rows.filter((r) => r.separatedByMargin).length / rows.length;
  const verdict = rows.length === 0 ? "inconclusive_no_pairs" : pairwiseAuc >= 0.9 && marginRate >= 0.8 ? "pass" : "fail";
  return {
    experiment: "minimal_pair_probes",
    provider: provider.name,
    criterion: criterion.key,
    questionDigest: await questionDigest(questions),
    parameters: { margin, pairs: pairs.length },
    summary: {
      pairwiseAuc: round(pairwiseAuc),
      separatedByMarginRate: round(marginRate),
      meanSeparation: round(rows.reduce((sum, r) => sum + r.separation, 0) / Math.max(1, rows.length)),
      inputTokens: usage
    },
    verdict,
    rule: "pass when >= 90% of pairs are ordered correctly and >= 80% are separated by the margin",
    rows
  };
}

/**
 * The weekly detection layer, half one: record a replayable per-item
 * probability log for a criterion over a development revision. Because the
 * probabilities are stored, labels that arrive later can recalibrate this run
 * offline, and next week's run can be diffed against it without recalling
 * the provider. Store case ids and probabilities, never payloads.
 */
export async function recordProbabilityLog({ provider, criterion, cases, recordedAt = new Date().toISOString() }) {
  const questions = criterionQuestion(criterion);
  const items = [];
  let model = null;
  let usage = 0;
  for (const item of cases) {
    const result = await provider.systemOne({ state: { input: item.input, output: item.output, steps: item.steps ?? [] }, questions });
    model = result.model ?? model;
    usage += result.usage?.input_tokens ?? 0;
    items.push({ caseId: item.id, p: round(probabilityOf(result, criterion.key), 6), label: item.humanLabel === "pass" ? 1 : item.humanLabel === "fail" ? 0 : null });
  }
  return {
    contract: "typesafe-loop/probability-log/v0",
    criterion: criterion.key,
    provider: provider.name,
    model,
    recordedAt,
    questionDigest: await questionDigest(questions),
    inputTokens: usage,
    items
  };
}

/**
 * The weekly detection layer, half two: compare this week's log with last
 * week's. Reports label-free drift (distribution shift, flips, model identity)
 * and, where labels exist, probability calibration (Brier, ECE) and the
 * ADR-0004 confusion counts at 0.5. The verdict is "review", never a
 * calibration decision: a shift is a reason to look, not proof of error.
 */
export function compareProbabilityLogs({ previous, current, brierDeltaThreshold = 0.05, flipRateThreshold = 0.1 }) {
  if (previous.criterion !== current.criterion) throw new Error("logs describe different criteria");
  const labelled = (log) => log.items.filter((i) => i.label === 0 || i.label === 1);
  const calibration = (log) => {
    const items = labelled(log);
    const { ece, bins } = expectedCalibrationError(items);
    return { labelled: items.length, brier: round(brierScore(items)), ece: round(ece), auc: round(rocAuc(items)), confusionAt050: confusionAt(items, 0.5), reliability: bins.map((b) => ({ ...b, meanConfidence: round(b.meanConfidence), observedRate: round(b.observedRate) })) };
  };
  const before = calibration(previous);
  const after = calibration(current);
  const shift = distributionShift(previous.items, current.items);
  const reasons = [];
  if (previous.model !== current.model) reasons.push(`model changed from ${previous.model} to ${current.model}`);
  if (previous.questionDigest !== current.questionDigest) reasons.push("question digest changed; the runs are not comparable as drift");
  if (shift.flipRate !== null && shift.flipRate >= flipRateThreshold) reasons.push(`label flips on ${round(shift.flipRate * 100, 1)}% of shared cases`);
  if (before.brier !== null && after.brier !== null && after.brier - before.brier >= brierDeltaThreshold) reasons.push(`Brier worsened by ${round(after.brier - before.brier)}`);
  return {
    experiment: "weekly_drift_replay",
    criterion: current.criterion,
    previous: { recordedAt: previous.recordedAt, model: previous.model, ...before },
    current: { recordedAt: current.recordedAt, model: current.model, ...after },
    shift: { ...shift, meanDelta: round(shift.meanDelta), maxAbsDelta: round(shift.maxAbsDelta), flipRate: round(shift.flipRate) },
    verdict: reasons.length > 0 ? "review" : "steady",
    reasons,
    rule: "review when the model identity changes, flips exceed the flip-rate threshold, or Brier worsens by the delta threshold"
  };
}
