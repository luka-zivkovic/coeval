import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, Copy, Download, RefreshCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownPreview } from "@/components/markdown-preview";
import { regressionReceiptLabel, skillVersionChangeLabels } from "@/lib/skill-edit-flow";
import { Table } from "@/components/ui/table";
import { RowLink } from "@/components/row-action";
import { Eyebrow, SectionHead, Chip, GateChip, gateStateForVersion, LabelChip, MarginNote, RegressionDiffTable, ConvergenceCard } from "@/components/coeval";
import { fetchCurrentSkill, fetchJudgeCard, fetchJudgeCardMarkdown, fetchSkillFormat, fetchSkillVersionHistory, fetchSkillVersions, fetchSkillVersionRegression, fetchSkillVersionConvergence, fetchSkillVersionSelfConsistency } from "@/lib/api";
import { useCriterion } from "@/lib/criterion-context";
import { verdictKindDescription } from "@/lib/verdict-kind";
import { compileJudgePrompt, KAPPA_MIN_SHARED_CASES, type ConvergenceAudit, type JudgeCard, type RegressionRunResult, type SelfConsistencyReport, type Skill, type SkillStatus, type SkillVersion } from "@coeval/shared";

// Explicit mapping for every SkillStatus value. Reviewer scanning a versions
// ledger needs to distinguish approved (on-deck) from deprecated (end of life)
// at a glance — collapsing both to neutral "outline" hides material state.
// `assertNever` keeps future schema additions honest.
type ChipVariant = "pass" | "ambig" | "fail" | "outline" | "default";
const STATUS_VARIANT: Record<SkillStatus, ChipVariant> = {
  production:   "pass",
  approved:     "pass",
  validated:    "pass",
  calibrating:  "ambig",
  needs_review: "ambig",
  draft:        "ambig",
  regressing:   "fail",
  failed:       "fail",
  deprecated:   "outline"
};
const STATUS_LABEL: Record<SkillStatus, string> = {
  production:   "current",
  approved:     "approved",
  validated:    "validated",
  calibrating:  "regression running",
  needs_review: "needs review",
  draft:        "draft · held",
  regressing:   "regressing",
  failed:       "regression check failed",
  deprecated:   "deprecated"
};

function StatusChip({ status }: { status: SkillStatus }) {
  return <Chip variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Chip>;
}

