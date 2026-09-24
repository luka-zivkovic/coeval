// Statistics for compare.mjs. Judges answer the same cases, so comparisons
// between them are paired: McNemar on correctness, and a paired bootstrap for
// differences in accuracy and AUC. Unpaired interval overlap would understate
// real differences.
import { rocAuc, round, seededRandom } from "./metrics.mjs";

/** Wilson 95% interval for k of n. */
export function wilson(k, n) {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

export function rate(k, n) {
  return { k, n, rate: n ? round(k / n) : null, wilson95: wilson(k, n) };
}

/** Nearest-rank quantile of an ascending array. */
export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Spearman rank correlation, ties given their average rank. */
export function spearman(xs, ys) {
  const ranks = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(values.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      for (let k = i; k <= j; k += 1) r[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? round(num / Math.sqrt(dx * dy)) : null;
}

/**
 * Exact two-sided McNemar test on paired correctness. `b` counts cases only
 * the first judge got right, `c` cases only the second got right.
 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  let logChoose = 0;
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i += 1) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logChoose - n * Math.LN2);
  }
  return { b, c, p: round(Math.min(1, 2 * tail), 4) };
}

/**
 * Paired bootstrap 95% intervals for the difference (first minus second) in
 * accuracy and AUC. Each item is { truth: 0|1, a: {label, p}, b: {label, p} }.
 * Accuracy uses items both judges decided; AUC uses items both answered.
 */
export function pairedBootstrap(items, { resamples = 2000, seed = 17 } = {}) {
  const random = seededRandom(seed);
  const correct = (side, item) => (item[side].label === "pass" ? 1 : 0) === item.truth;
  const decided = items.filter((i) => i.a.label !== "abstain" && i.b.label !== "abstain");
  const accuracyDiff = (sample) => sample.reduce((s, i) => s + (correct("a", i) ? 1 : 0) - (correct("b", i) ? 1 : 0), 0) / sample.length;
  const aucDiff = (sample) => {
    const a = rocAuc(sample.map((i) => ({ p: i.a.p, label: i.truth })));
    const b = rocAuc(sample.map((i) => ({ p: i.b.p, label: i.truth })));
    return a === null || b === null ? null : a - b;
  };
  const draw = (pool) => Array.from({ length: pool.length }, () => pool[Math.floor(random() * pool.length)]);
  const interval = (pool, statistic) => {
    if (pool.length === 0) return null;
    const values = [];
    for (let r = 0; r < resamples; r += 1) {
      const value = statistic(draw(pool));
      if (value !== null) values.push(value);
    }
    values.sort((x, y) => x - y);
    return { estimate: round(statistic(pool)), ci95: [round(quantile(values, 0.025)), round(quantile(values, 0.975))] };
  };
  return { accuracyDiff: interval(decided, accuracyDiff), aucDiff: interval(items, aucDiff) };
}

/**
 * Position consistency across the original and swapped orders of the same
 * pairwise cases: a consistent judge picks the same underlying response, so
 * its label flips when the responses are swapped.
 */
export function orderConsistency(original, swapped) {
  const bySwappedId = new Map(swapped.map((item) => [item.id, item]));
  const pairs = original
    .map((item) => [item, bySwappedId.get(`${item.id}s`)])
    .filter(([a, b]) => b && ["pass", "fail"].includes(a.label) && ["pass", "fail"].includes(b.label));
  return rate(pairs.filter(([a, b]) => a.label !== b.label).length, pairs.length);
}
