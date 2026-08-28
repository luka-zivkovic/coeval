import type { ProjectMode } from "@coeval/shared";
import { findStarterSkill, STARTER_SKILLS, type StarterSkill } from "./starter-skills.js";

export interface OnboardingCheckDraft {
  schemaVersion: 1;
  projectId: string;
  skillId: string;
  starterId: string;
  criterionName: string;
  qualityQuestion: string;
  rubricMarkdown: string;
  decisionSource: "user" | "coeval";
  decisionReason: string | null;
}

const STORAGE_PREFIX = "coeval.onboarding-check";

function storageKey(projectId: string, skillId: string): string {
  return `${STORAGE_PREFIX}.${projectId}.${skillId}`;
}

export function recommendStarterSkill(projectName: string, mode: ProjectMode): StarterSkill {
  const name = projectName.toLocaleLowerCase();
  const match = (pattern: RegExp, id: string): StarterSkill | undefined =>
    pattern.test(name) ? findStarterSkill(id) : undefined;
  return match(/support|help.?desk|customer|refund|ticket/, "support-chat-quality")
    ?? match(/rag|retriev|search|knowledge|docs?/, "rag-faithfulness")
    ?? match(/code|copilot|pull request|\bpr\b|repo/, "code-gen-safety")
    ?? match(/skill|harness|codex|claude|cursor/, "agent-skill-audit")
    ?? (mode === "bench" ? match(/audit/, "agent-skill-audit") : undefined)
    ?? STARTER_SKILLS[0]!;
}

export function recommendationReason(starter: StarterSkill, projectName: string): string {
  if (starter.id === "task-outcome-quality") {
    return "The project name did not point to a narrower quality question, so this starts with overall task completion.";
  }
  return `“${projectName}” looks closest to ${starter.fit.toLocaleLowerCase()}, so this starts with that focused Check.`;
}

export function evidenceReadDescription(mode: ProjectMode, evidenceCount: number): string {
  const evidence = evidenceCount === 0
    ? "the first Run you add"
    : `${evidenceCount} saved ${evidenceCount === 1 ? "Run" : "Runs"}`;
  return mode === "bench"
    ? `${evidence}: the request, result, and any saved steps or metadata.`
    : `${evidence}: the captured input, output, steps, and metadata.`;
}

export function evidenceLimitDescription(): string {
  return "It cannot see missing tool calls, file changes, policies, or context that were not captured in the Run or written into the Review guide.";
}

export function draftFromStarter(input: {
  projectId: string;
  skillId: string;
  starter: StarterSkill;
  decisionSource: OnboardingCheckDraft["decisionSource"];
  decisionReason?: string | null;
}): OnboardingCheckDraft {
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    skillId: input.skillId,
    starterId: input.starter.id,
    criterionName: input.starter.name,
    qualityQuestion: input.starter.qualityQuestion,
    rubricMarkdown: input.starter.rubricMarkdown,
    decisionSource: input.decisionSource,
    decisionReason: input.decisionReason ?? null
  };
}

function isDraft(value: unknown, projectId: string, skillId: string): value is OnboardingCheckDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<OnboardingCheckDraft>;
  return draft.schemaVersion === 1 &&
    draft.projectId === projectId &&
    draft.skillId === skillId &&
    typeof draft.starterId === "string" &&
    typeof draft.criterionName === "string" &&
    typeof draft.qualityQuestion === "string" &&
    typeof draft.rubricMarkdown === "string" &&
    (draft.decisionSource === "user" || draft.decisionSource === "coeval") &&
    (draft.decisionReason === null || typeof draft.decisionReason === "string");
}

export function saveOnboardingCheckDraft(draft: OnboardingCheckDraft): void {
  try {
    sessionStorage.setItem(storageKey(draft.projectId, draft.skillId), JSON.stringify(draft));
  } catch {
    // Draft persistence helps navigation but must not block setup.
  }
}

export function loadOnboardingCheckDraft(projectId: string, skillId: string): OnboardingCheckDraft | null {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId, skillId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed, projectId, skillId) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearOnboardingCheckDraft(projectId: string, skillId: string): void {
  try {
    sessionStorage.removeItem(storageKey(projectId, skillId));
  } catch {
    // The draft is only session-scoped assistance.
  }
}
