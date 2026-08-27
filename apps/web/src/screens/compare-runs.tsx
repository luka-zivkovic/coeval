import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronRight, GitCompareArrows, Play } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/table";
import { RowButton, RowLink } from "@/components/row-action";
import { Chip, Eyebrow, KPI, KPIRow, LabelChip, SectionHead, VerdictChip } from "@/components/coeval";
import {
  createRunComparison,
  fetchCurrentSkill,
  fetchDatasets,
  fetchRunComparisonDetail,
  fetchRunComparisons,
  fetchSkillVersions
} from "@/lib/api";
import { cn, formatTimestamp } from "@/lib/utils";
import { useCriterion } from "@/lib/criterion-context";
import { versionPairIsInScope } from "@/lib/criterion-scope";
import type {
  Dataset,
  RunComparison,
  RunComparisonBucket,
  RunComparisonCase,
  RunComparisonDetail,
  SkillVersion
} from "@coeval/shared";

const COMPARISON_POLL_MS = 4000;

const BUCKET_LABEL: Record<RunComparisonBucket, string> = {
  "flipped-now-failing": "flipped · now failing",
  "flipped-now-passing": "flipped · now passing",
  "same-fail": "same · fail",
  "same-pass": "same · pass",
  pending: "pending",
  missing: "missing"
};

