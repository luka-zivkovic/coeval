import { randomUUID } from "node:crypto";
import type { Trace } from "@coeval/audit/runtime";
import { demoGoldenSet, demoProject, demoSkill, getDemoDashboardSummary } from "@coeval/db";
import {
  type DatasetRevisionDetail,
  type ExceptionCase,
  type ExceptionDetail,
  type GoldenSetEntry,
  type GoldenSetHealthSummary,
  type JudgeRun,
  type SkillFormatExample,
  type VerdictRecord,
  effectiveHumanLabel,
  verdictLabelFromPayload
} from "@coeval/shared";
import { redactTrace } from "../lib/redaction.js";
import type {
  PromoteExceptionToGoldenSetInput,
  RetireGoldenSetEntryInput
} from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import {
  AmbiguousProjectSkillError,
  CaseNotFoundError,
  DatasetRevisionConflictError,
  GoldenSetEntryAlreadyRetiredError,
  GoldenSetEntryNotFoundError,
  GoldenSetLabelConflictError
} from "./errors.js";
import type { GoldenEvidenceRepositoryPort } from "./ports.js";

interface DemoGoldenEvidenceRepositoryDependencies {
  buildGoldenSetHealthSummary(
    projectId: string,
    entries: GoldenSetEntry[],
    now: Date
  ): GoldenSetHealthSummary;
  getCaseDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail | null>;
  getDemoActorName(actorUserId: string): string | undefined;
  getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string | undefined,
    criterionVersionId?: string | undefined
  ): Promise<DatasetRevisionDetail>;
  listGoldenSet(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetEntry[]>;
  resolveGoldenCriterionVersion(
    projectId: string,
    requested?: string | undefined
  ): Promise<string>;
  syntheticTraceForBuiltinCase(caseId: string): Trace | null;
}

