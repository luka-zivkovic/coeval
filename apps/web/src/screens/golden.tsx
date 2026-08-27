import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCcw, Star, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip, Eyebrow, SectionHead, VerdictChip } from "@/components/coeval";
import { fetchGoldenSet, retireGoldenSetEntry } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardCriterionVersionId } from "@/lib/criterion-scope";
import { isBench, journeyStage, type JourneyStage } from "@/lib/journey";
import { cn } from "@/lib/utils";
import type { GoldenSetEntry } from "@coeval/shared";

export function GoldenScreen() {
  const navigate = useNavigate();
  const { dashboard } = useDashboard();
  const criterionVersionId = dashboardCriterionVersionId(dashboard);
  const bench = dashboard ? isBench(dashboard.project) : false;
  const stage: JourneyStage = dashboard ? journeyStage(dashboard) : "production";
  const waitingExceptions = dashboard?.exceptions.length ?? 0;
  const [entries, setEntries] = useState<GoldenSetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!criterionVersionId) return;
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchGoldenSet(criterionVersionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [criterionVersionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retire = async (entryId: string) => {
    if (!confirm("Retire this reference case? It will no longer be replayed against new evaluator versions.")) {
      return;
    }
    setRetiring(entryId);
    try {
      await retireGoldenSetEntry(entryId);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetiring(null);
    }
  };

  return (
    <div className="fadeUp">
      <SectionHead
        eyebrow={`${entries.length} active reference case${entries.length === 1 ? "" : "s"}`}
        title="Golden set"
        sub="The Golden set stores human-curated labels for known cases. Coeval checks every evaluator edit against the active set. These references are ungoverned regression evidence, not calibration or sealed human truth."
        right={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            <Button variant="default" size="sm" onClick={() => navigate("/exceptions")}>
              <Star /> Promote from queue
            </Button>
          </div>
        }
      />

      <Card className="mb-6 max-w-[82ch] border-dashed">
        <CardContent className="py-4">
          <Eyebrow>The principle</Eyebrow>
          <div className="mt-2 font-serif text-[14px] leading-[1.55] tracking-[-0.005em] text-ink-2">
            Promote a reviewed case when future evaluator versions should preserve its result.
            Coeval freezes the recorded label and includes the case in later regression checks.
            This set covers only the cases you chose; it does not measure overall quality or create
            governed human truth. Retiring a case removes it from future checks while preserving its history.
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Card className="mb-5 border-signal-tint bg-signal-wash">
          <CardContent className="py-3 text-[12px] text-signal">{error}</CardContent>
        </Card>
      ) : null}

      {loading && entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-ink-3">Fetching promoted reference cases…</CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <EmptyGolden
          stage={stage}
          bench={bench}
          waitingExceptions={waitingExceptions}
          onPromote={() => navigate(stage === "day0" ? (bench ? "/datasets" : "/") : "/exceptions")}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          {entries.map((entry) => (
            <GoldenCard
              key={entry.id}
              entry={entry}
              retiring={retiring === entry.id}
              onRetire={() => void retire(entry.id)}
            />
          ))}
        </div>
      )}

    </div>
  );
}

function GoldenCard({
  entry,
  retiring,
  onRetire
}: {
  entry: GoldenSetEntry;
  retiring: boolean;
  onRetire: () => void;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex h-full flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <VerdictChip verdict={entry.agreedLabel} />
          <span className="font-mono text-[10.5px] tracking-[0.04em] text-ink-3">{entry.id}</span>
        </div>
        <blockquote className="border-l-2 border-rule-strong pl-3 font-serif text-[14px] leading-[1.45] tracking-[-0.005em] text-ink">
          {entry.reason || <span className="text-ink-3">No reason recorded.</span>}
        </blockquote>
        <div className="flex flex-col gap-1 font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
          <div>case · {entry.caseId}</div>
          <div>trace · {entry.traceId}</div>
          <div>
            promoted by {entry.promotedBy} · {new Date(entry.promotedAt).toLocaleDateString()}
          </div>
          <div>from skill {entry.sourceSkillVersionId}</div>
        </div>
        <div className="mt-auto flex items-center gap-2 pt-2">
          <Chip>active reference</Chip>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="xs"
            onClick={onRetire}
            disabled={retiring}
            className={cn(retiring && "opacity-60")}
          >
            <X /> {retiring ? "Retiring…" : "Retire"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyGolden({
  stage,
  bench,
  waitingExceptions,
  onPromote
}: {
  stage: JourneyStage;
  bench: boolean;
  waitingExceptions: number;
  onPromote: () => void;
}) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Eyebrow>Golden set · 0 reference cases</Eyebrow>
        <div className="mt-2 font-serif text-[18px] tracking-[-0.012em] text-ink">
          No promoted reference cases yet.
        </div>
        <div className="mx-auto mt-2 max-w-[58ch] text-[12.5px] leading-[1.55] text-ink-3">
          Promote a reviewed case when future evaluator versions should preserve its result. The
          case becomes ungoverned regression evidence, not calibration or sealed human truth.
          Without an active reference, Coeval cannot compare an edit with known cases.
        </div>
        <Button variant="primary" size="sm" className="mt-4" onClick={onPromote}>
          <Star />
          {stage === "day0"
            ? bench
              ? "Run an eval first"
              : "Back to setup"
            : waitingExceptions > 0
              ? `Review exceptions · ${waitingExceptions} waiting`
              : "Open the queue"}
        </Button>
        <div className="mt-4 font-mono text-[10.5px] tracking-[0.04em] text-ink-4">
          press P on any case while reviewing to promote it
        </div>
      </CardContent>
    </Card>
  );
}
