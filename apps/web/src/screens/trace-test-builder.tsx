import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ArrowLeft
} from "lucide-react";
import {
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";
import {
  Button
} from "@/components/ui/button";
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
  reviseTraceTest,
  runTraceTestValidation,
  startTraceTestRun
} from "@/lib/api";
import {
  conversationTurns,
  type CorrectionResult,
  correctionVerdictPayload,
  createManualTraceTestInput,
  defaultSourceSelection,
  initialJobForIntent,
  intentForVerdict,
  manualFields,
  type ManualTraceTestFields,
  samePath,
  type TraceTestIntent,
  type TraceTestJob
} from "@/lib/trace-test-flow";
import {
  createTraceTestFunnel,
  type TraceTestFunnel
} from "@/lib/trace-test-pilot";
import {
  useCriterion
} from "@/lib/criterion-context";
import {
  useDashboard
} from "@/lib/dashboard-context";
import {
  dashboardSkillVersionId
} from "@/lib/criterion-scope";
import {
  type ExceptionDetail,
  type TraceTestDetail,
  type TraceTestDraftField,
  type TraceTestDraftProvenance,
  type TraceTestRunResult,
  type TraceTestSourceScope,
  type TraceTestValidation
} from "@coeval/shared";
import {
  type EditableDraftTextField,
  type ReceiptKind,
  type Stage,
  DesiredStage,
  DraftStage,
  EMPTY_FIELDS,
  HUMAN_PROVENANCE,
  JourneyProgress,
  LocalState,
  MOBILE_FOCUS_CLASS,
  ReceiptStage,
  SourceStage,
  UnsavedDialog,
  ValidationStage,
  exampleText,
  journeyStatus,
  lastRevision,
  parseIntent,
  restoredInferredContext,
  restoredJob
} from "./trace-test-builder/components.js";

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
