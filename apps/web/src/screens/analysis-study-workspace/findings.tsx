import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type {
  AnalysisCriterionPromotionCandidate,
  AnalysisTaxonomyCoverage,
  AnalysisTaxonomyDetail,
  AnalysisTaxonomyRevisionCodeInput
} from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createAnalysisTaxonomy, createAnalysisTaxonomyRevision } from "@/lib/analysis-study-api";
import { fetchAnalysisPromotionCandidates } from "@/lib/analysis-promotion-api";
import { message, useIdempotentAction } from "./support.js";

export function TaxonomyCard({ taxonomy, editable, onChanged }: { taxonomy: AnalysisTaxonomyDetail | null; editable: boolean; onChanged: () => void }) {
  const [name, setName] = useState("Failure types");
  const [description, setDescription] = useState("Human-authored failure types from reviewed runs.");
  const [label, setLabel] = useState("");
  const [definition, setDefinition] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useIdempotentAction();
  const addRevision = async () => {
    if (!taxonomy) return;
    const current = taxonomy.revision;
    const codes: AnalysisTaxonomyRevisionCodeInput[] = current.codes.map((code) => ({
      kind: "existing", codeId: code.codeId, label: code.label, definition: code.definition, status: code.status
    }));
    codes.push({ kind: "new", clientToken: `code:${label.trim()}`, label: label.trim(), definition: definition.trim() });
    const input = {
      expectedPredecessorRevisionId: current.revision.id,
      expectedPredecessorRevisionDigest: current.revision.revisionDigest,
      expectedPredecessorSequence: current.revision.sequence,
      reason: "Added a human-authored failure code",
      codes,
      idempotencyKey: "pending"
    } as const;
    await mutation.run(JSON.stringify({ ...input, idempotencyKey: null }), (idempotencyKey) =>
      createAnalysisTaxonomyRevision(taxonomy.taxonomy.id, { ...input, idempotencyKey })
    );
  };
  const retireCode = async (codeId: string) => {
    if (!taxonomy) return;
    const current = taxonomy.revision;
    const input = {
      expectedPredecessorRevisionId: current.revision.id,
      expectedPredecessorRevisionDigest: current.revision.revisionDigest,
      expectedPredecessorSequence: current.revision.sequence,
      reason: "Retired a human-authored failure code without changing its meaning",
      codes: current.codes.map((code) => ({
        kind: "existing" as const,
        codeId: code.codeId,
        label: code.label,
        definition: code.definition,
        status: code.codeId === codeId ? "retired" as const : code.status
      })),
      idempotencyKey: "pending"
    } as const;
    await mutation.run(JSON.stringify({ ...input, idempotencyKey: null }), (idempotencyKey) =>
      createAnalysisTaxonomyRevision(taxonomy.taxonomy.id, { ...input, idempotencyKey })
    );
  };
  return <Card><CardHeader><div><CardTitle>3. Organize findings into failure types</CardTitle><p className="mt-1 text-[10.5px] leading-5 text-ink-3">You name this flat list and assign observations yourself. Coeval does not cluster, merge, split, or generate categories.</p></div></CardHeader><CardContent>
    {error ? <p role="alert" className="mb-2 text-[11px] text-signal">{error}</p> : null}
    {taxonomy ? <div className="space-y-2">
      <div className="text-[11px] text-ink-3">{taxonomy.revision.codes.filter((code) => code.status === "active").length} current failure type{taxonomy.revision.codes.filter((code) => code.status === "active").length === 1 ? "" : "s"}</div>
      {taxonomy.revision.codes.map((code) => <div key={code.codeId} className="rounded-sm border border-rule-soft p-2 text-[11px]">
        <span className={code.status === "retired" ? "line-through text-ink-4" : "font-medium"}>{code.label}</span>
        <div className="text-ink-3">{code.definition}</div>
        {editable && code.status === "active" ? <Button variant="ghost" size="sm" disabled={mutation.busy} onClick={() => void retireCode(code.codeId)
          .then(onChanged).catch((cause) => setError(message(cause)))}>Retire type</Button> : null}
      </div>)}
      {editable ? <>
        <label className="block text-[11px] text-ink-3" htmlFor="new-failure-type-name">New failure type name</label>
        <Input id="new-failure-type-name" placeholder="Name the failure type" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={500} />
        <label className="block text-[11px] text-ink-3" htmlFor="new-failure-type-definition">What belongs in this type?</label>
        <Input id="new-failure-type-definition" placeholder="Define the boundary" value={definition} onChange={(event) => setDefinition(event.target.value)} maxLength={5000} />
        <Button size="sm" disabled={!label.trim() || !definition.trim() || mutation.busy} onClick={() => void addRevision().then(onChanged).catch((cause) => setError(message(cause)))}><Plus /> Add failure type</Button>
      </> : null}
    </div> : editable ? <div className="space-y-2">
      <label className="block text-[11px] text-ink-3" htmlFor="failure-type-list-name">Failure-type list name</label>
      <Input id="failure-type-list-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={240} />
      <label className="block text-[11px] text-ink-3" htmlFor="failure-type-list-description">What is this list for?</label>
      <Input id="failure-type-list-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} />
      <label className="block text-[11px] text-ink-3" htmlFor="first-failure-type-name">First failure type name</label>
      <Input id="first-failure-type-name" placeholder="Name the failure type" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={500} />
      <label className="block text-[11px] text-ink-3" htmlFor="first-failure-type-definition">What belongs in this type?</label>
      <Input id="first-failure-type-definition" placeholder="Define the boundary" value={definition} onChange={(event) => setDefinition(event.target.value)} maxLength={5000} />
      <Button size="sm" disabled={!label.trim() || !definition.trim() || mutation.busy} onClick={() => {
        const input = {
          name: name.trim(), description: description.trim(), reason: "Created the first human-authored taxonomy revision",
          codes: [{ kind: "new" as const, clientToken: `code:${label.trim()}`, label: label.trim(), definition: definition.trim() }],
          idempotencyKey: "pending"
        };
        void mutation.run(JSON.stringify({ ...input, idempotencyKey: null }), (idempotencyKey) =>
          createAnalysisTaxonomy({ ...input, idempotencyKey })
        ).then(onChanged).catch((cause) => setError(message(cause)));
      }}><Plus /> Create first failure type</Button>
    </div> : <p className="text-[11px] text-ink-3">No failure types exist yet. A project owner must create the first one.</p>}
  </CardContent></Card>;
}

