import { randomUUID } from "node:crypto";
import type { JudgeProvider, Trace } from "@coeval/audit/runtime";
import { demoProject, demoSkill, demoSkillPrevVersion } from "@coeval/db";
import {
  type CriterionVersion,
  type CreateSkillVersionInput,
  type DatasetRevisionDetail,
  type EvaluatorExecutionContext,
  type GateRunJob,
  type GoldenSetEntry,
  MinimumVerdictOutputSchema,
  type RegressionRunResult,
  type Skill,
  type SkillVersion,
  type VerdictLabel,
  regressionDirectionCounts
} from "@coeval/shared";
import { evaluatorSuiteCriterionDigest } from "../lib/evaluator-suite.js";
import type { CreateSkillVersionContext } from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import {
  AmbiguousProjectSkillError,
  DatasetRevisionConflictError,
  GateRunBindingMismatchError,
  NoCurrentSkillError,
  OnboardingCheckConflictError,
  SkillVersionNotSignableError
} from "./errors.js";
import type { SkillLifecycleRepositoryPort } from "./ports.js";

// Keep this narrow alias local. The facade has the same private shape for its
// stable regression helper; moving it to barrel-exported contracts would widen
// the public repository type surface solely to share an implementation detail.
type BinaryJudgeProvider = Pick<JudgeProvider, "name" | "modelName" | "judge">;

interface DemoSkillLifecycleRepositoryDependencies {
  createSkillVersionPending(
    skillId: string,
    input: CreateSkillVersionInput,
    context: CreateSkillVersionContext
  ): Promise<SkillVersion>;
  getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null>;
  getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string | undefined,
    criterionVersionId?: string | undefined
  ): Promise<DatasetRevisionDetail>;
  previousVerdictsFromRun(run: RegressionRunResult | null | undefined): Map<string, VerdictLabel>;
  runRegressionGateForVersion(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }>;
  runGoldenSetRegression(input: {
    skillVersion: SkillVersion;
    goldenSet: GoldenSetEntry[];
    traces: Map<string, Trace>;
    overrideReason?: string | undefined;
    actorUserId?: string | undefined;
    judgeProvider?: BinaryJudgeProvider | undefined;
    previousVerdicts?: Map<string, VerdictLabel> | undefined;
  }): Promise<Omit<RegressionRunResult, "datasetRevisionId">>;
}

