import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ExternalLink, RefreshCcw } from "lucide-react";
import { parseTraceDeepLink, type TraceDeepLinkQuery, type TraceLinkConnection, type TraceLinkMatch, type TraceLinkResolution } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { EmptyGlyph, EmptyShell } from "@/components/coeval";
import { selectProject } from "../lib/api/transport.js";
import { resolveTraceLink, syncIronsideConnection } from "../lib/trace-link-api.js";
import { caseHref, connectionSyncBlocker, traceLinkOutcome } from "../lib/trace-link.js";

// /links/trace — the inbound deep link from Ironside's trace viewer. It sits
// outside RootLayout so no project-scoped provider loads before the resolver
// has chosen a project; AuthGate still requires a session first, and the
// login screen reloads this same URL afterwards.
export function TraceLinkScreen() {
  const location = useLocation();
  const parsed = useMemo(() => parseTraceDeepLink(new URLSearchParams(location.search)), [location.search]);
  const [resolution, setResolution] = useState<TraceLinkResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!parsed.ok) return;
    let cancelled = false;
    setError(null);
    resolveTraceLink(parsed.query)
      .then((result) => {
        if (cancelled) return;
        const outcome = traceLinkOutcome(result);
        if (outcome.kind === "open") {
          openMatch(outcome.match);
          return;
        }
        setResolution(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [parsed, attempt]);

  const retry = useCallback(() => {
    setResolution(null);
    setAttempt((value) => value + 1);
  }, []);

  if (!parsed.ok) {
    return (
      <Page>
        <EmptyShell
          eyebrow={parsed.code === "unsupported_source" ? "400 · unsupported link source" : "400 · invalid trace link"}
          title="Coeval can't open this link."
          body={parsed.error}
          art={<EmptyGlyph kind="404" />}
          primary={<Button variant="primary" onClick={() => window.location.assign("/")}>Go to Coeval</Button>}
        />
      </Page>
    );
  }
  return (
    <Page>
      <TraceLinkView query={parsed.query} resolution={resolution} error={error} onRetry={retry} />
    </Page>
  );
}

// Selecting the project then reloading lets every project-scoped provider
// start cleanly in the matched project, as the project switcher does.
function openMatch(match: TraceLinkMatch): void {
  selectProject(match.projectId);
  window.location.replace(caseHref(match));
}

function openIntegrations(projectId: string): void {
  selectProject(projectId);
  window.location.assign("/integrations");
}

function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8">{children}</main>;
}

export interface TraceLinkViewProps {
  query: TraceDeepLinkQuery;
  resolution: TraceLinkResolution | null;
  error: string | null;
  onRetry: () => void;
}