// Incident Bisect (compare on dataset): judge ONE dataset with TWO skill
// versions and read the per-case diff — "which version introduced these
// failures?" answered from two recorded runs, not from memory. The runs are
// ordinary eval runs; this screen creates the pair and polls until both land.
export function CompareRunsScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("id");

  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<SkillVersion[]>([]); // newest → oldest
  const [comparisons, setComparisons] = useState<RunComparison[]>([]);
  const [detail, setDetail] = useState<RunComparisonDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [datasetId, setDatasetId] = useState<string>("");
  const [versionAId, setVersionAId] = useState<string>("");
  const [versionBId, setVersionBId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [datasetRows, comparisonRows, skill] = await Promise.all([
          fetchDatasets(),
          fetchRunComparisons(),
          fetchCurrentSkill(selectedCriterionId ?? undefined)
        ]);
        const versionRows = await fetchSkillVersions(skill.id, 200);
        if (cancelled) return;
        const versionIds = new Set(versionRows.map((version) => version.id));
        const runnable = datasetRows.filter((dataset) => !dataset.archivedAt && dataset.itemCount > 0);
        setDatasets(runnable);
        setComparisons(comparisonRows.filter((comparison) => versionPairIsInScope(comparison, versionIds)));
        setVersions(versionRows);
        setDatasetId((current) => current || (runnable[0]?.id ?? ""));
        // Default pair mirrors /skill/compare: previous version as A (the
        // "known good"), newest as B (the suspect).
        if (versionRows.length >= 2) {
          setVersionAId((current) => current || versionRows[1]!.id);
          setVersionBId((current) => current || versionRows[0]!.id);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCriterionId]);

  const versionIds = useMemo(() => new Set(versions.map((version) => version.id)), [versions]);

  // Load the open comparison's detail whenever ?id changes…
  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    if (loading) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchRunComparisonDetail(openId);
        if (cancelled) return;
        const inSelectedCriterion = loaded && versionPairIsInScope(loaded, versionIds);
        setDetail(inSelectedCriterion ? loaded : null);
        // A 404 or a comparison owned by another criterion fails closed.
        if (!inSelectedCriterion) setError("Comparison not found for the selected criterion");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, openId, versionIds]);

  // …and poll while either run is still executing. Keyed on id + pending so
  // the timer tears down once both runs are terminal.
  const polling = detail?.status === "pending";
  useEffect(() => {
    if (!openId || !polling) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const loaded = await fetchRunComparisonDetail(openId);
          if (
            !cancelled
            && loaded
            && versionPairIsInScope(loaded, versionIds)
          ) setDetail(loaded);
        } catch {
          // Transient poll failures keep the last good state; the next tick retries.
        }
      })();
    }, COMPARISON_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [openId, polling, versionIds]);

  const openComparison = useCallback(
    (id: string) => setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("id", id);
      return next;
    }, { replace: true }),
    [setSearchParams]
  );

  const start = async () => {
    if (!datasetId || !versionAId || !versionBId) return;
    setCreating(true);
    setError(null);
    try {
      const comparison = await createRunComparison({ datasetId, versionAId, versionBId });
      setComparisons((current) => [comparison, ...current.filter((c) => c.id !== comparison.id)]);
      openComparison(comparison.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const versionLabel = useMemo(() => {
    const byId = new Map(versions.map((version) => [version.id, `v${version.version}`]));
    return (id: string) => byId.get(id) ?? id;
  }, [versions]);
  const datasetName = (id: string) => datasets.find((dataset) => dataset.id === id)?.name ?? id;

  const canStart = !creating && datasetId !== "" && versionAId !== "" && versionBId !== "" && versionAId !== versionBId;

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Compare evaluator versions on one dataset"
        title="See which cases changed"
        sub="Run two evaluator versions over the same dataset and compare their case-level results. Both are ordinary evaluation runs, and every value comes from a recorded verdict."
      />

      {error ? (
        <Card className="mb-5 border-signal-tint bg-signal-wash">
          <CardContent className="py-3 text-[12px] text-signal">{error}</CardContent>
        </Card>
      ) : null}

      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center gap-3 py-3.5">
          <Eyebrow>Dataset</Eyebrow>
          <PickSelect value={datasetId} onChange={setDatasetId} disabled={loading}>
            {datasets.length === 0 ? <option value="">no runnable datasets</option> : null}
            {datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name} · {dataset.itemCount} case{dataset.itemCount === 1 ? "" : "s"}
              </option>
            ))}
          </PickSelect>
          <Eyebrow>Version A</Eyebrow>
          <PickSelect value={versionAId} onChange={setVersionAId} disabled={loading}>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>v{version.version}</option>
            ))}
          </PickSelect>
          <span className="font-mono text-ink-4">vs</span>
          <Eyebrow>Version B</Eyebrow>
          <PickSelect value={versionBId} onChange={setVersionBId} disabled={loading}>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>v{version.version}</option>
            ))}
          </PickSelect>
          <div className="flex-1" />
          {versionAId !== "" && versionAId === versionBId ? (
            <span className="font-mono text-[11px] text-signal">pick two different versions</span>
          ) : null}
          <Button variant="primary" size="sm" onClick={() => void start()} disabled={!canStart}>
            <Play /> {creating ? "Starting…" : "Run comparison"}
          </Button>
        </CardContent>
      </Card>

      {detail ? (
        <ComparisonDetail
          detail={detail}
          versionLabel={versionLabel}
          datasetName={datasetName(detail.datasetId)}
          onOpenCase={(caseId) => navigate(`/cases/${caseId}`)}
        />
      ) : null}

      <SectionHead
        className="mb-3 mt-8"
        eyebrow="History"
        title="Comparisons"
        sub="Each comparison pairs two recorded runs over the same dataset. Open one to review the case-level differences again."
      />
      {comparisons.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-ink-3">
            {loading ? "Fetching comparisons…" : "No comparisons yet. Start one above."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Dataset</th>
                <th>Version A</th>
                <th>Version B</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((comparison) => (
                <tr
                  key={comparison.id}
                  className={cn("row-link", comparison.id === openId && "row-signal")}
                  onClick={() => openComparison(comparison.id)}
                >
                  <td>
                    <RowButton
                      onClick={() => openComparison(comparison.id)}
                      aria-label={`Open comparison · ${formatTimestamp(comparison.createdAt)}`}
                      className="font-mono text-[11px] text-ink-3"
                    >
                      {formatTimestamp(comparison.createdAt)}
                    </RowButton>
                  </td>
                  <td className="font-mono text-[11px]">{datasetName(comparison.datasetId)}</td>
                  <td className="font-mono text-[11px]">{versionLabel(comparison.versionAId)}</td>
                  <td className="font-mono text-[11px]">{versionLabel(comparison.versionBId)}</td>
                  <td>
                    <ChevronRight className="size-3.5 text-ink-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function ComparisonDetail({
  detail,
  versionLabel,
  datasetName,
  onOpenCase
}: {
  detail: RunComparisonDetail;
  versionLabel: (id: string) => string;
  datasetName: string;
  onOpenCase: (caseId: string) => void;
}) {
  const agreement = (a: { agreed: number; labeled: number }) =>
    a.labeled > 0 ? `${a.agreed}/${a.labeled}` : "—";
  const flippedFailing = detail.buckets["flipped-now-failing"];
  const flippedPassing = detail.buckets["flipped-now-passing"];
  const unresolved = detail.buckets.pending + detail.buckets.missing;

  return (
    <Card className="mb-5">
      <CardHeader>
        <div>
          <CardTitle className="inline-flex items-center gap-2">
            <GitCompareArrows className="size-4 text-ink-3" />
            {versionLabel(detail.versionAId)} vs {versionLabel(detail.versionBId)} · {datasetName}
          </CardTitle>
          <CardDescription>
            {detail.status === "pending"
              ? "Runs still executing — the diff below fills in as verdicts land."
              : "Both runs are done. Flips are listed first."}
          </CardDescription>
        </div>
        <div className="flex-1" />
        <div className="flex gap-2">
          <Chip variant={flippedFailing > 0 ? "fail" : "outline"}>{flippedFailing} now failing</Chip>
          <Chip>{flippedPassing} now passing</Chip>
          <Chip variant="outline">
            {detail.buckets["same-pass"]} same-pass · {detail.buckets["same-fail"]} same-fail
          </Chip>
          {unresolved > 0 ? (
            <Chip variant="outline">
              {detail.buckets.pending} pending · {detail.buckets.missing} missing
            </Chip>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <KPIRow className="mb-4">
          <KPI
            label={`Agreement · A (${versionLabel(detail.versionAId)})`}
            num={agreement(detail.agreementA)}
            delta={detail.agreementA.labeled > 0 ? "agreed of labeled + judged" : "no expected labels judged"}
          />
          <KPI
            label={`Agreement · B (${versionLabel(detail.versionBId)})`}
            num={agreement(detail.agreementB)}
            delta={detail.agreementB.labeled > 0 ? "agreed of labeled + judged" : "no expected labels judged"}
          />
          <KPI
            label="Flipped · now failing"
            num={flippedFailing}
            delta="passed under A, not under B"
            deltaKind={flippedFailing > 0 ? "signal" : "default"}
          />
          <KPI
            label="Run progress"
            num={`${detail.runA.completedItems + detail.runA.failedItems}/${detail.runA.totalItems} · ${detail.runB.completedItems + detail.runB.failedItems}/${detail.runB.totalItems}`}
            delta={detail.status === "pending" ? "still judging…" : "both runs terminal"}
          />
        </KPIRow>
        <Table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Expected</th>
              <th>A said</th>
              <th>B said</th>
              <th>Bucket</th>
              <th style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {detail.cases.map((row) => (
              <CaseRow key={row.caseId} row={row} onOpen={() => onOpenCase(row.caseId)} />
            ))}
          </tbody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CaseRow({ row, onOpen }: { row: RunComparisonCase; onOpen: () => void }) {
  const said = (label: string | null, status: RunComparisonCase["statusA"]) =>
    label ? <LabelChip label={label} /> : <span className="text-ink-4">{status ?? "absent"}</span>;
  return (
    <tr
      className={cn("row-link", row.bucket === "flipped-now-failing" && "row-signal")}
      onClick={onOpen}
    >
      <td>
        <RowLink to={`/cases/${row.caseId}`} className="font-mono text-[11px]">
          {row.caseId}
        </RowLink>
      </td>
      <td>{row.expectedLabel ? <VerdictChip verdict={row.expectedLabel} /> : <span className="text-ink-4">—</span>}</td>
      <td>{said(row.labelA, row.statusA)}</td>
      <td>{said(row.labelB, row.statusB)}</td>
      <td
        className="font-mono text-[11px]"
        style={row.bucket === "flipped-now-failing" ? { color: "var(--signal)" } : undefined}
      >
        {BUCKET_LABEL[row.bucket]}
      </td>
      <td>
        <ChevronRight className="size-3.5 text-ink-4" />
      </td>
    </tr>
  );
}

function PickSelect({
  value,
  onChange,
  disabled,
  children
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="h-7 cursor-pointer rounded-sm border border-rule-soft bg-card px-2 font-mono text-[11.5px] text-ink-2 hover:bg-card-2"
    >
      {children}
    </select>
  );
}