export function FailureTypeFindingsCard({ studyId, taxonomy, onOpenItem }: {
  studyId: string;
  taxonomy: AnalysisTaxonomyDetail;
  onOpenItem: (studyItemId: string) => void;
}) {
  const activeCodes = taxonomy.revision.codes.filter((code) => code.status === "active");
  const [codeId, setCodeId] = useState(activeCodes[0]?.codeId ?? "");
  const [candidates, setCandidates] = useState<AnalysisCriterionPromotionCandidate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const firstActiveId = activeCodes[0]?.codeId ?? "";
    if (!activeCodes.some((code) => code.codeId === codeId)) setCodeId(firstActiveId);
  }, [taxonomy.revision.revision.id, codeId]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setCandidates([]);
    setCursor(null);
    setTotalCount("0");
    setError(null);
    if (!codeId) return;
    setLoading(true);
    void fetchAnalysisPromotionCandidates({
      studyId,
      taxonomyRevisionId: taxonomy.revision.revision.id,
      codeId,
      limit: 100
    }).then((page) => {
      if (generation.current !== requestGeneration) return;
      setCandidates(page.items);
      setCursor(page.nextCursor);
      setTotalCount(page.totalCount);
    }).catch((cause) => {
      if (generation.current === requestGeneration) setError(message(cause));
    }).finally(() => {
      if (generation.current === requestGeneration) setLoading(false);
    });
  }, [studyId, taxonomy.revision.revision.id, codeId]);

  const selectedCode = activeCodes.find((code) => code.codeId === codeId) ?? null;
  return <Card><CardHeader><div><CardTitle>Findings by failure type</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">Choose a human-authored type to see its exact observation count and open the reviewed runs behind it.</p></div></CardHeader><CardContent>
    {activeCodes.length === 0 ? <p className="text-[11px] text-ink-3">No current failure type can summarize these findings. Create or restore one above.</p> : <>
      <label className="block text-[11px] text-ink-3" htmlFor="analysis-findings-type">Failure type</label>
      <select id="analysis-findings-type" value={codeId} onChange={(event) => setCodeId(event.target.value)}
        className="mt-1 h-9 w-full rounded-sm border border-rule bg-card px-3 text-[12px]">
        {activeCodes.map((code) => <option key={code.codeId} value={code.codeId}>{code.label}</option>)}
      </select>
      {error ? <p role="alert" className="mt-3 text-[11px] text-signal">{error}</p> : loading ? <p className="mt-3 text-[11px] text-ink-3">Loading exact findings…</p> : <>
        <div className="mt-3 text-[12px] font-medium">{totalCount} observation{totalCount === "1" ? "" : "s"} assigned to {selectedCode?.label}</div>
        {candidates.length === 0 ? <p className="mt-2 text-[11px] text-ink-3">No closed-study observation is assigned to this type.</p> : <div className="mt-3 divide-y divide-rule-soft rounded-sm border border-rule-soft">
          {candidates.map((candidate) => <button key={candidate.observationEventId} type="button"
            onClick={() => onOpenItem(candidate.studyItemId)}
            className="block w-full px-3 py-3 text-left hover:bg-card-2">
            <span className="text-[11px] font-medium">Run {candidate.position + 1} · {candidate.failureLabel}</span>
            <span className="mt-1 block text-[10.5px] text-ink-3">{candidate.observationRationale}</span>
            <span className="mt-1 block text-[10px] text-signal">Open reviewed run</span>
          </button>)}
        </div>}
        {cursor ? <Button className="mt-3" variant="ghost" size="sm" disabled={loading} onClick={() => {
          const nextCursor = cursor;
          const requestGeneration = generation.current;
          setLoading(true);
          void fetchAnalysisPromotionCandidates({
            studyId,
            taxonomyRevisionId: taxonomy.revision.revision.id,
            codeId,
            limit: 100,
            cursor: nextCursor
          }).then((page) => {
            if (generation.current !== requestGeneration) return;
            setCandidates((rows) => [...rows, ...page.items]);
            setCursor(page.nextCursor);
            setTotalCount(page.totalCount);
          }).catch((cause) => {
            if (generation.current === requestGeneration) setError(message(cause));
          }).finally(() => {
            if (generation.current === requestGeneration) setLoading(false);
          });
        }}>Load more linked runs</Button> : null}
      </>}
    </>}
  </CardContent></Card>;
}

