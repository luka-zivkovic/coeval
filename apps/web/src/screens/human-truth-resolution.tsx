import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Scale, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  appendGovernedAdjudication,
  appendGovernedAlignmentEvent,
  fetchGovernedBatch,
  fetchGovernedPostBarrierItem,
  type GovernedBatchSummary,
  type GovernedPostBarrierItem
} from "@/lib/governed-review-api";

type Purpose = "alignment" | "adjudication";

export function HumanTruthResolutionScreen() {
  const { batchId = "", itemId = "" } = useParams();
  const [purpose, setPurpose] = useState<Purpose>("adjudication");
  const [batch, setBatch] = useState<GovernedBatchSummary | null>(null);
  const [item, setItem] = useState<GovernedPostBarrierItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextBatch, nextItem] = await Promise.all([
        fetchGovernedBatch(batchId),
        fetchGovernedPostBarrierItem(batchId, itemId, purpose)
      ]);
      setBatch(nextBatch);
      setItem(nextItem);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [batchId, itemId, purpose]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="fadeUp max-w-[1080px]">
      <Link to="/human-truth" className="inline-flex items-center gap-2 text-[12px] text-ink-3 hover:text-ink">
        <ArrowLeft className="size-3.5" /> Human truth
      </Link>
      <div className="mb-6 mt-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-signal">After independent-submission barrier</div>
          <h1 className="mt-2 font-serif text-[26px] font-medium tracking-[-0.025em]">Alignment and adjudication</h1>
          <p className="mt-2 max-w-[72ch] text-[12.5px] leading-6 text-ink-3">
            The original reviewer labels remain unchanged. Use alignment to record discussion, or
            adjudication to add a final ruling for the active set of labels.
          </p>
        </div>
        <div className="flex rounded-sm border border-rule bg-paper-2 p-0.5">
          {(["alignment", "adjudication"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setPurpose(candidate)}
              className={`rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] ${purpose === candidate ? "bg-card text-ink shadow-[var(--shadow-card)]" : "text-ink-3"}`}
            >
              {candidate}
            </button>
          ))}
        </div>
      </div>

      {error ? <div role="alert" className="mb-5 rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">{error}</div> : null}
      {batch && batch.members.length > 1 ? <ItemNavigation batch={batch} currentItemId={itemId} /> : null}
      {loading && !item ? <Card><CardContent className="py-12 text-center text-[12px] text-ink-3">Loading post-barrier evidence…</CardContent></Card> : null}
      {item ? (
        <>
          <PostBarrierEvidence
            item={item}
            sealed={batch?.roleIntent === "sealed_validation"}
            evaluatorEvidenceAllowed={batch?.roleIntent === "analysis_authoring" || batch?.roleIntent === "iterative_development"}
          />
          {purpose === "alignment" && batch?.state === "alignment_open" ? (
            <AlignmentComposer batchId={batchId} item={item} onChanged={load} onError={setError} />
          ) : purpose === "adjudication" && batch?.state === "adjudicating" ? (
            <AdjudicationComposer batchId={batchId} itemId={itemId} item={item} onChanged={load} onError={setError} />
          ) : <StateBoundaryNotice purpose={purpose} state={batch?.state ?? null} />}
        </>
      ) : null}
    </div>
  );
}

function ItemNavigation({ batch, currentItemId }: { batch: GovernedBatchSummary; currentItemId: string }) {
  const index = batch.members.findIndex((member) => (member.batchItemId ?? member.reviewItemId) === currentItemId);
  const previous = index > 0 ? batch.members[index - 1] : null;
  const next = index >= 0 && index < batch.members.length - 1 ? batch.members[index + 1] : null;
  const hrefFor = (item: GovernedBatchSummary["members"][number]) =>
    `/human-truth/batches/${encodeURIComponent(batch.batchId)}/items/${encodeURIComponent(item.batchItemId ?? item.reviewItemId)}/resolve`;
  return (
    <nav aria-label="Batch review items" className="mb-5 flex items-center justify-between rounded-sm border border-rule-soft bg-card px-3 py-2">
      {previous ? <Link className="text-[12px] text-ink-2 hover:text-ink" to={hrefFor(previous)}>← Previous item</Link> : <span />}
      <span className="font-mono text-[9.5px] text-ink-4">item {index >= 0 ? index + 1 : "?"} of {batch.members.length}</span>
      {next ? <Link className="text-[12px] text-ink-2 hover:text-ink" to={hrefFor(next)}>Next item →</Link> : <span />}
    </nav>
  );
}

