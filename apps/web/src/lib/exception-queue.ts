// Deterministic and source-faithful: compact exception rows show the first
// sentence from the recorded judge rationale, never an LLM-generated gist.
export function rationalePreview(reason: string): string {
  const trimmed = reason.trim();
  const boundary = trimmed.search(/[.!?](?:\s|$)/);
  return boundary === -1 ? trimmed : trimmed.slice(0, boundary + 1);
}

export function caseReviewUrl(caseId: string, category?: string | null): string {
  const params = new URLSearchParams({ caseId });
  if (category) params.set("cluster", category);
  return `/review?${params.toString()}`;
}

export function selectReviewCaseIds(input: {
  explicitCaseId: string | null;
  stateCaseIds: string[] | undefined;
  exceptions: Array<{ id: string; capabilityGap?: string | null | undefined }>;
  categoryFilter: string | null;
}): string[] {
  if (input.explicitCaseId) return [input.explicitCaseId];
  if (input.stateCaseIds && input.stateCaseIds.length > 0) return input.stateCaseIds;
  return input.exceptions
    .filter((exception) => !input.categoryFilter || exception.capabilityGap === input.categoryFilter)
    .map((exception) => exception.id);
}
