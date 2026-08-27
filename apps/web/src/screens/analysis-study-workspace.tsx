import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, Eye, LockKeyhole, Plus, RefreshCcw, X } from "lucide-react";
import type {
  AnalysisCriterionPromotionCandidate,
  AnalysisCriterionPromotionCreateResult,
  AnalysisCriterionPromotionSummary,
  AnalysisPopulationSummary,
  AnalysisObservationAssignmentEventInput,
  AnalysisObservationAssignmentEventArtifact,
  AnalysisStudyDetail,
  AnalysisStudyItemEventArtifact,
  AnalysisStudyItemProjection,
  AnalysisStudySummary,
  AnalysisTaxonomyDetail,
  AnalysisTaxonomyCoverage,
  AnalysisTaxonomyRevisionCodeInput
} from "@coeval/shared";
import { ANALYSIS_MAX_PROMOTION_SUPPORTS } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AnalysisMeasurementCard } from "@/components/analysis-measurement-card";
import {
  AnalysisStudyApiError,
  abandonAnalysisStudy,
  appendAnalysisObservationAssignment,
  appendAnalysisStudyItemEvent,
  closeAnalysisStudy,
  completeAnalysisStudy,
  createAnalysisStudy,
  createAnalysisTaxonomy,
  createAnalysisTaxonomyRevision,
  fetchAnalysisStudies,
  fetchAnalysisObservationAssignments,
  fetchAnalysisStudy,
  fetchAnalysisStudyCoverage,
  fetchAnalysisStudyItemContent,
  fetchAnalysisStudyItemEvents,
  fetchAnalysisStudyItems,
  fetchAnalysisTaxonomy,
  openAnalysisStudy,
  type AnalysisStudyItemContent
} from "@/lib/analysis-study-api";
import { AnalysisStudyRequestCoordinator } from "@/lib/analysis-study-request-coordinator";
import { AnalysisMutationCoordinator } from "@/lib/analysis-mutation-coordinator";
import {
  analysisStudyUiCapabilities,
  loadAllUsedAnalysisPopulationIds,
  loadExactActiveFailureObservationCount,
  loadHistoryThroughRequiredIds,
  replaceAnalysisStudyItemProjection
} from "@/lib/analysis-study-ui";
import {
  createAnalysisPromotion,
  fetchAnalysisPromotionCandidates,
  fetchAnalysisPromotions
} from "@/lib/analysis-promotion-api";
import {
  analysisMutationFailureKind,
  analysisPromotionContextMatches,
  analysisPromotionHandoffInstructionHref
} from "@/lib/analysis-promotion-ui";
import {
  analysisCodingCardKey,
  analyzeJourneyFindingSnapshot,
  buildAnalyzeJourneySteps,
  type AnalyzeJourneyStatus
} from "@/lib/analyze-journey";

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

function AnalyzeJourneyStrip({ steps }: { steps: readonly { status: AnalyzeJourneyStatus; detail: string }[] }) {
  const labels = [
    "Choose runs",
    "Review runs",
    "Organize findings",
    "Create a criterion"
  ] as const;
  return <section aria-label="Analyze progress" className="rounded-sm border border-rule-soft bg-paper-2 p-3">
    <div className="grid gap-2 sm:grid-cols-4">
      {steps.map((step, index) => <div key={labels[index]}
        aria-current={step.status === "current" ? "step" : undefined}
        className={`rounded-sm border px-3 py-2 ${journeyStepClass(step.status)}`}>
        <div className="flex items-center gap-2 text-[11.5px] font-medium">
          <span className="grid size-5 place-items-center rounded-full border border-rule-strong font-mono text-[10px]">{step.status === "complete" ? <Check className="size-3" /> : index + 1}</span>
          {labels[index]}
        </div>
        <div className="mt-1 pl-7 text-[10.5px] text-ink-3">{step.detail}</div>
      </div>)}
    </div>
  </section>;
}

function journeyStepClass(status: AnalyzeJourneyStatus): string {
  if (status === "current") return "border-ink bg-card-2";
  if (status === "complete") return "border-rule-soft bg-paper-3";
  if (status === "incomplete") return "border-gold-tint bg-ambig-bg";
  if (status === "available") return "border-rule-soft";
  return "border-transparent opacity-70";
}

