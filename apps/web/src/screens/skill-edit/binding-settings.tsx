import { useCallback, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/rubrist";
import { checkModelCapabilities } from "../../lib/api.js";
import {
  bindingPickerGuidance,
  reasoningOffered,
  type BindingPickerGuidance,
  type SettingGuidance
} from "../../lib/binding-picker.js";
import { defaultBindingSettings, executionBindingFields, type ExecutionBindingFields } from "../../lib/execution-binding-draft.js";
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
// check of the chosen model. The picker pre-fills the documented default
// reasoning, which the author saves explicitly (founder decision 2).

export type PickerSettings = Pick<Required<ExecutionBindingFields>, "reasoning" | "verdictProtocol" | "outputTokenLimit">;

interface PickerModel {
  provider: JudgeProviderId;
  modelId: string;
  modelVersion: string;
  baseUrl: string;
}

const sameModel = (left: PickerModel, right: PickerModel) =>
  left.provider === right.provider && left.modelId.trim() === right.modelId.trim() &&
  left.modelVersion.trim() === right.modelVersion.trim() && left.baseUrl.trim() === right.baseUrl.trim();

/**
 * The picker's state for the model the editor has chosen: the settings the
 * author picked for it (else the base version's, for the same model, else the
 * documented defaults), and the capability check of exactly that model.
 */
export function useBindingPicker(model: PickerModel, base: ExecutionBinding | null) {
  const [picked, setPicked] = useState<{ model: PickerModel; settings: PickerSettings } | null>(null);
  const [check, setCheck] = useState<{ model: PickerModel; report: CapabilityCheckReport } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const settings: PickerSettings = useMemo(() => {
    if (picked && sameModel(picked.model, model)) return picked.settings;
    if (base && base.provider === model.provider && base.modelId === model.modelId.trim()) {
      const saved = executionBindingFields({ executionBinding: base, customEndpointUrl: null });
      return { reasoning: saved.reasoning ?? null, verdictProtocol: saved.verdictProtocol!, outputTokenLimit: saved.outputTokenLimit ?? "" };
    }
    return defaultBindingSettings(model.provider, model.modelId.trim());
  }, [picked, model, base]);
  const report = check && sameModel(check.model, model) ? check.report : null;
  const guidance = bindingPickerGuidance(model.provider, report, settings.reasoning);

  const setSettings = useCallback((next: Partial<PickerSettings>) => {
    setPicked({ model, settings: { ...settings, ...next } });
  }, [model, settings]);

  /** Loads a saved version's settings, or clears the picks for a version whose binding the editor can't keep. */
  const load = useCallback((version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl"> | null) => {
    if (version === null) {
      setPicked(null);
      return;
    }
    const fields = executionBindingFields(version);
    const provider = version.executionBinding.provider as JudgeProviderId;
    setPicked({
      model: { provider, modelId: fields.modelId, modelVersion: fields.modelVersion, baseUrl: provider === "custom" ? fields.baseUrl : "" },
      settings: { reasoning: fields.reasoning ?? null, verdictProtocol: fields.verdictProtocol!, outputTokenLimit: fields.outputTokenLimit ?? "" }
    });
  }, []);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    const checked = { ...model };
    try {
      // The check takes the binding rules a save does, so the author hears
      // about a missing limit here rather than from the server.
      const input = CapabilityCheckInputSchema.safeParse({
        provider: checked.provider,
        endpoint: checked.provider === "custom" ? { kind: "custom", baseUrl: checked.baseUrl.trim() } : { kind: "managed" },
        modelId: checked.modelId.trim(),
        modelVersion: checked.modelVersion.trim(),
        outputTokenLimit: takesSamplingSettings(checked.provider) && settings.outputTokenLimit.trim() !== "" ? Number(settings.outputTokenLimit) : null,
        routing: checked.provider === "openrouter" ? { requireParameters: true, allowFallbacks: false } : null
      });
      if (!input.success) {
        setCheckError(input.error.issues[0]?.message ?? "Choose a model before checking it.");
        return;
      }
      const result = await checkModelCapabilities(input.data);
      setCheck({ model: checked, report: result });
      // The protocol the check accepted is pre-selected; reasoning keeps the
      // author's choice, else the documented default.
      setPicked({
        model: checked,
        settings: {
          ...settings,
          verdictProtocol: result.protocol ?? settings.verdictProtocol,
          reasoning: settings.reasoning ?? result.documentedDefault
        }
      });
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "The capability check failed.");
    } finally {
      setChecking(false);
    }
  }, [model, settings]);

  /** The fields the editor saves: a setting the model rejects outright isn't sent. */
  const savedFields = (temperature: string): Pick<ExecutionBindingFields, "temperature" | "reasoning" | "verdictProtocol" | "outputTokenLimit"> => ({
    temperature: guidance.temperature.shown ? temperature : "",
    reasoning: guidance.reasoning.shown ? settings.reasoning : null,
    verdictProtocol: settings.verdictProtocol,
    outputTokenLimit: settings.outputTokenLimit
  });

  return { settings, setSettings, load, report, guidance, checking, checkError, runCheck, savedFields };
}

