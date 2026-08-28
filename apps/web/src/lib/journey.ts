import {
  CreatedApiKeySchema,
  GOLDEN_GATE_RECOMMENDED,
  type CreatedApiKey,
  type DashboardSummary,
  type Project
} from "@coeval/shared";

// Skill Bench: evidence comes from example datasets instead of a trace
// stream. Branches IA/copy only — journey predicates below hold unchanged
// (example imports bump importedTraceCount, so the stages fire correctly).
export function isBench(project: Pick<Project, "mode">): boolean {
  return project.mode === "bench";
}

// P0-1 — the onboarding journey is derived from real project state, never
// tracked separately (there is nothing to drift out of sync with):
//
//   day0        — no traces imported yet; the judge has nothing to say.
//   provisional — traces exist, but the current skill version is the
//                 never-approved starter draft. Verdicts wear the dashed
//                 badge until someone signs the rubric off (or edits it,
//                 which ships an approved version through the gate).
//   production  — an approved version is judging traffic.
export type JourneyStage = "day0" | "provisional" | "production";

export function journeyStage(dashboard: DashboardSummary): JourneyStage {
  if (dashboard.project.importedTraceCount === 0) return "day0";
  const version = dashboard.skill.currentVersion;
  if (version.status === "draft" && version.approvedAt === null) return "provisional";
  return "production";
}

export type JourneyActState = "done" | "now" | "next";

export interface JourneyActStates {
  defineGood: JourneyActState;
  judgeRealWork: JourneyActState;
  earnTrust: JourneyActState;
}

export type SetupJourneyStepState = "done" | "now" | "locked";

export interface FirstRunSetupStepStates {
  bringRun: SetupJourneyStepState;
  chooseCheck: SetupJourneyStepState;
  seeResult: SetupJourneyStepState;
}

export function currentCheckIsReady(dashboard: DashboardSummary): boolean {
  return dashboard.skill.currentVersion.status === "approved" ||
    dashboard.skill.currentVersion.status === "production";
}

// The first-run ledger mirrors durable project state for both supplied-example
// and tracing projects. No click-completion flags are allowed: agent setup,
// imports, and eval runs can all happen outside the current browser. Later
// outcomes remain done when work happened out of order, but only the earliest
// unmet prerequisite is presented as the primary next action.
export function firstRunSetupStepStates(dashboard: DashboardSummary): FirstRunSetupStepStates {
  const hasRun = dashboard.project.importedTraceCount > 0;
  const hasCheck = currentCheckIsReady(dashboard);
  const hasResult = dashboard.currentVersionResultCount > 0;

  return {
    bringRun: hasRun ? "done" : "now",
    chooseCheck: hasCheck ? "done" : hasRun ? "now" : "locked",
    seeResult: hasResult ? "done" : hasRun && hasCheck ? "now" : "locked"
  };
}

// The sidebar and Overview share one state-derived journey. Only the first
// incomplete act is "now"; later acts remain visible without pretending they
// are unlocked milestones. Five golden cases is a recommendation, while the
// actual regression gate still arms on the first promotion.
export function journeyActStates(dashboard: DashboardSummary): JourneyActStates {
  const defineGoodDone = currentCheckIsReady(dashboard);
  const judgeRealWorkDone = dashboard.currentVersionResultCount > 0;
  const earnTrustDone = dashboard.goldenSetSize >= GOLDEN_GATE_RECOMMENDED;
  const completed = [defineGoodDone, judgeRealWorkDone, earnTrustDone];
  const current = completed.findIndex((done) => !done);
  const state = (index: number): JourneyActState => completed[index]
    ? "done"
    : current === index
      ? "now"
      : "next";
  return { defineGood: state(0), judgeRealWork: state(1), earnTrust: state(2) };
}

// The single definition of the first-run Check route: `first=1` mounts the
// guided choice and proposal. Three
// surfaces (project creation, owner setup, the journey pipeline's Act-1 CTA)
// must all land new users here — a diverging copy strands them on the bare
// editor.
export function firstRunEditorPath(): string {
  return "/skill/edit?first=1";
}

export function firstResultPath(skillVersionId: string): string {
  return `/first-result?version=${encodeURIComponent(skillVersionId)}`;
}

const FIRST_PROJECT_KEY = "coeval.first-project-key";

// Returns whether the plaintext key was actually persisted. A live bearer
// credential was just minted server-side; if storage is unavailable (Safari
// private mode) the CALLER must show the key immediately instead — silently
// continuing leaves an active secret no UI ever displayed.
export function rememberFirstProjectKey(projectId: string, apiKey: CreatedApiKey): boolean {
  try {
    sessionStorage.setItem(FIRST_PROJECT_KEY, JSON.stringify({ projectId, apiKey }));
    return sessionStorage.getItem(FIRST_PROJECT_KEY) !== null;
  } catch {
    return false;
  }
}

export function firstProjectKey(projectId: string): CreatedApiKey | null {
  try {
    const raw = sessionStorage.getItem(FIRST_PROJECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { projectId?: unknown; apiKey?: unknown };
    if (parsed.projectId !== projectId) return null;
    return CreatedApiKeySchema.parse(parsed.apiKey);
  } catch {
    return null;
  }
}

export function forgetFirstProjectKey(): void {
  try {
    sessionStorage.removeItem(FIRST_PROJECT_KEY);
  } catch {
    /* ignore */
  }
}

// Session-scoped flag so the Overview can show the one-time setup receipt
// right after sign-off without persisting UI state anywhere durable.
const RECEIPT_KEY = "coeval.setup-receipt";

export function markSetupReceipt(text: string): void {
  try {
    sessionStorage.setItem(RECEIPT_KEY, text);
  } catch {
    /* storage unavailable — the receipt is cosmetic */
  }
}

export function takeSetupReceipt(): string | null {
  try {
    const value = sessionStorage.getItem(RECEIPT_KEY);
    return value;
  } catch {
    return null;
  }
}

export function clearSetupReceipt(): void {
  try {
    sessionStorage.removeItem(RECEIPT_KEY);
  } catch {
    /* ignore */
  }
}