function PromotionCard({ detail, taxonomy, onError, onPromotionStateChange }: {
  detail: AnalysisStudyDetail;
  taxonomy: AnalysisTaxonomyDetail;
  onError: (cause: unknown) => void;
  onPromotionStateChange: (created: boolean | null) => void;
}) {
  const study = detail.summary.study;
  const activeCodes = taxonomy.revision.codes.filter((code) => code.status === "active");
  const [codeId, setCodeId] = useState("");
  const [candidates, setCandidates] = useState<AnalysisCriterionPromotionCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [criterionName, setCriterionName] = useState("");
  const [criterionDefinition, setCriterionDefinition] = useState("");
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(false);
  const [promotionsByCode, setPromotionsByCode] = useState<Map<string, AnalysisCriterionPromotionCreateResult | AnalysisCriterionPromotionSummary>>(new Map());
  const currentContext = useRef({ studyId: study.study.id, taxonomyRevisionId: taxonomy.revision.revision.id, codeId });
  currentContext.current = { studyId: study.study.id, taxonomyRevisionId: taxonomy.revision.revision.id, codeId };
  const mutation = useIdempotentAction();
  const selectedCode = activeCodes.find((code) => code.codeId === codeId) ?? null;
  const receipt = codeId ? promotionsByCode.get(codeId) ?? null : null;

  useEffect(() => {
    setCandidates([]);
    setSelected(new Set());
    setCriterionDefinition("");
    setRationale("");
    if (!selectedCode) return;
    setCriterionName(selectedCode.label.length <= 200 ? selectedCode.label : "");
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const rows: AnalysisCriterionPromotionCandidate[] = [];
        const observations = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          if (cursor && cursors.has(cursor)) throw new Error("Analysis promotion candidate cursor did not advance");
          if (cursor) cursors.add(cursor);
          const page = await fetchAnalysisPromotionCandidates({
            studyId: study.study.id,
            taxonomyRevisionId: taxonomy.revision.revision.id,
            codeId: selectedCode.codeId,
            limit: 100,
            cursor
          });
          for (const candidate of page.items) {
            if (observations.has(candidate.observationEventId)) {
              throw new Error("Analysis promotion candidates repeated an observation across pages");
            }
            observations.add(candidate.observationEventId);
          }
          rows.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        if (!cancelled) setCandidates(rows);
      } catch (cause) {
        if (!cancelled) onError(cause);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCode?.codeId, study.study.id, taxonomy.revision.revision.id]);

  useEffect(() => {
    let cancelled = false;
    onPromotionStateChange(null);
    void (async () => {
      const rows = new Map<string, AnalysisCriterionPromotionSummary>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        if (cursor && cursors.has(cursor)) throw new Error("Analysis promotion list cursor did not advance");
        if (cursor) cursors.add(cursor);
        const page = await fetchAnalysisPromotions({ studyId: study.study.id, limit: 50, cursor });
        for (const promotion of page.items) rows.set(promotion.promotion.codeId, promotion);
        cursor = page.nextCursor;
      } while (cursor);
      if (!cancelled) {
        setPromotionsByCode(rows);
        onPromotionStateChange(rows.size > 0);
      }
    })()
      .catch((cause) => { if (!cancelled) onError(cause); });
    return () => { cancelled = true; };
  }, [study.study.id, onPromotionStateChange]);

  const toggle = (observationEventId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(observationEventId)) next.delete(observationEventId);
    else if (next.size < ANALYSIS_MAX_PROMOTION_SUPPORTS) next.add(observationEventId);
    return next;
  });
  const promote = async () => {
    if (!selectedCode || !study.closureId || !study.closureDigest) return;
    const supports = candidates.filter((candidate) => selected.has(candidate.observationEventId));
    const canonicalName = criterionName.trim();
    const canonicalDefinition = criterionDefinition.trim();
    const canonicalRationale = rationale.trim();
    const signature = JSON.stringify({
      studyId: study.study.id,
      closureId: study.closureId,
      taxonomyRevisionId: taxonomy.revision.revision.id,
      codeId: selectedCode.codeId,
      criterionName: canonicalName,
      criterionDefinition: canonicalDefinition,
      rationale: canonicalRationale,
      supports: supports.map((candidate) => candidate.observationEventId)
    });
    try {
      const expectedContext = {
        studyId: study.study.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        codeId: selectedCode.codeId
      };
      const result = await mutation.run(signature, (idempotencyKey) => createAnalysisPromotion({
        studyId: study.study.id,
        expectedClosureId: study.closureId!,
        expectedClosureDigest: study.closureDigest!,
        taxonomyId: taxonomy.taxonomy.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        expectedTaxonomyRevisionDigest: taxonomy.revision.revision.revisionDigest,
        codeId: selectedCode.codeId,
        expectedCodeEntryDigest: selectedCode.entryDigest,
        criterionName: canonicalName,
        criterionDefinition: canonicalDefinition,
        rationale: canonicalRationale,
        supportingObservations: supports.map((candidate) => ({
          studyItemId: candidate.studyItemId,
          closureItemId: candidate.closureItemId,
          closureItemDigest: candidate.closureItemDigest,
          observationEventId: candidate.observationEventId,
          observationEventDigest: candidate.observationEventDigest,
          assignmentEventId: candidate.assignmentEventId,
          assignmentEventDigest: candidate.assignmentEventDigest
        })),
        idempotencyKey
      }));
      if (analysisPromotionContextMatches(currentContext.current, expectedContext)) {
        setPromotionsByCode((current) => new Map(current).set(result.promotion.codeId, result));
        onPromotionStateChange(true);
      }
    } catch (cause) {
      onError(cause);
    }
  };

  return <Card>
    <CardHeader className="justify-between">
      <div>
        <CardTitle>4. Turn one failure type into a criterion</CardTitle>
        <p className="mt-1 text-[10.5px] text-ink-3">Choose the exact observations that explain why this behavior should be judged consistently.</p>
      </div>
    </CardHeader>
    <CardContent>
      <p className="mb-4 text-[11px] text-ink-3">
        This records an immutable criterion and a governed nonsealed review handoff. It does not create human truth,
        an evaluator, calibration, approval, or a release decision.
      </p>
      {receipt ? <div className="mb-4 rounded-sm border border-rule-soft bg-card-2 p-3 text-[11px]">
        <div className="font-medium">Criterion created</div>
        <div className="mt-2 text-ink-3">Next, write the governed review instructions and create a nonsealed review batch. No evaluator has been created or activated.</div>
        <a className="mt-3 inline-flex text-[11px] font-medium text-signal hover:underline"
          href={analysisPromotionHandoffInstructionHref(receipt.criterion.id, receipt.handoff.promotionId)}>
          Create governed instruction and handoff batch
        </a>
      </div> : null}
      <label className="block text-[11px] text-ink-3">Failure type
        <select value={codeId} onChange={(event) => setCodeId(event.target.value)}
          className="mt-1 h-9 w-full rounded-sm border border-rule bg-card px-3 text-[12px]">
          <option value="">Choose a current failure type</option>
          {activeCodes.map((code) => <option key={code.codeId} value={code.codeId}>{code.label}</option>)}
        </select>
      </label>
      {selectedCode ? <div className="mt-3 space-y-3">
        <label className="block text-[11px] text-ink-3" htmlFor="analysis-criterion-name">Criterion name</label>
        <Input id="analysis-criterion-name" value={criterionName} onChange={(event) => setCriterionName(event.target.value)} maxLength={200}
          placeholder={selectedCode.label.length > 200 ? "Failure-type name is too long; enter a shorter criterion name" : "Name the criterion"} />
        <label className="block text-[11px] text-ink-3" htmlFor="analysis-criterion-definition">Criterion definition</label>
        <textarea id="analysis-criterion-definition" value={criterionDefinition} onChange={(event) => setCriterionDefinition(event.target.value)}
          maxLength={20_000} placeholder="State exactly what should be judged"
          className="min-h-24 w-full rounded-sm border border-rule bg-card px-3 py-2 text-[12px]" />
        <label className="block text-[11px] text-ink-3" htmlFor="analysis-criterion-rationale">Why create this criterion?</label>
        <textarea id="analysis-criterion-rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} maxLength={5_000}
          placeholder="Explain why this closed evidence should become a reusable criterion"
          className="min-h-20 w-full rounded-sm border border-rule bg-card px-3 py-2 text-[12px]" />
        <div className="rounded-sm border border-rule-soft">
          <div className="border-b border-rule-soft px-3 py-2 text-[10px] text-ink-4">
            {loading ? "Loading supporting observations…" :
              `${candidates.length} supporting observations · ${selected.size} selected`}
          </div>
          {candidates.map((candidate) => <label key={candidate.observationEventId}
            className="flex gap-3 border-b border-rule-soft px-3 py-3 last:border-0">
            <input type="checkbox" checked={selected.has(candidate.observationEventId)}
              onChange={() => toggle(candidate.observationEventId)} />
            <span className="text-[11px]"><span className="font-medium">{candidate.failureLabel}</span>
              <span className="mt-1 block text-ink-3">{candidate.observationRationale}</span>
              <span className="mt-1 block text-[9px] text-ink-4">Reviewed run {candidate.position + 1}</span>
            </span>
          </label>)}
        </div>
        <Button size="sm" disabled={mutation.busy || loading || selected.size === 0 ||
          !criterionName.trim() || !criterionDefinition.trim() || !rationale.trim()}
          onClick={() => void promote()}><Plus /> Create criterion</Button>
      </div> : null}
    </CardContent>
  </Card>;
}

