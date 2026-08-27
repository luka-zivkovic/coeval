import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, ShieldCheck, Undo2 } from "lucide-react";
import type { GovernedBlindTaskView, GovernedReviewLabelValue } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  deferGovernedTask,
  fetchGovernedBlindTaskView,
  fetchGovernedTasks,
  resumeGovernedTask,
  submitGovernedLabel,
  withdrawGovernedLabel,
  type GovernedBlindTaskArtifact,
  type GovernedTaskSummary
} from "@/lib/governed-review-api";

export function GovernedReviewTaskScreen() {
  const { taskId = "" } = useParams();
  const [artifact, setArtifact] = useState<GovernedBlindTaskArtifact | null>(null);
  const [task, setTask] = useState<GovernedTaskSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The exact blind artifact is persisted by the first request. Only then
      // read this reviewer's governed task stream version for CAS actions.
      const exactArtifact = await fetchGovernedBlindTaskView(taskId);
      const assignments = await fetchGovernedTasks();
      setArtifact(exactArtifact);
      setTask(assignments.find((candidate) => candidate.taskId === taskId) ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshTask = useCallback(async () => {
    const assignments = await fetchGovernedTasks();
    setTask(assignments.find((candidate) => candidate.taskId === taskId) ?? null);
  }, [taskId]);

  if (loading && !artifact) return <LoadingTask />;
  if (error && !artifact) return <TaskFailure message={error} retry={() => void load()} />;
  if (!artifact) return <TaskFailure message="This governed task did not return a blind view." retry={() => void load()} />;

  return (
    <div className="fadeUp">
      {error ? <TaskAlert message={error} /> : null}
      <BlindTaskEvidence artifact={artifact} />
      <TaskActions
        artifact={artifact}
        task={task}
        onChanged={refreshTask}
        onError={setError}
      />
    </div>
  );
}

export function BlindTaskEvidence({ artifact }: { artifact: GovernedBlindTaskArtifact }) {
  const { view } = artifact;
  return (
    <>
      <div className="mb-7">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-signal">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Exact frozen reviewer view
        </div>
        <h1 className="mt-2 font-serif text-[28px] font-medium tracking-[-0.03em]">{view.instruction.title}</h1>
        <div className="mt-2 break-all font-mono text-[10px] text-ink-4">view digest · {artifact.viewDigest}</div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader><CardTitle>Evidence supplied for review</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <EvidencePart label="Input" value={view.payloadSnapshot.input} />
            <EvidencePart label="Output" value={view.payloadSnapshot.output} />
            {view.payloadSnapshot.steps?.length ? (
              <section aria-labelledby="frozen-steps-title">
                <h2 id="frozen-steps-title" className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">Steps</h2>
                <ol className="space-y-3">
                  {view.payloadSnapshot.steps.map((step, index) => (
                    <li key={`${step.name}-${index}`} className="rounded-sm border border-rule-soft bg-paper-2 p-3">
                      <div className="mb-2 font-serif text-[13px] font-medium">{step.name}</div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <EvidencePart label="Step input" value={step.input} compact />
                        <EvidencePart label="Step output" value={step.output} compact />
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Criterion</CardTitle></CardHeader>
            <CardContent>
              <div className="font-serif text-[16px] font-medium">{view.criterion.name}</div>
              <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-6 text-ink-2">{view.criterion.definition}</p>
              <Digest label="criterion" value={view.criterion.criterionDigest} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Reviewer instructions</CardTitle></CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-[12.5px] leading-6 text-ink-2">{view.instruction.instructions}</p>
              {view.instruction.failureCodeGuidance ? (
                <div className="mt-4 border-l-2 border-gold pl-3 text-[11.5px] leading-5 text-ink-3">
                  {view.instruction.failureCodeGuidance}
                </div>
              ) : null}
              <Digest label="instruction" value={view.instruction.instructionDigest} />
            </CardContent>
          </Card>
        </div>
      </div>

      <details className="mt-5 rounded-sm border border-rule-soft bg-card px-4 py-3">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">
          Exact canonical reviewer-view bytes
        </summary>
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-paper-2 p-3 font-mono text-[10px] leading-5 text-ink-3">
          {artifact.canonicalText}
        </pre>
      </details>
    </>
  );
}

function TaskActions({
  artifact,
  task,
  onChanged,
  onError
}: {
  artifact: GovernedBlindTaskArtifact;
  task: GovernedTaskSummary | null;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [label, setLabel] = useState<GovernedReviewLabelValue | null>(null);
  const [rationale, setRationale] = useState("");
  const [failureCodeText, setFailureCodeText] = useState("");
  const [deferReason, setDeferReason] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("");
  const [working, setWorking] = useState(false);
  const state = task?.state ?? null;
  const streamVersion = task?.stateVersion ?? null;
  const codes = useMemo(
    () => failureCodeText.split("\n").map((code) => code.trim()).filter(Boolean),
    [failureCodeText]
  );

  async function run(action: () => Promise<unknown>) {
    setWorking(true);
    onError(null);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }

  if (!task) {
    return <TaskAlert message="The task list response did not include this assignment, so no state-changing action is available." />;
  }
  if (streamVersion === null) {
    return <TaskAlert message="The governed task response omitted its stream version. Refresh after the API supplies a CAS version; no action was sent." />;
  }

  const mayLabel = state === "viewed" || state === "withdrawn";
  const mayDefer = state === "viewed";
  const mayResume = state === "deferred";
  const mayWithdraw = state === "submitted" && Boolean(task.activeLabelId);
  const activeLabelId = task.activeLabelId;

  return (
    <Card className="mt-7">
      <CardHeader className="justify-between">
        <div>
          <CardTitle>Record your independent label</CardTitle>
          <div className="mt-1 font-mono text-[10px] text-ink-4">task state · {state ?? "unavailable"} · stream {streamVersion}</div>
        </div>
        <span className="rounded-full border border-rule px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3">
          append only
        </span>
      </CardHeader>
      <CardContent>
        {mayLabel ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!label || !rationale.trim()) return;
              void run(() => submitGovernedLabel({
                taskId: task.taskId,
                expectedStreamVersion: streamVersion,
                viewDigest: artifact.viewDigest,
                label,
                rationale,
                failureCodes: codes
              }));
            }}
          >
            <fieldset>
              <legend className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">Label</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <LabelChoice value="pass" current={label} onChange={setLabel} description="Criterion is satisfied" />
                <LabelChoice value="fail" current={label} onChange={setLabel} description="Criterion is not satisfied" />
                <LabelChoice value="cannot_determine" current={label} onChange={setLabel} description="Evidence is insufficient" />
              </div>
            </fieldset>
            <label className="mt-5 block">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">Rationale · required</span>
              <Textarea
                className="mt-2"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                placeholder={label === "cannot_determine" ? "Explain exactly what evidence is missing or ambiguous." : "Explain the evidence behind your label."}
                required
              />
            </label>
            <label className="mt-4 block">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">Open failure codes · optional · one verbatim code per line</span>
              <Textarea
                className="mt-2 min-h-20"
                value={failureCodeText}
                onChange={(event) => setFailureCodeText(event.target.value)}
                placeholder="missing_support\ncontradictory_output"
              />
            </label>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" type="submit" disabled={working || !label || !rationale.trim()}>
                <CheckCircle2 /> Submit independent label
              </Button>
            </div>
          </form>
        ) : mayResume ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-[12px] text-ink-3">This task is deferred. Resume it to return to the frozen view and label it.</p>
            <Button
              variant="primary"
              disabled={working}
              onClick={() => void run(() => resumeGovernedTask(task.taskId, streamVersion, null))}
            >
              <RotateCcw /> Resume task
            </Button>
          </div>
        ) : mayWithdraw ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!activeLabelId || !withdrawReason.trim()) return;
              void run(() => withdrawGovernedLabel({
                taskId: task.taskId,
                expectedStreamVersion: streamVersion,
                labelId: activeLabelId,
                reason: withdrawReason
              }));
            }}
          >
            <p className="text-[12px] leading-5 text-ink-3">
              Withdrawing keeps the submitted label in the audit history. You can replace it only
              while labeling is open and before other reviewers can see the result.
            </p>
            <label className="mt-4 block">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">Withdrawal reason · required</span>
              <Textarea className="mt-2 min-h-20" value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} required />
            </label>
            <div className="mt-4 flex justify-end">
              <Button variant="outline" type="submit" disabled={working || !withdrawReason.trim()}>
                <Undo2 /> Withdraw label
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-center gap-3 text-[12px] text-ink-3">
            <Clock3 className="size-4" aria-hidden="true" />
            No reviewer action is available in state <span className="font-mono">{state ?? "unavailable"}</span>.
          </div>
        )}

        {mayDefer ? (
          <form
            className="mt-6 border-t border-rule-soft pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!deferReason.trim()) return;
              void run(() => deferGovernedTask(task.taskId, streamVersion, deferReason));
            }}
          >
            <label className="block">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">Need to defer? Give a reason</span>
              <div className="mt-2 flex gap-2">
                <Textarea className="min-h-16 flex-1" value={deferReason} onChange={(event) => setDeferReason(event.target.value)} required />
                <Button className="self-end" variant="default" type="submit" disabled={working || !deferReason.trim()}>
                  <Clock3 /> Defer
                </Button>
              </div>
            </label>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LabelChoice({
  value,
  current,
  onChange,
  description
}: {
  value: GovernedReviewLabelValue;
  current: GovernedReviewLabelValue | null;
  onChange: (value: GovernedReviewLabelValue) => void;
  description: string;
}) {
  return (
    <label className={`cursor-pointer rounded-sm border p-3 ${current === value ? "border-ink bg-paper-2" : "border-rule-soft bg-card"}`}>
      <input
        className="sr-only"
        type="radio"
        name="governed-label"
        value={value}
        checked={current === value}
        onChange={() => onChange(value)}
      />
      <span className="block font-serif text-[14px] font-medium">{value.replaceAll("_", " ")}</span>
      <span className="mt-1 block text-[11px] text-ink-3">{description}</span>
    </label>
  );
}

