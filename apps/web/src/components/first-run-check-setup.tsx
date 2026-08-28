import { ArrowLeft, Check, LoaderCircle, Pencil, Sparkles } from "lucide-react";
import type { JudgeProviderId, OnboardingEvidenceInventory } from "@coeval/shared";
import { MarkdownPreview } from "./markdown-preview.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Chip, Eyebrow, MarginNote, SectionHead } from "./coeval/index.js";
import { evidenceLimitDescription, evidenceReadDescription, type OnboardingCheckDraft } from "../lib/onboarding-check.js";
import type { StarterSkill } from "../lib/starter-skills.js";
import { cn } from "../lib/utils.js";

interface FirstRunCheckSetupProps {
  projectName: string;
  evidenceInventory: OnboardingEvidenceInventory | null;
  starters: ReadonlyArray<StarterSkill>;
  recommendedStarter: StarterSkill;
  draft: OnboardingCheckDraft | null;
  refining: boolean;
  provider: JudgeProviderId;
  modelId: string;
  modelVersion: string;
  baseUrl: string;
  providerReady: boolean;
  preparingProvider: boolean;
  canCreate: boolean;
  submitting: boolean;
  error: string | null;
  onChoose: (starter: StarterSkill) => void;
  onDecide: () => void;
  onChangeFocus: () => void;
  onRefine: () => void;
  onQuestionChange: (value: string) => void;
  onRubricChange: (value: string) => void;
  onModelIdChange: (value: string) => void;
  onModelVersionChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onCreate: () => void;
  onBack: () => void;
  onOpenSettings: () => void;
}