function loadItemHistory(item: AnalysisStudyItemProjection) {
  return loadHistoryThroughRequiredIds(item.activeFailureObservationEventIds, (cursor) =>
    fetchAnalysisStudyItemEvents(item.item.studyId, item.item.id, { limit: 100, cursor })
  );
}

function CreateStudyCard({ populations, usedPopulationIds, usedPopulationIdsReady, usedPopulationIdsUnavailableCount, onCreated }: {
  populations: AnalysisPopulationSummary[];
  usedPopulationIds: ReadonlySet<string>;
  usedPopulationIdsReady: boolean;
  usedPopulationIdsUnavailableCount: number;
  onCreated: (studyId: string) => void;
}) {
  const [populationId, setPopulationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useIdempotentAction();
  useEffect(() => {
    if (populationId && usedPopulationIds.has(populationId)) {
      setPopulationId("");
      setError("That saved sample already has an analysis. Resume it below.");
    }
  }, [populationId, usedPopulationIds]);
  return <Card>
    <CardHeader><div><CardTitle>2. Start reviewing</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">Choose a saved sample. The newest analysis opens automatically after creation.</p></div></CardHeader>
    <CardContent>
      <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        if (!usedPopulationIdsReady) {
          setError("Wait while existing analyses are checked.");
          return;
        }
        if (usedPopulationIdsUnavailableCount > 0) {
          setError("Existing analyses are temporarily unavailable. Refresh before starting another analysis.");
          return;
        }
        if (usedPopulationIds.has(populationId)) {
          setPopulationId("");
          setError("That saved sample already has an analysis. Resume it below.");
          return;
        }
        try {
          const result = await mutation.run(`create:${populationId}`, (idempotencyKey) =>
            createAnalysisStudy({ populationId, idempotencyKey })
          );
          setPopulationId("");
          setError(null);
          onCreated(result.study.study.id);
        } catch (cause) {
          setError(message(cause));
        }
      }}>
        {error ? <p role="alert" className="text-[11px] text-signal">{error}</p> : null}
        <label className="block text-[11px] text-ink-3">Review sample
          <select value={populationId} onChange={(event) => setPopulationId(event.target.value)} required
            disabled={!usedPopulationIdsReady || usedPopulationIdsUnavailableCount > 0}
            className="mt-1 h-9 w-full rounded-sm border border-rule bg-card px-3 text-[12px]">
            <option value="">Choose a saved sample</option>
            {populations.map((row) => <option key={row.population.id} value={row.population.id}
              disabled={usedPopulationIds.has(row.population.id)}>
              {new Date(row.population.windowStart).toLocaleDateString()}–{new Date(row.population.windowEnd).toLocaleDateString()} · {row.draw.fixedBudget} runs
              {usedPopulationIds.has(row.population.id) ? " · analysis exists — resume below" : ""}
            </option>)}
          </select>
        </label>
        {!usedPopulationIdsReady ? <p role="status" className="text-[10.5px] text-ink-3">Checking which samples already have an analysis…</p> :
          usedPopulationIdsUnavailableCount > 0 ? <p role="status" className="text-[10.5px] text-signal">Some existing analyses are temporarily unavailable. Refresh before starting another analysis.</p> : null}
        <Button type="submit" size="sm" disabled={mutation.busy || !populationId || !usedPopulationIdsReady || usedPopulationIdsUnavailableCount > 0 || usedPopulationIds.has(populationId)}><Plus /> Start analysis</Button>
      </form>
    </CardContent>
  </Card>;
}

