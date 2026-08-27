import {
  verdictLabelFromPayload,
  type GoldenSetEntry,
  type VerdictRecord
} from "@coeval/shared";

// P0-3 — "reviewing resolves": a case leaves the exceptions queue the moment
// a human (or an adjudication, or a golden promotion) decides it. Resolved
// cases don't vanish — this module reconstructs the decision record from the
// append-only verdict log so the queue can keep them on the record.
export interface ResolvedDecision {
  caseId: string;
  at: string; // ISO timestamp of the decision
  kind: "accept" | "override" | "promote" | "adjudicated";
  note: string;
  actorUserId: string | null;
}

export function resolvedDecisions(
  verdicts: VerdictRecord[],
  golden: GoldenSetEntry[],
  sinceMs: number
): ResolvedDecision[] {
  const byCase = new Map<string, VerdictRecord[]>();
  for (const v of verdicts) {
    const rows = byCase.get(v.caseId);
    if (rows) rows.push(v);
    else byCase.set(v.caseId, [v]);
  }

  const out = new Map<string, ResolvedDecision>();

  for (const [caseId, rows] of byCase) {
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const decision = [...rows]
      .reverse()
      .find((r) => r.source === "human" || r.source === "adjudicated");
    if (!decision) continue;
    if (Date.parse(decision.createdAt) < sinceMs) continue;

    // Classify against the judge's latest verdict at decision time: same
    // label = the reviewer confirmed the skill; different = an override.
    const judgeBefore = [...rows]
      .reverse()
      .find((r) => r.source === "llm_judge" && r.createdAt <= decision.createdAt);
    const humanLabel = verdictLabelFromPayload(decision.payload);
    const judgeLabel = judgeBefore ? verdictLabelFromPayload(judgeBefore.payload) : null;

    const rationale =
      "rationale" in decision.payload && typeof decision.payload.rationale === "string"
        ? decision.payload.rationale
        : "";

    const kind =
      decision.source === "adjudicated"
        ? "adjudicated"
        : judgeLabel !== null && judgeLabel !== humanLabel
          ? "override"
          : "accept";

    out.set(caseId, {
      caseId,
      at: decision.createdAt,
      kind,
      note:
        kind === "adjudicated"
          ? rationale
            ? `ungoverned ruling recorded · “${rationale}”`
            : "ungoverned ruling recorded by adjudication"
          : kind === "override"
            ? rationale
              ? `“${rationale}”`
              : "reviewer disagrees · reason on file"
            : "skill verdict confirmed",
      actorUserId: decision.actorUserId
    });
  }

  // Golden promotions outrank a plain accept/override record on the same case.
  for (const entry of golden) {
    if (Date.parse(entry.promotedAt) < sinceMs) continue;
    out.set(entry.caseId, {
      caseId: entry.caseId,
      at: entry.promotedAt,
      kind: "promote",
      note: `golden set · ${entry.id}`,
      actorUserId: entry.promotedBy
    });
  }

  return [...out.values()].sort((a, b) => b.at.localeCompare(a.at));
}