export function SkillVersionsScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [regressionRuns, setRegressionRuns] = useState<Record<string, RegressionRunResult>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchCurrentSkill(selectedCriterionId ?? undefined);
      setSkill(s);
      const history = await fetchSkillVersionHistory(s.id, 50);
      setVersions(history.versions);
      setRegressionRuns(Object.fromEntries(history.regressionRuns.map((run) => [run.skillVersionId, run])));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedCriterionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Async regression check (M0 C5b): a `calibrating` version is a gate.run in flight —
  // poll quietly until it lands as approved/regressing so the history updates
  // without a manual refresh. Silent refetch (no setLoading) to avoid a shell
  // flash on every tick; the interval tears down once nothing is calibrating.
  const anyCalibrating = versions.some((candidate) => candidate.status === "calibrating");
  useEffect(() => {
    if (!anyCalibrating) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const s = await fetchCurrentSkill(selectedCriterionId ?? undefined);
          const history = await fetchSkillVersionHistory(s.id, 50);
          if (cancelled) return;
          setSkill(s);
          setVersions(history.versions);
          setRegressionRuns(Object.fromEntries(history.regressionRuns.map((run) => [run.skillVersionId, run])));
        } catch {
          // Transient poll failure keeps last-good state; next tick retries.
        }
      })();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [anyCalibrating, selectedCriterionId]);

  if (loading && versions.length === 0) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Every version of the skill" title="Loading versions" />
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Every version of the skill" title="Could not load versions" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            {error ?? "Start the API with `pnpm dev:api` and refresh."}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Immutable evaluator history"
        title="Evaluator versions"
        sub="Each row is a saved evaluator version with its model settings and recorded Golden-set check. Open a version to inspect the guide, prompt, result format, and evidence attached to it."
        right={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            {versions.length >= 2 ? (
              <Button variant="default" size="sm" onClick={() => navigate("/skill/compare")}>
                Compare versions
              </Button>
            ) : null}
          </div>
        }
      />

      <Card className="mb-6">
        <Table>
          <thead>
            <tr>
              <th style={{ width: 110 }}>Version</th>
              <th style={{ width: 140 }}>Status</th>
              <th>Changes / model</th>
              <th style={{ width: 120 }} className="text-right">
                Golden agree
              </th>
              <th style={{ width: 80 }} className="text-right">
                Strict
              </th>
              <th style={{ width: 80 }} className="text-right">
                Lenient
              </th>
              <th style={{ width: 150 }}>Recorded</th>
              <th style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {versions.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center text-ink-3">
                  No versions recorded yet.
                </td>
              </tr>
            ) : null}
            {versions.map((v, index) => {
              const agreementPct =
                v.goldenSetAgreement == null ? null : Math.round(v.goldenSetAgreement * 100);
              const changes = skillVersionChangeLabels(v, versions[index + 1]);
              const regressionRun = regressionRuns[v.id];
              const receiptLabel = regressionReceiptLabel(regressionRun);
              const receiptAt = regressionRun?.createdAt ?? v.approvedAt;
              return (
                <tr
                  key={v.id}
                  className="row-link"
                  onClick={() => navigate(`/skill/versions/${v.id}`)}
                >
                  <td>
                    <RowLink to={`/skill/versions/${v.id}`} className="font-mono text-ink">
                      v{v.version}
                    </RowLink>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusChip status={v.status} />
                      {v.onboardingAssurance === "starter_unvalidated" ? <Chip>Starter · unvalidated</Chip> : null}
                      <GateChip state={gateStateForVersion(v)} title={v.knownLimitations.join(" · ")} />
                    </div>
                  </td>
                  <td>
                    <div className="text-[13px] text-ink-2">
                      {changes.join(" · ")}
                    </div>
                    <div className="mt-0.5 font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
                      {v.modelBinding.provider}/{v.modelBinding.modelId}@{v.modelBinding.modelVersion}
                    </div>
                    {v.knownLimitations.length > 0 ? (
                      <div className="mt-0.5 text-[10.5px] text-signal">
                        {v.knownLimitations.length} known limitation{v.knownLimitations.length === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {agreementPct == null ? "—" : (
                      <>
                        {agreementPct}
                        <span className="text-ink-3">%</span>
                      </>
                    )}
                  </td>
                  <td className="text-right font-mono tabular-nums">{v.tooStrictCount}</td>
                  <td className="text-right font-mono tabular-nums">{v.tooLenientCount}</td>
                  <td className="font-mono text-ink-3">
                    <div title={v.createdAt}>
                      {new Date(v.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                    </div>
                    <div className="mt-0.5 text-[10px]">
                      {receiptAt
                        ? `${receiptLabel} ${new Date(receiptAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                        : receiptLabel}
                    </div>
                  </td>
                  <td>
                    <ChevronRight className="size-3 text-ink-3" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card className="max-w-[80ch] border-dashed">
        <CardContent className="py-4">
          <Eyebrow>Why a Judge Card per version</Eyebrow>
          <div className="mt-2 font-serif text-[14px] leading-[1.55] tracking-[-0.005em] text-ink-2">
            A skill that judges other things must itself be judged. The card records the
            receipt: what model, what promoted reference cases, and what changed when this version was created.
            Every claim made against a trace links back to the card of the version that
            produced it.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function SkillVersionDetailScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const { id } = useParams<{ id: string }>();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [regression, setRegression] = useState<RegressionRunResult | null>(null);
  const [convergence, setConvergence] = useState<ConvergenceAudit | null>(null);
  const [consistency, setConsistency] = useState<SelfConsistencyReport | null>(null);
  // the AUTHORITATIVE Judge Card, fetched from /card (κ + basis + audit)
  // — distinct from the client-side signal assembly on this screen.
  const [judgeCard, setJudgeCard] = useState<JudgeCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRegression(null);
    setConvergence(null);
    setConsistency(null);
    setJudgeCard(null);
    (async () => {
      try {
        const s = await fetchCurrentSkill(selectedCriterionId ?? undefined);
        if (cancelled) return;
        setSkill(s);
        const vs = await fetchSkillVersions(s.id, 100);
        if (cancelled) return;
        setVersions(vs);
        // The recorded regression run is best-effort: fetchSkillVersionRegression
        // already maps 404 (no run for this version, e.g. the seeded baseline)
        // to null. We don't swallow other errors here — a 500/network failure
        // should surface via the surrounding catch, not silently omit the diff.
        if (id) {
          const run = await fetchSkillVersionRegression(s.id, id);
          if (!cancelled) setRegression(run);
          // A2.2c: the convergence audit is supplementary to the Judge Card. A
          // transient failure on it shouldn't collapse the whole version view
          // (rubric, prompt, regression) — isolate it and just omit the card,
          // mirroring how a missing regression run degrades to null.
          try {
            const page = await fetchSkillVersionConvergence(s.id, id);
            if (!cancelled) setConvergence(page.audit);
          } catch {
            if (!cancelled) setConvergence(null);
          }
          // self-consistency is the third trust signal on the card; like
          // convergence it degrades to absent rather than failing the view.
          try {
            const report = await fetchSkillVersionSelfConsistency(s.id, id);
            if (!cancelled) setConsistency(report);
          } catch {
            if (!cancelled) setConsistency(null);
          }
          // The attested Judge Card — supplementary like the signals above;
          // a transient failure omits the panel rather than failing the view.
          try {
            const cardData = await fetchJudgeCard(s.id, id);
            if (!cancelled) setJudgeCard(cardData);
          } catch {
            if (!cancelled) setJudgeCard(null);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, selectedCriterionId]);

  const v = versions.find((vv) => vv.id === id) ?? null;
  const isCurrent = v && skill ? v.id === skill.currentVersion.id : false;

  if (loading && !v) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Judge card" title="Loading version" />
      </div>
    );
  }

  if (error || !v) {
    return (
      <div className="fadeUp">
        <div className="mb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
            <ArrowLeft /> Back to versions
          </Button>
        </div>
        <SectionHead eyebrow="Judge card" title="Version not found" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            {error ?? "This version may have been archived or removed."}
          </CardContent>
        </Card>
      </div>
    );
  }

  const agreementPct = v.goldenSetAgreement == null ? null : Math.round(v.goldenSetAgreement * 100);
  const compiledPrompt = compileJudgePrompt({ prompt: v.prompt, rubricMarkdown: v.rubricMarkdown });

  return (
    <div className="fadeUp max-w-[1760px]">
      <div className="mb-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
          <ArrowLeft /> Back to versions
        </Button>
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
          <span>v{v.version}</span>
          <span>·</span>
          <span>
            {v.modelBinding.provider}/{v.modelBinding.modelId}@{v.modelBinding.modelVersion}
          </span>
        </div>
      </div>

      <SectionHead
        eyebrow={`Judge card · v${v.version}`}
        title={`${v.modelBinding.provider}/${v.modelBinding.modelId}`}
        sub={v.onboardingAssurance === "starter_unvalidated"
          ? `Starter · unvalidated · runnable does not mean calibrated · ${v.knownLimitations.length} known limitation${v.knownLimitations.length === 1 ? "" : "s"}`
          : `Approved ${v.approvedAt ? new Date(v.approvedAt).toLocaleString() : "—"} · ${v.knownLimitations.length} known limitation${v.knownLimitations.length === 1 ? "" : "s"}`}
        right={
          <div className="flex items-center gap-2">
            <StatusChip status={v.status} />
            {v.onboardingAssurance === "starter_unvalidated" ? <Chip>Starter · unvalidated</Chip> : null}
            <GateChip state={gateStateForVersion(v)} title={v.knownLimitations.join(" · ")} />
            {isCurrent ? <Chip>current</Chip> : null}
          </div>
        }
      />

      {judgeCard && skill ? <JudgeCardPanel card={judgeCard} skillId={skill.id} versionId={v.id} /> : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.3fr_1fr]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardContent className="py-4">
              <Eyebrow>Review guide · stored as Markdown</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Defines what a good result looks like and the evidence this evaluator should use.
              </p>
              <MarkdownPreview markdown={v.rubricMarkdown} className="mt-3 max-h-[520px]" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <Eyebrow>Judge instructions · exact compiled text</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Exact source sent to the judge after inserting the review guide. It is intentionally
                not rendered as Markdown.
              </p>
              <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-card-2 px-3 py-3 font-mono text-[12px] leading-[1.6] text-ink">
                {compiledPrompt.content || <span className="text-ink-3">No judge instructions recorded.</span>}
              </pre>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardContent className="py-4">
              <Eyebrow>Known-failure regression</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Compares this version with promoted reference cases. It does not measure overall
                evaluator quality or make a release decision.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                <div className="text-ink-3">Known-failure agreement</div>
                <div className="font-mono">
                  {agreementPct == null ? "—" : `${agreementPct}%`}
                </div>
                <div className="text-ink-3">Too strict</div>
                <div className="font-mono">{v.tooStrictCount}</div>
                <div className="text-ink-3">Too lenient</div>
                <div className="font-mono">{v.tooLenientCount}</div>
                <div className="text-ink-3">Ambiguous</div>
                <div className="font-mono">{v.ambiguousCount}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <Eyebrow>Requested model · immutable settings</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Provider, model, and temperature requested for this immutable version. Individual
                runs retain the provider-reported identity separately when available.
              </p>
              <div className="mt-2 grid grid-cols-1 gap-y-1 text-[13px] sm:grid-cols-[140px_1fr] sm:gap-y-2">
                <div className="text-ink-3">Provider</div>
                <div>{v.modelBinding.provider}</div>
                <div className="text-ink-3">Model id</div>
                <div className="font-mono">{v.modelBinding.modelId}</div>
                <div className="text-ink-3">Catalog identity</div>
                <div className="font-mono">{v.modelBinding.modelVersion}</div>
                <div className="text-ink-3">Temperature</div>
                <div className="font-mono">{v.modelBinding.temperature}</div>
                <div className="text-ink-3">Result type</div>
                <div>
                  <div className="font-mono">{v.verdictKind}</div>
                  <div className="mt-0.5 text-[11.5px] leading-5 text-ink-3">
                    {verdictKindDescription(v.verdictKind, {
                      scalarRange: v.scalarRange,
                      categoricalChoiceScores: v.categoricalChoiceScores
                    })}
                  </div>
                </div>
                <div className="text-ink-3">Pinned corpus</div>
                <div className="break-all font-mono text-[11px]" title={v.regressionDatasetRevisionId ?? undefined}>
                  {v.regressionDatasetRevisionId ?? "not pinned"}
                </div>
              </div>
            </CardContent>
          </Card>

          {v.knownLimitations.length > 0 ? (
            <Card>
              <CardContent className="py-4">
                <Eyebrow>Known limitations</Eyebrow>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[12.5px] text-ink-2">
                  {v.knownLimitations.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardContent className="py-4">
              <Eyebrow>Result format · exact JSON schema</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Fields and allowed values the judge must return. Coeval validates results against
                this exact contract, so it remains source text rather than Markdown.
              </p>
              <pre className="mt-3 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-card-2 px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink">
                {v.outputSchema != null && Object.keys(v.outputSchema as object).length > 0 ? (
                  JSON.stringify(v.outputSchema, null, 2)
                ) : (
                  <span className="text-ink-3">No schema recorded.</span>
                )}
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-6">
        {regression && regression.cases.length > 0 ? (
          <RegressionDiffTable
            cases={regression.cases}
            title="Regression at version creation"
            description={`The immutable reference revision pinned when this version was created was re-judged${regression.datasetRevisionId ? ` (${regression.datasetRevisionId})` : ""}. Click a row to open the trace.`}
          />
        ) : regression && regression.compared > 0 ? (
          <MarginNote tone="neutral" who="Regression">
            {regression.compared} case{regression.compared === 1 ? "" : "s"} were re-judged when this
            version was created, but this run didn't capture a per-case breakdown (older run format).
          </MarginNote>
        ) : null}
      </div>

      {convergence ? (
        <div className="mt-6">
          <ConvergenceCard
            audit={convergence}
            versionLabel={`v${v.version}`}
            beforeVersionLabel={
              convergence.beforeVersionId
                ? (() => {
                    const before = versions.find((vv) => vv.id === convergence.beforeVersionId);
                    return before ? `v${before.version}` : null;
                  })()
                : null
            }
          />
        </div>
      ) : null}

      <div className="mt-6">
        <SelfConsistencyCard report={consistency} />
      </div>
    </div>
  );
}

// self-consistency — one of the three trust signals, and the weakest on
// its own: a judge can be perfectly consistent and consistently wrong. Framed
// as "does the requested model repeat itself", never as correctness.
// the attested Judge Card — rendered FROM the /card JSON (not
// re-derived), with Markdown export/copy that pull /card?format=md so what's
// shown, copied, and downloaded all trace to the same attested source. Names
// and free-text arrive already escaped from the server (C1); React text nodes
// escape them again on render — belt and suspenders.
function JudgeCardPanel({ card, skillId, versionId }: { card: JudgeCard; skillId: string; versionId: string }) {
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState(false);
  const copyMarkdown = useCallback(async () => {
    try {
      const md = await fetchJudgeCardMarkdown(skillId, versionId);
      await navigator.clipboard?.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* copy is best-effort; export is the reliable path */
    }
  }, [skillId, versionId]);
  // Export via a fetch+blob download, NOT an anchor navigation: an anchor
  // cannot send the x-coeval-project header, so the server would resolve the
  // caller's oldest project and could export a DIFFERENT project's card than
  // the panel shows. fetchJudgeCardMarkdown sends the header → exported bytes
  // always match this panel's project.
  const exportMarkdown = useCallback(async () => {
    setExportError(false);
    try {
      const md = await fetchJudgeCardMarkdown(skillId, versionId);
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `coeval-judge-card-${stamp}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
    }
  }, [skillId, versionId]);
  // SkillFormat v1 JSON export — same project-scoped blob download.
  const exportSkillFormat = useCallback(async () => {
    setExportError(false);
    try {
      const doc = await fetchSkillFormat(skillId, versionId);
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `coeval-skill-format-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
    }
  }, [skillId, versionId]);

  const agreement = card.goldenSet.agreement;
  return (
    <Card className="mb-6 border-l-2 border-l-ink/40" data-judge-card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Eyebrow>Judge Card · attested · {card.version.version}</Eyebrow>
            <div className="mt-1 text-[11px] text-ink-3">
              This card contains recorded evidence for one evaluator version. It keeps each signal
              separate and does not turn them into a combined score.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="default" size="sm" onClick={() => void exportMarkdown()} data-card-export>
              <Download /> {exportError ? "Export failed" : "Export as Markdown"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void copyMarkdown()} data-card-copy>
              <Copy /> {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void exportSkillFormat()} data-skillformat-export>
              <Download /> SkillFormat
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
          <div className="text-ink-3">Requested model</div>
          <div className="font-mono">{card.modelBinding.provider}/{card.modelBinding.modelId} · {card.modelBinding.modelVersion}</div>
          <div className="text-ink-3">Rubric provenance</div>
          <div className="font-mono">{card.version.rubricProvenance}</div>
          <div className="text-ink-3">Known-failure agreement</div>
          <div className="font-mono">
            {agreement === null
              ? "no comparable promoted reference cases"
              : `recorded ratio ${agreement.toFixed(2)}${card.regression ? ` over ${card.regression.compared} case(s) at version creation` : ""}`}
          </div>
          <div className="text-ink-3">Evaluator regression</div>
          <div className="font-mono">
            {card.regression
              ? `${card.regression.status} · ${card.regression.compared} compared, ${card.regression.regressed} regressed, ${card.regression.flipped} flipped`
              : "no recorded run"}
          </div>
          <div className="text-ink-3">Judge–human κ</div>
          <div className="font-mono">
            {card.judgeHumanKappa.filter((pair) => pair.cases >= KAPPA_MIN_SHARED_CASES).length === 0
              ? card.judgeHumanKappa.length === 0
                ? "none recorded yet"
                : `gathering evidence · ${Math.min(Math.max(...card.judgeHumanKappa.map((pair) => pair.cases)), KAPPA_MIN_SHARED_CASES)}/${KAPPA_MIN_SHARED_CASES} shared cases`
              : card.judgeHumanKappa
                  .filter((pair) => pair.cases >= KAPPA_MIN_SHARED_CASES)
                  .map((p) => `${p.kappa.toFixed(2)} (${p.interpretation.replace("_", " ")}) vs ${p.humanRater} · ${p.cases}`)
                  .join(" · ")}
          </div>
          <div className="text-ink-3">Self-consistency</div>
          <div className="font-mono">
            {card.selfConsistency
              ? `${card.selfConsistency.consistentCases}/${card.selfConsistency.comparedCases} repeated cases returned the same verdict; repeated answers can still be wrong`
              : "not probed yet"}
          </div>
        </div>

        <div className="mt-4">
          <Eyebrow>Basis</Eyebrow>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[11.5px] leading-[1.5] text-ink-2" data-card-basis>
            {card.basis.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function SelfConsistencyCard({ report }: { report: SelfConsistencyReport | null }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 flex items-baseline justify-between">
          <Eyebrow>Self-consistency</Eyebrow>
          {report && report.comparedCases > 0 ? (
            <span className="font-mono text-[11px] text-ink-3">
              {report.consistentCases}/{report.comparedCases} cases fully consistent · mean{" "}
              {report.meanAgreement === null ? "—" : report.meanAgreement.toFixed(2)}
            </span>
          ) : null}
        </div>
        {!report || report.comparedCases === 0 ? (
          <div className="text-[12.5px] leading-[1.55] text-ink-3">
            No repeat runs under this version yet. Re-judge a case with <code>force: true</code> on{" "}
            <code>POST /api/v1/judge</code> (or re-run a dataset eval) to probe whether the requested
            model repeats its own verdicts.
          </div>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Runs</th>
                  <th>Majority label</th>
                  <th>Distinct labels</th>
                  <th>Agreement</th>
                </tr>
              </thead>
              <tbody>
                {report.cases.map((entry) => (
                  <tr key={entry.caseId} className={entry.distinctLabels > 1 ? "row-signal" : undefined}>
                    <td className="font-mono text-[11px]">{entry.caseId}</td>
                    <td className="font-mono text-[11px]">{entry.runs}</td>
                    <td><LabelChip label={entry.majorityLabel} /></td>
                    <td className="font-mono text-[11px]">{entry.distinctLabels}</td>
                    <td className="font-mono text-[11px]">{entry.agreement.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-2 text-[11px] text-ink-3">
              This measures only whether the evaluator repeated its verdict on cases judged at
              least twice. A repeated verdict can still be wrong, so read it separately from
              Golden-set agreement and convergence with human rulings.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
