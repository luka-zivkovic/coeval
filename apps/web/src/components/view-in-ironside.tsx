import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { CaseSourceLink } from "@rubrist/shared";
import { fetchCaseSourceLink } from "../lib/trace-link-api.js";

// "View in Ironside" for a case imported through the native connection. The
// URL is built server-side from the connection's web URL (or API URL) so the
// viewer route pattern lives in one shared helper.
export function ViewInIronside({ caseId }: { caseId: string }) {
  const [link, setLink] = useState<CaseSourceLink | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLink(null);
    fetchCaseSourceLink(caseId)
      .then((result) => {
        if (!cancelled) setLink(result);
      })
      .catch(() => {
        // Navigation sugar only: a failed lookup hides the link.
        if (!cancelled) setLink(null);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);
  return <ViewInIronsideLink link={link} />;
}

export function ViewInIronsideLink({ link }: { link: CaseSourceLink | null }) {
  const ironside = link?.ironside;
  if (!ironside) return null;
  if (!ironside.viewerUrl) {
    return (
      <span
        className="font-mono text-[10.5px] text-ink-3"
        title="Reconnect this Ironside project on the Integrations screen to link back to it."
      >
        imported from Ironside · no current connection
      </span>
    );
  }
  return (
    <a
      href={ironside.viewerUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-sm border border-rule-soft px-2 py-1 text-[12px] text-ink-2 hover:text-ink"
      title={ironside.traceVersion ? `Ironside trace ${ironside.traceId} · version ${ironside.traceVersion}` : `Ironside trace ${ironside.traceId}`}
    >
      <ExternalLink className="size-3" /> View in Ironside
    </a>
  );
}
