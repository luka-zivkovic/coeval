import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, DatabaseZap, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCriterion } from "@/lib/criterion-context";
import {
  createGovernedBatch,
  createGovernedInstruction,
  createGovernedSealedIntake,
  fetchGovernedInstructions,
  fetchGovernedSubjects,
  governedIdempotencyKey,
  type CreateBatchInput,
  type CreateSealedIntakeInput,
  type GovernedAssignableSubject,
  type GovernedInstructionSummary,
  type JsonRecord
} from "@/lib/governed-review-api";

type CreateKind = "instruction" | "intake" | "batch";
type StratifiedSelection = Extract<CreateBatchInput["selection"], { method: "stratified_random" }>;

export function HumanTruthCreateScreen() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const kind = isCreateKind(params.kind) ? params.kind : null;
  const promotionId = searchParams.get("promotionId")?.trim() || null;
  const { href } = useCriterion();

  if (!kind) {
    return (
      <Card><CardContent className="py-10 text-center text-[12px] text-ink-3">Unknown governed human-truth artifact.</CardContent></Card>
    );
  }

  return (
    <div className="fadeUp max-w-[900px]">
      <Link to={href("/human-truth")} className="inline-flex items-center gap-2 text-[12px] text-ink-3 hover:text-ink">
        <ArrowLeft className="size-3.5" /> Human truth
      </Link>
      <div className="mb-7 mt-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-signal">Governed control plane</div>
        <h1 className="mt-2 font-serif text-[26px] font-medium tracking-[-0.025em]">{titleFor(kind)}</h1>
        <p className="mt-2 max-w-[72ch] text-[12.5px] leading-6 text-ink-3">{descriptionFor(kind)}</p>
      </div>
      {kind === "instruction" ? <InstructionForm promotionId={promotionId} /> : null}
      {kind === "intake" ? <SealedIntakeForm /> : null}
      {kind === "batch" ? <BatchForm promotionId={promotionId} /> : null}
    </div>
  );
}

