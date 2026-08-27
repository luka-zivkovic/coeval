import type { CapabilityGap, ExceptionCase } from "@coeval/shared";

// These are exact evaluator-supplied categories, not semantic clusters.
// Severity only describes the number of unresolved cases in the current queue.
export function capabilityGapsFromExceptions(exceptions: ExceptionCase[]): CapabilityGap[] {
  const counts = new Map<string, number>();
  for (const exception of exceptions) {
    if (!exception.capabilityGap) continue;
    counts.set(exception.capabilityGap, (counts.get(exception.capabilityGap) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, count]) => ({
      id: `gap_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      name,
      count,
      severity: count >= 5 ? "high" : count >= 2 ? "medium" : "low"
    }));
}
