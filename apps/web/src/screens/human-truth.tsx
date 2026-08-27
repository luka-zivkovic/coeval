import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpenCheck, DatabaseZap, Plus, RefreshCcw, Scale, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHead } from "@/components/coeval";
import { BinaryCalibrationPanel } from "@/components/binary-calibration-panel";
import { EvaluatorLifecyclePanel } from "@/components/evaluator-lifecycle-panel";
import { DatabaseModeRequired } from "@/components/database-mode-required";
import { useAppMode } from "@/lib/app-mode";
import { useCriterion } from "@/lib/criterion-context";
import { useDashboard } from "@/lib/dashboard-context";
import { humanTruthNextStep, humanTruthNextStepHref } from "../lib/human-truth-journey.js";
import {
  fetchGovernedBatches,
  fetchGovernedInstructions,
  transitionGovernedBatch,
  type GovernedBatchSummary,
  type GovernedInstructionSummary
} from "@/lib/governed-review-api";

export function HumanTruthScreen() {
  const { demoMode } = useAppMode();

  if (demoMode) {
    return (
      <DatabaseModeRequired
        eyebrow="Governed human truth · demo mode"
        title="Governed human truth needs authenticated reviewers."
        description="Independent assignments, blind views, immutable instructions, and adjudication provenance require persistent reviewer identities."
        demoAlternative="The demo includes ungoverned legacy review examples under Needs a human and Reliability; they never become governed truth."
      />
    );
  }

  return <PersistentHumanTruthScreen />;
}

