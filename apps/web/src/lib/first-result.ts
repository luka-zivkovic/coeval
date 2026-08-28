import type { EvalRun, VerdictRecord } from "@coeval/shared";

export function backfillRunForVersion(runs: EvalRun[], skillVersionId: string): EvalRun | null {
  return runs.find((run) =>
    run.skillVersionId === skillVersionId && run.trigger === "backfill"
  ) ?? null;
}

export function verdictForTrackedItem(
  verdicts: VerdictRecord[],
  verdictId: string
): VerdictRecord | null {
  return verdicts.find((verdict) => verdict.id === verdictId) ?? null;
}
