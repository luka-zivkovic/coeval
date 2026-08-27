import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Database, Eye, RefreshCcw, Snowflake } from "lucide-react";
import type {
  AnalysisPopulationDetail,
  AnalysisPopulationExclusion,
  AnalysisPopulationMember,
  AnalysisPopulationOverlapSummary,
  AnalysisPopulationSummary,
  AnalysisPopulationDrawSelection
} from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SectionHead } from "@/components/coeval";
import {
  createAnalysisPopulation,
  fetchAnalysisPopulation,
  fetchAnalysisPopulationExclusions,
  fetchAnalysisPopulationMembers,
  fetchAnalysisPopulationOverlaps,
  fetchAnalysisPopulations,
  fetchAnalysisPopulationSelectedContent,
  fetchAnalysisPopulationSelections,
  type AnalysisPopulationSelectedContent
} from "@/lib/analysis-population-api";
import { AnalysisPopulationRequestCoordinator } from "@/lib/analysis-population-request-coordinator";
import { AnalysisStudyWorkspace } from "@/screens/analysis-study-workspace";
import { DatabaseModeRequired } from "@/components/database-mode-required";
import { useAppMode } from "@/lib/app-mode";
import { defaultAnalysisWindowEnd } from "@/lib/analyze-journey";

const PAGE_SIZE = 100;

export function AnalyzeScreen() {
  const { demoMode } = useAppMode();

  if (demoMode) {
    return (
      <DatabaseModeRequired
        eyebrow="Analysis authoring · demo mode"
        title="Governed analysis needs a persistent workspace."
        description="Reproducible review samples, human-authored observations, and their append-only history must remain durable and attributable."
        demoAlternative="Use Live traces to explore the seeded examples. They are a preview, not a reproducible analysis sample."
      />
    );
  }

  return <PersistentAnalyzeScreen />;
}