function PersistentHumanTruthScreen() {
  const { selectedChoice, href } = useCriterion();
  const { dashboard } = useDashboard();
  const criterionVersionId = latestCriterionVersionId(selectedChoice);
  const skillVersionId = dashboard?.skill.currentVersion.criterionVersionId === criterionVersionId
    ? dashboard.skill.currentVersion.id
    : null;
  const [batches, setBatches] = useState<GovernedBatchSummary[]>([]);
  const [instructions, setInstructions] = useState<GovernedInstructionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingBatchId, setWorkingBatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextStep = loading || error
    ? null
    : humanTruthNextStep({
      criterionVersionId,
      instructionCount: instructions.length,
      batchStates: batches.map((batch) => batch.state)
    });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextBatches, nextInstructions] = await Promise.all([
        fetchGovernedBatches(criterionVersionId ? { criterionVersionId } : {}),
        fetchGovernedInstructions(criterionVersionId ?? undefined)
      ]);
      setBatches(nextBatches);
      setInstructions(nextInstructions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [criterionVersionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function transition(batch: GovernedBatchSummary, action: Parameters<typeof transitionGovernedBatch>[1]) {
    if (batch.stateVersion === null) {
      setError("The batch response omitted its state version; no transition was sent.");
      return;
    }
    setWorkingBatchId(batch.batchId);
    setError(null);
    try {
      await transitionGovernedBatch(batch.batchId, action, batch.stateVersion);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorkingBatchId(null);
    }
  }

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Governed human truth · append-only"
        title="Human truth"
        sub="Set up a review where people label the same frozen evidence independently, without seeing the evaluator's answer. Coeval preserves the instructions, assignments, disagreements, and final rulings. Ordinary review queues remain ungoverned."
        right={
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCcw /> Refresh
          </Button>
        }
      />

      {error ? (
        <div role="alert" className="mb-5 rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">{error}</div>
      ) : null}

      <Card className="mb-4 border-signal-tint">
        <CardHeader><CardTitle>Next step</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-[70ch] text-[12.5px] leading-5 text-ink-3">
            {nextStep?.description ?? (error
              ? "The saved setup state could not be loaded. Refresh before starting another governed action."
              : "Checking your saved instruction and batch state…")}
          </p>
          {nextStep ? (
            <Button variant="primary" asChild>
              <Link to={humanTruthNextStepHref(nextStep.path, href)}>
                <ShieldCheck /> {nextStep.label}
              </Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <details className="mb-6 rounded-sm border border-rule-soft bg-paper-2">
        <summary className="cursor-pointer px-4 py-3 text-[12px] font-medium text-ink-2">Other governed setup actions</summary>
        <div className="grid gap-3 border-t border-rule-soft p-3 md:grid-cols-2 xl:grid-cols-4">
          <CreateCard
            to={href("/human-truth/new/instruction")}
            icon={<BookOpenCheck className="size-4" />}
            title="New instruction version"
            description="Write the exact criterion instructions and failure-code guidance reviewers will see."
          />
          <CreateCard
            to={href("/human-truth/new/intake")}
            icon={<DatabaseZap className="size-4" />}
            title="Protected sealed intake"
            description="Add sealed cases without exposing their contents through ordinary project screens."
          />
          <CreateCard
            to={href("/human-truth/new/batch")}
            icon={<Plus className="size-4" />}
            title="New review batch"
            description="Choose the evidence, assign reviewers, set the review order, and decide when labeling closes."
          />
          <CreateCard
            to="/governed-review/tasks"
            icon={<ShieldCheck className="size-4" />}
            title="My blind task inbox"
            description="Open reviews assigned to you. Other project batches do not appear unless you have an assignment."
          />
        </div>
      </details>

      {selectedChoice?.criterion.sourceKind === "analysis_promotion" && criterionVersionId ? (
        <EvaluatorLifecyclePanel
          criterionId={selectedChoice.criterion.id}
          criterionVersionId={criterionVersionId}
          criterionName={selectedChoice.name}
          batches={batches}
        />
      ) : null}

      <Card className="mb-6">
        <CardHeader className="justify-between">
          <CardTitle>Instruction lineage</CardTitle>
          <span className="font-mono text-[10px] text-ink-4">{instructions.length} immutable version{instructions.length === 1 ? "" : "s"}</span>
        </CardHeader>
        {instructions.length === 0 ? (
          <CardContent className="text-[12px] text-ink-3">{loading ? "Loading instruction versions…" : "No governed instruction version exists for this criterion."}</CardContent>
        ) : (
          <ul className="divide-y divide-rule-soft">
            {instructions.map((instruction) => (
              <li key={instruction.instructionVersionId} className="grid gap-2 px-[18px] py-3 sm:grid-cols-[1fr_auto]">
                <div>
                  <div className="font-serif text-[14px] font-medium">{instruction.title}</div>
                  <div className="mt-1 font-mono text-[10px] text-ink-4">
                    {instruction.revision === null ? "revision unavailable" : `revision ${instruction.revision}`} · {instruction.instructionVersionId}
                  </div>
                </div>
                <DigestValue value={instruction.instructionDigest} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card id="review-batches" className="scroll-mt-5">
        <CardHeader className="justify-between">
          <CardTitle>Review batches</CardTitle>
          <span className="font-mono text-[10px] text-ink-4">selection and coverage remain explicit</span>
        </CardHeader>
        {batches.length === 0 ? (
          <CardContent className="py-10 text-center text-[12px] text-ink-3">
            {loading ? "Loading governed batches…" : "No governed batch exists for this criterion."}
          </CardContent>
        ) : (
          <div className="divide-y divide-rule-soft">
            {batches.map((batch) => (
              <BatchRow
                key={batch.batchId}
                batch={batch}
                busy={workingBatchId === batch.batchId}
                skillVersionId={skillVersionId}
                onTransition={(action) => void transition(batch, action)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function BatchRow({
  batch,
  busy,
  skillVersionId,
  onTransition
}: {
  batch: GovernedBatchSummary;
  busy: boolean;
  skillVersionId: string | null;
  onTransition: (action: Parameters<typeof transitionGovernedBatch>[1]) => void;
}) {
  const actions = actionsFor(batch.state);
  const postBarrier = batch.state && !["draft", "open"].includes(batch.state);
  return (
    <article className="px-[18px] py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-serif text-[16px] font-medium">Batch {batch.batchId}</h2>
            <StateBadge state={batch.state} />
            {batch.roleIntent === "sealed_validation" ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-gold-tint bg-ambig-bg px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-gold">
                <ShieldCheck className="size-3" /> sealed
              </span>
            ) : null}
          </div>
          <div className="mt-2 grid gap-x-7 gap-y-1 font-mono text-[10px] text-ink-4 sm:grid-cols-2 lg:grid-cols-3">
            <Meta label="instruction" value={batch.instructionVersionId} />
            <Meta label="source" value={batch.sourcePopulationKind && batch.sourcePopulationId
              ? `${batch.sourcePopulationKind} · ${batch.sourcePopulationId}`
              : batch.sourcePopulationKind} />
            <Meta label="selection" value={batch.selectionMethod} />
            <Meta label="batch items" value={formatCount(batch.itemCount ?? batch.populationSize, "item")} />
            <Meta label="draw" value={formatCount(batch.fixedBudget, "item")} />
            <Meta label="independent labels" value={batch.requiredIndependentLabels?.toString() ?? null} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {postBarrier && batch.members.length > 0 ? (
            <Button variant="default" size="sm" asChild>
              <Link to={`/human-truth/batches/${encodeURIComponent(batch.batchId)}/items/${encodeURIComponent(batch.members[0]!.reviewItemId)}/resolve`}>
                <Scale /> Resolve items
              </Link>
            </Button>
          ) : null}
          {actions.map((action, index) => (
            <Button
              key={action.path}
              variant={index === actions.length - 1 ? "primary" : "default"}
              size="sm"
              onClick={() => {
                if (confirmTransition(action.path)) onTransition(action.path);
              }}
              disabled={busy || batch.stateVersion === null}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <EvidenceBox
          label="Frozen provenance"
          value={batch.batchDigest
            ? `batch · ${batch.batchDigest} · population · ${batch.populationDigest ?? "not supplied"} · draw · ${batch.drawDigest ?? "not supplied"}`
            : "API response did not include a batch digest."}
        />
        <EvidenceBox
          label="Blindness"
          value={blindnessCopy(batch)}
        />
        <EvidenceBox
          label="Coverage"
          value={coverageCopy(batch)}
        />
        <EvidenceBox
          label="Materialized truth"
          value={batch.evidenceClass === "governed_blind" && batch.datasetRevisionId
            ? `governed blind · revision ${batch.datasetRevisionId}`
            : "No governed-blind dataset revision has been materialized."}
        />
      </div>
      {batch.representativeness.status === "eligible" && batch.representativeness.populationId ? (
        <div className="mt-3 rounded-sm border border-rule-soft bg-paper-2 px-3 py-2 font-mono text-[10px] text-ink-3">
          Representative only of · {batch.representativeness.populationId}
        </div>
      ) : batch.representativeness.status ? (
        <div className="mt-3 font-mono text-[10px] text-ink-4">
          Representativeness · {batch.representativeness.status.replaceAll("_", " ")}
          {batch.representativeness.reasons.length ? ` · ${batch.representativeness.reasons.join(" · ")}` : ""}
        </div>
      ) : null}
      {batch.roleIntent === "sealed_validation" && batch.state === "frozen" &&
      batch.datasetRevisionId && batch.criterionVersionId ? (
        <BinaryCalibrationPanel
          datasetRevisionId={batch.datasetRevisionId}
          criterionVersionId={batch.criterionVersionId}
          skillVersionId={skillVersionId}
        />
      ) : null}
    </article>
  );
}

function CreateCard({ to, icon, title, description }: { to: string; icon: React.ReactNode; title: string; description: string }) {
  return (
    <Link to={to} className="rounded-sm border border-rule-soft bg-card p-4 hover:bg-card-2">
      <div className="flex items-center gap-2 font-serif text-[14px] font-medium">{icon}{title}</div>
      <p className="mt-2 text-[11.5px] leading-5 text-ink-3">{description}</p>
    </Link>
  );
}

function StateBadge({ state }: { state: string | null }) {
  return <span className="rounded-full border border-rule px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">{state?.replaceAll("_", " ") ?? "state unavailable"}</span>;
}

function EvidenceBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-rule-soft bg-paper-2 p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-4">{label}</div>
      <div className="mt-1 break-all text-[11px] leading-5 text-ink-2">{value}</div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string | null }) {
  return <span>{label} · <b className="font-normal text-ink-3">{value ?? "not supplied"}</b></span>;
}

function DigestValue({ value }: { value: string | null }) {
  return <div className="max-w-xs break-all text-right font-mono text-[9px] text-ink-4">{value ?? "digest not supplied"}</div>;
}

function blindnessCopy(batch: GovernedBatchSummary): string {
  const parts = [
    batch.evaluatorBlind === true ? "evaluator blind" : batch.evaluatorBlind === false ? "not evaluator blind" : "evaluator-blind status not supplied",
    batch.peerBlindUntilLabelingClosed === true ? "peer blind until barrier" : batch.peerBlindUntilLabelingClosed === false ? "peer-blind status false" : "peer-blind status not supplied"
  ];
  return parts.join(" · ");
}

function coverageCopy(batch: GovernedBatchSummary): string {
  const coverage = batch.coverage;
  if (coverage.totalTasks !== null) {
    return `${coverage.submittedTasks ?? "?"}/${coverage.totalTasks} submitted · ${coverage.deferredTasks ?? "?"} deferred · ${coverage.expiredTasks ?? "?"} expired`;
  }
  return "Coverage summary not supplied; state alone is not presented as completeness.";
}

function actionsFor(state: GovernedBatchSummary["state"]): Array<{ label: string; path: Parameters<typeof transitionGovernedBatch>[1] }> {
  switch (state) {
    case "draft": return [{ label: "Open labeling", path: "open" }];
    case "open": return [{ label: "Close labeling", path: "close-labeling" }];
    case "labeling_closed": return [
      { label: "Open alignment", path: "alignment/open" },
      { label: "Start adjudication", path: "adjudication/start" },
      { label: "Finalize if resolvable", path: "finalize" }
    ];
    case "alignment_open": return [
      { label: "Start adjudication", path: "adjudication/start" },
      { label: "Finalize", path: "finalize" }
    ];
    case "adjudicating": return [{ label: "Finalize resolution", path: "finalize" }];
    case "resolved": return [{ label: "Freeze truth revision", path: "freeze" }];
    default: return [];
  }
}

function formatCount(value: number | null, noun: string): string | null {
  return value === null ? null : `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function confirmTransition(action: Parameters<typeof transitionGovernedBatch>[1]): boolean {
  if (action === "close-labeling") {
    return window.confirm("Close independent labeling? This barrier is irreversible and reveals peer labels only after it succeeds.");
  }
  if (action === "freeze") {
    return window.confirm("Freeze the resolved truth into an immutable dataset revision? Existing evidence will not be rewritten.");
  }
  return true;
}

function latestCriterionVersionId(choice: ReturnType<typeof useCriterion>["selectedChoice"]): string | null {
  if (!choice?.detail) return null;
  return [...choice.detail.versions].sort((left, right) => right.revision - left.revision)[0]?.id ?? null;
}