function InstructionForm({ promotionId }: { promotionId: string | null }) {
  const navigate = useNavigate();
  const { selectedChoice, href } = useCriterion();
  const criterionVersionId = latestCriterionVersionId(selectedChoice);
  const [predecessor, setPredecessor] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [failureGuidance, setFailureGuidance] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!criterionVersionId) return;
    fetchGovernedInstructions(criterionVersionId)
      .then((versions) => {
        const latest = [...versions].sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0];
        if (latest) setPredecessor((current) => current || latest.instructionVersionId);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [criterionVersionId]);

  return (
    <Card>
      <CardHeader><CardTitle>Immutable instruction version</CardTitle></CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!criterionVersionId) {
              setError("The selected criterion response has no version identity.");
              return;
            }
            setWorking(true);
            setError(null);
            void createGovernedInstruction({
              criterionVersionId,
              ...(predecessor.trim() ? { predecessorInstructionVersionId: predecessor.trim() } : {}),
              title,
              instructions,
              failureCodeGuidance: failureGuidance,
              idempotencyKey: governedIdempotencyKey("instruction")
            }).then(() => navigate(promotionId
              ? withPromotionId(href("/human-truth/new/batch"), promotionId)
              : href("/human-truth"))).catch((cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
              setWorking(false);
            });
          }}
        >
          <ReadOnlyField label="Criterion version" value={criterionVersionId ?? "Not available"} />
          <Field label="Predecessor instruction version · optional">
            <Input value={predecessor} onChange={(event) => setPredecessor(event.target.value)} placeholder="instruction version id" />
          </Field>
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={240} />
          </Field>
          <Field label="Reviewer instructions">
            <Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} required className="min-h-52" />
          </Field>
          <Field label="Open failure-code guidance">
            <Textarea value={failureGuidance} onChange={(event) => setFailureGuidance(event.target.value)} className="min-h-24" />
          </Field>
          <div className="rounded-sm border border-rule-soft bg-paper-2 p-3 text-[11.5px] leading-5 text-ink-3">
            Allowed labels are fixed by the governed contract: pass, fail, and cannot determine. Editing creates a successor; it never changes this version.
          </div>
          <FormError error={error} />
          <div className="flex justify-end"><Button variant="primary" type="submit" disabled={working || !criterionVersionId}>Create immutable version</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function SealedIntakeForm() {
  const [populationDefinition, setPopulationDefinition] = useState("");
  const [predecessor, setPredecessor] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [itemsJson, setItemsJson] = useState('[\n  {\n    "clientItemId": "item-1",\n    "input": {},\n    "output": {}\n  }\n]');
  const [receipt, setReceipt] = useState<JsonRecord | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (receipt) {
    const intakeId = stringValue(receipt.intakeId ?? receipt.id) ?? "identity not supplied";
    const frameDigest = stringValue(receipt.frameDigest) ?? "digest not supplied";
    const itemCount = numberValue(receipt.itemCount);
    return (
      <Card className="border-gold-tint">
        <CardHeader><CardTitle>Protected intake receipt</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-sm border border-gold-tint bg-ambig-bg p-4">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-gold" />
            <div className="min-w-0">
              <div className="font-serif text-[15px] font-medium">The protected population was accepted.</div>
              <p className="mt-1 text-[11.5px] leading-5 text-ink-3">The response is a receipt only. Item payloads are intentionally absent and this browser did not persist form content.</p>
            </div>
          </div>
          <dl className="mt-5 grid gap-3 font-mono text-[10px] sm:grid-cols-2">
            <ReceiptValue label="Intake id" value={intakeId} />
            <ReceiptValue label="Item count" value={itemCount === null ? "not supplied" : String(itemCount)} />
            <ReceiptValue label="Frame digest" value={frameDigest} wide />
          </dl>
          <div className="mt-5 flex justify-end"><Button variant="default" onClick={() => setReceipt(null)}>Create another intake</Button></div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle><DatabaseZap className="mr-2 inline size-4" /> Session-only protected intake</CardTitle></CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            let parsed: unknown;
            try {
              parsed = JSON.parse(itemsJson);
            } catch {
              setError("Items must be valid JSON.");
              return;
            }
            if (!Array.isArray(parsed) || parsed.length === 0) {
              setError("Items must be a non-empty JSON array.");
              return;
            }
            if (Boolean(windowStart) !== Boolean(windowEnd)) {
              setError("Supply both time-window endpoints or leave both empty.");
              return;
            }
            const timeWindow = windowStart && windowEnd
              ? { startInclusive: new Date(windowStart).toISOString(), endExclusive: new Date(windowEnd).toISOString() }
              : null;
            const input: CreateSealedIntakeInput = {
              populationDefinition,
              ...(timeWindow ? { timeWindow } : {}),
              ...(predecessor.trim() ? { predecessorRevisionId: predecessor.trim() } : {}),
              items: parsed as CreateSealedIntakeInput["items"],
              idempotencyKey: governedIdempotencyKey("sealed-intake")
            };
            setWorking(true);
            void createGovernedSealedIntake(input).then((nextReceipt) => {
              setItemsJson("");
              setReceipt(nextReceipt);
            }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setWorking(false));
          }}
        >
          <Field label="Exact finite population definition">
            <Textarea value={populationDefinition} onChange={(event) => setPopulationDefinition(event.target.value)} required className="min-h-24" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Window start · optional"><Input type="datetime-local" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} /></Field>
            <Field label="Window end · optional"><Input type="datetime-local" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} /></Field>
          </div>
          <Field label="Eligible direct predecessor revision · optional">
            <Input value={predecessor} onChange={(event) => setPredecessor(event.target.value)} />
          </Field>
          <Field label="Protected items · JSON array">
            <Textarea value={itemsJson} onChange={(event) => setItemsJson(event.target.value)} required className="min-h-72" spellCheck={false} />
          </Field>
          <div className="rounded-sm border border-gold-tint bg-ambig-bg p-3 text-[11.5px] leading-5 text-ink-3">
            Do not include expected labels, evaluator output, or judge metadata. Intake checks project-wide input overlap and returns no payloads.
          </div>
          <FormError error={error} />
          <div className="flex justify-end"><Button variant="primary" type="submit" disabled={working}>Create protected intake</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function BatchForm({ promotionId }: { promotionId: string | null }) {
  const navigate = useNavigate();
  const { selectedChoice, href } = useCriterion();
  const criterionVersionId = latestCriterionVersionId(selectedChoice);
  const [instructions, setInstructions] = useState<GovernedInstructionSummary[]>([]);
  const [subjects, setSubjects] = useState<GovernedAssignableSubject[]>([]);
  const [instructionId, setInstructionId] = useState("");
  const [roleIntent, setRoleIntent] = useState<CreateBatchInput["roleIntent"]>("analysis_authoring");
  const [developmentSourceKind, setDevelopmentSourceKind] = useState<"dataset_revision" | "analysis_promotion_handoff">(
    promotionId ? "analysis_promotion_handoff" : "dataset_revision"
  );
  const [sourceId, setSourceId] = useState(promotionId ?? "");
  const [selectionMethod, setSelectionMethod] = useState<CreateBatchInput["selection"]["method"]>("simple_random");
  const [budget, setBudget] = useState("1");
  const [selectedIds, setSelectedIds] = useState("");
  const [strataJson, setStrataJson] = useState("[]");
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [fixedStopAt, setFixedStopAt] = useState(defaultStop());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!criterionVersionId) return;
    Promise.all([fetchGovernedInstructions(criterionVersionId), fetchGovernedSubjects()])
      .then(([nextInstructions, nextSubjects]) => {
        setInstructions(nextInstructions);
        setSubjects(nextSubjects);
        setInstructionId((current) => current || nextInstructions.at(-1)?.instructionVersionId || "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [criterionVersionId]);

  useEffect(() => {
    if (!promotionId) return;
    setDevelopmentSourceKind("analysis_promotion_handoff");
    setSourceId(promotionId);
    setRoleIntent("analysis_authoring");
  }, [promotionId]);

  const sourceKind = roleIntent === "sealed_validation"
    ? "sealed_intake"
    : roleIntent === "iterative_development"
      ? "dataset_revision"
      : developmentSourceKind;
  const minimumReviewers = roleIntent === "sealed_validation" ? 2 : 1;
  const selection = useMemo<CreateBatchInput["selection"] | null>(() => {
    if (selectionMethod === "simple_random" || selectionMethod === "systematic") {
      const fixedBudget = Number(budget);
      return Number.isInteger(fixedBudget) && fixedBudget > 0 ? { method: selectionMethod, fixedBudget } : null;
    }
    if (selectionMethod === "stratified_random") {
      try {
        const strata = JSON.parse(strataJson) as StratifiedSelection["strata"];
        return Array.isArray(strata) && strata.length ? { method: "stratified_random", strata } : null;
      } catch {
        return null;
      }
    }
    const ids = selectedIds.split("\n").map((id) => id.trim()).filter(Boolean);
    return ids.length ? { method: selectionMethod, selectedSourceItemIds: ids } : null;
  }, [budget, selectedIds, selectionMethod, strataJson]);

  return (
    <Card>
      <CardHeader><CardTitle>Freeze batch draft</CardTitle></CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selection) {
              setError("Selection settings are incomplete or invalid.");
              return;
            }
            if (reviewerIds.length < minimumReviewers) {
              setError(`This role requires at least ${minimumReviewers} independent reviewer${minimumReviewers === 1 ? "" : "s"}.`);
              return;
            }
            setWorking(true);
            setError(null);
            void createGovernedBatch({
              instructionVersionId: instructionId,
              roleIntent,
              source: sourceKind === "sealed_intake"
                ? { kind: "sealed_intake", intakeId: sourceId }
                : sourceKind === "analysis_promotion_handoff"
                  ? { kind: "analysis_promotion_handoff", promotionId: sourceId }
                  : { kind: "dataset_revision", revisionId: sourceId },
              selection,
              reviewerUserIds: reviewerIds,
              fixedStopAt: new Date(fixedStopAt).toISOString(),
              idempotencyKey: governedIdempotencyKey("batch")
            }).then(() => navigate(href("/human-truth"))).catch((cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
              setWorking(false);
            });
          }}
        >
          <ReadOnlyField label="Criterion version" value={criterionVersionId ?? "Not available"} />
          <Field label="Immutable instruction version">
            <select className={selectClass} value={instructionId} onChange={(event) => setInstructionId(event.target.value)} required>
              <option value="">Select an instruction version</option>
              {instructions.map((instruction) => <option key={instruction.instructionVersionId} value={instruction.instructionVersionId}>r{instruction.revision ?? "?"} · {instruction.title}</option>)}
            </select>
          </Field>
          <Field label="Dataset role intent">
            <select className={selectClass} value={roleIntent} onChange={(event) => setRoleIntent(event.target.value as CreateBatchInput["roleIntent"])}>
              <option value="analysis_authoring">Analysis / authoring</option>
              <option value="iterative_development">Iterative development</option>
              <option value="sealed_validation">Sealed validation</option>
            </select>
          </Field>
          {roleIntent === "analysis_authoring" ? <Field label="Analysis source evidence">
            <select className={selectClass} value={developmentSourceKind}
              onChange={(event) => {
                setDevelopmentSourceKind(event.target.value as typeof developmentSourceKind);
                setSourceId("");
              }}>
              <option value="dataset_revision">Immutable dataset revision</option>
              <option value="analysis_promotion_handoff">Exact analysis promotion handoff</option>
            </select>
          </Field> : null}
          <Field label={sourceKind === "sealed_intake"
            ? "Protected intake id"
            : sourceKind === "analysis_promotion_handoff"
              ? "Analysis promotion handoff id"
              : "Immutable dataset revision id"}>
            <Input value={sourceId} onChange={(event) => setSourceId(event.target.value)} required />
          </Field>
          {sourceKind === "analysis_promotion_handoff" ? (
            <div className="rounded-sm border border-rule-soft bg-paper-2 p-3 text-[11.5px] leading-5 text-ink-3">
              This handoff is development evidence only; its analysis labels are not truth. Independent governed review may produce truth only when resolved and frozen. No evaluator is created.
            </div>
          ) : null}
          <Field label="Selection method">
            <select className={selectClass} value={selectionMethod} onChange={(event) => setSelectionMethod(event.target.value as CreateBatchInput["selection"]["method"])}>
              <option value="simple_random">Simple random</option>
              <option value="stratified_random">Stratified random</option>
              <option value="systematic">Systematic</option>
              <option value="convenience">Convenience</option>
              <option value="uncertainty">Uncertainty</option>
              <option value="failure_hunting">Failure hunting</option>
              <option value="manual">Manual</option>
            </select>
          </Field>
          {selectionMethod === "simple_random" || selectionMethod === "systematic" ? (
            <Field label="Fixed draw budget"><Input type="number" min={1} max={5000} value={budget} onChange={(event) => setBudget(event.target.value)} required /></Field>
          ) : selectionMethod === "stratified_random" ? (
            <Field label="Declared strata · JSON array"><Textarea value={strataJson} onChange={(event) => setStrataJson(event.target.value)} className="min-h-44" /></Field>
          ) : (
            <Field label="Selected immutable source item ids · one per line"><Textarea value={selectedIds} onChange={(event) => setSelectedIds(event.target.value)} className="min-h-36" required /></Field>
          )}
          <fieldset>
            <legend className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">Independent reviewers · {minimumReviewers} minimum</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {subjects.map((subject) => (
                <label key={subject.userId} className="flex cursor-pointer items-start gap-2 rounded-sm border border-rule-soft bg-paper px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={reviewerIds.includes(subject.userId)}
                    onChange={(event) => setReviewerIds((current) => event.target.checked
                      ? [...current, subject.userId]
                      : current.filter((id) => id !== subject.userId))}
                  />
                  <span className="min-w-0 text-[12px]">
                    <span className="block truncate font-medium">{subject.displayName ?? subject.email ?? subject.userId}</span>
                    <span className="block truncate font-mono text-[9.5px] text-ink-4">{subject.subjectId} · {subject.role ?? "role not supplied"}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Fixed labeling stop"><Input type="datetime-local" value={fixedStopAt} onChange={(event) => setFixedStopAt(event.target.value)} required /></Field>
          {roleIntent === "sealed_validation" ? (
            <div className="rounded-sm border border-gold-tint bg-ambig-bg p-3 text-[11.5px] leading-5 text-ink-3">
              Sealed validation is always evaluator-blind, requires two reviewers, and fails closed when developer identity or separation of duties is unresolved.
            </div>
          ) : null}
          <FormError error={error} />
          <div className="flex justify-end"><Button variant="primary" type="submit" disabled={working || !instructionId || !sourceId.trim()}>Freeze batch draft</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function withPromotionId(href: string, promotionId: string): string {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}promotionId=${encodeURIComponent(promotionId)}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">{label}</span>{children}</label>;
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <div><div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">{label}</div><div className="mt-2 break-all rounded-sm border border-rule-soft bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink-2">{value}</div></div>;
}

