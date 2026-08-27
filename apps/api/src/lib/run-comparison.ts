import type {
  EvalRun,
  EvalRunItem,
  RunComparisonAgreement,
  RunComparisonBucket,
  RunComparisonBucketCounts,
  RunComparisonCase
} from "@coeval/shared";

// Incident-bisect diff: join two eval runs' items on caseId and bucket every
// case explicitly. Pure — the route loads both run details and delegates
// here, so the bucketing rules are unit-testable with crafted items.
//
// Bucketing rules (in precedence order per case):
// - pending: either run's item is still pending (a run mid-flight must never
//   report a flip that could reverse on the next poll).
// - missing: the case has no judgment in at least one run — absent from that
//   run's snapshot, or terminally failed/skipped there. Named, never blended
//   into the flip counts (an infrastructure failure is not a verdict).
// - flips/sames compare the PASS PROJECTION of the two labels: "pass" vs
//   anything else. An ambiguous verdict is a non-pass for bisect purposes, so
//   fail↔ambiguous is same-fail, not a flip — the incident question is
//   "where did passes stop passing".

export interface RunComparisonDiff {
  buckets: RunComparisonBucketCounts;
  cases: RunComparisonCase[];
}

const BUCKET_ORDER: RunComparisonBucket[] = [
  "flipped-now-failing",
  "flipped-now-passing",
  "same-fail",
  "same-pass",
  "pending",
  "missing"
];

function bucketFor(a: EvalRunItem | undefined, b: EvalRunItem | undefined): RunComparisonBucket {
  if (a?.status === "pending" || b?.status === "pending") return "pending";
  const labelA = a?.status === "completed" ? a.resultLabel : null;
  const labelB = b?.status === "completed" ? b.resultLabel : null;
  if (labelA === null || labelB === null) return "missing";
  const passA = labelA === "pass";
  const passB = labelB === "pass";
  if (passA === passB) return passA ? "same-pass" : "same-fail";
  return passB ? "flipped-now-passing" : "flipped-now-failing";
}

export function computeRunComparisonDiff(
  itemsA: EvalRunItem[],
  itemsB: EvalRunItem[]
): RunComparisonDiff {
  const byCaseA = new Map(itemsA.map((item) => [item.caseId, item]));
  const byCaseB = new Map(itemsB.map((item) => [item.caseId, item]));
  // Union of case ids, run A's snapshot order first so rows stay stable
  // across polls; B-only cases follow in B's order.
  const caseIds = [
    ...itemsA.map((item) => item.caseId),
    ...itemsB.filter((item) => !byCaseA.has(item.caseId)).map((item) => item.caseId)
  ];

  const cases: RunComparisonCase[] = caseIds.map((caseId) => {
    const a = byCaseA.get(caseId);
    const b = byCaseB.get(caseId);
    return {
      caseId,
      expectedLabel: a?.expectedLabel ?? b?.expectedLabel ?? null,
      labelA: a?.status === "completed" ? a.resultLabel : null,
      labelB: b?.status === "completed" ? b.resultLabel : null,
      statusA: a?.status ?? null,
      statusB: b?.status ?? null,
      bucket: bucketFor(a, b)
    };
  });

  const buckets: RunComparisonBucketCounts = {
    "same-pass": 0,
    "same-fail": 0,
    "flipped-now-failing": 0,
    "flipped-now-passing": 0,
    pending: 0,
    missing: 0
  };
  for (const row of cases) buckets[row.bucket] += 1;

  // Flips first — the incident reader wants "what changed" before "what
  // didn't"; ties keep snapshot order.
  const rank = new Map(BUCKET_ORDER.map((bucket, index) => [bucket, index]));
  const sorted = cases
    .map((row, index) => ({ row, index }))
    .sort((left, right) =>
      (rank.get(left.row.bucket)! - rank.get(right.row.bucket)!) || (left.index - right.index)
    )
    .map(({ row }) => row);

  return { buckets, cases: sorted };
}

// Mirrors detailAgreement on the datasets screen: agreed of items that
// carried an expectedLabel AND completed.
export function runComparisonAgreement(run: EvalRun, items: EvalRunItem[]): RunComparisonAgreement {
  return {
    agreed: run.agreedItems,
    labeled: items.filter((item) => item.expectedLabel !== null && item.status === "completed").length
  };
}

// A comparison is done polling when both runs are terminal.
export function runComparisonStatus(runA: EvalRun, runB: EvalRun): "pending" | "completed" {
  const terminal = (status: EvalRun["status"]) =>
    status === "completed" || status === "failed" || status === "canceled";
  return terminal(runA.status) && terminal(runB.status) ? "completed" : "pending";
}
