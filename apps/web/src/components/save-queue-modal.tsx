import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eyebrow } from "@/components/coeval";
import { createReviewQueue } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardCriterionVersionId } from "@/lib/criterion-scope";
import { useDialogFocus } from "@/hooks/use-dialog-focus";

// "Save this view as a queue" — any filtered slice of cases becomes a named
// pile someone agreed to walk through. Once reviewed, its verdicts are a
// labeled dataset future versions can be held against.
const QUEUE_CASE_CAP = 500;

export function SaveQueueModal({
  caseIds,
  defaultName,
  context,
  onClose
}: {
  caseIds: string[];
  defaultName: string;
  // One line describing what the slice is, shown under the name field.
  context: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { dashboard } = useDashboard();
  const criterionVersionId = dashboardCriterionVersionId(dashboard);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose, closeOnEscape: !busy });

  const unique = Array.from(new Set(caseIds));
  const capped = unique.slice(0, QUEUE_CASE_CAP);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the queue a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const queue = await createReviewQueue({
        name: trimmed,
        description: context,
        caseIds: capped,
        ...(criterionVersionId ? { criterionVersionId } : {}),
      });
      navigate(`/review-queues/${queue.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Queue creation failed.");
      setBusy(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-queue-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-start overflow-y-auto bg-ink/30 p-4 fadeUp sm:place-items-center"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto shadow-[var(--shadow-elev)] sm:w-[480px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div>
            <CardTitle id="save-queue-title">Save view as queue</CardTitle>
            <CardDescription>{context}</CardDescription>
          </div>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy} aria-label="Close save queue dialog">
            <X />
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="save-queue-name" className="eyebrow">Queue name</label>
            <Input
              id="save-queue-name"
              autoFocus
              data-dialog-initial-focus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="font-mono text-[11px] text-ink-3">
            {capped.length.toLocaleString()} {capped.length === 1 ? "case" : "cases"}
            {unique.length > QUEUE_CASE_CAP
              ? ` · capped at ${QUEUE_CASE_CAP} (of ${unique.length.toLocaleString()} matching)`
              : ""}
          </div>
          {error ? <div role="alert" className="font-mono text-[11px] text-signal">{error}</div> : null}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Button variant="primary" disabled={busy || capped.length === 0} onClick={() => void submit()}>
              {busy ? "Creating…" : `Create queue · ${capped.length}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
