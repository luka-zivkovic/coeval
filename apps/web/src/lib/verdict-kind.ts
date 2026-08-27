import type { VerdictKind } from "@coeval/shared";

export function verdictKindDescription(
  kind: VerdictKind,
  details?: {
    scalarRange?: [number, number] | null;
    categoricalChoiceScores?: Record<string, number> | null;
  }
): string {
  if (kind === "binary") {
    return "Returns pass or fail. Use ambiguous when the evidence is not enough to decide.";
  }
  if (kind === "scalar") {
    return details?.scalarRange
      ? `Returns a numeric value from ${details.scalarRange[0]} to ${details.scalarRange[1]}.`
      : "Returns a numeric value inside the configured range.";
  }
  const choices = Object.keys(details?.categoricalChoiceScores ?? {});
  return choices.length > 0
    ? `Returns one named choice: ${choices.join(", ")}.`
    : "Returns one named choice from the evaluator's configured label set.";
}