export function TraceLinkView({ query, resolution, error, onRetry }: TraceLinkViewProps) {
  const identity = <TraceIdentity query={query} />;
  if (error) {
    return (
      <EmptyShell
        eyebrow="Trace link"
        title="Coeval could not look up this trace."
        body={<>{error}{identity}</>}
        art={<EmptyGlyph kind="offline" />}
        primary={<Button variant="primary" onClick={onRetry}><RefreshCcw /> Try again</Button>}
      />
    );
  }
  if (!resolution) {
    return <EmptyShell eyebrow="Trace link" title="Finding this trace in Coeval…" body={identity} />;
  }
  const outcome = traceLinkOutcome(resolution);
  if (outcome.kind === "open") {
    return <EmptyShell eyebrow="Trace link" title="Opening the imported trace…" body={identity} />;
  }
  if (outcome.kind === "pick") {
    return (
      <div className="flex flex-col gap-4">
        <EmptyShell
          eyebrow="Trace link · choose a project"
          title="This trace is imported in more than one of your projects."
          body={<>Choose which Coeval project to open it in.{identity}</>}
        />
        <ul className="flex flex-col gap-2" aria-label="Projects containing this trace">
          {outcome.matches.map((match) => (
            <li key={match.projectId} className="flex flex-wrap items-center gap-3 rounded-sm border border-rule-soft px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] text-ink">{match.projectName}</div>
                <div className="font-mono text-[10.5px] text-ink-3">
                  {versionLabel(match)} · imported {new Date(match.importedAt).toLocaleString()}
                </div>
              </div>
              <Button variant="primary" size="sm" onClick={() => openMatch(match)}>Open in {match.projectName}</Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <NotImported query={query} otherVersions={outcome.otherVersions} connections={outcome.connections} onRetry={onRetry} />;
}

function NotImported({
  query,
  otherVersions,
  connections,
  onRetry
}: {
  query: TraceDeepLinkQuery;
  otherVersions: TraceLinkMatch[];
  connections: TraceLinkConnection[];
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <EmptyShell
        eyebrow="Trace link · not imported yet"
        title={query.version ? "This trace version hasn't been imported into Coeval yet." : "This trace hasn't been imported into Coeval yet."}
        body={
          <>
            Coeval imports settled trace versions from Ironside through a project's Ironside
            connection, either on its polling schedule or when someone runs an import. A trace
            becomes available after Ironside's quiet period ends.
            <TraceIdentity query={query} />
          </>
        }
        art={<EmptyGlyph kind="404" />}
        primary={<Button variant="default" onClick={onRetry}><RefreshCcw /> Check again</Button>}
      />
      {otherVersions.length > 0 ? (
        <section aria-label="Other imported versions" className="flex flex-col gap-2">
          <div className="eyebrow">Other imported versions of this trace</div>
          {otherVersions.map((match) => (
            <div key={match.caseId} className="flex flex-wrap items-center gap-3 rounded-sm border border-rule-soft px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink">{match.projectName}</div>
                <div className="font-mono text-[10.5px] text-ink-3">{versionLabel(match)}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => openMatch(match)}>Open this version</Button>
            </div>
          ))}
        </section>
      ) : null}
      {connections.length > 0 ? (
        <section aria-label="Ironside connections" className="flex flex-col gap-2">
          <div className="eyebrow">Your projects connected to this Ironside project</div>
          {connections.map((connection) => (
            <ConnectionRow key={connection.integrationId} connection={connection} />
          ))}
        </section>
      ) : (
        <p className="text-center text-[13px] text-ink-3">
          None of your Coeval projects is connected to Ironside project{" "}
          <span className="font-mono">{query.project}</span>. A project owner connects it from{" "}
          <a className="underline" href="/integrations">Integrations → Connect Ironside</a> with an
          Ironside Integration credential; imports then run on its polling schedule or from its import action there.
        </p>
      )}
    </div>
  );
}

function ConnectionRow({ connection }: { connection: TraceLinkConnection }) {
  const [state, setState] = useState<{ status: "idle" | "syncing" | "queued" | "error"; message?: string }>({ status: "idle" });
  const blocker = connectionSyncBlocker(connection);
  const sync = async () => {
    setState({ status: "syncing" });
    try {
      const result = await syncIronsideConnection(connection);
      setState(result.queued
        ? { status: "queued", message: "Import queued. Check again once it completes." }
        : { status: "error", message: result.importJob.error ?? "The import could not be queued." });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-sm border border-rule-soft px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{connection.projectName}</div>
        <div className="font-mono text-[10.5px] text-ink-3">
          polling {connection.pollEnabled ? "on" : "off"}
          {blocker ? ` · ${blocker}` : ""}
        </div>
        {state.message ? (
          <div role="status" className={state.status === "error" ? "text-[12px] text-signal" : "text-[12px] text-ink-2"}>
            {state.message}
          </div>
        ) : null}
      </div>
      <Button variant="ghost" size="sm" onClick={() => openIntegrations(connection.projectId)}>
        <ExternalLink /> Integrations
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => void sync()}
        disabled={blocker !== null || state.status === "syncing"}
        title={blocker ?? "Run this connection's Ironside import now"}
      >
        {state.status === "syncing" ? "Queuing…" : "Import now"}
      </Button>
    </div>
  );
}

function TraceIdentity({ query }: { query: TraceDeepLinkQuery }) {
  return (
    <span className="mt-2 block font-mono text-[11px] text-ink-3">
      Ironside project {query.project} · trace {query.trace}
      {query.version ? ` · version ${query.version}` : " · latest imported version"}
    </span>
  );
}

function versionLabel(match: TraceLinkMatch): string {
  const version = match.traceVersion ? `version ${match.traceVersion}` : "unversioned";
  return match.importedVersionCount > 1 ? `${version} (newest of ${match.importedVersionCount})` : version;
}
