import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Plus, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip, Eyebrow, MarginNote } from "@/components/coeval";
import { importTrace } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardSkillVersionId } from "@/lib/criterion-scope";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import type { ManualTraceImportResult } from "@coeval/shared";

const SAMPLE_INPUT = `{
  "case_id": "manual-001",
  "customer": { "name": "Calla R.", "tier": "standard" },
  "transcript": [
    { "role": "user", "text": "Hi - the throw I ordered Apr 15 just arrived today and the box was wet. Can I still return it?" },
    { "role": "asst", "text": "Order is 39 days past delivery; the 30-day window is calculated from order date. I'm not able to start a return on this one." }
  ]
}`;

const SAMPLE_OUTPUT = `{
  "agent_reply": "Order is 39 days past delivery; the 30-day window is calculated from order date. I'm not able to start a return on this one.",
  "tools_called": [],
  "latency_ms": 312
}`;

export function ImportTraceLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="default"
        size="sm"
        onClick={() => setOpen(true)}
        title="Paste a trace and run the skill on it"
      >
        <Plus /> Import trace
      </Button>
      {open ? <ImportTraceModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function validateJson(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!s.trim()) return { ok: false, error: "required" };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `invalid JSON · ${message.slice(0, 64)}` };
  }
}

function ImportTraceModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { dashboard, refresh } = useDashboard();
  const skillVersionId = dashboardSkillVersionId(dashboard);
  const [inputJson, setInputJson] = useState(SAMPLE_INPUT);
  const [outputJson, setOutputJson] = useState(SAMPLE_OUTPUT);
  const [sourceTraceId, setSourceTraceId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualTraceImportResult | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose, closeOnEscape: !submitting });

  // Validation re-parses both blobs on every render. Memoize so typing in
  // sourceTraceId / toggling submitting / setting result don't trigger a fresh
  // JSON.parse on a potentially-large payload.
  const inputValidation = useMemo(() => validateJson(inputJson), [inputJson]);
  const outputValidation = useMemo(() => validateJson(outputJson), [outputJson]);
  const canSubmit =
    inputValidation.ok && outputValidation.ok && skillVersionId !== null && !submitting && result == null;

  const submit = async () => {
    if (!canSubmit || !inputValidation.ok || !outputValidation.ok) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const trimmedSource = sourceTraceId.trim();
      const imported = await importTrace({
        skillVersionId: skillVersionId!,
        input: inputValidation.value,
        output: outputValidation.value,
        ...(trimmedSource ? { sourceTraceId: trimmedSource } : {})
      });
      setResult(imported);
      // Counts + journey stage read the dashboard context — revalidate so the
      // topbar/sidebar reflect the import without a hard reload (M0 C4).
      void refresh();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-trace-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto shadow-elev sm:w-[760px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="min-w-0 flex-1">
            <CardTitle id="import-trace-title">
              {result ? "Trace imported" : "Import a trace by hand"}
            </CardTitle>
            <CardDescription>
              {result
                ? "The recorded Run now appears in Traces. Its Check is queued; a Result or exception appears after evaluation finishes."
                : "For one-off cases, dry runs, or workspaces without an upstream tracer. Coeval queues the current Check after import."}
            </CardDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close import trace dialog"
            className="-mr-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-ink-3 hover:bg-paper-3"
          >
            <X className="size-3.5" />
          </button>
        </CardHeader>

        {result ? (
          <ImportDone
            result={result}
            onClose={onClose}
            onImportAnother={() => {
              setResult(null);
              setServerError(null);
              setSourceTraceId("");
            }}
            onOpenTraces={() => {
              onClose();
              // /traces is the audit table — every verdict (pass/fail/ambiguous)
              // surfaces there once the judge run lands. /exceptions/:caseId
              // 404s for non-exception cases (passing judge or judge still
              // queued), so it's the wrong destination from a fresh import.
              navigate("/traces");
            }}
            onOpenExceptions={() => {
              onClose();
              navigate("/exceptions");
            }}
          />
        ) : (
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <JsonField
                id="import-trace-input"
                label="Input · JSON"
                value={inputJson}
                onChange={setInputJson}
                validation={inputValidation}
              />
              <JsonField
                id="import-trace-output"
                label="Output · JSON"
                value={outputJson}
                onChange={setOutputJson}
                validation={outputValidation}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="import-source-trace-id" className="eyebrow">
                Source trace id <span className="lowercase tracking-normal text-ink-3">(optional)</span>
              </label>
              <input
                id="import-source-trace-id"
                value={sourceTraceId}
                onChange={(e) => setSourceTraceId(e.target.value)}
                placeholder="e.g. ls_4f10a7  or  zendesk-tkt-44219"
                className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12px] text-ink focus-visible:border-ink"
              />
            </div>

            <div className="text-[11.5px] leading-[1.55] text-ink-3">
              The skill runs against this case once, locally to your workspace. The verdict is
              stored on the new trace and surfaces in Traces & Exceptions. Manually-imported
              cases do not sync back to any provider.
            </div>

            {serverError ? <div role="alert" className="text-[12px] text-signal">{serverError}</div> : null}

            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <div className="flex-1" />
              <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? "Running skill…" : (
                  <>
                    Run skill on this trace <ArrowRight />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function JsonField({
  id,
  label,
  value,
  onChange,
  validation
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  validation: ReturnType<typeof validateJson>;
}) {
  const err = !validation.ok;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="eyebrow">{label}</label>
        <span
          className={cn(
            "font-mono text-[10.5px] tracking-[0.04em]",
            err ? "text-signal" : "text-ink-3"
          )}
        >
          {err ? validation.error : "valid"}
        </span>
      </div>
      <textarea
        id={id}
        data-dialog-initial-focus={id === "import-trace-input" ? true : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={cn(
          "min-h-[180px] resize-y rounded-sm border bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.5] text-ink",
          err ? "border-signal-tint focus-visible:border-signal" : "border-rule-soft focus-visible:border-ink"
        )}
      />
    </div>
  );
}

function ImportDone({
  result,
  onClose,
  onImportAnother,
  onOpenTraces,
  onOpenExceptions
}: {
  result: ManualTraceImportResult;
  onClose: () => void;
  onImportAnother: () => void;
  onOpenTraces: () => void;
  onOpenExceptions: () => void;
}) {
  return (
    <CardContent className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Chip variant="pass">imported</Chip>
        <span className="font-mono text-[11px] tracking-[0.04em] text-ink-2">
          case {result.caseId}
        </span>
        {result.queued ? (
          <Chip>judge queued</Chip>
        ) : (
          <Chip variant="outline">no judge run queued</Chip>
        )}
      </div>
      <MarginNote tone="neutral" who="Where it landed">
        Trace <span className="font-mono">{result.rawTraceId}</span> · source{" "}
        <span className="font-mono">{result.sourceTraceId}</span>.{" "}
        {result.queued
          ? "The skill will judge it shortly; the verdict will appear in Traces. If it's flagged as fail or ambiguous it also lands on the Exceptions queue."
          : "No judge job was queued — the case is stored but unjudged."}{" "}
        Manually-imported cases don't sync back to any provider.
      </MarginNote>
      <div className="flex items-center gap-2 pt-2">
        <Button variant="primary" onClick={onOpenTraces}>
          View in Traces
        </Button>
        <Button variant="default" onClick={onOpenExceptions}>
          Open Exceptions
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onImportAnother}>
          Import another
        </Button>
      </div>
    </CardContent>
  );
}