export function FirstRunCheckSetup({
  projectName,
  evidenceInventory,
  starters,
  recommendedStarter,
  draft,
  refining,
  provider,
  modelId,
  modelVersion,
  baseUrl,
  providerReady,
  preparingProvider,
  canCreate,
  submitting,
  error,
  onChoose,
  onDecide,
  onChangeFocus,
  onRefine,
  onQuestionChange,
  onRubricChange,
  onModelIdChange,
  onModelVersionChange,
  onBaseUrlChange,
  onCreate,
  onBack,
  onOpenSettings
}: FirstRunCheckSetupProps) {
  if (!draft) {
    return (
      <div className="fadeUp mx-auto max-w-[960px]">
        <div className="mb-3">
          <Button variant="ghost" size="sm" onClick={onBack} disabled={submitting}><ArrowLeft /> Back to onboarding</Button>
        </div>
        <SectionHead
          eyebrow="Set up your first Check · step 1 of 2"
          title="What should this Check focus on?"
          sub="Choose one quality question now. You can inspect and refine the proposed Review guide before anything is created."
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {starters.map((starter) => (
            <button
              key={starter.id}
              type="button"
              onClick={() => onChoose(starter)}
              disabled={submitting}
              className={cn(
                "min-h-32 rounded-sm border border-rule-soft bg-card p-4 text-left transition-colors",
                "hover:border-rule-strong hover:bg-card-2 focus-visible:border-ink"
              )}
            >
              <span className="mb-2 flex items-center justify-between gap-3">
                <span className="font-serif text-[17px] font-semibold text-ink">{starter.name}</span>
                {starter.id === recommendedStarter.id ? <Chip>suggested</Chip> : null}
              </span>
              <span className="block text-[12.5px] leading-5 text-ink-2">{starter.qualityQuestion}</span>
              <span className="mt-3 block font-mono text-[10.5px] text-ink-3">{starter.fit}</span>
            </button>
          ))}
        </div>

        <Card className="mt-4">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Eyebrow>Want the shortest path?</Eyebrow>
              <p className="mt-1 text-[12.5px] text-ink-2">
                Coeval can choose a starting point from “{projectName}” and explain the choice before creating it.
              </p>
            </div>
            <Button variant="primary" onClick={onDecide} disabled={submitting}><Sparkles /> Decide for me</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fadeUp mx-auto max-w-[1040px]">
      <div className="mb-3">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={submitting}><ArrowLeft /> Back to onboarding</Button>
      </div>
      <SectionHead
        eyebrow="Set up your first Check · step 2 of 2"
        title="Review the proposed Check"
        sub="This is a usable starting point, not a claim that the Check is accurate. Read it, refine it if useful, then create it."
      />

      {draft.decisionSource === "coeval" && draft.decisionReason ? (
        <MarginNote tone="neutral" who="Coeval decided" className="mb-4">
          {draft.decisionReason}
        </MarginNote>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <CardTitle>{draft.criterionName}</CardTitle>
              <Chip><span className="inline-flex items-center gap-1"><Check className="size-3" /> Starter · unvalidated</span></Chip>
            </div>
            <CardDescription>One Check answers one quality question about each Run.</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onChangeFocus} disabled={submitting}>Change focus</Button>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Eyebrow>What this Check decides</Eyebrow>
            {refining ? (
              <input
                aria-label="Quality question"
                value={draft.qualityQuestion}
                onChange={(event) => onQuestionChange(event.target.value)}
                disabled={submitting}
                className="mt-2 h-10 w-full rounded-sm border border-rule-soft bg-card-2 px-3 text-[13px] text-ink focus-visible:border-ink"
              />
            ) : (
              <p className="mt-2 font-serif text-[21px] leading-7 text-ink">{draft.qualityQuestion}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-sm border border-rule-soft bg-card-2 p-3">
              <Eyebrow>What it reads</Eyebrow>
              <p className="mt-2 text-[12.5px] leading-5 text-ink-2">
                {evidenceReadDescription(evidenceInventory)}
              </p>
            </div>
            <div className="rounded-sm border border-rule-soft bg-card-2 p-3">
              <Eyebrow>What it cannot know</Eyebrow>
              <p className="mt-2 text-[12.5px] leading-5 text-ink-2">{evidenceLimitDescription()}</p>
            </div>
          </div>

          <div className="rounded-sm border border-gold-tint bg-ambig-bg/30 p-3">
            <Eyebrow>Evidence this focus needs</Eyebrow>
            <p className="mt-2 text-[12.5px] leading-5 text-ink-2">
              {starters.find((starter) => starter.id === draft.starterId)?.evidenceRequirements
                ?? "Capture the request, result, and any context needed to judge this quality question fairly."}
            </p>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <Eyebrow>Review guide</Eyebrow>
                <p className="mt-1 text-[11.5px] text-ink-3">The exact instructions the Check uses to decide.</p>
              </div>
              {!refining ? <Button variant="outline" size="sm" onClick={onRefine} disabled={submitting}><Pencil /> Refine it first</Button> : null}
            </div>
            {refining ? (
              <textarea
                aria-label="Review guide Markdown"
                value={draft.rubricMarkdown}
                onChange={(event) => onRubricChange(event.target.value)}
                disabled={submitting}
                spellCheck={false}
                className="min-h-[340px] w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink focus-visible:border-ink"
              />
            ) : (
              <MarkdownPreview markdown={draft.rubricMarkdown} className="max-h-[440px]" />
            )}
          </div>

          {provider === "custom" ? (
            <div className="rounded-sm border border-rule-soft bg-card-2 p-3">
              <Eyebrow>Custom judge connection</Eyebrow>
              <p className="mt-1 text-[11.5px] leading-5 text-ink-3">
                These values identify the OpenAI-compatible model endpoint. The API key stays in Settings.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="text-[11.5px] text-ink-2">
                  Model ID
                  <input
                    aria-label="Custom judge model ID"
                    value={modelId}
                    onChange={(event) => onModelIdChange(event.target.value)}
                    disabled={submitting}
                    placeholder="your-model-id"
                    className="mt-1 h-9 w-full rounded-sm border border-rule-soft bg-card px-2.5 font-mono text-[12px] text-ink focus-visible:border-ink"
                  />
                </label>
                <label className="text-[11.5px] text-ink-2">
                  Model version
                  <input
                    aria-label="Custom judge model version"
                    value={modelVersion}
                    onChange={(event) => onModelVersionChange(event.target.value)}
                    disabled={submitting}
                    placeholder="stable name or dated version"
                    className="mt-1 h-9 w-full rounded-sm border border-rule-soft bg-card px-2.5 font-mono text-[12px] text-ink focus-visible:border-ink"
                  />
                </label>
                <label className="text-[11.5px] text-ink-2 md:col-span-2">
                  Base URL
                  <input
                    aria-label="Custom judge base URL"
                    value={baseUrl}
                    onChange={(event) => onBaseUrlChange(event.target.value)}
                    disabled={submitting}
                    placeholder="https://api.example.com/v1"
                    className="mt-1 h-9 w-full rounded-sm border border-rule-soft bg-card px-2.5 font-mono text-[12px] text-ink focus-visible:border-ink"
                  />
                </label>
              </div>
            </div>
          ) : null}

          <details className="rounded-sm border border-rule-soft bg-card-2 px-3 py-2">
            <summary className="cursor-pointer text-[11.5px] font-medium text-ink-2">Technical details</summary>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11.5px]">
              <dt className="text-ink-3">Requested judge</dt><dd className="font-mono text-ink">{provider} · {modelId || "not ready"}</dd>
              <dt className="text-ink-3">Result shape</dt><dd className="text-ink">One structured verdict and rationale per Run</dd>
              <dt className="text-ink-3">Apply to</dt><dd className="text-ink">Saved Runs and new Runs</dd>
            </dl>
          </details>
        </CardContent>
      </Card>

      <MarginNote tone="neutral" who="What creation means" className="mb-4">
        This creates an immutable Check version. Its Results are model opinions—not human truth,
        calibration, or a release decision. You can improve the Check after seeing how it behaves on real Runs.
      </MarginNote>

      {!preparingProvider && !providerReady ? (
        <MarginNote tone="signal" who="Judge provider needed" className="mb-4">
          {provider === "custom"
            ? "Enter the custom model ID, version, and full base URL above. "
            : "Connect a judge provider before creating this Check. "}
          <Button variant="link" size="sm" onClick={onOpenSettings} disabled={submitting}>Open Settings</Button>
        </MarginNote>
      ) : null}
      {error ? <p role="alert" className="mb-3 text-[12.5px] text-signal">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {refining ? <Button variant="outline" onClick={() => onRefine()} disabled={submitting}>Preview current draft</Button> : null}
        <Button variant="primary" size="lg" onClick={onCreate} disabled={!canCreate || submitting}>
          {submitting
            ? <><LoaderCircle className="animate-spin" /> Creating Check…</>
            : refining ? "Create with current draft" : "Create this Check"}
        </Button>
      </div>
    </div>
  );
}
