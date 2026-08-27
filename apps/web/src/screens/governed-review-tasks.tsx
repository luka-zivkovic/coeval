import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RefreshCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchGovernedTasks, type GovernedTaskSummary } from "@/lib/governed-review-api";

export function GovernedReviewTasksScreen() {
  const [tasks, setTasks] = useState<GovernedTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await fetchGovernedTasks());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="fadeUp">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-signal">Independent review</div>
          <h1 className="mt-2 font-serif text-[28px] font-medium tracking-[-0.03em]">Your governed tasks</h1>
          <p className="mt-2 max-w-[70ch] text-[13px] leading-6 text-ink-3">
            Each task shows the exact frozen evidence and instructions assigned to you. Reviewers
            submit independently, so you cannot see peer labels or evaluator evidence before labeling closes.
          </p>
        </div>
        <Button variant="default" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCcw /> Refresh
        </Button>
      </div>

      {error ? (
        <div role="alert" className="mb-5 rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">
          {error}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{loading && tasks.length === 0 ? "Loading assignments…" : `${tasks.length} assigned task${tasks.length === 1 ? "" : "s"}`}</CardTitle>
        </CardHeader>
        {!loading && tasks.length === 0 ? (
          <CardContent className="py-12 text-center">
            <ShieldCheck className="mx-auto size-7 text-ink-4" aria-hidden="true" />
            <div className="mt-3 font-serif text-[16px]">No governed tasks are assigned to you.</div>
            <p className="mx-auto mt-2 max-w-md text-[12px] leading-5 text-ink-3">
              Assignments are personal. A link to another reviewer's task will not give you access.
            </p>
          </CardContent>
        ) : (
          <ul className="divide-y divide-rule-soft">
            {tasks.map((task) => (
              <li key={task.taskId}>
                <Link
                  to={`/governed-review/tasks/${encodeURIComponent(task.taskId)}`}
                  className="grid grid-cols-1 items-center gap-3 px-[18px] py-4 hover:bg-card-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-serif text-[15px] font-medium">{task.instructionTitle ?? `Review task ${displayPosition(task)}`}</span>
                      <TaskState state={task.state} />
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-ink-4">
                      {task.criterionName ? `${task.criterionName} · ` : ""}{task.taskId}
                    </div>
                    {task.fixedStopAt ? (
                      <div className="mt-2 text-[11.5px] text-ink-3">Fixed stop · {formatDate(task.fixedStopAt)}</div>
                    ) : null}
                  </div>
                  <span className="flex items-center gap-2 text-[12px] text-ink-2">
                    Open frozen view <ArrowRight className="size-3.5" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TaskState({ state }: { state: string | null }) {
  const display = state?.replaceAll("_", " ") ?? "state unavailable";
  const quiet = state === "submitted" || state === "expired";
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] ${
      quiet ? "border-rule text-ink-4" : "border-gold-tint bg-ambig-bg text-gold"
    }`}>
      {display}
    </span>
  );
}

function displayPosition(task: GovernedTaskSummary): string {
  return task.servePosition === null ? "" : `${task.servePosition + 1}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
