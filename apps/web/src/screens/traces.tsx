import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Download, Inbox, RefreshCcw, Search, Shuffle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/table";
import {
  DistBar,
  EmptyShell,
  Eyebrow,
  ProvBanner,
  ProvChip,
  SectionHead,
  VerdictChip
} from "@/components/coeval";
import {
  fetchProjectVerdicts
} from "@/lib/api";
import { SaveQueueModal } from "@/components/save-queue-modal";
import { RowLink } from "@/components/row-action";
import { useDashboard } from "@/lib/dashboard-context";
import { isBench, journeyStage } from "@/lib/journey";
import {
  buildTraceExportPresentation,
  VERDICT_SOURCE_LABEL,
  type TraceSourceFilter
} from "@/lib/trace-export";
import { cn, formatTimestamp } from "@/lib/utils";
import {
  verdictComparableScore,
  verdictLabelFromPayload,
  VERDICT_LIST_MAX_LIMIT,
  type VerdictRecord
} from "@coeval/shared";

type VerdictFilter = "all" | "pass" | "fail" | "ambiguous";
type SourceFilter = TraceSourceFilter;

const VERDICT_OPTIONS: ReadonlyArray<{ value: VerdictFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pass", label: "Pass" },
  { value: "fail", label: "Fail" },
  { value: "ambiguous", label: "Ambiguous" }
];

const SOURCE_OPTIONS: ReadonlyArray<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "llm_judge", label: "LLM judge" },
  { value: "human", label: "Human" },
  { value: "adjudicated", label: "Adjudicated" },
  { value: "imported_external", label: "Imported" }
];

// Capped to what the API accepts — the constant is shared so they can't
// drift back into a 400 on the whole screen.
const FETCH_LIMIT = VERDICT_LIST_MAX_LIMIT;

// Label projection is single-sourced in @coeval/shared; this page previously
// kept a private 0.66/0.33-banded copy that could disagree with the queue and
// the dashboard about the same verdict.
const derivedVerdict = verdictLabelFromPayload;

