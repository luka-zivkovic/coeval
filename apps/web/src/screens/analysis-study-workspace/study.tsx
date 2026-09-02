import { useEffect, useState } from "react";
import { BookOpen, Check, LockKeyhole, Plus, X } from "lucide-react";
import type { AnalysisPopulationSummary, AnalysisStudyDetail } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  abandonAnalysisStudy,
  closeAnalysisStudy,
  completeAnalysisStudy,
  createAnalysisStudy,
  openAnalysisStudy
} from "@/lib/analysis-study-api";
import { message, useIdempotentAction } from "./support.js";

export function CreateStudyCard({ populations, usedPopulationIds, usedPopulationIdsReady, usedPopulationIdsUnavailableCount, onCreated }: {
  populations: AnalysisPopulationSummary[];
  usedPopulationIds: ReadonlySet<string>;
  usedPopulationIdsReady: boolean;
  usedPopulationIdsUnavailableCount: number;
  onCreated: (studyId: string) => void;
}) {
  const [populationId, setPopulationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useIdempotentAction();
  useEffect(() => {
    if (populationId && usedPopulationIds.has(populationId)) {
      setPopulationId("");
      setError("That saved sample already has an analysis. Resume it below.");
    }
  }, [populationId, usedPopulationIds]);
  return <Card>
    <CardHeader><div><CardTitle>2. Start reviewing</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">Choose a saved sample. The newest analysis opens automatically after creation.</p></div></CardHeader>
    <CardContent>
      <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        if (!usedPopulationIdsReady) {
          setError("Wait while existing analyses are checked.");
          return;
        }
        if (usedPopulationIdsUnavailableCount > 0) {
          setError("Existing analyses are temporarily unavailable. Refresh before starting another analysis.");
          return;
        }
        if (usedPopulationIds.has(populationId)) {
          setPopulationId("");
          setError("That saved sample already has an analysis. Resume it below.");
          return;
        }
        try {
          const result = await mutation.run(`create:${populationId}`, (idempotencyKey) =>
            createAnalysisStudy({ populationId, idempotencyKey })
          );
          setPopulationId("");
          setError(null);
          onCreated(result.study.study.id);
        } catch (cause) {
          setError(message(cause));
        }
      }}>
        {error ? <p role="alert" className="text-[11px] text-signal">{error}</p> : null}
        <label className="block text-[11px] text-ink-3">Review sample
          <select value={populationId} onChange={(event) => setPopulationId(event.target.value)} required
            disabled={!usedPopulationIdsReady || usedPopulationIdsUnavailableCount > 0}
            className="mt-1 h-9 w-full rounded-sm border border-rule bg-card px-3 text-[12px]">
            <option value="">Choose a saved sample</option>
            {populations.map((row) => <option key={row.population.id} value={row.population.id}
              disabled={usedPopulationIds.has(row.population.id)}>
              {new Date(row.population.windowStart).toLocaleDateString()}–{new Date(row.population.windowEnd).toLocaleDateString()} · {row.draw.fixedBudget} runs
              {usedPopulationIds.has(row.population.id) ? " · analysis exists — resume below" : ""}
            </option>)}
          </select>
        </label>
        {!usedPopulationIdsReady ? <p role="status" className="text-[10.5px] text-ink-3">Checking which samples already have an analysis…</p> :
          usedPopulationIdsUnavailableCount > 0 ? <p role="status" className="text-[10.5px] text-signal">Some existing analyses are temporarily unavailable. Refresh before starting another analysis.</p> : null}
        <Button type="submit" size="sm" disabled={mutation.busy || !populationId || !usedPopulationIdsReady || usedPopulationIdsUnavailableCount > 0 || usedPopulationIds.has(populationId)}><Plus /> Start analysis</Button>
      </form>
    </CardContent>
  </Card>;
}

