import { randomUUID } from "node:crypto";
import {
  deriveGateCheckDecision,
  type EvalRun,
  type EvalRunDetail,
  type GateCheck,
  type GateCheckDetail,
  type GateCheckItem
} from "@coeval/shared";
import type { CreateGateCheckInputDb } from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import type { HistoricalGateEvidenceRepositoryPort } from "./ports.js";

interface DemoHistoricalGateEvidenceRepositoryDependencies {
  getEvalRun(projectId: string, evalRunId: string): Promise<EvalRun | null>;
  getEvalRunDetail(projectId: string, evalRunId: string): Promise<EvalRunDetail | null>;
  getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null>;
}

// Internal DemoRepository compatibility slice for deprecated historical gate
// evidence. It owns no release decisions: stored compatibility rows remain on
// the exact shared store and projections retain their existing eval-run reads.
export class DemoHistoricalGateEvidenceRepository implements HistoricalGateEvidenceRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoHistoricalGateEvidenceRepositoryDependencies
  ) {}

  async createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail> {
    const createdAt = new Date().toISOString();
    this.store.gateChecks.unshift({
      id: `gate_${randomUUID()}`,
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      evalRunId: input.evalRunId,
      label: input.label ?? null,
      metadata: input.metadata ?? {},
      maxDisagreements: input.maxDisagreements,
      createdAt,
      items: input.items.map((item) => ({ id: `gati_${randomUUID()}`, ...item, createdAt }))
    });
    const detail = await this.dependencies.getGateCheckDetail(input.projectId, this.store.gateChecks[0]!.id);
    if (!detail) throw new Error(`Gate check vanished after create: ${this.store.gateChecks[0]!.id}`);
    return detail;
  }

  async getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null> {
    const stored = this.store.gateChecks.find((candidate) => candidate.id === gateCheckId && candidate.projectId === projectId);
    if (!stored) return null;
    const run = await this.dependencies.getEvalRunDetail(projectId, stored.evalRunId);
    if (!run) return null;
    const items: GateCheckItem[] = stored.items.map((item) => {
      const evalItem = run.items.find((candidate) => candidate.caseId === item.candidateCaseId);
      return {
        id: item.id,
        gateCheckId: stored.id,
        goldenEntryId: item.goldenEntryId,
        goldenCaseId: item.goldenCaseId,
        caseKey: item.caseKey,
        candidateCaseId: item.candidateCaseId,
        expectedLabel: item.expectedLabel,
        status: evalItem?.status === "completed" ? "completed" : evalItem?.status === "failed" ? "failed" : "pending",
        judgedLabel: evalItem?.resultLabel ?? null,
        agreement: evalItem?.agreement ?? null,
        cached: evalItem?.cached ?? false,
        error: evalItem?.error ?? null,
        createdAt: item.createdAt
      };
    });
    return { ...this.projectGateCheck(stored, run), items };
  }

  async listGateChecks(projectId: string, opts?: { limit?: number | undefined }): Promise<GateCheck[]> {
    const checks: GateCheck[] = [];
    for (const stored of this.store.gateChecks) {
      if (stored.projectId !== projectId) continue;
      const run = await this.dependencies.getEvalRun(projectId, stored.evalRunId);
      if (!run) continue;
      checks.push(this.projectGateCheck(stored, run));
    }
    return checks
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, opts?.limit ?? 50);
  }

  private projectGateCheck(
    stored: (typeof this.store.gateChecks)[number],
    run: EvalRun
  ): GateCheck {
    const decision = deriveGateCheckDecision({
      runStatus: run.status,
      totalItems: run.totalItems,
      completedItems: run.completedItems,
      failedItems: run.failedItems,
      agreedItems: run.agreedItems,
      maxDisagreements: stored.maxDisagreements
    });
    return {
      id: stored.id,
      projectId: stored.projectId,
      skillVersionId: stored.skillVersionId,
      evalRunId: stored.evalRunId,
      label: stored.label,
      metadata: stored.metadata,
      maxDisagreements: stored.maxDisagreements,
      status: decision.status,
      totalCandidates: run.totalItems,
      judgedCandidates: run.completedItems,
      erroredCandidates: run.failedItems,
      disagreements: decision.disagreements,
      createdAt: stored.createdAt,
      finishedAt: run.finishedAt
    };
  }
}
