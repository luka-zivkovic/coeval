// Shared cap for the exceptions list. PgRepository.listExceptionCases reduces
// in SQL (mirroring pinExceptionJudgeRunRows below — the unit-tested spec) and
// must apply the SAME limit, or the dashboard and this lib disagree about what
// "the queue" is.
export const EXCEPTION_LIST_LIMIT = 50;

export interface ExceptionJudgeRunRow {
  case_id: string;
  judge_run_id: string;
  verdict: string;
  reasoning: string;
  created_at: string | Date;
}

export interface PinnedExceptionJudgeRunRow extends ExceptionJudgeRunRow {
  latest_judge_run_id: string | null;
  latest_verdict: string | null;
  latest_reasoning: string | null;
  latest_created_at: string | Date | null;
}

export function pinExceptionJudgeRunRows<T extends ExceptionJudgeRunRow>(
  rows: T[],
  resolvedAtByCase: Map<string, string | Date>,
  limit = EXCEPTION_LIST_LIMIT
): Array<T & PinnedExceptionJudgeRunRow> {
  const byCase = new Map<string, T[]>();
  for (const row of rows) {
    const caseRows = byCase.get(row.case_id);
    if (caseRows) caseRows.push(row);
    else byCase.set(row.case_id, [row]);
  }

  const pinned: Array<T & PinnedExceptionJudgeRunRow> = [];
  for (const [caseId, caseRows] of byCase) {
    const sorted = [...caseRows].sort(compareJudgeRows);
    const resolvedAt = resolvedAtByCase.get(caseId);
    const openRows = resolvedAt
      ? sorted.filter((row) => toMillis(row.created_at) > toMillis(resolvedAt))
      : sorted;
    const pinnedRow = openRows.find((row) => row.verdict !== "pass");
    if (!pinnedRow) continue;
    const latest = sorted[sorted.length - 1]!;
    pinned.push({
      ...pinnedRow,
      latest_judge_run_id: latest.judge_run_id,
      latest_verdict: latest.verdict,
      latest_reasoning: latest.reasoning,
      latest_created_at: latest.created_at
    });
  }

  return pinned
    .sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at) || String(b.judge_run_id).localeCompare(String(a.judge_run_id)))
    .slice(0, limit);
}

function compareJudgeRows(a: ExceptionJudgeRunRow, b: ExceptionJudgeRunRow): number {
  return toMillis(a.created_at) - toMillis(b.created_at) || String(a.judge_run_id).localeCompare(String(b.judge_run_id));
}

function toMillis(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