export function StudyAdminCard({ detail, busy, onChanged, onError }: {
  detail: AnalysisStudyDetail;
  busy: boolean;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const projection = detail.summary.study;
  const [rule, setRule] = useState<"explicit_owner_close" | "server_deadline">("explicit_owner_close");
  const [closeAt, setCloseAt] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [abandonReason, setAbandonReason] = useState("");
  const mutation = useIdempotentAction();
  const action = async (signature: string, operation: (idempotencyKey: string) => Promise<unknown>) => {
    try { await mutation.run(signature, operation); onChanged(); } catch (cause) { onError(cause); }
  };
  const nextAction = projection.state === "draft" ? "Ready to review" :
    projection.state === "coding_open" ? "Review the sample" :
    projection.state === "coding_closed" ? "Review finished" :
    projection.state === "completed" ? "Analysis recorded" : "Analysis stopped";
  return <Card>
    <CardHeader><div><CardTitle>{nextAction}</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">{detail.summary.completedItemCount}/{detail.summary.selectedItemCount} runs complete · {detail.summary.viewedItemCount} opened</p></div></CardHeader>
    <CardContent className="space-y-3">
      {projection.state === "draft" ? <>
        <p className="text-[11.5px] leading-5 text-ink-2">Start the review, then work through one run at a time. Every observation and correction stays in append-only history.</p>
        <Button size="sm" disabled={busy || mutation.busy || (rule === "server_deadline" && !closeAt)} onClick={() => void action(`open:${rule}:${closeAt}`, (idempotencyKey) => openAnalysisStudy(projection.study.id, {
          expectedVersion: projection.currentVersion,
          stoppingRule: rule === "server_deadline" ? { kind: rule, closeAt: new Date(closeAt).toISOString() } : { kind: rule, closeAt: null },
          idempotencyKey
        }))}><BookOpen /> Start reviewing runs</Button>
        <details className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
          <summary className="cursor-pointer text-[10.5px] text-ink-3">Advanced stopping rule</summary>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-[11px] text-ink-3">Finish
              <select value={rule} onChange={(event) => setRule(event.target.value as typeof rule)} className="ml-2 h-9 rounded-sm border border-rule bg-card px-2">
                <option value="explicit_owner_close">when an owner closes it</option><option value="server_deadline">at a server deadline</option>
              </select>
            </label>
            {rule === "server_deadline" ? <label className="text-[11px] text-ink-3">Deadline · local time
              <Input type="datetime-local" value={closeAt} onChange={(event) => setCloseAt(event.target.value)} />
            </label> : null}
          </div>
        </details>
      </> : null}
      {projection.state === "coding_open" && projection.stoppingRule?.kind === "explicit_owner_close" ? <div>
        <p className="mb-2 text-[11px] leading-5 text-ink-3">Finish when the planned review is over. Any unreviewed runs remain visibly missing; finishing never marks them complete.</p>
        <div className="flex gap-2">
          <Input aria-label="Why this review is ending" placeholder="Why is this review ending?" value={closeReason} onChange={(event) => setCloseReason(event.target.value)} maxLength={2000} />
          <Button size="sm" disabled={!closeReason.trim() || mutation.busy} onClick={() => void action(`close:${closeReason.trim()}`, (idempotencyKey) => closeAnalysisStudy(projection.study.id, {
            expectedVersion: projection.currentVersion, reason: closeReason.trim(), idempotencyKey
          }))}><LockKeyhole /> Finish review</Button>
        </div>
      </div> : null}
      {projection.state === "coding_closed" && projection.closureDigest ? <div>
        <p className="mb-2 text-[11px] text-ink-3">The closure receipt is immutable. Acknowledge it to mark the analysis workflow complete; this does not fill missing work.</p>
        <Button size="sm" disabled={mutation.busy} onClick={() => void action(`complete:${projection.closureDigest}`, (idempotencyKey) => completeAnalysisStudy(projection.study.id, {
          expectedVersion: projection.currentVersion, expectedClosureDigest: projection.closureDigest!, idempotencyKey
        }))}><Check /> Acknowledge receipt</Button>
      </div> : null}
      {(projection.state === "draft" || projection.state === "coding_open") ? <details className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
        <summary className="cursor-pointer text-[10.5px] text-ink-3">Stop and abandon this analysis</summary>
        <div className="mt-3 flex gap-2">
          <Input aria-label="Why this analysis is being abandoned" placeholder="Reason" value={abandonReason} onChange={(event) => setAbandonReason(event.target.value)} maxLength={2000} />
          <Button variant="ghost" size="sm" disabled={!abandonReason.trim() || mutation.busy} onClick={() => void action(`abandon:${abandonReason.trim()}`, (idempotencyKey) => abandonAnalysisStudy(projection.study.id, {
            expectedVersion: projection.currentVersion, reason: abandonReason.trim(), idempotencyKey
          }))}><X /> Abandon</Button>
        </div>
      </details> : null}
    </CardContent>
  </Card>;
}
