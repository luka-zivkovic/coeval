import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Eyebrow } from "../../components/rubrist/index.js";
import { checkModelCapabilities } from "../../lib/api.js";
import {
  bindingPickerGuidance,
  pickerBlockingProblems,
  reasoningAccepted,
  reasoningOffered,
  type BindingPickerGuidance,
  type SettingGuidance
} from "../../lib/binding-picker.js";
import {
  defaultBindingSettings,
  executionBindingFields,
  outputTokenLimitProblem,
  type ExecutionBindingFields
} from "../../lib/execution-binding-draft.js";
import {
  CapabilityCheckInputSchema,
  reasoningFamilyFor,
  takesSamplingSettings,
  type CapabilityCheckReport,
  type ExecutionBinding,
  type JudgeProviderId,
  type ReasoningSettings,
  type SkillVersion,
  type VerdictProtocolId
} from "@rubrist/shared";

// The model picker's settings (ADR-0014 section 4, Batch 8F): temperature,
// reasoning, verdict protocol, and output token limit, guided by a capability
// check of the chosen model. When the author picks a model the check runs by
// itself; the author can run it again. The picker pre-fills the documented
// default reasoning, which the author saves explicitly (founder decision 2).

export type PickerSettings = Pick<Required<ExecutionBindingFields>, "reasoning" | "verdictProtocol" | "outputTokenLimit">;

export interface PickerModel {
  provider: JudgeProviderId;
  modelId: string;
  modelVersion: string;
  baseUrl: string;
}

/** The author's settings for one model, and whether its protocol was chosen rather than defaulted. */
interface Picks {
  settings: PickerSettings;
  protocolChosen: boolean;
}

interface CheckState {
  running: boolean;
  report: CapabilityCheckReport | null;
  error: string | null;
}

// Picks follow the model, so fixing a base URL or a model version keeps them;
// a check answers for the exact model and endpoint it probed.
const picksKey = (model: PickerModel) => `${model.provider}\u0000${model.modelId.trim()}`;
const checkKey = (model: PickerModel) =>
  `${picksKey(model)}\u0000${model.modelVersion.trim()}\u0000${model.provider === "custom" ? model.baseUrl.trim() : ""}`;

/** How long the picker waits after the author picks a model before checking it. */
const AUTO_CHECK_DELAY_MS = 800;

function settingsFrom(binding: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">): PickerSettings {
  const saved = executionBindingFields(binding);
  return { reasoning: saved.reasoning ?? null, verdictProtocol: saved.verdictProtocol!, outputTokenLimit: saved.outputTokenLimit ?? "" };
}

/**
 * The picker's state for the model the editor has chosen: the settings the
 * author picked for it (else the base version's, for the same model, else the
 * documented defaults), and the capability check of exactly that model.
 * `canCheck` says a check can run: a model is named and its provider has a key.
 */
