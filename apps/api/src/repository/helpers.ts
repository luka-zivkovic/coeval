import {
  CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT,
  CONVERGENCE_CASE_PAGE_MAX_LIMIT,
  type CaseSource,
  type ConvergenceCaseChange,
  type EvalRunItem,
  type EvalRunSpend,
  type RuntimeIngestionPurpose,
  type TraceTestValidation,
  type TraceTestValidationDiagnostic,
  type TraceTestValidationStatus
} from "@coeval/shared";
import type { ConvergenceCursor } from "./contracts.js";
import { InvalidConvergenceCursorError } from "./errors.js";

// Pure repository-boundary helpers shared by implementations and workers.
export function traceTestValidationStatus(
  badResult: TraceTestValidation["badEvidence"]["result"],
  goodResult: TraceTestValidation["goodEvidence"]["result"]
): TraceTestValidationStatus {
  const results = [badResult, goodResult];
  if (results.includes("unavailable")) return "unavailable";
  if (results.includes("evaluator_error")) return "evaluator_error";
  if (results.includes("ambiguous")) return "ambiguous";
  if (results.includes("could_not_run")) return "could_not_run";
  if (results.includes("needs_review")) return "needs_review";
  if (badResult === "fail" && goodResult === "pass") return "passed";
  if (badResult === goodResult) return "non_discriminating";
  return "failed";
}

export function traceTestValidationDiagnostic(
  badResult: TraceTestValidation["badEvidence"]["result"],
  goodResult: TraceTestValidation["goodEvidence"]["result"]
): TraceTestValidationDiagnostic | null {
  const status = traceTestValidationStatus(badResult, goodResult);
  if (status === "passed") return null;
  if (status === "non_discriminating") return badResult === "pass" ? "always_pass" : "always_fail";
  if (status === "failed") return "reversed";
  if (status === "ambiguous" || status === "needs_review") return "ambiguous";
  if (status === "evaluator_error") return "evaluator_error";
  return "unavailable";
}

export function traceTestValidationIsEnableEligible(validation: TraceTestValidation): boolean {
  if (validation.status !== "passed") return false;
  if (validation.method === "automated") return validation.evaluator !== null;
  if (validation.method === "manual_override") {
    return typeof validation.overrideReason === "string" && validation.overrideReason.trim().length >= 10;
  }
  return false;
}

// run-level spend from the items — tokens and counts, never dollars.
// Null token sums mean "nothing reported usage" (no fresh calls, or all
// calls unreported); zero is a real recorded zero. Cached items never count.
export function computeEvalRunSpend(items: EvalRunItem[]): EvalRunSpend {
  const fresh = items.filter((item) => !item.cached && item.status === "completed");
  const cached = items.filter((item) => item.cached);
  // BOTH sides must be present to count as reported — a partial envelope is
  // treated as unreported (usageMissingCount), never zero-filled on one side.
  const reported = fresh.filter((item) => item.inputTokens !== null && item.outputTokens !== null);
  const latencies = items.map((item) => item.latencyMs).filter((ms): ms is number => ms !== null);
  return {
    freshItems: fresh.length,
    cachedItems: cached.length,
    inputTokens: reported.length === 0 ? null : reported.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
    outputTokens: reported.length === 0 ? null : reported.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    usageMissingCount: fresh.length - reported.length,
    totalLatencyMs: latencies.length === 0 ? null : latencies.reduce((sum, ms) => sum + ms, 0)
  };
}

// the ONLY renderable form of a stored judge key.
export function judgeKeyDisplay(apiKey: string): string {
  if (apiKey.length <= 14) return `${apiKey.slice(0, 4)}…`;
  return `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}`;
}

export const TRACE_INGESTION_PURPOSES_BY_SOURCE = {
  manual: [
    "analysis_eligible_manual",
    "judge_api",
    "judge_batch_general",
    "dataset_example",
    "trace_test_synthetic"
  ],
  langsmith: ["analysis_eligible_langsmith"],
  langfuse: ["analysis_eligible_langfuse"],
  ironside: ["analysis_eligible_ironside"],
  release_evidence: ["release_evidence"],
  gate_candidate: []
} as const satisfies Record<CaseSource, readonly RuntimeIngestionPurpose[]>;

export function assertTraceIngestionPurpose(
  source: CaseSource,
  purpose: RuntimeIngestionPurpose
): void {
  const allowed = TRACE_INGESTION_PURPOSES_BY_SOURCE[source] as readonly RuntimeIngestionPurpose[];
  if (!allowed.includes(purpose)) {
    throw new Error(`Ingestion purpose ${purpose} is not valid for case source ${source}`);
  }
}

export function convergencePageLimit(value: number | undefined): number {
  if (value === undefined) return CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT;
  return Math.min(CONVERGENCE_CASE_PAGE_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

export function convergenceChangeRank(change: ConvergenceCaseChange): number {
  if (change === "regressed") return 0;
  if (change === "improved") return 1;
  if (change === "still_disagree") return 2;
  return 3;
}

export function encodeConvergenceCursor(cursor: ConvergenceCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeConvergenceCursor(value: string | null): ConvergenceCursor | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      !Number.isInteger(parsed.rank) ||
      Number(parsed.rank) < 0 ||
      Number(parsed.rank) > 3 ||
      typeof parsed.versionId !== "string" ||
      parsed.versionId.length === 0 ||
      typeof parsed.criterionVersionId !== "string" ||
      parsed.criterionVersionId.length === 0 ||
      !(parsed.beforeVersionId === null || typeof parsed.beforeVersionId === "string") ||
      typeof parsed.snapshotCreatedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.snapshotCreatedAt)) ||
      typeof parsed.snapshotId !== "string" ||
      parsed.snapshotId.length === 0 ||
      typeof parsed.caseId !== "string" ||
      parsed.caseId.length === 0
    ) {
      throw new InvalidConvergenceCursorError();
    }
    return {
      versionId: parsed.versionId,
      criterionVersionId: parsed.criterionVersionId,
      beforeVersionId: parsed.beforeVersionId as string | null,
      snapshotCreatedAt: parsed.snapshotCreatedAt,
      snapshotId: parsed.snapshotId,
      rank: Number(parsed.rank),
      caseId: parsed.caseId
    };
  } catch (error) {
    if (error instanceof InvalidConvergenceCursorError) throw error;
    throw new InvalidConvergenceCursorError();
  }
}
