import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, Pencil, RefreshCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow, MarginNote, SectionHead, Chip } from "@/components/coeval";
import { MarkdownPreview } from "@/components/markdown-preview";
import { fetchCurrentSkill } from "@/lib/api";
import { useCriterion } from "@/lib/criterion-context";
import { useDashboard } from "@/lib/dashboard-context";
import { skillEditConsequence, skillVersionStateLabel } from "../lib/skill-presentation.js";
import { cn } from "@/lib/utils";
import { verdictKindDescription } from "@/lib/verdict-kind";
import { compileJudgePrompt, type Skill } from "@coeval/shared";

type Tab = "rubric" | "prompt" | "binding" | "schema";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "rubric", label: "Review guide" },
  { id: "prompt", label: "Judge instructions" },
  { id: "binding", label: "Requested model" },
  { id: "schema", label: "Result format" }
];

export function SkillScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const { dashboard, refresh: refreshDashboard } = useDashboard();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("rubric");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSkill(await fetchCurrentSkill(selectedCriterionId ?? undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedCriterionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshDashboard();
  }, [refreshDashboard]);

  if (loading && !skill) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="The artifact" title="Loading skill" />
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="The artifact" title="Could not load skill" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            {error ?? "Start the API with `pnpm dev:api` and refresh."}
          </CardContent>
        </Card>
      </div>
    );
  }

  const v = skill.currentVersion;
  const agreementPct = v.goldenSetAgreement == null ? null : Math.round(v.goldenSetAgreement * 100);
  const goldenSetSize = dashboard?.goldenSetSize ?? null;
  const editConsequence = skillEditConsequence(goldenSetSize);
  const starterUnvalidated = skill.isStarter || v.onboardingAssurance === "starter_unvalidated";

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Evaluator definition"
        title={skill.name}
        sub={starterUnvalidated
          ? `${skill.description} This Starter Check can run, but it has not been validated against governed human judgment. Review what it checks before relying on its Results.`
          : `${skill.description} Review what this evaluator checks. ${editConsequence}`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
              <Clock /> Version history
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => navigate("/skill/edit")}>
              <Pencil /> Edit evaluator
            </Button>
          </div>
        }
      />

      {starterUnvalidated ? (
        <MarginNote tone="neutral" who="Starter · unvalidated" className="mb-5 max-w-[82ch]">
          Runnable is not the same as accurate. Results are model opinions until this Check is tested against admissible governed human judgment and receives scoped calibration evidence.
        </MarginNote>
      ) : null}

      <details className="mb-5 max-w-[82ch] rounded-sm border border-rule-soft bg-paper-2">
        <summary className="cursor-pointer px-3 py-2 text-[11.5px] text-ink-2">
          Evaluator details
          <span className="ml-2 text-ink-4">requested model, immutable version, and status</span>
        </summary>
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-rule-soft px-3 py-2 break-all font-mono text-[10.5px] text-ink-3">
          <span>{v.modelBinding.provider}/{v.modelBinding.modelId}@{v.modelBinding.modelVersion}</span>
          <span>·</span>
          <span>temperature {v.modelBinding.temperature}</span>
          <span>·</span>
          <span>{skillVersionStateLabel(v)}</span>
        </div>
      </details>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-1 border-b border-rule-soft pb-4 lg:border-r lg:border-b-0 lg:pr-4 lg:pb-0">
          <Eyebrow>Skill</Eyebrow>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
              className={cn(
                "rounded-sm px-2 py-1.5 text-left text-[12.5px] cursor-pointer",
                tab === t.id ? "bg-card text-ink shadow-[var(--shadow-card)]" : "text-ink-2 hover:bg-paper-3"
              )}
            >
              {t.label}
            </button>
          ))}

          <div className="mt-4">
            <Eyebrow>Regression</Eyebrow>
            <button
              type="button"
              onClick={() => navigate("/skill/versions")}
              className="mt-1 w-full rounded-sm px-2 py-1.5 text-left text-[12.5px] text-ink-2 cursor-pointer hover:bg-paper-3"
            >
              Known-failure agreement
              <span className="ml-1 font-mono text-ink">
                {agreementPct == null ? "—" : `${agreementPct}%`}
              </span>
            </button>
            <div className="px-2 py-1.5 font-mono text-[11px] text-ink-3">
              Strict {v.tooStrictCount} · Lenient {v.tooLenientCount}
            </div>
          </div>

          <div className="mt-4">
            <Eyebrow>Ownership</Eyebrow>
            <div className="px-2 py-1.5 text-[12px] text-ink-2">Owner · {skill.ownerName}</div>
            <div className="px-2 font-mono text-[11px] text-ink-3">
              {starterUnvalidated
                ? "Starter · unvalidated"
                : `Approved ${v.approvedAt ? new Date(v.approvedAt).toLocaleDateString() : "—"}`}
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          {tab === "rubric" ? <RubricView markdown={v.rubricMarkdown} /> : null}
          {tab === "prompt" ? <PromptView prompt={v.prompt} rubricMarkdown={v.rubricMarkdown} /> : null}
          {tab === "binding" ? (
            <BindingView
              binding={v.modelBinding}
              verdictKind={v.verdictKind}
              scalarRange={v.scalarRange}
              categoricalChoiceScores={v.categoricalChoiceScores}
            />
          ) : null}
          {tab === "schema" ? <SchemaView schema={v.outputSchema} /> : null}
        </div>
      </div>

      <div className="mt-6 max-w-[80ch] text-[13px] italic leading-[1.55] text-ink-3">
        Every save creates an immutable evaluator version. {goldenSetSize !== null && goldenSetSize > 0
          ? "Its regression check compares that version with the current promoted known-failure references. Passing is not an overall quality or release decision."
          : goldenSetSize === 0
            ? "No regression check runs until at least one Golden reference exists; a later pass is not an overall quality or release decision."
            : "Known-failure checks apply when the current Golden set is non-empty; passing is not an overall quality or release decision."}
      </div>
    </div>
  );
}

