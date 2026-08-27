import type { DashboardSummary, Skill } from "@coeval/shared";

export function skillCriterionVersionId(skill: Skill | null | undefined): string | null {
  return skill?.currentVersion.criterionVersionId ?? null;
}

export function dashboardSkillVersionId(dashboard: DashboardSummary | null | undefined): string | null {
  return dashboard?.skill.currentVersion.id ?? null;
}

export function dashboardCriterionVersionId(dashboard: DashboardSummary | null | undefined): string | null {
  return skillCriterionVersionId(dashboard?.skill);
}

export function filterToSkillVersionScope<T extends { skillVersionId: string }>(
  rows: readonly T[],
  allowedVersionIds: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => allowedVersionIds.has(row.skillVersionId));
}

export function versionPairIsInScope(
  pair: { versionAId: string; versionBId: string },
  allowedVersionIds: ReadonlySet<string>,
): boolean {
  return allowedVersionIds.has(pair.versionAId) && allowedVersionIds.has(pair.versionBId);
}
