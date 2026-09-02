import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import type {
  AnalysisPopulationSummary,
  AnalysisStudyDetail,
  AnalysisStudyItemEventArtifact,
  AnalysisStudyItemProjection,
  AnalysisStudySummary,
  AnalysisTaxonomyCoverage,
  AnalysisTaxonomyDetail
} from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnalysisMeasurementCard } from "@/components/analysis-measurement-card";
import {
  AnalysisStudyApiError,
  fetchAnalysisStudies,
  fetchAnalysisStudy,
  fetchAnalysisStudyCoverage,
  fetchAnalysisStudyItemContent,
  fetchAnalysisStudyItemEvents,
  fetchAnalysisStudyItems,
  fetchAnalysisTaxonomy,
  type AnalysisStudyItemContent
} from "@/lib/analysis-study-api";
import { AnalysisStudyRequestCoordinator } from "@/lib/analysis-study-request-coordinator";
import {
  analysisStudyUiCapabilities,
  loadAllUsedAnalysisPopulationIds,
  loadExactActiveFailureObservationCount,
  loadHistoryThroughRequiredIds,
  replaceAnalysisStudyItemProjection
} from "@/lib/analysis-study-ui";
import {
  analysisCodingCardKey,
  analyzeJourneyFindingSnapshot,
  buildAnalyzeJourneySteps
} from "@/lib/analyze-journey";
import { CodingCard } from "./analysis-study-workspace/coding.js";
import {
  CoverageCard,
  FailureTypeFindingsCard,
  MemberFindingsCard,
  TaxonomyCard
} from "./analysis-study-workspace/findings.js";
import { AnalyzeJourneyStrip, PromotionCard } from "./analysis-study-workspace/journey.js";
import { CreateStudyCard, StudyAdminCard } from "./analysis-study-workspace/study.js";
import { message } from "./analysis-study-workspace/support.js";

const PAGE_SIZE = 100;

