// Persist the historical values so existing browser preferences keep working.
// These are display-density choices only: they never grant or remove access.
export type DisplayMode = "pm" | "dev" | "exec";

export interface DisplayModeOption {
  value: DisplayMode;
  label: string;
  description: string;
}

export const DISPLAY_MODE_OPTIONS: readonly DisplayModeOption[] = [
  {
    value: "pm",
    label: "Guided",
    description: "Shows the core evaluator journey and hides secondary diagnostics and technical details."
  },
  {
    value: "dev",
    label: "Technical",
    description: "Keeps every next step and adds model, version, and internal ID details."
  },
  {
    value: "exec",
    label: "Summary",
    description: "Shows compact status navigation; it does not change your permissions."
  }
] as const;

export const DISPLAY_MODE_BY_VALUE: Record<DisplayMode, DisplayModeOption> = Object.fromEntries(
  DISPLAY_MODE_OPTIONS.map((option) => [option.value, option])
) as Record<DisplayMode, DisplayModeOption>;

export function displayModeFromStorage(value: string | null): DisplayMode {
  return value === "dev" || value === "exec" ? value : "pm";
}

const TRACING_GUIDED_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/criteria",
  "/skill",
  "/analyze",
  "/human-truth",
  "/traces",
  "/exceptions",
  "/golden",
  "/integrations"
]);

const BENCH_GUIDED_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/criteria",
  "/skill",
  "/analyze",
  "/human-truth",
  "/datasets",
  "/exceptions",
  "/golden",
  "/integrations"
]);

const TRACING_SUMMARY_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/traces",
  "/criteria",
  "/skill",
  "/golden"
]);

const BENCH_SUMMARY_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/datasets",
  "/criteria",
  "/skill",
  "/golden"
]);

// Workspace administration must never become URL-only. Display modes may
// simplify the evaluator journey, but every user still needs a visible path
// to credentials, retention, redaction, and other project settings.
const PERSISTENT_WORKSPACE_ROUTES: ReadonlySet<string> = new Set(["/settings"]);

/**
 * Navigation density only. Direct routes and server authorization are
 * unchanged; Guided keeps the core analyze-to-measure journey and its
 * immediate operational actions visible.
 */
export function workspaceRouteVisible(mode: DisplayMode, bench: boolean, path: string): boolean {
  if (PERSISTENT_WORKSPACE_ROUTES.has(path)) return true;
  if (mode === "dev") return true;
  if (mode === "exec") return (bench ? BENCH_SUMMARY_ROUTES : TRACING_SUMMARY_ROUTES).has(path);
  return (bench ? BENCH_GUIDED_ROUTES : TRACING_GUIDED_ROUTES).has(path);
}
