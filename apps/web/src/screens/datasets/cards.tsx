import {
  ChevronRight,
  Database,
  Play
} from "lucide-react";
import {
  Card,
  CardContent
} from "@/components/ui/card";
import {
  Button
} from "@/components/ui/button";
import {
  Table
} from "@/components/ui/table";
import {
  RowLink
} from "@/components/row-action";
import {
  Chip,
  Eyebrow,
  LabelChip,
  VerdictChip
} from "@/components/coeval";
import {
  type RunDelta
} from "@/lib/run-delta";
import {
  cn,
  formatTimestamp
} from "@/lib/utils";
import {
  type Dataset,
  type DatasetDetail,
  type DatasetRevision,
  type EvalRunDetail,
  traceTestRunOutcome,
  type TraceTestRunOutcome
} from "@coeval/shared";

// Agreement is only meaningful over items that carried an expectedLabel AND
// were actually judged — a failed item was never judged, and counting it in
// the denominator would render an infrastructure error as a judge
// disagreement.
function detailAgreement(detail: EvalRunDetail): string {
  if (detail.status !== "completed") return "—";
  const judged = detail.items.filter((item) => item.expectedLabel !== null && item.status === "completed").length;
  if (judged === 0) return "no expected labels";
  const failed = detail.items.filter((item) => item.status === "failed").length;
  return `${detail.agreedItems}/${judged} agree${failed > 0 ? ` · ${failed} failed` : ""}`;
}