function PersistentAnalyzeScreen() {
  const [populations, setPopulations] = useState<AnalysisPopulationSummary[]>([]);
  const [populationCursor, setPopulationCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalysisPopulationDetail | null>(null);
  const [members, setMembers] = useState<AnalysisPopulationMember[]>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [selections, setSelections] = useState<AnalysisPopulationDrawSelection[]>([]);
  const [selectionCursor, setSelectionCursor] = useState<string | null>(null);
  const [exclusions, setExclusions] = useState<AnalysisPopulationExclusion[]>([]);
  const [exclusionCursor, setExclusionCursor] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<AnalysisPopulationOverlapSummary[]>([]);
  const [overlapCursor, setOverlapCursor] = useState<string | null>(null);
  const [content, setContent] = useState<AnalysisPopulationSelectedContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [contentLoadingPosition, setContentLoadingPosition] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestCoordinatorRef = useRef<AnalysisPopulationRequestCoordinator | null>(null);
  if (!requestCoordinatorRef.current) requestCoordinatorRef.current = new AnalysisPopulationRequestCoordinator();
  const populationListGenerationRef = useRef(0);
  const populationPageLoadsRef = useRef(new Set<string>());

  const loadPopulations = useCallback(async () => {
    const generation = populationListGenerationRef.current + 1;
    populationListGenerationRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchAnalysisPopulations({ limit: 50 });
      if (populationListGenerationRef.current !== generation) return;
      setPopulations(page.items);
      setPopulationCursor(page.nextCursor);
    } catch (cause) {
      if (populationListGenerationRef.current === generation) setError(message(cause));
    } finally {
      if (populationListGenerationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPopulations();
  }, [loadPopulations]);

  async function openPopulation(populationId: string) {
    const token = requestCoordinatorRef.current!.selectPopulation(populationId);
    setSelectedId(populationId);
    setDetailLoading(true);
    setContent(null);
    setContentLoadingPosition(null);
    setError(null);
    try {
      const [nextDetail, memberPage, selectionPage, exclusionPage, overlapPage] = await Promise.all([
        fetchAnalysisPopulation(populationId),
        fetchAnalysisPopulationMembers(populationId, { limit: PAGE_SIZE }),
        fetchAnalysisPopulationSelections(populationId, { limit: PAGE_SIZE }),
        fetchAnalysisPopulationExclusions(populationId, { limit: PAGE_SIZE }),
        fetchAnalysisPopulationOverlaps(populationId, { limit: PAGE_SIZE })
      ]);
      if (!requestCoordinatorRef.current!.isPopulationCurrent(token)) return;
      setDetail(nextDetail);
      setMembers(memberPage.items);
      setMemberCursor(memberPage.nextCursor);
      setSelections(selectionPage.items);
      setSelectionCursor(selectionPage.nextCursor);
      setExclusions(exclusionPage.items);
      setExclusionCursor(exclusionPage.nextCursor);
      setOverlaps(overlapPage.items);
      setOverlapCursor(overlapPage.nextCursor);
    } catch (cause) {
      if (!requestCoordinatorRef.current!.isPopulationCurrent(token)) return;
      setDetail(null);
      setError(message(cause));
    } finally {
      if (requestCoordinatorRef.current!.isPopulationCurrent(token)) {
        setDetailLoading(false);
      }
    }
  }

  async function viewContent(populationId: string, position: number) {
    const token = requestCoordinatorRef.current!.beginContent(populationId);
    if (!token) return;
    setContentLoadingPosition(position);
    setError(null);
    try {
      const nextContent = await fetchAnalysisPopulationSelectedContent(populationId, position);
      if (requestCoordinatorRef.current!.isContentCurrent(token)) {
        setContent(nextContent);
      }
    } catch (cause) {
      if (requestCoordinatorRef.current!.isContentCurrent(token)) {
        setError(message(cause));
      }
    } finally {
      if (requestCoordinatorRef.current!.isContentCurrent(token)) {
        setContentLoadingPosition(null);
      }
    }
  }

  async function loadNextPage<T>(
    kind: string,
    cursor: string | null,
    loader: (populationId: string, input: { limit: number; cursor: string }) => Promise<{ items: T[]; nextCursor: string | null }>,
    setRows: Dispatch<SetStateAction<T[]>>,
    setCursor: Dispatch<SetStateAction<string | null>>
  ) {
    if (!cursor) return;
    const token = requestCoordinatorRef.current!.beginPage(kind, cursor);
    if (!token) return;
    try {
      const page = await loader(token.populationId, { limit: PAGE_SIZE, cursor });
      if (!requestCoordinatorRef.current!.isPopulationCurrent(token)) return;
      setRows((rows) => [...rows, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (requestCoordinatorRef.current!.isPopulationCurrent(token)) {
        setError(message(cause));
      }
    } finally {
      requestCoordinatorRef.current!.finishPage(token);
    }
  }

  async function loadMorePopulations(cursor: string) {
    const generation = populationListGenerationRef.current;
    const key = `populations:${cursor}`;
    if (populationPageLoadsRef.current.has(key)) return;
    populationPageLoadsRef.current.add(key);
    try {
      const page = await fetchAnalysisPopulations({ limit: 50, cursor });
      if (populationListGenerationRef.current !== generation) return;
      setPopulations((current) => [...current, ...page.items]);
      setPopulationCursor(page.nextCursor);
    } catch (cause) {
      if (populationListGenerationRef.current === generation) setError(message(cause));
    } finally {
      populationPageLoadsRef.current.delete(key);
    }
  }

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Analyze · failure discovery · human-authored"
        title="Analyze why runs fail"
        sub="Review a reproducible sample, describe what went wrong in your own words, organize those observations into failure types you name, and turn one important type into a criterion."
        right={
          <Button variant="ghost" size="sm" onClick={() => void loadPopulations()} disabled={loading}>
            <RefreshCcw /> Refresh
          </Button>
        }
      />

      {error ? <div role="alert" className="mb-5 rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">{error}</div> : null}

      <FreezePopulationForm onCreated={(populationId) => {
        void loadPopulations();
        void openPopulation(populationId);
      }} />

      <AnalysisStudyWorkspace populations={populations} />

      <details className="mb-6 rounded-sm border border-rule-soft bg-paper-2">
        <summary className="cursor-pointer px-[18px] py-4 text-[12px] font-medium text-ink">
          Technical evidence and sample history
          <span className="ml-2 font-normal text-ink-3">IDs, digests, exclusions, overlap, and frozen payload access</span>
        </summary>
        <div className="grid gap-5 border-t border-rule-soft p-4 xl:grid-cols-[360px_1fr]">
          <Card>
            <CardHeader className="justify-between">
              <CardTitle>Saved review samples</CardTitle>
              <span className="font-mono text-[10px] text-ink-4">metadata only</span>
            </CardHeader>
            {populations.length === 0 ? (
              <CardContent className="py-8 text-center text-[12px] text-ink-3">
                {loading ? "Loading samples…" : "No review sample has been created."}
              </CardContent>
            ) : (
              <div className="divide-y divide-rule-soft">
                {populations.map((row) => (
                  <button
                    type="button"
                    key={row.population.id}
                    onClick={() => void openPopulation(row.population.id)}
                    className={`w-full px-[18px] py-4 text-left hover:bg-card-2 ${selectedId === row.population.id ? "bg-card-2" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-serif text-[14px] font-medium">{formatWindow(row.population.windowStart, row.population.windowEnd)}</span>
                      <span className="font-mono text-[10px] text-ink-4">{row.draw.fixedBudget} of {row.population.populationSize}</span>
                    </div>
                    <div className="mt-2 break-all font-mono text-[9px] text-ink-4">{row.population.id}</div>
                    <div className="mt-1 text-[11px] text-ink-3">Frozen eligible frame and server-chosen review sample</div>
                  </button>
                ))}
                {populationCursor ? <LoadMoreButton onClick={() => void loadMorePopulations(populationCursor)} /> : null}
              </div>
            )}
          </Card>

          <div>
            {detailLoading ? (
              <Card><CardContent className="py-12 text-center text-[12px] text-ink-3">Loading technical evidence…</CardContent></Card>
            ) : detail ? (
              <PopulationDetail
                detail={detail}
                members={members}
                selections={selections}
                exclusions={exclusions}
                overlaps={overlaps}
                memberCursor={memberCursor}
                selectionCursor={selectionCursor}
                exclusionCursor={exclusionCursor}
                overlapCursor={overlapCursor}
                content={content}
                contentLoadingPosition={contentLoadingPosition}
                onViewContent={(position) => void viewContent(detail.population.id, position)}
                onMoreMembers={() => void loadNextPage("members", memberCursor, fetchAnalysisPopulationMembers, setMembers, setMemberCursor)}
                onMoreSelections={() => void loadNextPage("selections", selectionCursor, fetchAnalysisPopulationSelections, setSelections, setSelectionCursor)}
                onMoreExclusions={() => void loadNextPage("exclusions", exclusionCursor, fetchAnalysisPopulationExclusions, setExclusions, setExclusionCursor)}
                onMoreOverlaps={() => void loadNextPage("overlaps", overlapCursor, fetchAnalysisPopulationOverlaps, setOverlaps, setOverlapCursor)}
              />
            ) : (
              <Card><CardContent className="py-12 text-center text-[12px] text-ink-3">Choose a saved sample to inspect its technical evidence.</CardContent></Card>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

function FreezePopulationForm({ onCreated }: { onCreated: (populationId: string) => void }) {
  const [latestWindowEnd] = useState(() => localDateTimeInput(defaultAnalysisWindowEnd()));
  const [windowStart, setWindowStart] = useState(() => localDateTimeInput(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [windowEnd, setWindowEnd] = useState(latestWindowEnd);
  const [fixedBudget, setFixedBudget] = useState("20");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="mb-5">
      <CardHeader className="justify-between">
        <div>
          <CardTitle>1. Choose runs to review</CardTitle>
          <p className="mt-1 max-w-[72ch] text-[11px] leading-5 text-ink-3">Pick a recent window and how many runs you can review. Coeval chooses the rows reproducibly and keeps the exact scope.</p>
        </div>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 xl:grid-cols-[1fr_1fr_150px_auto]" onSubmit={async (event) => {
          event.preventDefault();
          setSubmitting(true);
          setError(null);
          try {
            const created = await createAnalysisPopulation({
              windowStart: new Date(windowStart).toISOString(),
              windowEnd: new Date(windowEnd).toISOString(),
              fixedBudget: Number(fixedBudget),
              idempotencyKey: analysisKey("sample")
            });
            onCreated(created.population.id);
          } catch (cause) {
            setError(message(cause));
          } finally {
            setSubmitting(false);
          }
        }}>
          <Field label="From · local time"><Input required type="datetime-local" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} /></Field>
          <Field label="Until · local time"><Input required type="datetime-local" max={latestWindowEnd} value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} /></Field>
          <Field label="Sample size"><Input required min={1} max={10000} type="number" value={fixedBudget} onChange={(event) => setFixedBudget(event.target.value)} /></Field>
          <div className="flex items-end"><Button type="submit" variant="primary" disabled={submitting || !windowStart || !windowEnd || Number(fixedBudget) < 1}><Snowflake /> {submitting ? "Creating sample…" : "Create review sample"}</Button></div>
        </form>
        <p className="mt-3 text-[11px] text-ink-3">The end time keeps a one-minute ingestion buffer. This sample supports failure discovery for the exact eligible runs in the window; it is not sealed validation or a production-wide failure-rate estimate.</p>
        {error ? <p role="alert" className="mt-2 text-[11px] text-signal">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

export function PopulationDetail(props: {
  detail: AnalysisPopulationDetail;
  members: AnalysisPopulationMember[];
  selections: AnalysisPopulationDrawSelection[];
  exclusions: AnalysisPopulationExclusion[];
  overlaps: AnalysisPopulationOverlapSummary[];
  memberCursor: string | null;
  selectionCursor: string | null;
  exclusionCursor: string | null;
  overlapCursor: string | null;
  content: AnalysisPopulationSelectedContent | null;
  contentLoadingPosition: number | null;
  onViewContent: (position: number) => void;
  onMoreMembers: () => void;
  onMoreSelections: () => void;
  onMoreExclusions: () => void;
  onMoreOverlaps: () => void;
}) {
  const { population, draw } = props.detail;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="justify-between"><CardTitle>Frozen frame</CardTitle><Database className="size-4 text-ink-4" /></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Evidence label="population" value={population.id} />
            <Evidence label="dataset revision" value={population.datasetRevisionId} />
            <Evidence label="frame N / draw K" value={`${population.populationSize} / ${draw.fixedBudget}`} />
            <Evidence label="exclusions" value={population.exclusionCount} />
            <Evidence label="method" value={`${draw.method} · ${draw.rngVersion}`} />
            <Evidence label="inclusion" value={`${draw.inclusionProbability.numerator}/${draw.inclusionProbability.denominator}`} />
            <Evidence label="frame digest" value={population.frameDigest} />
            <Evidence label="draw digest" value={draw.drawDigest} />
            <Evidence label="snapshot" value={population.snapshotTakenAt} />
          </div>
          <div className="mt-4 rounded-sm border border-gold-tint bg-ambig-bg px-3 py-2 text-[11px] text-gold">
            This draw artifact alone does not establish completed review or an exact finite-set claim. Inspect the linked analysis closure for current review coverage.
          </div>
        </CardContent>
      </Card>

      <EvidenceTable title="Draw selections" note="Payload remains unopened until View frozen payload is clicked." rows={props.selections.map((row) => ({
        key: row.id,
        cells: [`#${row.position}`, row.caseId, shortDigest(row.rankDigest)],
        action: <Button variant="ghost" size="sm" onClick={() => props.onViewContent(row.position)} disabled={props.contentLoadingPosition === row.position}><Eye /> {props.contentLoadingPosition === row.position ? "Opening…" : "View frozen payload"}</Button>
      }))} more={props.selectionCursor ? props.onMoreSelections : null} />

      {props.content ? (
        <Card>
          <CardHeader className="justify-between"><CardTitle>Explicitly opened frozen payload · draw #{props.content.drawPosition}</CardTitle><span className="font-mono text-[9px] text-ink-4">development exposure recorded</span></CardHeader>
          <CardContent><pre className="max-h-[420px] overflow-auto rounded-sm bg-ink p-4 text-[11px] text-paper">{JSON.stringify(props.content.payloadSnapshot, null, 2)}</pre></CardContent>
        </Card>
      ) : null}

      <EvidenceTable title="Eligible frame members" note="Identity and lineage only; no payload is fetched." rows={props.members.map((row) => ({ key: row.id, cells: [`#${row.position}`, row.caseId, shortDigest(row.lineageDigest)] }))} more={props.memberCursor ? props.onMoreMembers : null} />
      <EvidenceTable title="Explicit exclusions" note="Excluded cases are retained as audit evidence, separately from eligible frame N." rows={props.exclusions.map((row) => ({ key: row.id, cells: [`#${row.position}`, row.caseId, row.ingestionPurpose] }))} more={props.exclusionCursor ? props.onMoreExclusions : null} />
      <EvidenceTable title="Overlapping frozen populations" note={`${props.detail.overlapCount} other population(s) share at least one case identity.`} rows={props.overlaps.map((row) => ({ key: row.populationId, cells: [row.populationId, `${row.overlapCount} shared`, shortDigest(row.frameDigest)] }))} more={props.overlapCursor ? props.onMoreOverlaps : null} />
    </div>
  );
}

function EvidenceTable({ title, note, rows, more }: { title: string; note: string; rows: Array<{ key: string; cells: string[]; action?: ReactNode }>; more: (() => void) | null }) {
  return <Card><CardHeader className="justify-between"><div><CardTitle>{title}</CardTitle><p className="mt-1 text-[10px] text-ink-4">{note}</p></div></CardHeader><div className="divide-y divide-rule-soft">{rows.length === 0 ? <div className="px-[18px] py-5 text-[12px] text-ink-3">No rows in this page.</div> : rows.map((row) => <div key={row.key} className="flex flex-wrap items-center justify-between gap-3 px-[18px] py-3"><div className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-ink-3">{row.cells.map((cell, index) => <span key={`${row.key}-${index}`} className="break-all">{cell}</span>)}</div>{row.action}</div>)}{more ? <LoadMoreButton onClick={more} /> : null}</div></Card>;
}

function LoadMoreButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="w-full border-t border-rule-soft px-[18px] py-3 text-left text-[11px] text-ink-3 hover:bg-card-2">Load next immutable page</button>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block font-mono text-[9px] uppercase tracking-[0.08em] text-ink-4">{label}</span>{children}</label>;
}

function Evidence({ label, value }: { label: string; value: string }) {
  return <div><div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-4">{label}</div><div className="mt-1 break-all font-mono text-[10px] text-ink-2">{value}</div></div>;
}

function formatWindow(start: string, end: string): string {
  return `${start.slice(0, 16).replace("T", " ")} UTC → ${end.slice(0, 16).replace("T", " ")} UTC`;
}
function shortDigest(value: string): string { return value.length > 24 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value; }
function localDateTimeInput(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
function analysisKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
