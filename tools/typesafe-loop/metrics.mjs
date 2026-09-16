// Probability-aware calibration metrics. These are the numbers the current
// coeval/binary-calibration/v1 artifact cannot carry (it keeps labels only),
// and the numbers a Jev-style provider makes measurable.

/** Mean squared error between probability and 0/1 label. Lower is better. */
export function brierScore(items) {
  if (items.length === 0) return null;
  let total = 0;
  for (const { p, label } of items) total += (p - label) ** 2;
  return total / items.length;
}

/**
 * Expected calibration error over equal-width bins. Returns the error and the
 * reliability table so a report can show where confidence is unearned.
 */
export function expectedCalibrationError(items, bins = 10) {
  if (items.length === 0) return { ece: null, bins: [] };
  const table = Array.from({ length: bins }, (_, i) => ({
    lower: i / bins,
    upper: (i + 1) / bins,
    count: 0,
    meanConfidence: 0,
    observedRate: 0
  }));
  for (const { p, label } of items) {
    const index = Math.min(bins - 1, Math.floor(p * bins));
    const bin = table[index];
    bin.count += 1;
    bin.meanConfidence += p;
    bin.observedRate += label;
  }
  let ece = 0;
  for (const bin of table) {
    if (bin.count === 0) continue;
    bin.meanConfidence /= bin.count;
    bin.observedRate /= bin.count;
    ece += (bin.count / items.length) * Math.abs(bin.meanConfidence - bin.observedRate);
  }
  return { ece, bins: table };
}

/** Area under the ROC curve via the rank statistic; ties count half. */
export function rocAuc(items) {
  const positives = items.filter((i) => i.label === 1).map((i) => i.p);
  const negatives = items.filter((i) => i.label === 0).map((i) => i.p);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const pos of positives) {
    for (const neg of negatives) {
      if (pos > neg) wins += 1;
      else if (pos === neg) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

/** Confusion counts at a threshold, with the ADR-0004 error directions. */
export function confusionAt(items, threshold = 0.5) {
  const counts = { truePass: 0, trueFail: 0, falsePass: 0, falseFail: 0 };
  for (const { p, label } of items) {
    const predictedPass = p >= threshold;
    if (predictedPass && label === 1) counts.truePass += 1;
    else if (!predictedPass && label === 0) counts.trueFail += 1;
    else if (predictedPass && label === 0) counts.falsePass += 1;
    else counts.falseFail += 1;
  }
  const passSupport = counts.truePass + counts.falseFail;
  const failSupport = counts.trueFail + counts.falsePass;
  return {
    ...counts,
    truthPassRecall: passSupport === 0 ? null : counts.truePass / passSupport,
    truthFailRecall: failSupport === 0 ? null : counts.trueFail / failSupport
  };
}

/** Small seeded PRNG (mulberry32) so permutation tests are reproducible. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Permutation test: is the overlap between two boolean vectors larger than
 * chance? Returns the observed overlap fraction among `selected`, the expected
 * fraction under shuffling, and a one-sided p-value.
 */
export function overlapPermutationTest(selected, reference, { permutations = 2000, seed = 7 } = {}) {
  if (selected.length !== reference.length) throw new Error("vectors must align");
  const selectedCount = selected.filter(Boolean).length;
  if (selectedCount === 0) {
    return { observed: null, expected: null, pValue: null, lift: null, selectedCount };
  }
  const overlap = (ref) => {
    let hits = 0;
    for (let i = 0; i < selected.length; i += 1) if (selected[i] && ref[i]) hits += 1;
    return hits / selectedCount;
  };
  const observed = overlap(reference);
  const random = seededRandom(seed);
  const shuffled = reference.slice();
  let atLeast = 0;
  let expectedTotal = 0;
  for (let n = 0; n < permutations; n += 1) {
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const value = overlap(shuffled);
    expectedTotal += value;
    if (value >= observed) atLeast += 1;
  }
  const expected = expectedTotal / permutations;
  return {
    observed,
    expected,
    pValue: (atLeast + 1) / (permutations + 1),
    lift: expected === 0 ? null : observed / expected,
    selectedCount
  };
}

/** Summary of how a probability vector moved between two runs on the same items. */
export function distributionShift(previous, current) {
  const byId = new Map(previous.map((item) => [item.caseId, item.p]));
  const deltas = [];
  let flips = 0;
  for (const item of current) {
    if (!byId.has(item.caseId)) continue;
    const before = byId.get(item.caseId);
    deltas.push(item.p - before);
    if (before >= 0.5 !== item.p >= 0.5) flips += 1;
  }
  if (deltas.length === 0) return { compared: 0, meanDelta: null, maxAbsDelta: null, flips: 0, flipRate: null };
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const maxAbsDelta = Math.max(...deltas.map(Math.abs));
  return { compared: deltas.length, meanDelta, maxAbsDelta, flips, flipRate: flips / deltas.length };
}

export function round(value, places = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
