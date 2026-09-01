import { randomUUID } from "node:crypto";
import type {
  ReviewQueue,
  ReviewQueueDetail,
  ReviewQueueItem,
  ReviewQueueStatus,
  Skill
} from "@coeval/shared";
import type { AddQueueItemsInputDb, CreateReviewQueueInputDb } from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import { AmbiguousProjectSkillError, DatasetRevisionConflictError } from "./errors.js";
import type { ReviewQueueRepositoryPort } from "./ports.js";

interface DemoReviewQueueRepositoryDependencies {
  caseExistsForProject(projectId: string, caseId: string): Promise<boolean>;
  getCurrentSkill(projectId: string): Promise<Skill>;
}

// Internal DemoRepository annotation-queue slice. Queue and assignment state
// remain on the exact shared store; case ownership and current evaluator
// selection keep flowing through the facade's existing domain boundaries.
export class DemoReviewQueueRepository implements ReviewQueueRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoReviewQueueRepositoryDependencies
  ) {}

  async createReviewQueue(input: CreateReviewQueueInputDb): Promise<ReviewQueue> {
    const criterionVersionId = await this.resolveReviewCriterionVersion(
      input.projectId,
      input.criterionVersionId
    );
    // Reject case IDs that don't belong to this project. DemoRepo's tenancy
    // model: all cases live in the demo project; PG enforces via FK.
    for (const caseId of input.caseIds) {
      if (!(await this.dependencies.caseExistsForProject(input.projectId, caseId))) {
        throw new Error(`Case not found in project: ${caseId}`);
      }
    }
    const id = `revq_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.store.reviewQueues.push({
      id,
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      status: "open",
      createdByUserId: input.createdByUserId ?? null,
      createdAt,
      closedAt: null
    });
    const seen = new Set<string>();
    let position = 0;
    for (const caseId of input.caseIds) {
      if (seen.has(caseId)) continue; // dedup within a single create call
      seen.add(caseId);
      this.store.reviewQueueItems.push({
        id: `revqi_${randomUUID()}`,
        queueId: id,
        caseId,
        criterionVersionId,
        status: "pending",
        position,
        assignedToUserId: null,
        createdAt,
        completedAt: null
      });
      position += 1;
    }
    return this.toReviewQueue(this.store.reviewQueues[this.store.reviewQueues.length - 1]!);
  }

  async listReviewQueues(projectId: string, opts?: { status?: ReviewQueueStatus | undefined }): Promise<ReviewQueue[]> {
    return this.store.reviewQueues
      .filter((q) => q.projectId === projectId)
      .filter((q) => !opts?.status || q.status === opts.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((q) => this.toReviewQueue(q));
  }

  async getReviewQueueDetail(projectId: string, queueId: string): Promise<ReviewQueueDetail | null> {
    const row = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!row) return null;
    return {
      queue: this.toReviewQueue(row),
      items: this.store.reviewQueueItems
        .filter((item) => item.queueId === queueId)
        .sort((left, right) => left.position - right.position)
    };
  }

  async getNextPendingQueueItem(projectId: string, queueId: string, opts?: {
    assignedToUserId?: string | undefined;
    criterionVersionId?: string | undefined;
  }): Promise<ReviewQueueItem | null> {
    const queue = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue || queue.status !== "open") return null;
    const pending = this.store.reviewQueueItems.filter((item) => item.queueId === queueId && item.status === "pending");
    const criterionVersions = new Set(pending.map((item) => item.criterionVersionId));
    if (!opts?.criterionVersionId && criterionVersions.size > 1) {
      throw new AmbiguousProjectSkillError(projectId, Math.max(2, criterionVersions.size));
    }
    if (opts?.criterionVersionId) {
      await this.resolveReviewCriterionVersion(projectId, opts.criterionVersionId);
    }
    return pending
      .filter((item) => !opts?.criterionVersionId || item.criterionVersionId === opts.criterionVersionId)
      .filter((item) => {
        // No assignee filter → return any pending item (unassigned or
        // assigned). With a filter → match either: (a) explicitly assigned to
        // this reviewer, or (b) unassigned (anyone can pull).
        if (!opts?.assignedToUserId) return true;
        return item.assignedToUserId === opts.assignedToUserId || item.assignedToUserId === null;
      })
      .sort((left, right) => left.position - right.position)[0] ?? null;
  }

  async closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const queue = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue) return null;
    if (queue.status !== "closed") {
      queue.status = "closed";
      queue.closedAt = new Date().toISOString();
    }
    return this.toReviewQueue(queue);
  }

  async reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const queue = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue) return null;
    if (queue.status !== "open") {
      queue.status = "open";
      queue.closedAt = null;
    }
    return this.toReviewQueue(queue);
  }

  async addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]> {
    const queue = this.store.reviewQueues.find((q) => q.id === input.queueId && q.projectId === input.projectId);
    if (!queue) throw new Error(`Review queue not found: ${input.queueId}`);
    // Validate every case before any insert — same shape as createReviewQueue.
    for (const item of input.items) {
      if (!(await this.dependencies.caseExistsForProject(input.projectId, item.caseId))) {
        throw new Error(`Case not found in project: ${item.caseId}`);
      }
    }
    const resolvedItems = await Promise.all(input.items.map(async (item) => ({
      ...item,
      criterionVersionId: await this.resolveReviewCriterionVersion(
        input.projectId,
        item.criterionVersionId
      )
    })));
    // Position continues where the existing items end so new rows append in
    // FIFO order.
    let position = this.store.reviewQueueItems.filter((existing) => existing.queueId === input.queueId).length;
    const createdAt = new Date().toISOString();
    const added: ReviewQueueItem[] = [];
    const seen = new Set<string>();
    for (const item of resolvedItems) {
      const dedupKey = `${item.caseId}__${item.criterionVersionId}__${item.assignedToUserId ?? ""}`;
      // Within this call: dedup on (case, criterion, assignee) — the same tuple twice is
      // pointless. Across calls: the unique index on PG enforces the same.
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      // Also dedup against existing items in the queue with the same pair.
      const alreadyExists = this.store.reviewQueueItems.some(
        (existing) =>
          existing.queueId === input.queueId &&
          existing.caseId === item.caseId &&
          existing.criterionVersionId === item.criterionVersionId &&
          (existing.assignedToUserId ?? "") === (item.assignedToUserId ?? "")
      );
      if (alreadyExists) continue;
      const row: ReviewQueueItem = {
        id: `revqi_${randomUUID()}`,
        queueId: input.queueId,
        caseId: item.caseId,
        criterionVersionId: item.criterionVersionId,
        status: "pending",
        position,
        assignedToUserId: item.assignedToUserId ?? null,
        createdAt,
        completedAt: null
      };
      this.store.reviewQueueItems.push(row);
      added.push(row);
      position += 1;
    }
    return added;
  }

  private async resolveReviewCriterionVersion(
    projectId: string,
    requested?: string | undefined
  ): Promise<string> {
    if (requested) {
      const criterionVersion = this.store.criterionVersions.find((candidate) =>
        candidate.projectId === projectId && candidate.id === requested
      );
      const hasEvaluator = [...this.store.skillVersionCriteria.values()].includes(requested);
      if (!criterionVersion || !hasEvaluator) {
        throw new DatasetRevisionConflictError(
          `Criterion version is not bound to an evaluator in this project: ${requested}`
        );
      }
      return requested;
    }
    const current = await this.dependencies.getCurrentSkill(projectId);
    const criterionVersionId = this.store.skillVersionCriteria.get(current.currentVersion.id);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Current evaluator has no immutable criterion version binding");
    }
    return criterionVersionId;
  }

  private toReviewQueue(row: {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    status: ReviewQueueStatus;
    createdByUserId: string | null;
    createdAt: string;
    closedAt: string | null;
  }): ReviewQueue {
    let pendingCount = 0;
    let completedCount = 0;
    for (const item of this.store.reviewQueueItems) {
      if (item.queueId !== row.id) continue;
      if (item.status === "pending") pendingCount += 1;
      else completedCount += 1;
    }
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      status: row.status,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      pendingCount,
      completedCount
    };
  }
}
