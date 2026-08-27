import type { EvalRunDetail } from "@coeval/shared";

// dataset cross-version delta, computed CLIENT-SIDE from two run
// details the API already serves — no delta endpoint, no synthetic numbers.
// A is always the older run, B the newer. Every case is accounted for
// explicitly: shared rows (flips first), only-in-one counts, failed counts —
// nothing is silently dropped from a denominator.

export interface RunDeltaRow {
  caseId: string;
  expected: "pass" | "fail" | null;
  // The judge's recorded label, or null when the item never completed
  // (status is shown instead — a failed item is an infrastructure outcome,
  // not a judgment).
  aSaid: string | null;
  bSaid: string | null;
  aStatus: string;
  bStatus: string;
  // True only when BOTH items completed and the labels differ. A failure in
  // either run can never be claimed as a flip.
  flipped: boolean;
}

export interface RunAgreement {
  agreed: number;
  // Items that carried an expectedLabel AND completed — the only honest
  // agreement denominator (mirrors detailAgreement on the datasets screen).
  labeled: number;
}

export interface RunDelta {
  rows: RunDeltaRow[];
  flipped: number;
  shared: number;
  aOnly: number;
  bOnly: number;
  aFailed: number;
  bFailed: number;
  aAgreement: RunAgreement;
  bAgreement: RunAgreement;
}

function agreementOf(detail: EvalRunDetail): RunAgreement {
  const labeled = detail.items.filter(
    (item) => item.expectedLabel !== null && item.status === "completed"
  ).length;
  return { agreed: detail.agreedItems, labeled };
}

// Callers pass runs in any order; the older run (createdAt) becomes A.
export function orderRuns(x: EvalRunDetail, y: EvalRunDetail): [EvalRunDetail, EvalRunDetail] {
  return x.createdAt <= y.createdAt ? [x, y] : [y, x];
}

export function computeRunDelta(a: EvalRunDetail, b: EvalRunDetail): RunDelta {
  const bByCase = new Map(b.items.map((item) => [item.caseId, item]));
  const aCaseIds = new Set(a.items.map((item) => item.caseId));

  const rows: RunDeltaRow[] = [];
  for (const aItem of a.items) {
    const bItem = bByCase.get(aItem.caseId);
    if (!bItem) continue;
    const aCompleted = aItem.status === "completed";
    const bCompleted = bItem.status === "completed";
    rows.push({
      caseId: aItem.caseId,
      expected: aItem.expectedLabel,
      aSaid: aCompleted ? aItem.resultLabel : null,
      bSaid: bCompleted ? bItem.resultLabel : null,
      aStatus: aItem.status,
      bStatus: bItem.status,
      flipped: aCompleted && bCompleted && aItem.resultLabel !== bItem.resultLabel
    });
  }
  // Flips first so what changed is read before what didn't; ties keep the
  // run's own case order.
  const flippedRows = rows.filter((row) => row.flipped);
  const stableRows = rows.filter((row) => !row.flipped);

  return {
    rows: [...flippedRows, ...stableRows],
    flipped: flippedRows.length,
    shared: rows.length,
    aOnly: a.items.filter((item) => !bByCase.has(item.caseId)).length,
    bOnly: b.items.filter((item) => !aCaseIds.has(item.caseId)).length,
    aFailed: a.items.filter((item) => item.status === "failed").length,
    bFailed: b.items.filter((item) => item.status === "failed").length,
    aAgreement: agreementOf(a),
    bAgreement: agreementOf(b)
  };
}
