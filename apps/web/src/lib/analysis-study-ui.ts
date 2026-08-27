export function analysisStudyUiCapabilities(role: "owner" | "member" | null): {
  canAdminister: boolean;
  canCode: boolean;
} {
  return { canAdminister: role === "owner", canCode: role === "owner" || role === "member" };
}

export async function loadHistoryThroughRequiredIds<T extends { id: string }>(
  requiredIds: readonly string[],
  loadPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>
): Promise<{ items: T[]; nextCursor: string | null }> {
  const required = new Set(requiredIds);
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const page = await loadPage(cursor);
    items.push(...page.items);
    for (const item of page.items) required.delete(item.id);
    if (required.size === 0 || page.nextCursor === null) {
      if (required.size > 0) {
        throw new Error("Analysis history omitted an active evidence event");
      }
      return { items, nextCursor: page.nextCursor };
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Analysis history cursor did not advance");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function replaceAnalysisStudyItemProjection<T extends { item: { id: string } }>(
  items: readonly T[],
  replacement: T
): T[] {
  let replaced = false;
  const next = items.map((item) => {
    if (item.item.id !== replacement.item.id) return item;
    replaced = true;
    return replacement;
  });
  if (!replaced) throw new Error("Updated analysis item is absent from the loaded study page");
  return next;
}

export async function loadAllUsedAnalysisPopulationIds<T extends {
  study: { study: { populationId: string } };
}>(
  firstPage: { items: readonly T[]; nextCursor: string | null; unavailableDueClosureCount: number },
  loadPage: (cursor: string) => Promise<{
    items: readonly T[];
    nextCursor: string | null;
    unavailableDueClosureCount: number;
  }>
): Promise<{ populationIds: Set<string>; unavailableDueClosureCount: number }> {
  const populationIds = new Set(firstPage.items.map((row) => row.study.study.populationId));
  let unavailableDueClosureCount = firstPage.unavailableDueClosureCount;
  const seenCursors = new Set<string>();
  let cursor = firstPage.nextCursor;

  while (cursor !== null) {
    if (seenCursors.has(cursor)) throw new Error("Analysis study cursor did not advance");
    seenCursors.add(cursor);
    const page = await loadPage(cursor);
    for (const row of page.items) populationIds.add(row.study.study.populationId);
    unavailableDueClosureCount += page.unavailableDueClosureCount;
    cursor = page.nextCursor;
  }

  return { populationIds, unavailableDueClosureCount };
}

export async function loadExactActiveFailureObservationCount<T extends {
  activeFailureObservationEventIds: readonly string[];
}>(
  loadPage: (cursor: string | null) => Promise<{ items: readonly T[]; nextCursor: string | null }>
): Promise<string> {
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let count = 0n;

  while (true) {
    const page = await loadPage(cursor);
    for (const item of page.items) count += BigInt(item.activeFailureObservationEventIds.length);
    if (page.nextCursor === null) return count.toString();
    if (seenCursors.has(page.nextCursor)) throw new Error("Analysis item cursor did not advance");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
