export const CRITERION_QUERY_PARAM = "criterionId";

export function resolveCriterionSelection(
  criterionIds: readonly string[],
  queryCriterionId: string | null,
  persistedCriterionId: string | null,
): string | null {
  const valid = new Set(criterionIds);
  if (queryCriterionId !== null) {
    if (valid.has(queryCriterionId)) return queryCriterionId;
    // An explicit but stale/deleted selector must not silently open a
    // different persisted criterion in a multi-criterion project.
    return criterionIds.length === 1 ? criterionIds[0]! : null;
  }
  if (persistedCriterionId && valid.has(persistedCriterionId)) return persistedCriterionId;
  return criterionIds.length === 1 ? criterionIds[0]! : null;
}

export function withCriterionSearch(search: string, criterionId: string | null): string {
  const params = new URLSearchParams(search);
  if (criterionId) params.set(CRITERION_QUERY_PARAM, criterionId);
  else params.delete(CRITERION_QUERY_PARAM);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function criterionSelectionStorageKey(projectId: string | null): string {
  return `coeval.criterion.${projectId ?? "default"}`;
}
