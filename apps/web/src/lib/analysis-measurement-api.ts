import {
  AnalysisWorkflowMeasurementReportSchema,
  type AnalysisWorkflowMeasurementReport
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "coeval.project";

export class AnalysisMeasurementApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "AnalysisMeasurementApiError";
  }
}

export async function fetchAnalysisWorkflowMeasurement(input: {
  studyId: string;
  taxonomyRevisionId?: string | null;
  skillVersionId?: string | null;
  calibrationArtifactId?: string | null;
}): Promise<{ report: AnalysisWorkflowMeasurementReport; projectRole: "owner" | "member" }> {
  const query = new URLSearchParams();
  if (input.taxonomyRevisionId) query.set("taxonomyRevisionId", input.taxonomyRevisionId);
  if (input.skillVersionId) query.set("skillVersionId", input.skillVersionId);
  if (input.calibrationArtifactId) query.set("calibrationArtifactId", input.calibrationArtifactId);
  const suffix = query.size ? `?${query.toString()}` : "";
  const response = await projectFetch(
    `${API_BASE}/api/analysis-measurements/${encodeURIComponent(input.studyId)}${suffix}`
  );
  const body = await response.json().catch(() => null) as {
    report?: unknown;
    projectRole?: unknown;
    error?: unknown;
    code?: unknown;
  } | null;
  if (!response.ok) {
    throw new AnalysisMeasurementApiError(
      typeof body?.error === "string" ? body.error : "Analysis measurement request failed",
      response.status,
      typeof body?.code === "string" ? body.code : null
    );
  }
  if (body?.projectRole !== "owner" && body?.projectRole !== "member") {
    throw new Error("Analysis measurement response omitted the exact project role");
  }
  return {
    report: AnalysisWorkflowMeasurementReportSchema.parse(body.report),
    projectRole: body.projectRole
  };
}

function projectFetch(input: string): Promise<Response> {
  const headers = new Headers();
  try {
    const projectId = localStorage.getItem(PROJECT_KEY);
    if (projectId) headers.set("x-coeval-project", projectId);
  } catch {
    // The authenticated server default remains authoritative.
  }
  return fetch(input, { headers, credentials: "include" });
}
