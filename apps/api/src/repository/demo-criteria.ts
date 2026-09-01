import { randomUUID } from "node:crypto";
import { demoSkill, demoSkillPrevVersion } from "@coeval/db";
import type {
  Criterion,
  CriterionDetail,
  CriterionVersion,
  CreateCriterionInput,
  CreateCriterionVersionInput,
  CreatedCriterion,
  CreateEvaluatorSuiteManifestInput,
  EvaluatorSuite,
  EvaluatorSuiteManifest,
  Skill,
  SkillVersion
} from "@coeval/shared";
import {
  buildEvaluatorSuiteManifest,
  canonicalEvaluatorSuiteManifestBytes,
  evaluatorSuiteCreateRequestDigest,
  evaluatorSuiteCriterionDigest,
  parseCanonicalEvaluatorSuiteManifestBytes
} from "../lib/evaluator-suite.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import {
  CriterionStableKeyConflictError,
  EvaluatorSuiteBindingError,
  EvaluatorSuiteIdempotencyConflictError
} from "./errors.js";
import type { CriterionSuiteRepositoryPort } from "./ports.js";

// Internal DemoRepository slice. It owns no state: the facade constructs it
// once with the exact shared store used by every other demo domain.
export class DemoCriterionSuiteRepository implements CriterionSuiteRepositoryPort {
  constructor(private readonly store: DemoRepositoryStore) {}