export function AnalysisStudyWorkspace({ populations }: { populations: AnalysisPopulationSummary[] }) {
  const [studies, setStudies] = useState<AnalysisStudySummary[]>([]);
  const [studyCursor, setStudyCursor] = useState<string | null>(null);
  const [unavailableStudyCount, setUnavailableStudyCount] = useState(0);
  const [studyPageLoading, setStudyPageLoading] = useState(false);
  const [projectRole, setProjectRole] = useState<"owner" | "member" | null>(null);
  const [usedPopulationIds, setUsedPopulationIds] = useState<ReadonlySet<string>>(new Set());
  const [usedPopulationIdsReady, setUsedPopulationIdsReady] = useState(false);
  const [usedPopulationIdsUnavailableCount, setUsedPopulationIdsUnavailableCount] = useState(0);
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalysisStudyDetail | null>(null);
  const [items, setItems] = useState<AnalysisStudyItemProjection[]>([]);
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [events, setEvents] = useState<AnalysisStudyItemEventArtifact[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [content, setContent] = useState<AnalysisStudyItemContent | null>(null);
  const [taxonomy, setTaxonomy] = useState<AnalysisTaxonomyDetail | null>(null);
  const [coverage, setCoverage] = useState<AnalysisTaxonomyCoverage | null>(null);
  const [exactActiveFailureObservationCount, setExactActiveFailureObservationCount] = useState<string | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [coverageGeneration, setCoverageGeneration] = useState(0);
  const [findingCountGeneration, setFindingCountGeneration] = useState(0);
  const [reviewAnnouncement, setReviewAnnouncement] = useState("");
  const [criterionCreated, setCriterionCreated] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capabilities = analysisStudyUiCapabilities(projectRole);
  const coordinator = useRef<AnalysisStudyRequestCoordinator | null>(null);
  if (!coordinator.current) coordinator.current = new AnalysisStudyRequestCoordinator();
  const itemsRef = useRef<AnalysisStudyItemProjection[]>([]);
  itemsRef.current = items;
  const itemCursorRef = useRef<string | null>(null);
  itemCursorRef.current = itemCursor;
  const listGeneration = useRef(0);
  const usedPopulationScanGeneration = useRef(0);
  const itemRefreshGeneration = useRef(0);
  const studyPageCursorInFlight = useRef<string | null>(null);
  const reportError = useCallback((cause: unknown) => setError(message(cause)), []);

  const loadList = useCallback(async (scanUsedPopulationIds = true) => {
    const generation = ++listGeneration.current;
    const usedGeneration = scanUsedPopulationIds ? ++usedPopulationScanGeneration.current : null;
    if (usedGeneration !== null) setUsedPopulationIdsReady(false);
    try {
      const [studyPage, taxonomyResult] = await Promise.all([
        fetchAnalysisStudies({ limit: 100 }),
        fetchAnalysisTaxonomy().catch((cause) => {
          if (cause instanceof AnalysisStudyApiError && cause.status === 404) return null;
          throw cause;
        })
      ]);
      if (generation === listGeneration.current) {
        setStudies(studyPage.items);
        setStudyCursor(studyPage.nextCursor);
        setUnavailableStudyCount(studyPage.unavailableDueClosureCount);
        setProjectRole(studyPage.projectRole);
        setTaxonomy(taxonomyResult);
      }
      if (usedGeneration !== null) {
        const usedPopulationResult = await loadAllUsedAnalysisPopulationIds(studyPage, async (cursor) => {
          if (usedGeneration !== usedPopulationScanGeneration.current) {
            return { items: [], nextCursor: null, unavailableDueClosureCount: 0 };
          }
          return fetchAnalysisStudies({ limit: 100, cursor });
        });
        if (usedGeneration === usedPopulationScanGeneration.current) {
          setUsedPopulationIds(usedPopulationResult.populationIds);
          setUsedPopulationIdsUnavailableCount(usedPopulationResult.unavailableDueClosureCount);
          setUsedPopulationIdsReady(true);
        }
      }
    } catch (cause) {
      if (generation === listGeneration.current || usedGeneration === usedPopulationScanGeneration.current) {
        setError(message(cause));
      }
    }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);

  async function selectStudy(studyId: string) {
    const token = coordinator.current!.selectStudy(studyId);
    itemRefreshGeneration.current += 1;
    setSelectedStudyId(studyId);
    setSelectedItemId(null);
    setDetail(null);
    setItems([]);
    itemsRef.current = [];
    setItemCursor(null);
    itemCursorRef.current = null;
    setContent(null);
    setEvents([]);
    setEventCursor(null);
    setCriterionCreated(null);
    setBusy(true);
    setError(null);
    try {
      const [nextDetail, page] = await Promise.all([
        fetchAnalysisStudy(studyId),
        fetchAnalysisStudyItems(studyId, { limit: PAGE_SIZE })
      ]);
      if (!coordinator.current!.isStudyCurrent(token)) return;
      setDetail(nextDetail);
      setItems(page.items);
      itemsRef.current = page.items;
      setItemCursor(page.nextCursor);
      itemCursorRef.current = page.nextCursor;
      const firstReview = page.items.find((item) => item.state !== "completed") ?? page.items[0];
      if (firstReview) await selectItem(firstReview);
    } catch (cause) {
      if (!coordinator.current!.isStudyCurrent(token)) return;
      setError(message(cause));
    } finally {
      if (coordinator.current!.isStudyCurrent(token)) setBusy(false);
    }
  }

  async function refreshSelected() {
    const token = coordinator.current!.currentStudy();
    if (!token) return;
    setBusy(true);
    try {
      const nextDetail = await fetchAnalysisStudy(token.studyId);
      if (coordinator.current!.isStudyCurrent(token)) setDetail(nextDetail);
    } catch (cause) {
      if (coordinator.current!.isStudyCurrent(token)) reportError(cause);
    } finally {
      if (coordinator.current!.isStudyCurrent(token)) setBusy(false);
    }
    await loadList(false);
  }

  async function selectItem(item: AnalysisStudyItemProjection) {
    const token = coordinator.current!.selectItem(item.item.studyId, item.item.id);
    if (!token) return;
    itemRefreshGeneration.current += 1;
    setSelectedItemId(item.item.id);
    setContent(null);
    setEvents([]);
    setEventCursor(null);
    setReviewAnnouncement(`Opening run ${item.item.position + 1}`);
    setError(null);
    try {
      const page = await loadItemHistory(item);
      if (coordinator.current!.isItemCurrent(token)) {
        setEvents(page.items);
        setEventCursor(page.nextCursor);
        setReviewAnnouncement(`Run ${item.item.position + 1} is ready for review`);
      }
    } catch (cause) {
      if (coordinator.current!.isItemCurrent(token)) setError(message(cause));
    }
  }

  async function openFindingItem(studyItemId: string) {
    const studyToken = coordinator.current!.currentStudy();
    if (!studyToken) return;
    let target = itemsRef.current.find((item) => item.item.id === studyItemId) ?? null;
    const seenCursors = new Set<string>();
    while (!target && itemCursorRef.current) {
      const cursor = itemCursorRef.current;
      if (seenCursors.has(cursor)) throw new Error("Analysis item cursor did not advance");
      seenCursors.add(cursor);
      const pageToken = coordinator.current!.beginPage(studyToken.studyId, cursor);
      if (!pageToken) throw new Error("The review queue is already loading. Try the run link again.");
      try {
        const page = await fetchAnalysisStudyItems(studyToken.studyId, { limit: PAGE_SIZE, cursor });
        if (!coordinator.current!.isStudyCurrent(pageToken)) return;
        const known = new Set(itemsRef.current.map((item) => item.item.id));
        const nextRows = [...itemsRef.current, ...page.items.filter((item) => !known.has(item.item.id))];
        itemsRef.current = nextRows;
        itemCursorRef.current = page.nextCursor;
        setItems(nextRows);
        setItemCursor(page.nextCursor);
        target = nextRows.find((item) => item.item.id === studyItemId) ?? null;
      } finally {
        coordinator.current!.finishPage(pageToken, cursor);
      }
    }
    if (!target) throw new Error("The linked reviewed run is not available in this analysis");
    await selectItem(target);
  }

  const selectedItem = items.find((item) => item.item.id === selectedItemId) ?? null;
  const currentState = detail?.summary.study.state ?? null;
  const closed = currentState === "coding_closed" || currentState === "completed";
  const activeFailureTypeCount = taxonomy?.revision.codes.filter((code) => code.status === "active").length ?? 0;
  const findingSnapshot = analyzeJourneyFindingSnapshot({ coverage, exactActiveFailureObservationCount });
  const journeySteps = buildAnalyzeJourneySteps({
    reviewSampleCount: populations.length,
    analysisState: currentState,
    selectedItemCount: detail?.summary.selectedItemCount ?? 0,
    completedItemCount: detail?.summary.completedItemCount ?? 0,
    activeFailureTypeCount,
    ...findingSnapshot,
    canCreateCriterion: capabilities.canAdminister,
    criterionCreated
  });

  useEffect(() => {
    let current = true;
    setExactActiveFailureObservationCount(null);
    if (!selectedStudyId) return () => { current = false; };
    void loadExactActiveFailureObservationCount((cursor) => fetchAnalysisStudyItems(selectedStudyId, {
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {})
    }))
      .then((count) => { if (current) setExactActiveFailureObservationCount(count); })
      .catch((cause) => { if (current) reportError(cause); });
    return () => { current = false; };
  }, [selectedStudyId, findingCountGeneration, reportError]);

  useEffect(() => {
    let current = true;
    setCoverage(null);
    setCoverageError(null);
    if (!selectedStudyId || !taxonomy) return () => { current = false; };
    void fetchAnalysisStudyCoverage(selectedStudyId, taxonomy.revision.revision.id)
      .then((value) => { if (current) setCoverage(value); })
      .catch((cause) => { if (current) setCoverageError(message(cause)); });
    return () => { current = false; };
  }, [selectedStudyId, taxonomy?.revision.revision.id, coverageGeneration]);

  useEffect(() => {
    setCriterionCreated(null);
  }, [selectedStudyId, taxonomy?.revision.revision.id]);

  useEffect(() => {
    if (selectedStudyId || studies.length === 0) return;
    void selectStudy(studies[0]!.study.study.id);
  }, [selectedStudyId, studies]);

  return (
    <div className="mb-6 space-y-5">
      <div className="sr-only" role="status" aria-live="polite">{reviewAnnouncement}</div>
      <AnalyzeJourneyStrip steps={journeySteps} />
      <div className="grid gap-5 xl:grid-cols-[340px_1fr]">
        <div className="space-y-5">
          {capabilities.canAdminister ? <CreateStudyCard populations={populations}
            usedPopulationIds={usedPopulationIds}
            usedPopulationIdsReady={usedPopulationIdsReady}
            usedPopulationIdsUnavailableCount={usedPopulationIdsUnavailableCount}
            onCreated={(studyId) => {
            void loadList();
            void selectStudy(studyId);
          }} /> : <Card><CardContent className="py-4 text-[11px] text-ink-3">You can review runs and organize observations. A project owner starts or finishes an analysis and changes the failure-type list.</CardContent></Card>}
          <Card>
            <CardHeader className="justify-between">
              <div>
                <CardTitle>Your analyses</CardTitle>
                <p className="mt-1 text-[10.5px] text-ink-3">Resume the most recent review or inspect an earlier receipt.</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void loadList()} aria-label="Refresh analyses"><RefreshCcw /></Button>
            </CardHeader>
            {unavailableStudyCount > 0 ? <div role="status" className="border-t border-rule-soft bg-signal-wash px-[18px] py-3 text-[11px] text-signal">
              {unavailableStudyCount} analysis {unavailableStudyCount === 1 ? "is" : "are"} temporarily unavailable while durable deadline closure retries.
            </div> : null}
            {studies.length === 0 ? (
              <CardContent className="py-8 text-center text-[12px] text-ink-3">
                {studyCursor || unavailableStudyCount > 0 ? "No analysis is available on this page." : "Create a review sample above, then start its analysis here."}
              </CardContent>
            ) : (
              <div className="divide-y divide-rule-soft">
                {studies.map((row) => (
                  <button key={row.study.study.id} type="button" onClick={() => void selectStudy(row.study.study.id)}
                    className={`w-full px-[18px] py-4 text-left hover:bg-card-2 ${selectedStudyId === row.study.study.id ? "bg-card-2" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-serif text-[14px]">{analysisStateLabel(row.study.state)}</span>
                      <span className="font-mono text-[10px] text-ink-4">{row.completedItemCount}/{row.selectedItemCount} reviewed</span>
                    </div>
                    <div className="mt-1 text-[10.5px] text-ink-3">Created {new Date(row.study.study.createdAt).toLocaleDateString()}</div>
                    <ClaimLine row={row} />
                  </button>
                ))}
              </div>
            )}
            {studyCursor ? <div className="border-t border-rule-soft p-3"><Button variant="ghost" size="sm" disabled={studyPageLoading} onClick={async () => {
              const cursor = studyCursor;
              if (studyPageCursorInFlight.current === cursor) return;
              studyPageCursorInFlight.current = cursor;
              const generation = listGeneration.current;
              setStudyPageLoading(true);
              try {
                const page = await fetchAnalysisStudies({ limit: 100, cursor });
                if (generation !== listGeneration.current || cursor !== studyCursor) return;
                setStudies((rows) => [...rows, ...page.items]);
                setStudyCursor(page.nextCursor);
                setUnavailableStudyCount((count) => count + page.unavailableDueClosureCount);
                setProjectRole(page.projectRole);
              } catch (cause) {
                if (generation === listGeneration.current) reportError(cause);
              } finally {
                if (studyPageCursorInFlight.current === cursor) studyPageCursorInFlight.current = null;
                if (generation === listGeneration.current) setStudyPageLoading(false);
              }
            }}>Load more analyses</Button></div> : null}
          </Card>
        </div>

        <div className="space-y-5">
          {error ? <div role="alert" className="rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">{error}</div> : null}
          {!detail ? (
            <Card><CardContent className="py-12 text-center text-[12px] text-ink-3">Create or choose an analysis to begin reviewing its sample.</CardContent></Card>
          ) : (
            <>
              {capabilities.canAdminister ? <StudyAdminCard detail={detail} busy={busy} onChanged={() => void refreshSelected()} onError={reportError} /> : null}
              {selectedItem ? (
                <CodingCard
                key={analysisCodingCardKey(selectedItem)}
                item={selectedItem}
                events={events}
                eventCursor={eventCursor}
                content={content}
                taxonomy={taxonomy}
                codingOpen={currentState === "coding_open"}
                totalItems={detail.summary.selectedItemCount}
                onView={async () => {
                  const token = coordinator.current!.beginContent(selectedItem.item.studyId, selectedItem.item.id);
                  if (!token) return;
                  try {
                    const next = await fetchAnalysisStudyItemContent(selectedItem.item.studyId, selectedItem.item.id);
                    if (coordinator.current!.isContentCurrent(token)) setContent(next);
                  } catch (cause) {
                    if (coordinator.current!.isContentCurrent(token)) reportError(cause);
                  }
                }}
                onChanged={async (nextItem) => {
                  const token = coordinator.current!.currentItem();
                  if (!token || token.studyItemId !== nextItem.item.id) return;
                  const refreshGeneration = ++itemRefreshGeneration.current;
                  const refreshIsCurrent = () => coordinator.current!.isItemCurrent(token) &&
                    itemRefreshGeneration.current === refreshGeneration;
                  const nextRows = replaceAnalysisStudyItemProjection(itemsRef.current, nextItem);
                  setItems(nextRows);
                  itemsRef.current = nextRows;
                  setCoverageGeneration((value) => value + 1);
                  setFindingCountGeneration((value) => value + 1);
                  const [nextDetail, page] = await Promise.all([
                    fetchAnalysisStudy(token.studyId),
                    loadItemHistory(nextItem)
                  ]);
                  if (!refreshIsCurrent()) return;
                  setDetail(nextDetail);
                  setEvents(page.items);
                  setEventCursor(page.nextCursor);
                  await loadList(false);
                  if (!refreshIsCurrent()) return;
                  if (nextItem.state === "completed") {
                    const currentIndex = nextRows.findIndex((row) => row.item.id === nextItem.item.id);
                    const ordered = [...nextRows.slice(currentIndex + 1), ...nextRows.slice(0, currentIndex)];
                    const nextReview = ordered.find((row) => row.state !== "completed");
                    if (nextReview) await selectItem(nextReview);
                  }
                }}
                onMoreEvents={async () => {
                  if (!eventCursor) return;
                  const token = coordinator.current!.currentItem();
                  if (!token) return;
                  try {
                    const page = await fetchAnalysisStudyItemEvents(token.studyId, token.studyItemId, {
                      limit: 100,
                      cursor: eventCursor
                    });
                    if (!coordinator.current!.isItemCurrent(token)) return;
                    setEvents((rows) => [...rows, ...page.items]);
                    setEventCursor(page.nextCursor);
                  } catch (cause) {
                    if (coordinator.current!.isItemCurrent(token)) reportError(cause);
                  }
                }}
                onAssignmentChanged={() => setCoverageGeneration((value) => value + 1)}
                onError={(cause) => {
                  const current = coordinator.current!.currentItem();
                  if (current?.studyId === selectedItem.item.studyId && current.studyItemId === selectedItem.item.id) {
                    reportError(cause);
                  }
                }}
              />
              ) : null}

              <details className="rounded-sm border border-rule-soft bg-paper-2">
                <summary className="cursor-pointer px-[18px] py-4 text-[12px] font-medium text-ink">
                  Review queue · {detail.summary.completedItemCount}/{detail.summary.selectedItemCount} complete
                  <span className="ml-2 font-normal text-ink-3">metadata only until View</span>
                </summary>
                <div className="divide-y divide-rule-soft border-t border-rule-soft">
                  {items.map((item) => (
                    <button key={item.item.id} type="button" onClick={() => void selectItem(item)}
                      className={`flex w-full items-center justify-between gap-4 px-[18px] py-3 text-left hover:bg-card-2 ${selectedItemId === item.item.id ? "bg-card-2" : ""}`}>
                      <span className="font-mono text-[11px]">Run {item.item.position + 1}</span>
                      <span className="flex-1 text-[12px] text-ink-3">{reviewStateLabel(item.state)}</span>
                      <span className="font-mono text-[10px] text-ink-4">{item.activeFailureObservationEventIds.length} observation{item.activeFailureObservationEventIds.length === 1 ? "" : "s"}</span>
                    </button>
                  ))}
                  {itemCursor ? <div className="p-3"><Button variant="ghost" size="sm" onClick={async () => {
                    if (!selectedStudyId || !itemCursor) return;
                    const cursor = itemCursor;
                    const token = coordinator.current!.beginPage(selectedStudyId, cursor);
                    if (!token) return;
                    try {
                      const page = await fetchAnalysisStudyItems(selectedStudyId, { limit: PAGE_SIZE, cursor });
                      if (!coordinator.current!.isStudyCurrent(token)) return;
                      setItems((rows) => {
                        const nextRows = [...rows, ...page.items];
                        itemsRef.current = nextRows;
                        return nextRows;
                      });
                      setItemCursor(page.nextCursor);
                      itemCursorRef.current = page.nextCursor;
                    } catch (cause) {
                      if (coordinator.current!.isStudyCurrent(token)) reportError(cause);
                    } finally {
                      coordinator.current!.finishPage(token, cursor);
                    }
                  }}>Load more runs</Button></div> : null}
                </div>
              </details>

              <TaxonomyCard taxonomy={taxonomy} editable={capabilities.canAdminister} onChanged={() => void loadList()} />
              {taxonomy && selectedStudyId ? <CoverageCard coverage={coverage} error={coverageError} /> : null}
              {taxonomy && selectedStudyId && closed && capabilities.canAdminister ? <FailureTypeFindingsCard
                studyId={selectedStudyId}
                taxonomy={taxonomy}
                onOpenItem={(studyItemId) => void openFindingItem(studyItemId).catch(reportError)}
              /> : taxonomy && selectedStudyId && closed ? <MemberFindingsCard /> : null}

              <details className="rounded-sm border border-rule-soft bg-paper-2">
                <summary className="cursor-pointer px-[18px] py-4 text-[12px] font-medium text-ink">Technical workflow measurements</summary>
                <div className="border-t border-rule-soft p-4">
                  <AnalysisMeasurementCard
                    key={`${detail.summary.study.study.id}:${taxonomy?.revision.revision.id ?? "no-taxonomy"}:${coverageGeneration}`}
                    studyId={detail.summary.study.study.id}
                    taxonomyRevisionId={taxonomy?.revision.revision.id ?? null}
                  />
                </div>
              </details>

              {taxonomy && capabilities.canAdminister && closed ? (
                <PromotionCard key={`${detail.summary.study.study.id}:${taxonomy.revision.revision.id}`}
                  detail={detail} taxonomy={taxonomy} onError={reportError}
                  onPromotionStateChange={setCriterionCreated} />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function loadItemHistory(item: AnalysisStudyItemProjection) {
  return loadHistoryThroughRequiredIds(item.activeFailureObservationEventIds, (cursor) =>
    fetchAnalysisStudyItemEvents(item.item.studyId, item.item.id, { limit: 100, cursor })
  );
}
function ClaimLine({ row }: { row: AnalysisStudySummary }) {
  if (!row.closure) return <div className="mt-1 text-[11px] text-ink-3">Exact sample saved · review not finished</div>;
  return row.closure.representativeOfPopulationId ?
    <div className="mt-1 text-[11px] text-mint">Complete for this exact frozen set only</div> :
    <div className="mt-1 text-[11px] text-ink-3">Scope saved · {representativeReasonLabel(row.closure.representativeReason)}</div>;
}
function analysisStateLabel(value: string): string {
  if (value === "draft") return "Ready to start";
  if (value === "coding_open") return "Review in progress";
  if (value === "coding_closed") return "Review finished";
  if (value === "completed") return "Analysis recorded";
  return "Stopped";
}
function reviewStateLabel(value: string): string {
  if (value === "uncoded") return "Not reviewed";
  if (value === "in_progress") return "In progress";
  return "Complete";
}
function representativeReasonLabel(value: string | null | undefined): string {
  if (value === "coding_not_complete") return "some sampled runs were not completed";
  if (value === "draw_not_complete") return "the server sample did not complete";
  if (value === "frame_not_reproducible") return "the eligible set could not be reproduced";
  if (value === "method_not_eligible") return "the sampling method cannot support the finite-set claim";
  return "the exact finite-set claim is unavailable";
}
