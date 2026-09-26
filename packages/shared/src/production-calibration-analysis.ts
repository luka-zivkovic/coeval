import {
  PRODUCTION_CALIBRATION_CONFIDENCE_BASIS_POINTS,
  PRODUCTION_CALIBRATION_CONTRACT,
  PRODUCTION_CALIBRATION_DEFAULT_BINS,
  PRODUCTION_CALIBRATION_DEFAULT_MIN_OUTCOMES_TO_FLAG,
  PRODUCTION_CALIBRATION_DEFAULT_THRESHOLD,
  PRODUCTION_CALIBRATION_DEFAULT_WINDOW_DAYS,
  PRODUCTION_CALIBRATION_INTERVAL_DEFINITION_VERSION,
  PRODUCTION_CALIBRATION_MAX_BINS,
  PRODUCTION_CALIBRATION_MAX_SCORE_LEVELS,
  PRODUCTION_CALIBRATION_METRIC_DEFINITION_VERSION,
  PRODUCTION_CALIBRATION_MIN_ADVISABLE_OUTCOMES,
  PRODUCTION_CALIBRATION_MIN_SCORE_LEVELS,
  PRODUCTION_CALIBRATION_SCORE_SUM_TOLERANCE,
  PRODUCTION_CALIBRATION_THRESHOLD_GRID,
  PRODUCTION_CALIBRATION_WILSON_Z,
  PRODUCTION_DECISION_RECORD_CONTRACT,
  ProductionCalibrationParametersSchema,
  ProductionCalibrationProbabilitySchema
} from "./production-calibration.js";
import type {
  ProductionActionRecord,
  ProductionCalibrationAdviceCaveat,
  ProductionCalibrationArtifact,
  ProductionCalibrationBandSweepRow,
  ProductionCalibrationBoolean,
  ProductionCalibrationChoice,
  ProductionCalibrationChoiceConfusionCell,
  ProductionCalibrationConfusion,
  ProductionCalibrationDrift,
  ProductionCalibrationModelIdentity,
  ProductionCalibrationQuestion,
  ProductionCalibrationReliabilityBin,
  ProductionCalibrationScore,
  ProductionCalibrationScoreConfusionCell,
  ProductionCalibrationScoreCut,
  ProductionCalibrationScoreModelGroup,
  ProductionCalibrationSingleSweepRow,
  ProductionCalibrationThresholdAdvice,
  ProductionCalibrationWilsonRate,
  ProductionCalibrationWindow,
  ProductionDecisionAnswerType,
  ProductionDecisionLedgerRecord,
  ProductionDecisionQuestionSetRef,
  ProductionDecisionRecord,
  ProductionDecisionScoreAnswer,
  ProductionOutcomeRecord
} from "./production-calibration.js";

// Pure analysis over arrays of production decision records. Boolean and choice
// math is ported from jevkit's decision ledger. No I/O and no clock: every
// function is a deterministic map from records (and explicit options) to the
// `rubrist/production-calibration/v2` artifact or one of its parts. Every rate
// carries its numerator and denominator and a 95% Wilson interval; a rate
// with a zero denominator is an explicit "undefined" object, never NaN.

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export interface ProductionCalibrationJoinedDecision {
  decision: ProductionDecisionRecord;
  actions: ProductionActionRecord[];
  /** The latest outcome per question (by `at`, then by input order). */
  outcomes: Record<string, ProductionOutcomeRecord>;
  /** All outcome records seen for this decision, including superseded ones. */
  outcomeCount: number;
  /** Superseded outcomes whose value differs from the one that won. */
  conflictingOutcomes: number;
}

// Compare JSON record contents independently of object key order; array order
// and every provenance field remain significant. Only needed for duplicate IDs.
function sameRecordValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) =>
    Object.hasOwn(rightRecord, key) && sameRecordValue(leftRecord[key], rightRecord[key])
  );
}

