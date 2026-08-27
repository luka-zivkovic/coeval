import type { SkillVersion } from "@coeval/shared";

export function skillEditConsequence(goldenSetSize: number | null): string {
  if (goldenSetSize === null) {
    return "Editing creates a new immutable version. Known-failure checks run when the current Golden set is non-empty.";
  }
  return goldenSetSize > 0
    ? `Editing creates a new immutable version and compares it with ${goldenSetSize} current Golden reference${goldenSetSize === 1 ? "" : "s"}.`
    : "Editing creates a new immutable version. Add a Golden reference to enable known-failure regression checks.";
}

export function skillVersionStateLabel(version: Pick<SkillVersion, "version" | "status">): string {
  return `v${version.version} · ${version.status}`;
}
