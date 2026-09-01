import { randomUUID } from "node:crypto";
import type { RunComparison } from "@coeval/shared";
import type { CreateRunComparisonInputDb } from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import { DatasetRevisionConflictError } from "./errors.js";
import type { RunComparisonRepositoryPort } from "./ports.js";

// Internal DemoRepository incident-bisect slice. Comparisons retain the exact
// shared dataset-revision and eval-run identities owned by the facade store.
export class DemoRunComparisonRepository implements RunComparisonRepositoryPort {
  constructor(private readonly store: DemoRepositoryStore) {}

  async createRunComparison(input: CreateRunComparisonInputDb): Promise<RunComparison> {
    if (input.datasetRevisionId) {
      const revision = this.store.datasetRevisions.find((candidate) =>
        candidate.id === input.datasetRevisionId &&
        candidate.projectId === input.projectId &&
        candidate.sourceDatasetId === input.datasetId
      );
      const runA = this.store.evalRuns.find((candidate) => candidate.id === input.runAId && candidate.projectId === input.projectId);
      const runB = this.store.evalRuns.find((candidate) => candidate.id === input.runBId && candidate.projectId === input.projectId);
      if (!revision || runA?.datasetRevisionId !== revision.id || runB?.datasetRevisionId !== revision.id) {
        throw new DatasetRevisionConflictError(
          "Run comparison revision must match its dataset and both eval runs"
        );
      }
    }
    const comparison: RunComparison = {
      id: `rcmp_${randomUUID()}`,
      projectId: input.projectId,
      datasetId: input.datasetId,
      datasetRevisionId: input.datasetRevisionId ?? null,
      versionAId: input.versionAId,
      versionBId: input.versionBId,
      runAId: input.runAId,
      runBId: input.runBId,
      createdAt: new Date().toISOString()
    };
    this.store.runComparisons.push(comparison);
    return { ...comparison };
  }

  async getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null> {
    const comparison = this.store.runComparisons.find(
      (candidate) => candidate.id === runComparisonId && candidate.projectId === projectId
    );
    return comparison ? { ...comparison } : null;
  }

  async listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]> {
    return this.store.runComparisons
      .filter((comparison) => comparison.projectId === projectId)
      // id desc tiebreaker mirrors the PG repository: same-millisecond rows
      // still list in a stable order.
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      )
      .slice(0, opts?.limit ?? 50)
      .map((comparison) => ({ ...comparison }));
  }
}
