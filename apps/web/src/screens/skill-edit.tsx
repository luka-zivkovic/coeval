import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, Clock, LoaderCircle, RefreshCcw, ShieldAlert, Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownPreview } from "@/components/markdown-preview";
import { FirstRunCheckSetup } from "@/components/first-run-check-setup";
import {
  SkillChangeReview,
  SkillEditFlow,
  type SkillEditOutcome,
  type SkillEditPhase
} from "@/components/skill-edit-flow";
import { Chip, Eyebrow, GateStrip, KPI, KPIRow, MarginNote, RegressionDiffTable, SectionHead } from "@/components/coeval";
import {
  createSkillVersion,
  createOnboardingCheck,
  fetchDatasetRevisionMetadata,
  fetchJudgeModels,
  fetchJudgeProviders,
  fetchLatestSkill,
  fetchOnboardingEvidenceInventory,
  fetchSkillVersionCriterion,
  fetchSkillVersionRegression,
  fetchSkillVersions,
  type CompletedSkillVersionResult,
  type CreateSkillVersionResult
} from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { useCriterion } from "@/lib/criterion-context";
import { skillCriterionVersionId } from "@/lib/criterion-scope";
import { resolveJudgeProviderSelection } from "@/lib/judge-provider-selection";
import { firstResultPath, isBench, markSetupReceipt } from "@/lib/journey";
import {
  clearOnboardingCheckDraft,
  draftFromStarter,
  loadOnboardingCheckDraft,
  onboardingCheckDraftIdentity,
  recommendationReason,
  recommendStarterSkill,
  saveOnboardingCheckDraft,
  type OnboardingCheckDraft
} from "@/lib/onboarding-check";
import { STARTER_SKILLS, findStarterSkill, type StarterSkill } from "@/lib/starter-skills";
import { cn } from "@/lib/utils";
import { verdictKindDescription } from "@/lib/verdict-kind";
import { shouldRegenerateVerdictOutputSchema, skillEditOperationIsCurrent } from "@/lib/skill-edit-flow";
import {
  compileJudgePrompt,
  regressionDirectionCounts,
  verdictOutputSchema,
  type CriterionVersion,
  type CreateSkillVersionInput,
  type JudgeModel,
  type JudgeProviderAvailabilityItem,
  type JudgeProviderId,
  type OnboardingEvidenceInventory,
  type RegressionCaseDiff,
  type Skill,
  type SkillVersion,
  type SkillVersionTimeScope,
  type VerdictKind
} from "@coeval/shared";

// A regression isn't always "pass → fail": a fail anchor the new version now
// passes is a LENIENT regression. Spell out each direction so the tile never
// claims a direction the diff table below contradicts.
function regressionDirectionSummary(cases: RegressionCaseDiff[]): string {
  const { tooStrict, tooLenient, ambiguous } = regressionDirectionCounts(cases);
  const parts: string[] = [];
  if (tooStrict > 0) parts.push(`${tooStrict} pass → fail`);
  if (tooLenient > 0) parts.push(`${tooLenient} fail → pass`);
  if (ambiguous > 0) parts.push(`${ambiguous} → ambiguous`);
  return parts.join(" · ") || "vs promoted reference labels";
}

const TIME_SCOPES: ReadonlyArray<{ value: SkillVersionTimeScope; label: string; hint: string }> = [
  { value: "new", label: "New traces only", hint: "Future traces use this version. Existing verdicts untouched." },
  { value: "existing", label: "Re-judge existing", hint: "Backfill every existing case against this version." },
  { value: "both", label: "New + existing", hint: "Future traces and a full backfill of existing cases." }
];