function StudyAdminCard({ detail, busy, onChanged, onError }: {
  detail: AnalysisStudyDetail;
  busy: boolean;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const projection = detail.summary.study;
  const [rule, setRule] = useState<"explicit_owner_close" | "server_deadline">("explicit_owner_close");
  const [closeAt, setCloseAt] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [abandonReason, setAbandonReason] = useState("");
  const mutation = useIdempotentAction();
  const action = async (signature: string, operation: (idempotencyKey: string) => Promise<unknown>) => {
    try { await mutation.run(signature, operation); onChanged(); } catch (cause) { onError(cause); }
  };
  const nextAction = projection.state === "draft" ? "Ready to review" :
    projection.state === "coding_open" ? "Review the sample" :
    projection.state === "coding_closed" ? "Review finished" :
    projection.state === "completed" ? "Analysis recorded" : "Analysis stopped";
  return <Card>
    <CardHeader><div><CardTitle>{nextAction}</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">{detail.summary.completedItemCount}/{detail.summary.selectedItemCount} runs complete · {detail.summary.viewedItemCount} opened</p></div></CardHeader>
    <CardContent className="space-y-3">
      {projection.state === "draft" ? <>
        <p className="text-[11.5px] leading-5 text-ink-2">Start the review, then work through one run at a time. Every observation and correction stays in append-only history.</p>
        <Button size="sm" disabled={busy || mutation.busy || (rule === "server_deadline" && !closeAt)} onClick={() => void action(`open:${rule}:${closeAt}`, (idempotencyKey) => openAnalysisStudy(projection.study.id, {
          expectedVersion: projection.currentVersion,
          stoppingRule: rule === "server_deadline" ? { kind: rule, closeAt: new Date(closeAt).toISOString() } : { kind: rule, closeAt: null },
          idempotencyKey
        }))}><BookOpen /> Start reviewing runs</Button>
        <details className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
          <summary className="cursor-pointer text-[10.5px] text-ink-3">Advanced stopping rule</summary>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-[11px] text-ink-3">Finish
              <select value={rule} onChange={(event) => setRule(event.target.value as typeof rule)} className="ml-2 h-9 rounded-sm border border-rule bg-card px-2">
                <option value="explicit_owner_close">when an owner closes it</option><option value="server_deadline">at a server deadline</option>
              </select>
            </label>
            {rule === "server_deadline" ? <label className="text-[11px] text-ink-3">Deadline · local time
              <Input type="datetime-local" value={closeAt} onChange={(event) => setCloseAt(event.target.value)} />
            </label> : null}
          </div>
        </details>
      </> : null}
      {projection.state === "coding_open" && projection.stoppingRule?.kind === "explicit_owner_close" ? <div>
        <p className="mb-2 text-[11px] leading-5 text-ink-3">Finish when the planned review is over. Any unreviewed runs remain visibly missing; finishing never marks them complete.</p>
        <div className="flex gap-2">
          <Input aria-label="Why this review is ending" placeholder="Why is this review ending?" value={closeReason} onChange={(event) => setCloseReason(event.target.value)} maxLength={2000} />
          <Button size="sm" disabled={!closeReason.trim() || mutation.busy} onClick={() => void action(`close:${closeReason.trim()}`, (idempotencyKey) => closeAnalysisStudy(projection.study.id, {
            expectedVersion: projection.currentVersion, reason: closeReason.trim(), idempotencyKey
          }))}><LockKeyhole /> Finish review</Button>
        </div>
      </div> : null}
      {projection.state === "coding_closed" && projection.closureDigest ? <div>
        <p className="mb-2 text-[11px] text-ink-3">The closure receipt is immutable. Acknowledge it to mark the analysis workflow complete; this does not fill missing work.</p>
        <Button size="sm" disabled={mutation.busy} onClick={() => void action(`complete:${projection.closureDigest}`, (idempotencyKey) => completeAnalysisStudy(projection.study.id, {
          expectedVersion: projection.currentVersion, expectedClosureDigest: projection.closureDigest!, idempotencyKey
        }))}><Check /> Acknowledge receipt</Button>
      </div> : null}
      {(projection.state === "draft" || projection.state === "coding_open") ? <details className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
        <summary className="cursor-pointer text-[10.5px] text-ink-3">Stop and abandon this analysis</summary>
        <div className="mt-3 flex gap-2">
          <Input aria-label="Why this analysis is being abandoned" placeholder="Reason" value={abandonReason} onChange={(event) => setAbandonReason(event.target.value)} maxLength={2000} />
          <Button variant="ghost" size="sm" disabled={!abandonReason.trim() || mutation.busy} onClick={() => void action(`abandon:${abandonReason.trim()}`, (idempotencyKey) => abandonAnalysisStudy(projection.study.id, {
            expectedVersion: projection.currentVersion, reason: abandonReason.trim(), idempotencyKey
          }))}><X /> Abandon</Button>
        </div>
      </details> : null}
    </CardContent>
  </Card>;
}

function CodingCard({ item, events, eventCursor, content, taxonomy, codingOpen, totalItems, onView, onChanged, onMoreEvents, onAssignmentChanged, onError }: {
  item: AnalysisStudyItemProjection;
  events: AnalysisStudyItemEventArtifact[];
  eventCursor: string | null;
  content: AnalysisStudyItemContent | null;
  taxonomy: AnalysisTaxonomyDetail | null;
  codingOpen: boolean;
  totalItems: number;
  onView: () => Promise<void>;
  onChanged: (item: AnalysisStudyItemProjection) => Promise<void>;
  onMoreEvents: () => Promise<void>;
  onAssignmentChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const [label, setLabel] = useState("");
  const [rationale, setRationale] = useState("");
  const [anchor, setAnchor] = useState<"case_output" | "step">("case_output");
  const [stepIndex, setStepIndex] = useState("0");
  const [refreshing, setRefreshing] = useState(false);
  const headingRef = useRef<HTMLSpanElement | null>(null);
  const operationInFlight = useRef(false);
  const mutation = useIdempotentAction();
  const actionBusy = mutation.busy || refreshing;
  useEffect(() => { headingRef.current?.focus(); }, [item.item.id]);
  const append = async (input: Parameters<typeof appendAnalysisStudyItemEvent>[2]) => {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setRefreshing(true);
    const signature = JSON.stringify({ ...input, idempotencyKey: null });
    try {
      const result = await mutation.run(signature, (idempotencyKey) => appendAnalysisStudyItemEvent(
        item.item.studyId, item.item.id, { ...input, idempotencyKey }
      ));
      if (input.eventType === "failure_observed" || input.eventType === "no_failure_observed") {
        setLabel("");
        setRationale("");
        setAnchor("case_output");
        setStepIndex("0");
      }
      await onChanged(result.item);
    }
    catch (cause) { onError(cause); }
    finally {
      operationInFlight.current = false;
      setRefreshing(false);
    }
  };
  const activeFailureEvents = useMemo(() => events.filter((event) =>
    event.eventType === "failure_observed" && item.activeFailureObservationEventIds.includes(event.id)
  ), [events, item.activeFailureObservationEventIds]);
  return <Card>
    <CardHeader className="justify-between"><div><CardTitle><span ref={headingRef} tabIndex={-1}>Review run {item.item.position + 1} of {totalItems}</span></CardTitle><p className="mt-1 text-[10.5px] text-ink-3">What went wrong? Record each distinct issue, or say no issue was found.</p></div>
      <Button variant="ghost" size="sm" onClick={() => void onView()}><Eye /> {content ? "Reload run" : "Open run"}</Button></CardHeader>
    <CardContent>
      {content ? <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div><div className="mb-1 text-[10.5px] font-medium text-ink-3">Input</div><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-card-2 p-3 text-[10.5px]">{JSON.stringify(content.payloadSnapshot.input, null, 2)}</pre></div>
        <div><div className="mb-1 text-[10.5px] font-medium text-ink-3">Output</div><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-card-2 p-3 text-[10.5px]">{JSON.stringify(content.payloadSnapshot.output, null, 2)}</pre></div>
      </div> : <p className="mb-4 rounded-sm border border-dashed border-rule-soft px-3 py-4 text-[11px] text-ink-3">Open this run when you are ready to review it. Opening records access to the frozen analysis evidence.</p>}
      <div className="space-y-2">
        {activeFailureEvents.length > 0 ? <div className="text-[10.5px] font-medium text-ink-3">Recorded observations</div> : null}
        {activeFailureEvents.map((event) => event.eventType === "failure_observed" ? <div key={event.id} className="rounded-sm border border-rule-soft p-3 text-[11px]">
          <div className="font-medium">{event.failureLabel}</div><div className="mt-1 text-ink-3">{event.rationale}</div>
          {taxonomy ? <ObservationAssignmentControl taxonomy={taxonomy} observation={event} codingOpen={codingOpen}
            onChanged={onAssignmentChanged} onError={onError} /> : null}
          {codingOpen && item.state !== "completed" ? <Button variant="ghost" size="sm" disabled={actionBusy} onClick={() => void append({
            eventType: "failure_withdrawn", expectedVersion: item.currentVersion, targetEventId: event.id,
            targetEventDigest: event.eventDigest, rationale: "Withdrawn by reviewer", idempotencyKey: "pending"
          })}>Withdraw</Button> : null}
        </div> : null)}
      </div>
      {eventCursor ? <Button variant="ghost" size="sm" onClick={() => void onMoreEvents()}>Load earlier changes</Button> : null}
      {codingOpen && item.state !== "completed" && item.activeNoFailureEventId && item.activeNoFailureEventDigest ?
        <Button className="mt-3" variant="ghost" size="sm" disabled={actionBusy} onClick={() => void append({
          eventType: "no_failure_withdrawn", expectedVersion: item.currentVersion,
          targetEventId: item.activeNoFailureEventId!, targetEventDigest: item.activeNoFailureEventDigest!,
          rationale: "No-failure observation withdrawn for correction", idempotencyKey: "pending"
        })}>Withdraw no-failure observation</Button> : null}
      {codingOpen && item.state !== "completed" ? <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-[11px] text-ink-3">What went wrong?
          <Input className="mt-1" placeholder="Short, exact failure description" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={500} />
        </label>
        <label className="text-[11px] text-ink-3">Why?
          <Input className="mt-1" placeholder="Explain the evidence you saw" value={rationale} onChange={(event) => setRationale(event.target.value)} maxLength={5000} />
        </label>
        <details className="md:col-span-2 rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
          <summary className="cursor-pointer text-[10.5px] text-ink-3">Evidence anchor</summary>
          <div className="mt-2 flex gap-2">
            <select aria-label="Evidence anchor" value={anchor} onChange={(event) => setAnchor(event.target.value as typeof anchor)} className="h-9 rounded-sm border border-rule bg-card px-2 text-[12px]">
              <option value="case_output">Whole output</option><option value="step">One step</option>
            </select>
            {anchor === "step" ? <Input aria-label="Zero-based step number" type="number" min={0} value={stepIndex} onChange={(event) => setStepIndex(event.target.value)} /> : null}
          </div>
        </details>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button size="sm" disabled={actionBusy || !label.trim() || !rationale.trim() || item.activeNoFailureEventId !== null} onClick={() => void append({
            eventType: "failure_observed", expectedVersion: item.currentVersion, failureLabel: label.trim(), rationale: rationale.trim(),
            evidenceAnchor: anchor === "step" ? { kind: "step", stepIndex: Number(stepIndex) } : { kind: "case_output" }, idempotencyKey: "pending"
          })}>Record issue</Button>
          <Button variant="ghost" size="sm" disabled={actionBusy || !rationale.trim() || item.activeFailureObservationEventIds.length > 0} onClick={() => void append({
            eventType: "no_failure_observed", expectedVersion: item.currentVersion, rationale: rationale.trim(), idempotencyKey: "pending"
          })}>No issue found</Button>
          <Button variant="ghost" size="sm" disabled={actionBusy || (item.activeFailureObservationEventIds.length === 0 && item.activeNoFailureEventId === null)} onClick={() => void append({
            eventType: "coding_completed", expectedVersion: item.currentVersion, idempotencyKey: "pending"
          })}><Check /> Finish this run</Button>
        </div>
      </div> : null}
      {codingOpen && item.state === "completed" && item.completionEventId && item.completionEventDigest ? <Button className="mt-4" variant="ghost" size="sm" disabled={actionBusy} onClick={() => void append({
        eventType: "coding_reopened", expectedVersion: item.currentVersion, targetEventId: item.completionEventId!,
        targetEventDigest: item.completionEventDigest!, rationale: "Reopened for correction", idempotencyKey: "pending"
      })}>Reopen this run</Button> : null}
    </CardContent>
  </Card>;
}

function ObservationAssignmentControl({ taxonomy, observation, codingOpen, onChanged, onError }: {
  taxonomy: AnalysisTaxonomyDetail;
  observation: Extract<AnalysisStudyItemEventArtifact, { eventType: "failure_observed" }>;
  codingOpen: boolean;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const [history, setHistory] = useState<AnalysisObservationAssignmentEventArtifact[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [codeId, setCodeId] = useState("");
  const mutation = useIdempotentAction();
  const activeCodes = taxonomy.revision.codes.filter((code) => code.status === "active");
  const load = useCallback(async () => {
    try {
      const page = await fetchAnalysisObservationAssignments(taxonomy.taxonomy.id, observation.id, { limit: 100 });
      setHistory(page.items);
      setHistoryCursor(page.nextCursor);
    } catch (cause) { onError(cause); }
  }, [observation.id, taxonomy.taxonomy.id]);
  useEffect(() => { void load(); }, [load]);
  const head = history.reduce<AnalysisObservationAssignmentEventArtifact | null>((current, event) =>
    current === null || BigInt(event.version) > BigInt(current.version) ? event : current, null);
  const assigned = head?.eventType === "assigned" ? taxonomy.revision.codes.find((code) => code.codeId === head.codeId) : null;
  const mutate = async (withdraw: boolean) => {
    try {
      const input: AnalysisObservationAssignmentEventInput = withdraw ? {
        eventType: "withdrawn",
        observationEventId: observation.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        expectedVersion: head?.version ?? "0",
        expectedPredecessorEventId: head?.id ?? null,
        expectedPredecessorEventDigest: head?.eventDigest ?? null,
        codeId: null,
        rationale: "Assignment withdrawn during governed coding",
        idempotencyKey: "pending"
      } : {
        eventType: "assigned",
        observationEventId: observation.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        expectedVersion: head?.version ?? "0",
        expectedPredecessorEventId: head?.id ?? null,
        expectedPredecessorEventDigest: head?.eventDigest ?? null,
        codeId,
        rationale: "Assigned during governed open coding",
        idempotencyKey: "pending"
      };
      const signature = JSON.stringify({ ...input, idempotencyKey: null });
      await mutation.run(signature, (idempotencyKey) => appendAnalysisObservationAssignment(
        taxonomy.taxonomy.id,
        { ...input, idempotencyKey }
      ));
      await load(); onChanged();
    } catch (cause) { onError(cause); }
  };
  return <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-rule-soft pt-2">
    <span className="text-[10px] text-ink-4">Failure type: {assigned ? assigned.label : head?.eventType === "withdrawn" ? "assignment removed" : "not organized yet"}</span>
    {codingOpen ? <>
      <select aria-label={`Failure type for ${observation.failureLabel}`} value={codeId} onChange={(event) => setCodeId(event.target.value)} className="h-8 rounded-sm border border-rule bg-card px-2 text-[11px]">
        <option value="">Choose a failure type</option>{activeCodes.map((code) => <option key={code.codeId} value={code.codeId}>{code.label}</option>)}
      </select>
      <Button size="sm" variant="ghost" disabled={!codeId || mutation.busy} onClick={() => void mutate(false)}>Organize</Button>
      {head?.eventType === "assigned" ? <Button size="sm" variant="ghost" disabled={mutation.busy} onClick={() => void mutate(true)}>Remove assignment</Button> : null}
    </> : null}
    {historyCursor ? <Button size="sm" variant="ghost" onClick={async () => {
      try {
        const page = await fetchAnalysisObservationAssignments(taxonomy.taxonomy.id, observation.id, {
          limit: 100,
          cursor: historyCursor
        });
        setHistory((rows) => [...rows, ...page.items]);
        setHistoryCursor(page.nextCursor);
      } catch (cause) { onError(cause); }
    }}>Load older assignments</Button> : null}
  </div>;
}

function TaxonomyCard({ taxonomy, editable, onChanged }: { taxonomy: AnalysisTaxonomyDetail | null; editable: boolean; onChanged: () => void }) {
  const [name, setName] = useState("Failure types");
  const [description, setDescription] = useState("Human-authored failure types from reviewed runs.");
  const [label, setLabel] = useState("");
  const [definition, setDefinition] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useIdempotentAction();
  const addRevision = async () => {
    if (!taxonomy) return;
    const current = taxonomy.revision;
    const codes: AnalysisTaxonomyRevisionCodeInput[] = current.codes.map((code) => ({
      kind: "existing", codeId: code.codeId, label: code.label, definition: code.definition, status: code.status
    }));
    codes.push({ kind: "new", clientToken: `code:${label.trim()}`, label: label.trim(), definition: definition.trim() });
    const input = {
      expectedPredecessorRevisionId: current.revision.id,
      expectedPredecessorRevisionDigest: current.revision.revisionDigest,
      expectedPredecessorSequence: current.revision.sequence,
      reason: "Added a human-authored failure code",
      codes,
      idempotencyKey: "pending"
    } as const;
    await mutation.run(JSON.stringify({ ...input, idempotencyKey: null }), (idempotencyKey) =>
      createAnalysisTaxonomyRevision(taxonomy.taxonomy.id, { ...input, idempotencyKey })
    );
  };
  const retireCode = async (codeId: string) => {
    if (!taxonomy) return;
    const current = taxonomy.revision;
    const input = {
      expectedPredecessorRevisionId: current.revision.id,
      expectedPredecessorRevisionDigest: current.revision.revisionDigest,
      expectedPredecessorSequence: current.revision.sequence,
      reason: "Retired a human-authored failure code without changing its meaning",
      codes: current.codes.map((code) => ({
        kind: "existing" as const,
        codeId: code.codeId,
        label: code.label,
        definition: code.definition,
        status: code.codeId === codeId ? "retired" as const : code.status
      })),
      idempotencyKey: "pending"
    } as const;
    await mutation.run(JSON.stringify({ ...input, idempotencyKey: null }), (idempotencyKey) =>
      createAnalysisTaxonomyRevision(taxonomy.taxonomy.id, { ...input, idempotencyKey })
    );
  };
  return <Card><CardHeader><div><CardTitle>3. Organize findings into failure types</CardTitle><p className="mt-1 text-[10.5px] leading-5 text-ink-3">You name this flat list and assign observations yourself. Coeval does not cluster, merge, split, or generate categories.</p></div></CardHeader><CardContent>
    {error ? <p role="alert" className="mb-2 text-[11px] text-signal">{error}</p> : null}
    {taxonomy ? <div className="space-y-2">
      <div className="text-[11px] text-ink-3">{taxonomy.revision.codes.filter((code) => code.status === "active").length} current failure type{taxonomy.revision.codes.filter((code) => code.status === "active").length === 1 ? "" : "s"}</div>
      {taxonomy.revision.codes.map((code) => <div key={code.codeId} className="rounded-sm border border-rule-soft p-2 text-[11px]">
        <span className={code.status === "retired" ? "line-through text-ink-4" : "font-medium"}>{code.label}</span>
        <div className="text-ink-3">{code.definition}</div>
        {editable && code.status === "active" ? <Button variant="ghost" size="sm" disabled={mutation.busy} onClick={() => void retireCode(code.codeId)
          .then(onChanged).catch((cause) => setError(message(cause)))}>Retire type</Button> : null}
      </div>)}
      {editable ? <>
        <label className="block text-[11px] text-ink-3" htmlFor="new-failure-type-name">New failure type name</label>
        <Input id="new-failure-type-name" placeholder="Name the failure type" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={500} />
        <label className="block text-[11px] text-ink-3" htmlFor="new-failure-type-definition">What belongs in this type?</label>
        <Input id="new-failure-type-definition" placeholder="Define the boundary" value={definition} onChange={(event) => setDefinition(event.target.value)} maxLength={5000} />
        <Button size="sm" disabled={!label.trim() || !definition.trim() || mutation.busy} onClick={() => void addRevision().then(onChanged).catch((cause) => setError(message(cause)))}><Plus /> Add failure type</Button>
      </> : null}
    </div> : editable ? <div className="space-y-2">
      <label className="block text-[11px] text-ink-3" htmlFor="failure-type-list-name">Failure-type list name</label>
      <Input id="failure-type-list-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={240} />
      <label className="block text-[11px] text-ink-3" htmlFor="failure-type-list-description">What is this list for?</label>
      <Input id="failure-type-list-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} />
      <label className="block text-[11px] text-ink-3" htmlFor="first-failure-type-name">First failure type name</label>
      <Input id="first-failure-type-name" placeholder="Name the failure type" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={500} />
      <label className="block text-[11px] text-ink-3" htmlFor="first-failure-type-definition">What belongs in this type?</label>
      <Input id="first-failure-type-definition" placeholder="Define the boundary" value={definition} onChange={(event) => setDefinition(event.target.value)} maxLength={5000} />
      <Button size="sm" disabled={!label.trim() || !definition.trim() || mutation.busy} onClick={() => {
        const input = {
          name: name.trim(), description: description.trim(), reason: "Created the first human-authored taxonomy revision",
          codes: [{ kind: "new" as const, clientToken: `code:${label.trim()}`, label: label.trim(), definition: definition.trim() }],
          idempotencyKey: "pending"
        };
        void mutation.run(JSON.stringify({ ...input, idempotencyKey: null }), (idempotencyKey) =>
          createAnalysisTaxonomy({ ...input, idempotencyKey })
        ).then(onChanged).catch((cause) => setError(message(cause)));
      }}><Plus /> Create first failure type</Button>
    </div> : <p className="text-[11px] text-ink-3">No failure types exist yet. A project owner must create the first one.</p>}
  </CardContent></Card>;
}

function FailureTypeFindingsCard({ studyId, taxonomy, onOpenItem }: {
  studyId: string;
  taxonomy: AnalysisTaxonomyDetail;
  onOpenItem: (studyItemId: string) => void;
}) {
  const activeCodes = taxonomy.revision.codes.filter((code) => code.status === "active");
  const [codeId, setCodeId] = useState(activeCodes[0]?.codeId ?? "");
  const [candidates, setCandidates] = useState<AnalysisCriterionPromotionCandidate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const firstActiveId = activeCodes[0]?.codeId ?? "";
    if (!activeCodes.some((code) => code.codeId === codeId)) setCodeId(firstActiveId);
  }, [taxonomy.revision.revision.id, codeId]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setCandidates([]);
    setCursor(null);
    setTotalCount("0");
    setError(null);
    if (!codeId) return;
    setLoading(true);
    void fetchAnalysisPromotionCandidates({
      studyId,
      taxonomyRevisionId: taxonomy.revision.revision.id,
      codeId,
      limit: 100
    }).then((page) => {
      if (generation.current !== requestGeneration) return;
      setCandidates(page.items);
      setCursor(page.nextCursor);
      setTotalCount(page.totalCount);
    }).catch((cause) => {
      if (generation.current === requestGeneration) setError(message(cause));
    }).finally(() => {
      if (generation.current === requestGeneration) setLoading(false);
    });
  }, [studyId, taxonomy.revision.revision.id, codeId]);

  const selectedCode = activeCodes.find((code) => code.codeId === codeId) ?? null;
  return <Card><CardHeader><div><CardTitle>Findings by failure type</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">Choose a human-authored type to see its exact observation count and open the reviewed runs behind it.</p></div></CardHeader><CardContent>
    {activeCodes.length === 0 ? <p className="text-[11px] text-ink-3">No current failure type can summarize these findings. Create or restore one above.</p> : <>
      <label className="block text-[11px] text-ink-3" htmlFor="analysis-findings-type">Failure type</label>
      <select id="analysis-findings-type" value={codeId} onChange={(event) => setCodeId(event.target.value)}
        className="mt-1 h-9 w-full rounded-sm border border-rule bg-card px-3 text-[12px]">
        {activeCodes.map((code) => <option key={code.codeId} value={code.codeId}>{code.label}</option>)}
      </select>
      {error ? <p role="alert" className="mt-3 text-[11px] text-signal">{error}</p> : loading ? <p className="mt-3 text-[11px] text-ink-3">Loading exact findings…</p> : <>
        <div className="mt-3 text-[12px] font-medium">{totalCount} observation{totalCount === "1" ? "" : "s"} assigned to {selectedCode?.label}</div>
        {candidates.length === 0 ? <p className="mt-2 text-[11px] text-ink-3">No closed-study observation is assigned to this type.</p> : <div className="mt-3 divide-y divide-rule-soft rounded-sm border border-rule-soft">
          {candidates.map((candidate) => <button key={candidate.observationEventId} type="button"
            onClick={() => onOpenItem(candidate.studyItemId)}
            className="block w-full px-3 py-3 text-left hover:bg-card-2">
            <span className="text-[11px] font-medium">Run {candidate.position + 1} · {candidate.failureLabel}</span>
            <span className="mt-1 block text-[10.5px] text-ink-3">{candidate.observationRationale}</span>
            <span className="mt-1 block text-[10px] text-signal">Open reviewed run</span>
          </button>)}
        </div>}
        {cursor ? <Button className="mt-3" variant="ghost" size="sm" disabled={loading} onClick={() => {
          const nextCursor = cursor;
          const requestGeneration = generation.current;
          setLoading(true);
          void fetchAnalysisPromotionCandidates({
            studyId,
            taxonomyRevisionId: taxonomy.revision.revision.id,
            codeId,
            limit: 100,
            cursor: nextCursor
          }).then((page) => {
            if (generation.current !== requestGeneration) return;
            setCandidates((rows) => [...rows, ...page.items]);
            setCursor(page.nextCursor);
            setTotalCount(page.totalCount);
          }).catch((cause) => {
            if (generation.current === requestGeneration) setError(message(cause));
          }).finally(() => {
            if (generation.current === requestGeneration) setLoading(false);
          });
        }}>Load more linked runs</Button> : null}
      </>}
    </>}
  </CardContent></Card>;
}

function MemberFindingsCard() {
  return <Card><CardHeader><div><CardTitle>Findings by failure type</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">The review queue and exact aggregate counts above remain available to every reviewer.</p></div></CardHeader><CardContent>
    <p className="text-[11px] leading-5 text-ink-3">Per-type promotion evidence is owner-only because it is also the input to criterion creation. Ask a project owner to inspect those linked runs or create the criterion.</p>
  </CardContent></Card>;
}

function CoverageCard({ coverage, error }: { coverage: AnalysisTaxonomyCoverage | null; error: string | null }) {
  return <Card><CardHeader><div><CardTitle>What you found</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">Counts are tied to this exact analysis and current human-authored failure-type revision.</p></div></CardHeader><CardContent>
    {error ? <p role="alert" className="text-[11px] text-signal">{error}</p> : coverage ? <div className="grid gap-2 sm:grid-cols-3">
      <Fact label="Runs sampled" value={String(coverage.selectedItemCount)} />
      <Fact label="Runs reviewed" value={String(coverage.completedItemCount)} />
      <Fact label="No issue found" value={String(coverage.noFailureObservedItemCount)} />
      <Fact label="Issue observations" value={coverage.activeFailureObservationCount} />
      <Fact label="Organized" value={coverage.categorized} /><Fact label="Type later retired" value={coverage.assignedToRetiredCode} />
      <Fact label="Needs a type" value={coverage.uncategorized} />
    </div> : <p className="text-[11px] text-ink-3">Loading findings…</p>}
  </CardContent></Card>;
}

function ClaimLine({ row }: { row: AnalysisStudySummary }) {
  if (!row.closure) return <div className="mt-1 text-[11px] text-ink-3">Exact sample saved · review not finished</div>;
  return row.closure.representativeOfPopulationId ?
    <div className="mt-1 text-[11px] text-mint">Complete for this exact frozen set only</div> :
    <div className="mt-1 text-[11px] text-ink-3">Scope saved · {representativeReasonLabel(row.closure.representativeReason)}</div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><div className="font-mono text-[9px] uppercase tracking-wide text-ink-4">{label}</div><div className="mt-1 text-[12px]">{value}</div></div>;
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

function useIdempotentAction(): {
  busy: boolean;
  run<T>(signature: string, operation: (idempotencyKey: string) => Promise<T>): Promise<T>;
} {
  const coordinator = useRef<AnalysisMutationCoordinator | null>(null);
  if (!coordinator.current) coordinator.current = new AnalysisMutationCoordinator(() => key("analysis-action"));
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async <T,>(signature: string, operation: (idempotencyKey: string) => Promise<T>) => {
      const idempotencyKey = coordinator.current!.begin(signature);
      if (!idempotencyKey) throw new Error("This governed mutation is already in flight");
      setBusy(true);
      try {
        const result = await operation(idempotencyKey);
        coordinator.current!.finish(signature, "success");
        return result;
      } catch (cause) {
        coordinator.current!.finish(signature, analysisMutationFailureKind(cause));
        throw cause;
      } finally {
        setBusy(coordinator.current!.busy);
      }
    }
  };
}

function key(prefix: string): string { return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : "Governed analysis request failed"; }
