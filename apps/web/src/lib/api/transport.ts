export const API_BASE = import.meta.env.VITE_API_URL ?? "";

export function publicApiBaseUrl(): string {
  if (typeof window === "undefined") return API_BASE || "https://your-coeval.example";
  const resolved = API_BASE ? new URL(API_BASE, window.location.origin).toString() : window.location.origin;
  return resolved.replace(/\/$/, "");
}

// P0-2: project switching. The selected project pins every request via the
// x-coeval-project header; the server checks membership, not trust. No
// selection = the server's default (oldest membership).
const PROJECT_KEY = "coeval.project";

export function selectedProjectId(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

export function selectProject(projectId: string | null): void {
  try {
    if (projectId) localStorage.setItem(PROJECT_KEY, projectId);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    /* storage unavailable — fall back to server default */
  }
}

// Every API call goes through here so the project pin can't drift per-callsite.
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const projectId = selectedProjectId();
  const headers = new Headers(init?.headers);
  if (projectId) headers.set("x-coeval-project", projectId);
  return fetch(input, { ...init, headers, credentials: "include" });
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
  }
  return fallback;
}

export function apiError(response: Response, payload: unknown, fallback: string): ApiError {
  return new ApiError(errorMessage(payload, `${fallback}: ${response.status}`), response.status, payload);
}

export async function apiErrorFromResponse(response: Response, fallback: string): Promise<ApiError> {
  const payload = await response.json().catch(() => null) as unknown;
  return apiError(response, payload, fallback);
}

export function queryPath(path: string, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const serialized = query.toString();
  return `${path}${serialized ? `?${serialized}` : ""}`;
}
