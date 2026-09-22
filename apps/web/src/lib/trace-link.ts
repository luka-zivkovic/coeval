import type { TraceLinkConnection, TraceLinkMatch, TraceLinkResolution } from "@coeval/shared";

// Pure decision for the /links/trace page, kept apart from the screen so the
// redirect/pick/not-imported branching is testable without a browser.
export type TraceLinkOutcome =
  | { kind: "open"; match: TraceLinkMatch }
  | { kind: "pick"; matches: TraceLinkMatch[] }
  | { kind: "not_imported"; otherVersions: TraceLinkMatch[]; connections: TraceLinkConnection[] };

export function traceLinkOutcome(resolution: TraceLinkResolution): TraceLinkOutcome {
  if (resolution.status === "resolved" && resolution.matches.length === 1) {
    return { kind: "open", match: resolution.matches[0]! };
  }
  if (resolution.matches.length > 0) return { kind: "pick", matches: resolution.matches };
  return { kind: "not_imported", otherVersions: resolution.otherVersions, connections: resolution.connections };
}

export function caseHref(match: Pick<TraceLinkMatch, "caseId">): string {
  return `/cases/${encodeURIComponent(match.caseId)}`;
}

// Why a connection's sync action is unavailable, or null when it can run.
export function connectionSyncBlocker(connection: TraceLinkConnection): string | null {
  if (connection.revalidationRequired) {
    return "This connection must be tested successfully on the Integrations screen before it can import.";
  }
  if (!connection.skillVersionId) {
    return "This connection has no polling criterion yet. Choose one on the Integrations screen, then import.";
  }
  return null;
}
