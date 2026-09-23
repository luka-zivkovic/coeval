import {
  CaseSourceLinkSchema,
  IronsideImportEnqueueResultSchema,
  TraceLinkResolutionSchema,
  type CaseSourceLink,
  type IronsideImportEnqueueResult,
  type TraceDeepLinkQuery,
  type TraceLinkConnection,
  type TraceLinkResolution
} from "@rubrist/shared";
import { API_BASE, apiError, apiErrorFromResponse, apiFetch, queryPath } from "./api/transport.js";

// Clients for the cross-product trace links. The deep-link resolver spans the
// caller's project memberships, so it sends no project pin of its own.

export async function resolveTraceLink(query: TraceDeepLinkQuery): Promise<TraceLinkResolution> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/links/trace`, {
    source: query.source,
    project: query.project,
    trace: query.trace,
    version: query.version
  }), { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Trace link request failed");
  return TraceLinkResolutionSchema.parse(await response.json());
}

export async function fetchCaseSourceLink(caseId: string): Promise<CaseSourceLink> {
  const response = await apiFetch(`${API_BASE}/api/cases/${encodeURIComponent(caseId)}/source-link`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Case source request failed");
  return CaseSourceLinkSchema.parse(await response.json());
}

// Runs the existing Ironside import for a connection in a specific project,
// with that connection's own polling evaluator binding. The project header is
// explicit so the user's selected project is not changed as a side effect.
export async function syncIronsideConnection(connection: TraceLinkConnection): Promise<IronsideImportEnqueueResult> {
  if (!connection.skillVersionId) {
    throw new Error("This connection has no polling criterion yet. Choose one on the Integrations screen first.");
  }
  const response = await fetch(`${API_BASE}/api/integrations/ironside/${encodeURIComponent(connection.integrationId)}/import`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", "x-rubrist-project": connection.projectId },
    body: JSON.stringify({ limit: connection.pollLimit, skillVersionId: connection.skillVersionId })
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (response.ok) return IronsideImportEnqueueResultSchema.parse(payload);
  throw apiError(response, payload, "Ironside sync request failed");
}