function EvidencePart({ label, value, compact = false }: { label: string; value: unknown; compact?: boolean }) {
  return (
    <section>
      <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">{label}</h2>
      <pre className={`overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-paper p-3 font-mono text-[11px] leading-5 text-ink-2 ${compact ? "max-h-48" : "max-h-[28rem]"}`}>
        {formatJson(value)}
      </pre>
    </section>
  );
}

function Digest({ label, value }: { label: string; value: string }) {
  return <div className="mt-4 break-all border-t border-rule-soft pt-3 font-mono text-[9.5px] text-ink-4">{label} digest · {value}</div>;
}

function formatJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function LoadingTask() {
  return <div className="py-24 text-center font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3">Loading exact frozen view…</div>;
}

function TaskFailure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Card className="mx-auto max-w-xl border-signal-tint">
      <CardContent className="py-10 text-center">
        <AlertTriangle className="mx-auto size-6 text-signal" aria-hidden="true" />
        <h1 className="mt-3 font-serif text-[18px]">The blind task could not be opened.</h1>
        <p role="alert" className="mt-2 text-[12px] leading-5 text-ink-3">{message}</p>
        <Button className="mt-5" variant="primary" onClick={retry}>Try again</Button>
      </CardContent>
    </Card>
  );
}

function TaskAlert({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-5 rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">
      {message}
    </div>
  );
}

// Keeps the public evidence component's contract explicit for server-rendered
// tests without exposing any broader review context.
export type BlindTaskEvidenceView = GovernedBlindTaskView;
