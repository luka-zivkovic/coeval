import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarginNote, SectionHead, Chip } from "@/components/coeval";
import { ReviewPlayer } from "@/components/review-player";
import { fetchReviewQueueDetail } from "@/lib/api";
import type { ReviewQueueDetail, ReviewQueueItem } from "@coeval/shared";

export function QueueDetailScreen() {
  const navigate = useNavigate();
  const { id: queueId } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ReviewQueueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sequence counter for all fetches into this screen — initial route mount,
  // route-change refetches, AND user-triggered reload() invocations called
  // mid-flight by the player's onItemChanged. Any fetch whose seq is no longer
  // the latest at resolution time has its result discarded; this prevents the
  // queue-A → record verdict → quickly navigate to queue-B race where A's
  // reload would otherwise write into B's URL.
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!queueId) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const d = await fetchReviewQueueDetail(queueId);
      if (loadSeqRef.current !== seq) return;
      if (!d) {
        setError("Queue not found.");
        setDetail(null);
      } else {
        setDetail(d);
      }
    } catch (err) {
      if (loadSeqRef.current === seq) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (loadSeqRef.current === seq) setLoading(false);
    }
  }, [queueId]);

  useEffect(() => {
    if (!queueId) return;
    const seq = ++loadSeqRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReviewQueueDetail(queueId)
      .then((d) => {
        if (cancelled || loadSeqRef.current !== seq) return;
        if (!d) {
          setError("Queue not found.");
          setDetail(null);
        } else {
          setDetail(d);
        }
      })
      .catch((err) => {
        if (cancelled || loadSeqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled || loadSeqRef.current !== seq) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queueId]);

  if (!queueId) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Ungoverned legacy · Review queue" title="Missing queue id" />
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Ungoverned legacy · Review queue" title="Loading queue" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="fadeUp">
        <div className="mb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/review-queues")}>
            <ArrowLeft /> Back to queues
          </Button>
        </div>
        <SectionHead eyebrow="Ungoverned legacy · Review queue" title="Could not load queue" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">{error ?? "Queue not found."}</CardContent>
        </Card>
      </div>
    );
  }

  return <QueueDetailBody detail={detail} reload={load} />;
}

function QueueDetailBody({ detail, reload }: { detail: ReviewQueueDetail; reload: () => void }) {
  const navigate = useNavigate();
  const { queue, items } = detail;

  // Position-ordered items for the work flow. Items missing position fall to
  // the end via the index fallback.
  const ordered = useMemo(
    () => [...items].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
    [items]
  );

  const playerItems = useMemo(
    () =>
      ordered.map((item) => ({
        key: item.id,
        caseId: item.caseId,
        completed: item.status === "completed"
      })),
    [ordered]
  );

  return (
    <ReviewPlayer
      eyebrow="Ungoverned legacy · Review queue"
      name={queue.name}
      idTag={queue.id.slice(0, 12)}
      items={playerItems}
      marginNote={{
        who: `Queue · ${queue.name}`,
        text:
          "Your verdict here is unblinded legacy triage recorded on the ordinary case. The queue preserves who walked through what, but it is not governed human truth."
      }}
      onExit={() => navigate("/review-queues")}
      // Promote doesn't mark the queue item completed on the server, so we
      // don't gate on the decision kind — the reload re-reads item status.
      onItemChanged={() => reload()}
      renderDone={(reopen) => (
        <DoneView
          queue={queue}
          items={ordered}
          onBack={() => navigate("/review-queues")}
          onReopen={reopen}
        />
      )}
    />
  );
}

function DoneView({
  queue,
  items,
  onBack,
  onReopen
}: {
  queue: ReviewQueueDetail["queue"];
  items: ReviewQueueItem[];
  onBack: () => void;
  onReopen: () => void;
}) {
  const completed = items.filter((i) => i.status === "completed").length;
  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Queue complete"
        title={queue.name}
        sub={`${completed} of ${items.length} cases have a recorded ruling. Each ruling remains attached to its case and can be reopened from Traces.`}
      />
      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>Summary</CardTitle>
            <CardDescription>The queue's final progress and recorded case rulings.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Chip>queue · {queue.status}</Chip>
            <Chip>{completed} verdicted</Chip>
            {items.length - completed > 0 ? (
              <Chip variant="outline">{items.length - completed} pending</Chip>
            ) : null}
          </div>
          <MarginNote tone="neutral" who="Closed by reviewers">
            Closing the queue does not change or remove its rulings. Reopen it at any time to see
            which reviewer recorded each decision.
          </MarginNote>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onBack}>
              Back to queues
            </Button>
            <Button variant="default" onClick={onReopen}>
              Walk the queue again
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
