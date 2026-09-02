import type { Dispatch, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import { ArrowLeft, Check, Clock, LoaderCircle, RefreshCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownPreview } from "@/components/markdown-preview";
import { Chip, Eyebrow, GateStrip, MarginNote, SectionHead } from "@/components/coeval";
import { SkillChangeReview, SkillEditFlow, type SkillEditPhase } from "@/components/skill-edit-flow";
import type {
  CreateSkillVersionInput,
  JudgeModel,
  JudgeProviderAvailabilityItem,
  JudgeProviderId,
  Skill,
  SkillVersion,
  SkillVersionTimeScope,
  VerdictKind
} from "@coeval/shared";
import { STARTER_SKILLS, type StarterSkill } from "@/lib/starter-skills";
import { cn } from "@/lib/utils";
import { verdictKindDescription } from "@/lib/verdict-kind";

const TIME_SCOPES: ReadonlyArray<{ value: SkillVersionTimeScope; label: string; hint: string }> = [
  { value: "new", label: "New traces only", hint: "Future traces use this version. Existing verdicts untouched." },
  { value: "existing", label: "Re-judge existing", hint: "Backfill every existing case against this version." },
  { value: "both", label: "New + existing", hint: "Future traces and a full backfill of existing cases." }
];

export function SkillVersionEditor({
  navigate, firstRun, v, skill, gateKnownUnarmed, loading, submitting, phase,
  dashboardReady, goldenSetSize, evidenceCount, bench, resetToCurrent,
  appliedStarter, setAppliedStarter, applyStarter, rubricMode, setRubricMode,
  rubric, setRubric, prompt, setPrompt, showPromptEditor, setShowPromptEditor,
  usesImplicitRubric, unknownPromptVariables, availableProviderOptions,
  provider, setProvider, selectedProviderOption, baseUrl, setBaseUrl, baseUrlValid,
  modelsLoading, models, modelId, setModelId, modelVersion, setModelVersion,
  modelsError, pinnedModelMissing, temperature, setTemperature, temperatureValid,
  verdictKind, scalarRange, choiceScores, hasConfiguredRealProvider, timeScope,
  setTimeScope, changeInput, submitError, canSave, submit
}: {
  navigate: NavigateFunction;
  firstRun: boolean;
  v: SkillVersion;
  skill: Skill;
  gateKnownUnarmed: boolean;
  loading: boolean;
  submitting: boolean;
  phase: SkillEditPhase;
  dashboardReady: boolean;
  goldenSetSize: number;
  evidenceCount: number;
  bench: boolean;
  resetToCurrent: () => void;
  appliedStarter: StarterSkill | null;
  setAppliedStarter: Dispatch<SetStateAction<StarterSkill | null>>;
  applyStarter: (starter: StarterSkill) => void;
  rubricMode: "source" | "preview";
  setRubricMode: Dispatch<SetStateAction<"source" | "preview">>;
  rubric: string;
  setRubric: Dispatch<SetStateAction<string>>;
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  showPromptEditor: boolean;
  setShowPromptEditor: Dispatch<SetStateAction<boolean>>;
  usesImplicitRubric: boolean;
  unknownPromptVariables: string[];
  availableProviderOptions: JudgeProviderAvailabilityItem[];
  provider: JudgeProviderId;
  setProvider: Dispatch<SetStateAction<JudgeProviderId>>;
  selectedProviderOption: JudgeProviderAvailabilityItem | undefined;
  baseUrl: string;
  setBaseUrl: Dispatch<SetStateAction<string>>;
  baseUrlValid: boolean;
  modelsLoading: boolean;
  models: JudgeModel[];
  modelId: string;
  setModelId: Dispatch<SetStateAction<string>>;
  modelVersion: string;
  setModelVersion: Dispatch<SetStateAction<string>>;
  modelsError: string | null;
  pinnedModelMissing: boolean;
  temperature: string;
  setTemperature: Dispatch<SetStateAction<string>>;
  temperatureValid: boolean;
  verdictKind: VerdictKind;
  scalarRange: [number, number] | null;
  choiceScores: Record<string, number> | null;
  hasConfiguredRealProvider: boolean;
  timeScope: SkillVersionTimeScope;
  setTimeScope: Dispatch<SetStateAction<SkillVersionTimeScope>>;
  changeInput: CreateSkillVersionInput | null;
  submitError: string | null;
  canSave: boolean;
  submit: (extra?: { overrideReason?: string }) => Promise<void>;
}) {
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