export function MemberFindingsCard() {
  return <Card><CardHeader><div><CardTitle>Findings by failure type</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">The review queue and exact aggregate counts above remain available to every reviewer.</p></div></CardHeader><CardContent>
    <p className="text-[11px] leading-5 text-ink-3">Per-type promotion evidence is owner-only because it is also the input to criterion creation. Ask a project owner to inspect those linked runs or create the criterion.</p>
  </CardContent></Card>;
}

export function CoverageCard({ coverage, error }: { coverage: AnalysisTaxonomyCoverage | null; error: string | null }) {
  return <Card><CardHeader><div><CardTitle>What you found</CardTitle><p className="mt-1 text-[10.5px] text-ink-3">Counts are tied to this exact analysis and current human-authored failure-type revision.</p></div></CardHeader><CardContent>
    {error ? <p role="alert" className="text-[11px] text-signal">{error}</p> : coverage ? <div className="grid gap-2 sm:grid-cols-3">
      <Fact label="Runs sampled" value={String(coverage.selectedItemCount)} />
      <Fact label="Runs reviewed" value={String(coverage.completedItemCount)} />
      <Fact label="No issue found" value={String(coverage.noFailureObservedItemCount)} />
      <Fact label="Issue observations" value={coverage.activeFailureObservationCount} />
      <Fact label="Organized" value={coverage.categorized} /><Fact label="Type later retired" value={coverage.assignedToRetiredCode} />
      <Fact label="Needs a type" value={coverage.uncategorized} />
    </div> : <p className="text-[11px] text-ink-3">Loading findings…</p>}
  </CardContent></Card>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><div className="font-mono text-[9px] uppercase tracking-wide text-ink-4">{label}</div><div className="mt-1 text-[12px]">{value}</div></div>;
}
