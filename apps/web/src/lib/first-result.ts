import type { EvalRun } from "@coeval/shared";

export function backfillRunForVersion(runs: EvalRun[], skillVersionId: string): EvalRun | null {
  return runs.find((run) =>
    run.skillVersionId === skillVersionId && run.trigger === "backfill"
  ) ?? null;
}