export function useBindingPicker(
  model: PickerModel,
  base: ExecutionBinding | null,
  options: { canCheck: boolean; temperature: string }
) {
  const [picks, setPicks] = useState<Record<string, Picks>>({});
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  // Set when the author picks a model, so only their choice starts a check by itself.
  const [autoCheckArmed, setAutoCheckArmed] = useState(false);

  const fallback = useCallback((target: PickerModel): Picks => {
    if (base && base.provider === target.provider && base.modelId === target.modelId.trim()) {
      // The base version's protocol is its author's choice, kept to reproduce it (ADR-0014 section 3).
      return { settings: settingsFrom({ executionBinding: base, customEndpointUrl: null }), protocolChosen: true };
    }
    return { settings: defaultBindingSettings(target.provider, target.modelId.trim()), protocolChosen: false };
  }, [base]);

  const current = picks[picksKey(model)] ?? fallback(model);
  const settings = current.settings;
  const check = checks[checkKey(model)] ?? null;
  const report = check?.report ?? null;
  const guidance = bindingPickerGuidance(model.provider, report, { reasoning: settings.reasoning, temperature: options.temperature });

  const setSettings = useCallback((next: Partial<PickerSettings>) => {
    setPicks((previous) => {
      const key = picksKey(model);
      const now = previous[key] ?? fallback(model);
      return {
        ...previous,
        [key]: { settings: { ...now.settings, ...next }, protocolChosen: now.protocolChosen || next.verdictProtocol !== undefined }
      };
    });
  }, [model, fallback]);

  /** Loads a saved version's settings, or clears the picks for a version whose binding the editor can't keep. */
  const load = useCallback((version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl"> | null) => {
    setAutoCheckArmed(false);
    if (version === null) {
      setPicks({});
      return;
    }
    const fields = executionBindingFields(version);
    const provider = version.executionBinding.provider as JudgeProviderId;
    setPicks({
      [picksKey({ provider, modelId: fields.modelId, modelVersion: fields.modelVersion, baseUrl: fields.baseUrl })]: {
        settings: settingsFrom(version),
        protocolChosen: true
      }
    });
  }, []);

  /** Records that the author picked a model, so the picker checks it once it settles. */
  const modelPicked = useCallback(() => setAutoCheckArmed(true), []);

  const runCheck = useCallback(async () => {
    const checked = { ...model };
    const key = checkKey(checked);
    const input = CapabilityCheckInputSchema.safeParse({
      provider: checked.provider,
      endpoint: checked.provider === "custom" ? { kind: "custom", baseUrl: checked.baseUrl.trim() } : { kind: "managed" },
      modelId: checked.modelId.trim(),
      modelVersion: checked.modelVersion.trim(),
      outputTokenLimit: takesSamplingSettings(checked.provider) && settings.outputTokenLimit.trim() !== "" ? Number(settings.outputTokenLimit) : null,
      routing: checked.provider === "openrouter" ? { requireParameters: true, allowFallbacks: false } : null
    });
    if (!input.success) {
      // The limit field states its own problem; anything else is a model the check can't take.
      const limit = outputTokenLimitProblem(checked.provider, settings.outputTokenLimit);
      setChecks((previous) => ({ ...previous, [key]: { running: false, report: null, error: limit ?? "Choose a model before checking it." } }));
      return;
    }
    setChecks((previous) => ({ ...previous, [key]: { running: true, report: previous[key]?.report ?? null, error: null } }));
    try {
      const result = await checkModelCapabilities(input.data);
      setChecks((previous) => ({ ...previous, [key]: { running: false, report: result, error: null } }));
      // Only the protocol follows the check, and only where the author hasn't
      // chosen one or the check rejected theirs. Edits made while it ran stay.
      setPicks((previous) => {
        const pk = picksKey(checked);
        const now = previous[pk] ?? fallback(checked);
        const rejected = result.probes.some((probe) =>
          probe.purpose === "protocol" && probe.verdictProtocol === now.settings.verdictProtocol && probe.outcome === "rejected");
        if (result.protocol === null || result.protocol === now.settings.verdictProtocol || (now.protocolChosen && !rejected)) return previous;
        return { ...previous, [pk]: { ...now, settings: { ...now.settings, verdictProtocol: result.protocol } } };
      });
    } catch (error) {
      setChecks((previous) => ({
        ...previous,
        [key]: { running: false, report: null, error: error instanceof Error ? error.message : "The capability check failed." }
      }));
    }
  }, [model, settings.outputTokenLimit, fallback]);

  // When the author picks a model with a key, the picker checks it (ADR-0014 section 4).
  const currentCheckKey = checkKey(model);
  const alreadyChecked = checks[currentCheckKey] !== undefined;
  useEffect(() => {
    if (!autoCheckArmed || !options.canCheck || !takesSamplingSettings(model.provider) || alreadyChecked) return;
    const timer = setTimeout(() => {
      setAutoCheckArmed(false);
      void runCheck();
    }, AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoCheckArmed, options.canCheck, model.provider, currentCheckKey, alreadyChecked, runCheck]);

  /** The fields the editor saves: a setting the model rejects outright isn't sent. */
  const temperatureShown = guidance.temperature.shown;
  const reasoningShown = guidance.reasoning.shown;
  const savedFields = useCallback((temperature: string): Pick<ExecutionBindingFields, "temperature" | "reasoning" | "verdictProtocol" | "outputTokenLimit"> => ({
    temperature: temperatureShown ? temperature : "",
    reasoning: reasoningShown ? settings.reasoning : null,
    verdictProtocol: settings.verdictProtocol,
    outputTokenLimit: settings.outputTokenLimit
  }), [temperatureShown, reasoningShown, settings]);

  return {
    settings,
    setSettings,
    load,
    modelPicked,
    report,
    guidance,
    checking: check?.running === true,
    checkError: check?.error ?? null,
    runCheck,
    savedFields,
    blockingProblems: pickerBlockingProblems(guidance, settings)
  };
}

const GUIDANCE_TEXT: Record<SettingGuidance, string> = {
  accepted: "The model accepted this in the check.",
  rejected: "The model rejected this in the check.",
  "confirmed at resolution": "Not probed with these settings; confirmed at resolution after save."
};

function GuidanceNote({ guidance, text }: { guidance: SettingGuidance | null; text?: string | undefined }) {
  if (guidance === null) return null;
  return <span className={guidance === "rejected" ? "text-[11px] text-signal" : "text-[11px] text-ink-3"}>{text ?? GUIDANCE_TEXT[guidance]}</span>;
}

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
      {children}
    </div>
  );
}

