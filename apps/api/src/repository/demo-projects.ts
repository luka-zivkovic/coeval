import type { Trace } from "@coeval/audit/runtime";
import { demoProject, demoSkill, getDemoDashboardSummary } from "@coeval/db";
import type {
  DashboardSummary,
  GoldenSetEntry,
  OnboardingEvidenceInventory,
  Project,
  ProjectSettings,
  RetentionPruneResult,
  Skill,
  UpdateProjectSettingsInput
} from "@coeval/shared";
import { capabilityGapsFromExceptions } from "../lib/capability-gaps.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import type { ProjectRepositoryPort } from "./ports.js";

interface DemoProjectRepositoryDependencies {
  getCurrentSkill(projectId?: string | undefined): Promise<Skill>;
  getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill>;
  isEvidenceScaffoldingCase(caseId: string): boolean;
  listGoldenSet(projectId: string, criterionVersionId?: string | undefined): Promise<GoldenSetEntry[]>;
  syntheticTraceForBuiltinCase(caseId: string): Trace | null;
}

// Internal DemoRepository slice. It owns no state: the facade constructs it
// once with the exact shared store and narrow callbacks for cross-port reads.
export class DemoProjectRepository implements ProjectRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoProjectRepositoryDependencies
  ) {}

  async listProjects(): Promise<Project[]> {
    return [demoProject];
  }

  async getProjectSettings(): Promise<ProjectSettings> {
    return {
      projectId: demoProject.id,
      name: demoProject.name,
      mode: demoProject.mode,
      traceRetentionDays: demoProject.traceRetentionDays
    };
  }

  async updateProjectSettings(_projectId: string, input: UpdateProjectSettingsInput): Promise<ProjectSettings> {
    return {
      projectId: demoProject.id,
      name: demoProject.name,
      mode: input.mode ?? demoProject.mode,
      traceRetentionDays: input.traceRetentionDays
    };
  }

  async pruneExpiredTraces(): Promise<RetentionPruneResult> {
    return {
      projectId: demoProject.id,
      traceRetentionDays: demoProject.traceRetentionDays,
      cutoff: null,
      deletedCases: 0,
      deletedRawTraces: 0,
      skippedActiveGoldenCases: 0,
      skippedImmutableRevisionCases: 0
    };
  }

  async deleteProject(_projectId: string, input: { confirmProjectName: string }): Promise<void> {
    if (input.confirmProjectName !== demoProject.name) throw new Error("Project confirmation did not match");
  }

  async getDashboardSummary(projectId = demoProject.id, criterionId?: string | undefined): Promise<DashboardSummary> {
    const summary = getDemoDashboardSummary();
    const skill = criterionId
      ? await this.dependencies.getCurrentSkillForCriterion(projectId, criterionId)
      : await this.dependencies.getCurrentSkill(projectId);
    const criterionVersionId = skill.currentVersion.criterionVersionId;
    // Gate candidates and release evidence are invisible to
    // every dashboard number — trace counts, coverage, and the verdict chart
    // (mirrors the PG exclusions on case_type = 'gate_candidate').
    const countedRuns = this.store.judgeRuns.filter((run) =>
      !this.dependencies.isEvidenceScaffoldingCase(run.caseId) &&
      this.store.skillVersionCriteria.get(run.skillVersionId) === criterionVersionId
    );
    const isLegacyCriterion = criterionId === undefined || criterionId === demoSkill.criterionId;
    const exceptions = isLegacyCriterion
      ? summary.exceptions.filter((exception) => {
          const scopedVerdicts = this.store.verdicts.filter((verdict) =>
            verdict.projectId === projectId &&
            verdict.caseId === exception.id &&
            verdict.skillVersionId !== null &&
            this.store.skillVersionCriteria.get(verdict.skillVersionId) === criterionVersionId
          );
          const latestResolution = scopedVerdicts
            .filter((verdict) => verdict.source === "human" || verdict.source === "adjudicated")
            .sort((left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
            )[0];
          const latestJudge = scopedVerdicts
            .filter((verdict) => verdict.source === "llm_judge")
            .sort((left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
            )[0];
          const latestRecordedRun = countedRuns
            .filter((run) => run.caseId === exception.id)
            .sort((left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
            )[0];
          const latestJudgeAt = [latestJudge?.createdAt, latestRecordedRun?.createdAt]
            .filter((createdAt): createdAt is string => Boolean(createdAt))
            .sort((left, right) => right.localeCompare(left))[0];
          // Match the PG queue projector: a human/owner ruling closes the
          // exception until a strictly newer evaluator run reopens it.
          return !latestResolution || Boolean(latestJudgeAt && latestJudgeAt > latestResolution.createdAt);
        })
      : [];
    const goldenSetSize = (await this.dependencies.listGoldenSet(projectId, criterionVersionId)).length;
    const topCapabilityGaps = isLegacyCriterion ? capabilityGapsFromExceptions(exceptions) : [];
    const dynamicCurrentVersionResultCount = new Set(
      countedRuns
        .filter((run) =>
          run.skillVersionId === skill.currentVersion.id &&
          // The aggregate demo baseline already includes every built-in
          // case. A runtime re-judge of one of those identities replaces its
          // Result; it is not another covered case. Dynamically imported
          // cases remain outside that baseline and do increase coverage.
          !(isLegacyCriterion && skill.currentVersion.id === demoSkill.currentVersion.id &&
            this.dependencies.syntheticTraceForBuiltinCase(run.caseId))
        )
        .map((run) => run.caseId)
    ).size;
    const currentVersionResultCount = isLegacyCriterion && skill.currentVersion.id === demoSkill.currentVersion.id
      ? summary.currentVersionResultCount + dynamicCurrentVersionResultCount
      : dynamicCurrentVersionResultCount;
    if (countedRuns.length === 0) {
      return {
        ...summary,
        skill,
        currentVersionResultCount,
        verdictDistribution: isLegacyCriterion
          ? summary.verdictDistribution
          : { pass: 0, fail: 0, ambiguous: 0 },
        exceptions,
        topCapabilityGaps,
        goldenSetSize
      };
    }
    const countedTraces = [...this.store.traceSources.values()]
      .filter((traceSource) => traceSource.source !== "gate_candidate" && traceSource.source !== "release_evidence").length;
    // P1-4 parity with PG: one vote per case — the latest judge verdict on
    // each judged case, not every run row (re-judges and repeat probes would
    // inflate the chart).
    const latestByCase = new Map<string, (typeof this.store.judgeRuns)[number]>();
    for (const run of countedRuns) {
      const prior = latestByCase.get(run.caseId);
      if (!prior || run.createdAt >= prior.createdAt) latestByCase.set(run.caseId, run);
    }
    const verdictDistribution = { pass: 0, fail: 0, ambiguous: 0 };
    for (const run of latestByCase.values()) verdictDistribution[run.verdict] += 1;
    return {
      ...summary,
      skill,
      currentVersionResultCount,
      exceptions,
      topCapabilityGaps,
      goldenSetSize,
      project: {
        ...summary.project,
        importedTraceCount: summary.project.importedTraceCount + countedTraces,
        // Distinct judged cases, not judge_runs rows — re-judges under a new
        // skill version are not new coverage (mirrors the PG recount).
        autoJudgedTraceCount:
          summary.project.autoJudgedTraceCount + new Set(countedRuns.map((run) => run.caseId)).size
      },
      verdictDistribution
    };
  }

  async getOnboardingEvidenceInventory(projectId: string): Promise<OnboardingEvidenceInventory> {
    if (projectId !== demoProject.id) {
      return { runCount: 0, inputCount: 0, outputCount: 0, stepsCount: 0, metadataCount: 0 };
    }
    const inventory: OnboardingEvidenceInventory = {
      runCount: 0,
      inputCount: 0,
      outputCount: 0,
      stepsCount: 0,
      metadataCount: 0
    };
    for (const [caseId, trace] of this.store.traces.entries()) {
      if (this.dependencies.isEvidenceScaffoldingCase(caseId) || !this.store.traceSources.has(caseId)) continue;
      inventory.runCount += 1;
      if (trace.input !== null && trace.input !== undefined) inventory.inputCount += 1;
      if (trace.output !== null && trace.output !== undefined) inventory.outputCount += 1;
      if ((trace.steps?.length ?? 0) > 0) inventory.stepsCount += 1;
      if (Object.keys(trace.metadata ?? {}).length > 0) inventory.metadataCount += 1;
    }
    return inventory;
  }
}