export function SkillEditScreen() {
  const navigate = useNavigate();
  const {
    selectedCriterionId,
    selectedChoice,
    loading: criterionLoading,
    href: criterionHref
  } = useCriterion();
  const [searchParams, setSearchParams] = useSearchParams();
  const starterParam = searchParams.get("starter");
  const firstRun = searchParams.get("first") === "1";
  const resumeVersionId = searchParams.get("version");
  const { dashboard, refresh } = useDashboard();
  // "dashboard not loaded" is NOT "zero evidence": every branch keyed on these
  // counts must first check dashboardReady, or a slow fetch renders the day-0
  // UI (wrong CTA route, hidden backfill choice) on a mature project. And the
  // SPA's counts only move on in-app actions — traces ingested server-side
  // (pollers, another tab) never bump them — so revalidate on mount.
  const dashboardReady = dashboard != null;
  const goldenSetSize = dashboard?.goldenSetSize ?? 0;
  const evidenceCount = dashboard?.project.importedTraceCount ?? 0;
  const bench = dashboard ? isBench(dashboard.project) : false;
  // Gate copy may only degrade to the unarmed wording once the dashboard has
  // actually said the golden set is empty; while loading, keep the regression
  // wording (the pre-onboarding default) rather than flashing day-0 UI.
  const gateKnownUnarmed = dashboardReady && goldenSetSize === 0;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const [skill, setSkill] = useState<Skill | null>(null);
  const [baseVersion, setBaseVersion] = useState<SkillVersion | null>(null);
  const [loadedCriterionId, setLoadedCriterionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const operationGeneration = useRef(0);
  const criterionScope = useRef(selectedCriterionId);
  const skillScope = useRef<string | null>(skill?.id ?? null);
  skillScope.current = skill?.id ?? null;
  // Invalidate a pending writer during the render that observes a criterion
  // switch. Waiting for the load effect leaves a small window where the old
  // response can restore its version query onto the new criterion route.
  if (criterionScope.current !== selectedCriterionId) {
    criterionScope.current = selectedCriterionId;
    operationGeneration.current += 1;
  }

  // Editable fields.
  const [rubric, setRubric] = useState("");
  const [rubricMode, setRubricMode] = useState<"source" | "preview">("source");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<JudgeProviderId>("mock");
  const [providerOptions, setProviderOptions] = useState<JudgeProviderAvailabilityItem[]>([]);
  const [modelId, setModelId] = useState("");
  const [modelVersion, setModelVersion] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<JudgeModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [temperature, setTemperature] = useState("0");
  // First-run setup starts from an already-recorded Run whenever one exists;
  // keep the new Check on future Runs and enqueue the existing evidence after
  // its regression gate. The ordinary editor preserves the safer new-only
  // default for later changes.
  const [timeScope, setTimeScope] = useState<SkillVersionTimeScope>(firstRun ? "both" : "new");
  // The judge prompt template is an advanced concern — most users should only touch the
  // rubric. Collapsed by default; the disconnect warning below stays visible
  // either way.
  const [showPromptEditor, setShowPromptEditor] = useState(false);

  // Verdict shape. Defaults from the current version; a starter template can
  // override it (starters declare their own kind + choice scores). Not editable
  // via UI controls — only set by load() or applying a starter.
  const [verdictKind, setVerdictKind] = useState<VerdictKind>("binary");
  const [choiceScores, setChoiceScores] = useState<Record<string, number> | null>(null);
  const [scalarRange, setScalarRange] = useState<[number, number] | null>(null);
  const [appliedStarter, setAppliedStarter] = useState<StarterSkill | null>(null);
  // This records ownership of the result contract separately from the visual
  // template marker. Editing the template clears its selected styling, but it
  // must not make save fall back to a legacy schema from the base version.
  const [starterSuppliedOutputContract, setStarterSuppliedOutputContract] = useState(false);
  const [onboardingDraft, setOnboardingDraft] = useState<OnboardingCheckDraft | null>(null);
  const [refiningOnboardingDraft, setRefiningOnboardingDraft] = useState(false);
  const [onboardingCriterionVersion, setOnboardingCriterionVersion] = useState<CriterionVersion | null>(null);
  const [onboardingEvidenceInventory, setOnboardingEvidenceInventory] = useState<OnboardingEvidenceInventory | null>(null);
  const onboardingDraftIdentityRef = useRef<string | null>(null);
  onboardingDraftIdentityRef.current = onboardingDraft ? onboardingCheckDraftIdentity(onboardingDraft) : null;

  // Submit / result state.
  const [phase, setPhase] = useState<SkillEditPhase>("edit");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pendingVersion, setPendingVersion] = useState<SkillVersion | null>(null);
  const [pinnedReferenceCount, setPinnedReferenceCount] = useState<number | null>(null);
  const [result, setResult] = useState<CompletedSkillVersionResult | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  // Apply a starter template's content over the form. Model binding stays as
  // whatever's loaded (the team's existing pinned model) — starters
  // deliberately don't include a binding, to avoid pinning a version that drifts.
  const applyStarter = useCallback((starter: StarterSkill) => {
    setRubric(starter.rubricMarkdown);
    setPrompt(starter.prompt);
    setVerdictKind(starter.verdictKind);
    setChoiceScores(starter.categoricalChoiceScores ?? null);
    setScalarRange(null);
    setAppliedStarter(starter);
    setStarterSuppliedOutputContract(true);
  }, []);

  // Reset content + verdict-shape fields to the current version.
  // Used by the "Reset to vX" button — deliberately ignores any `?starter=`
  // param so the button does what its label says (revert to the current version),
  // not silently re-apply the template.
  const applyCurrentVersion = useCallback((s: Skill) => {
    const v = s.currentVersion;
    setRubric(v.rubricMarkdown);
    setPrompt(v.prompt);
    setVerdictKind(v.verdictKind);
    setChoiceScores(v.categoricalChoiceScores);
    setScalarRange(v.scalarRange);
    setAppliedStarter(null);
    setStarterSuppliedOutputContract(false);
  }, []);

  const resetToCurrent = useCallback(() => {
    if (!skill) return;
    applyCurrentVersion(skill);
    const binding = skill.currentVersion.modelBinding;
    const { provider: resetProvider, preservesBinding } = resolveJudgeProviderSelection(binding.provider, providerOptions);
    setProvider(resetProvider);
    setModelId(preservesBinding ? binding.modelId : "");
    setModelVersion(preservesBinding ? binding.modelVersion : "");
    setBaseUrl(preservesBinding && resetProvider === "custom" ? binding.baseUrl ?? "" : "");
    setTemperature(String(binding.temperature));
  }, [skill, providerOptions, applyCurrentVersion]);

  const editFromVersion = useCallback((version: SkillVersion) => {
    setRubric(version.rubricMarkdown);
    setPrompt(version.prompt);
    setVerdictKind(version.verdictKind);
    setChoiceScores(version.categoricalChoiceScores);
    setScalarRange(version.scalarRange);
    setAppliedStarter(null);
    setStarterSuppliedOutputContract(false);
    const binding = version.modelBinding;
    const { provider: selectedProvider, preservesBinding } = resolveJudgeProviderSelection(
      binding.provider,
      providerOptions
    );
    setProvider(selectedProvider);
    setModelId(preservesBinding ? binding.modelId : "");
    setModelVersion(preservesBinding ? binding.modelVersion : "");
    setBaseUrl(preservesBinding && selectedProvider === "custom" ? binding.baseUrl ?? "" : "");
    setTemperature(String(binding.temperature));
  }, [providerOptions]);

  // Initial load: fetch the skill, seed model binding, then apply either the
  // requested starter (deep-link) or the latest version's content. Latest —
  // not the current approved version — so a regression-held edit survives a reload as
  // the editing base instead of silently reverting to the approved rubric.
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    operationGeneration.current += 1;
    setLoading(true);
    setLoadError(null);
    setLoadedCriterionId(null);
    setSkill(null);
    setBaseVersion(null);
    setPhase("edit");
    setPendingVersion(null);
    setPinnedReferenceCount(null);
    setResult(null);
    setSubmitError(null);
    setPollError(null);
    setOverrideReason("");
    setSubmitting(false);
    setOnboardingDraft(null);
    setRefiningOnboardingDraft(false);
    setOnboardingCriterionVersion(null);
    setOnboardingEvidenceInventory(null);
    try {
      const [s, availability, evidenceInventory] = await Promise.all([
        fetchLatestSkill(selectedCriterionId ?? undefined),
        fetchJudgeProviders(),
        firstRun ? fetchOnboardingEvidenceInventory().catch(() => null) : Promise.resolve(null)
      ]);
      if (generation !== loadGeneration.current) return;
      setSkill(s);
      setOnboardingEvidenceInventory(evidenceInventory);
      const v = s.currentVersion;
      setBaseVersion(v);
      setProviderOptions(availability.providers);
      const { provider: selectedProvider, preservesBinding } = resolveJudgeProviderSelection(
        v.modelBinding.provider,
        availability.providers
      );
      setProvider(selectedProvider);
      setModelId(preservesBinding ? v.modelBinding.modelId : "");
      setModelVersion(preservesBinding ? v.modelBinding.modelVersion : "");
      setBaseUrl(preservesBinding && selectedProvider === "custom" ? v.modelBinding.baseUrl ?? "" : "");
      setTemperature(String(v.modelBinding.temperature));

      if (firstRun) {
        const savedDraft = loadOnboardingCheckDraft(s.projectId, s.id);
        const savedStarter = savedDraft ? findStarterSkill(savedDraft.starterId) : undefined;
        if (savedDraft && savedStarter) {
          applyStarter(savedStarter);
          setRubric(savedDraft.rubricMarkdown);
          setOnboardingDraft(savedDraft);
        } else {
          applyCurrentVersion(s);
        }
      } else {
        const starter = findStarterSkill(starterParam);
        if (starter) applyStarter(starter);
        else applyCurrentVersion(s);
      }

      // A queued version id stays in the URL, so a reload resumes the exact
      // immutable version instead of silently returning to an editable form.
      if (resumeVersionId) {
        const versions = await fetchSkillVersions(s.id, 100);
        if (generation !== loadGeneration.current) return;
        const resumeIndex = versions.findIndex((candidate) => candidate.id === resumeVersionId);
        const resumed = resumeIndex >= 0 ? versions[resumeIndex] : undefined;
        if (resumed) {
          setBaseVersion(versions[resumeIndex + 1] ?? v);
          const [run, exactCriterion] = await Promise.all([
            fetchSkillVersionRegression(s.id, resumed.id),
            firstRun ? fetchSkillVersionCriterion(s.id, resumed.id) : Promise.resolve(null)
          ]);
          if (generation !== loadGeneration.current) return;
          if (exactCriterion) setOnboardingCriterionVersion(exactCriterion);
          if (run) {
            setResult({
              version: resumed,
              regressionRun: run,
              blocked: run.status === "blocked"
            });
            setPendingVersion(null);
            setPhase("result");
          } else if (resumed.status === "calibrating") {
            setPendingVersion(resumed);
            setPhase("running");
          }
        } else {
          setSearchParams((current) => {
            const next = new URLSearchParams(current);
            next.delete("version");
            return next;
          }, { replace: true });
        }
      }
      setLoadedCriterionId(selectedCriterionId);
    } catch (err) {
      if (generation === loadGeneration.current) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [starterParam, firstRun, applyStarter, applyCurrentVersion, selectedCriterionId, resumeVersionId, setSearchParams]);

  const chooseOnboardingStarter = useCallback((starter: StarterSkill, source: OnboardingCheckDraft["decisionSource"]) => {
    if (!skill) return;
    applyStarter(starter);
    const projectName = dashboard?.project.name ?? "this project";
    const draft = draftFromStarter({
      projectId: skill.projectId,
      skillId: skill.id,
      starter,
      decisionSource: source,
      decisionReason: source === "coeval" ? recommendationReason(starter, projectName) : null
    });
    setOnboardingDraft(draft);
    setRefiningOnboardingDraft(false);
    saveOnboardingCheckDraft(draft);
  }, [skill, dashboard?.project.name, applyStarter]);

  const updateOnboardingDraft = useCallback((change: Partial<Pick<OnboardingCheckDraft, "qualityQuestion" | "rubricMarkdown">>) => {
    if (change.rubricMarkdown !== undefined) setRubric(change.rubricMarkdown);
    setOnboardingDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...change };
      saveOnboardingCheckDraft(next);
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rememberVersion = useCallback((versionId: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("version", versionId);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const clearRememberedVersion = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("version");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const pinnedRevisionId = pendingVersion?.regressionDatasetRevisionId ?? result?.version.regressionDatasetRevisionId ?? null;
  useEffect(() => {
    const revisionId = pinnedRevisionId;
    if (!revisionId) {
      setPinnedReferenceCount(null);
      return;
    }
    let cancelled = false;
    setPinnedReferenceCount(null);
    void fetchDatasetRevisionMetadata(revisionId)
      .then((metadata) => {
        if (!cancelled) setPinnedReferenceCount(metadata?.itemCount ?? null);
      })
      .catch(() => {
        // The durable version receipt still names the pinned revision. A read
        // failure only withholds the count; terminal evidence remains exact.
      });
    return () => {
      cancelled = true;
    };
  }, [pinnedRevisionId]);

  useEffect(() => {
    if (phase !== "running" || !pendingVersion || !skill) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const run = await fetchSkillVersionRegression(skill.id, pendingVersion.id);
        if (cancelled) return;
        if (run) {
          const versions = await fetchSkillVersions(skill.id, 100).catch(() => [] as SkillVersion[]);
          if (cancelled) return;
          const refreshed = versions.find((candidate) => candidate.id === pendingVersion.id) ?? pendingVersion;
          setResult({
            version: refreshed,
            regressionRun: run,
            blocked: run.status === "blocked"
          });
          setPendingVersion(null);
          setPollError(null);
          setPhase("result");
          void refresh();
          return;
        }
        setPollError(null);
      } catch (error) {
        if (!cancelled) {
          setPollError(error instanceof Error ? error.message : "Could not refresh the regression status.");
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, pendingVersion, skill, refresh]);

  useEffect(() => {
    if (!skill) return;
    const providerIsAvailable = providerOptions.some((option) => option.provider === provider && option.available);
    if (!providerIsAvailable) {
      setModels([]);
      setModelsError(null);
      setModelsLoading(false);
      setModelId("");
      setModelVersion("");
      return;
    }
    if (provider === "custom") {
      setModels([]);
      setModelsError(null);
      setModelsLoading(false);
      setModelVersion(modelId.trim());
      return;
    }

    let active = true;
    setModelsLoading(true);
    setModelsError(null);
    void fetchJudgeModels(provider)
      .then((catalog) => {
        if (!active) return;
        setModels(catalog.models);
        if (catalog.models.length === 0) {
          setModelId("");
          setModelVersion("");
          setModelsError(`No judge-capable models were returned by ${provider}.`);
          return;
        }
        // NEVER silently replace a pinned model that dropped out of the
        // catalog (deprecations, listing filters): keep the pin — it renders
        // as an explicit "not in catalog" option with a warning below — and
        // only default to the catalog head when nothing is pinned yet.
        if (modelId && !catalog.models.some((model) => model.id === modelId)) return;
        const selected = catalog.models.find((model) => model.id === modelId) ?? catalog.models[0]!;
        setModelId(selected.id);
        setModelVersion(selected.version);
      })
      .catch((err) => {
        if (!active) return;
        setModels([]);
        setModelId("");
        setModelVersion("");
        setModelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [provider, providerOptions, skill?.id]);

  // A blank string coerces to 0 via Number(""), which would silently submit
  // temperature 0 the user never typed. Require a non-blank, finite value.
  const parsedTemperature = Number(temperature);
  const temperatureValid = temperature.trim() !== "" && Number.isFinite(parsedTemperature) && parsedTemperature >= 0 && parsedTemperature <= 2;
  const baseUrlValid = provider !== "custom" || /^https?:\/\/\S+$/i.test(baseUrl.trim());
  const providerAvailable = providerOptions.some((option) => option.provider === provider && option.available);
  // The pinned model is allowed to be absent from the fetched catalog (it may
  // have been deprecated or filtered out of the listing). It stays selectable
  // and saveable — the warning below the picker is the honest surface.
  const pinnedModelMissing =
    provider !== "custom" &&
    !modelsLoading &&
    !modelsError &&
    models.length > 0 &&
    modelId.trim() !== "" &&
    !models.some((model) => model.id === modelId);

  // Build the create-version input. Model binding (incl. topP) and output
  // schema carry through from the current version; rubric / prompt / verdict
  // shape / time scope come from editor state.
  const buildInput = useCallback(
    (extra?: { overrideReason?: string }): CreateSkillVersionInput | null => {
      if (!skill) return null;
      const v = skill.currentVersion;
      if (temperature.trim() === "") return null;
      const temp = Number(temperature);
      if (!Number.isFinite(temp) || temp < 0 || temp > 2) return null;
      const regenerateOutputSchema = shouldRegenerateVerdictOutputSchema({
        firstRun,
        starterSuppliedContract: starterSuppliedOutputContract,
        base: v,
        current: {
          verdictKind,
          scalarRange,
          categoricalChoiceScores: choiceScores
        }
      });
      const input: CreateSkillVersionInput = {
        ...(skillCriterionVersionId(skill) ? { criterionVersionId: skillCriterionVersionId(skill)! } : {}),
        rubricMarkdown: rubric,
        prompt,
        modelBinding: {
          provider,
          modelId: modelId.trim(),
          modelVersion: modelVersion.trim(),
          temperature: temp,
          // topP has no UI field — it rides along from the current version.
          ...(v.modelBinding.topP !== undefined ? { topP: v.modelBinding.topP } : {}),
          ...(provider === "custom" ? { baseUrl: baseUrl.trim() } : {})
        },
        outputSchema: regenerateOutputSchema
          ? verdictOutputSchema({ verdictKind, scalarRange, categoricalChoiceScores: choiceScores })
          : v.outputSchema,
        verdictKind,
        timeScope,
        ...(verdictKind === "scalar" && scalarRange ? { scalarRange } : {}),
        ...(verdictKind === "categorical" && choiceScores
          ? { categoricalChoiceScores: choiceScores }
          : {}),
        ...(extra?.overrideReason ? { overrideReason: extra.overrideReason } : {})
      };
      return input;
    },
    [skill, rubric, prompt, provider, modelId, modelVersion, baseUrl, temperature, timeScope, verdictKind, choiceScores, scalarRange, firstRun, starterSuppliedOutputContract]
  );

  const canSave =
    skill != null &&
    rubric.trim().length > 0 &&
    prompt.trim().length > 0 &&
    modelId.trim().length > 0 &&
    modelVersion.trim().length > 0 &&
    providerAvailable &&
    temperatureValid &&
    baseUrlValid &&
    !modelsLoading &&
    !modelsError &&
    !submitting;

  // The create request is short-lived: a 202 returns the immutable version
  // receipt immediately, then the visible running stage polls by that exact id.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (extra?: { overrideReason?: string }) => {
    if (!skill) return;
    const operation = ++operationGeneration.current;
    const submittedCriterionId = selectedCriterionId;
    const submittedSkillId = skill.id;
    const submittedScope = {
      generation: operation,
      criterionId: submittedCriterionId,
      skillId: submittedSkillId
    };
    const recordingOverride = Boolean(extra?.overrideReason);
    const submittedDraftIdentity = firstRun && onboardingDraft && !recordingOverride
      ? onboardingCheckDraftIdentity(onboardingDraft)
      : null;
    const input = buildInput(extra);
    if (!input) {
      setSubmitError("Check the model binding — choose a model, use a temperature from 0 to 2, and complete the custom endpoint fields.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    if (!recordingOverride) setPhase("creating");
    try {
      let res: CreateSkillVersionResult;
      let createdCriterionVersion: CriterionVersion | null = null;
      if (firstRun && onboardingDraft && !recordingOverride) {
        const { criterionVersionId: _criterionVersionId, overrideReason: _overrideReason, ...evaluator } = input;
        const created = await createOnboardingCheck(skill.id, {
          idempotencyKey: onboardingDraft.requestId,
          criterion: {
            name: onboardingDraft.criterionName,
            definition: onboardingDraft.qualityQuestion
          },
          evaluator
        });
        createdCriterionVersion = created.criterionVersion;
        if (created.queued) {
          res = { state: "queued", version: created.version };
        } else {
          res = {
            state: "complete",
            version: created.version,
            regressionRun: created.regressionRun,
            blocked: created.regressionRun.status === "blocked"
          };
        }
      } else {
        res = await createSkillVersion(skill.id, input);
      }
      if (
        !mountedRef.current ||
        !skillEditOperationIsCurrent(submittedScope, {
          generation: operationGeneration.current,
          criterionId: criterionScope.current,
          skillId: skillScope.current
        }) || submittedDraftIdentity !== onboardingDraftIdentityRef.current
      ) return;
      if (createdCriterionVersion) setOnboardingCriterionVersion(createdCriterionVersion);
      rememberVersion(res.version.id);
      if (recordingOverride && result) setBaseVersion(result.version);
      if (res.state === "queued") {
        setResult(null);
        setPendingVersion(res.version);
        setPinnedReferenceCount(null);
        setPollError(null);
        setPhase("running");
      } else {
        setPendingVersion(null);
        setResult({
          version: res.version,
          regressionRun: res.regressionRun,
          blocked: res.blocked,
          ...(res.backfill ? { backfill: res.backfill } : {})
        });
        setPhase("result");
      }
    } catch (err) {
      if (!mountedRef.current || operation !== operationGeneration.current) return;
      setSubmitError(err instanceof Error ? err.message : String(err));
      if (!recordingOverride) setPhase("edit");
    } finally {
      if (mountedRef.current && operation === operationGeneration.current) setSubmitting(false);
    }
  };

  if (loading || criterionLoading || loadedCriterionId !== selectedCriterionId) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Edit skill" title="Loading skill" />
      </div>
    );
  }

  if (loadError || !skill) {
    return (
      <div className="fadeUp">
        <div className="mb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/skill")}>
            <ArrowLeft /> Back to skill
          </Button>
        </div>
        <SectionHead eyebrow="Edit skill" title="Could not load skill" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            {loadError ?? "Start the API with `pnpm dev:api` and refresh."}
          </CardContent>
        </Card>
      </div>
    );
  }

  const v = baseVersion ?? skill.currentVersion;

  if (selectedChoice?.criterion.sourceKind === "analysis_promotion") {
    return (
      <GovernedEvaluatorEditBoundary
        skill={skill}
        onBack={() => navigate("/skill")}
        onOpenLifecycle={() => navigate(criterionHref("/human-truth"))}
      />
    );
  }

  if (phase === "running" && pendingVersion) {
    return (
      <RegressionRunning
        skill={skill}
        baseVersion={v.version}
        version={pendingVersion}
        firstRun={firstRun}
        criterionVersion={onboardingCriterionVersion}
        referenceCount={pinnedReferenceCount}
        pollError={pollError}
        onOpenHistory={() => navigate("/skill/versions")}
      />
    );
  }

  if (phase === "result" && result) {
    return (
      <RegressionResult
        skill={skill}
        baseVersion={v.version}
        result={result}
        firstRun={firstRun}
        criterionVersion={onboardingCriterionVersion}
        referenceCount={pinnedReferenceCount ?? (
          result.regressionRun.status === "error" ? null : result.regressionRun.compared
        )}
        overrideReason={overrideReason}
        onOverrideReasonChange={setOverrideReason}
        submitting={submitting}
        submitError={submitError}
        onPublishOverride={() => void submit({ overrideReason })}
        onBackToEdit={() => {
          if (firstRun) {
            clearOnboardingCheckDraft(skill.projectId, skill.id);
            navigate("/skill/edit", { replace: true });
            return;
          }
          setBaseVersion(result.version);
          editFromVersion(result.version);
          setPhase("edit");
          setResult(null);
          setOverrideReason("");
          setSubmitError(null);
          clearRememberedVersion();
        }}
        doneLabel={firstRun
          ? result.regressionRun.status === "error"
            ? "Back to onboarding"
            : evidenceCount === 0
              ? "Finish for now"
              : "See first Result"
          : "View skill versions"}
        onDone={() => {
          if (firstRun && result.regressionRun.status !== "error" && result.regressionRun.status !== "blocked") {
            clearOnboardingCheckDraft(skill.projectId, skill.id);
            if (evidenceCount === 0) {
              markSetupReceipt(`Starter Check v${result.version.version} created. Add a Run to see its first Result.`);
              navigate("/");
            } else {
              navigate(firstResultPath(result.version.id, skill.id));
            }
            return;
          }
          navigate(firstRun ? "/" : "/skill/versions");
        }}
      />
    );
  }

  const promptCompilation = compileJudgePrompt({ rubricMarkdown: rubric, prompt });
  const usesImplicitRubric = promptCompilation.diagnostics.some((diagnostic) => diagnostic.code === "implicit-rubric");
  const unknownPromptVariables = promptCompilation.diagnostics.flatMap((diagnostic) =>
    diagnostic.code === "unknown-variable" ? [diagnostic.variable] : []
  );
  const availableProviderOptions = providerOptions.filter((option) => option.available);
  const selectedProviderOption = availableProviderOptions.find((option) => option.provider === provider);
  const hasConfiguredRealProvider = availableProviderOptions.some((option) => option.provider !== "mock");
  const changeInput = buildInput();

  if (firstRun) {
    if (!dashboardReady) {
      return <div className="fadeUp"><SectionHead eyebrow="Set up your first Check" title="Loading project" /></div>;
    }
    if (dashboard.viewerRole !== "owner") {
      return (
        <div className="fadeUp mx-auto max-w-[760px]">
          <SectionHead
            eyebrow="Set up your first Check"
            title="An owner needs to create this Check"
            sub="You can inspect the current starter Check, Runs, and Results. Creating or replacing the project's Check changes shared evaluation behavior, so this setup step is owner-only."
          />
          <Button variant="outline" onClick={() => navigate("/skill")}>
            View the current Check
          </Button>
        </div>
      );
    }
    const recommendedStarter = recommendStarterSkill(dashboard.project.name, dashboard.project.mode);
    const onboardingCanCreate = canSave && Boolean(
      onboardingDraft?.qualityQuestion.trim() && onboardingDraft.rubricMarkdown.trim()
    );
    return (
      <FirstRunCheckSetup
        projectName={dashboard.project.name}
        evidenceInventory={onboardingEvidenceInventory}
        starters={STARTER_SKILLS}
        recommendedStarter={recommendedStarter}
        draft={onboardingDraft}
        refining={refiningOnboardingDraft}
        provider={provider}
        modelId={modelId}
        modelVersion={modelVersion}
        baseUrl={baseUrl}
        providerReady={providerAvailable && modelId.trim().length > 0 && modelVersion.trim().length > 0 && baseUrlValid && !modelsError}
        preparingProvider={modelsLoading}
        canCreate={onboardingCanCreate}
        submitting={submitting}
        error={submitError}
        onChoose={(starter) => chooseOnboardingStarter(starter, "user")}
        onDecide={() => chooseOnboardingStarter(recommendedStarter, "coeval")}
        onChangeFocus={() => {
          setOnboardingDraft(null);
          setRefiningOnboardingDraft(false);
          clearOnboardingCheckDraft(skill.projectId, skill.id);
        }}
        onRefine={() => setRefiningOnboardingDraft((current) => !current)}
        onQuestionChange={(value) => updateOnboardingDraft({ qualityQuestion: value })}
        onRubricChange={(value) => updateOnboardingDraft({ rubricMarkdown: value })}
        onModelIdChange={setModelId}
        onModelVersionChange={setModelVersion}
        onBaseUrlChange={setBaseUrl}
        onCreate={() => void submit()}
        onBack={() => navigate("/")}
        onOpenSettings={() => navigate("/settings")}
      />
    );
  }

  return (
    <div className="fadeUp max-w-[1600px]">
      <div className="mb-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(firstRun ? "/" : "/skill")}>
          <ArrowLeft /> {firstRun ? "Back to onboarding" : "Back to skill"}
        </Button>
      </div>

      <SectionHead
        eyebrow={firstRun ? `First evaluator setup · from v${v.version}` : `Editing ${skill.name} · from v${v.version}`}
        title={firstRun ? "Define what a good result looks like" : "Edit the evaluator"}
        sub={gateKnownUnarmed
          ? "Save creates a new immutable evaluator version. Once you promote reference cases, later edits run a known-failure regression check."
          : "Save creates a new immutable evaluator version and compares it with the promoted known-failure set before it becomes current. Regressions require review or a recorded override reason."}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
              <Clock /> Version history
            </Button>
            <Button variant="ghost" size="sm" onClick={resetToCurrent} disabled={loading || submitting}>
              <RefreshCcw /> Reset to v{v.version}
            </Button>
          </div>
        }
      />

      <SkillEditFlow
        phase={phase}
        baseVersion={v.version}
        referenceCount={dashboardReady ? goldenSetSize : null}
      />

      {firstRun ? (
        <MarginNote tone="neutral" who="First project" className="mb-5">
          Start with a template, then rewrite its pass, fail, and ambiguous conditions for your
          task. The model picker uses a configured provider, and the prompt template stays under
          Advanced. Save the evaluator before submitting a case from Overview.
        </MarginNote>
      ) : null}

      {dashboardReady ? (
        <GateStrip
          state={goldenSetSize > 0 ? "armed" : evidenceCount === 0 ? "no-evidence" : "unarmed"}
          goldenSize={goldenSetSize}
          mode={bench ? "bench" : "tracing"}
          onStartEvidence={() => navigate(bench ? "/datasets?add=1" : "/")}
          onOpenExceptions={() => navigate("/exceptions")}
          onOpenGolden={() => navigate("/golden")}
          className="mb-5"
        />
      ) : null}

      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center gap-2 py-3">
          <Eyebrow>
            <span className="inline-flex items-center gap-1">
              <Sparkles className="size-3" /> Start from a template
            </span>
          </Eyebrow>
          {STARTER_SKILLS.map((starter) => (
            <button
              key={starter.id}
              type="button"
              onClick={() => applyStarter(starter)}
              aria-pressed={appliedStarter?.id === starter.id}
              title={`${starter.tagline} — ${starter.fit}`}
              className={cn(
                "inline-flex h-7 items-center rounded-sm border px-2.5 text-[11.5px] cursor-pointer",
                appliedStarter?.id === starter.id
                  ? "border-ink bg-ink text-paper"
                  : "border-rule-soft bg-transparent text-ink-2 hover:bg-paper-3"
              )}
            >
              {starter.name}
            </button>
          ))}
          <div className="flex-1" />
          <span className="font-mono text-[10.5px] text-ink-3">
            templates overwrite the form · model binding kept
          </span>
        </CardContent>
      </Card>

      {appliedStarter ? (
        <MarginNote tone="neutral" who={`Template · ${appliedStarter.name}`} className="mb-5">
          Use this template as a starting point. Edit the review guide and prompt for your task,
          then save. Coeval checks the new version against the active Golden references.
        </MarginNote>
      ) : null}

      <Card className="mb-5">
        <CardHeader>
          <div>
            <CardTitle>Review guide</CardTitle>
            <CardDescription>
              Defines what a good result looks like and the evidence the evaluator should use.
              It is stored as Markdown; Preview renders it without changing the source.
            </CardDescription>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1" aria-label="Review guide view">
            <Button
              type="button"
              size="xs"
              variant={rubricMode === "source" ? "default" : "ghost"}
              aria-pressed={rubricMode === "source"}
              onClick={() => setRubricMode("source")}
            >
              Edit source
            </Button>
            <Button
              type="button"
              size="xs"
              variant={rubricMode === "preview" ? "default" : "ghost"}
              aria-pressed={rubricMode === "preview"}
              onClick={() => setRubricMode("preview")}
            >
              Preview
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rubricMode === "source" ? (
            <textarea
              value={rubric}
              aria-label="Review guide Markdown source"
              onChange={(e) => {
                setRubric(e.target.value);
                if (appliedStarter) setAppliedStarter(null);
              }}
              spellCheck={false}
              className="min-h-[280px] w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink focus-visible:border-ink"
            />
          ) : (
            <MarkdownPreview markdown={rubric} className="min-h-[280px]" emptyText="Nothing to preview yet." />
          )}
        </CardContent>
      </Card>

      <Card className="mb-5">
        <CardHeader>
          <div>
            <CardTitle>Judge prompt template · advanced</CardTitle>
            <CardDescription>
              Builds the exact instructions sent to the judge. Place the review guide with
              {" {{rubric_markdown}}"}; trace data and the result schema are injected separately
              at runtime. This stays source text, not Markdown.
            </CardDescription>
          </div>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => setShowPromptEditor((v) => !v)}>
            {showPromptEditor ? "Hide" : "Edit"}
          </Button>
        </CardHeader>
        {showPromptEditor ? (
          <CardContent>
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (appliedStarter) setAppliedStarter(null);
              }}
              spellCheck={false}
              className="min-h-[220px] w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink focus-visible:border-ink"
            />
          </CardContent>
        ) : null}
      </Card>

      {prompt.trim() && usesImplicitRubric ? (
        <MarginNote tone="signal" who="Judge prompt template" className="mb-5">
          This prompt does not include {"{{rubric_markdown}}"}, so Coeval adds the review guide
          before the prompt. Add {"{{rubric_markdown}}"} where you want the guide to appear in the
          compiled instructions.
        </MarginNote>
      ) : null}

      {unknownPromptVariables.length > 0 ? (
        <MarginNote tone="signal" who="Judge prompt template" className="mb-5">
          Unsupported template {unknownPromptVariables.length === 1 ? "variable" : "variables"}{" "}
          <span className="font-mono">{unknownPromptVariables.join(", ")}</span> will be sent literally.
          Only <span className="font-mono">{"{{rubric_markdown}}"}</span> is supported; trace data is
          injected separately.
        </MarginNote>
      ) : null}

      <Card className="mb-5">
        <CardHeader>
          <div>
            <CardTitle>Requested model</CardTitle>
            <CardDescription>
              Chooses the provider, model, and temperature requested for judge calls. The exact API
              model ID is stored on the immutable version; runs record the provider-reported model
              identity separately when available. Verdict kind controls the allowed result labels.
            </CardDescription>
          </div>
          <div className="flex-1" />
          <Chip>verdict · {verdictKind}</Chip>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Provider">
            <select
              value={provider}
              disabled={availableProviderOptions.length === 0}
              onChange={(event) => {
                const next = event.target.value as JudgeProviderId;
                setProvider(next);
                setModelId("");
                setModelVersion("");
                setBaseUrl("");
              }}
              className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 text-[12.5px] text-ink focus-visible:border-ink"
            >
              {availableProviderOptions.length === 0 ? <option value="mock">Configure a provider in Settings</option> : null}
              {availableProviderOptions.map((option) => (
                <option key={option.provider} value={option.provider}>{option.label}</option>
              ))}
            </select>
            {selectedProviderOption ? (
              <span className="text-[11px] text-ink-3">
                {selectedProviderOption.credentialSource === "project"
                  ? "Using this project's saved key."
                  : selectedProviderOption.credentialSource === "environment"
                    ? "Using the platform key."
                    : "Deterministic local provider; no API key required."}
              </span>
            ) : null}
          </Field>

          {provider === "custom" ? (
            <Field label="OpenAI-compatible base URL">
              <TextInput value={baseUrl} onChange={setBaseUrl} placeholder="https://api.example.com/v1" mono />
              {!baseUrlValid ? <span className="text-[11px] text-signal">Enter a full http(s) base URL.</span> : null}
            </Field>
          ) : (
            <Field label="Model">
              <select
                value={modelId}
                disabled={modelsLoading || models.length === 0}
                onChange={(event) => {
                  const value = event.target.value;
                  // Re-choosing the pinned "not in catalog" option keeps the
                  // stored binding untouched (its pinned modelVersion may be a
                  // value the current catalog can't reproduce).
                  if (value === modelId) return;
                  const selected = models.find((model) => model.id === value);
                  setModelId(selected?.id ?? "");
                  setModelVersion(selected?.version ?? "");
                }}
                className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12px] text-ink focus-visible:border-ink disabled:opacity-60"
              >
                {modelsLoading ? <option value="">Loading models…</option> : null}
                {!modelsLoading && models.length === 0 ? <option value="">No models available</option> : null}
                {pinnedModelMissing ? (
                  <option value={modelId}>{modelId} · configured (not in catalog)</option>
                ) : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label === model.id ? model.id : `${model.label} · ${model.id}`}
                  </option>
                ))}
              </select>
              {modelsError ? <span className="text-[11px] text-signal">{modelsError}</span> : null}
              {pinnedModelMissing ? (
                <span className="text-[11px] text-signal">
                  The configured model isn't in the current {provider} catalog (it may be deprecated).
                  It remains configured until you pick a listed model.
                </span>
              ) : null}
            </Field>
          )}

          {provider === "custom" ? (
            <Field label="Custom model ID">
              <TextInput
                value={modelId}
                onChange={(value) => {
                  setModelId(value);
                  setModelVersion(value.trim());
                }}
                placeholder="provider/model-name"
                mono
              />
            </Field>
          ) : null}

          <Field label="Requested model identity">
            <div className="flex min-h-9 items-center rounded-sm border border-rule-soft bg-paper-3 px-2 font-mono text-[12px] text-ink-2">
              {modelVersion || "Choose a model"}
            </div>
            <span className="text-[11px] text-ink-3">Filled automatically from the selected API model ID.</span>
          </Field>

          <Field label="Temperature">
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
              className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
            />
            {!temperatureValid ? (
              <span className="text-[11px] text-signal">Enter a number from 0 to 2.</span>
            ) : (
              <span className="text-[11px] text-ink-3">Use 0 for repeatable judge decisions; increase only for a deliberate variance test.</span>
            )}
          </Field>

          <div className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2 text-[11.5px] leading-5 text-ink-2 sm:col-span-2">
            <span className="font-medium text-ink">Result format.</span> Coeval generates the exact
            JSON schema from the <span className="font-mono">{verdictKind}</span> result type and
            validates every judge response against it. {verdictKindDescription(verdictKind, {
              scalarRange,
              categoricalChoiceScores: choiceScores
            })} Changing the requested model creates a new version; a later
            requested-versus-observed mismatch is recorded evidence, not an automatic regression
            result.
          </div>
        </CardContent>
      </Card>

      {!hasConfiguredRealProvider ? (
        <MarginNote tone="neutral" who="Requested model" className="mb-5">
          {availableProviderOptions.some((option) => option.provider === "mock")
            ? "Only the local mock is available."
            : "No judge provider key is configured."}{" "}
          Add an Anthropic, OpenAI, OpenRouter, or custom provider key in{" "}
          <button type="button" className="underline cursor-pointer" onClick={() => navigate("/settings")}>Settings</button>{" "}
          to load its model catalog.
        </MarginNote>
      ) : null}

      {!dashboardReady || evidenceCount > 0 ? (
        // Unknown evidence (dashboard still loading) keeps the card VISIBLE —
        // hiding it would silently submit timeScope "new" and skip the
        // re-judge-existing choice on a project that actually has traces.
        <Card className="mb-5">
          <CardHeader>
            <div>
              <CardTitle>Apply to</CardTitle>
              <CardDescription>Which traces this evaluator version judges after it becomes current.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {TIME_SCOPES.map((scope) => (
              <button
                key={scope.value}
                type="button"
                onClick={() => setTimeScope(scope.value)}
                aria-pressed={timeScope === scope.value}
                className={cn(
                  "flex items-center gap-3 rounded-sm border px-3 py-2.5 text-left cursor-pointer",
                  timeScope === scope.value
                    ? "border-ink bg-card-2"
                    : "border-rule-soft hover:bg-paper-3"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 grid h-4 w-4 place-items-center rounded-full border",
                    timeScope === scope.value ? "border-ink" : "border-rule-strong"
                  )}
                >
                  {timeScope === scope.value ? <span className="h-2 w-2 rounded-full bg-ink" /> : null}
                </span>
                <span>
                  <span className="block text-[13px] font-medium text-ink">{scope.label}</span>
                  <span className="block text-[11.5px] text-ink-3">{scope.hint}</span>
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {changeInput ? (
        <SkillChangeReview
          base={v}
          rubricMarkdown={rubric}
          prompt={prompt}
          modelBinding={changeInput.modelBinding}
          verdictKind={verdictKind}
          timeScope={timeScope}
        />
      ) : null}

      {submitError ? <div className="mb-4 text-[12px] text-signal">{submitError}</div> : null}

      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={() => navigate(firstRun ? "/" : "/skill")} disabled={submitting}>
          Cancel
        </Button>
        <div className="flex-1" />
        <Button variant="primary" onClick={() => void submit()} disabled={!canSave}>
          {phase === "creating" ? <LoaderCircle className="animate-spin" /> : <Check />}
          {phase === "creating"
            ? "Creating immutable version…"
            : gateKnownUnarmed ? "Create version" : "Create version & check references"}
        </Button>
      </div>
    </div>
  );
}

function GovernedEvaluatorEditBoundary({
  skill,
  onBack,
  onOpenLifecycle
}: {
  skill: Skill;
  onBack: () => void;
  onOpenLifecycle: () => void;
}) {
  return (
    <div className="fadeUp max-w-[900px]">
      <div className="mb-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> Back to skill
        </Button>
      </div>
      <SectionHead
        eyebrow="Governed evaluator lifecycle"
        title={`Create the next ${skill.name} candidate from governed evidence`}
        sub="This evaluator came from an Analyze promotion. Its successors require an eligible frozen governed batch, an exact truth revision, calibration, and a complete regression receipt."
      />
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-signal" />
            <div>
              <div className="text-[13px] font-medium text-ink">Legacy editing and overrides are unavailable</div>
              <p className="mt-1 max-w-[72ch] text-[12px] leading-5 text-ink-2">
                Coeval will not send this evaluator through the legacy version writer or let an override substitute for governed activation. Open Human truth to create and manage its next candidate from admissible evidence.
              </p>
            </div>
          </div>
          <Button variant="primary" onClick={onOpenLifecycle}>
            Open governed evaluator lifecycle
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function RegressionRunning({
  skill,
  baseVersion,
  version,
  firstRun,
  criterionVersion,
  referenceCount,
  pollError,
  onOpenHistory
}: {
  skill: Skill;
  baseVersion: string;
  version: SkillVersion;
  firstRun: boolean;
  criterionVersion: CriterionVersion | null;
  referenceCount: number | null;
  pollError: string | null;
  onOpenHistory: () => void;
}) {
  if (firstRun) {
    return (
      <div className="fadeUp mx-auto max-w-[900px]">
        <SectionHead
          eyebrow="First setup · Check saved"
          title="Creating your first Result"
          sub="The quality question and Review guide are now an immutable Check. Coeval is finishing its saved setup step before applying it to a recorded Run."
        />
        <Card className="mb-4" role="status" aria-live="polite">
          <CardHeader>
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <CardTitle>{criterionVersion?.name ?? skill.name}</CardTitle>
                <Chip>Starter · unvalidated</Chip>
              </div>
              <CardDescription>The exact quality question bound to Check v{version.version}</CardDescription>
            </div>
            <LoaderCircle className="size-5 animate-spin text-ink-2" />
          </CardHeader>
          <CardContent>
            <p className="font-serif text-[21px] leading-7 text-ink">
              {criterionVersion?.definition ?? skill.description}
            </p>
            <p className="mt-4 text-[12.5px] leading-5 text-ink-2">
              This saved step does not validate the Check. It only records the version and checks any protected Runs already in the project.
            </p>
          </CardContent>
        </Card>
        {pollError ? (
          <MarginNote tone="signal" who="Status refresh" className="mb-4">
            {pollError} The Check is still saved; this page will keep checking.
          </MarginNote>
        ) : null}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onOpenHistory}><Clock /> View saved version</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="fadeUp max-w-[1200px]">
      <SectionHead
        eyebrow={`Evaluator edit · v${version.version} created`}
        title={referenceCount == null
          ? "Checking the pinned known-failure revision"
          : `Checking ${referenceCount} pinned reference case${referenceCount === 1 ? "" : "s"}`}
        sub={`The new ${skill.name} version is already immutable. This page follows that exact version; it is safe to leave and return through Version history.`}
        right={
          <Button variant="ghost" size="sm" onClick={onOpenHistory}>
            <Clock /> Version history
          </Button>
        }
      />

      <SkillEditFlow
        phase="running"
        baseVersion={baseVersion}
        createdVersion={version.version}
        referenceCount={referenceCount}
      />

      <Card className="mb-5">
        <CardContent className="flex items-start gap-3 py-5">
          <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-ink-2" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink">Regression check running</div>
            <p className="mt-1 max-w-[72ch] text-[12px] leading-5 text-ink-2">
              Coeval records the full outcome only after every case in the pinned revision finishes.
              Until then this version is not presented as passed or current.
            </p>
            <dl className="mt-4 grid grid-cols-1 gap-y-1 text-[11.5px] sm:grid-cols-[150px_1fr] sm:gap-y-2">
              <dt className="text-ink-3">Immutable version</dt>
              <dd className="font-mono">v{version.version} · {version.id}</dd>
              <dt className="text-ink-3">Pinned revision</dt>
              <dd className="break-all font-mono">{version.regressionDatasetRevisionId ?? "not available"}</dd>
              <dt className="text-ink-3">Cases in revision</dt>
              <dd>{referenceCount == null ? "Loading exact count…" : referenceCount}</dd>
            </dl>
          </div>
        </CardContent>
      </Card>

      {pollError ? (
        <div role="status" aria-live="polite">
          <MarginNote tone="signal" who="Status refresh" className="mb-5">
            {pollError} The version is still recorded; this page will keep retrying.
          </MarginNote>
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button variant="primary" onClick={onOpenHistory}>
          View version history
        </Button>
      </div>
    </div>
  );
}

function RegressionResult({
  skill,
  baseVersion,
  result,
  firstRun,
  criterionVersion,
  referenceCount,
  overrideReason,
  onOverrideReasonChange,
  submitting,
  submitError,
  onPublishOverride,
  onBackToEdit,
  onDone,
  doneLabel
}: {
  skill: Skill;
  baseVersion: string;
  result: CompletedSkillVersionResult;
  firstRun: boolean;
  criterionVersion: CriterionVersion | null;
  referenceCount: number | null;
  overrideReason: string;
  onOverrideReasonChange: (v: string) => void;
  submitting: boolean;
  submitError: string | null;
  onPublishOverride: () => void;
  onBackToEdit: () => void;
  onDone: () => void;
  doneLabel: string;
}) {
  const run = result.regressionRun;
  const blocked = result.blocked && run.status === "blocked";
  const overridden = run.status === "overridden";
  const failed = run.status === "error";
  const outcome: SkillEditOutcome = failed ? "error" : blocked ? "blocked" : overridden ? "overridden" : "passed";
  // Count "agree" rows directly. `flipped` overlaps regressed+improved (it's
  // "verdict changed vs the prior version"), so the old arithmetic
  // compared − regressed − improved − flipped double-subtracted.
  const agreed = run.cases.length
    ? run.cases.filter((c) => c.change === "agree").length
    : Math.max(0, run.compared - run.regressed - run.improved);

  if (firstRun) {
    const couldNotFinish = failed || blocked;
    return (
      <div className="fadeUp mx-auto max-w-[900px]">
        <SectionHead
          eyebrow={couldNotFinish ? "First setup · Check needs attention" : "First setup · Check ready"}
          title={couldNotFinish ? "The saved Check could not finish setup" : "Your first Check is ready"}
          sub={couldNotFinish
            ? (run.error ?? "A protected Run disagreed with this first Check. Refine it before continuing.")
            : "The exact quality question and Review guide are saved. The next step is to see what this Check says about a real recorded Run."}
        />
        <Card className="mb-4">
          <CardHeader>
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <CardTitle>{criterionVersion?.name ?? skill.name}</CardTitle>
                <Chip>Starter · unvalidated</Chip>
              </div>
              <CardDescription>The quality question bound to Check v{result.version.version}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="font-serif text-[21px] leading-7 text-ink">
              {criterionVersion?.definition ?? skill.description}
            </p>
            <p className="mt-4 text-[12.5px] leading-5 text-ink-2">
              “Ready” means the Check can run. It has not been validated against governed human judgment, calibrated, or approved for a release decision.
            </p>
          </CardContent>
        </Card>
        {submitError ? <MarginNote tone="signal" who="Could not continue" className="mb-4">{submitError}</MarginNote> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {couldNotFinish ? (
            <Button variant="outline" onClick={onBackToEdit} disabled={submitting}>
              <ArrowLeft /> Refine the Check
            </Button>
          ) : null}
          <Button variant="primary" onClick={onDone} disabled={submitting || blocked}>
            {doneLabel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fadeUp">
      <SectionHead
        eyebrow={
          failed
            ? "Evaluator edit · regression check failed"
            : blocked
            ? "Evaluator edit · regression found"
            : overridden
              ? "Evaluator edit · override recorded"
              : "Evaluator edit · check passed"
        }
        title={
          failed
            ? `v${result.version.version} was recorded, but its check did not finish`
            : blocked
            ? `${run.regressed} pinned reference case${run.regressed === 1 ? "" : "s"} would regress`
            : overridden
              ? `v${result.version.version} recorded with an override`
              : run.goldenSetMissing
                ? `v${result.version.version} recorded without a reference comparison`
                : `v${result.version.version} agrees with the known-failure set`
        }
        sub={
          failed
            ? run.error ?? "The provider or worker failed before a complete regression result was available."
            : run.goldenSetMissing
              ? "No promoted reference set yet — this version was created without a known-failure comparison. Promote reviewed cases to check future evaluator edits."
              : blocked
                ? "Coeval is holding this evaluator version out of current selection until you record an override reason or revise the edit."
                : overridden
                  ? "The override reason and replacement version are recorded in Version history."
                  : "Every promoted reference case still agrees. The immutable outcome is recorded in Version history."
        }
      />

      <SkillEditFlow
        phase="result"
        baseVersion={baseVersion}
        createdVersion={result.version.version}
        referenceCount={referenceCount}
        outcome={outcome}
      />

      {failed ? (
        <Card className="mb-5 border-signal-tint bg-signal-wash">
          <CardContent className="flex items-start gap-3 py-4">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-signal" />
            <div className="flex-1">
              <Eyebrow tone="signal">No complete regression result</Eyebrow>
              <div className="mt-1 text-[13px] leading-[1.5] text-ink-2">
                This version remains in history, but a failed or partial check cannot count as a
                pass. Review the operational error, then create a corrected version or retry from the editor.
              </div>
            </div>
          </CardContent>
        </Card>
      ) : blocked ? (
        <Card className="mb-5 border-signal-tint bg-signal-wash">
          <CardContent className="flex items-start gap-3 py-4">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-signal" />
            <div className="flex-1">
              <Eyebrow tone="signal">Regression found · review required</Eyebrow>
              <div className="mt-1 text-[13px] leading-[1.5] text-ink-2">
                This edit flips {run.regressed} previously-agreed case{run.regressed === 1 ? "" : "s"} in
                the pinned reference revision. Either go back and revert, or record why the
                evaluator change is acceptable.
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!failed ? (
        <KPIRow className="mb-5">
          <KPI label="Cases re-judged" num={run.compared} foot="pinned reference revision" />
          <KPI label="Agreed" num={agreed} delta="kept good or kept bad" deltaKind="default" />
          <KPI
            label="Regressed"
            num={run.regressed}
            delta={run.regressed > 0 ? regressionDirectionSummary(run.cases) : "none"}
            deltaKind={run.regressed > 0 ? "signal" : "default"}
          />
          <KPI
            label="Improved"
            num={run.improved}
            delta={run.improved > 0 ? "now agree with reference labels" : "none"}
            deltaKind={run.improved > 0 ? "up" : "default"}
          />
        </KPIRow>
      ) : null}

      {run.cases.length > 0 ? (
        <RegressionDiffTable cases={run.cases} />
      ) : null}

      <Card className="mb-5">
        <CardHeader>
          <div>
            <CardTitle>Judge card · v{result.version.version}</CardTitle>
            <CardDescription>Snapshot of the version this save produced.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-y-1 py-4 text-[13px] sm:grid-cols-[180px_1fr] sm:gap-y-2">
          <div className="text-ink-3">Skill</div>
          <div>{skill.name}</div>
          <div className="text-ink-3">Version</div>
          <div className="font-mono">{result.version.version}</div>
          <div className="text-ink-3">Model</div>
          <div className="font-mono">
            {result.version.modelBinding.provider}/{result.version.modelBinding.modelId} · catalog identity{" "}
            {result.version.modelBinding.modelVersion}
          </div>
          <div className="text-ink-3">Known-failure agreement</div>
          <div>
            {result.version.goldenSetAgreement == null
              ? "—"
              : `${Math.round(result.version.goldenSetAgreement * 100)}%`}
          </div>
          <div className="text-ink-3">Evaluator regression</div>
          <div className={cn("font-medium", blocked || failed ? "text-signal" : "text-ink")}>
            {failed
              ? "Check failed — no pass recorded"
              : blocked
                ? "Regression found — review required"
                : overridden ? "Override recorded" : "No regression found"}
          </div>
        </CardContent>
      </Card>

      {result.backfill ? (
        <MarginNote tone="neutral" who="Backfill" className="mb-5">
          {result.backfill.enqueued} of {result.backfill.cases} existing case
          {result.backfill.cases === 1 ? "" : "s"} re-queued against this version
          {result.backfill.skipped > 0 ? ` (${result.backfill.skipped} skipped)` : ""}.
        </MarginNote>
      ) : null}

      {submitError ? (
        <MarginNote tone="signal" who="Could not create the next version" className="mb-5">
          {submitError}
        </MarginNote>
      ) : null}

      {blocked ? (
        <Card className="mb-5">
          <CardHeader>
            <div>
              <CardTitle>Override with reason</CardTitle>
              <CardDescription>
                The blocked version stays immutable. This creates another version with the same
                edit and stores your reason with its overridden regression receipt.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <label htmlFor="skill-regression-override-reason" className="text-[12px] font-medium text-ink">
              Override reason
            </label>
            <textarea
              id="skill-regression-override-reason"
              value={overrideReason}
              onChange={(e) => onOverrideReasonChange(e.target.value)}
              placeholder="Why is this regression acceptable? (e.g. the regressed cases reflect an old tone policy we're intentionally changing — they'll be retired this week.)"
              className="min-h-[120px] w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-sans text-[12.5px] text-ink focus-visible:border-signal"
            />
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onBackToEdit} disabled={submitting}>
                <ArrowLeft /> Back to edit
              </Button>
              <div className="flex-1" />
              <Button
                variant="signal"
                onClick={onPublishOverride}
                disabled={submitting || overrideReason.trim().length < 8}
              >
                {submitting ? "Creating overridden version…" : "Create a new version with override"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : failed ? (
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={onBackToEdit}>
            <ArrowLeft /> Back to edit
          </Button>
          <Button variant="primary" onClick={onDone}>
            {doneLabel}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {overridden ? (
            <MarginNote tone="signal" who="Override on file" className="flex-1">
              {run.overrideReason ?? overrideReason ?? "—"}
            </MarginNote>
          ) : null}
          <Button variant="primary" onClick={onDone}>
            {doneLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "h-9 rounded-sm border border-rule-soft bg-card-2 px-2 text-[12.5px] text-ink focus-visible:border-ink",
        mono && "font-mono"
      )}
    />
  );
}
