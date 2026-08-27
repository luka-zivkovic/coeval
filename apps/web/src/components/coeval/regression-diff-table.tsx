import { useNavigate } from "react-router-dom";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table } from "@/components/ui/table";
import { RowLink } from "@/components/row-action";
import { Chip } from "./chip";
import { VerdictChip } from "./chip";
import { cn } from "@/lib/utils";
import type { RegressionCaseDiff } from "@coeval/shared";

const CHANGE_LABEL: Record<RegressionCaseDiff["change"], string> = {
  regress: "regressed",
  improve: "improved",
  agree: "agreed"
};

function changeRank(change: RegressionCaseDiff["change"]): number {
  switch (change) {
    case "regress":
      return 0;
    case "improve":
      return 1;
    default:
      return 2;
  }
}

// The gate's teeth: every golden case re-judged, sorted regressions-first so the
// reviewer sees what would break before anything else. Turns "3 cases regressed"
// into "here is exactly which, how the verdict changed, and a click to the trace."
export function RegressionDiffTable({
  cases,
  title = "Case-by-case diff",
  description = "Every promoted case re-judged against this version. Regressions first."
}: {
  cases: RegressionCaseDiff[];
  title?: string;
  description?: string;
}) {
  const navigate = useNavigate();
  const ordered = [...cases].sort((a, b) => changeRank(a.change) - changeRank(b.change));
  const regressedCount = cases.filter((c) => c.change === "regress").length;

  return (
    <Card className="mb-5">
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="flex-1" />
        <div className="flex gap-1.5">
          {regressedCount > 0 ? <Chip variant="fail">{regressedCount} regressed</Chip> : null}
          <Chip variant="outline">{cases.length} compared</Chip>
        </div>
      </CardHeader>
      <Table>
        <thead>
          <tr>
            <th style={{ width: 90 }}>Change</th>
            <th>Case</th>
            <th style={{ width: 180 }}>Agreed → new</th>
            <th>Reading</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((c) => (
            <tr
              key={c.caseId}
              className={cn("row-link", c.change === "regress" && "row-signal")}
              onClick={() => navigate(`/cases/${c.caseId}`)}
              title="Open the trace"
            >
              <td>
                <span
                  className={cn(
                    "font-mono text-[10.5px] uppercase tracking-[0.08em]",
                    c.change === "regress" ? "text-signal" : "text-ink-3"
                  )}
                >
                  {CHANGE_LABEL[c.change]}
                </span>
              </td>
              <td>
                <RowLink to={`/cases/${c.caseId}`} className="font-mono text-[11.5px] text-ink-2">
                  {c.caseId}
                </RowLink>
                <div className="font-mono text-[10.5px] tracking-[0.04em] text-ink-3">{c.traceId}</div>
              </td>
              <td>
                <div className="flex items-center gap-1.5">
                  <VerdictChip verdict={c.agreedLabel} />
                  <span className="text-ink-3">→</span>
                  <VerdictChip verdict={c.newLabel} />
                </div>
              </td>
              <td className="text-[12px] text-ink-3">{c.rationale}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
