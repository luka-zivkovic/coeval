import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { BindingResolutionStatus as ResolutionStatus } from "@rubrist/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Chip, Eyebrow } from "@/components/rubrist";
import { fetchBindingResolution, resolveBindingNow } from "@/lib/evaluator-lifecycle-api";
import { resolutionView, type ResolutionView } from "../lib/binding-resolution-view.js";

// A version's execution-binding resolution, shown to its author (ADR-0014
// section 4, Batch 8F): the status, each probe's outcome, and whether the
// binding can pass a governed gate. The in-memory demo keeps no resolution
// records, so there the card isn't shown.

export function BindingResolutionStatus({ skillVersionId, embedded = false }: {
  skillVersionId: string;
  /** Inside another card: rendered without its own. */
  embedded?: boolean;
}) {
  const [status, setStatus] = useState<ResolutionStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus(undefined);
    setError(null);
    fetchBindingResolution(skillVersionId).then(
      (loaded) => { if (!cancelled) setStatus(loaded); },
      (cause: unknown) => { if (!cancelled) setError(message(cause)); }
    );
    return () => { cancelled = true; };
  }, [skillVersionId]);

  async function resolve() {
    setResolving(true);
    setError(null);
    try {
      setStatus(await resolveBindingNow(skillVersionId));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setResolving(false);
    }
  }

  if (status === null) return null;
  const panel = (
    <ResolutionPanel
      view={status === undefined ? null : resolutionView(status)}
      error={error}
      resolving={resolving}
      onResolve={() => void resolve()}
    />
  );
  if (embedded) return <div className="mt-3 border-t border-rule-soft pt-3">{panel}</div>;
  return (
    <Card>
      <CardContent className="py-4">{panel}</CardContent>
    </Card>
  );
}

/** The panel for a loaded status (`null` while loading). */
export function ResolutionPanel({
  view,
  error,
  resolving,
  onResolve
}: {
  view: ResolutionView | null;
  error: string | null;
  resolving: boolean;
  onResolve: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Eyebrow>Execution binding · resolution</Eyebrow>
        {view ? <Chip variant={view.tone}>{view.label}</Chip> : null}
      </div>
      {error ? <div role="alert" className="mt-2 text-[11.5px] text-signal">{error}</div> : null}
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
                <span className="text-ink-2">Can't pass a governed gate yet: {view.gate.problems.join("; ")}.</span>
                {view.gate.suggestion ? <span className="block text-ink-3">{view.gate.suggestion}</span> : null}
              </>
            )}
          </div>
          {view.canResolve ? (
            <Button className="mt-3" variant="outline" size="sm" disabled={resolving} onClick={onResolve}>
              {resolving ? <><LoaderCircle className="animate-spin" /> Resolving…</> : "Resolve now"}
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The binding's resolution couldn't be read.";
}
