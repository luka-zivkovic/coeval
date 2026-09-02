import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye } from "lucide-react";
import type {
  AnalysisObservationAssignmentEventArtifact,
  AnalysisObservationAssignmentEventInput,
  AnalysisStudyItemEventArtifact,
  AnalysisStudyItemProjection,
  AnalysisTaxonomyDetail
} from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  appendAnalysisObservationAssignment,
  appendAnalysisStudyItemEvent,
  fetchAnalysisObservationAssignments,
  type AnalysisStudyItemContent
} from "@/lib/analysis-study-api";
import { useIdempotentAction } from "./support.js";

export function CodingCard({ item, events, eventCursor, content, taxonomy, codingOpen, totalItems, onView, onChanged, onMoreEvents, onAssignmentChanged, onError }: {
  item: AnalysisStudyItemProjection;
  events: AnalysisStudyItemEventArtifact[];
  eventCursor: string | null;
  content: AnalysisStudyItemContent | null;
  taxonomy: AnalysisTaxonomyDetail | null;
  codingOpen: boolean;
  totalItems: number;
  onView: () => Promise<void>;
  onChanged: (item: AnalysisStudyItemProjection) => Promise<void>;
  onMoreEvents: () => Promise<void>;
  onAssignmentChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const [label, setLabel] = useState("");
  const [rationale, setRationale] = useState("");
  const [anchor, setAnchor] = useState<"case_output" | "step">("case_output");
  const [stepIndex, setStepIndex] = useState("0");
  const [refreshing, setRefreshing] = useState(false);
  const headingRef = useRef<HTMLSpanElement | null>(null);
  const operationInFlight = useRef(false);
  const mutation = useIdempotentAction();
  const actionBusy = mutation.busy || refreshing;
  useEffect(() => { headingRef.current?.focus(); }, [item.item.id]);
  const append = async (input: Parameters<typeof appendAnalysisStudyItemEvent>[2]) => {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setRefreshing(true);
    const signature = JSON.stringify({ ...input, idempotencyKey: null });
    try {
      const result = await mutation.run(signature, (idempotencyKey) => appendAnalysisStudyItemEvent(
        item.item.studyId, item.item.id, { ...input, idempotencyKey }
      ));
      if (input.eventType === "failure_observed" || input.eventType === "no_failure_observed") {
        setLabel("");
        setRationale("");
        setAnchor("case_output");
        setStepIndex("0");
      }
      await onChanged(result.item);
    }
    catch (cause) { onError(cause); }
    finally {
      operationInFlight.current = false;
      setRefreshing(false);
    }
  };
  const activeFailureEvents = useMemo(() => events.filter((event) =>
    event.eventType === "failure_observed" && item.activeFailureObservationEventIds.includes(event.id)
  ), [events, item.activeFailureObservationEventIds]);
  return <Card>
    <CardHeader className="justify-between"><div><CardTitle><span ref={headingRef} tabIndex={-1}>Review run {item.item.position + 1} of {totalItems}</span></CardTitle><p className="mt-1 text-[10.5px] text-ink-3">What went wrong? Record each distinct issue, or say no issue was found.</p></div>
      <Button variant="ghost" size="sm" onClick={() => void onView()}><Eye /> {content ? "Reload run" : "Open run"}</Button></CardHeader>
    <CardContent>
      {content ? <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div><div className="mb-1 text-[10.5px] font-medium text-ink-3">Input</div><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-card-2 p-3 text-[10.5px]">{JSON.stringify(content.payloadSnapshot.input, null, 2)}</pre></div>
        <div><div className="mb-1 text-[10.5px] font-medium text-ink-3">Output</div><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-card-2 p-3 text-[10.5px]">{JSON.stringify(content.payloadSnapshot.output, null, 2)}</pre></div>
      </div> : <p className="mb-4 rounded-sm border border-dashed border-rule-soft px-3 py-4 text-[11px] text-ink-3">Open this run when you are ready to review it. Opening records access to the frozen analysis evidence.</p>}
      <div className="space-y-2">
        {activeFailureEvents.length > 0 ? <div className="text-[10.5px] font-medium text-ink-3">Recorded observations</div> : null}
        {activeFailureEvents.map((event) => event.eventType === "failure_observed" ? <div key={event.id} className="rounded-sm border border-rule-soft p-3 text-[11px]">
          <div className="font-medium">{event.failureLabel}</div><div className="mt-1 text-ink-3">{event.rationale}</div>
          {taxonomy ? <ObservationAssignmentControl taxonomy={taxonomy} observation={event} codingOpen={codingOpen}
            onChanged={onAssignmentChanged} onError={onError} /> : null}
          {codingOpen && item.state !== "completed" ? <Button variant="ghost" size="sm" disabled={actionBusy} onClick={() => void append({
            eventType: "failure_withdrawn", expectedVersion: item.currentVersion, targetEventId: event.id,
            targetEventDigest: event.eventDigest, rationale: "Withdrawn by reviewer", idempotencyKey: "pending"
          })}>Withdraw</Button> : null}
        </div> : null)}
      </div>
      {eventCursor ? <Button variant="ghost" size="sm" onClick={() => void onMoreEvents()}>Load earlier changes</Button> : null}
      {codingOpen && item.state !== "completed" && item.activeNoFailureEventId && item.activeNoFailureEventDigest ?
        <Button className="mt-3" variant="ghost" size="sm" disabled={actionBusy} onClick={() => void append({
          eventType: "no_failure_withdrawn", expectedVersion: item.currentVersion,
          targetEventId: item.activeNoFailureEventId!, targetEventDigest: item.activeNoFailureEventDigest!,
          rationale: "No-failure observation withdrawn for correction", idempotencyKey: "pending"
        })}>Withdraw no-failure observation</Button> : null}
      {codingOpen && item.state !== "completed" ? <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-[11px] text-ink-3">What went wrong?
          <Input className="mt-1" placeholder="Short, exact failure description" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={500} />
        </label>
        <label className="text-[11px] text-ink-3">Why?
          <Input className="mt-1" placeholder="Explain the evidence you saw" value={rationale} onChange={(event) => setRationale(event.target.value)} maxLength={5000} />
        </label>
        <details className="md:col-span-2 rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
          <summary className="cursor-pointer text-[10.5px] text-ink-3">Evidence anchor</summary>
          <div className="mt-2 flex gap-2">
            <select aria-label="Evidence anchor" value={anchor} onChange={(event) => setAnchor(event.target.value as typeof anchor)} className="h-9 rounded-sm border border-rule bg-card px-2 text-[12px]">
              <option value="case_output">Whole output</option><option value="step">One step</option>
            </select>
            {anchor === "step" ? <Input aria-label="Zero-based step number" type="number" min={0} value={stepIndex} onChange={(event) => setStepIndex(event.target.value)} /> : null}
          </div>
        </details>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button size="sm" disabled={actionBusy || !label.trim() || !rationale.trim() || item.activeNoFailureEventId !== null} onClick={() => void append({
            eventType: "failure_observed", expectedVersion: item.currentVersion, failureLabel: label.trim(), rationale: rationale.trim(),
            evidenceAnchor: anchor === "step" ? { kind: "step", stepIndex: Number(stepIndex) } : { kind: "case_output" }, idempotencyKey: "pending"
          })}>Record issue</Button>
          <Button variant="ghost" size="sm" disabled={actionBusy || !rationale.trim() || item.activeFailureObservationEventIds.length > 0} onClick={() => void append({
            eventType: "no_failure_observed", expectedVersion: item.currentVersion, rationale: rationale.trim(), idempotencyKey: "pending"
          })}>No issue found</Button>
          <Button variant="ghost" size="sm" disabled={actionBusy || (item.activeFailureObservationEventIds.length === 0 && item.activeNoFailureEventId === null)} onClick={() => void append({
            eventType: "coding_completed", expectedVersion: item.currentVersion, idempotencyKey: "pending"
          })}><Check /> Finish this run</Button>
        </div>
      </div> : null}
      {codingOpen && item.state === "completed" && item.completionEventId && item.completionEventDigest ? <Button className="mt-4" variant="ghost" size="sm" disabled={actionBusy} onClick={() => void append({
        eventType: "coding_reopened", expectedVersion: item.currentVersion, targetEventId: item.completionEventId!,
        targetEventDigest: item.completionEventDigest!, rationale: "Reopened for correction", idempotencyKey: "pending"
      })}>Reopen this run</Button> : null}
    </CardContent>
  </Card>;
}

function ObservationAssignmentControl({ taxonomy, observation, codingOpen, onChanged, onError }: {
  taxonomy: AnalysisTaxonomyDetail;
  observation: Extract<AnalysisStudyItemEventArtifact, { eventType: "failure_observed" }>;
  codingOpen: boolean;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const [history, setHistory] = useState<AnalysisObservationAssignmentEventArtifact[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [codeId, setCodeId] = useState("");
  const mutation = useIdempotentAction();
  const activeCodes = taxonomy.revision.codes.filter((code) => code.status === "active");
  const load = useCallback(async () => {
    try {
      const page = await fetchAnalysisObservationAssignments(taxonomy.taxonomy.id, observation.id, { limit: 100 });
      setHistory(page.items);
      setHistoryCursor(page.nextCursor);
    } catch (cause) { onError(cause); }
  }, [observation.id, taxonomy.taxonomy.id]);
  useEffect(() => { void load(); }, [load]);
  const head = history.reduce<AnalysisObservationAssignmentEventArtifact | null>((current, event) =>
    current === null || BigInt(event.version) > BigInt(current.version) ? event : current, null);
  const assigned = head?.eventType === "assigned" ? taxonomy.revision.codes.find((code) => code.codeId === head.codeId) : null;
  const mutate = async (withdraw: boolean) => {
    try {
      const input: AnalysisObservationAssignmentEventInput = withdraw ? {
        eventType: "withdrawn",
        observationEventId: observation.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        expectedVersion: head?.version ?? "0",
        expectedPredecessorEventId: head?.id ?? null,
        expectedPredecessorEventDigest: head?.eventDigest ?? null,
        codeId: null,
        rationale: "Assignment withdrawn during governed coding",
        idempotencyKey: "pending"
      } : {
        eventType: "assigned",
        observationEventId: observation.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        expectedVersion: head?.version ?? "0",
        expectedPredecessorEventId: head?.id ?? null,
        expectedPredecessorEventDigest: head?.eventDigest ?? null,
        codeId,
        rationale: "Assigned during governed open coding",
        idempotencyKey: "pending"
      };
      const signature = JSON.stringify({ ...input, idempotencyKey: null });
      await mutation.run(signature, (idempotencyKey) => appendAnalysisObservationAssignment(
        taxonomy.taxonomy.id,
        { ...input, idempotencyKey }
      ));
      await load(); onChanged();
    } catch (cause) { onError(cause); }
  };
  return <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-rule-soft pt-2">
    <span className="text-[10px] text-ink-4">Failure type: {assigned ? assigned.label : head?.eventType === "withdrawn" ? "assignment removed" : "not organized yet"}</span>
    {codingOpen ? <>
      <select aria-label={`Failure type for ${observation.failureLabel}`} value={codeId} onChange={(event) => setCodeId(event.target.value)} className="h-8 rounded-sm border border-rule bg-card px-2 text-[11px]">
        <option value="">Choose a failure type</option>{activeCodes.map((code) => <option key={code.codeId} value={code.codeId}>{code.label}</option>)}
      </select>
      <Button size="sm" variant="ghost" disabled={!codeId || mutation.busy} onClick={() => void mutate(false)}>Organize</Button>
      {head?.eventType === "assigned" ? <Button size="sm" variant="ghost" disabled={mutation.busy} onClick={() => void mutate(true)}>Remove assignment</Button> : null}
    </> : null}
    {historyCursor ? <Button size="sm" variant="ghost" onClick={async () => {
      try {
        const page = await fetchAnalysisObservationAssignments(taxonomy.taxonomy.id, observation.id, {
          limit: 100,
          cursor: historyCursor
        });
        setHistory((rows) => [...rows, ...page.items]);
        setHistoryCursor(page.nextCursor);
      } catch (cause) { onError(cause); }
    }}>Load older assignments</Button> : null}
  </div>;
}
