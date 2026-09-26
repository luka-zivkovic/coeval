import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { BindingResolutionStatus as ResolutionStatus } from "@rubrist/shared";
import { Button } from "./ui/button.js";
import { Card, CardContent } from "./ui/card.js";
import { Chip, Eyebrow } from "./rubrist/index.js";
import { fetchBindingResolution, resolveBindingNow } from "../lib/evaluator-lifecycle-api.js";
import { resolutionView, type ResolutionView } from "../lib/binding-resolution-view.js";

// A version's execution-binding resolution, shown to its author (ADR-0014
// section 4, Batch 8F): the status, each probe's outcome, and whether the
// binding can pass a governed gate. The in-memory demo keeps no resolution
// records, so there the card isn't shown.

export function BindingResolutionStatus({
  skillVersionId,
  embedded = false,
  refreshKey = 0,
  disabled = false
}: {
  skillVersionId: string;
  /** Inside another card: rendered without its own. */
  embedded?: boolean;
  /** Changing it reads the status again, after something that may have resolved the binding. */
  refreshKey?: number;
  /** While the surrounding view changes the evaluator, Resolve now waits. */
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<ResolutionStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [reload, setReload] = useState(0);
  // The version this card shows now, so an answer for another one is dropped.
  const current = useRef(skillVersionId);
  current.current = skillVersionId;
  const labelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus(undefined);
    setError(null);
    setResolving(false);
    fetchBindingResolution(skillVersionId).then(
      (loaded) => { if (!cancelled) setStatus(loaded); },
      (cause: unknown) => { if (!cancelled) setError(message(cause)); }
    );
    return () => { cancelled = true; };
  }, [skillVersionId, refreshKey, reload]);

  const resolve = useCallback(async () => {
    const requested = skillVersionId;
    setResolving(true);
    setError(null);
    try {
      const resolved = await resolveBindingNow(requested);
      if (current.current !== requested) return;
      setStatus(resolved);
      // The button goes away once there is nothing left to resolve; keep focus in the card.
      labelRef.current?.focus();
    } catch (cause) {
      if (current.current === requested) setError(message(cause));
    } finally {
      if (current.current === requested) setResolving(false);
    }
  }, [skillVersionId]);

  if (status === null) return null;
  const panel = (
    <ResolutionPanel
      view={status === undefined ? null : resolutionView(status)}
      error={error}
      resolving={resolving}
      disabled={disabled}
      labelRef={labelRef}
      onResolve={() => void resolve()}
      onRetry={() => setReload((count) => count + 1)}
    />
  );
  if (embedded) return <div className="mt-3 border-t border-rule-soft pt-3">{panel}</div>;
  return (
    <Card>
      <CardContent className="py-4">{panel}</CardContent>
    </Card>
  );
}

/** The panel for a loaded status (`null` while loading, or when loading failed). */
export function ResolutionPanel({
  view,
  error,
  resolving,
  disabled = false,
  labelRef,
  onResolve,
  onRetry
}: {
  view: ResolutionView | null;
  error: string | null;
  resolving: boolean;
  disabled?: boolean;
  labelRef?: React.Ref<HTMLDivElement>;
  onResolve: () => void;
  onRetry?: () => void;
}) {
  return (
    <div aria-live="polite">
      <div ref={labelRef} tabIndex={-1} className="flex flex-wrap items-center justify-between gap-3 outline-none">
        <Eyebrow>Execution binding · resolution</Eyebrow>
        {view ? <Chip variant={view.tone}>{view.label}</Chip> : null}
      </div>
      {error ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-signal">
          {error}
          {view === null && onRetry ? <Button variant="ghost" size="xs" onClick={onRetry}>Retry</Button> : null}
        </div>
      ) : null}
      {view === null ? (
        error ? null : <p className="mt-2 text-[12px] text-ink-3">Loading the binding's resolution…</p>
      ) : (
        <>
          <p className="mt-2 text-[12px] leading-5 text-ink-2">{view.summary}</p>
          {view.settings.length > 0 ? (
            <div className="mt-2 grid grid-cols-1 gap-y-1 text-[12.5px] sm:grid-cols-[140px_1fr]">
              {view.settings.map(({ setting, support }) => (
                <div key={setting} className="contents">
                  <div className="text-ink-3">{setting}</div>
                  <div>{support}</div>
                </div>
              ))}
            </div>
          ) : null}
          {view.probes.length > 0 ? (
            <ol className="mt-3 flex flex-col gap-2">
              {view.probes.map((probe, index) => (
                <li key={index} className="rounded-sm border border-rule-soft bg-paper-2 px-3 py-2 text-[12px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-ink-2">{probe.purpose}</span>
                    <Chip variant={probe.tone}>{probe.outcome}</Chip>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-ink-3">{probe.sent}</div>
                  {probe.providerMessage ? <div className="mt-1 text-[11px] text-ink-3">Provider: {probe.providerMessage}</div> : null}
                </li>
              ))}
            </ol>
          ) : null}
          <div className="mt-3 text-[12px] leading-5">
            {view.gate.ready ? (
              <span className="text-ink-2">Ready for governed gates: candidate creation, activation, and sealed calibration.</span>
            ) : (
              <>
                <span className="text-ink-2">
                  {view.gate.failed ? "Can't pass a governed gate" : "Can't pass a governed gate yet"}: {view.gate.problems.join("; ")}.
                </span>
                {view.gate.suggestion ? <span className="block text-ink-3">{view.gate.suggestion}</span> : null}
              </>
            )}
          </div>
          {view.canResolve ? (
            <Button className="mt-3" variant="outline" size="sm" disabled={resolving || disabled} onClick={onResolve}>
              {resolving ? <><LoaderCircle className="animate-spin" /> Resolving…</> : "Resolve now"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The binding's resolution couldn't be read.";
}