export function TracesScreen() {
  const navigate = useNavigate();
  const { dashboard } = useDashboard();
  const criterionId = dashboard?.skill.criterionId ?? null;
  const stage = dashboard ? journeyStage(dashboard) : "production";
  const [verdicts, setVerdicts] = useState<VerdictRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [versionFilter, setVersionFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sampleSeed, setSampleSeed] = useState<number | null>(null);
  const [saveQueueOpen, setSaveQueueOpen] = useState(false);

  const load = useCallback(async () => {
    if (!criterionId) {
      setVerdicts([]);
      setLoading(true);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchProjectVerdicts({ limit: FETCH_LIMIT, criterionId });
      setVerdicts(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [criterionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const versions = useMemo(() => {
    const set = new Set<string>();
    for (const v of verdicts) if (v.skillVersionId) set.add(v.skillVersionId);
    return Array.from(set).sort();
  }, [verdicts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return verdicts.filter((v) => {
      if (sourceFilter !== "all" && v.source !== sourceFilter) return false;
      if (versionFilter !== "all" && v.skillVersionId !== versionFilter) return false;
      if (verdictFilter !== "all" && derivedVerdict(v.payload) !== verdictFilter) return false;
      if (q && !v.caseId.toLowerCase().includes(q) && !v.id.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [verdicts, verdictFilter, sourceFilter, versionFilter, query]);

  const visible = useMemo(() => {
    if (sampleSeed == null) return filtered;
    // Deterministic shuffle by hashing id+seed, take first 20.
    return [...filtered]
      .map((row) => ({ row, sortKey: hashString(`${row.id}|${sampleSeed}`) }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .slice(0, 20)
      .map((item) => item.row);
  }, [filtered, sampleSeed]);

  const summary = useMemo(() => {
    const counts = { total: 0, pass: 0, fail: 0, ambiguous: 0, distinctCases: 0 };
    const caseIds = new Set<string>();
    for (const v of filtered) {
      counts.total += 1;
      counts[derivedVerdict(v.payload)] += 1;
      caseIds.add(v.caseId);
    }
    counts.distinctCases = caseIds.size;
    return counts;
  }, [filtered]);

  const visibleCaseCount = useMemo(() => new Set(visible.map((v) => v.caseId)).size, [visible]);

  const pct = (n: number) => (summary.total ? Math.round((n / summary.total) * 100) : 0);

  const resetFilters = () => {
    setVerdictFilter("all");
    setSourceFilter("all");
    setVersionFilter("all");
    setQuery("");
    setSampleSeed(null);
  };

  const exportPresentation = buildTraceExportPresentation({
    criterionId,
    sourceFilter,
    versionFilter
  });

  // Day 0 — no traces imported. Empty states say what to do next from here,
  // not just what the screen is.
  if (stage === "day0" && !loading && verdicts.length === 0) {
    // Bench projects reach this screen only by URL (it's out of the bench
    // nav) — the topbar has "Add examples", not "+ Import trace", so the
    // trace-era instructions would point at a button that doesn't exist.
    if (dashboard && isBench(dashboard.project)) {
      return (
        <EmptyShell
          className="min-h-[60vh] justify-center"
          eyebrow="Skill Bench · no judged cases yet"
          title="This bench runs on examples, not traces."
          body="Add example cases on the Examples screen and run the evaluator there. Results also appear in Exceptions. You can connect a tracer later without losing the evaluator or Golden set."
          primary={
            <Button variant="primary" onClick={() => navigate("/datasets")}>
              Open Examples
            </Button>
          }
          secondary={
            <Button variant="ghost" onClick={() => navigate("/integrations")}>
              Connect a tracer
            </Button>
          }
        />
      );
    }
    const traceProvider = dashboard?.project.traceProvider;
    const connected = traceProvider === "langsmith" || traceProvider === "langfuse";
    return (
      <EmptyShell
        className="min-h-[60vh] justify-center"
        eyebrow={connected ? "Traces · waiting on first poll" : "Traces · nothing imported yet"}
        title={connected ? "Connected. Listening." : "No traces yet."}
        body={
          connected
            ? "Coeval is connected to your tracer. The first batch should appear after the next polling cycle, with a recorded verdict for each imported trace."
            : "Connect a tracer, or paste a single trace with the + Import trace button in the top bar to see Coeval judge a case end-to-end."
        }
        primary={
          <Button variant="primary" onClick={() => navigate("/integrations")}>
            {connected ? "Check connection" : "Connect a trace source"}
          </Button>
        }
        secondary={
          <Button variant="ghost" onClick={() => navigate("/")}>
            Back to setup
          </Button>
        }
      />
    );
  }

  return (
    <div className="fadeUp">
      {stage === "provisional" ? (
        <ProvBanner
          className="mb-4"
          text={
            <span>
              Every evaluator verdict below is <b>provisional</b> because the starter review guide
              has not been approved yet.
            </span>
          }
          cta={
            <Button size="sm" onClick={() => navigate("/skill/edit")}>
              Review the rubric
            </Button>
          }
        />
      ) : null}
      <SectionHead
        eyebrow="Audit · ungoverned_legacy verdicts"
        title="Traces"
        sub="This page lists evaluator and human verdicts for ordinary cases. Use it to inspect, filter, sample, or export the legacy review ledger. These records are unblinded and do not count as governed human truth."
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            <a
              href={exportPresentation.url}
              title={exportPresentation.title}
              className="inline-flex h-7 items-center gap-2 rounded-sm border border-rule bg-card px-2 py-1 text-[11.5px] text-foreground hover:bg-card-2"
            >
              <Download className="size-3.5" /> Export
              {sourceFilter !== "all" ? (
                <span className="font-mono text-[10px] text-ink-3">· {VERDICT_SOURCE_LABEL[sourceFilter].toLowerCase()}</span>
              ) : null}
            </a>
            <Button
              variant="default"
              size="sm"
              onClick={() => setSampleSeed(sampleSeed == null ? Date.now() : null)}
            >
              <Shuffle /> {sampleSeed == null ? "Sample 20 random" : "Show all"}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={visible.length === 0}
              onClick={() => setSaveQueueOpen(true)}
            >
              <Inbox /> Save view as queue
            </Button>
          </div>
        }
      />

      {saveQueueOpen ? (
        <SaveQueueModal
          caseIds={visible.map((v) => v.caseId)}
          defaultName={
            sampleSeed != null
              ? "Random sample"
              : verdictFilter !== "all" || sourceFilter !== "all" || versionFilter !== "all" || query.trim()
                ? "Filtered traces"
                : "All traces"
          }
          context={`Saved from Traces · verdict ${verdictFilter} · source ${sourceFilter} · version ${versionFilter}${query.trim() ? ` · search "${query.trim()}"` : ""}${sampleSeed != null ? " · random sample of 20" : ""}`}
          onClose={() => setSaveQueueOpen(false)}
        />
      ) : null}

      <Card className="mb-5">
        <CardContent className="grid grid-cols-1 gap-6 py-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1.4fr]">
          <SummaryCell
            label="Verdict rows"
            value={summary.total.toLocaleString()}
            foot={`${summary.distinctCases.toLocaleString()} distinct ${summary.distinctCases === 1 ? "case" : "cases"}`}
          />
          <SummaryCell label="Pass" value={`${pct(summary.pass)}%`} foot={summary.pass.toLocaleString()} />
          <SummaryCell
            label="Fail"
            value={`${pct(summary.fail)}%`}
            foot={summary.fail.toLocaleString()}
            valueClass="text-signal"
          />
          <div>
            <Eyebrow>Distribution</Eyebrow>
            <div className="mt-2.5">
              <DistBar pass={summary.pass} fail={summary.fail} ambig={summary.ambiguous} />
            </div>
            <div className="mt-2 font-mono text-[11px] tracking-[0.04em] text-ink-3">
              {pct(summary.ambiguous)}% ambiguous · {summary.ambiguous.toLocaleString()}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-5">
        <CardContent className="flex flex-col gap-3 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Eyebrow>Verdict</Eyebrow>
            <Chips
              options={VERDICT_OPTIONS}
              value={verdictFilter}
              onChange={setVerdictFilter}
            />
            <FilterSep />
            <Eyebrow>Source</Eyebrow>
            <Chips options={SOURCE_OPTIONS} value={sourceFilter} onChange={setSourceFilter} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Eyebrow>Skill version</Eyebrow>
            <select
              value={versionFilter}
              onChange={(e) => setVersionFilter(e.target.value)}
              className="h-7 rounded-sm border border-rule-soft bg-card px-2 font-mono text-[11.5px] text-ink-2 cursor-pointer hover:bg-card-2"
            >
              <option value="all">All versions</option>
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <div className="flex-1" />
            <label className="flex h-7 items-center gap-2 rounded-sm border border-rule-soft bg-card px-2 focus-within:border-ink">
              <Search className="size-3 text-ink-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search case id or verdict id…"
                className="w-[260px] max-w-full bg-transparent text-[12px] text-ink placeholder:text-ink-3"
              />
            </label>
          </div>
        </CardContent>
      </Card>

      {loading && verdicts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-ink-3">Fetching verdicts…</CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <div className="text-[13px] text-ink-2">{error}</div>
            <Button variant="default" size="sm" className="mt-3" onClick={() => void load()}>
              <RefreshCcw /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Eyebrow>No matches</Eyebrow>
            <div className="mt-2 font-serif text-[16px] tracking-[-0.012em]">
              Nothing in the verdict log matches these filters.
            </div>
            <div className="mt-2 text-[12px] text-ink-3">
              Loosen a filter, clear the search, or sample randomly.
            </div>
            <Button variant="default" size="sm" className="mt-4" onClick={resetFilters}>
              Reset filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <th style={{ width: 130 }}>When</th>
                <th>Case</th>
                <th style={{ width: 120 }}>Verdict</th>
                <th style={{ width: 72 }} className="text-right">Score</th>
                <th style={{ width: 110 }}>Source</th>
                <th style={{ width: 140 }}>Skill version</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => {
                const verdict = derivedVerdict(v.payload);
                const score = verdictComparableScore(v.payload);
                return (
                  <tr
                    key={v.id}
                    className={cn("row-link", verdict === "fail" && "row-signal")}
                    onClick={() => navigate(`/cases/${v.caseId}`)}
                  >
                    <td className="font-mono text-ink-3">{formatTimestamp(v.createdAt)}</td>
                    <td>
                      <RowLink to={`/cases/${v.caseId}`} className="font-mono text-[12px] text-ink">
                        {v.caseId}
                      </RowLink>
                      <div className="mt-0.5 font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
                        {v.id} · {v.payload.kind}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <VerdictChip verdict={verdict} />
                        {stage === "provisional" && v.source === "llm_judge" ? <ProvChip /> : null}
                      </div>
                    </td>
                    <td className="text-right font-mono tabular-nums text-ink-2">
                      {score.toFixed(2)}
                    </td>
                    <td>
                      <span className="font-mono text-[11px] text-ink-2">
                        {VERDICT_SOURCE_LABEL[v.source]}
                      </span>
                    </td>
                    <td className="font-mono text-[11px] text-ink-3">
                      {v.skillVersionId ?? "—"}
                    </td>
                    <td>
                      <ChevronRight className="size-3 text-ink-3" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div className="flex items-center justify-between border-t border-rule-soft px-[18px] py-3">
            <div className="font-mono text-[11px] text-ink-3">
              Showing {visible.length} of {filtered.length} matching verdict rows ·{" "}
              {visibleCaseCount} distinct {visibleCaseCount === 1 ? "case" : "cases"}
              {sampleSeed != null ? " · random sample" : " · sorted newest first"}
            </div>
            {verdicts.length === FETCH_LIMIT ? (
              <div className="font-mono text-[10.5px] text-ink-3">
                Showing the first {FETCH_LIMIT} verdicts. Tighten filters to see older rows.
              </div>
            ) : null}
          </div>
        </Card>
      )}

      <Card className="mt-6 max-w-[82ch] border-dashed">
        <CardContent className="py-4">
          <Eyebrow>How this ledger works</Eyebrow>
          <div className="mt-2 font-serif text-[14px] leading-[1.55] tracking-[-0.005em] text-ink-2">
            Every recorded verdict remains available here, including cases that were not sent to
            Exceptions. Open any case to inspect the evidence or add a human ruling.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  foot,
  valueClass
}: {
  label: string;
  value: string;
  foot: string;
  valueClass?: string;
}) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          "mt-1 font-serif text-[26px] font-medium leading-[1.05] tracking-[-0.022em] tabular-nums",
          valueClass
        )}
      >
        {value}
      </div>
      <div className="mt-1 font-mono text-[11px] text-ink-3">{foot}</div>
    </div>
  );
}

function Chips<T extends string>({
  options,
  value,
  onChange
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex h-6 items-center rounded-sm border px-2 text-[11.5px] cursor-pointer",
              active
                ? "border-ink bg-ink text-paper"
                : "border-rule-soft bg-transparent text-ink-2 hover:bg-paper-3"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterSep() {
  return <div className="mx-1 h-4 w-px bg-rule-soft" />;
}

// Simple deterministic string hash (FNV-1a 32-bit) used to sort by
// (id + seed) for random-sample shuffles. Pure, no Math.random — stable for
// a given seed so the user can compare two samples or refresh into the same one.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}