  async listCriteria(projectId: string): Promise<Criterion[]> {
    return this.store.criteria
      .filter((criterion) => criterion.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((criterion) => structuredClone(criterion));
  }

  async getCriterion(projectId: string, criterionId: string): Promise<CriterionDetail | null> {
    const criterion = this.store.criteria.find((candidate) =>
      candidate.projectId === projectId && candidate.id === criterionId
    );
    if (!criterion) return null;
    return {
      criterion: structuredClone(criterion),
      versions: this.store.criterionVersions
        .filter((version) => version.projectId === projectId && version.criterionId === criterionId)
        .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id))
        .map((version) => structuredClone(version))
    };
  }

  async createCriterion(
    projectId: string,
    input: CreateCriterionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CreatedCriterion> {
    if (this.store.criteria.some((criterion) =>
      criterion.projectId === projectId && criterion.stableKey === input.stableKey
    )) {
      throw new CriterionStableKeyConflictError(input.stableKey);
    }
    const createdAt = new Date().toISOString();
    const criterion: Criterion = {
      id: `criterion_${randomUUID()}`,
      projectId,
      stableKey: input.stableKey,
      sourceKind: "native",
      createdByUserId: context.actorUserId ?? null,
      createdAt
    };
    const versionId = `criterionv_${randomUUID()}`;
    const version: CriterionVersion = {
      id: versionId,
      projectId,
      criterionId: criterion.id,
      revision: 1,
      name: input.name,
      definition: input.definition,
      criterionDigest: evaluatorSuiteCriterionDigest({
        criterionId: criterion.id,
        criterionVersionId: versionId,
        criterionName: input.name,
        criterionDefinition: input.definition
      }),
      sourceKind: "native",
      createdByUserId: context.actorUserId ?? null,
      createdAt
    };
    const skillVersion: SkillVersion = {
      id: `skillv_${randomUUID()}`,
      skillId: `skill_${randomUUID()}`,
      criterionVersionId: version.id,
      version: "0.1.0",
      status: "draft",
      rubricMarkdown: input.evaluator.rubricMarkdown,
      prompt: input.evaluator.prompt,
      modelBinding: input.evaluator.modelBinding,
      outputSchema: input.evaluator.outputSchema,
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: input.evaluator.verdictKind,
      scalarRange: input.evaluator.verdictKind === "scalar" ? input.evaluator.scalarRange ?? null : null,
      categoricalChoiceScores: input.evaluator.verdictKind === "categorical"
        ? input.evaluator.categoricalChoiceScores ?? null
        : null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: null,
      createdAt,
      approvedAt: null
    };
    const evaluator: Skill = {
      id: skillVersion.skillId,
      projectId,
      criterionId: criterion.id,
      name: input.name,
      description: input.definition,
      ownerName: context.actorUserId ?? "API key",
      status: "draft",
      isStarter: false,
      currentVersion: skillVersion
    };
    this.store.criteria.push(criterion);
    this.store.criterionVersions.push(version);
    if (this.store.skillVersions === null) this.store.skillVersions = [structuredClone(demoSkill.currentVersion)];
    this.store.skillVersions.push(skillVersion);
    this.store.skillVersionCriteria.set(skillVersion.id, version.id);
    this.store.criterionSkills.set(criterion.id, evaluator);
    return {
      criterion: structuredClone(criterion),
      versions: [structuredClone(version)],
      evaluator: structuredClone(evaluator)
    };
  }

  async createCriterionVersion(
    projectId: string,
    criterionId: string,
    input: CreateCriterionVersionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CriterionVersion | null> {
    if (!this.store.criteria.some((criterion) =>
      criterion.projectId === projectId && criterion.id === criterionId
    )) return null;
    const prior = this.store.criterionVersions.filter((version) =>
      version.projectId === projectId && version.criterionId === criterionId
    );
    const id = `criterionv_${randomUUID()}`;
    const version: CriterionVersion = {
      id,
      projectId,
      criterionId,
      revision: Math.max(0, ...prior.map((entry) => entry.revision)) + 1,
      name: input.name,
      definition: input.definition,
      criterionDigest: evaluatorSuiteCriterionDigest({
        criterionId,
        criterionVersionId: id,
        criterionName: input.name,
        criterionDefinition: input.definition
      }),
      sourceKind: "native",
      createdByUserId: context.actorUserId ?? null,
      createdAt: new Date().toISOString()
    };
    this.store.criterionVersions.push(version);
    return structuredClone(version);
  }

  async listEvaluatorSuites(projectId: string): Promise<EvaluatorSuite[]> {
    return this.store.evaluatorSuites
      .filter((suite) => suite.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((suite) => structuredClone(suite));
  }

  async getEvaluatorSuite(projectId: string, suiteId: string): Promise<EvaluatorSuite | null> {
    const suite = this.store.evaluatorSuites.find((candidate) =>
      candidate.projectId === projectId && candidate.id === suiteId
    );
    return suite ? structuredClone(suite) : null;
  }

  async createEvaluatorSuiteManifest(
    projectId: string,
    input: CreateEvaluatorSuiteManifestInput,
    context: { actorUserId?: string | undefined }
  ): Promise<EvaluatorSuiteManifest> {
    if (
      new Set(input.members.map((member) => member.criterionVersionId)).size !== input.members.length ||
      new Set(input.members.map((member) => member.skillVersionId)).size !== input.members.length
    ) {
      throw new EvaluatorSuiteBindingError("Evaluator suite members must bind distinct criteria and evaluator versions.");
    }
    const retried = this.store.evaluatorSuiteManifests.find((entry) =>
      entry.manifest.projectId === projectId && entry.idempotencyKey === input.idempotencyKey
    );
    if (retried) {
      if (retried.requestDigest !== evaluatorSuiteCreateRequestDigest(input)) {
        throw new EvaluatorSuiteIdempotencyConflictError(input.idempotencyKey);
      }
      return parseCanonicalEvaluatorSuiteManifestBytes(retried.canonicalBytes);
    }
    const existingSuite = input.suiteId
      ? this.store.evaluatorSuites.find((suite) => suite.projectId === projectId && suite.id === input.suiteId)
      : undefined;
    if (input.suiteId && !existingSuite) {
      throw new EvaluatorSuiteBindingError(`Evaluator suite not found in this project: ${input.suiteId}`);
    }
    const suiteId = existingSuite?.id ?? `suite_${randomUUID()}`;
    const memberInputs = input.members.map((binding, position) => {
      const criterionVersion = this.store.criterionVersions.find((version) =>
        version.projectId === projectId && version.id === binding.criterionVersionId
      );
      const skillVersion = (this.store.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
        .find((version) => version.id === binding.skillVersionId);
      if (!criterionVersion || !skillVersion || this.store.skillVersionCriteria.get(skillVersion.id) !== criterionVersion.id) {
        throw new EvaluatorSuiteBindingError(
          `Suite member ${position} must bind a criterion version to its exact evaluator version in this project.`
        );
      }
      return {
        criterionId: criterionVersion.criterionId,
        criterionVersionId: criterionVersion.id,
        criterionName: criterionVersion.name,
        criterionDefinition: criterionVersion.definition,
        skillVersion
      };
    });
    if (new Set(memberInputs.map((member) => member.criterionId)).size !== memberInputs.length) {
      throw new EvaluatorSuiteBindingError(
        "Evaluator suite members must bind distinct stable criteria, not multiple versions of one criterion."
      );
    }
    const priorRevisions = this.store.evaluatorSuiteManifests
      .filter((entry) => entry.manifest.projectId === projectId && entry.manifest.suiteId === suiteId)
      .map((entry) => entry.manifest.revision);
    const manifest = buildEvaluatorSuiteManifest({
      manifestId: `manifest_${randomUUID()}`,
      suiteId,
      projectId,
      revision: Math.max(0, ...priorRevisions) + 1,
      members: memberInputs,
      trialPlan: input.trialPlan
    });
    const canonicalBytes = canonicalEvaluatorSuiteManifestBytes(manifest);
    parseCanonicalEvaluatorSuiteManifestBytes(canonicalBytes);
    if (!existingSuite) {
      this.store.evaluatorSuites.push({
        id: suiteId,
        projectId,
        createdByUserId: context.actorUserId ?? null,
        createdAt: new Date().toISOString()
      });
    }
    this.store.evaluatorSuiteManifests.push({
      manifest,
      canonicalBytes,
      idempotencyKey: input.idempotencyKey,
      requestDigest: evaluatorSuiteCreateRequestDigest(input)
    });
    return structuredClone(manifest);
  }

  async listEvaluatorSuiteManifests(
    projectId: string,
    suiteId?: string | undefined
  ): Promise<EvaluatorSuiteManifest[]> {
    return this.store.evaluatorSuiteManifests
      .filter((entry) => entry.manifest.projectId === projectId && (!suiteId || entry.manifest.suiteId === suiteId))
      .sort((left, right) =>
        left.manifest.suiteId.localeCompare(right.manifest.suiteId) ||
        right.manifest.revision - left.manifest.revision ||
        right.manifest.manifestId.localeCompare(left.manifest.manifestId)
      )
      .map((entry) => parseCanonicalEvaluatorSuiteManifestBytes(entry.canonicalBytes));
  }

  async getEvaluatorSuiteManifest(
    projectId: string,
    manifestId: string
  ): Promise<EvaluatorSuiteManifest | null> {
    const entry = this.store.evaluatorSuiteManifests.find((candidate) =>
      candidate.manifest.projectId === projectId && candidate.manifest.manifestId === manifestId
    );
    return entry ? parseCanonicalEvaluatorSuiteManifestBytes(entry.canonicalBytes) : null;
  }
}
