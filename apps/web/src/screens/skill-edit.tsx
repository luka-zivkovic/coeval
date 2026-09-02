import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FirstRunCheckSetup } from "@/components/first-run-check-setup";
import type { SkillEditPhase } from "@/components/skill-edit-flow";
import { SectionHead } from "@/components/coeval";
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
import { shouldRegenerateVerdictOutputSchema, skillEditOperationIsCurrent } from "@/lib/skill-edit-flow";
import {
  compileJudgePrompt,
  verdictOutputSchema,
  type CriterionVersion,
  type CreateSkillVersionInput,
  type JudgeModel,
  type JudgeProviderAvailabilityItem,
  type JudgeProviderId,
  type OnboardingEvidenceInventory,
  type Skill,
  type SkillVersion,
  type SkillVersionTimeScope,
  type VerdictKind
} from "@coeval/shared";
import { SkillVersionEditor } from "./skill-edit/editor.js";
import {
  GovernedEvaluatorEditBoundary,
  RegressionResult,
  RegressionRunning
} from "./skill-edit/regression.js";

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
              navigate(firstResultPath(result.version.id, skill.id, skill.criterionId));
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
    <SkillVersionEditor
      navigate={navigate}
      firstRun={firstRun}
      v={v}
      skill={skill}
      gateKnownUnarmed={gateKnownUnarmed}
      loading={loading}
      submitting={submitting}
      phase={phase}
      dashboardReady={dashboardReady}
      goldenSetSize={goldenSetSize}
      evidenceCount={evidenceCount}
      bench={bench}
      resetToCurrent={resetToCurrent}
      appliedStarter={appliedStarter}
      setAppliedStarter={setAppliedStarter}
      applyStarter={applyStarter}
      rubricMode={rubricMode}
      setRubricMode={setRubricMode}
      rubric={rubric}
      setRubric={setRubric}
      prompt={prompt}
      setPrompt={setPrompt}
      showPromptEditor={showPromptEditor}
      setShowPromptEditor={setShowPromptEditor}
      usesImplicitRubric={usesImplicitRubric}
      unknownPromptVariables={unknownPromptVariables}
      availableProviderOptions={availableProviderOptions}
      provider={provider}
      setProvider={setProvider}
      selectedProviderOption={selectedProviderOption}
      baseUrl={baseUrl}
      setBaseUrl={setBaseUrl}
      baseUrlValid={baseUrlValid}
      modelsLoading={modelsLoading}
      models={models}
      modelId={modelId}
      setModelId={setModelId}
      modelVersion={modelVersion}
      setModelVersion={setModelVersion}
      modelsError={modelsError}
      pinnedModelMissing={pinnedModelMissing}
      temperature={temperature}
      setTemperature={setTemperature}
      temperatureValid={temperatureValid}
      verdictKind={verdictKind}
      scalarRange={scalarRange}
      choiceScores={choiceScores}
      hasConfiguredRealProvider={hasConfiguredRealProvider}
      timeScope={timeScope}
      setTimeScope={setTimeScope}
      changeInput={changeInput}
      submitError={submitError}
      canSave={canSave}
      submit={submit}
    />
  );
}
