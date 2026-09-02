import { randomUUID } from "node:crypto";
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
  SkillVersion
} from "@coeval/shared";
import type { Pool } from "pg";
import {
  buildEvaluatorSuiteManifest,
  canonicalEvaluatorSuiteManifestBytes,
  evaluatorSuiteArtifactDigest,
  evaluatorSuiteCreateRequestDigest,
  evaluatorSuiteCriterionDigest,
  parseCanonicalEvaluatorSuiteManifestBytes
} from "../lib/evaluator-suite.js";
import {
  CriterionStableKeyConflictError,
  EvaluatorSuiteBindingError,
  EvaluatorSuiteIdempotencyConflictError
} from "../repository/errors.js";
import type { CriterionSuiteRepositoryPort } from "../repository/ports.js";
import {
  isUniqueViolation,
  rowToCriterion,
  rowToCriterionVersion,
  rowToEvaluatorSuite,
  rowToSkillVersion
} from "./mappers.js";
import { insertSkillVersion } from "./skill-version-commands.js";

// Internal PostgreSQL criterion and policy-free evaluator-suite slice. The
// facade constructs it once with the exact application pool.
export class PgCriterionSuiteRepository implements CriterionSuiteRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async listCriteria(projectId: string): Promise<Criterion[]> {
    const result = await this.pool.query(
      `select * from criteria where project_id = $1 order by created_at asc, id asc`,
      [projectId]
    );
    return result.rows.map(rowToCriterion);
  }

  async getCriterion(projectId: string, criterionId: string): Promise<CriterionDetail | null> {
    const criterion = (await this.pool.query(
      `select * from criteria where project_id = $1 and id = $2`,
      [projectId, criterionId]
    )).rows[0];
    if (!criterion) return null;
    const versions = await this.pool.query(
      `select * from criterion_versions
       where project_id = $1 and criterion_id = $2
       order by revision desc, id desc`,
      [projectId, criterionId]
    );
    return {
      criterion: rowToCriterion(criterion),
      versions: versions.rows.map(rowToCriterionVersion)
    };
  }

  async createCriterion(
    projectId: string,
    input: CreateCriterionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CreatedCriterion> {
    const client = await this.pool.connect();
    const criterionId = `criterion_${randomUUID()}`;
    const criterionVersionId = `criterionv_${randomUUID()}`;
    const skillId = `skill_${randomUUID()}`;
    const skillVersionId = `skillv_${randomUUID()}`;
    const criterionDigest = evaluatorSuiteCriterionDigest({
      criterionId,
      criterionVersionId,
      criterionName: input.name,
      criterionDefinition: input.definition
    });
    try {
      await client.query("begin");
      const criterion = (await client.query(
        `insert into criteria
          (id, project_id, stable_key, source_kind, created_by_user_id)
         values ($1, $2, $3, 'native', $4)
         returning *`,
        [criterionId, projectId, input.stableKey, context.actorUserId ?? null]
      )).rows[0];
      const version = (await client.query(
        `insert into criterion_versions
          (id, project_id, criterion_id, revision, name, definition,
           criterion_digest, source_kind, created_by_user_id)
         values ($1, $2, $3, 1, $4, $5, $6, 'native', $7)
         returning *`,
        [
          criterionVersionId,
          projectId,
          criterionId,
          input.name,
          input.definition,
          criterionDigest,
          context.actorUserId ?? null
        ]
      )).rows[0];
      await client.query(
        `insert into skills
          (id, project_id, name, description, owner_user_id, status, is_starter, criterion_id)
         values ($1, $2, $3, $4, $5, 'draft', false, $6)`,
        [skillId, projectId, input.name, input.definition, context.actorUserId ?? null, criterionId]
      );
      const skillVersion: SkillVersion = {
        id: skillVersionId,
        skillId,
        criterionVersionId,
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
        createdAt: new Date().toISOString(),
        approvedAt: null
      };
      await insertSkillVersion(
        client,
        skillVersion,
        projectId,
        criterionVersionId,
        context.actorUserId ?? null
      );
      await client.query("commit");
      return {
        criterion: rowToCriterion(criterion),
        versions: [rowToCriterionVersion(version)],
        evaluator: {
          id: skillId,
          projectId,
          criterionId,
          name: input.name,
          description: input.definition,
          ownerName: context.actorUserId ?? "API key",
          status: "draft",
          isStarter: false,
          currentVersion: skillVersion
        }
      };
    } catch (error) {
      await client.query("rollback");
      if (isUniqueViolation(error)) throw new CriterionStableKeyConflictError(input.stableKey);
      throw error;
    } finally {
      client.release();
    }
  }

  async createCriterionVersion(
    projectId: string,
    criterionId: string,
    input: CreateCriterionVersionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CriterionVersion | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const criterion = await client.query(
        `select id from criteria where project_id = $1 and id = $2 for update`,
        [projectId, criterionId]
      );
      if (!criterion.rowCount) {
        await client.query("rollback");
        return null;
      }
      const revisionRow = (await client.query(
        `select coalesce(max(revision), 0)::int + 1 as revision
         from criterion_versions where project_id = $1 and criterion_id = $2`,
        [projectId, criterionId]
      )).rows[0];
      const revision = Number(revisionRow?.revision ?? 1);
      const id = `criterionv_${randomUUID()}`;
      const criterionDigest = evaluatorSuiteCriterionDigest({
        criterionId,
        criterionVersionId: id,
        criterionName: input.name,
        criterionDefinition: input.definition
      });
      const inserted = (await client.query(
        `insert into criterion_versions
          (id, project_id, criterion_id, revision, name, definition,
           criterion_digest, source_kind, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'native', $8)
         returning *`,
        [id, projectId, criterionId, revision, input.name, input.definition, criterionDigest, context.actorUserId ?? null]
      )).rows[0];
      await client.query("commit");
      return rowToCriterionVersion(inserted);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvaluatorSuites(projectId: string): Promise<EvaluatorSuite[]> {
    const result = await this.pool.query(
      `select * from evaluator_suites where project_id = $1 order by created_at desc, id desc`,
      [projectId]
    );
    return result.rows.map(rowToEvaluatorSuite);
  }

  async getEvaluatorSuite(projectId: string, suiteId: string): Promise<EvaluatorSuite | null> {
    const row = (await this.pool.query(
      `select * from evaluator_suites where project_id = $1 and id = $2`,
      [projectId, suiteId]
    )).rows[0];
    return row ? rowToEvaluatorSuite(row) : null;
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
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const project = await client.query(`select id from projects where id = $1 for update`, [projectId]);
      if (!project.rowCount) throw new Error(`Project not found: ${projectId}`);
      const priorAttempt = (await client.query(
        `select canonical_bytes, request_digest from evaluator_suite_manifests
         where project_id = $1 and idempotency_key = $2`,
        [projectId, input.idempotencyKey]
      )).rows[0];
      if (priorAttempt) {
        const existing = parseCanonicalEvaluatorSuiteManifestBytes(
          Buffer.from(priorAttempt.canonical_bytes as Uint8Array)
        );
        if (String(priorAttempt.request_digest) !== evaluatorSuiteCreateRequestDigest(input)) {
          throw new EvaluatorSuiteIdempotencyConflictError(input.idempotencyKey);
        }
        await client.query("commit");
        return existing;
      }
      let suiteId = input.suiteId;
      if (suiteId) {
        const suite = await client.query(
          `select id from evaluator_suites where project_id = $1 and id = $2 for update`,
          [projectId, suiteId]
        );
        if (!suite.rowCount) {
          throw new EvaluatorSuiteBindingError(`Evaluator suite not found in this project: ${suiteId}`);
        }
      } else {
        suiteId = `suite_${randomUUID()}`;
        await client.query(
          `insert into evaluator_suites (id, project_id, created_by_user_id) values ($1, $2, $3)`,
          [suiteId, projectId, context.actorUserId ?? null]
        );
      }

      const memberInputs = [];
      for (const [position, binding] of input.members.entries()) {
        const row = (await client.query(
          `select criterion_version.criterion_id,
                  criterion_version.id as bound_criterion_version_id,
                  criterion_version.name as criterion_name,
                  criterion_version.definition as criterion_definition,
                  skill_version.*
           from criterion_versions criterion_version
           join skills skill
             on skill.project_id = criterion_version.project_id
            and skill.criterion_id = criterion_version.criterion_id
           join skill_versions skill_version
             on skill_version.project_id = skill.project_id
            and skill_version.skill_id = skill.id
            and skill_version.criterion_version_id = criterion_version.id
           where criterion_version.project_id = $1
             and criterion_version.id = $2
             and skill_version.id = $3
             and evaluator_skill_version_context_allowed_v1($1,skill_version.id,'suite_publication')`,
          [projectId, binding.criterionVersionId, binding.skillVersionId]
        )).rows[0];
        if (!row) {
          throw new EvaluatorSuiteBindingError(
            `Suite member ${position} must bind a criterion version to its exact evaluator version in this project.`
          );
        }
        memberInputs.push({
          criterionId: String(row.criterion_id),
          criterionVersionId: String(row.bound_criterion_version_id),
          criterionName: String(row.criterion_name),
          criterionDefinition: String(row.criterion_definition),
          skillVersion: rowToSkillVersion(row)
        });
      }
      if (new Set(memberInputs.map((member) => member.criterionId)).size !== memberInputs.length) {
        throw new EvaluatorSuiteBindingError(
          "Evaluator suite members must bind distinct stable criteria, not multiple versions of one criterion."
        );
      }

      const revision = Number((await client.query(
        `select coalesce(max(revision), 0)::int + 1 as revision
         from evaluator_suite_manifests where project_id = $1 and suite_id = $2`,
        [projectId, suiteId]
      )).rows[0]?.revision ?? 1);
      const manifest = buildEvaluatorSuiteManifest({
        manifestId: `manifest_${randomUUID()}`,
        suiteId,
        projectId,
        revision,
        members: memberInputs,
        trialPlan: input.trialPlan
      });
      const canonicalBytes = canonicalEvaluatorSuiteManifestBytes(manifest);
      const artifactDigest = evaluatorSuiteArtifactDigest(canonicalBytes);
      await client.query(
        `insert into evaluator_suite_manifests
          (id, suite_id, project_id, revision, contract, schema_version, member_count,
           trial_plan, canonical_bytes, artifact_digest, manifest_digest, created_by_user_id,
           idempotency_key, request_digest)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          manifest.manifestId,
          manifest.suiteId,
          manifest.projectId,
          manifest.revision,
          manifest.contract,
          manifest.schemaVersion,
          manifest.members.length,
          JSON.stringify(manifest.trialPlan),
          canonicalBytes,
          artifactDigest,
          manifest.manifestDigest,
          context.actorUserId ?? null,
          input.idempotencyKey,
          evaluatorSuiteCreateRequestDigest(input)
        ]
      );
      for (const member of manifest.members) {
        await client.query(
          `insert into evaluator_suite_manifest_members
            (manifest_id, suite_id, project_id, position, criterion_id, criterion_version_id,
             criterion_name, criterion_definition, criterion_digest, skill_id, skill_version_id,
             skill_digest, output_contract_digest, applicability)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            manifest.manifestId,
            manifest.suiteId,
            manifest.projectId,
            member.position,
            member.criterionId,
            member.criterionVersionId,
            member.criterionName,
            member.criterionDefinition,
            member.criterionDigest,
            member.skillId,
            member.skillVersionId,
            member.skillDigest,
            member.outputContractDigest,
            JSON.stringify(member.applicability)
          ]
        );
      }
      await client.query("commit");
      return manifest;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvaluatorSuiteManifests(
    projectId: string,
    suiteId?: string | undefined
  ): Promise<EvaluatorSuiteManifest[]> {
    const result = await this.pool.query(
      `select canonical_bytes from evaluator_suite_manifests
       where project_id = $1 ${suiteId ? "and suite_id = $2" : ""}
       order by suite_id asc, revision desc, id desc`,
      suiteId ? [projectId, suiteId] : [projectId]
    );
    return result.rows.map((row) =>
      parseCanonicalEvaluatorSuiteManifestBytes(Buffer.from(row.canonical_bytes as Uint8Array))
    );
  }

  async getEvaluatorSuiteManifest(
    projectId: string,
    manifestId: string
  ): Promise<EvaluatorSuiteManifest | null> {
    const row = (await this.pool.query(
      `select canonical_bytes from evaluator_suite_manifests where project_id = $1 and id = $2`,
      [projectId, manifestId]
    )).rows[0];
    return row
      ? parseCanonicalEvaluatorSuiteManifestBytes(Buffer.from(row.canonical_bytes as Uint8Array))
      : null;
  }
}
