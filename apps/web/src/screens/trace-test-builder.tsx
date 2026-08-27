import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, FileCheck2, Play, ShieldCheck, X } from "lucide-react";
import { useBlocker, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Chip, Receipt } from "@/components/coeval";
import {
  ApiError,
  assistTraceTestDraft,
  createTraceTest,
  enableTraceTest,
  fetchCaseDetail,
  fetchDashboard,
  fetchTraceTest,
  recordHumanVerdict,
  recordManualTraceTestValidation,
  runTraceTestValidation,
  startTraceTestRun,
  reviseTraceTest
} from "@/lib/api";
import {
  conversationTurns,
  correctionVerdictPayload,
  createManualTraceTestInput,
  defaultSourceSelection,
  initialJobForIntent,
  intentForVerdict,
  manualFields,
  plainText,
  samePath,
  type ConversationTurn,
  type CorrectionResult,
  type ManualTraceTestFields,
  type TraceTestIntent,
  type TraceTestJob
} from "@/lib/trace-test-flow";
import { createTraceTestFunnel, type TraceTestFunnel } from "@/lib/trace-test-pilot";
import { useCriterion } from "@/lib/criterion-context";
import { useDashboard } from "@/lib/dashboard-context";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import { dashboardSkillVersionId } from "@/lib/criterion-scope";
import type {
  ExceptionDetail,
  TraceTestDetail,
  TraceTestDraftField,
  TraceTestDraftProvenance,
  TraceTestRevision,
  TraceTestSourceScope,
  TraceTestValidation,
  TraceTestValidationOutcome,
  TraceTestRunResult
} from "@coeval/shared";

type Stage = "source" | "desired" | "draft" | "validate" | "receipt";
type ReceiptKind = "draft" | "correction" | "enabled";

const EMPTY_FIELDS: ManualTraceTestFields = {
  scenario: "",
  expectedBehavior: "",
  mustDo: "",
  mustAvoid: "",
  goodExample: "",
  badExample: "",
  checkerKind: "manual",
  checkerLabel: "Manual behavior check",
  checkerRationale: ""
};

const HUMAN_PROVENANCE: TraceTestDraftProvenance = {
  origin: "human",
  generatedFields: [],
  generator: null
};

type EditableDraftTextField = Exclude<keyof ManualTraceTestFields, "checkerKind" | "checkerLabel" | "checkerRationale">;

const INPUT_CLASS = "w-full rounded-sm border border-rule-soft bg-card-2 px-3 py-2 text-[13px] leading-[1.55] text-ink transition-colors placeholder:text-ink-3 focus-visible:border-ink max-[760px]:text-base";
const MOBILE_FOCUS_CLASS = "max-[760px]:fixed max-[760px]:inset-0 max-[760px]:z-50 max-[760px]:overflow-y-auto max-[760px]:bg-paper max-[760px]:px-4 max-[760px]:pt-4";

function lastRevision(test: TraceTestDetail): TraceTestRevision {
  const revision = test.revisions.find((candidate) => candidate.revision === test.currentRevision);
  if (!revision) throw new Error("The saved draft is missing its current revision.");
  return revision;
}