const selectClass = "h-9 rounded-sm border border-rule-soft bg-card-2 px-2 text-[12.5px] text-ink focus-visible:border-ink disabled:opacity-60";
const numberClass = "h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink";

/**
 * A whole number the author types freely: a value under `min` stays in the
 * field with a note until it is fixed, and blurring reverts it to the saved one.
 */
function WholeNumberInput({ value, min, label, onCommit }: { value: number; min: number; label: string; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parsed = Number(text);
  const valid = text.trim() !== "" && Number.isSafeInteger(parsed) && parsed >= min;
  return (
    <>
      <input
        type="number"
        min={min}
        aria-label={label}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isSafeInteger(next) && next >= min) onCommit(next);
        }}
        onBlur={() => { if (!valid) setText(String(value)); }}
        className={numberClass}
      />
      {!valid ? <span className="text-[11px] text-signal">Enter a whole number of at least {min}; {value} is kept until then.</span> : null}
    </>
  );
}

/** A reasoning option: its value, its label, and the setting it saves. */
interface ReasoningOption {
  value: string;
  label: string;
  reasoning: ReasoningSettings | null;
}

const NOT_OFFERED = " (not offered by the model)";

function anthropicThinkingOptions(current: ReasoningSettings | null, guidance: BindingPickerGuidance): ReasoningOption[] {
  const effort = current?.family === "anthropic" ? current.effort : null;
  const budget = current?.family === "anthropic" && current.thinking.type === "enabled" ? current.thinking.budgetTokens : 1_024;
  const currentType = current?.family === "anthropic" ? current.thinking.type : null;
  // A type the provider doesn't publish is offered only while it is the one the author has.
  const published = (type: "enabled" | "adaptive") => guidance.thinkingTypes === null || guidance.thinkingTypes.includes(type);
  const listed = (type: "enabled" | "adaptive") => published(type) || currentType === type;
  const suffix = (type: "enabled" | "adaptive") => published(type) ? "" : NOT_OFFERED;
  return [
    { value: "unset", label: "Not sent", reasoning: null },
    { value: "disabled", label: "Thinking disabled", reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort } },
    ...(listed("adaptive") ? [{ value: "adaptive", label: `Adaptive thinking${suffix("adaptive")}`, reasoning: { family: "anthropic" as const, thinking: { type: "adaptive" as const }, effort } }] : []),
    ...(listed("enabled") ? [{ value: "enabled", label: `Thinking with a budget${suffix("enabled")}`, reasoning: { family: "anthropic" as const, thinking: { type: "enabled" as const, budgetTokens: budget }, effort } }] : [])
  ];
}

function reasoningOptions(family: ReasoningSettings["family"], current: ReasoningSettings | null, guidance: BindingPickerGuidance): ReasoningOption[] {
  switch (family) {
    case "anthropic":
      return anthropicThinkingOptions(current, guidance);
    case "openai":
      return [
        { value: "unset", label: "Not sent", reasoning: null },
        ...(["none", "minimal", "low", "medium", "high"] as const).map((effort) => ({
          value: effort, label: `Effort ${effort}`, reasoning: { family: "openai" as const, effort }
        }))
      ];
    case "openrouter": {
      const maxTokens = current?.family === "openrouter" && current.maxTokens !== null ? current.maxTokens : 1_024;
      return [
        { value: "unset", label: "Not sent", reasoning: null },
        { value: "off", label: "Reasoning off", reasoning: { family: "openrouter", enabled: false, effort: null, maxTokens: null } },
        { value: "on", label: "Reasoning on, provider's effort", reasoning: { family: "openrouter", enabled: true, effort: null, maxTokens: null } },
        ...(["low", "medium", "high"] as const).map((effort) => ({
          value: `effort-${effort}`, label: `Effort ${effort}`, reasoning: { family: "openrouter" as const, enabled: true, effort, maxTokens: null }
        })),
        { value: "budget", label: "Token budget", reasoning: { family: "openrouter", enabled: true, effort: null, maxTokens } }
      ];
    }
  }
}