function RubricView({ markdown }: { markdown: string }) {
  return (
    <div>
      <Eyebrow>Review guide · stored as Markdown</Eyebrow>
      <p className="mt-2 max-w-[80ch] text-[12.5px] leading-5 text-ink-2">
        Defines what a good result looks like and the evidence the evaluator should use. This is
        the main content reviewers should read and edit.
      </p>
      <MarkdownPreview markdown={markdown} className="mt-3" />
    </div>
  );
}

function PromptView({ prompt, rubricMarkdown }: { prompt: string; rubricMarkdown: string }) {
  const compiled = compileJudgePrompt({ prompt, rubricMarkdown });
  const unknownVariables = compiled.diagnostics.flatMap((diagnostic) =>
    diagnostic.code === "unknown-variable" ? [diagnostic.variable] : []
  );

  return (
    <div>
      <Eyebrow>Judge instructions · exact compiled text</Eyebrow>
      <p className="mt-2 max-w-[80ch] text-[12.5px] leading-5 text-ink-2">
        These are the exact instructions sent to the judge after the review guide is inserted.
        They control how the model applies the guide; they are shown as source text, not Markdown.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip>{compiled.rubricMode === "template" ? "rubric placed by template" : "rubric prepended for compatibility"}</Chip>
        {unknownVariables.length > 0 ? <Chip variant="fail">unresolved variables · {unknownVariables.length}</Chip> : null}
      </div>
      <pre className="mt-3 max-h-[640px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-card-2 px-3 py-3 font-mono text-[12px] leading-[1.6] text-ink">
        {compiled.content || <span className="text-ink-3">No judge instructions recorded.</span>}
      </pre>
      <details className="mt-3 max-w-[80ch] text-[12px] text-ink-2">
        <summary className="cursor-pointer select-none font-medium text-ink">View stored prompt template</summary>
        <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-card-2 px-3 py-3 font-mono text-[11px] leading-[1.6] text-ink-2">
          {prompt || <span className="text-ink-3">No prompt template recorded.</span>}
        </pre>
      </details>
    </div>
  );
}

function BindingView({
  binding,
  verdictKind,
  scalarRange,
  categoricalChoiceScores
}: {
  binding: Skill["currentVersion"]["modelBinding"];
  verdictKind: Skill["currentVersion"]["verdictKind"];
  scalarRange: Skill["currentVersion"]["scalarRange"];
  categoricalChoiceScores: Skill["currentVersion"]["categoricalChoiceScores"];
}) {
  return (
    <div>
      <Eyebrow>
        Requested model · immutable settings for this version
      </Eyebrow>
      <p className="mt-2 max-w-[80ch] text-[12.5px] leading-5 text-ink-2">
        Selects the provider, model, and temperature requested for judge calls. Each run records
        the model identity the provider reports when it is available, so requested and observed
        identities can be compared later.
      </p>
      <Card className="mt-3 max-w-[600px]">
        <CardContent className="grid grid-cols-1 gap-y-1 py-3 text-[13px] sm:grid-cols-[160px_1fr] sm:gap-y-2">
          <div className="text-ink-3">Provider</div>
          <div>{binding.provider}</div>
          <div className="text-ink-3">Model id</div>
          <div className="font-mono">{binding.modelId}</div>
          <div className="text-ink-3">Catalog identity</div>
          <div className="font-mono">{binding.modelVersion}</div>
          <div className="text-ink-3">Temperature</div>
          <div className="font-mono">{binding.temperature}</div>
          <div className="text-ink-3">Result type</div>
          <div>
            <div className="font-mono">{verdictKind}</div>
            <div className="mt-0.5 text-[11.5px] leading-5 text-ink-3">
              {verdictKindDescription(verdictKind, { scalarRange, categoricalChoiceScores })}
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="mt-4 max-w-[600px] border-l-2 border-rule-strong bg-card-2 px-3 py-2 text-[12px] text-ink-2">
        A requested-versus-observed mismatch is evidence to inspect. It does not automatically
        change the evaluator status or rerun promoted reference cases.
      </div>
    </div>
  );
}

function SchemaView({ schema }: { schema: unknown }) {
  const hasSchema = schema != null && !(typeof schema === "object" && Object.keys(schema as object).length === 0);
  return (
    <div>
      <Eyebrow>Result format · exact JSON schema</Eyebrow>
      <p className="mt-2 max-w-[80ch] text-[12.5px] leading-5 text-ink-2">
        Defines the fields and allowed values the judge must return. Coeval validates each result
        against this exact contract, so it remains formatted as source rather than Markdown.
      </p>
      <pre className="mt-3 max-h-[640px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-card-2 px-3 py-3 font-mono text-[12px] leading-[1.6] text-ink">
        {hasSchema ? (
          JSON.stringify(schema, null, 2)
        ) : (
          <span className="text-ink-3">No schema recorded.</span>
        )}
      </pre>
    </div>
  );
}