export function DatasetCard({
  dataset,
  starting,
  onOpen,
  onRun
}: {
  dataset: Dataset;
  starting: boolean;
  onOpen: () => void;
  onRun: () => void;
}) {
  return (
    <Card className={cn("flex h-full flex-col", dataset.archivedAt && "opacity-60")}>
      <CardContent className="flex h-full flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
            <Database className="size-3.5 text-ink-3" /> {dataset.name}
          </div>
          <Chip>working · mutable</Chip>
        </div>
        {dataset.description ? (
          <div className="text-[12.5px] leading-[1.5] text-ink-2">{dataset.description}</div>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-ink-3">
            {dataset.itemCount} case{dataset.itemCount === 1 ? "" : "s"} · {formatTimestamp(dataset.createdAt)}
            {dataset.archivedAt ? " · archived" : ""}
          </span>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={onOpen}>
              Cases
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={onRun}
              disabled={starting || dataset.itemCount === 0 || dataset.archivedAt !== null}
              title={dataset.itemCount === 0 ? "Dataset has no cases to judge." : undefined}
            >
              <Play /> {starting ? "Starting…" : "Run eval"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DatasetDetailCard({
  detail,
  revisions,
  freezing,
  startingRevisionId,
  onFreeze,
  onRunRevision,
  onClose,
  onOpenCase
}: {
  detail: DatasetDetail;
  revisions: DatasetRevision[];
  freezing: string | null;
  startingRevisionId: string | null;
  onFreeze: (role: "analysis_authoring" | "iterative_development") => void;
  onRunRevision: (revisionId: string) => void;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <Eyebrow>
              {detail.name} · working collection · mutable · {detail.items.length} case{detail.items.length === 1 ? "" : "s"}
            </Eyebrow>
            <div className="mt-1 text-[11px] text-ink-3">
              Freeze a revision when you need a stable, digest-addressed evaluation corpus. The collection stays editable.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={detail.items.length === 0 || freezing !== null}
              onClick={() => onFreeze("analysis_authoring")}
            >
              {freezing === "analysis_authoring" ? "Freezing…" : "Freeze for analysis"}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={detail.items.length === 0 || freezing !== null}
              onClick={() => onFreeze("iterative_development")}
            >
              {freezing === "iterative_development" ? "Freezing…" : "Freeze for development"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
        <Table>
          <thead>
            <tr>
              <th>Trace</th>
              <th>Expected</th>
              <th>Note</th>
              <th style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((item) => (
              <tr key={item.id} className="row-link" onClick={() => onOpenCase(item.caseId)}>
                <td>
                  <RowLink to={`/cases/${item.caseId}`} className="font-mono text-[11px]">
                    {item.traceId}
                  </RowLink>
                </td>
                <td>{item.expectedLabel ? <VerdictChip verdict={item.expectedLabel} /> : <span className="text-ink-4">—</span>}</td>
                <td className="text-[12px] text-ink-2">{item.note ?? "—"}</td>
                <td>
                  <ChevronRight className="size-3.5 text-ink-4" />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="mt-5 border-t border-rule-soft pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <Eyebrow>Immutable revisions · {revisions.length}</Eyebrow>
            <span className="text-[10.5px] text-ink-3">Sealed validation intake is not available in this batch.</span>
          </div>
          {revisions.length === 0 ? (
            <div className="rounded-sm bg-paper-2 px-3 py-3 text-[12px] text-ink-3">
              No frozen evidence revisions yet.
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Role</th>
                  <th>Cases</th>
                  <th>Exposure</th>
                  <th>Digest</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision) => (
                  <tr key={revision.id}>
                    <td className="font-mono text-[11px]">r{revision.revisionNumber}</td>
                    <td><Chip>{revision.role.replaceAll("_", " ")}</Chip></td>
                    <td className="font-mono text-[11px]">{revision.itemCount}</td>
                    <td className="font-mono text-[11px]">{revision.exposureState.replaceAll("_", " ")}</td>
                    <td className="font-mono text-[10px] text-ink-3" title={revision.revisionDigest}>
                      {revision.revisionDigest.slice(0, 18)}…
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={startingRevisionId === revision.id || revision.itemCount === 0}
                        onClick={() => onRunRevision(revision.id)}
                      >
                        <Play /> {startingRevisionId === revision.id ? "Starting…" : "Run"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// the delta card. Counts only, flips first, and every excluded case
// (only-in-one-run, failed) is named instead of vanishing from a denominator.
export function RunDeltaCard({
  comparison,
  datasets,
  versionNames,
  onClose,
  onOpenCase
}: {
  comparison: { a: EvalRunDetail; b: EvalRunDetail; delta: RunDelta };
  datasets: Dataset[];
  versionNames: Record<string, string>;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  const { a, b, delta } = comparison;
  const versionLabel = (versionId: string) => versionNames[versionId] ?? versionId;
  const datasetName = a.datasetId
    ? datasets.find((d) => d.id === a.datasetId)?.name ?? a.datasetId
    : "ad-hoc batch";
  const sameVersion = a.skillVersionId === b.skillVersionId;
  const said = (label: string | null, status: string) =>
    label ? <LabelChip label={label} /> : <span className="text-signal">{status}</span>;

  const notes: string[] = [];
  if (delta.aOnly > 0 || delta.bOnly > 0) {
    notes.push(
      `${delta.aOnly + delta.bOnly} case(s) appear in only one run (${delta.aOnly} A-only, ${delta.bOnly} B-only) — the dataset changed between runs; they can't flip and are not shown.`
    );
  }
  if (delta.aFailed > 0 || delta.bFailed > 0) {
    notes.push(
      `${delta.aFailed + delta.bFailed} item(s) failed (${delta.aFailed} in A, ${delta.bFailed} in B) — a failed item was never judged and is never counted as a flip.`
    );
  }
  if (sameVersion) {
    notes.push("Both runs used the same skill version — any flip here is judge inconsistency, not a prompt change.");
  }

  return (
    <Card className="mt-4">
      <CardContent className="py-4">
        <div className="mb-1 flex items-center justify-between">
          <Eyebrow>Delta · {datasetName}</Eyebrow>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="mb-3 text-[13px] text-ink">
          <span className="font-medium">A · {versionLabel(a.skillVersionId)}</span>{" "}
          <span className="font-mono text-[12px]">
            {delta.aAgreement.labeled > 0 ? `${delta.aAgreement.agreed}/${delta.aAgreement.labeled} agreed` : "no expected labels"}
          </span>
          {" · "}
          <span className="font-medium">B · {versionLabel(b.skillVersionId)}</span>{" "}
          <span className="font-mono text-[12px]">
            {delta.bAgreement.labeled > 0 ? `${delta.bAgreement.agreed}/${delta.bAgreement.labeled} agreed` : "no expected labels"}
          </span>
          {" · "}
          <span className={cn("font-mono text-[12px]", delta.flipped > 0 ? "text-signal" : "text-ink-3")}>
            {delta.flipped} of {delta.shared} shared case(s) flipped
          </span>
        </div>
        {notes.length > 0 ? (
          <div className="mb-3 flex flex-col gap-0.5 text-[11px] leading-[1.5] text-ink-3">
            {notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        ) : null}
        {delta.shared === 0 ? (
          <div className="py-4 text-[12.5px] text-ink-3">
            These runs share no cases — there is nothing to diff.
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Expected</th>
                <th>A said</th>
                <th>B said</th>
                <th>Flip</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {delta.rows.map((row) => (
                <tr
                  key={row.caseId}
                  className={cn("row-link", row.flipped && "row-signal")}
                  onClick={() => onOpenCase(row.caseId)}
                >
                  <td>
                    <RowLink to={`/cases/${row.caseId}`} className="font-mono text-[11px]">
                      {row.caseId}
                    </RowLink>
                  </td>
                  <td>{row.expected ? <VerdictChip verdict={row.expected} /> : <span className="text-ink-4">—</span>}</td>
                  <td>{said(row.aSaid, row.aStatus)}</td>
                  <td>{said(row.bSaid, row.bStatus)}</td>
                  <td className="font-mono text-[11px]">
                    {row.flipped ? "flipped" : row.aSaid !== null && row.bSaid !== null ? "same" : "—"}
                  </td>
                  <td>
                    <ChevronRight className="size-3.5 text-ink-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function EvalRunDetailCard({
  detail,
  onClose,
  onOpenCase,
  onOpenTraceTest
}: {
  detail: EvalRunDetail;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
  onOpenTraceTest: (source: NonNullable<EvalRunDetail["sourceTraceTest"]>) => void;
}) {
  const disagreements = detail.items.filter((item) => item.agreement === false).length;
  // tokens and counts, never dollars. Null token sums = nothing
  // reported usage (all cached, or the provider didn't report) — an explicit
  // state, never zero-as-unknown.
  const spend = detail.spend;
  const sourceOutcome = detail.sourceTraceTest ? traceTestRunOutcome(detail) : null;
  const spendLine = [
    `${spend.freshItems} fresh`,
    `${spend.cachedItems} cached (no spend)`,
    spend.inputTokens === null && spend.outputTokens === null
      ? "usage unavailable"
      : `${spend.inputTokens ?? 0} in / ${spend.outputTokens ?? 0} out tokens`,
    ...(spend.usageMissingCount > 0 ? [`usage unavailable for ${spend.usageMissingCount} call(s)`] : []),
    ...(spend.totalLatencyMs !== null ? [`${spend.totalLatencyMs} ms total`] : [])
  ].join(" · ");
  return (
    <Card className="mt-4">
      <CardContent className="py-4">
        <div className="mb-3 flex items-center justify-between">
          <Eyebrow>
            Run {detail.id} · {detail.status} · {detailAgreement(detail)}
            {disagreements > 0 ? ` · ${disagreements} disagree` : ""}
          </Eyebrow>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="mb-3 font-mono text-[11px] text-ink-3" data-spend-line>
          spend: {spendLine}
        </div>
        {detail.sourceTraceTest ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-rule-soft bg-paper-2 px-3 py-2.5">
            <div>
              <div className="text-[12px] font-medium text-ink">Run from a saved conversation test</div>
              <div className="mt-0.5 text-[11px] text-ink-3">Revision {detail.sourceTraceTest.revision} · validation {detail.sourceTraceTest.validationId}</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenTraceTest(detail.sourceTraceTest!)}>View source test</Button>
          </div>
        ) : null}
        {sourceOutcome ? <TraceTestOutcomeBanner outcome={sourceOutcome} /> : null}
        <div className="overflow-x-auto">
          <Table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Expected</th>
              <th>Judge said</th>
              <th>Agreement</th>
              <th>Latency</th>
              <th>Cached</th>
              <th style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((item) => (
              <tr
                key={item.id}
                className={cn("row-link", item.agreement === false && "row-signal")}
                onClick={() => onOpenCase(item.caseId)}
              >
                <td>
                  <RowLink to={`/cases/${item.caseId}`} className="font-mono text-[11px]">
                    {item.caseId}
                  </RowLink>
                </td>
                <td>{item.expectedLabel ? <VerdictChip verdict={item.expectedLabel} /> : <span className="text-ink-4">—</span>}</td>
                <td>
                  {item.resultLabel ? (
                    <LabelChip label={item.resultLabel} />
                  ) : (
                    <span className="text-ink-4">{item.status}</span>
                  )}
                </td>
                <td className="font-mono text-[11px]">
                  {item.agreement === null ? "—" : item.agreement ? "agree" : "disagree"}
                </td>
                <td className="font-mono text-[11px] text-ink-3">
                  {item.latencyMs === null ? "—" : `${item.latencyMs} ms`}
                </td>
                <td className="font-mono text-[11px] text-ink-3">{item.cached ? "cached" : "fresh"}</td>
                <td>
                  <ChevronRight className="size-3.5 text-ink-4" />
                </td>
              </tr>
            ))}
          </tbody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function TraceTestOutcomeBanner({ outcome }: { outcome: TraceTestRunOutcome }) {
  const copy = outcome === "passed"
    ? { title: "Passed", body: "The evaluator behaved as this saved test expected." }
    : outcome === "regressed"
      ? { title: "Regressed", body: "The evaluator disagreed with the behavior this test protects." }
      : outcome === "needs_review"
        ? { title: "Needs review", body: "The evaluator could not make a clear behavior decision from this case." }
        : outcome === "could_not_run"
          ? { title: "Could not run", body: "A runtime or provider problem stopped this check. This is not a behavior regression." }
          : { title: "Running", body: "Coeval is checking this test now. This report will update automatically." };
  return (
    <div className="mb-3 rounded-sm border border-rule-soft bg-paper-2 px-3 py-2.5" role="status">
      <div className="text-[12px] font-medium text-ink">{copy.title}</div>
      <div className="mt-0.5 text-[11.5px] leading-[1.5] text-ink-2">{copy.body}</div>
    </div>
  );
}
