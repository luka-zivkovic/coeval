import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, RefreshCcw, ShieldAlert } from "lucide-react";
import { MinimumVerdictOutputSchema, type EvaluatorLifecycleProjection } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchDatasetRevision, fetchSkillVersionRegression } from "@/lib/api";
import { fetchBinaryCalibrationRuns } from "@/lib/binary-calibration-api";
import {
  activateEvaluator,
  createEvaluatorCandidate,
  fetchAllEvaluatorLifecycles,
  lifecycleIdempotencyKey,
  retireEvaluator
} from "@/lib/evaluator-lifecycle-api";
import type { GovernedBatchSummary } from "@/lib/governed-review-api";

export function EvaluatorLifecyclePanel({
  criterionId,
  criterionVersionId,
  criterionName,
  batches
}: {
  criterionId: string;
  criterionVersionId: string;
  criterionName: string;
  batches: GovernedBatchSummary[];
}) {
  const [items,setItems] = useState<EvaluatorLifecycleProjection[]>([]);
  const [projectRole,setProjectRole] = useState<"owner"|"member"|null>(null);
  const [loading,setLoading] = useState(true);
  const [working,setWorking] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [skillName,setSkillName] = useState(`${criterionName} evaluator`);
  const [skillDescription,setSkillDescription] = useState("Governed evaluator candidate derived from independently reviewed nonsealed truth.");
  const [rubric,setRubric] = useState(`Return fail when the response violates: ${criterionName}. Otherwise return pass.`);
  const [prompt,setPrompt] = useState("Judge only the supplied response against the exact criterion and return the required structured verdict.");
  const [modelId,setModelId] = useState("gpt-4o-mini");
  const [rationale,setRationale] = useState("Current regression and calibration evidence support this explicit owner action.");
  const [candidateKey,setCandidateKey] = useState(() => lifecycleIdempotencyKey("candidate"));
  const [transitionKey,setTransitionKey] = useState(() => lifecycleIdempotencyKey("transition"));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchAllEvaluatorLifecycles();
      setProjectRole(response.projectRole);
      setItems(response.items.filter((item) => item.lifecycle.criterionId===criterionId));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  },[criterionId]);
  useEffect(() => { void load(); },[load]);

  const frozenBatch = useMemo(() => batches.find((batch) =>
    batch.state==="frozen" && batch.criterionVersionId===criterionVersionId &&
    (batch.roleIntent==="analysis_authoring" || batch.roleIntent==="iterative_development") &&
    batch.datasetRevisionId && batch.batchDigest
  ) ?? null,[batches,criterionVersionId]);

  async function createCandidate() {
    if (!frozenBatch?.datasetRevisionId || !frozenBatch.batchDigest) return;
    setWorking(true); setError(null);
    try {
      const truth = await fetchDatasetRevision(frozenBatch.datasetRevisionId);
      if (!truth) throw new Error("The frozen truth revision is unavailable.");
      await createEvaluatorCandidate({
        criterionId,criterionVersionId,governedBatchId:frozenBatch.batchId,
        expectedBatchDigest:frozenBatch.batchDigest,
        truthDatasetRevisionId:truth.id,
        expectedTruthRevisionDigest:truth.revisionDigest,
        expectedTruthContentDigest:truth.contentDigest,
        skillName,skillDescription,rubricMarkdown:rubric,prompt,
        modelBinding:{provider:"openai",modelId,modelVersion:"pinned-by-provider-catalog",temperature:0},
        outputSchema:MinimumVerdictOutputSchema,
        idempotencyKey:candidateKey
      });
      setCandidateKey(lifecycleIdempotencyKey("candidate"));
      await load();
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(false); }
  }

  async function activate(projection:EvaluatorLifecycleProjection) {
    setWorking(true); setError(null);
    try {
      const [runs,regression] = await Promise.all([
        fetchBinaryCalibrationRuns(),
        fetchSkillVersionRegression(projection.lifecycle.skillId,projection.lifecycle.skillVersionId)
      ]);
      const calibration = runs.find((run) => run.skillVersionId===projection.lifecycle.skillVersionId &&
        run.state==="complete" && run.artifactId && run.artifactDigest && run.evidenceDigest);
      if (!calibration?.artifactId || !calibration.artifactDigest || !calibration.evidenceDigest) {
        throw new Error("No complete calibration artifact exists for this candidate.");
      }
      if (!regression || regression.status!=="passed") {
        throw new Error("The candidate does not have a complete passed regression result.");
      }
      const prior = items.find((item) => item.currentEvent.state==="active" &&
        item.lifecycle.skillVersionId!==projection.lifecycle.skillVersionId) ?? null;
      await activateEvaluator(projection.lifecycle.skillVersionId,{
        expectedState:projection.currentEvent.state as "candidate"|"needs_review",
        expectedSequence:projection.currentEvent.sequence,
        expectedEventId:projection.currentEvent.id,
        expectedEventDigest:projection.currentEvent.contentDigest,
        calibrationArtifactId:calibration.artifactId,
        expectedCalibrationArtifactDigest:calibration.artifactDigest,
        expectedCalibrationEvidenceDigest:calibration.evidenceDigest,
        regressionRunId:regression.id,
        expectedPriorActiveSkillVersionId:prior?.lifecycle.skillVersionId ?? null,
        expectedPriorActiveEventId:prior?.currentEvent.id ?? null,
        expectedPriorActiveEventDigest:prior?.currentEvent.contentDigest ?? null,
        rationale,idempotencyKey:transitionKey
      });
      setTransitionKey(lifecycleIdempotencyKey("transition"));
      await load();
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(false); }
  }

  async function retire(projection:EvaluatorLifecycleProjection) {
    setWorking(true); setError(null);
    try {
      await retireEvaluator(projection.lifecycle.skillVersionId,{
        expectedState:projection.currentEvent.state as "candidate"|"active"|"needs_review",
        expectedSequence:projection.currentEvent.sequence,
        expectedEventId:projection.currentEvent.id,
        expectedEventDigest:projection.currentEvent.contentDigest,
        rationale,idempotencyKey:transitionKey
      });
      setTransitionKey(lifecycleIdempotencyKey("transition"));
      await load();
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(false); }
  }

  return <Card className="mb-6">
    <CardHeader className="justify-between">
      <CardTitle>Evaluator lifecycle</CardTitle>
      <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}><RefreshCcw /> Refresh</Button>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="text-[11.5px] leading-5 text-ink-3">
        A governed candidate may run only in exact development, regression, and calibration contexts. Production, imports,
        suites, release gates, and trace tests require an explicit owner activation backed by current calibration and a full passed regression.
      </p>
      {error ? <div role="alert" className="rounded-sm border border-signal-tint bg-signal-wash px-3 py-2 text-[11px] text-signal">{error}</div> : null}
      {items.map((projection) => <div key={projection.lifecycle.skillVersionId} className="rounded-sm border border-rule-soft bg-paper-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-serif text-[14px] font-medium">
              {projection.currentEvent.state==="active" ? <CheckCircle2 className="size-4 text-pass"/> : <Activity className="size-4"/>}
              {projection.currentEvent.state.replaceAll("_"," ")}
            </div>
            <div className="mt-1 font-mono text-[9px] text-ink-4">{projection.lifecycle.skillVersionId} · event {projection.currentEvent.sequence}</div>
          </div>
          {projectRole==="owner" && projection.currentEvent.state!=="retired" ? <div className="flex gap-2">
            {(projection.currentEvent.state==="candidate" || projection.currentEvent.state==="needs_review") ?
              <Button size="sm" onClick={() => void activate(projection)} disabled={working}>Activate with current evidence</Button> : null}
            <Button variant="ghost" size="sm" onClick={() => void retire(projection)} disabled={working}>Retire</Button>
          </div> : null}
        </div>
        <div className="mt-2 text-[10.5px] text-ink-3">
          implicit execution · {projection.implicitExecutionAllowed ? "allowed" : `denied (${projection.implicitDenialReasons.join(", ") || "not active"})`}
        </div>
      </div>)}
      {projectRole==="owner" ? <div className="grid gap-3 rounded-sm border border-rule-soft p-4 md:grid-cols-2">
        <div className="md:col-span-2 flex items-center gap-2 text-[12px] text-ink-2"><ShieldAlert className="size-4"/> {items.length ? "Create another governed candidate" : "Create the first governed candidate"}</div>
        <Input value={skillName} onChange={(event)=>setSkillName(event.target.value)} placeholder="Evaluator name" />
        <Input value={modelId} onChange={(event)=>setModelId(event.target.value)} placeholder="Pinned model ID" />
        <Textarea value={skillDescription} onChange={(event)=>setSkillDescription(event.target.value)} placeholder="Description" />
        <Textarea value={rubric} onChange={(event)=>setRubric(event.target.value)} placeholder="Rubric" />
        <Textarea className="md:col-span-2" value={prompt} onChange={(event)=>setPrompt(event.target.value)} placeholder="Prompt" />
        <Button className="md:col-span-2" onClick={() => void createCandidate()} disabled={working || !frozenBatch}>
          {frozenBatch ? "Create candidate and queue regression" : "Freeze an eligible governed batch first"}
        </Button>
      </div> : null}
      {projectRole==="owner" && items.some((item)=>item.currentEvent.state!=="retired") ?
        <Textarea value={rationale} onChange={(event)=>setRationale(event.target.value)} placeholder="Owner activation or retirement rationale" /> : null}
      {projectRole==="member" ? <p className="text-[11px] text-ink-4">Lifecycle controls are owner-only. Members may inspect immutable states and evidence.</p> : null}
    </CardContent>
  </Card>;
}

function message(cause:unknown):string {
  return cause instanceof Error ? cause.message : "Evaluator lifecycle request failed";
}