function optionValue(family: ReasoningSettings["family"], reasoning: ReasoningSettings | null): string {
  if (reasoning === null) return "unset";
  switch (family) {
    case "anthropic":
      return reasoning.family === "anthropic" ? reasoning.thinking.type : "unset";
    case "openai":
      return reasoning.family === "openai" ? reasoning.effort : "unset";
    case "openrouter":
      if (reasoning.family !== "openrouter") return "unset";
      if (!reasoning.enabled) return "off";
      if (reasoning.maxTokens !== null) return "budget";
      return reasoning.effort === null ? "on" : `effort-${reasoning.effort}`;
  }
}

type AnthropicEffort = NonNullable<Extract<ReasoningSettings, { family: "anthropic" }>["effort"]>;
const ALL_EFFORTS: readonly AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function BindingSettings({
  provider,
  temperature,
  setTemperature,
  temperatureValid,
  picker,
  canCheck
}: {
  provider: JudgeProviderId;
  temperature: string;
  setTemperature: (value: string) => void;
  temperatureValid: boolean;
  picker: ReturnType<typeof useBindingPicker>;
  /** Whether a model is chosen and its key is available, so a check can run. */
  canCheck: boolean;
}) {
  const { settings, setSettings, guidance, report, checking, checkError, runCheck } = picker;
  const family = reasoningFamilyFor(provider);
  const samples = takesSamplingSettings(provider);
  const options = family === null ? [] : reasoningOptions(family, settings.reasoning, guidance);
  const current = family === null ? "unset" : optionValue(family, settings.reasoning);
  const limitProblem = outputTokenLimitProblem(provider, settings.outputTokenLimit, settings.reasoning);
  const acceptedTemperature = guidance.temperature.acceptedValue;
  const anthropicEffort = settings.reasoning?.family === "anthropic" ? settings.reasoning.effort : null;
  const effortChoices: readonly AnthropicEffort[] = guidance.effortLevels ?? ALL_EFFORTS;

  return (
    <>
      {samples ? (
        <div className="flex flex-wrap items-center gap-3 rounded-sm border border-rule-soft bg-paper-3 px-3 py-2 sm:col-span-2">
          <Button variant="outline" size="sm" disabled={!canCheck || checking} onClick={() => void runCheck()}>
            {checking ? <><LoaderCircle className="animate-spin" /> Checking…</> : report ? "Check again" : "Check model"}
          </Button>
          <span className="text-[11.5px] leading-5 text-ink-2">
            {report
              ? `Checked with ${report.probes.length} probe${report.probes.length === 1 ? "" : "s"}: ${report.protocol ? `${report.protocol} accepted` : report.interrupted ? "no protocol confirmed" : "no protocol accepted"}.${report.interrupted ? " The check ended early; what it didn't reach is confirmed at resolution after save." : ""}`
              : canCheck
                ? "Picking a model checks it (up to 6 calls), so the picker offers only settings it takes."
                : "Choose a model whose provider has a key to check which settings it takes."}
          </span>
          {checkError ? <span className="text-[11px] text-signal">{checkError}</span> : null}
        </div>
      ) : null}

      <Setting label="Temperature">
        {samples && guidance.temperature.shown ? (
          <>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={temperature}
              placeholder="not sent"
              onChange={(event) => setTemperature(event.target.value)}
              className={numberClass}
            />
            {!temperatureValid ? (
              <span className="text-[11px] text-signal">Enter a number from 0 to 2, or leave it blank to not send one.</span>
            ) : guidance.temperature.guidance !== null ? (
              <GuidanceNote
                guidance={guidance.temperature.guidance}
                text={guidance.temperature.guidance === "confirmed at resolution" && acceptedTemperature !== null
                  ? `The check accepted temperature ${acceptedTemperature}; ${temperature.trim()} is confirmed at resolution after save.`
                  : undefined}
              />
            ) : (
              <span className="text-[11px] text-ink-3">
                Use 0 for repeatable judge decisions. Governed use needs an explicit value wherever the model accepts one.
              </span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-ink-3">
            {samples ? "The model rejects temperature with this reasoning, so none is sent." : `${provider} takes no sampling settings.`}
          </span>
        )}
      </Setting>

      {family !== null ? (
        <Setting label="Reasoning">
          {guidance.reasoning.shown ? (
            <>
              <select
                value={current}
                onChange={(event) => setSettings({ reasoning: options.find((option) => option.value === event.target.value)?.reasoning ?? null })}
                className={selectClass}
              >
                {options.map((option) => {
                  const rejected = option.reasoning !== null && !reasoningOffered(guidance, option.reasoning);
                  const accepted = option.reasoning !== null && reasoningAccepted(guidance, option.reasoning);
                  return (
                    <option key={option.value} value={option.value} disabled={rejected && option.value !== current}>
                      {option.label}{rejected ? " (rejected by the model)" : accepted ? " (accepted)" : ""}
                    </option>
                  );
                })}
              </select>
              {settings.reasoning?.family === "anthropic" && settings.reasoning.thinking.type === "enabled" ? (
                <WholeNumberInput
                  label="Thinking budget tokens"
                  min={1_024}
                  value={settings.reasoning.thinking.budgetTokens}
                  onCommit={(budgetTokens) => {
                    if (settings.reasoning?.family === "anthropic") setSettings({ reasoning: { ...settings.reasoning, thinking: { type: "enabled", budgetTokens } } });
                  }}
                />
              ) : null}
              {settings.reasoning?.family === "anthropic" ? (
                <select
                  aria-label="Effort"
                  value={anthropicEffort ?? "unset"}
                  onChange={(event) => {
                    if (settings.reasoning?.family !== "anthropic") return;
                    const effort = event.target.value === "unset" ? null : event.target.value as AnthropicEffort;
                    setSettings({ reasoning: { ...settings.reasoning, effort } });
                  }}
                  className={selectClass}
                >
                  <option value="unset">Effort not sent</option>
                  {/* An effort the provider doesn't publish stays listed while it is the one the author has. */}
                  {ALL_EFFORTS.filter((effort) => effortChoices.includes(effort) || effort === anthropicEffort).map((effort) => (
                    <option key={effort} value={effort}>Effort {effort}{effortChoices.includes(effort) ? "" : NOT_OFFERED}</option>
                  ))}
                </select>
              ) : null}
              {settings.reasoning?.family === "openrouter" && settings.reasoning.maxTokens !== null ? (
                <WholeNumberInput
                  label="Reasoning token budget"
                  min={1}
                  value={settings.reasoning.maxTokens}
                  onCommit={(maxTokens) => {
                    if (settings.reasoning?.family === "openrouter") setSettings({ reasoning: { ...settings.reasoning, maxTokens } });
                  }}
                />
              ) : null}
              <GuidanceNote guidance={guidance.reasoning.guidance} />
            </>
          ) : (
            <span className="text-[11px] text-ink-3">The model rejects the reasoning parameter, so none is sent.</span>
          )}
        </Setting>
      ) : null}

      <Setting label="Verdict protocol">
        <select
          value={settings.verdictProtocol}
          onChange={(event) => setSettings({ verdictProtocol: event.target.value as VerdictProtocolId })}
          className={selectClass}
        >
          {guidance.protocols.map(({ protocol, guidance: shown }) => (
            <option key={protocol} value={protocol} disabled={shown === "rejected" && protocol !== settings.verdictProtocol}>
              {protocol}{shown === "accepted" ? " (accepted)" : shown === "rejected" ? " (rejected by the model)" : ""}
            </option>
          ))}
        </select>
        <GuidanceNote guidance={guidance.protocols.find((option) => option.protocol === settings.verdictProtocol)?.guidance ?? null} />
      </Setting>

      {samples ? (
        <Setting label="Output token limit">
          <input
            type="number"
            min="1"
            value={settings.outputTokenLimit}
            placeholder="not sent"
            onChange={(event) => setSettings({ outputTokenLimit: event.target.value })}
            className={numberClass}
          />
          <span className={limitProblem ? "text-[11px] text-signal" : "text-[11px] text-ink-3"}>
            {limitProblem ?? (provider === "anthropic" ? "Anthropic requires a limit." : "Leave it blank to not send one.")}
          </span>
        </Setting>
      ) : null}

      {picker.blockingProblems.length > 0 ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-signal sm:col-span-2">
          {picker.blockingProblems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      ) : null}
    </>
  );
}