// Internal DemoRepository slice. It owns no state: the facade constructs it
// once with the exact shared store and narrow callbacks for cross-port work
// and preservation of the facade's existing polymorphic dispatch.
export class DemoSkillLifecycleRepository implements SkillLifecycleRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly judgeProvider: BinaryJudgeProvider,
    private readonly dependencies: DemoSkillLifecycleRepositoryDependencies
  ) {}

  async getCurrentSkill(projectId = demoProject.id): Promise<Skill> {
    const criteria = this.store.criteria.filter((criterion) => criterion.projectId === projectId);
    const criterionCount = criteria.length;
    if (criterionCount > 1) throw new AmbiguousProjectSkillError(projectId, criterionCount);
    const criterionId = criteria[0]?.id;
    if (!criterionId) throw new NoCurrentSkillError(projectId);
    return this.getSkillForCriterion(projectId, criterionId, "current");
  }

  async getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.getSkillForCriterion(projectId, criterionId, "current");
  }

  async authorizeSkillVersionExecution(_input: {
    projectId: string;
    skillVersionId: string;
    context: EvaluatorExecutionContext;
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }): Promise<void> {
    // Demo fixtures have no governed lifecycle store.
  }

  async getLatestSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.getSkillForCriterion(projectId, criterionId, "latest");
  }

  async getLatestSkill(projectId = demoProject.id): Promise<Skill> {
    const criteria = this.store.criteria.filter((criterion) => criterion.projectId === projectId);
    const criterionCount = criteria.length;
    if (criterionCount > 1) throw new AmbiguousProjectSkillError(projectId, criterionCount);
    const criterionId = criteria[0]?.id;
    if (!criterionId) throw new NoCurrentSkillError(projectId);
    return this.getSkillForCriterion(projectId, criterionId, "latest");
  }

  private getSkillForCriterion(
    projectId: string,
    criterionId: string,
    scope: "current" | "latest"
  ): Skill {
    const base = this.store.criterionSkills.get(criterionId);
    if (!base || base.projectId !== projectId) throw new NoCurrentSkillError(projectId);
    const versions = (this.store.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
      .filter((version) => version.skillId === base.id);
    const ranked = [...versions].sort((left, right) => {
      if (scope === "current") {
        const rank = (status: SkillVersion["status"]) =>
          status === "approved" || status === "production" ? 0
            : status === "regressing" || status === "failed" || status === "deprecated" ? 2
              : 1;
        const rankDiff = rank(left.status) - rank(right.status);
        if (rankDiff !== 0) return rankDiff;
      }
      return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
    });
    const selected = ranked[0];
    if (!selected) throw new NoCurrentSkillError(projectId);
    return structuredClone({ ...base, currentVersion: selected });
  }

  async getSkillVersion(projectId: string, skillVersionId: string): Promise<SkillVersion | null> {
    if (projectId !== demoProject.id) return null;
    return (this.store.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
      .find((version) => version.id === skillVersionId) ?? null;
  }

  async getCriterionVersionForSkillVersion(
    projectId: string,
    skillVersionId: string
  ): Promise<CriterionVersion | null> {
    const criterionVersionId = this.store.skillVersionCriteria.get(skillVersionId);
    if (!criterionVersionId) return null;
    return this.store.criterionVersions.find((candidate) =>
      candidate.projectId === projectId && candidate.id === criterionVersionId
    ) ?? null;
  }

  async signOffSkillVersion(
    _projectId: string,
    _skillId: string,
    versionId: string,
    _context: { actorUserId?: string | undefined }
  ): Promise<SkillVersion | null> {
    const versions = this.store.skillVersions ?? [demoSkill.currentVersion];
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) return null;
    if (version.status !== "draft" || version.approvedAt !== null) {
      throw new SkillVersionNotSignableError(versionId, version.status);
    }
    version.status = "approved";
    version.approvedAt = new Date().toISOString();
    demoSkill.isStarter = false;
    return version;
  }

  async createSkillVersion(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    const version = await this.dependencies.createSkillVersionPending(skillId, input, context);
    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(`Skill version ${version.id} has no immutable regression dataset binding.`);
    }
    return this.dependencies.runRegressionGateForVersion({
      projectId: demoProject.id,
      skillVersionId: version.id,
      datasetRevisionId,
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
      ...(context.actorUserId ? { actorUserId: context.actorUserId } : {}),
      timeScope: input.timeScope
    });
  }

  async createSkillVersionPending(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<SkillVersion> {
    const evaluatorBinding = [...this.store.criterionSkills.entries()].find(([, skill]) =>
      skill.projectId === demoProject.id && skill.id === skillId
    );
    if (!evaluatorBinding) throw new NoCurrentSkillError(demoProject.id);
    const [criterionId, evaluator] = evaluatorBinding;
    let criterionVersion: CriterionVersion | undefined;
    if (context.onboardingCriterion) {
      const requestKey = `${skillId}:${context.onboardingCriterion.idempotencyKey}`;
      const priorRequest = this.store.onboardingCheckRequests.get(requestKey);
      if (priorRequest) {
        if (priorRequest.requestDigest !== context.onboardingCriterion.requestDigest) {
          throw new OnboardingCheckConflictError(
            "idempotency_conflict",
            "This first-Check request key was already used with different proposal content."
          );
        }
        const priorVersion = (this.store.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
          .find((candidate) => candidate.id === priorRequest.versionId);
        if (!priorVersion) throw new Error(`Onboarding Check version not found: ${priorRequest.versionId}`);
        return priorVersion;
      }
      if (!evaluator.isStarter) {
        throw new OnboardingCheckConflictError(
          "project_already_configured",
          "This project's starter Check has already been configured."
        );
      }
      const criterion = this.store.criteria.find((candidate) =>
        candidate.projectId === demoProject.id && candidate.id === criterionId
      );
      if (!criterion || criterion.sourceKind !== "native") {
        throw new OnboardingCheckConflictError(
          "criterion_not_native",
          "Guided onboarding can configure only the project's native starter criterion."
        );
      }
      const prior = this.store.criterionVersions.filter((candidate) =>
        candidate.projectId === demoProject.id && candidate.criterionId === criterionId
      );
      const id = `criterionv_${randomUUID()}`;
      criterionVersion = {
        id,
        projectId: demoProject.id,
        criterionId,
        revision: Math.max(0, ...prior.map((entry) => entry.revision)) + 1,
        name: context.onboardingCriterion.name,
        definition: context.onboardingCriterion.definition,
        criterionDigest: evaluatorSuiteCriterionDigest({
          criterionId,
          criterionVersionId: id,
          criterionName: context.onboardingCriterion.name,
          criterionDefinition: context.onboardingCriterion.definition
        }),
        sourceKind: "native",
        createdByUserId: context.actorUserId ?? null,
        createdAt: new Date().toISOString()
      };
      this.store.criterionVersions.push(criterionVersion);
    } else {
      const definitionCount = this.store.criterionVersions.filter((candidate) =>
        candidate.projectId === demoProject.id && candidate.criterionId === criterionId
      ).length;
      if (!input.criterionVersionId && definitionCount > 1) {
        throw new DatasetRevisionConflictError(
          "Criteria with multiple immutable definitions require an explicit criterionVersionId when creating an evaluator version."
        );
      }
      criterionVersion = input.criterionVersionId
        ? this.store.criterionVersions.find((candidate) =>
            candidate.projectId === demoProject.id &&
            candidate.criterionId === criterionId &&
            candidate.id === input.criterionVersionId
          )
        : this.store.criterionVersions
            .filter((candidate) => candidate.projectId === demoProject.id && candidate.criterionId === criterionId)
            .sort((left, right) => right.revision - left.revision)[0];
    }
    if (!criterionVersion) {
      throw new DatasetRevisionConflictError(
        `Skill ${skillId} does not own criterion version ${input.criterionVersionId ?? "(latest)"}.`
      );
    }
    const createdAt = new Date().toISOString();
    const regressionRevision = await this.dependencies.getOrCreateRegressionDatasetRevision(
      demoProject.id,
      context.actorUserId,
      criterionVersion.id
    );
    const priorVersions = (this.store.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
      .filter((candidate) => candidate.skillId === skillId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const version: SkillVersion = {
      id: `skillv_${randomUUID()}`,
      skillId,
      criterionVersionId: criterionVersion.id,
      version: nextPatchVersion(priorVersions[0]?.version ?? evaluator.currentVersion.version),
      status: "calibrating",
      rubricMarkdown: input.rubricMarkdown,
      prompt: input.prompt,
      modelBinding: input.modelBinding,
      outputSchema: input.outputSchema ?? MinimumVerdictOutputSchema,
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: input.verdictKind,
      scalarRange: input.verdictKind === "scalar" ? input.scalarRange ?? null : null,
      categoricalChoiceScores: input.verdictKind === "categorical" ? input.categoricalChoiceScores ?? null : null,
      rubricProvenance: context.rubricProvenance ?? "human-authored",
      onboardingAssurance: context.onboardingCriterion || context.agentSetup
        ? "starter_unvalidated"
        : priorVersions.find((candidate) => candidate.onboardingAssurance)?.onboardingAssurance ?? null,
      regressionDatasetRevisionId: regressionRevision.id,
      createdAt,
      approvedAt: null
    };
    // persist so listSkillVersions renders the audit trail; the gate
    // step mutates this same object in place (demo is reference-shared).
    if (this.store.skillVersions === null) this.store.skillVersions = [structuredClone(demoSkill.currentVersion)];
    this.store.skillVersions.push(version);
    this.store.skillVersionCriteria.set(version.id, criterionVersion.id);
    if (context.onboardingCriterion) {
      this.store.onboardingCheckRequests.set(`${skillId}:${context.onboardingCriterion.idempotencyKey}`, {
        requestDigest: context.onboardingCriterion.requestDigest,
        versionId: version.id
      });
    }
    evaluator.isStarter = false;
    if (context.onboardingCriterion) {
      evaluator.name = context.onboardingCriterion.name;
      evaluator.description = context.onboardingCriterion.definition;
    } else if (context.agentSetup) {
      evaluator.name = context.agentSetup.skillName;
      evaluator.description = context.agentSetup.skillDescription;
    }
    return version;
  }

  async runRegressionGateForVersion(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    if (this.store.skillVersions === null) this.store.skillVersions = [structuredClone(demoSkill.currentVersion)];
    const version = this.store.skillVersions.find((candidate) => candidate.id === job.skillVersionId);
    if (!version) throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
    const criterionVersionId = this.store.skillVersionCriteria.get(version.id);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Evaluator version has no immutable criterion version binding");
    }
    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(
        `Skill version ${version.id} has no immutable regression dataset binding`,
      );
    }
    if (job.datasetRevisionId !== datasetRevisionId) {
      throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
    }
    const revision = await this.dependencies.getDatasetRevisionDetail(job.projectId, datasetRevisionId);
    if (!revision || revision.role !== "regression_golden") {
      throw new Error(`Pinned regression dataset revision is unavailable: ${datasetRevisionId}`);
    }

    // Prior-version comparison: the version immediately before the pending one.
    const priorVersionId = this.store.skillVersions
      .filter((candidate) =>
        candidate.skillId === version.skillId &&
        candidate.id !== version.id &&
        this.store.skillVersionCriteria.get(candidate.id) === criterionVersionId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]?.id;
    const previousVerdicts = this.dependencies.previousVerdictsFromRun(
      priorVersionId ? this.store.regressionRuns.get(priorVersionId) ?? null : null
    );

    const goldenSet: GoldenSetEntry[] = revision.items.map((item) => {
      if (!item.referenceLabel || !item.sourceCaseId) {
        throw new DatasetRevisionConflictError(
          `Regression revision item ${item.id} has no case identity or reference label`
        );
      }
      return {
        id: item.sourceGoldenEntryId ?? item.id,
        caseId: item.sourceCaseId,
        traceId: item.sourceTraceId ?? item.sourceCaseId,
        agreedLabel: item.referenceLabel,
        reason: item.note ?? "Frozen regression case.",
        promotedBy: "Frozen regression revision",
        promotedAt: item.createdAt,
        sourceSkillVersionId: version.id,
        criterionVersionId
      };
    });
    const traces = new Map(revision.items.map((item) => {
      if (!item.sourceCaseId) {
        throw new DatasetRevisionConflictError(`Regression revision item ${item.id} has no case identity`);
      }
      return [item.sourceCaseId, {
        id: item.sourceTraceId ?? item.sourceCaseId,
        input: item.payloadSnapshot.input,
        output: item.payloadSnapshot.output,
        metadata: item.payloadSnapshot.metadata,
        ...(item.payloadSnapshot.steps ? { steps: item.payloadSnapshot.steps } : {})
      } satisfies Trace] as const;
    }));
    const computedRegression = await this.dependencies.runGoldenSetRegression({
      skillVersion: version,
      goldenSet,
      traces,
      overrideReason: job.overrideReason,
      actorUserId: job.actorUserId,
      judgeProvider: this.judgeProvider,
      previousVerdicts
    });
    const regression: RegressionRunResult = { ...computedRegression, datasetRevisionId };

    version.status = regression.status === "blocked" ? "regressing" : "approved";
    version.goldenSetAgreement = regression.compared === 0 ? null : (regression.compared - regression.regressed) / regression.compared;
    const directions = regressionDirectionCounts(regression.cases);
    version.tooStrictCount = directions.tooStrict;
    version.tooLenientCount = directions.tooLenient;
    version.ambiguousCount = directions.ambiguous;
    version.knownLimitations = regression.regressed > 0 ? ["regressed on one or more golden-set cases"] : [];
    version.approvedAt = regression.status === "blocked" ? null : new Date().toISOString();
    this.store.regressionRuns.set(version.id, regression);
    this.store.datasetExposureEvents.push({
      id: `dse_${randomUUID()}`,
      projectId: job.projectId,
      revisionId: datasetRevisionId,
      revisionItemId: null,
      kind: "evaluator_execution",
      exposureClass: "development",
      activity: "regression_run",
      subjectKind: "evaluator_version",
      subjectId: version.id,
      actorUserId: job.actorUserId ?? null,
      evidenceRefKind: "regression_run",
      evidenceRefId: regression.id,
      reason: null,
      details: {},
      occurredAt: regression.createdAt
    });

    return { version, regressionRun: regression };
  }

  async failRegressionGateForVersion(job: GateRunJob, error: unknown): Promise<void> {
    if (this.store.skillVersions === null) this.store.skillVersions = [structuredClone(demoSkill.currentVersion)];
    const version = this.store.skillVersions.find((candidate) => candidate.id === job.skillVersionId);
    if (!version) throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
    // A replay after a successful or already-terminal gate must not overwrite
    // the recorded outcome or append another error run.
    if (version.status !== "calibrating") return;

    const message = gateFailureMessage(error);
    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(
        `Calibrating skill version ${version.id} has no immutable regression dataset binding.`,
      );
    }
    if (job.datasetRevisionId !== datasetRevisionId) {
      throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
    }
    version.status = "failed";
    version.goldenSetAgreement = null;
    version.tooStrictCount = 0;
    version.tooLenientCount = 0;
    version.ambiguousCount = 0;
    version.knownLimitations = [`regression gate failed: ${message}`];
    version.approvedAt = null;
    this.store.regressionRuns.set(version.id, {
      id: `reg_${randomUUID()}`,
      skillVersionId: version.id,
      datasetRevisionId,
      status: "error",
      compared: 0,
      regressed: 0,
      improved: 0,
      flipped: 0,
      error: message,
      goldenSetMissing: false,
      cases: [],
      createdAt: new Date().toISOString()
    });
  }

  async getRegressionRunForVersion(_projectId: string, skillVersionId: string): Promise<RegressionRunResult | null> {
    return this.store.regressionRuns.get(skillVersionId) ?? null;
  }

  async listRegressionRunsForVersions(_projectId: string, skillVersionIds: string[]): Promise<RegressionRunResult[]> {
    return skillVersionIds.flatMap((versionId) => {
      const run = this.store.regressionRuns.get(versionId);
      return run ? [run] : [];
    });
  }

  async listSkillVersions(_projectId: string, skillId: string, limit = 50): Promise<SkillVersion[]> {
    if (this.store.skillVersions === null) this.store.skillVersions = [structuredClone(demoSkill.currentVersion)];
    return [...this.store.skillVersions]
      .filter((version) => version.skillId === skillId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }
}

function gateFailureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function nextPatchVersion(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = version.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}