/** Attach actions and outcomes; deduplicate identical decisions and reject conflicting IDs. Orphans are dropped. */
export function joinProductionDecisionRecords(
  records: readonly ProductionDecisionLedgerRecord[]
): ProductionCalibrationJoinedDecision[] {
  const byId = new Map<string, ProductionCalibrationJoinedDecision>();
  const all = new Map<string, Map<string, ProductionOutcomeRecord[]>>();
  for (const record of records) {
    if (record.kind !== "decision") continue;
    const existing = byId.get(record.id);
    if (existing) {
      if (!sameRecordValue(existing.decision, record)) throw new Error(`Conflicting decision records for id ${record.id}`);
      continue;
    }
    byId.set(record.id, { decision: record, actions: [], outcomes: {}, outcomeCount: 0, conflictingOutcomes: 0 });
    all.set(record.id, new Map());
  }
  for (const record of records) {
    if (record.kind === "action") byId.get(record.decisionId)?.actions.push(record);
    if (record.kind === "outcome") {
      const perQuestion = all.get(record.decisionId);
      if (!perQuestion) continue;
      const list = perQuestion.get(record.question) ?? [];
      list.push(record);
      perQuestion.set(record.question, list);
    }
  }
  for (const [id, perQuestion] of all) {
    const joined = byId.get(id);
    if (!joined) continue;
    for (const [question, list] of perQuestion) {
      // Stable sort by time; the last one wins, so equal timestamps resolve to input order.
      const ordered = list
        .map((outcome, index) => ({ outcome, index }))
        .sort((left, right) => Date.parse(left.outcome.at) - Date.parse(right.outcome.at) || left.index - right.index);
      const winner = ordered[ordered.length - 1]?.outcome;
      if (!winner) continue;
      joined.outcomes[question] = winner;
      joined.outcomeCount += list.length;
      joined.conflictingOutcomes += list.filter((outcome) => outcome !== winner && outcome.value !== winner.value).length;
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Rates and intervals
// ---------------------------------------------------------------------------

export interface ProductionCalibrationWilsonInterval {
  numerator: number;
  denominator: number;
  rate: number;
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a binomial proportion. The default z and binary64
 * operation order are pinned by contracts/binary-calibration-v2.md; do not
 * algebraically simplify them. Explicit endpoint bounds avoid rounding away
 * from 0 or 1 and falsely flagging perfectly correct predictions as drift.
 *
 * Unlike the normal approximation it stays inside [0, 1] and behaves for
 * small n and rates near 0 or 1. Returns null when the denominator is 0.
 */
export function productionCalibrationWilsonInterval(
  numerator: number,
  denominator: number,
  z: number = PRODUCTION_CALIBRATION_WILSON_Z
): ProductionCalibrationWilsonInterval | null {
  if (denominator <= 0) return null;
  const zSquared = z * z;
  const adjustedDenominator = denominator + zSquared;
  const centerNumerator = numerator + (zSquared / 2);
  const remaining = denominator - numerator;
  const product = numerator * remaining;
  const scaledProduct = product / denominator;
  const correction = zSquared / 4;
  const radicand = scaledProduct + correction;
  const root = Math.sqrt(radicand);
  const marginNumerator = z * root;
  const lowerRaw = (centerNumerator - marginNumerator) / adjustedDenominator;
  const upperRaw = (centerNumerator + marginNumerator) / adjustedDenominator;
  const lower = numerator === 0 ? 0 : Math.max(0, lowerRaw);
  const upper = numerator === denominator ? 1 : Math.min(1, upperRaw);
  return { numerator, denominator, rate: numerator / denominator, lower, upper };
}

/** A rate that carries its own denominator; explicit when it cannot be computed. */
export function productionCalibrationRate(numerator: number, denominator: number): ProductionCalibrationWilsonRate {
  const interval = productionCalibrationWilsonInterval(numerator, denominator);
  if (!interval) {
    return { state: "undefined", numerator: 0, denominator: 0, undefinedReason: "zero_denominator", interval: null };
  }
  return {
    state: "defined",
    numerator,
    denominator,
    rate: interval.rate,
    interval: {
      method: PRODUCTION_CALIBRATION_INTERVAL_DEFINITION_VERSION,
      confidenceBasisPoints: PRODUCTION_CALIBRATION_CONFIDENCE_BASIS_POINTS,
      lower: interval.lower,
      upper: interval.upper
    }
  };
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export function productionCalibrationModelIdentity(
  decision: Pick<ProductionDecisionRecord, "provider" | "model">
): ProductionCalibrationModelIdentity {
  return {
    provider: decision.provider,
    observedModel: decision.model,
    identityStrength: decision.model === null ? "unreported" : "observed_version"
  };
}

function modelIdentityKey(identity: ProductionCalibrationModelIdentity): string {
  return `${identity.provider}\u0000${identity.observedModel ?? ""}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareModelIdentity(left: ProductionCalibrationModelIdentity, right: ProductionCalibrationModelIdentity): number {
  return compareText(left.provider, right.provider) ||
    compareText(left.observedModel ?? "", right.observedModel ?? "");
}

// ---------------------------------------------------------------------------
// Shared binary machinery
// ---------------------------------------------------------------------------

/** One prediction of a binary event, oriented so that `y === true` is the positive class. */
interface BinaryPair {
  p: number;
  y: boolean | null;
  model: ProductionCalibrationModelIdentity;
  digest: string;
  at: string;
}

type ScoredBinaryPair = BinaryPair & { y: boolean };

interface BinaryStats {
  n: number;
  nWithOutcome: number;
  brier: number | null;
  ece: number | null;
  reliability: ProductionCalibrationReliabilityBin[];
}

function isScored(pair: BinaryPair): pair is ScoredBinaryPair {
  return pair.y !== null;
}

function binIndex(p: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
}

function binaryStats(pairs: readonly BinaryPair[], bins: number): BinaryStats {
  const scored = pairs.filter(isScored);
  const nWithOutcome = scored.length;
  const sums = Array.from({ length: bins }, () => ({ count: 0, sumP: 0, positives: 0 }));
  let squaredError = 0;
  for (const { p, y } of scored) {
    const slot = sums[binIndex(p, bins)];
    if (!slot) continue;
    slot.count += 1;
    slot.sumP += p;
    if (y) slot.positives += 1;
    const yNum = y ? 1 : 0;
    squaredError += (p - yNum) * (p - yNum);
  }
  const reliability: ProductionCalibrationReliabilityBin[] = sums.map((slot, index) => ({
    index,
    lower: index / bins,
    upper: (index + 1) / bins,
    count: slot.count,
    meanPredicted: slot.count > 0 ? slot.sumP / slot.count : null,
    observedRate: productionCalibrationRate(slot.positives, slot.count)
  }));
  let ece: number | null = null;
  if (nWithOutcome > 0) {
    ece = 0;
    for (const bin of reliability) {
      if (bin.count === 0 || bin.meanPredicted === null || bin.observedRate.state !== "defined") continue;
      ece += (bin.count / nWithOutcome) * Math.abs(bin.observedRate.rate - bin.meanPredicted);
    }
  }
  return {
    n: pairs.length,
    nWithOutcome,
    brier: nWithOutcome > 0 ? squaredError / nWithOutcome : null,
    ece,
    reliability
  };
}

/** Counts at `p >= threshold` means "predicted positive". */
function confusionAt(pairs: readonly BinaryPair[], threshold: number): ProductionCalibrationConfusion {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const { p, y } of pairs) {
    if (y === null) continue;
    const predicted = p >= threshold;
    if (predicted && y) tp += 1;
    else if (predicted && !y) fp += 1;
    else if (!predicted && !y) tn += 1;
    else fn += 1;
  }
  return {
    threshold,
    truePositive: tp,
    falsePositive: fp,
    trueNegative: tn,
    falseNegative: fn,
    accuracy: productionCalibrationRate(tp + tn, tp + fp + tn + fn),
    precision: productionCalibrationRate(tp, tp + fp),
    recall: productionCalibrationRate(tp, tp + fn),
    specificity: productionCalibrationRate(tn, tn + fp)
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k) ?? [];
    list.push(item);
    groups.set(k, list);
  }
  return groups;
}

/** Boolean answers to `question`, oriented to the positive class. */
function booleanPairs(
  joined: readonly ProductionCalibrationJoinedDecision[],
  question: string,
  positiveClass: boolean
): BinaryPair[] {
  const pairs: BinaryPair[] = [];
  for (const { decision, outcomes } of joined) {
    const answer = decision.answers[question];
    if (!answer || answer.type !== "boolean") continue;
    const outcome = outcomes[question];
    const truth = outcome && typeof outcome.value === "boolean" ? outcome.value : null;
    pairs.push({
      // Flip both sides when the caller treats "false" as the event of interest.
      p: positiveClass ? answer.probability : 1 - answer.probability,
      y: truth === null ? null : truth === positiveClass,
      model: productionCalibrationModelIdentity(decision),
      digest: decision.questionSet.digest,
      at: decision.at
    });
  }
  return pairs;
}

function modelGroups(pairs: readonly BinaryPair[]): Array<{ model: ProductionCalibrationModelIdentity; pairs: BinaryPair[] }> {
  return [...groupBy(pairs, (pair) => modelIdentityKey(pair.model)).values()]
    .flatMap((group) => {
      const first = group[0];
      return first ? [{ model: first.model, pairs: group }] : [];
    })
    .sort((left, right) => compareModelIdentity(left.model, right.model));
}

function assertBins(bins: number): void {
  if (!Number.isInteger(bins) || bins < 1 || bins > PRODUCTION_CALIBRATION_MAX_BINS) {
    throw new RangeError(`bins must be an integer between 1 and ${PRODUCTION_CALIBRATION_MAX_BINS}`);
  }
}

// ---------------------------------------------------------------------------
// Boolean calibration
// ---------------------------------------------------------------------------

export interface ProductionBooleanCalibrationOptions {
  threshold?: number;
  bins?: number;
  positiveClass?: boolean;
}

export function productionBooleanCalibration(
  joined: readonly ProductionCalibrationJoinedDecision[],
  question: string,
  options: ProductionBooleanCalibrationOptions = {}
): ProductionCalibrationBoolean {
  const bins = options.bins ?? PRODUCTION_CALIBRATION_DEFAULT_BINS;
  assertBins(bins);
  const positiveClass = options.positiveClass ?? true;
  const threshold = ProductionCalibrationProbabilitySchema.parse(options.threshold ?? PRODUCTION_CALIBRATION_DEFAULT_THRESHOLD);
  const pairs = booleanPairs(joined, question, positiveClass);
  const stats = binaryStats(pairs, bins);
  const confusion = confusionAt(pairs, threshold);
  const positive = String(positiveClass);
  const negative = String(!positiveClass);
  return {
    question,
    positiveClass,
    bins,
    n: stats.n,
    nWithOutcome: stats.nWithOutcome,
    brier: stats.brier,
    ece: stats.ece,
    reliability: stats.reliability,
    confusion,
    errorDirections: {
      falsePositive: {
        definition: `predicted ${positive} at p >= ${threshold} when the outcome was ${negative}`,
        count: confusion.falsePositive
      },
      falseNegative: {
        definition: `predicted ${negative} at p < ${threshold} when the outcome was ${positive}`,
        count: confusion.falseNegative
      }
    },
    byModel: modelGroups(pairs).map(({ model, pairs: group }) => {
      const groupStats = binaryStats(group, bins);
      return { model, n: groupStats.n, nWithOutcome: groupStats.nWithOutcome, brier: groupStats.brier, ece: groupStats.ece };
    }),
    byDigest: [...groupBy(pairs, (pair) => pair.digest)]
      .sort(([left], [right]) => compareText(left, right))
      .map(([questionSetDigest, group]) => {
        const groupStats = binaryStats(group, bins);
        return {
          questionSetDigest,
          n: groupStats.n,
          nWithOutcome: groupStats.nWithOutcome,
          brier: groupStats.brier,
          ece: groupStats.ece
        };
      })
  };
}

// ---------------------------------------------------------------------------
// Choice calibration
// ---------------------------------------------------------------------------

export interface ProductionChoiceCalibrationOptions {
  bins?: number;
}

export function productionChoiceCalibration(
  joined: readonly ProductionCalibrationJoinedDecision[],
  question: string,
  options: ProductionChoiceCalibrationOptions = {}
): ProductionCalibrationChoice {
  const bins = options.bins ?? PRODUCTION_CALIBRATION_DEFAULT_BINS;
  assertBins(bins);
  const pairs: BinaryPair[] = [];
  const cells = new Map<string, ProductionCalibrationChoiceConfusionCell>();
  for (const { decision, outcomes } of joined) {
    const answer = decision.answers[question];
    if (!answer || answer.type !== "choice") continue;
    const outcome = outcomes[question];
    const truth = outcome && typeof outcome.value === "string" ? outcome.value : null;
    pairs.push({
      p: answer.confidence,
      y: truth === null ? null : truth === answer.choice,
      model: productionCalibrationModelIdentity(decision),
      digest: decision.questionSet.digest,
      at: decision.at
    });
    if (truth !== null) {
      const key = `${truth}\u0000${answer.choice}`;
      const cell = cells.get(key) ?? { truth, chosen: answer.choice, count: 0 };
      cell.count += 1;
      cells.set(key, cell);
    }
  }
  const stats = binaryStats(pairs, bins);
  const correct = pairs.filter((pair) => pair.y === true).length;
  return {
    question,
    bins,
    n: stats.n,
    nWithOutcome: stats.nWithOutcome,
    accuracy: productionCalibrationRate(correct, stats.nWithOutcome),
    reliability: stats.reliability,
    ece: stats.ece,
    brier: stats.brier,
    confusion: [...cells.values()]
      .sort((left, right) => compareText(left.truth, right.truth) || compareText(left.chosen, right.chosen)),
    byModel: modelGroups(pairs).map(({ model, pairs: group }) => {
      const groupStats = binaryStats(group, bins);
      return {
        model,
        n: groupStats.n,
        nWithOutcome: groupStats.nWithOutcome,
        accuracy: productionCalibrationRate(group.filter((pair) => pair.y === true).length, groupStats.nWithOutcome),
        ece: groupStats.ece
      };
    })
  };
}

// ---------------------------------------------------------------------------
// Score (ordinal) calibration
// ---------------------------------------------------------------------------

// Float slack for a mean the provider computed from unrounded probabilities.
// A mean further above the top level does not describe the answer's scale.
const SCORE_MEAN_EPSILON = 1e-9;

/** One valid score answer, with its probabilities divided by their sum. */
interface ScorePrediction {
  levels: number;
  mean: number;
  /** The most likely level; ties resolve to the lowest level. */
  predicted: number;
  /** The probability of the most likely level. */
  confidence: number;
  /** `atLeast[k - 1]` is P(level >= k) for k from 1 to levels - 1. */
  atLeast: number[];
  truth: number | null;
  model: ProductionCalibrationModelIdentity;
  digest: string;
  at: string;
}

/** The answer's normalized distribution, or null when it cannot describe an ordered rubric of 2 to 10 levels. */
function scoreDistribution(answer: ProductionDecisionScoreAnswer): number[] | null {
  const levels = answer.probabilities.length;
  if (levels < PRODUCTION_CALIBRATION_MIN_SCORE_LEVELS || levels > PRODUCTION_CALIBRATION_MAX_SCORE_LEVELS) return null;
  if (!answer.probabilities.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)) return null;
  const sum = answer.probabilities.reduce((total, p) => total + p, 0);
  if (!(Math.abs(sum - 1) <= PRODUCTION_CALIBRATION_SCORE_SUM_TOLERANCE)) return null;
  if (!Number.isFinite(answer.mean) || answer.mean < 0 || answer.mean > levels - 1 + SCORE_MEAN_EPSILON) return null;
  return answer.probabilities.map((p) => p / sum);
}

function scorePrediction(
  decision: ProductionDecisionRecord,
  answer: ProductionDecisionScoreAnswer,
  probabilities: readonly number[],
  truth: number | null
): ScorePrediction {
  let predicted = 0;
  for (let level = 1; level < probabilities.length; level += 1) {
    if (probabilities[level]! > probabilities[predicted]!) predicted = level;
  }
  const atLeast: number[] = [];
  let tail = 0;
  for (let level = probabilities.length - 1; level >= 1; level -= 1) {
    tail += probabilities[level]!;
    atLeast[level - 1] = Math.min(1, tail);
  }
  return {
    levels: probabilities.length,
    mean: answer.mean,
    predicted,
    confidence: probabilities[predicted]!,
    atLeast,
    truth,
    model: productionCalibrationModelIdentity(decision),
    digest: decision.questionSet.digest,
    at: decision.at
  };
}

interface ScoreSummary {
  nWithOutcome: number;
  exactAccuracy: ProductionCalibrationWilsonRate;
  withinOneAccuracy: ProductionCalibrationWilsonRate;
  meanAbsoluteError: number | null;
  meanSignedError: number | null;
  rankedProbabilityScore: number | null;
}

function scoreSummary(predictions: readonly ScorePrediction[]): ScoreSummary {
  let scored = 0;
  let exact = 0;
  let withinOne = 0;
  let absoluteError = 0;
  let signedError = 0;
  let rankedProbability = 0;
  for (const prediction of predictions) {
    const { truth } = prediction;
    if (truth === null) continue;
    scored += 1;
    if (prediction.predicted === truth) exact += 1;
    if (Math.abs(prediction.predicted - truth) <= 1) withinOne += 1;
    absoluteError += Math.abs(prediction.mean - truth);
    signedError += prediction.mean - truth;
    let squaredError = 0;
    prediction.atLeast.forEach((p, index) => {
      const y = truth >= index + 1 ? 1 : 0;
      squaredError += (p - y) * (p - y);
    });
    rankedProbability += squaredError / prediction.atLeast.length;
  }
  return {
    nWithOutcome: scored,
    exactAccuracy: productionCalibrationRate(exact, scored),
    withinOneAccuracy: productionCalibrationRate(withinOne, scored),
    meanAbsoluteError: scored > 0 ? absoluteError / scored : null,
    meanSignedError: scored > 0 ? signedError / scored : null,
    rankedProbabilityScore: scored > 0 ? rankedProbability / scored : null
  };
}

export interface ProductionScoreCalibrationOptions {
  bins?: number;
}

/**
 * Ordinal calibration for a score question. An answer is a distribution over
 * ordered levels and its outcome is the true level index. Answers that cannot
 * describe a 2-to-10-level rubric, and outcomes that are not a level of the
 * answer's own scale, are counted and left out rather than repaired.
 *
 * - Exact and within-one accuracy of the most likely level, as Wilson rates.
 * - Mean absolute and mean signed error of the stated `mean`, in levels.
 * - Confidence reliability: the most likely level's probability against exact
 *   correctness, the same pairing as choice questions.
 * - Cumulative reliability: for each k, P(level >= k) against whether the
 *   outcome reached level k. Each cut is a binary event, so it reuses the
 *   boolean machinery; the mean of the cut Brier scores is the ranked
 *   probability score.
 */
export function productionScoreCalibration(
  joined: readonly ProductionCalibrationJoinedDecision[],
  question: string,
  options: ProductionScoreCalibrationOptions = {}
): ProductionCalibrationScore {
  const bins = options.bins ?? PRODUCTION_CALIBRATION_DEFAULT_BINS;
  assertBins(bins);
  const predictions: ScorePrediction[] = [];
  let invalidAnswer = 0;
  let outcomeOutOfRange = 0;
  for (const { decision, outcomes } of joined) {
    const answer = decision.answers[question];
    if (!answer || answer.type !== "score") continue;
    const probabilities = scoreDistribution(answer);
    if (!probabilities) {
      invalidAnswer += 1;
      continue;
    }
    const outcome = outcomes[question];
    let truth: number | null = null;
    if (outcome && typeof outcome.value === "number") {
      if (Number.isInteger(outcome.value) && outcome.value >= 0 && outcome.value < probabilities.length) truth = outcome.value;
      else outcomeOutOfRange += 1;
    }
    predictions.push(scorePrediction(decision, answer, probabilities, truth));
  }

  const levelCounts = [...groupBy(predictions, (prediction) => String(prediction.levels))]
    .map(([levels, group]) => ({ levels: Number(levels), decisions: group.length }))
    .sort((left, right) => left.levels - right.levels);
  const summary = scoreSummary(predictions);
  const base = {
    question,
    n: predictions.length,
    nWithOutcome: summary.nWithOutcome,
    excluded: { invalidAnswer, outcomeOutOfRange },
    levelCounts
  };
  const levels = levelCounts[0]?.levels;
  if (levels === undefined) return { ...base, state: "undefined", undefinedReason: "no_valid_answers" };
  if (levelCounts.length > 1) return { ...base, state: "undefined", undefinedReason: "mixed_levels" };

  const toPair = (prediction: ScorePrediction, p: number, y: boolean | null): BinaryPair =>
    ({ p, y, model: prediction.model, digest: prediction.digest, at: prediction.at });
  const confidence = binaryStats(
    predictions.map((prediction) =>
      toPair(prediction, prediction.confidence, prediction.truth === null ? null : prediction.truth === prediction.predicted)),
    bins
  );
  const cumulative: ProductionCalibrationScoreCut[] = Array.from({ length: levels - 1 }, (_, index) => {
    const atLeast = index + 1;
    const pairs = predictions.map((prediction) =>
      toPair(prediction, prediction.atLeast[index]!, prediction.truth === null ? null : prediction.truth >= atLeast));
    const stats = binaryStats(pairs, bins);
    const scored = pairs.filter(isScored);
    return {
      atLeast,
      meanPredicted: scored.length > 0 ? scored.reduce((sum, pair) => sum + pair.p, 0) / scored.length : null,
      observedRate: productionCalibrationRate(scored.filter((pair) => pair.y).length, scored.length),
      brier: stats.brier,
      ece: stats.ece,
      reliability: stats.reliability
    };
  });

  const cells = new Map<string, ProductionCalibrationScoreConfusionCell>();
  for (const { truth, predicted } of predictions) {
    if (truth === null) continue;
    const key = `${truth}:${predicted}`;
    const cell = cells.get(key) ?? { truth, predicted, count: 0 };
    cell.count += 1;
    cells.set(key, cell);
  }
  const byModel: ProductionCalibrationScoreModelGroup[] = [...groupBy(predictions, (prediction) => modelIdentityKey(prediction.model)).values()]
    .flatMap((group) => {
      const first = group[0];
      if (!first) return [];
      const groupSummary = scoreSummary(group);
      return [{
        model: first.model,
        n: group.length,
        nWithOutcome: groupSummary.nWithOutcome,
        exactAccuracy: groupSummary.exactAccuracy,
        meanAbsoluteError: groupSummary.meanAbsoluteError,
        rankedProbabilityScore: groupSummary.rankedProbabilityScore
      }];
    })
    .sort((left, right) => compareModelIdentity(left.model, right.model));

  return {
    ...base,
    state: "defined",
    levels,
    bins,
    exactAccuracy: summary.exactAccuracy,
    withinOneAccuracy: summary.withinOneAccuracy,
    meanAbsoluteError: summary.meanAbsoluteError,
    meanSignedError: summary.meanSignedError,
    rankedProbabilityScore: summary.rankedProbabilityScore,
    reliability: confidence.reliability,
    ece: confidence.ece,
    brier: confidence.brier,
    cumulative,
    confusion: [...cells.values()].sort((left, right) => left.truth - right.truth || left.predicted - right.predicted),
    byModel
  };
}

// ---------------------------------------------------------------------------
// Threshold advisor
// ---------------------------------------------------------------------------

export interface ProductionThresholdCostsInput {
  /** Cost of acting on a positive that was not one. */
  falsePositive: number;
  /** Cost of missing a positive. */
  falseNegative: number;
  /** Cost of sending one decision to a person. Enables band mode. */
  humanReview?: number | null;
}

export interface ProductionThresholdAdviceOptions {
  positiveClass?: boolean;
}

function assertCost(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} cost must be a finite non-negative number`);
}

/**
 * Sweep thresholds over the decisions that have outcomes and pick the one
 * with the lowest expected cost per decision.
 *
 * Single mode: everything is auto-decided at `t`.
 *   cost(t) = (FP(t)·costFP + FN(t)·costFN) / n
 *
 * Band mode (when `humanReview` is given): p >= high is auto-yes, p <= low is
 * auto-no, and the middle goes to a person who is assumed to be right.
 *   cost(low, high) = (FP(high)·costFP + FN(low)·costFN + middle·costReview) / n
 * Pairs with low == high are included so "review nothing" can win when review
 * is expensive. Ties break toward higher automation.
 */
export function adviseProductionThreshold(
  joined: readonly ProductionCalibrationJoinedDecision[],
  question: string,
  costs: ProductionThresholdCostsInput,
  options: ProductionThresholdAdviceOptions = {}
): ProductionCalibrationThresholdAdvice {
  assertCost("falsePositive", costs.falsePositive);
  assertCost("falseNegative", costs.falseNegative);
  const review = costs.humanReview ?? null;
  if (review !== null) assertCost("humanReview", review);
  const positiveClass = options.positiveClass ?? true;
  const scored = booleanPairs(joined, question, positiveClass).filter(isScored);
  const n = scored.length;
  const caveat: ProductionCalibrationAdviceCaveat | null =
    n === 0 ? "no_outcomes" : n < PRODUCTION_CALIBRATION_MIN_ADVISABLE_OUTCOMES ? "fewer_than_30_outcomes" : null;
  const base = {
    question,
    positiveClass,
    n,
    costs: { falsePositive: costs.falsePositive, falseNegative: costs.falseNegative, humanReview: review },
    caveat
  };

  const fpAtOrAbove = (t: number): number => scored.filter(({ p, y }) => p >= t && !y).length;
  const fnBelow = (t: number): number => scored.filter(({ p, y }) => p < t && y).length;
  const fnAtOrBelow = (t: number): number => scored.filter(({ p, y }) => p <= t && y).length;

  if (review === null) {
    const sweep: ProductionCalibrationSingleSweepRow[] = PRODUCTION_CALIBRATION_THRESHOLD_GRID.map((threshold) => {
      const fp = fpAtOrAbove(threshold);
      const fn = fnBelow(threshold);
      return {
        threshold,
        automated: n,
        falsePositives: fp,
        falseNegatives: fn,
        errorRateAmongAutomated: productionCalibrationRate(fp + fn, n),
        expectedCostPerDecision: n === 0 ? 0 : (fp * costs.falsePositive + fn * costs.falseNegative) / n
      };
    });
    let best: ProductionCalibrationSingleSweepRow | null = null;
    for (const row of sweep) if (!best || row.expectedCostPerDecision < best.expectedCostPerDecision) best = row;
    return { ...base, mode: "single", recommendation: n === 0 ? null : best, sweep };
  }

  const sweep: ProductionCalibrationBandSweepRow[] = [];
  for (const low of PRODUCTION_CALIBRATION_THRESHOLD_GRID) {
    for (const high of PRODUCTION_CALIBRATION_THRESHOLD_GRID) {
      if (high < low) continue;
      const fp = fpAtOrAbove(high);
      const fn = low === high ? fnBelow(high) : fnAtOrBelow(low);
      const humans = low === high ? 0 : scored.filter(({ p }) => p > low && p < high).length;
      const automated = n - humans;
      sweep.push({
        low,
        high,
        automated,
        humanReviews: humans,
        automationRate: n === 0 ? 1 : automated / n,
        falsePositives: fp,
        falseNegatives: fn,
        errorRateAmongAutomated: productionCalibrationRate(fp + fn, automated),
        expectedCostPerDecision: n === 0
          ? 0
          : (fp * costs.falsePositive + fn * costs.falseNegative + humans * review) / n
      });
    }
  }
  let best: ProductionCalibrationBandSweepRow | null = null;
  for (const row of sweep) {
    if (
      !best ||
      row.expectedCostPerDecision < best.expectedCostPerDecision ||
      (row.expectedCostPerDecision === best.expectedCostPerDecision && row.automationRate > best.automationRate)
    ) best = row;
  }
  return { ...base, mode: "band", recommendation: n === 0 ? null : best, sweep };
}

// ---------------------------------------------------------------------------
// Drift by time window
// ---------------------------------------------------------------------------

export interface ProductionDriftOptions {
  windowDays?: number;
  positiveClass?: boolean;
  minOutcomesToFlag?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function productionDriftByWindow(
  joined: readonly ProductionCalibrationJoinedDecision[],
  question: string,
  options: ProductionDriftOptions = {}
): ProductionCalibrationDrift {
  const windowDays = options.windowDays ?? PRODUCTION_CALIBRATION_DEFAULT_WINDOW_DAYS;
  const positiveClass = options.positiveClass ?? true;
  const minOutcomesToFlag = options.minOutcomesToFlag ?? PRODUCTION_CALIBRATION_DEFAULT_MIN_OUTCOMES_TO_FLAG;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
    throw new RangeError("windowDays must be an integer between 1 and 366");
  }
  if (!Number.isInteger(minOutcomesToFlag) || minOutcomesToFlag < 1) {
    throw new RangeError("minOutcomesToFlag must be a positive integer");
  }
  const pairs = booleanPairs(joined, question, positiveClass);
  const report: ProductionCalibrationDrift = { question, positiveClass, windowDays, minOutcomesToFlag, windows: [] };
  if (pairs.length === 0) return report;

  // Windows are anchored at the UTC midnight before the earliest decision.
  const first = pairs.reduce((earliest, pair) => Math.min(earliest, Date.parse(pair.at)), Infinity);
  const origin = Math.floor(first / DAY_MS) * DAY_MS;
  const span = windowDays * DAY_MS;
  const buckets = groupBy(pairs, (pair) => String(Math.floor((Date.parse(pair.at) - origin) / span)));
  const indices = [...buckets.keys()].map(Number).sort((left, right) => left - right);

  let previousModels: Set<string> | null = null;
  for (const index of indices) {
    const group = buckets.get(String(index)) ?? [];
    const stats = binaryStats(group, 1);
    const scored = group.filter(isScored);
    const meanPredicted = scored.length > 0 ? scored.reduce((sum, pair) => sum + pair.p, 0) / scored.length : null;
    const observedRate = productionCalibrationRate(scored.filter((pair) => pair.y).length, scored.length);
    const models = modelGroups(group).map((entry) => entry.model);
    const keys = new Set(models.map(modelIdentityKey));
    const modelChanged = previousModels !== null && [...keys].some((key) => !previousModels?.has(key));
    const driftFlag =
      scored.length >= minOutcomesToFlag &&
      meanPredicted !== null &&
      observedRate.state === "defined" &&
      (meanPredicted < observedRate.interval.lower || meanPredicted > observedRate.interval.upper);
    report.windows.push({
      index,
      start: new Date(origin + index * span).toISOString(),
      end: new Date(origin + (index + 1) * span).toISOString(),
      n: group.length,
      nWithOutcome: scored.length,
      meanPredicted,
      observedRate,
      brier: stats.brier,
      models,
      modelChanged,
      driftFlag
    });
    previousModels = keys;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export interface ProductionCalibrationQuestionOptions {
  threshold?: number;
  positiveClass?: boolean;
  /** Null removes a global cost setting for this question. */
  costs?: ProductionThresholdCostsInput | null;
}

export interface ProductionCalibrationWindowOptions {
  /** Inclusive lower bound on a decision's `at`; null or omitted means unbounded. */
  from?: Date | null;
  /** Exclusive upper bound on a decision's `at`; null or omitted means unbounded. */
  to?: Date | null;
}

export interface ProductionCalibrationBuildOptions {
  /** The report's generation time; the builder never reads the clock. */
  now: Date;
  /** The decisions the report covers; omitted means every decision supplied. */
  window?: ProductionCalibrationWindowOptions;
  bins?: number;
  threshold?: number;
  positiveClass?: boolean;
  windowDays?: number;
  minOutcomesToFlag?: number;
  /** Costs applied to every boolean question unless overridden per question. */
  costs?: ProductionThresholdCostsInput | null;
  questions?: Readonly<Record<string, ProductionCalibrationQuestionOptions>>;
}

function questionSetKey(ref: ProductionDecisionQuestionSetRef): string {
  return JSON.stringify([ref.name, ref.version, ref.digest]);
}

function compareQuestionSetRef(left: ProductionDecisionQuestionSetRef, right: ProductionDecisionQuestionSetRef): number {
  return compareText(left.name, right.name) ||
    compareText(String(left.version), String(right.version)) ||
    compareText(left.digest, right.digest);
}

function reportWindow(options: ProductionCalibrationWindowOptions | undefined): {
  window: ProductionCalibrationWindow;
  contains: (at: string) => boolean;
} {
  const from = options?.from ?? null;
  const to = options?.to ?? null;
  if (from !== null && Number.isNaN(from.getTime())) throw new RangeError("window.from must be a valid date");
  if (to !== null && Number.isNaN(to.getTime())) throw new RangeError("window.to must be a valid date");
  if (from !== null && to !== null && from.getTime() >= to.getTime()) {
    throw new RangeError("window.from must be earlier than window.to");
  }
  return {
    window: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    contains: (at) => {
      const time = Date.parse(at);
      return (from === null || time >= from.getTime()) && (to === null || time < to.getTime());
    }
  };
}

/** Build the production calibration artifact from an array of ledger records. Pure: no I/O and no clock. */
export function buildProductionCalibrationArtifact(
  records: readonly ProductionDecisionLedgerRecord[],
  options: ProductionCalibrationBuildOptions
): ProductionCalibrationArtifact {
  const generatedAt = options.now.toISOString();
  const parameters = ProductionCalibrationParametersSchema.parse({
    bins: options.bins ?? PRODUCTION_CALIBRATION_DEFAULT_BINS,
    threshold: options.threshold ?? PRODUCTION_CALIBRATION_DEFAULT_THRESHOLD,
    positiveClass: options.positiveClass ?? true,
    windowDays: options.windowDays ?? PRODUCTION_CALIBRATION_DEFAULT_WINDOW_DAYS,
    minOutcomesToFlag: options.minOutcomesToFlag ?? PRODUCTION_CALIBRATION_DEFAULT_MIN_OUTCOMES_TO_FLAG
  });
  const { window, contains } = reportWindow(options.window);
  // Conflicts are checked across every record supplied, so a window can never
  // hide a decision ID whose content was replaced.
  const supplied = joinProductionDecisionRecords(records);
  const joined = supplied.filter((entry) => contains(entry.decision.at));
  const suppliedIds = new Set(supplied.map((entry) => entry.decision.id));
  const coveredIds = new Set(joined.map((entry) => entry.decision.id));

  const outcomeSources = { human: 0, automatic: 0, delayed: 0 };
  let actionTotal = 0;
  let orphanActions = 0;
  let actionsOutsideWindow = 0;
  let outcomeTotal = 0;
  let orphanOutcomes = 0;
  let outcomesOutsideWindow = 0;
  for (const record of records) {
    if (record.kind === "action") {
      actionTotal += 1;
      if (!suppliedIds.has(record.decisionId)) orphanActions += 1;
      else if (!coveredIds.has(record.decisionId)) actionsOutsideWindow += 1;
    } else if (record.kind === "outcome") {
      outcomeTotal += 1;
      if (suppliedIds.has(record.decisionId) && !coveredIds.has(record.decisionId)) {
        outcomesOutsideWindow += 1;
        continue;
      }
      outcomeSources[record.source] += 1;
      if (!suppliedIds.has(record.decisionId)) orphanOutcomes += 1;
    }
  }
  let superseded = 0;
  let conflicting = 0;
  let synthetic = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const questionSets = new Map<string, { ref: ProductionDecisionQuestionSetRef; decisions: number }>();
  const models = new Map<string, { model: ProductionCalibrationModelIdentity; decisions: number }>();
  const questionTypes = new Map<string, Set<ProductionDecisionAnswerType>>();
  for (const { decision, outcomes, outcomeCount, conflictingOutcomes } of joined) {
    superseded += outcomeCount - Object.keys(outcomes).length;
    conflicting += conflictingOutcomes;
    if (decision.tags?.["synthetic"] === "true") synthetic += 1;
    const at = Date.parse(decision.at);
    if (firstAt === null || at < Date.parse(firstAt)) firstAt = decision.at;
    if (lastAt === null || at > Date.parse(lastAt)) lastAt = decision.at;
    const setKey = questionSetKey(decision.questionSet);
    const set = questionSets.get(setKey) ?? { ref: decision.questionSet, decisions: 0 };
    set.decisions += 1;
    questionSets.set(setKey, set);
    const identity = productionCalibrationModelIdentity(decision);
    const modelKey = modelIdentityKey(identity);
    const model = models.get(modelKey) ?? { model: identity, decisions: 0 };
    model.decisions += 1;
    models.set(modelKey, model);
    for (const [question, answer] of Object.entries(decision.answers)) {
      const types = questionTypes.get(question) ?? new Set<ProductionDecisionAnswerType>();
      types.add(answer.type);
      questionTypes.set(question, types);
    }
  }

  const questions: ProductionCalibrationQuestion[] = [];
  const typeOrder: readonly ProductionDecisionAnswerType[] = ["boolean", "choice", "score"];
  for (const question of [...questionTypes.keys()].sort(compareText)) {
    const perQuestion = options.questions?.[question] ?? {};
    const threshold = perQuestion.threshold ?? parameters.threshold;
    const positiveClass = perQuestion.positiveClass ?? parameters.positiveClass;
    const costs = perQuestion.costs === undefined ? options.costs ?? null : perQuestion.costs;
    for (const answerType of typeOrder) {
      if (!questionTypes.get(question)?.has(answerType)) continue;
      if (answerType === "boolean") {
        questions.push({
          question,
          answerType,
          calibration: productionBooleanCalibration(joined, question, { threshold, bins: parameters.bins, positiveClass }),
          thresholdAdvice: costs === null ? null : adviseProductionThreshold(joined, question, costs, { positiveClass }),
          drift: productionDriftByWindow(joined, question, {
            windowDays: parameters.windowDays,
            positiveClass,
            minOutcomesToFlag: parameters.minOutcomesToFlag
          })
        });
      } else if (answerType === "choice") {
        questions.push({ question, answerType, calibration: productionChoiceCalibration(joined, question, { bins: parameters.bins }) });
      } else {
        questions.push({ question, answerType, calibration: productionScoreCalibration(joined, question, { bins: parameters.bins }) });
      }
    }
  }

  return {
    contract: PRODUCTION_CALIBRATION_CONTRACT,
    schemaVersion: 2,
    metricDefinitionVersion: PRODUCTION_CALIBRATION_METRIC_DEFINITION_VERSION,
    intervalDefinitionVersion: PRODUCTION_CALIBRATION_INTERVAL_DEFINITION_VERSION,
    generatedAt,
    window,
    evidence: {
      kind: "production_outcomes",
      sealed: false,
      independentHumanValidation: false,
      outcomeSources
    },
    records: {
      contract: PRODUCTION_DECISION_RECORD_CONTRACT,
      decisions: { total: supplied.length, outsideWindow: supplied.length - joined.length, synthetic, firstAt, lastAt },
      actions: { total: actionTotal, orphan: orphanActions, outsideWindow: actionsOutsideWindow },
      outcomes: { total: outcomeTotal, orphan: orphanOutcomes, outsideWindow: outcomesOutsideWindow, superseded, conflicting },
      questionSets: [...questionSets.values()]
        .sort((left, right) => compareQuestionSetRef(left.ref, right.ref))
        .map(({ ref, decisions }) => ({ name: ref.name, version: ref.version, digest: ref.digest, decisions })),
      models: [...models.values()].sort((left, right) => compareModelIdentity(left.model, right.model))
    },
    parameters,
    questions
  };
}