// Internal DemoRepository slice. It owns no state: the facade constructs it
// once with the exact shared store and narrow callbacks for cross-port work
// and preservation of the facade's existing polymorphic dispatch.
export class DemoGoldenEvidenceRepository implements GoldenEvidenceRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoGoldenEvidenceRepositoryDependencies
  ) {}

  async listGoldenSet(
    projectId = demoProject.id,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetEntry[]> {
    const resolvedCriterionVersionId = await this.dependencies.resolveGoldenCriterionVersion(
      projectId,
      criterionVersionId
    );
    return [...this.store.promotedGoldenSet, ...demoGoldenSet].filter((entry) =>
      entry.criterionVersionId === resolvedCriterionVersionId &&
      !this.store.retiredGoldenSetEntries.has(entry.id)
    );
  }

  async getSkillFormatExamples(
    projectId: string,
    cap: number,
    criterionVersionId?: string | undefined
  ): Promise<SkillFormatExample[]> {
    const golden = (await this.dependencies.listGoldenSet(projectId, criterionVersionId)).slice(0, cap);
    const examples: SkillFormatExample[] = [];
    for (const entry of golden) {
      // Reuse the redacted case-detail trace (demo parity with the PG join).
      const detail = await this.dependencies.getCaseDetail(projectId, entry.caseId, entry.sourceSkillVersionId).catch(() => null);
      examples.push({
        id: entry.id,
        label: entry.agreedLabel,
        input: detail?.trace.input ?? null,
        output: detail?.trace.output ?? null,
        reason: entry.reason,
        ...(detail?.trace.metadata && Object.keys(detail.trace.metadata).length > 0 ? { metadata: detail.trace.metadata } : {})
      });
    }
    return examples;
  }

  async getGoldenSetHealth(
    projectId = demoProject.id,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetHealthSummary> {
    return this.dependencies.buildGoldenSetHealthSummary(
      projectId,
      await this.dependencies.listGoldenSet(projectId, criterionVersionId),
      new Date(demoProject.updatedAt)
    );
  }

  async getExceptionDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail> {
    const detail = await this.dependencies.getCaseDetail(projectId, caseId, skillVersionId);
    if (!detail || detail.judgeRun.verdict === "pass") throw new Error(`Exception not found: ${caseId}`);
    return detail;
  }

  // generic case detail. Resolves an exception, a golden case, OR any
  // runtime-judged case to its trace — PgRepository resolves any case with a
  // judge run, and promotion ("any judged case is promotable") relies on the
  // same contract holding in demo mode.
  async getCaseDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail | null> {
    const criterionCount = this.store.criteria.filter((criterion) => criterion.projectId === projectId).length;
    if (!skillVersionId && criterionCount > 1) {
      throw new AmbiguousProjectSkillError(projectId, criterionCount);
    }
    const judged = [...this.store.judgeRuns]
      .filter((run) => run.caseId === caseId && (!skillVersionId || run.skillVersionId === skillVersionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (judged) {
      const trace = this.store.traces.get(caseId);
      return this.buildDemoCaseDetail(
        caseId,
        trace?.id ?? caseId,
        judged.verdict,
        judged.reasoning,
        undefined,
        judged
      );
    }
    const summary = getDemoDashboardSummary();
    const exception = summary.exceptions.find((candidate) => candidate.id === caseId);
    if (exception && (!skillVersionId || skillVersionId === demoSkill.currentVersion.id)) {
      return this.buildDemoCaseDetail(exception.id, exception.traceId, exception.verdict, exception.reason, exception.capabilityGap);
    }
    const goldenCriterionVersionId = skillVersionId
      ? this.store.skillVersionCriteria.get(skillVersionId)
      : undefined;
    const golden = (await this.dependencies.listGoldenSet(projectId, goldenCriterionVersionId)).find((entry) =>
      entry.caseId === caseId && (!skillVersionId || entry.sourceSkillVersionId === skillVersionId)
    );
    if (golden) {
      return this.buildDemoCaseDetail(golden.caseId, golden.traceId, golden.agreedLabel, golden.reason, undefined);
    }
    return null;
  }

  private buildDemoCaseDetail(
    caseId: string,
    traceId: string,
    verdict: ExceptionDetail["judgeRun"]["verdict"],
    reason: string,
    capabilityGap: string | undefined,
    recordedRun?: JudgeRun | undefined
  ): ExceptionDetail {
    const skillVersionId = recordedRun?.skillVersionId ?? demoSkill.currentVersion.id;
    const criterionVersionId = this.store.skillVersionCriteria.get(skillVersionId);
    let verdictHistory: VerdictRecord[] = this.store.verdicts
      .filter((record) => record.projectId === demoProject.id && record.caseId === caseId)
      .filter((record) => record.source === "llm_judge" || record.source === "human" || record.source === "adjudicated")
      .filter((record) => !criterionVersionId || (
        record.skillVersionId !== null && this.store.skillVersionCriteria.get(record.skillVersionId) === criterionVersionId
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((record) => ({
        ...record,
        actorName: record.actorName ?? (
          record.actorUserId
            ? this.dependencies.getDemoActorName(record.actorUserId) ?? null
            : record.source === "human" || record.source === "adjudicated"
              ? "Demo reviewer"
              : null
        )
      }));
    // recordJudgeRun is the first, independently durable write in the worker.
    // When the companion verdict write fails, keep that evaluator evidence in
    // the demo history instead of displaying a latest run that the audit trail
    // cannot explain. A later/equal v2 verdict for the same immutable version
    // is the normal paired-write state and avoids a duplicate projection.
    if (recordedRun && !verdictHistory.some((record) =>
      record.source === "llm_judge" &&
      record.skillVersionId === recordedRun.skillVersionId &&
      record.createdAt >= recordedRun.createdAt
    )) {
      const recordedRunEvidence: VerdictRecord = {
        id: `verdict_from_${recordedRun.id}`,
        projectId: recordedRun.projectId,
        caseId: recordedRun.caseId,
        skillVersionId: recordedRun.skillVersionId,
        source: "llm_judge",
        actorUserId: null,
        actorName: null,
        payload: {
          kind: "categorical",
          choice: recordedRun.verdict,
          choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
          rationale: recordedRun.reasoning
        },
        externalRunId: null,
        createdAt: recordedRun.createdAt
      };
      verdictHistory = [
        ...verdictHistory,
        recordedRunEvidence
      ].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      );
    }
    const latestHistoricalJudge = verdictHistory.find((record) => record.source === "llm_judge");
    const displayedSkillVersionId = recordedRun?.skillVersionId ?? latestHistoricalJudge?.skillVersionId ?? skillVersionId;
    const displayedVerdict = recordedRun?.verdict ?? (
      latestHistoricalJudge ? verdictLabelFromPayload(latestHistoricalJudge.payload) : verdict
    );
    const displayedReason = recordedRun?.reasoning ?? latestHistoricalJudge?.payload.rationale ?? reason;
    const displayedCreatedAt = recordedRun?.createdAt ?? latestHistoricalJudge?.createdAt ?? demoProject.updatedAt;
    const displayedJudgeRunId = recordedRun?.id ?? (
      latestHistoricalJudge ? `judge_from_${latestHistoricalJudge.id}` : `judge_${caseId}`
    );
    const exceptionVerdict: ExceptionCase["verdict"] = displayedVerdict;
    const goldenSetEntry = [...this.store.promotedGoldenSet, ...demoGoldenSet].find((entry) =>
      entry.caseId === caseId &&
      (!criterionVersionId || entry.criterionVersionId === criterionVersionId) &&
      !this.store.retiredGoldenSetEntries.has(entry.id)
    ) ?? null;
    // Imported cases serve their REAL stored payload (already redacted at
    // ingestion — PG parity, and the only way steps reach case detail);
    // the synthetic placeholder remains for built-in fixture cases only.
    const stored = this.store.traces.get(caseId);
    const trace = stored
      ? { ...stored, id: traceId, metadata: stored.metadata ?? {} }
      : redactTrace({
          id: traceId,
          input: { text: "Demo customer support question" },
          output: { text: "Demo AI answer for case drill-down" },
          metadata: { source: "demo", ...(capabilityGap ? { capabilityGap } : {}) }
        });
    return {
      exception: {
        id: caseId,
        traceId,
        title: displayedReason.slice(0, 80) || caseId,
        verdict: exceptionVerdict,
        reason: displayedReason,
        skillVersionId: displayedSkillVersionId,
        criterionVersionId: this.store.skillVersionCriteria.get(
          displayedSkillVersionId
        ),
        ...(capabilityGap ? { capabilityGap } : {}),
        reviewerState: "needs_review",
        createdAt: demoProject.updatedAt
      },
      trace: {
        id: trace.id,
        input: trace.input,
        output: trace.output,
        metadata: trace.metadata ?? {},
        ...(trace.steps ? { steps: trace.steps } : {})
      },
      // every dataset's expectation for this case, by name.
      datasetExpectations: this.store.datasetItems
        .filter((item) => item.caseId === caseId)
        .map((item) => ({
          datasetName: this.store.datasets.find((d) => d.id === item.datasetId && !d.archivedAt)?.name ?? null,
          expectedLabel: item.expectedLabel,
          expectedFailStep: item.expectedFailStep
        }))
        .filter((expectation): expectation is { datasetName: string; expectedLabel: "pass" | "fail" | null; expectedFailStep: number | null } =>
          expectation.datasetName !== null
        ),
      judgeRun: {
        id: displayedJudgeRunId,
        projectId: demoProject.id,
        caseId,
        skillVersionId: displayedSkillVersionId,
        verdict: displayedVerdict,
        score: displayedVerdict === "fail" ? 0.2 : displayedVerdict === "pass" ? 0.9 : 0.5,
        reasoning: displayedReason,
        createdAt: displayedCreatedAt
      },
      latestHumanLabel: effectiveHumanLabel(verdictHistory),
      verdictHistory,
      goldenSetEntry,
      rawResponse: {
        label: displayedVerdict,
        reason: displayedReason,
        ...(capabilityGap ? { failureCategory: capabilityGap } : {})
      }
    };
  }

  async promoteExceptionToGoldenSet(input: PromoteExceptionToGoldenSetInput): Promise<GoldenSetEntry> {
    // Any judged case is promotable (pass anchors included), matching
    // PgRepository — see its rationale.
    const detail = await this.dependencies.getCaseDetail(input.projectId, input.caseId, input.skillVersionId);
    if (!detail) throw new CaseNotFoundError(input.caseId);
    if (this.store.traceSources.get(input.caseId)?.source === "release_evidence") {
      throw new CaseNotFoundError(input.caseId);
    }
    // Mirror PgRepository: a label that contradicts the recorded human
    // decision must not be frozen.
    if (
      detail.latestHumanLabel &&
      detail.latestHumanLabel !== "ambiguous" &&
      detail.latestHumanLabel !== input.agreedLabel
    ) {
      throw new GoldenSetLabelConflictError(input.caseId, input.agreedLabel, detail.latestHumanLabel);
    }
    // Mirror PgRepository: a promotion records a source=human verdict in the
    // v2 ledger (visible to κ / calibration). Pushed directly rather than via
    // recordVerdict so it does NOT complete pending review-queue items — only
    // an explicit human verdict does that.
    this.store.verdicts.push({
      id: `verdict_${randomUUID()}`,
      projectId: input.projectId,
      caseId: input.caseId,
      skillVersionId: detail.judgeRun.skillVersionId,
      source: "human",
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? "Demo reviewer",
      payload: {
        kind: "categorical",
        choice: input.agreedLabel,
        choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
        rationale: input.reason
      },
      externalRunId: null,
      createdAt: new Date().toISOString()
    });
    const criterionVersionId = this.store.skillVersionCriteria.get(detail.judgeRun.skillVersionId);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Judge evaluator has no immutable criterion version binding");
    }
    const existing = this.store.promotedGoldenSet.find((entry) =>
      entry.caseId === input.caseId &&
      this.store.skillVersionCriteria.get(entry.sourceSkillVersionId) === criterionVersionId &&
      !this.store.retiredGoldenSetEntries.has(entry.id)
    );
    if (existing) {
      existing.agreedLabel = input.agreedLabel;
      existing.reason = input.reason;
      existing.promotedBy = input.actorName ?? "Reviewer";
      existing.promotedAt = new Date().toISOString();
      await this.dependencies.getOrCreateRegressionDatasetRevision(input.projectId, input.actorUserId, criterionVersionId);
      return existing;
    }
    const entry: GoldenSetEntry = {
      id: `gold_${randomUUID()}`,
      caseId: input.caseId,
      traceId: detail.trace.id,
      agreedLabel: input.agreedLabel,
      reason: input.reason,
      promotedBy: input.actorName ?? "Reviewer",
      promotedAt: new Date().toISOString(),
      sourceSkillVersionId: detail.judgeRun.skillVersionId,
      criterionVersionId
    };
    this.store.promotedGoldenSet.unshift(entry);
    await this.dependencies.getOrCreateRegressionDatasetRevision(input.projectId, input.actorUserId, criterionVersionId);
    return entry;
  }

  async retireGoldenSetEntry(input: RetireGoldenSetEntryInput): Promise<void> {
    const entry = [...this.store.promotedGoldenSet, ...demoGoldenSet].find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new GoldenSetEntryNotFoundError(input.entryId);
    const retirement = this.store.retiredGoldenSetEntries.get(entry.id);
    if (retirement) throw new GoldenSetEntryAlreadyRetiredError(input.entryId, retirement);
    this.store.retiredGoldenSetEntries.set(entry.id, {
      retiredAt: new Date().toISOString(),
      retiredByUserId: input.actorUserId ?? null,
      retiredBy: input.actorUserId ?? "Unknown",
      reason: input.reason ?? null
    });
    const criterionVersionId = this.store.skillVersionCriteria.get(entry.sourceSkillVersionId);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Golden evidence has no immutable criterion version binding");
    }
    await this.dependencies.getOrCreateRegressionDatasetRevision(input.projectId, input.actorUserId, criterionVersionId);
  }

  async getGoldenSetTraces(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<Map<string, Trace>> {
    const traces = new Map<string, Trace>();
    for (const entry of await this.dependencies.listGoldenSet(projectId, criterionVersionId)) {
      // Imported (promoted) cases first; built-in fixture golden cases get the
      // same synthesized traces the judge context uses.
      const trace = this.store.traces.get(entry.caseId) ?? this.dependencies.syntheticTraceForBuiltinCase(entry.caseId);
      if (trace) traces.set(entry.caseId, trace);
    }
    return traces;
  }
}