const GUIDANCE_TEXT: Record<SettingGuidance, string> = {
  accepted: "The model accepted this in the check.",
  rejected: "The model rejected this in the check.",
  "confirmed at resolution": "Not probed with these settings; confirmed at resolution after save."
};

function GuidanceNote({ guidance }: { guidance: SettingGuidance | null }) {
  if (guidance === null) return null;
  return <span className={guidance === "rejected" ? "text-[11px] text-signal" : "text-[11px] text-ink-3"}>{GUIDANCE_TEXT[guidance]}</span>;
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

/** A reasoning option: its label, the setting it saves, and whether the picker offers it. */
interface ReasoningOption {
  value: string;
  label: string;
  reasoning: ReasoningSettings | null;
}

function anthropicThinkingOptions(current: ReasoningSettings | null, guidance: BindingPickerGuidance): ReasoningOption[] {
  const effort = current?.family === "anthropic" ? current.effort : null;
  const budget = current?.family === "anthropic" && current.thinking.type === "enabled" ? current.thinking.budgetTokens : 1_024;
  const offered = (type: "enabled" | "adaptive") => guidance.thinkingTypes === null || guidance.thinkingTypes.includes(type);
  return [
    { value: "unset", label: "Not sent", reasoning: null },
    { value: "disabled", label: "Thinking disabled", reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort } },
    ...(offered("adaptive") ? [{ value: "adaptive", label: "Adaptive thinking", reasoning: { family: "anthropic" as const, thinking: { type: "adaptive" as const }, effort } }] : []),
    ...(offered("enabled") ? [{ value: "enabled", label: "Thinking with a budget", reasoning: { family: "anthropic" as const, thinking: { type: "enabled" as const, budgetTokens: budget }, effort } }] : [])
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
      return reasoning.maxTokens !== null ? "budget" : `effort-${reasoning.effort}`;
  }
}

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

  return (
    <>
      {samples ? (
        <div className="flex flex-wrap items-center gap-3 rounded-sm border border-rule-soft bg-paper-3 px-3 py-2 sm:col-span-2">
          <Button variant="outline" size="sm" disabled={!canCheck || checking} onClick={() => void runCheck()}>
            {checking ? <><LoaderCircle className="animate-spin" /> Checking…</> : "Check model"}
          </Button>
          <span className="text-[11.5px] leading-5 text-ink-2">
            {report
              ? `Checked with ${report.probes.length} probe${report.probes.length === 1 ? "" : "s"}: ${report.protocol ? `${report.protocol} accepted` : report.interrupted ? "no protocol confirmed" : "no protocol accepted"}.${report.interrupted ? " The check ended early; what it didn't reach is confirmed at resolution after save." : ""}`
              : "Probes the model (up to 6 calls) so the picker offers only settings it takes."}
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
              <GuidanceNote guidance={guidance.temperature.guidance} />
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
                  return (
                    <option key={option.value} value={option.value} disabled={rejected}>
                      {option.label}{rejected ? " (rejected by the model)" : ""}
                    </option>
                  );
                })}
              </select>
              {settings.reasoning?.family === "anthropic" && settings.reasoning.thinking.type === "enabled" ? (
                <input
                  type="number"
                  min="1024"
                  step="256"
                  aria-label="Thinking budget tokens"
                  value={settings.reasoning.thinking.budgetTokens}
                  onChange={(event) => {
                    const budgetTokens = Number(event.target.value);
                    if (settings.reasoning?.family === "anthropic" && Number.isSafeInteger(budgetTokens) && budgetTokens >= 1_024) {
                      setSettings({ reasoning: { ...settings.reasoning, thinking: { type: "enabled", budgetTokens } } });
                    }
                  }}
                  className={numberClass}
                />
              ) : null}
              {settings.reasoning?.family === "anthropic" ? (
                <select
                  aria-label="Effort"
                  value={settings.reasoning.effort ?? "unset"}
                  onChange={(event) => {
                    if (settings.reasoning?.family !== "anthropic") return;
                    const effort = event.target.value === "unset" ? null : event.target.value as NonNullable<Extract<ReasoningSettings, { family: "anthropic" }>["effort"]>;
                    setSettings({ reasoning: { ...settings.reasoning, effort } });
                  }}
                  className={selectClass}
                >
                  <option value="unset">Effort not sent</option>
                  {(guidance.effortLevels ?? ["low", "medium", "high", "xhigh", "max"] as const).map((effort) => (
                    <option key={effort} value={effort}>Effort {effort}</option>
                  ))}
                </select>
              ) : null}
              {settings.reasoning?.family === "openrouter" && settings.reasoning.maxTokens !== null ? (
                <input
                  type="number"
                  min="1"
                  aria-label="Reasoning token budget"
                  value={settings.reasoning.maxTokens}
                  onChange={(event) => {
                    const maxTokens = Number(event.target.value);
                    if (settings.reasoning?.family === "openrouter" && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
                      setSettings({ reasoning: { ...settings.reasoning, maxTokens } });
                    }
                  }}
                  className={numberClass}
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
            <option key={protocol} value={protocol} disabled={shown === "rejected"}>
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
          <span className="text-[11px] text-ink-3">
            {provider === "anthropic" ? "Anthropic requires a limit." : "Leave it blank to not send one."}
          </span>
        </Setting>
      ) : null}
    </>
  );
}