export function PostBarrierEvidence({
  item,
  sealed,
  evaluatorEvidenceAllowed = false
}: {
  item: GovernedPostBarrierItem;
  sealed: boolean;
  evaluatorEvidenceAllowed?: boolean;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        <Card>
          <CardHeader className="justify-between">
            <CardTitle>Frozen reviewed evidence</CardTitle>
            {sealed ? <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-gold"><ShieldCheck className="size-3" /> sealed</span> : null}
          </CardHeader>
          <CardContent>
            {item.payloadSnapshot ? (
              <div className="space-y-3">
                <JsonBlock label="Input" value={item.payloadSnapshot.input} />
                <JsonBlock label="Output" value={item.payloadSnapshot.output} />
                {item.payloadSnapshot.steps?.map((step, index) => <JsonBlock key={`${step.name}-${index}`} label={step.name} value={{ input: step.input, output: step.output }} />)}
              </div>
            ) : <MissingProjection text="The post-barrier response omitted its frozen payload snapshot." />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Independent labels at the barrier</CardTitle></CardHeader>
          {item.labels.length ? (
            <ul className="divide-y divide-rule-soft">
              {item.labels.map((label) => (
                <li key={label.labelId} className="px-[18px] py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-serif text-[14px] font-medium">{label.value?.replaceAll("_", " ") ?? "label unavailable"}</span>
                    <span className="font-mono text-[9.5px] text-ink-4">reviewer · {label.reviewerSubjectId ?? "not supplied"}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-ink-2">{label.rationale ?? "Rationale not supplied"}</p>
                  {label.failureCodes.length ? <div className="mt-2 flex flex-wrap gap-1">{label.failureCodes.map((code) => <span key={code} className="rounded-sm border border-rule bg-paper-2 px-2 py-0.5 font-mono text-[9.5px]">{code}</span>)}</div> : null}
                  <div className="mt-2 break-all font-mono text-[9px] text-ink-4">label · {label.labelId}</div>
                </li>
              ))}
            </ul>
          ) : <CardContent><MissingProjection text="No active independent labels were returned for this item." /></CardContent>}
        </Card>
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader><CardTitle>{item.criterion?.name ?? "Criterion"}</CardTitle></CardHeader>
          <CardContent><p className="whitespace-pre-wrap text-[12px] leading-5 text-ink-2">{item.criterion?.definition ?? "Criterion projection not supplied."}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{item.instruction?.title ?? "Reviewer instruction"}</CardTitle></CardHeader>
          <CardContent><p className="whitespace-pre-wrap text-[12px] leading-5 text-ink-2">{item.instruction?.instructions ?? "Instruction projection not supplied."}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Current resolution</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 font-mono text-[10px]">
              <ResolutionRow label="Basis" value={item.resolution?.basis ?? "not supplied"} />
              <ResolutionRow label="Reference label" value={item.resolution?.referenceLabel ?? "unresolved"} />
              <ResolutionRow label="Adjudication head" value={item.adjudicationHeadId ?? "none"} />
            </dl>
          </CardContent>
        </Card>
        {!evaluatorEvidenceAllowed ? (
          <div className="rounded-sm border border-gold-tint bg-ambig-bg p-3 text-[11.5px] leading-5 text-ink-3">
            {sealed
              ? "Evaluator evidence is never shown for sealed review, including after the barrier."
              : "Evaluator evidence is hidden because the batch role was not explicitly supplied as nonsealed."}
          </div>
        ) : item.evaluatorEvidence ? (
          <Card>
            <CardHeader><CardTitle>Evaluator evidence · post-barrier only</CardTitle></CardHeader>
            <CardContent>
              <ResolutionRow label="Label" value={item.evaluatorEvidence.label ?? "not supplied"} />
              {item.evaluatorEvidence.rationale ? <p className="mt-3 whitespace-pre-wrap text-[12px] leading-5 text-ink-2">{item.evaluatorEvidence.rationale}</p> : null}
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-sm border border-rule-soft bg-paper-2 p-3 text-[11px] leading-5 text-ink-3">
            This server projection did not include evaluator evidence. No evaluator comparison is inferred.
          </div>
        )}
      </div>
    </div>
  );
}

function AlignmentComposer({
  batchId,
  item,
  onChanged,
  onError
}: {
  batchId: string;
  item: GovernedPostBarrierItem;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [kind, setKind] = useState<"comment_recorded" | "instruction_change_proposed" | "closed">("comment_recorded");
  const [content, setContent] = useState("");
  const [successorInstructionId, setSuccessorInstructionId] = useState("");
  const [working, setWorking] = useState(false);

  if (item.alignmentVersion === null) {
    return <MissingVersion message="The post-barrier alignment response omitted expectedAlignmentVersion, so the UI cannot append an event safely." />;
  }
  const alignmentVersion = item.alignmentVersion;

  return (
    <Card className="mt-5">
      <CardHeader><CardTitle>Append alignment history</CardTitle></CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setWorking(true);
            onError(null);
            void appendGovernedAlignmentEvent({
              batchId,
              expectedAlignmentVersion: alignmentVersion,
              kind,
              content,
              ...(kind === "instruction_change_proposed" ? { proposedInstructionVersionId: successorInstructionId } : {})
            }).then(() => onChanged()).catch((cause) => onError(cause instanceof Error ? cause.message : String(cause))).finally(() => setWorking(false));
          }}
        >
          <label className="block">
            <span className={labelClass}>Event kind</span>
            <select className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="comment_recorded">Comment recorded</option>
              <option value="instruction_change_proposed">Instruction change proposed</option>
              <option value="closed">Close alignment</option>
            </select>
          </label>
          {kind === "instruction_change_proposed" ? (
            <label className="block"><span className={labelClass}>Exact successor instruction version</span><Input value={successorInstructionId} onChange={(event) => setSuccessorInstructionId(event.target.value)} required /></label>
          ) : null}
          <label className="block"><span className={labelClass}>Content · required</span><Textarea value={content} onChange={(event) => setContent(event.target.value)} required /></label>
          <div className="flex justify-end"><Button variant="primary" type="submit" disabled={working || !content.trim() || (kind === "instruction_change_proposed" && !successorInstructionId.trim())}>Append alignment event</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function AdjudicationComposer({
  batchId,
  itemId,
  item,
  onChanged,
  onError
}: {
  batchId: string;
  itemId: string;
  item: GovernedPostBarrierItem;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [decision, setDecision] = useState<"pass" | "fail" | "unresolvable">("unresolvable");
  const [rationale, setRationale] = useState("");
  const [basis, setBasis] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [working, setWorking] = useState(false);
  const correction = item.adjudicationHeadId !== null;

  return (
    <Card className="mt-5">
      <CardHeader><CardTitle><Scale className="mr-2 inline size-4" /> {correction ? "Append adjudication correction" : "Append adjudication"}</CardTitle></CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setWorking(true);
            onError(null);
            void appendGovernedAdjudication({
              batchId,
              itemId,
              expectedHeadAdjudicationId: item.adjudicationHeadId,
              decision,
              rationale,
              basis,
              ...(correction ? { correctionReason } : {})
            }).then(() => onChanged()).catch((cause) => onError(cause instanceof Error ? cause.message : String(cause))).finally(() => setWorking(false));
          }}
        >
          <label className="block">
            <span className={labelClass}>Decision</span>
            <select className={selectClass} value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
              <option value="unresolvable">Unresolvable</option>
            </select>
          </label>
          <label className="block"><span className={labelClass}>Rationale · required</span><Textarea value={rationale} onChange={(event) => setRationale(event.target.value)} required /></label>
          <label className="block"><span className={labelClass}>Basis in the exact active label set · required</span><Textarea value={basis} onChange={(event) => setBasis(event.target.value)} required /></label>
          {correction ? <label className="block"><span className={labelClass}>Correction reason · required</span><Textarea value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} required /></label> : null}
          <div className="flex justify-end"><Button variant="primary" type="submit" disabled={working || !rationale.trim() || !basis.trim() || (correction && !correctionReason.trim())}>Append adjudication</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return <section><h3 className={labelClass}>{label}</h3><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-paper p-3 font-mono text-[11px] leading-5 text-ink-2">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></section>;
}

function ResolutionRow({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-1 gap-1 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-2"><dt className="text-ink-4">{label}</dt><dd className="break-all text-ink-2">{value.replaceAll("_", " ")}</dd></div>;
}

function MissingProjection({ text }: { text: string }) {
  return <div className="rounded-sm border border-rule-soft bg-paper-2 p-3 text-[11.5px] leading-5 text-ink-3">{text}</div>;
}

function MissingVersion({ message }: { message: string }) {
  return <div role="alert" className="mt-5 rounded-sm border border-signal-tint bg-signal-wash p-4 text-[12px] text-signal">{message} No event was sent.</div>;
}

function StateBoundaryNotice({ purpose, state }: { purpose: Purpose; state: string | null }) {
  return (
    <div className="mt-5 rounded-sm border border-rule-soft bg-paper-2 p-4 text-[12px] leading-5 text-ink-3">
      {purpose === "alignment" ? "Alignment events" : "Adjudications"} can be appended only after the batch enters
      <span className="font-mono text-ink-2"> {purpose === "alignment" ? "alignment_open" : "adjudicating"}</span>.
      Current state: <span className="font-mono text-ink-2">{state ?? "not supplied"}</span>. Use the batch control plane to make the explicit transition.
    </div>
  );
}

const labelClass = "mb-2 block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3";
const selectClass = "w-full rounded-sm border border-rule bg-paper px-2.5 py-2 text-[13px] text-foreground focus:border-ink-3";
