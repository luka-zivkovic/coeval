import assert from "node:assert/strict";
import { test } from "node:test";
import { chaosMnliCounts } from "./fixtures/build/common.mjs";
import { mcnemarExact, orderConsistency, pairedBootstrap, quantile, spearman, wilson } from "./compare-stats.mjs";

test("wilson matches the textbook interval", () => {
  assert.deepEqual(wilson(8, 10), [0.49, 0.943]);
  assert.equal(wilson(0, 0), null);
});

test("quantile is nearest-rank", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.95), 4);
  assert.equal(quantile([], 0.5), null);
});

test("spearman averages tied ranks", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 2, 3], [1, 2, 3, 4]), 0.949);
});

test("mcnemarExact is the two-sided binomial tail", () => {
  assert.deepEqual(mcnemarExact(0, 0), { b: 0, c: 0, p: 1 });
  // 23 against 10: two-sided exact p = 0.0351.
  assert.equal(mcnemarExact(23, 10).p, 0.0351);
  assert.equal(mcnemarExact(5, 5).p, 1);
});

test("pairedBootstrap separates a judge that is always right from one that is always wrong", () => {
  const items = Array.from({ length: 40 }, (_, i) => {
    const truth = i % 2;
    return {
      truth,
      a: { label: truth ? "pass" : "fail", p: truth ? 0.9 : 0.1 },
      b: { label: truth ? "fail" : "pass", p: truth ? 0.1 : 0.9 }
    };
  });
  const result = pairedBootstrap(items, { resamples: 200 });
  assert.deepEqual(result.accuracyDiff, { estimate: 1, ci95: [1, 1] });
  assert.deepEqual(result.aucDiff, { estimate: 1, ci95: [1, 1] });
});

test("orderConsistency counts label flips across swapped pairs", () => {
  const original = [{ id: "m1", label: "pass" }, { id: "m2", label: "pass" }, { id: "m3", label: "abstain" }];
  const swapped = [{ id: "m1s", label: "fail" }, { id: "m2s", label: "pass" }, { id: "m3s", label: "fail" }];
  assert.deepEqual(orderConsistency(original, swapped), { k: 1, n: 2, rate: 0.5, wilson95: [0.095, 0.905] });
});

test("chaosMnliCounts reads every served shape in e, n, c order", () => {
  assert.deepEqual(chaosMnliCounts({ label_counter: { e: 1, n: 2, c: 97 } }), { e: 1, n: 2, c: 97 });
  assert.deepEqual(chaosMnliCounts({ label_count: [12, 68, 20] }), { e: 12, n: 68, c: 20 });
  assert.deepEqual(chaosMnliCounts({ label_count: "[25, 39, 36]" }), { e: 25, n: 39, c: 36 });
  assert.deepEqual(chaosMnliCounts({ label_count: "25,39,36" }), { e: 25, n: 39, c: 36 });
  assert.throws(() => chaosMnliCounts({ uid: "x", label_count: "[1, 2]" }), /unreadable/);
});
