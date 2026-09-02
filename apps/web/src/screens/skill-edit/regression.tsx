import { ArrowLeft, Clock, LoaderCircle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip, Eyebrow, KPI, KPIRow, MarginNote, RegressionDiffTable, SectionHead } from "@/components/coeval";
import { SkillEditFlow, type SkillEditOutcome } from "@/components/skill-edit-flow";
import type { CompletedSkillVersionResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  regressionDirectionCounts,
  type CriterionVersion,
  type RegressionCaseDiff,
  type Skill,
  type SkillVersion
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

export function GovernedEvaluatorEditBoundary({
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

export function RegressionRunning({
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

export function RegressionResult({
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
