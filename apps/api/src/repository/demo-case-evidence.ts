import { randomUUID } from "node:crypto";
import { demoExceptions, demoGoldenSet, demoProject } from "@coeval/db";
import type {
  ConvergenceAuditPage,
  DisagreementSummary,
  JudgeCardAuditEntry,
  JudgeHumanDisagreementSummary,
  KappaSummary,
  SelfConsistencyReport,
  VerdictRecord
} from "@coeval/shared";
import {
  computeConvergenceAudit,
  computeDisagreementSummary,
  computeJudgeHumanCalibration,
  computeJudgeHumanDisagreement,
  computeKappaSummary,
  computeSelfConsistency
} from "../lib/kappa.js";
import type {
  CaseListEntry,
  ConvergenceAuditPageInput,
  ListCasesOptions,
  ListVerdictsInput,
  RecordVerdictInput
} from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import {
  AmbiguousProjectSkillError,
  CaseNotFoundError,
  InvalidConvergenceCursorError
} from "./errors.js";
import {
  convergenceChangeRank,
  convergencePageLimit,
  decodeConvergenceCursor,
  encodeConvergenceCursor
} from "./helpers.js";
import type {
  CaseEvidenceRepositoryPort,
  GoldenEvidenceRepositoryPort,
  SkillLifecycleRepositoryPort
} from "./ports.js";

interface DemoCaseEvidenceRepositoryDependencies extends
  Pick<CaseEvidenceRepositoryPort, "caseExistsForProject">,
  Pick<GoldenEvidenceRepositoryPort, "getCaseDetail">,
  Pick<SkillLifecycleRepositoryPort, "getCurrentSkill" | "getSkillVersion" | "listSkillVersions"> {
  getDemoActorName(actorUserId: string): string | undefined;
  isEvidenceScaffoldingCase(caseId: string): boolean;
  resolveGoldenCriterionVersion(projectId: string, requested?: string | undefined): Promise<string>;
}

