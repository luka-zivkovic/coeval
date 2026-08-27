import { useEffect, useState } from "react";
import { ArrowLeft, Check, ShieldCheck } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/coeval";
import { fetchTraceTest } from "@/lib/api";
import { plainText } from "@/lib/trace-test-flow";
import type { TraceTestDetail, TraceTestRevision, TraceTestValidation, TraceTestValidationOutcome } from "@coeval/shared";

type Evidence = {
  test: TraceTestDetail;
  revision: TraceTestRevision;
  validation: TraceTestValidation;
};

export function TraceTestEvidenceScreen() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = searchParams.get("run");

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    if (!media.matches) return;
    const previousHtml = document.documentElement.style.overflow;
    const previousBody = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previousHtml;
      document.body.style.overflow = previousBody;
    };
  }, []);

  useEffect(() => {
    if (!id) {
      setError("This evidence link is missing its test.");
      return;
    }
    const revisionNumber = Number(searchParams.get("revision"));
    const validationRevision = Number(searchParams.get("validationRevision"));
    const validationId = searchParams.get("validation");
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1
      || !Number.isInteger(validationRevision) || validationRevision < 1
      || !validationId) {
      setError("This evidence link is incomplete.");
      return;
    }
    let cancelled = false;
    setError(null);
    setEvidence(null);
    fetchTraceTest(id)
      .then((test) => {
        if (cancelled) return;
        const revision = test.revisions.find((candidate) => candidate.revision === revisionNumber);
        const validation = test.validations.find((candidate) =>
          candidate.id === validationId && candidate.revision === validationRevision
        );
        if (!revision || !validation
          || revision.validationId !== validation.id
          || revision.validatedRevision !== validation.revision) {
          setError("The exact saved revision or validation evidence is unavailable.");
          return;
        }
        setEvidence({ test, revision, validation });
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => { cancelled = true; };
  }, [id, searchParams]);

  const backToReport = () => navigate(runId ? `/datasets?run=${encodeURIComponent(runId)}` : "/datasets");
  if (error) {
    return (
      <div className="fadeUp mx-auto max-w-3xl max-[760px]:fixed max-[760px]:inset-0 max-[760px]:z-50 max-[760px]:overflow-y-auto max-[760px]:bg-paper max-[760px]:px-4 max-[760px]:py-4">
        <Button variant="ghost" size="sm" onClick={backToReport}><ArrowLeft /> Back to run report</Button>
        <Card className="mt-5 border-signal-tint bg-signal-wash"><CardContent className="py-6 text-[13px] text-signal">{error}</CardContent></Card>
      </div>
    );
  }
  if (!evidence) {
    return <div className="fadeUp mx-auto max-w-3xl max-[760px]:fixed max-[760px]:inset-0 max-[760px]:z-50 max-[760px]:overflow-y-auto max-[760px]:bg-paper max-[760px]:px-4 max-[760px]:py-4"><Card><CardContent className="py-10 text-center text-ink-3">Loading saved test evidence…</CardContent></Card></div>;
  }

  const { test, revision, validation } = evidence;
  return (
    <div className="fadeUp mx-auto max-w-4xl pb-12 max-[760px]:fixed max-[760px]:inset-0 max-[760px]:z-50 max-[760px]:overflow-y-auto max-[760px]:bg-paper max-[760px]:px-4 max-[760px]:py-4">
      <Button variant="ghost" size="sm" onClick={backToReport}><ArrowLeft /> Back to run report</Button>
      <div className="mt-5 rounded-sm border border-rule-soft bg-card px-4 py-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ink-2" />
          <div>
            <div className="text-[13px] font-medium text-ink">Exact run evidence</div>
            <p className="mt-1 text-[12px] leading-[1.5] text-ink-2">This is the enabled revision and validation saved with the run, not the latest draft.</p>
          </div>
        </div>
        <div className="mt-3 break-all font-mono text-[10.5px] text-ink-3">Test {test.id} · revision {revision.revision}</div>
      </div>
      <div className="mt-7 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[30px] font-medium tracking-[-0.025em] text-ink">{revision.scenario}</h1>
          <p className="mt-2 max-w-[70ch] text-[13.5px] leading-[1.65] text-ink-2">{revision.expectedBehavior}</p>
        </div>
        <Chip>{validation.status === "passed" ? "Validated" : validation.status}</Chip>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <RequirementCard title="Must do" items={revision.mustDo} empty="No required behaviors recorded." />
        <RequirementCard title="Must avoid" items={revision.mustAvoid} empty="No prohibited behaviors recorded." />
        <EvidenceCard title="Should fail" evidence={validation.badEvidence} />
        <EvidenceCard title="Should pass" evidence={validation.goodEvidence} />
      </div>

      <Card className="mt-4">
        <CardHeader><div><CardTitle>Provenance</CardTitle><CardDescription>The retained source identity remains available even if the live case expires.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-2 text-[12px] text-ink-2 sm:grid-cols-2">
          <div><span className="text-ink-3">Source case</span><div className="mt-0.5 font-mono text-[11px] text-ink">{test.sourceCaseRef}</div></div>
          <div><span className="text-ink-3">Source trace</span><div className="mt-0.5 font-mono text-[11px] text-ink">{test.sourceTraceRef}</div></div>
          <div><span className="text-ink-3">Validation</span><div className="mt-0.5 font-mono text-[11px] text-ink">{validation.id} · revision {validation.revision}</div></div>
          <div><span className="text-ink-3">Recorded</span><div className="mt-0.5 text-ink">{new Date(validation.createdAt).toLocaleString()}</div></div>
        </CardContent>
      </Card>
    </div>
  );
}

function RequirementCard({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {items.length > 0 ? <ul className="space-y-2 text-[12.5px] leading-[1.5] text-ink-2">{items.map((item) => <li key={item} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0" />{item}</li>)}</ul> : <p className="text-[12px] text-ink-3">{empty}</p>}
      </CardContent>
    </Card>
  );
}

function EvidenceCard({ title, evidence }: { title: string; evidence: TraceTestValidation["badEvidence"] }) {
  return (
    <Card>
      <CardHeader>
        <div><CardTitle>{title}</CardTitle><CardDescription>{outcomeLabel(evidence.result)}</CardDescription></div>
        <Chip>{outcomeLabel(evidence.result)}</Chip>
      </CardHeader>
      <CardContent>
        <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded-sm border border-rule-soft bg-card-2 px-3 py-3 text-[12px] leading-[1.55] text-ink">{plainText(evidence.output) || "No response recorded"}</div>
        {evidence.note ? <p className="mt-3 text-[11.5px] leading-[1.5] text-ink-3">{evidence.note}</p> : null}
      </CardContent>
    </Card>
  );
}

function outcomeLabel(outcome: TraceTestValidationOutcome): string {
  if (outcome === "pass") return "Pass";
  if (outcome === "fail") return "Fail";
  if (outcome === "ambiguous" || outcome === "needs_review") return "Needs review";
  if (outcome === "evaluator_error") return "Evaluator error";
  if (outcome === "could_not_run") return "Could not run";
  return "Unavailable";
}