function exampleText(value: unknown): string {
  if (typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return plainText(value);
}

function restoredJob(revision: TraceTestRevision): Exclude<TraceTestJob, "verdict"> {
  const job = revision.checker.metadata.journeyJob;
  return job === "preserve" ? "preserve" : "response";
}

function restoredInferredContext(revision: TraceTestRevision): string[] {
  const value = revision.checker.metadata.inferredContext;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validationIsEnableEligible(validation: TraceTestValidation | null): boolean {
  if (!validation || validation.status !== "passed") return false;
  if (validation.method === "automated") return validation.evaluator !== null;
  return validation.method === "manual_override"
    && typeof validation.overrideReason === "string"
    && validation.overrideReason.trim().length >= 10;
}

export function TraceTestBuilderScreen() {
  const { id: caseId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const { dashboard } = useDashboard();
  const skillVersionId = dashboardSkillVersionId(dashboard);
  const routeState = (location.state ?? {}) as { backTo?: string; backLabel?: string };
  const backTo = routeState.backTo ?? (caseId ? `/cases/${caseId}` : "/traces");
  const backLabel = routeState.backLabel ?? "Back to conversation";
  const requestedDraftId = searchParams.get("draft");

  const [detail, setDetail] = useState<ExceptionDetail | null>(null);
  const [savedTest, setSavedTest] = useState<TraceTestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorTitle, setLoadErrorTitle] = useState("Source conversation unavailable");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [stage, setStage] = useState<Stage>("source");
  const [receiptKind, setReceiptKind] = useState<ReceiptKind>("draft");
  const [intent, setIntent] = useState<TraceTestIntent>("make");
  const [job, setJob] = useState<TraceTestJob>("response");
  const [responsePath, setResponsePath] = useState<Array<string | number>>(["output"]);
  const [selectedTurns, setSelectedTurns] = useState<number[]>([]);
  const [selectedSteps, setSelectedSteps] = useState<number[]>([]);
  const [editingScope, setEditingScope] = useState(false);
  const [desiredBehavior, setDesiredBehavior] = useState("");
  const [correctionResult, setCorrectionResult] = useState<CorrectionResult>("pass");
  const [correctionReason, setCorrectionReason] = useState("");
  const [fields, setFields] = useState<ManualTraceTestFields>(EMPTY_FIELDS);
  const [draftProvenance, setDraftProvenance] = useState<TraceTestDraftProvenance>(HUMAN_PROVENANCE);
  const [suggestedFields, setSuggestedFields] = useState<TraceTestDraftField[]>([]);
  const [inferredContext, setInferredContext] = useState<string[]>([]);
  const [assistNotice, setAssistNotice] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftSeeded, setDraftSeeded] = useState(false);
  const [validation, setValidation] = useState<TraceTestValidation | null>(null);
  const [validationRunning, setValidationRunning] = useState(false);
  const [manualValidation, setManualValidation] = useState(false);
  const [manualBadResult, setManualBadResult] = useState<"pass" | "fail" | "ambiguous">("fail");
  const [manualGoodResult, setManualGoodResult] = useState<"pass" | "fail" | "ambiguous">("pass");
  const [manualReason, setManualReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<TraceTestRunResult | null>(null);
  const [testRunStarting, setTestRunStarting] = useState(false);
  const [testRunError, setTestRunError] = useState<string | null>(null);
  const [viewerRole, setViewerRole] = useState<"owner" | "member" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const draftAbortRef = useRef<AbortController | null>(null);
  const funnelRef = useRef<TraceTestFunnel | null>(null);
  const sourceCaseRef = useRef<string | null>(null);

  const blocker = useBlocker(dirty);

  useEffect(() => () => draftAbortRef.current?.abort(), []);

  useEffect(() => {
    const abandon = (event?: PageTransitionEvent) => {
      if (!event?.persisted) funnelRef.current?.abandon();
    };
    window.addEventListener("pagehide", abandon);
    return () => {
      window.removeEventListener("pagehide", abandon);
      abandon();
      funnelRef.current = null;
    };
  }, [caseId]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  // The incumbent app shell is intentionally desktop-dense. This journey is
  // a focused full-viewport page below 760px; lock the hidden shell so its
  // fixed 232px navigation cannot create a second, horizontal scroll surface.
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const previousHtml = document.documentElement.style.overflow;
    const previousBody = document.body.style.overflow;
    const sync = () => {
      document.documentElement.style.overflow = media.matches ? "hidden" : previousHtml;
      document.body.style.overflow = media.matches ? "hidden" : previousBody;
    };
    sync();
    media.addEventListener("change", sync);
    return () => {
      media.removeEventListener("change", sync);
      document.documentElement.style.overflow = previousHtml;
      document.body.style.overflow = previousBody;
    };
  }, []);

  useEffect(() => {
    if (!caseId) {
      setLoadError("This link is missing its source conversation.");
      setLoading(false);
      return;
    }
    if (!skillVersionId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setLoadErrorTitle("Source conversation unavailable");
    setSavedTest(null);
    setDraftSeeded(false);
    setFields(EMPTY_FIELDS);
    setDraftProvenance(HUMAN_PROVENANCE);
    setSuggestedFields([]);
    setInferredContext([]);
    setAssistNotice(null);
    setValidation(null);
    setValidationRunning(false);
    setManualValidation(false);
    setManualReason("");
    setValidationError(null);
    setTestRun(null);
    setTestRunStarting(false);
    setTestRunError(null);
    setViewerRole(null);
    setStage("source");
    setDirty(false);
    setEditingScope(false);
    if (sourceCaseRef.current !== caseId) {
      sourceCaseRef.current = caseId;
      setDesiredBehavior("");
      setCorrectionResult("pass");
      setCorrectionReason("");
    }
    const detailRequest = fetchCaseDetail(caseId, skillVersionId);
    const draftRequest = requestedDraftId ? fetchTraceTest(requestedDraftId) : Promise.resolve(null);
    const dashboardRequest = fetchDashboard(selectedCriterionId ?? undefined);
    Promise.allSettled([detailRequest, draftRequest, dashboardRequest])
      .then(([detailResult, draftResult, dashboardResult]) => {
        if (cancelled) return;
        if (detailResult.status === "rejected") throw detailResult.reason;
        if (draftResult.status === "rejected") {
          setLoadErrorTitle("Test draft unavailable");
          throw draftResult.reason;
        }
        const loadedDetail = detailResult.value;
        const draft = draftResult.value;
        setViewerRole(dashboardResult.status === "fulfilled" ? dashboardResult.value.viewerRole : null);
        if (draft && draft.sourceCaseId !== caseId) {
          setLoadErrorTitle("Test draft unavailable");
          throw new Error("This draft belongs to a different source conversation.");
        }
        setDetail(loadedDetail);
        const turns = conversationTurns(loadedDetail.trace);
        const initial = defaultSourceSelection(turns);
        const inferredIntent = parseIntent(searchParams.get("intent")) ?? intentForVerdict(loadedDetail.latestHumanLabel ?? loadedDetail.exception.verdict);
        setIntent(inferredIntent);
        if (!funnelRef.current) funnelRef.current = createTraceTestFunnel(inferredIntent);
        funnelRef.current.record("started");
        setResponsePath(initial.responsePath);
        setSelectedTurns(initial.turnIndexes);
        setSelectedSteps([]);
        setJob(initialJobForIntent(inferredIntent));
        if (draft) {
          const revision = lastRevision(draft);
          const draftJob = restoredJob(revision);
          setSavedTest(draft);
          setResponsePath(draft.sourceScope.responsePath);
          setSelectedTurns(draft.sourceScope.turnIndexes);
          setSelectedSteps(draft.sourceScope.stepIndexes);
          setJob(draftJob);
          setDesiredBehavior(revision.desiredBehavior);
          setFields({
            scenario: revision.scenario,
            expectedBehavior: revision.expectedBehavior,
            mustDo: revision.mustDo.join("\n"),
            mustAvoid: revision.mustAvoid.join("\n"),
            goodExample: exampleText(revision.goodExample),
            badExample: exampleText(revision.badExample),
            checkerKind: revision.checker.kind === "judge" ? "judge" : "manual",
            checkerLabel: revision.checker.label,
            checkerRationale: typeof revision.checker.metadata.recommendationRationale === "string"
              ? revision.checker.metadata.recommendationRationale
              : ""
          });
          setDraftProvenance(revision.draftProvenance);
          setInferredContext(restoredInferredContext(revision));
          setValidation([...draft.validations]
            .filter((candidate) => candidate.revision === draft.currentRevision)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null);
          setDraftSeeded(true);
          setStage("draft");
        }
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [caseId, requestedDraftId, loadAttempt, selectedCriterionId, skillVersionId]); // searchParams is intentionally read only for the initial entry intent.

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-trace-test-heading]")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail?.exception.id, loadError, loading, stage]);

  const turns = useMemo(() => detail ? conversationTurns(detail.trace) : [], [detail]);
  const selectedResponse = turns.find((turn) => samePath(turn.path, responsePath)) ?? null;
  const sourceScope: TraceTestSourceScope = useMemo(() => ({
    responsePath,
    turnIndexes: [...selectedTurns].sort((a, b) => a - b),
    stepIndexes: [...selectedSteps].sort((a, b) => a - b)
  }), [responsePath, selectedTurns, selectedSteps]);

  const confirmGeneratedField = (field: TraceTestDraftField) => {
    setSuggestedFields((current) => current.filter((candidate) => candidate !== field));
    setDraftProvenance((current) => current.origin === "generated" && current.generatedFields.includes(field)
      ? { ...current, origin: "mixed" }
      : current);
  };

  const invalidateUnsavedAssistance = () => {
    if (savedTest || draftProvenance.origin === "human") return;
    setFields(EMPTY_FIELDS);
    setDraftProvenance(HUMAN_PROVENANCE);
    setSuggestedFields([]);
    setInferredContext([]);
    setAssistNotice(null);
    setDraftSeeded(false);
  };

  const cancelAssistance = () => {
    draftAbortRef.current?.abort();
    draftAbortRef.current = null;
    setDrafting(false);
  };

  const updateField = (field: EditableDraftTextField, value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
    confirmGeneratedField(field);
    setDirty(true);
  };

  const seedManualDraft = (notice: string | null = null) => {
    setFields(manualFields({
      turns,
      selectedTurnIndexes: selectedTurns,
      responsePath,
      desiredBehavior,
      job: job === "preserve" ? "preserve" : "response"
    }));
    setDraftProvenance(HUMAN_PROVENANCE);
    setSuggestedFields([]);
    setInferredContext([]);
    setAssistNotice(notice);
    setDraftSeeded(true);
  };

  const enterDraft = async () => {
    if (!desiredBehavior.trim() || job === "verdict") return;
    if (draftSeeded) {
      setStage("draft");
      setDirty(true);
      setSubmitError(null);
      return;
    }
    if (!caseId) return;
    const controller = new AbortController();
    draftAbortRef.current = controller;
    setDrafting(true);
    setSubmitError(null);
    let shouldEnterDraft = true;
    try {
      const result = await assistTraceTestDraft({
        sourceCaseId: caseId,
        skillVersionId: skillVersionId ?? undefined,
        sourceScope,
        desiredBehavior,
        job
      }, controller.signal);
      if (result.status === "generated") {
        setFields({
          scenario: result.content.scenario,
          expectedBehavior: result.content.expectedBehavior,
          mustDo: result.content.mustDo.join("\n"),
          mustAvoid: result.content.mustAvoid.join("\n"),
          goodExample: result.content.goodExample,
          badExample: result.content.badExample,
          checkerKind: result.content.checker.kind,
          checkerLabel: result.content.checker.label,
          checkerRationale: typeof result.content.checker.metadata.recommendationRationale === "string"
            ? result.content.checker.metadata.recommendationRationale
            : ""
        });
        setDraftProvenance(result.draftProvenance);
        setSuggestedFields(result.draftProvenance.generatedFields);
        setInferredContext(result.content.inferredContext);
        setAssistNotice(null);
        setDraftSeeded(true);
      } else {
        seedManualDraft(result.message);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        shouldEnterDraft = false;
        setSubmitError(error.message);
        return;
      }
      seedManualDraft(error instanceof ApiError
        ? error.message
        : "Automatic drafting could not finish. A manual draft is ready and nothing was lost.");
    } finally {
      if (draftAbortRef.current === controller) draftAbortRef.current = null;
      if (!controller.signal.aborted) {
        setDrafting(false);
        if (shouldEnterDraft) {
          setStage("draft");
          setDirty(true);
        }
      }
    }
  };

  const writeManually = () => {
    if (!desiredBehavior.trim() || job === "verdict") return;
    cancelAssistance();
    if (!draftSeeded) seedManualDraft();
    setStage("draft");
    setDirty(true);
    setSubmitError(null);
  };

  const persistDraft = async (showReceipt = true): Promise<TraceTestDetail> => {
    if (!caseId || job === "verdict") throw new Error("A product-behavior draft is not available for this choice.");
    setSubmitting(true);
    setSubmitError(null);
    try {
      const input = createManualTraceTestInput({
        sourceCaseId: caseId,
        sourceScope,
        desiredBehavior,
        job,
        fields,
        draftProvenance,
        inferredContext
      });
      const test = savedTest
        ? await reviseTraceTest(savedTest.id, {
            expectedRevision: savedTest.currentRevision,
            desiredBehavior: input.desiredBehavior,
            scenario: input.scenario,
            expectedBehavior: input.expectedBehavior,
            mustDo: input.mustDo,
            mustAvoid: input.mustAvoid,
            goodExample: input.goodExample,
            badExample: input.badExample,
            checker: input.checker,
            draftProvenance: input.draftProvenance
          })
        : await createTraceTest(input);
      setSavedTest(test);
      funnelRef.current?.record("draft_saved");
      setSuggestedFields([]);
      setValidation(null);
      setManualValidation(false);
      setManualReason("");
      setValidationError(null);
      setDirty(false);
      if (showReceipt) {
        setReceiptKind("draft");
        setStage("receipt");
      }
      return test;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubmitError(message);
      throw error;
    } finally {
      setSubmitting(false);
    }
  };

  const recordCorrection = async () => {
    if (!caseId || !correctionReason.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await recordHumanVerdict(
        caseId,
        correctionVerdictPayload(correctionResult, correctionReason),
        skillVersionId ?? undefined,
      );
      funnelRef.current?.record("correction_recorded");
      funnelRef.current?.complete();
      setDirty(false);
      setReceiptKind("correction");
      setStage("receipt");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const runAutomatedValidation = async (test: TraceTestDetail) => {
    setValidationRunning(true);
    setValidationError(null);
    try {
      const result = await runTraceTestValidation(test.id, {
        revision: test.currentRevision,
        skillVersionId: skillVersionId ?? undefined,
      });
      setValidation(result);
      funnelRef.current?.record("validation_completed");
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    } finally {
      setValidationRunning(false);
    }
  };

  const beginValidation = async () => {
    if (!savedTest) return;
    const revision = lastRevision(savedTest);
    setStage("validate");
    setValidationError(null);
    const existing = validation?.revision === savedTest.currentRevision ? validation : null;
    if (existing) return;
    if (revision.checker.kind === "judge") {
      setManualValidation(false);
      await runAutomatedValidation(savedTest);
    } else {
      setManualValidation(true);
    }
  };

  const recordManualValidation = async () => {
    if (!savedTest || manualReason.trim().length < 10) return;
    setValidationRunning(true);
    setValidationError(null);
    try {
      const result = await recordManualTraceTestValidation(savedTest.id, {
        revision: savedTest.currentRevision,
        badResult: manualBadResult,
        goodResult: manualGoodResult,
        overrideReason: manualReason
      });
      setValidation(result);
      funnelRef.current?.record("validation_completed");
      setManualValidation(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    } finally {
      setValidationRunning(false);
    }
  };

  const enableValidatedTest = async () => {
    if (!savedTest || !validation || validation.status !== "passed") return;
    setValidationRunning(true);
    setValidationError(null);
    try {
      const test = await enableTraceTest(savedTest.id, {
        expectedRevision: savedTest.currentRevision,
        validationId: validation.id
      });
      setSavedTest(test);
      funnelRef.current?.record("enabled");
      funnelRef.current?.complete();
      setReceiptKind("enabled");
      setStage("receipt");
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    } finally {
      setValidationRunning(false);
    }
  };

  const runEnabledTest = async () => {
    if (!savedTest) return;
    setTestRunStarting(true);
    setTestRunError(null);
    try {
      setTestRun(await startTraceTestRun(savedTest.id));
      funnelRef.current?.record("run_started");
    } catch (error) {
      setTestRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setTestRunStarting(false);
    }
  };

  if (loading) return <div className={MOBILE_FOCUS_CLASS}><LocalState title="Loading the source conversation" body="Your test draft will stay attached to its original evidence." /></div>;
  if (loadError || !detail) {
    return (
      <div className={`fadeUp mx-auto max-w-3xl ${MOBILE_FOCUS_CLASS}`}>
        <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}><ArrowLeft /> {backLabel}</Button>
        <LocalState
          title={loadErrorTitle}
          body={loadError ?? "Coeval could not access the source. The test was not created from partial or stale content."}
        />
        <div className="mt-3 flex justify-center"><Button variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading</Button></div>
      </div>
    );
  }

  return (
    <div className={`fadeUp mx-auto max-w-[1180px] pb-12 ${MOBILE_FOCUS_CLASS}`}>
      <div className="sr-only" aria-live="polite">{journeyStatus({ stage, receiptKind, drafting, submitting, validationRunning, validation, validationError, testRunStarting, testRun, testRunError })}</div>
      <div aria-busy={drafting || submitting || validationRunning || testRunStarting}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}><ArrowLeft /> {backLabel}</Button>
        <JourneyProgress stage={stage} correction={job === "verdict" || receiptKind === "correction"} completed={receiptKind === "enabled"} />
      </div>

      {stage === "source" ? (
        <SourceStage
          detail={detail}
          turns={turns}
          responsePath={responsePath}
          selectedTurns={selectedTurns}
          selectedSteps={selectedSteps}
          editingScope={editingScope}
          scopeLocked={Boolean(savedTest)}
          setEditingScope={setEditingScope}
          onSelectResponse={(turn) => {
            invalidateUnsavedAssistance();
            setResponsePath(turn.path);
            setSelectedTurns((current) => current.includes(turn.index) ? current : [...current, turn.index]);
            setDirty(true);
          }}
          onToggleTurn={(turn) => {
            if (samePath(turn.path, responsePath)) return;
            invalidateUnsavedAssistance();
            setSelectedTurns((current) => current.includes(turn.index) ? current.filter((index) => index !== turn.index) : [...current, turn.index]);
            setDirty(true);
          }}
          onToggleStep={(stepIndex) => {
            invalidateUnsavedAssistance();
            setSelectedSteps((current) => current.includes(stepIndex) ? current.filter((index) => index !== stepIndex) : [...current, stepIndex]);
            setDirty(true);
          }}
          onContinue={() => { setStage("desired"); setSubmitError(null); }}
          onCancel={() => navigate(backTo)}
        />
      ) : null}

      {stage === "desired" ? (
        <DesiredStage
          job={job}
          desiredBehavior={desiredBehavior}
          correctionResult={correctionResult}
          correctionReason={correctionReason}
          submitting={submitting}
          drafting={drafting}
          error={submitError}
          onJobChange={(nextJob) => { invalidateUnsavedAssistance(); setJob(nextJob); setDirty(true); setSubmitError(null); }}
          onDesiredBehaviorChange={(value) => { invalidateUnsavedAssistance(); setDesiredBehavior(value); setDirty(true); }}
          onCorrectionResultChange={(value) => { setCorrectionResult(value); setDirty(true); }}
          onCorrectionReasonChange={(value) => { setCorrectionReason(value); setDirty(true); }}
          onBack={() => { cancelAssistance(); setStage("source"); }}
          onCancel={() => { cancelAssistance(); navigate(backTo); }}
          onDraft={() => void enterDraft()}
          onManual={writeManually}
          onCorrection={() => void recordCorrection()}
        />
      ) : null}

      {stage === "draft" ? (
        <DraftStage
          detail={detail}
          turns={turns}
          scope={sourceScope}
          fields={fields}
          suggestedFields={suggestedFields}
          inferredContext={inferredContext}
          assistNotice={assistNotice}
          submitting={submitting}
          error={submitError}
          isRevision={Boolean(savedTest)}
          canCheckSaved={Boolean(savedTest) && !dirty}
          onChange={updateField}
          onCheckerKindChange={(checkerKind) => {
            setFields((current) => ({
              ...current,
              checkerKind,
              checkerLabel: current.checkerLabel.trim()
                ? current.checkerLabel
                : checkerKind === "judge" ? "AI behavior check" : "Manual behavior check"
            }));
            confirmGeneratedField("checker");
            setDirty(true);
          }}
          onCheckerLabelChange={(checkerLabel) => {
            setFields((current) => ({ ...current, checkerLabel }));
            confirmGeneratedField("checker");
            setDirty(true);
          }}
          onBack={() => setStage("desired")}
          onCancel={() => navigate(backTo)}
          onSave={() => void persistDraft()}
          onCheck={() => void beginValidation()}
        />
      ) : null}

      {stage === "validate" && savedTest ? (
        <ValidationStage
          revision={lastRevision(savedTest)}
          validation={validation}
          originalOutput={selectedResponse?.body ?? lastRevision(savedTest).badExample}
          running={validationRunning}
          manual={manualValidation}
          manualBadResult={manualBadResult}
          manualGoodResult={manualGoodResult}
          manualReason={manualReason}
          error={validationError}
          canEnable={viewerRole !== "member"}
          onBadResult={setManualBadResult}
          onGoodResult={setManualGoodResult}
          onReason={setManualReason}
          onRun={() => void runAutomatedValidation(savedTest)}
          onUseManual={() => { setManualValidation(true); setValidationError(null); }}
          onRecordManual={() => void recordManualValidation()}
          onEnable={() => void enableValidatedTest()}
          onEdit={() => { setStage("draft"); setValidationError(null); }}
          onCancel={() => navigate(backTo)}
        />
      ) : null}

      {stage === "receipt" ? (
        <ReceiptStage
          kind={receiptKind}
          test={savedTest}
          onReturn={() => navigate(`/cases/${caseId ?? detail.exception.id}`, { replace: true })}
          onReviewAccuracy={() => navigate("/reliability")}
          onCheck={() => void beginValidation()}
          run={testRun}
          runStarting={testRunStarting}
          runError={testRunError}
          onRun={() => void runEnabledTest()}
          onViewRun={(runId) => navigate(`/datasets?run=${encodeURIComponent(runId)}`)}
          onOpenSuite={() => navigate("/datasets")}
        />
      ) : null}

      {blocker.state === "blocked" ? (
        <UnsavedDialog
          canSave={stage === "draft" && job !== "verdict" && Boolean(fields.scenario.trim()) && Boolean(fields.expectedBehavior.trim())}
          incompleteDraft={stage === "draft" && (!fields.scenario.trim() || !fields.expectedBehavior.trim())}
          submitting={submitting}
          error={submitError}
          onKeep={() => blocker.reset()}
          onDiscard={() => blocker.proceed()}
          onSave={async () => {
            try {
              await persistDraft(false);
              blocker.proceed();
            } catch {
              // The inline error keeps the dialog open with a retry path.
            }
          }}
        />
      ) : null}
      </div>
    </div>
  );
}

function parseIntent(value: string | null): TraceTestIntent | null {
  return value === "prevent" || value === "protect" || value === "make" ? value : null;
}

function journeyStatus(input: {
  stage: Stage;
  receiptKind: ReceiptKind;
  drafting: boolean;
  submitting: boolean;
  validationRunning: boolean;
  validation: TraceTestValidation | null;
  validationError: string | null;
  testRunStarting: boolean;
  testRun: TraceTestRunResult | null;
  testRunError: string | null;
}): string {
  if (input.drafting) return "Drafting the test. Your description is preserved.";
  if (input.submitting) return "Saving your work.";
  if (input.validationRunning) return "Checking the test evidence.";
  if (input.testRunStarting) return "Starting the regression test run.";
  if (input.testRunError) return "The test run could not start. Retry when you are ready.";
  if (input.testRun) {
    const result = traceTestRunMessage(input.testRun);
    return `${result.title}. ${result.body}`;
  }
  if (input.validationError) return "The test check could not finish. Your draft is preserved and ready to retry.";
  if (input.stage === "validate" && input.validation) {
    if (input.validation.status === "passed") return "Validation passed. The test distinguishes the should-fail response from the should-pass response.";
    if (input.validation.status === "ambiguous" || input.validation.status === "needs_review") return "Validation needs review. The evidence does not support one clear decision.";
    if (input.validation.status === "unavailable" || input.validation.status === "evaluator_error" || input.validation.status === "could_not_run") return "Validation could not run. This is not a behavior failure.";
    return "Validation did not distinguish the should-fail response from the should-pass response.";
  }
  if (input.stage === "source") return "Source conversation step.";
  if (input.stage === "desired") return "Desired behavior step.";
  if (input.stage === "draft") return "Draft review step.";
  if (input.stage === "validate") return "Test check step.";
  if (input.receiptKind === "enabled") return "Test enabled and ready to run.";
  if (input.receiptKind === "correction") return "Correction recorded. No product test was created.";
  return "Draft saved and ready to check.";
}

function JourneyProgress({ stage, correction, completed }: { stage: Stage; correction: boolean; completed: boolean }) {
  const labels = correction ? ["Source", "Describe", "Recorded"] : ["Source", "Describe", "Draft", "Check", "Ready"];
  const current = stage === "source" ? 0
    : stage === "desired" ? 1
      : stage === "draft" ? 2
        : stage === "validate" || !completed ? Math.min(3, labels.length - 1)
          : labels.length - 1;
  return (
    <ol className="flex max-w-full items-center gap-1.5 overflow-x-auto pb-1" aria-label="Test creation progress">
      {labels.map((label, index) => (
        <li key={label} className="flex items-center gap-1.5">
          {index > 0 ? <ChevronRight className="size-3 text-ink-3" aria-hidden="true" /> : null}
          <span className={`text-[11.5px] ${index === current ? "font-medium text-ink" : index < current ? "text-ink-2" : "text-ink-3"}`} aria-current={index === current ? "step" : undefined}>
            {index < current ? <Check className="mr-1 inline size-3" aria-hidden="true" /> : null}{label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PageHeading({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-6 max-w-[72ch]">
      <h1 data-trace-test-heading tabIndex={-1} className="font-serif text-[28px] font-medium leading-tight tracking-[-0.025em] text-ink outline-none">{title}</h1>
      <p className="mt-2 text-[13.5px] leading-[1.6] text-ink-2">{body}</p>
    </div>
  );
}

interface SourceStageProps {
  detail: ExceptionDetail;
  turns: ConversationTurn[];
  responsePath: Array<string | number>;
  selectedTurns: number[];
  selectedSteps: number[];
  editingScope: boolean;
  scopeLocked: boolean;
  setEditingScope: (value: boolean) => void;
  onSelectResponse: (turn: ConversationTurn) => void;
  onToggleTurn: (turn: ConversationTurn) => void;
  onToggleStep: (stepIndex: number) => void;
  onContinue: () => void;
  onCancel: () => void;
}

function SourceStage(props: SourceStageProps) {
  const { detail, turns } = props;
  const selectedResponse = turns.find((turn) => samePath(turn.path, props.responsePath));
  return (
    <>
      <PageHeading title="What are we protecting?" body="Confirm the response and the part of the conversation that gives it meaning. Coeval keeps the complete source as evidence." />
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Source conversation</CardTitle>
            <CardDescription>
              {turns.length} turn{turns.length === 1 ? "" : "s"} · {props.scopeLocked ? "source scope is fixed for this saved draft" : "selected response stays visible in the saved test"}
            </CardDescription>
          </div>
          <div className="flex-1" />
          {!props.scopeLocked ? (
            <Button variant="ghost" size="sm" onClick={() => props.setEditingScope(!props.editingScope)}>
              {props.editingScope ? "Done choosing" : "Choose different turns"}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {turns.map((turn) => {
            const responseSelected = samePath(turn.path, props.responsePath);
            const inScope = props.selectedTurns.includes(turn.index);
            return (
              <article key={`${turn.index}-${turn.role}`} className={`rounded-sm border px-4 py-3 ${responseSelected ? "border-ink bg-paper-2" : inScope ? "border-rule-soft bg-card" : "border-rule-soft bg-card-2 opacity-65"}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{turn.role}</span>
                  {responseSelected ? <Chip>selected response</Chip> : null}
                  <span className="flex-1" />
                  {props.editingScope && !props.scopeLocked ? (
                    <label className="inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-2">
                      <input className="size-4" type="checkbox" checked={inScope} disabled={responseSelected} onChange={() => props.onToggleTurn(turn)} /> Include turn
                    </label>
                  ) : null}
                  {props.editingScope && !props.scopeLocked && turn.responseCandidate ? (
                    <label className="inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-2">
                      <input className="size-4" type="radio" name="source-response" checked={responseSelected} onChange={() => props.onSelectResponse(turn)} /> Use as response
                    </label>
                  ) : null}
                </div>
                <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.65] text-ink">{turn.body}</div>
              </article>
            );
          })}

          {detail.trace.steps?.length ? (
            <details className="rounded-sm border border-rule-soft px-4 py-3">
              <summary className="cursor-pointer text-[12.5px] font-medium text-ink-2">Intermediate steps ({detail.trace.steps.length})</summary>
              <div className="mt-3 flex flex-col gap-2 border-t border-rule-soft pt-3">
                {detail.trace.steps.map((step, stepIndex) => (
                  <label key={stepIndex} className={`flex items-start gap-2 text-[12px] text-ink-2 ${props.scopeLocked ? "cursor-default" : "cursor-pointer"}`}>
                    <input className="mt-0.5" type="checkbox" checked={props.selectedSteps.includes(stepIndex)} disabled={props.scopeLocked} onChange={() => props.onToggleStep(stepIndex)} />
                    <span><b className="font-medium text-ink">{step.name ?? `Step ${stepIndex + 1}`}</b><br />{plainText(step.output).slice(0, 240)}</span>
                  </label>
                ))}
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>
      {!selectedResponse ? (
        <div className="mt-3 rounded-sm border border-signal-tint bg-signal-wash px-3 py-2 text-[12px] text-signal" role="alert">
          This source has no assistant response to test. Return to the conversation and choose a completed response.
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={props.onContinue} disabled={!selectedResponse}>Use this response <ChevronRight /></Button>
        <Button variant="ghost" onClick={props.onCancel}>Cancel</Button>
      </div>
    </>
  );
}

interface DesiredStageProps {
  job: TraceTestJob;
  desiredBehavior: string;
  correctionResult: CorrectionResult;
  correctionReason: string;
  submitting: boolean;
  drafting: boolean;
  error: string | null;
  onJobChange: (job: TraceTestJob) => void;
  onDesiredBehaviorChange: (value: string) => void;
  onCorrectionResultChange: (value: CorrectionResult) => void;
  onCorrectionReasonChange: (value: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onDraft: () => void;
  onManual: () => void;
  onCorrection: () => void;
}

function DesiredStage(props: DesiredStageProps) {
  const choices: Array<{ value: TraceTestJob; title: string; body: string }> = [
    { value: "response", title: "The AI response", body: "Prevent an unwanted product behavior from happening again." },
    { value: "verdict", title: "Coeval's verdict", body: "Correct how Coeval judged this conversation. This will not create a product test." },
    { value: "preserve", title: "Nothing is wrong; this is worth preserving", body: "Protect the useful behavior already shown in the response." }
  ];
  return (
    <>
      <PageHeading title="What do you want to improve or protect?" body="Choose the job you are doing now. You can return to the conversation for another job afterward." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
        <fieldset className="overflow-hidden rounded-sm border border-rule-soft">
          <legend className="sr-only">What to improve or protect</legend>
          {choices.map((choice, index) => (
            <label
              key={choice.value}
              className={`flex w-full cursor-pointer items-start gap-3 px-4 py-3.5 text-left transition-colors ${index > 0 ? "border-t border-rule-soft" : ""} ${props.job === choice.value ? "bg-paper-2" : "bg-card hover:bg-card-2"}`}
            >
              <input
                className="mt-0.5 size-4 shrink-0 accent-current"
                type="radio"
                name="trace-test-job"
                value={choice.value}
                checked={props.job === choice.value}
                onChange={() => props.onJobChange(choice.value)}
              />
              <span><b className="block text-[13px] font-medium text-ink">{choice.title}</b><span className="mt-0.5 block text-[12px] leading-[1.5] text-ink-3">{choice.body}</span></span>
            </label>
          ))}
        </fieldset>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>{props.job === "verdict" ? "Record the correct result" : "Describe the desired behavior"}</CardTitle>
              <CardDescription>{props.job === "verdict" ? "This becomes evaluator feedback, not a regression test." : "Your words remain authoritative in the saved draft."}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {props.job === "verdict" ? (
              <>
                <fieldset>
                  <legend className="mb-1.5 text-[12.5px] font-medium text-ink">Correct result</legend>
                  <div className="flex flex-wrap gap-2">
                    {(["pass", "fail", "needs_review"] as CorrectionResult[]).map((result) => (
                      <label key={result} className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm border px-2 text-[11.5px] transition-colors ${props.correctionResult === result ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink hover:bg-card-2"}`}>
                        <input className="size-3 accent-current" type="radio" name="correction-result" value={result} checked={props.correctionResult === result} onChange={() => props.onCorrectionResultChange(result)} />
                        <span>{result === "needs_review" ? "Needs review" : result[0]?.toUpperCase() + result.slice(1)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <FieldLabel label="Why is that the right result?">
                  <textarea className={`${INPUT_CLASS} min-h-32 resize-y`} value={props.correctionReason} onChange={(event) => props.onCorrectionReasonChange(event.target.value)} placeholder="Ground the correction in what happened in the source conversation." />
                </FieldLabel>
              </>
            ) : (
              <FieldLabel label="What should happen when this situation comes up again?">
                <textarea className={`${INPUT_CLASS} min-h-40 resize-y`} value={props.desiredBehavior} onChange={(event) => props.onDesiredBehaviorChange(event.target.value)} placeholder="For example: explain the cancellation path and check eligibility before promising a refund." autoFocus />
              </FieldLabel>
            )}
            {props.error ? <InlineError>{props.error}</InlineError> : null}
          </CardContent>
        </Card>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {props.job === "verdict" ? (
          <Button variant="primary" disabled={props.submitting || !props.correctionReason.trim()} onClick={props.onCorrection}>{props.submitting ? "Recording…" : "Record correction"}</Button>
        ) : (
          <>
            <Button variant="primary" disabled={props.drafting || !props.desiredBehavior.trim()} onClick={props.onDraft}>
              {props.drafting ? "Drafting…" : "Draft the test"} {!props.drafting ? <ChevronRight /> : null}
            </Button>
            <Button variant="outline" disabled={!props.desiredBehavior.trim()} onClick={props.onManual}>Write it myself</Button>
          </>
        )}
        <Button variant="ghost" onClick={props.onBack} disabled={props.submitting}><ArrowLeft /> Back</Button>
        <Button variant="ghost" onClick={props.onCancel} disabled={props.submitting}>Cancel</Button>
      </div>
    </>
  );
}

interface DraftStageProps {
  detail: ExceptionDetail;
  turns: ConversationTurn[];
  scope: TraceTestSourceScope;
  fields: ManualTraceTestFields;
  suggestedFields: TraceTestDraftField[];
  inferredContext: string[];
  assistNotice: string | null;
  submitting: boolean;
  error: string | null;
  isRevision: boolean;
  canCheckSaved: boolean;
  onChange: (field: EditableDraftTextField, value: string) => void;
  onCheckerKindChange: (kind: "judge" | "manual") => void;
  onCheckerLabelChange: (label: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onSave: () => void;
  onCheck: () => void;
}

function DraftStage(props: DraftStageProps) {
  const suggested = (field: TraceTestDraftField) => props.suggestedFields.includes(field);
  return (
    <>
      <PageHeading title="Does this capture the behavior you want?" body="Everything here is editable. Save it as a draft now; checking and enabling it remain separate steps." />
      {props.assistNotice ? (
        <div className="mb-4 rounded-sm border border-rule-soft bg-paper-2 px-3 py-2 text-[12px] leading-[1.5] text-ink-2" role="status">
          {props.assistNotice}
        </div>
      ) : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Test draft</CardTitle>
              <CardDescription>Review the suggestions, change anything, then save. Nothing is enabled automatically.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <FieldLabel label="Scenario" hint="The smallest replayable input and necessary context." suggested={suggested("scenario")}>
              <textarea className={`${INPUT_CLASS} min-h-28 resize-y`} value={props.fields.scenario} onChange={(event) => props.onChange("scenario", event.target.value)} />
            </FieldLabel>
            <FieldLabel label="Expected behavior" hint="The outcome in plain language." suggested={suggested("expectedBehavior")}>
              <textarea className={`${INPUT_CLASS} min-h-28 resize-y`} value={props.fields.expectedBehavior} onChange={(event) => props.onChange("expectedBehavior", event.target.value)} />
            </FieldLabel>
            <div className="grid gap-4 md:grid-cols-2">
              <FieldLabel label="Must do" hint="One observable requirement per line." suggested={suggested("mustDo")}>
                <textarea className={`${INPUT_CLASS} min-h-28 resize-y`} value={props.fields.mustDo} onChange={(event) => props.onChange("mustDo", event.target.value)} placeholder="Check eligibility" />
              </FieldLabel>
              <FieldLabel label="Must avoid" hint="One prohibited behavior per line." suggested={suggested("mustAvoid")}>
                <textarea className={`${INPUT_CLASS} min-h-28 resize-y`} value={props.fields.mustAvoid} onChange={(event) => props.onChange("mustAvoid", event.target.value)} placeholder="Promise an outcome without evidence" />
              </FieldLabel>
            </div>
            <div className="border-t border-rule-soft pt-5">
              <h2 className="font-serif text-[16px] font-medium text-ink">Examples</h2>
              <p className="mt-1 text-[12px] text-ink-3">Write or paste one response that should pass and one that should fail. A blank example is allowed in a saved draft.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <FieldLabel label="Should pass" suggested={suggested("goodExample")}>
                  <textarea className={`${INPUT_CLASS} min-h-36 resize-y`} value={props.fields.goodExample} onChange={(event) => props.onChange("goodExample", event.target.value)} placeholder="A response showing the behavior you want" />
                </FieldLabel>
                <FieldLabel label="Should fail" suggested={suggested("badExample")}>
                  <textarea className={`${INPUT_CLASS} min-h-36 resize-y`} value={props.fields.badExample} onChange={(event) => props.onChange("badExample", event.target.value)} placeholder="A response showing the behavior you do not want" />
                </FieldLabel>
              </div>
            </div>
            {props.inferredContext.length > 0 ? (
              <div className="rounded-sm border border-rule-soft bg-paper-2 px-4 py-3">
                <div className="text-[12.5px] font-medium text-ink">Coeval inferred — review these</div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] leading-[1.5] text-ink-2">
                  {props.inferredContext.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            <div className="border-t border-rule-soft pt-5">
              <div className="mb-3 flex items-center gap-2">
                <div>
                  <h2 className="font-serif text-[16px] font-medium text-ink">How should this be checked?</h2>
                  <p className="mt-1 text-[12px] text-ink-3">This is an editable recommendation. Checking happens only after you save.</p>
                </div>
                {suggested("checker") ? <SuggestedMark /> : null}
              </div>
              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="sr-only">Checker type</legend>
                {([
                  { kind: "judge" as const, title: "AI behavior check", body: "Judge whether the response follows this behavior." },
                  { kind: "manual" as const, title: "Manual review", body: "A person decides whether the response passes." }
                ]).map((choice) => (
                  <label key={choice.kind} className={`flex cursor-pointer items-start gap-2 rounded-sm border px-3 py-2.5 ${props.fields.checkerKind === choice.kind ? "border-ink bg-paper-2" : "border-rule-soft bg-card-2"}`}>
                    <input className="mt-0.5 size-4 accent-current" type="radio" name="trace-test-checker" checked={props.fields.checkerKind === choice.kind} onChange={() => props.onCheckerKindChange(choice.kind)} />
                    <span><b className="block text-[12.5px] font-medium text-ink">{choice.title}</b><span className="mt-0.5 block text-[11.5px] leading-[1.45] text-ink-3">{choice.body}</span></span>
                  </label>
                ))}
              </fieldset>
              <div className="mt-3">
                <FieldLabel label="Check name">
                  <input className={INPUT_CLASS} value={props.fields.checkerLabel} onChange={(event) => props.onCheckerLabelChange(event.target.value)} />
                </FieldLabel>
              </div>
              {props.fields.checkerRationale ? <p className="mt-2 text-[11.5px] leading-[1.45] text-ink-3">Why Coeval suggested it: {props.fields.checkerRationale}</p> : null}
            </div>
            {props.error ? <InlineError>{props.error}</InlineError> : null}
          </CardContent>
        </Card>
        <SourceSummary detail={props.detail} turns={props.turns} scope={props.scope} />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {props.canCheckSaved ? (
          <Button variant="primary" onClick={props.onCheck}><Check /> Check this draft</Button>
        ) : (
          <Button variant="primary" disabled={props.submitting || !props.fields.scenario.trim() || !props.fields.expectedBehavior.trim()} onClick={props.onSave}>
            <FileCheck2 /> {props.submitting ? "Saving…" : props.isRevision ? "Save changes" : "Save draft"}
          </Button>
        )}
        <Button variant="ghost" onClick={props.onBack} disabled={props.submitting}><ArrowLeft /> Back</Button>
        <Button variant="ghost" onClick={props.onCancel} disabled={props.submitting}>Cancel</Button>
      </div>
    </>
  );
}

interface ValidationStageProps {
  revision: TraceTestRevision;
  validation: TraceTestValidation | null;
  originalOutput: unknown;
  running: boolean;
  manual: boolean;
  manualBadResult: "pass" | "fail" | "ambiguous";
  manualGoodResult: "pass" | "fail" | "ambiguous";
  manualReason: string;
  error: string | null;
  canEnable: boolean;
  onBadResult: (result: "pass" | "fail" | "ambiguous") => void;
  onGoodResult: (result: "pass" | "fail" | "ambiguous") => void;
  onReason: (reason: string) => void;
  onRun: () => void;
  onUseManual: () => void;
  onRecordManual: () => void;
  onEnable: () => void;
  onEdit: () => void;
  onCancel: () => void;
}

function ValidationStage(props: ValidationStageProps) {
  const operationalFailure = props.validation?.status === "unavailable" || props.validation?.status === "evaluator_error";
  const preservesOriginal = props.revision.checker.metadata.journeyJob === "preserve";
  const uncheckedBadOutput = preservesOriginal ? props.revision.badExample : props.originalOutput;
  const uncheckedGoodOutput = preservesOriginal ? props.originalOutput : props.revision.goodExample;
  const enableEligible = validationIsEnableEligible(props.validation);
  const result = props.validation ? validationMessage(props.validation) : null;
  return (
    <>
      <PageHeading
        title="Can this test tell good from bad?"
        body={preservesOriginal
          ? "Coeval checks a known-bad response and the original response you want to preserve. Only the expected fail/pass split can make the draft ready."
          : "Coeval checks the original unwanted response and the known-good response separately. Only the expected fail/pass split can make the draft ready."}
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ValidationEvidenceCard
          title={preservesOriginal ? "Known-bad response" : "Original response"}
          expectation="Should fail"
          output={props.validation?.badEvidence.output ?? uncheckedBadOutput}
          result={props.validation?.badEvidence.result ?? null}
          note={props.validation?.badEvidence.note ?? null}
        />
        <ValidationEvidenceCard
          title={preservesOriginal ? "Original response" : "Known-good response"}
          expectation="Should pass"
          output={props.validation?.goodEvidence.output ?? uncheckedGoodOutput}
          result={props.validation?.goodEvidence.result ?? null}
          note={props.validation?.goodEvidence.note ?? null}
        />
      </div>

      {props.running ? (
        <div className="mt-5 rounded-sm border border-rule-soft bg-paper-2 px-4 py-3 text-[12.5px] text-ink-2" role="status">
          Checking both examples… provider failures will be recorded separately from behavior results.
        </div>
      ) : null}
      {result && !props.manual ? (
        <div className={`mt-5 rounded-sm border px-4 py-3 ${props.validation?.status === "passed" ? "border-rule bg-card" : "border-signal-tint bg-signal-wash"}`} role="status">
          <div className="text-[13px] font-medium text-ink">{result.title}</div>
          <p className="mt-1 text-[12px] leading-[1.5] text-ink-2">{result.body}</p>
        </div>
      ) : null}

      {props.manual ? (
        <Card className="mt-5">
          <CardHeader>
            <div><CardTitle>Confirm the evidence yourself</CardTitle><CardDescription>Choose what each response demonstrates, then explain why. This reason stays with the validation record.</CardDescription></div>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2">
            <ManualOutcomeField label={preservesOriginal ? "Known-bad response result" : "Original response result"} value={props.manualBadResult} onChange={props.onBadResult} />
            <ManualOutcomeField label={preservesOriginal ? "Original response result" : "Known-good response result"} value={props.manualGoodResult} onChange={props.onGoodResult} />
            <div className="md:col-span-2">
              <FieldLabel label="Why do these examples prove the test works?" hint="Be specific enough that another person could verify your decision.">
                <textarea className={`${INPUT_CLASS} min-h-28 resize-y`} value={props.manualReason} onChange={(event) => props.onReason(event.target.value)} placeholder="The original response promises an unknown outcome, while the known-good response checks eligibility first." />
              </FieldLabel>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {props.error ? <div className="mt-4"><InlineError>{props.error}</InlineError></div> : null}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {props.manual ? (
          <Button variant="primary" disabled={props.running || props.manualReason.trim().length < 10} onClick={props.onRecordManual}>
            {props.running ? "Recording…" : "Record this evidence"}
          </Button>
        ) : enableEligible && props.canEnable ? (
          <Button variant="primary" disabled={props.running} onClick={props.onEnable}><Check /> Enable this test</Button>
        ) : null}
        {!props.manual && enableEligible && !props.canEnable ? (
          <span className="text-[12px] text-ink-2">Ready for a project owner to enable.</span>
        ) : null}
        {!props.manual && props.revision.checker.kind === "judge" && (props.error || (props.validation && props.validation.status !== "passed")) ? (
          <Button variant="outline" disabled={props.running} onClick={props.onRun}>Retry check</Button>
        ) : null}
        {!props.manual && (props.revision.checker.kind !== "judge" || operationalFailure || props.error) ? (
          <Button variant="outline" disabled={props.running} onClick={props.onUseManual}>Review manually instead</Button>
        ) : null}
        <Button variant="ghost" disabled={props.running} onClick={props.onEdit}><ArrowLeft /> Edit draft</Button>
        <Button variant="ghost" disabled={props.running} onClick={props.onCancel}>Return to conversation</Button>
      </div>
    </>
  );
}

function ValidationEvidenceCard(props: {
  title: string;
  expectation: string;
  output: unknown;
  result: TraceTestValidationOutcome | null;
  note: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div><CardTitle>{props.title}</CardTitle><CardDescription>{props.expectation}</CardDescription></div>
        {props.result ? <Chip>{validationOutcomeLabel(props.result)}</Chip> : null}
      </CardHeader>
      <CardContent>
        <div className="max-h-52 overflow-auto whitespace-pre-wrap rounded-sm border border-rule-soft bg-card-2 px-3 py-3 text-[12.5px] leading-[1.55] text-ink">{exampleText(props.output) || "No response provided"}</div>
        {props.note ? <p className="mt-3 text-[11.5px] leading-[1.5] text-ink-3">{props.note}</p> : null}
      </CardContent>
    </Card>
  );
}

function ManualOutcomeField(props: { label: string; value: "pass" | "fail" | "ambiguous"; onChange: (value: "pass" | "fail" | "ambiguous") => void }) {
  return (
    <fieldset>
      <legend className="mb-2 text-[12.5px] font-medium text-ink">{props.label}</legend>
      <div className="flex flex-wrap gap-2">
        {(["fail", "pass", "ambiguous"] as const).map((result) => (
          <label key={result} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-[11.5px] ${props.value === result ? "border-ink bg-ink text-paper" : "border-rule-soft bg-card-2 text-ink"}`}>
            <input className="size-3 accent-current" type="radio" checked={props.value === result} onChange={() => props.onChange(result)} />
            {result === "ambiguous" ? "Not sure" : result[0]?.toUpperCase() + result.slice(1)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function validationOutcomeLabel(result: TraceTestValidationOutcome): string {
  if (result === "pass") return "Pass";
  if (result === "fail") return "Fail";
  if (result === "ambiguous" || result === "needs_review") return "Not sure";
  if (result === "evaluator_error") return "Evaluator error";
  return "Unavailable";
}

function validationMessage(validation: TraceTestValidation): { title: string; body: string } {
  if (validation.status === "passed") return { title: "The test distinguishes the examples", body: "The should-fail example failed and the should-pass example passed. This exact revision is ready for an owner to enable." };
  if (validation.diagnostic === "always_pass") return { title: "This check passes everything", body: "Both examples passed, so this test would miss the unwanted behavior. Edit the requirements or checker before enabling." };
  if (validation.diagnostic === "always_fail") return { title: "This check fails everything", body: "Both examples failed, so this test would block good behavior too. Edit the requirements or checker before enabling." };
  if (validation.diagnostic === "reversed") return { title: "The results are reversed", body: "The should-fail example passed or the should-pass example failed. Edit the draft before enabling." };
  if (validation.status === "ambiguous" || validation.status === "needs_review") return { title: "The evidence is ambiguous", body: "The checker could not decide from at least one response. Ambiguity never enables a blocking test." };
  if (validation.status === "evaluator_error") return { title: "The evaluator failed", body: "This is an infrastructure result, not a behavioral fail. Retry or review the examples manually." };
  return { title: "The automated check is unavailable", body: "No behavioral result was inferred. Add missing examples, retry after configuration is fixed, or review the evidence manually." };
}

function SourceSummary({ detail, turns, scope }: { detail: ExceptionDetail; turns: ConversationTurn[]; scope: TraceTestSourceScope }) {
  const scopedTurns = turns.filter((turn) => scope.turnIndexes.includes(turn.index));
  const response = turns.find((turn) => samePath(turn.path, scope.responsePath));
  return (
    <aside className="rounded-sm border border-rule-soft bg-card px-4 py-4 lg:sticky lg:top-5" aria-label="Selected source">
      <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-ink-2" /><h2 className="font-serif text-[15px] font-medium text-ink">Source stays attached</h2></div>
      <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-3">Coeval keeps the full conversation. This summary shows the selected scope.</p>
      <div className="mt-4 flex flex-col gap-3">
        {scopedTurns.map((turn) => (
          <div key={turn.index} className="border-t border-rule-soft pt-3 first:border-0 first:pt-0">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">{turn.role}{response?.index === turn.index ? " · selected response" : ""}</div>
            <div className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-[11.5px] leading-[1.55] text-ink-2">{turn.body}</div>
          </div>
        ))}
      </div>
      {scope.stepIndexes.length > 0 ? <div className="mt-3 border-t border-rule-soft pt-3 text-[11px] text-ink-3">{scope.stepIndexes.length} intermediate step{scope.stepIndexes.length === 1 ? "" : "s"} included</div> : null}
      <div className="mt-3 font-mono text-[10.5px] text-ink-3">{detail.trace.id}</div>
    </aside>
  );
}

function ReceiptStage({
  kind,
  test,
  run,
  runStarting,
  runError,
  onReturn,
  onReviewAccuracy,
  onCheck,
  onRun,
  onViewRun,
  onOpenSuite
}: {
  kind: ReceiptKind;
  test: TraceTestDetail | null;
  run: TraceTestRunResult | null;
  runStarting: boolean;
  runError: string | null;
  onReturn: () => void;
  onReviewAccuracy: () => void;
  onCheck: () => void;
  onRun: () => void;
  onViewRun: (runId: string) => void;
  onOpenSuite: () => void;
}) {
  if (kind === "correction") {
    return (
      <div className="mx-auto max-w-2xl pt-10">
        <Receipt icon={<Check className="size-4" />} meta="Evaluator feedback">
          <b>Correction recorded.</b> Coeval saved your result on the source conversation. No product test was created.
        </Receipt>
        <h1 data-trace-test-heading tabIndex={-1} className="mt-7 font-serif text-[30px] font-medium tracking-[-0.025em] text-ink outline-none">Evaluator correction recorded</h1>
        <p className="mt-2 max-w-[65ch] text-[13.5px] leading-[1.65] text-ink-2">The ruling is now part of the source case's ungoverned review history. It can inform later evaluator changes, but it does not create a regression test or governed calibration evidence.</p>
        <div className="mt-6 flex flex-wrap gap-2"><Button variant="primary" onClick={onReviewAccuracy}>Review evaluator accuracy</Button><Button variant="ghost" onClick={onReturn}>Return to conversation</Button></div>
      </div>
    );
  }
  if (kind === "enabled") {
    const result = run ? traceTestRunMessage(run) : null;
    return (
      <div className="mx-auto max-w-2xl pt-10">
        <Receipt icon={<Check className="size-4" />} meta={test ? `Test ${test.id}` : "Test enabled"}>
          <b>Test enabled.</b> The validated revision is now ready for normal use.
        </Receipt>
        <h1 data-trace-test-heading tabIndex={-1} className="mt-7 font-serif text-[30px] font-medium tracking-[-0.025em] text-ink outline-none">Test enabled</h1>
        <p className="mt-2 max-w-[65ch] text-[13.5px] leading-[1.65] text-ink-2">Run the enabled test against the current evaluator. Coeval adds the test to Regression tests and keeps each run linked to the validated evidence.</p>
        {result ? (
          <div className="mt-5 rounded-sm border border-rule-soft bg-paper-2 px-4 py-3" role="status">
            <div className="text-[13px] font-medium text-ink">{result.title}</div>
            <p className="mt-1 text-[12px] leading-[1.5] text-ink-2">{result.body}</p>
          </div>
        ) : null}
        {runError ? <div className="mt-4"><InlineError>{runError}</InlineError></div> : null}
        <div className="mt-6 flex flex-wrap gap-2">
          {run ? (
            <Button variant="primary" onClick={() => onViewRun(run.run.id)}>View run</Button>
          ) : (
            <Button variant="primary" disabled={runStarting} onClick={onRun}><Play /> {runStarting ? "Running…" : runError ? "Retry run" : "Run now"}</Button>
          )}
          {run ? <Button variant="outline" onClick={onOpenSuite}>Open Regression tests</Button> : null}
          <Button variant="ghost" onClick={onReturn}>Return to conversation</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl pt-10">
      <Receipt icon={<FileCheck2 className="size-4" />} meta={test ? `Draft ${test.id}` : "Draft saved"}>
        <b>Draft saved.</b> It is not enabled and has not been run.
      </Receipt>
      <h1 data-trace-test-heading tabIndex={-1} className="mt-7 font-serif text-[30px] font-medium tracking-[-0.025em] text-ink outline-none">Test draft saved</h1>
      <p className="mt-2 max-w-[65ch] text-[13.5px] leading-[1.65] text-ink-2">The draft keeps the source conversation and selected scope. Reopen it from the conversation when you are ready to check and enable it.</p>
      <div className="mt-6 flex flex-wrap gap-2"><Button variant="primary" onClick={onCheck}>Check this test</Button><Button variant="ghost" onClick={onReturn}>Return to conversation</Button></div>
    </div>
  );
}

function traceTestRunMessage(result: TraceTestRunResult): { title: string; body: string } {
  if (result.outcome === "passed") return { title: "Passed", body: "The current evaluator behaved as this test expected." };
  if (result.outcome === "regressed") return { title: "Regressed", body: "The evaluator's result disagreed with the behavior this test protects." };
  if (result.outcome === "needs_review") return { title: "Needs review", body: "The evaluator could not make a clear behavior decision from this case." };
  if (result.outcome === "could_not_run") return { title: "Could not run", body: "A runtime or provider problem stopped the check. This is not a behavior regression." };
  return { title: "Running", body: "The run has started. Open it to follow progress." };
}

function SuggestedMark() {
  return <span className="inline-flex rounded-sm border border-rule-soft bg-card px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-ink-3">Suggested</span>;
}

function FieldLabel({ label, hint, suggested, children }: { label: string; hint?: string; suggested?: boolean; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-ink">{label}{suggested ? <SuggestedMark /> : null}</span>{hint ? <span className="mb-2 block text-[11.5px] leading-[1.45] text-ink-3">{hint}</span> : null}{children}</label>;
}

function InlineError({ children }: { children: React.ReactNode }) {
  return <div className="rounded-sm border border-signal-tint bg-signal-wash px-3 py-2 text-[12px] text-signal" role="alert">{children}</div>;
}

function LocalState({ title, body }: { title: string; body: string }) {
  return <Card className="mx-auto mt-10 max-w-2xl"><CardContent className="py-8"><h1 data-trace-test-heading tabIndex={-1} className="font-serif text-[22px] font-medium text-ink outline-none">{title}</h1><p className="mt-2 text-[13px] leading-[1.6] text-ink-2">{body}</p></CardContent></Card>;
}

function UnsavedDialog({ canSave, incompleteDraft, submitting, error, onKeep, onDiscard, onSave }: { canSave: boolean; incompleteDraft: boolean; submitting: boolean; error: string | null; onKeep: () => void; onDiscard: () => void; onSave: () => Promise<void> }) {
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({
    onClose: onKeep,
    closeOnEscape: !submitting,
    initialFocusRef: firstActionRef
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-start overflow-y-auto bg-ink/35 p-4 sm:place-items-center" role="presentation">
      <div ref={dialogRef} tabIndex={-1} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-sm border border-rule bg-card p-5 shadow-[0_12px_34px_rgba(0,0,0,0.18)]" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-description">
        <div className="flex items-start gap-3"><div className="flex-1"><h2 id="unsaved-title" className="font-serif text-[18px] font-medium text-ink">Leave with unsaved changes?</h2><p id="unsaved-description" className="mt-1.5 text-[12.5px] leading-[1.55] text-ink-2">{canSave ? "Keep editing, save the test as a draft, or discard the changes you made here." : incompleteDraft ? "Complete Scenario and Expected behavior before saving, or discard the changes you made here." : "Keep editing or discard the changes you made here."}</p></div><Button variant="ghost" size="icon" onClick={onKeep} aria-label="Keep editing"><X /></Button></div>
        {error ? <div className="mt-3"><InlineError>{error}</InlineError></div> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button ref={firstActionRef} variant="ghost" onClick={onKeep} disabled={submitting}>Keep editing</Button>
          <Button variant="outline" onClick={onDiscard} disabled={submitting}>Discard changes</Button>
          {canSave ? <Button variant="primary" onClick={() => void onSave()} disabled={submitting}>{submitting ? "Saving…" : "Save draft"}</Button> : null}
        </div>
      </div>
    </div>
  );
}