function FormError({ error }: { error: string | null }) {
  return error ? <div role="alert" className="rounded-sm border border-signal-tint bg-signal-wash px-3 py-2 text-[12px] text-signal">{error}</div> : null;
}

function ReceiptValue({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? "sm:col-span-2" : ""}><dt className="uppercase tracking-[0.1em] text-ink-4">{label}</dt><dd className="mt-1 break-all text-ink-2">{value}</dd></div>;
}

function isCreateKind(value: string | undefined): value is CreateKind {
  return value === "instruction" || value === "intake" || value === "batch";
}

function titleFor(kind: CreateKind): string {
  return kind === "instruction" ? "New reviewer instruction version" : kind === "intake" ? "New protected sealed intake" : "New governed review batch";
}

function descriptionFor(kind: CreateKind): string {
  if (kind === "instruction") return "Write the exact criterion instructions and failure-code guidance reviewers will see. Saving creates a new immutable instruction version.";
  if (kind === "intake") return "Add a fixed set of sealed cases for protected review. The form remains in this browser until you submit it. Coeval then checks for overlap and returns a receipt without exposing item contents through project screens.";
  return "Choose a fixed source set, assign independent reviewers, and set the order and closing time. These details cannot change after the batch opens.";
}

function latestCriterionVersionId(choice: ReturnType<typeof useCriterion>["selectedChoice"]): string | null {
  if (!choice?.detail) return null;
  return [...choice.detail.versions].sort((left, right) => right.revision - left.revision)[0]?.id ?? null;
}

function defaultStop(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const selectClass = "w-full rounded-sm border border-rule bg-paper px-2.5 py-2 text-[13px] text-foreground focus:border-ink-3";