// Internal DemoRepository case and verdict evidence slice. All mutable
// evidence remains on the one shared store, while lazy facade callbacks keep
// CURRENT subclass dispatch and criterion/evaluator selection behavior.
export class DemoCaseEvidenceRepository implements CaseEvidenceRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoCaseEvidenceRepositoryDependencies
  ) {}

  async recordVerdict(input: RecordVerdictInput): Promise<VerdictRecord> {
    if (input.externalRunId) {
      const existing = this.store.verdicts.find(
        (candidate) =>
          candidate.projectId === input.projectId &&
          candidate.source === "imported_external" &&
          candidate.externalRunId === input.externalRunId
      );
      if (existing) return existing;
    }
    let skillVersionId = input.skillVersionId;
    if (input.source === "human" || input.source === "adjudicated") {
      const criterionCount = this.store.criteria.filter((criterion) => criterion.projectId === input.projectId).length;
      const definitionCount = this.store.criterionVersions.filter((version) => version.projectId === input.projectId).length;
      if (!skillVersionId && (criterionCount > 1 || definitionCount > 1)) {
        throw new AmbiguousProjectSkillError(input.projectId, Math.max(criterionCount, definitionCount));
      }
      const detail = await this.dependencies.getCaseDetail(input.projectId, input.caseId, skillVersionId);
      if (detail) {
        skillVersionId = detail.judgeRun.skillVersionId;
      } else if (skillVersionId) {
        const version = await this.dependencies.getSkillVersion(input.projectId, skillVersionId);
        if (!version || !(await this.dependencies.caseExistsForProject(input.projectId, input.caseId))) {
          throw new CaseNotFoundError(input.caseId);
        }
      } else if (!skillVersionId) {
        // Legacy singleton behavior allowed a reviewer to label an imported
        // case before its first judge run. Preserve that flow by binding the
        // verdict to the sole evaluator instead of writing an unscoped NULL.
        skillVersionId = (await this.dependencies.getCurrentSkill(input.projectId)).currentVersion.id;
      }
    }
    const createdAt = new Date().toISOString();
    const record: VerdictRecord = {
      id: `verdict_${randomUUID()}`,
      projectId: input.projectId,
      caseId: input.caseId,
      skillVersionId: skillVersionId ?? null,
      source: input.source,
      actorUserId: input.actorUserId ?? null,
      payload: input.payload,
      externalRunId: input.externalRunId ?? null,
      createdAt
    };
    this.store.verdicts.push(record);
    // a human verdict completes pending queue items pointing at
    // this case, scoped to:
    //   - items unassigned (any reviewer covered them); AND
    //   - items assigned specifically to this verdict's actor.
    // Items assigned to OTHER reviewers stay pending — they're the κ-overlap
    // partner row and must wait for that reviewer's own verdict.
    if (input.source === "human") {
      const criterionVersionId = skillVersionId
        ? this.store.skillVersionCriteria.get(skillVersionId)
        : undefined;
      for (const item of this.store.reviewQueueItems) {
        if (item.caseId !== input.caseId || item.status !== "pending") continue;
        if (!criterionVersionId || item.criterionVersionId !== criterionVersionId) continue;
        const isMine = item.assignedToUserId === null || item.assignedToUserId === input.actorUserId;
        if (!isMine) continue;
        item.status = "completed";
        item.completedAt = createdAt;
      }
    }
    return record;
  }

  async listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]> {
    return this.store.verdicts
      .filter((verdict) => verdict.projectId === input.projectId)
      .filter((verdict) => input.evidenceScope !== "customer" || !this.dependencies.isEvidenceScaffoldingCase(verdict.caseId))
      .filter((verdict) => !input.caseId || verdict.caseId === input.caseId)
      .filter((verdict) => !input.source || verdict.source === input.source)
      .filter((verdict) => !input.skillVersionId || verdict.skillVersionId === input.skillVersionId)
      .filter((verdict) => {
        if (!input.criterionId) return true;
        if (!verdict.skillVersionId) return false;
        const criterionVersionId = this.store.skillVersionCriteria.get(verdict.skillVersionId);
        return this.store.criterionVersions.some((version) =>
          version.id === criterionVersionId &&
          version.projectId === input.projectId &&
          version.criterionId === input.criterionId
        );
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit)
      .map((verdict) => {
        const actorName = verdict.actorName ?? (
          verdict.actorUserId ? this.dependencies.getDemoActorName(verdict.actorUserId) : undefined
        );
        return actorName ? { ...verdict, actorName } : verdict;
      });
  }

  async getProjectKappaSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<KappaSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    return computeKappaSummary(verdicts);
  }

  async getProjectJudgeHumanCalibration(
    projectId: string,
    criterionVersionId?: string | undefined,
    skillVersionId?: string | undefined
  ): Promise<KappaSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    return computeJudgeHumanCalibration(verdicts.filter((verdict) =>
      !skillVersionId || verdict.source !== "llm_judge" || verdict.skillVersionId === skillVersionId
    ));
  }

  async getDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<DisagreementSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    const summary = computeDisagreementSummary(verdicts);
    this.attachDemoActorNames(summary.cases.map((entry) => entry.labels));
    return summary;
  }

  async getJudgeHumanDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<JudgeHumanDisagreementSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    const summary = computeJudgeHumanDisagreement(verdicts);
    this.attachDemoActorNames(summary.cases.map((entry) => entry.humanLabels));
    return summary;
  }

  async getConvergenceAudit(
    projectId: string,
    skillId: string,
    versionId: string,
    input: ConvergenceAuditPageInput = {}
  ): Promise<ConvergenceAuditPage> {
    // The predecessor = the version created immediately before this one. The
    // list is newest-first, so it's the next entry after this version's index.
    const criterionVersionId = this.store.skillVersionCriteria.get(versionId);
    const versions = (await this.dependencies.listSkillVersions(projectId, skillId, 1000)).filter((version) =>
      criterionVersionId !== undefined && this.store.skillVersionCriteria.get(version.id) === criterionVersionId
    );
    const idx = versions.findIndex((v) => v.id === versionId);
    const beforeVersionId = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1]!.id : null;
    const scopedVerdicts = criterionVersionId
      ? this.store.verdicts.filter((verdict) =>
          verdict.projectId === projectId && (
            (verdict.source === "llm_judge" && (
              verdict.skillVersionId === versionId || verdict.skillVersionId === beforeVersionId
            )) || (
              verdict.source === "adjudicated" &&
              verdict.skillVersionId !== null &&
              this.store.skillVersionCriteria.get(verdict.skillVersionId) === criterionVersionId
            )
          )
        )
      : [];
    const cursor = decodeConvergenceCursor(input.cursor ?? null);
    if (cursor && (
      cursor.versionId !== versionId ||
      cursor.criterionVersionId !== criterionVersionId ||
      cursor.beforeVersionId !== beforeVersionId
    )) {
      throw new InvalidConvergenceCursorError();
    }
    const latestAtSnapshot = cursor
      ? { createdAt: cursor.snapshotCreatedAt, id: cursor.snapshotId }
      : [...scopedVerdicts].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
        )[0] ?? null;
    const verdicts = cursor
      ? scopedVerdicts.filter((verdict) =>
          verdict.createdAt < cursor.snapshotCreatedAt || (
            verdict.createdAt === cursor.snapshotCreatedAt && verdict.id <= cursor.snapshotId
          )
        )
      : scopedVerdicts;
    const completeAudit = computeConvergenceAudit(verdicts, { beforeVersionId, afterVersionId: versionId });
    const limit = convergencePageLimit(input.limit);
    const rank = convergenceChangeRank;
    const afterCursor = cursor
      ? completeAudit.cases.filter((entry) => {
          const entryRank = rank(entry.change);
          return entryRank > cursor.rank || (entryRank === cursor.rank && entry.caseId > cursor.caseId);
        })
      : completeAudit.cases;
    const pageCases = afterCursor.slice(0, limit);
    const hasMore = afterCursor.length > limit;
    const last = pageCases.at(-1) ?? null;
    const covered = new Set(completeAudit.cases.map((entry) => entry.caseId));
    const nextUncoveredCaseId = verdicts
      .filter((verdict) =>
        verdict.source === "adjudicated" &&
        verdict.payload.kind !== "scalar" &&
        !covered.has(verdict.caseId)
      )
      .map((verdict) => verdict.caseId)
      .sort()[0] ?? null;
    return {
      audit: { ...completeAudit, cases: pageCases },
      nextCursor: hasMore && last && latestAtSnapshot
        ? encodeConvergenceCursor({
            versionId,
            criterionVersionId: criterionVersionId!,
            beforeVersionId,
            snapshotCreatedAt: latestAtSnapshot.createdAt,
            snapshotId: latestAtSnapshot.id,
            rank: rank(last.change),
            caseId: last.caseId
          })
        : null,
      nextUncoveredCaseId
    };
  }

  async getSelfConsistencyReport(projectId: string, versionId: string): Promise<SelfConsistencyReport> {
    const verdicts = this.store.verdicts.filter((verdict) => verdict.projectId === projectId);
    return computeSelfConsistency(verdicts, versionId);
  }

  async listAuditEntries(): Promise<JudgeCardAuditEntry[]> {
    // Demo mode records no audit_logs rows; the Judge Card's basis note says so.
    return [];
  }

  async listCases(projectId: string, opts: ListCasesOptions = {}): Promise<CaseListEntry[]> {
    // DemoRepo tenancy: imported traces live in the demo project. Built-in
    // fixture cases (exceptions/golden) are session-demo scaffolding without
    // real timestamps and stay off the machine surface.
    if (projectId !== demoProject.id) return [];
    const limit = opts.limit ?? 500;
    const entries: CaseListEntry[] = [];
    for (const [caseId, trace] of this.store.traces.entries()) {
      if (this.dependencies.isEvidenceScaffoldingCase(caseId)) continue;
      const source = this.store.traceSources.get(caseId);
      if (!source) continue;
      if (opts.since !== undefined && source.createdAt <= opts.since) continue;
      entries.push({
        caseId,
        sourceTraceId: source.sourceTraceId,
        createdAt: source.createdAt,
        trace: {
          input: trace.input,
          output: trace.output,
          metadata: trace.metadata ?? {},
          ...(trace.steps ? { steps: trace.steps } : {})
        }
      });
    }
    return entries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.caseId.localeCompare(b.caseId))
      .slice(0, limit);
  }

  async listCaseIdsForProject(projectId: string, limit = 10_000): Promise<string[]> {
    // DemoRepo tenancy: all cases (traces + exceptions + golden set) live in
    // the demo project. Return the union, deduped, capped at `limit`.
    // Gate candidates are excluded: the approval-time backfill must never
    // re-judge (and pay for) product-gate scaffolding.
    if (projectId !== demoProject.id) return [];
    const ids = new Set<string>();
    for (const caseId of this.store.traces.keys()) {
      if (!this.dependencies.isEvidenceScaffoldingCase(caseId)) ids.add(caseId);
    }
    for (const exception of demoExceptions) ids.add(exception.id);
    for (const entry of demoGoldenSet) ids.add(entry.caseId);
    return [...ids].slice(0, limit);
  }

  async caseExistsForProject(projectId: string, caseId: string): Promise<boolean> {
    // DemoRepo's tenancy model: all built-in fixtures (cases, exceptions, golden
    // set) belong to the demo project. Imported cases (via importTrace) also use
    // the demo project. So a case exists "for this project" iff it exists in any
    // of these sources AND projectId is the demo project.
    if (projectId !== demoProject.id) return false;
    if (this.store.traces.has(caseId)) return true;
    if (demoExceptions.some((exception) => exception.id === caseId)) return true;
    if (demoGoldenSet.some((entry) => entry.caseId === caseId)) return true;
    return false;
  }

  private async verdictsForCriterion(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<VerdictRecord[]> {
    const resolved = await this.dependencies.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    return this.store.verdicts.filter((verdict) =>
      verdict.projectId === projectId &&
      verdict.skillVersionId !== null &&
      this.store.skillVersionCriteria.get(verdict.skillVersionId) === resolved
    );
  }

  private attachDemoActorNames(
    labelLists: Array<Array<{ actorUserId: string; actorName?: string | null | undefined }>>
  ): void {
    for (const labels of labelLists) {
      for (const label of labels) {
        label.actorName = this.dependencies.getDemoActorName(label.actorUserId) ?? null;
      }
    }
  }
}
