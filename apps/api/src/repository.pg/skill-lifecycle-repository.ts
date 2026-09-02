import { randomUUID } from "node:crypto";
import type { Trace } from "@coeval/audit/runtime";
import {
  MinimumVerdictOutputSchema,
  regressionDirectionCounts,
  type CriterionVersion,
  type EvaluatorExecutionContext,
  type GateRunJob,
  type GoldenSetEntry,
  type RegressionRunResult,
  type Skill,
  type SkillVersion,
  type CreateSkillVersionInput
} from "@coeval/shared";
import type { Pool } from "pg";
import { PgEvaluatorLifecycleRepository } from "../evaluator-lifecycle/repository.pg.js";
import { evaluatorSuiteCriterionDigest } from "../lib/evaluator-suite.js";
import type { JudgeProviderFactory } from "../lib/judge-provider.js";
import type { CreateSkillVersionContext } from "../repository.js";
import {
  AgentSetupEligibilityError,
  DatasetRevisionConflictError,
  GateRunBindingMismatchError,
  NoCurrentSkillError,
  OnboardingCheckConflictError,
  RegressionGateUnavailableError,
  SkillVersionNotSignableError
} from "../repository/errors.js";
import { previousVerdictsFromRun, runGoldenSetRegression } from "../repository/golden-helpers.js";
import type {
  DatasetRepositoryPort,
  JudgeCredentialRepositoryPort,
  SkillLifecycleRepositoryPort
} from "../repository/ports.js";
import { setJudgeProviderKeyOnClient } from "./credential-commands.js";
import { getOrCreateRegressionDatasetRevisionWithClient } from "./dataset-revision-commands.js";
import { insertRegressionRun } from "./regression-run-commands.js";
import { insertSkillVersion, nextVersion } from "./skill-version-commands.js";
import {
  gateFailureMessage,
  rowToCriterionVersion,
  rowToRegressionRun,
  rowToSkill,
  rowToSkillVersion
} from "./mappers.js";

export interface PgSkillLifecycleRepositoryDependencies {
  assertSingletonCriterion(projectId: string): Promise<void>;
  getDatasetRevisionDetail: DatasetRepositoryPort["getDatasetRevisionDetail"];
  getJudgeProviderCredential: JudgeCredentialRepositoryPort["getJudgeProviderCredential"];
}

// PostgreSQL evaluator-skill selection, immutable version authoring, and
// governed regression execution. Lifecycle evidence remains policy-free and
// cannot promote, block, deploy, or override a release.
export class PgSkillLifecycleRepository implements SkillLifecycleRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly judgeProviderFactory: JudgeProviderFactory,
    private readonly dependencies: PgSkillLifecycleRepositoryDependencies
  ) {}

  // "Current" = the version production traffic should be judged with: the
  // latest APPROVED version. A gate-blocked (`regressing`) version must never
  // be picked implicitly — it exists only as audit history until someone
  // overrides it into a new approved version. Drafts rank above blocked
  // versions only so a fresh project (whose seed version is still `draft`)
  // can judge at all before its first approval.
  async getCurrentSkill(projectId: string): Promise<Skill> {
    await this.dependencies.assertSingletonCriterion(projectId);
    return this.loadSkillByVersionOrder(
      projectId,
      `case
         when sv.status in ('approved', 'production') then 0
         when sv.status in ('regressing', 'failed', 'deprecated') then 2
         else 1
       end,
       sv.created_at desc,
       sv.id desc`,
      undefined,
      true
    );
  }

  async getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.loadSkillByVersionOrder(
      projectId,
      `case
         when sv.status in ('approved', 'production') then 0
         when sv.status in ('regressing', 'failed', 'deprecated') then 2
         else 1
       end,
       sv.created_at desc,
       sv.id desc`,
      criterionId,
      true
    );
  }

  async getLatestSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.loadSkillByVersionOrder(projectId, `sv.created_at desc, sv.id desc`, criterionId);
  }

  // "Latest" = the newest version regardless of status — the editing base and
  // the gate's comparison baseline. Where getCurrentSkill answers "what judges
  // production traffic", this answers "what was the last attempt": a
  // gate-blocked draft must stay loadable here, or its author loses the edit
  // as a starting point the moment the editor reloads.
  async getLatestSkill(projectId: string): Promise<Skill> {
    await this.dependencies.assertSingletonCriterion(projectId);
    return this.loadSkillByVersionOrder(projectId, `sv.created_at desc, sv.id desc`);
  }

  async getSkillVersion(projectId: string, skillVersionId: string): Promise<SkillVersion | null> {
    const result = await this.pool.query(
      `select version.*,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else version.status
              end as status
       from skill_versions version
       left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
       left join lateral evaluator_lifecycle_head_v1(lifecycle.id) lifecycle_head on true
       where version.id = $1 and version.project_id = $2`,
      [skillVersionId, projectId]
    );
    return result.rows[0] ? rowToSkillVersion(result.rows[0]) : null;
  }

  async getCriterionVersionForSkillVersion(
    projectId: string,
    skillVersionId: string
  ): Promise<CriterionVersion | null> {
    const row = (await this.pool.query(
      `select criterion.*
       from skill_versions evaluator
       join criterion_versions criterion
         on criterion.id = evaluator.criterion_version_id
        and criterion.project_id = evaluator.project_id
       where evaluator.project_id = $1 and evaluator.id = $2`,
      [projectId, skillVersionId]
    )).rows[0];
    return row ? rowToCriterionVersion(row) : null;
  }

  private async loadSkillByVersionOrder(
    projectId: string,
    versionOrderBy: string,
    criterionId?: string | undefined,
    requireImplicitEligibility = false
  ): Promise<Skill> {
    const result = await this.pool.query(
      `select s.*,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else s.status
              end as status,
              sv.id as version_id,
              sv.version,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else sv.status
              end as version_status,
              sv.rubric_markdown,
              sv.prompt,
              sv.model_binding,
              sv.output_schema,
              sv.golden_set_agreement,
              sv.too_strict_count,
              sv.too_lenient_count,
              sv.ambiguous_count,
              sv.known_limitations,
              sv.verdict_kind,
              sv.scalar_range,
              sv.categorical_choice_scores,
              sv.rubric_provenance,
              sv.onboarding_assurance,
              sv.regression_dataset_revision_id,
              sv.criterion_version_id as version_criterion_version_id,
              sv.created_at as version_created_at,
              sv.approved_at,
              u.name as owner_name,
              u.email as owner_email
       from skills s
       join skill_versions sv on sv.skill_id = s.id
       left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=sv.id
       left join lateral evaluator_lifecycle_head_v1(lifecycle.id) lifecycle_head on true
       left join "user" u on u.id = s.owner_user_id
       where s.project_id = $1
         ${criterionId ? "and s.criterion_id = $2" : ""}
         ${requireImplicitEligibility
           ? "and evaluator_skill_version_context_allowed_v1(s.project_id,sv.id,'implicit_production')"
           : ""}
       order by ${versionOrderBy}
       limit 1`,
      criterionId ? [projectId, criterionId] : [projectId]
    );
    const row = result.rows[0];
    if (!row) throw new NoCurrentSkillError(projectId);
    return rowToSkill(row);
  }

  async authorizeSkillVersionExecution(input: {
    projectId: string;
    skillVersionId: string;
    context: EvaluatorExecutionContext;
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }): Promise<void> {
    await new PgEvaluatorLifecycleRepository(this.pool).authorizeExecution(input);
  }

  async signOffSkillVersion(
    projectId: string,
    skillId: string,
    versionId: string,
    context: { actorUserId?: string | undefined }
  ): Promise<SkillVersion | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Serialize starter sign-off with agent bootstrap and normal version
      // creation. Whichever locks the project/skill first becomes the first
      // real configuration; the later operation observes is_starter=false.
      const locked = await client.query(
        `select sv.status, sv.approved_at
         from skills s
         join projects p on p.id = s.project_id
         join skill_versions sv on sv.skill_id = s.id
         where s.id = $1 and s.project_id = $2 and sv.id = $3
         for update of s, p, sv`,
        [skillId, projectId, versionId]
      );
      if (!locked.rows[0]) {
        await client.query("rollback");
        return null;
      }
      if (locked.rows[0].status !== "draft" || locked.rows[0].approved_at !== null) {
        throw new SkillVersionNotSignableError(versionId, String(locked.rows[0].status));
      }
      const updated = await client.query(
        `update skill_versions
         set status = 'approved', approved_at = now()
         where id = $1 and project_id = $2 and status = 'draft' and approved_at is null
         returning *`,
        [versionId, projectId]
      );
      if (!updated.rows[0]) {
        // Lost a race with a concurrent sign-off or edit — surface as not-signable.
        await client.query("rollback");
        throw new SkillVersionNotSignableError(versionId, "concurrently changed");
      }
      await client.query(`update skills set is_starter = false where id = $1 and project_id = $2`, [skillId, projectId]);
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          projectId,
          context.actorUserId ?? null,
          "skill_version.signoff",
          "skill_version",
          versionId,
          JSON.stringify({ signedOffAsIs: true })
        ]
      );
      await client.query("commit");
      return rowToSkillVersion(updated.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // Sync path (demo / no-queue): pending insert + inline gate. The queue path
  // calls the two halves separately (route inserts pending + enqueues gate.run;
  // the worker runs the gate) — M0 C5a.
  async createSkillVersion(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    const version = await this.createSkillVersionPending(skillId, input, context);
    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(`Skill version ${version.id} has no immutable regression dataset binding.`);
    }
    return this.runRegressionGateForVersion({
      projectId: context.projectId,
      skillVersionId: version.id,
      datasetRevisionId,
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
      ...(context.actorUserId ? { actorUserId: context.actorUserId } : {}),
      timeScope: input.timeScope
    });
  }

  // Inserts the version in `calibrating` with no regression run. The strict
  // provider refusal runs HERE so a 503 never leaves a pending row behind.
  async createSkillVersionPending(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<SkillVersion> {
    const submitProvider = input.modelBinding.provider;
    const suppliedCredential = context.agentSetup?.providerCredential;
    const submitKey = suppliedCredential && suppliedCredential.provider === submitProvider
      ? suppliedCredential.apiKey
      : submitProvider && submitProvider !== "mock"
        ? await this.dependencies.getJudgeProviderCredential(context.projectId, submitProvider)
        : null;
    const judgeProvider = this.judgeProviderFactory(input.modelBinding, submitKey ? { apiKey: submitKey } : undefined);
    if (submitProvider !== "mock" && judgeProvider.name === "mock") {
      throw new RegressionGateUnavailableError(input.modelBinding.provider);
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // The project and skill rows are the shared serialization point for
      // human edits, sign-off, imports (which update the project counter), and
      // paired bootstrap. This closes the check-then-create race.
      const locked = await client.query(
        `select s.is_starter, s.criterion_id, p.imported_trace_count
         from skills s
         join projects p on p.id = s.project_id
         where s.id = $1 and s.project_id = $2
         for update of s, p`,
        [skillId, context.projectId]
      );
      if (!locked.rows[0]) throw new Error(`Skill not found for project: ${skillId}`);

      if (context.onboardingCriterion) {
        const replay = (await client.query(
          `select id, onboarding_request_digest
           from skill_versions
           where project_id = $1 and skill_id = $2 and onboarding_idempotency_key = $3`,
          [context.projectId, skillId, context.onboardingCriterion.idempotencyKey]
        )).rows[0];
        if (replay) {
          if (String(replay.onboarding_request_digest) !== context.onboardingCriterion.requestDigest) {
            throw new OnboardingCheckConflictError(
              "idempotency_conflict",
              "This first-Check request key was already used with different proposal content."
            );
          }
          await client.query("commit");
          const existing = await this.getSkillVersion(context.projectId, String(replay.id));
          if (!existing) throw new Error(`Onboarding Check version not found: ${String(replay.id)}`);
          return existing;
        }
      }

      if (context.agentSetup?.pairingId) {
        const pairing = await client.query(
          `select id
           from agent_setup_pairings
           where id = $1 and project_id = $2
             and claimed_at is not null and consumed_at is null and revoked_at is null
           for update`,
          [context.agentSetup.pairingId, context.projectId]
        );
        if (!pairing.rowCount) {
          throw new AgentSetupEligibilityError("pairing_no_longer_active", "This setup connection is no longer active.");
        }
        if (!locked.rows[0].is_starter) {
          throw new AgentSetupEligibilityError(
            "project_already_configured",
            "This project's judging skill was configured while the connection was outstanding."
          );
        }
        if (Number(locked.rows[0].imported_trace_count ?? 0) > 0) {
          throw new AgentSetupEligibilityError(
            "project_not_empty",
            "The paired project already has imported cases. Finish setup in the app instead."
          );
        }
      }

      // Bind the evaluator to an immutable regression corpus before it is
      // persisted or queued. Golden-set edits after this point may advance
      // the criterion pointer, but can never change this version's gate input.
      const lockedCriterion = await client.query(
        `select id, source_kind from criteria where project_id = $1 and id = $2 for update`,
        [context.projectId, String(locked.rows[0].criterion_id)]
      );
      if (!lockedCriterion.rows[0]) {
        throw new DatasetRevisionConflictError(`Skill ${skillId} has no criterion.`);
      }

      let criterionVersionId: string;
      if (context.onboardingCriterion) {
        if (!locked.rows[0].is_starter) {
          throw new OnboardingCheckConflictError(
            "project_already_configured",
            "This project's starter Check has already been configured."
          );
        }
        if (String(lockedCriterion.rows[0].source_kind) !== "native") {
          throw new OnboardingCheckConflictError(
            "criterion_not_native",
            "Guided onboarding can configure only the project's native starter criterion."
          );
        }
        if (input.criterionVersionId) {
          throw new DatasetRevisionConflictError(
            "Guided onboarding creates and binds its own criterion version."
          );
        }
        const criterionId = String(locked.rows[0].criterion_id);
        const revision = Number((await client.query(
          `select coalesce(max(revision), 0)::int + 1 as revision
           from criterion_versions where project_id = $1 and criterion_id = $2`,
          [context.projectId, criterionId]
        )).rows[0]?.revision ?? 1);
        criterionVersionId = `criterionv_${randomUUID()}`;
        const criterionDigest = evaluatorSuiteCriterionDigest({
          criterionId,
          criterionVersionId,
          criterionName: context.onboardingCriterion.name,
          criterionDefinition: context.onboardingCriterion.definition
        });
        await client.query(
          `insert into criterion_versions
            (id, project_id, criterion_id, revision, name, definition,
             criterion_digest, source_kind, created_by_user_id)
           values ($1, $2, $3, $4, $5, $6, $7, 'native', $8)`,
          [
            criterionVersionId,
            context.projectId,
            criterionId,
            revision,
            context.onboardingCriterion.name,
            context.onboardingCriterion.definition,
            criterionDigest,
            context.actorUserId ?? null
          ]
        );
      } else {
        if (!input.criterionVersionId) {
          const definitionCount = Number((await client.query(
            `select count(*)::int as count
             from criterion_versions
             where project_id = $1 and criterion_id = $2`,
            [context.projectId, String(locked.rows[0].criterion_id)]
          )).rows[0]?.count ?? 0);
          if (definitionCount > 1) {
            throw new DatasetRevisionConflictError(
              "Criteria with multiple immutable definitions require an explicit criterionVersionId when creating an evaluator version."
            );
          }
        }
        const criterionVersion = (await client.query(
          `select id from criterion_versions
           where project_id = $1 and criterion_id = $2
             and ($3::text is null or id = $3)
           order by revision desc, id desc
           limit 1`,
          [context.projectId, String(locked.rows[0].criterion_id), input.criterionVersionId ?? null]
        )).rows[0];
        if (!criterionVersion) {
          throw new DatasetRevisionConflictError(
            `Skill ${skillId} does not own criterion version ${input.criterionVersionId ?? "(latest)"}.`
          );
        }
        criterionVersionId = String(criterionVersion.id);
      }
      const regressionDatasetRevisionId = await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        context.projectId,
        criterionVersionId,
        context.actorUserId
      );

      const version: SkillVersion = {
        id: `skillv_${randomUUID()}`,
        skillId,
        criterionVersionId,
        version: await nextVersion(client, skillId),
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
          : (await client.query(
              `select onboarding_assurance
               from skill_versions
               where project_id = $1 and skill_id = $2 and onboarding_assurance is not null
               order by created_at desc, id desc limit 1`,
              [context.projectId, skillId]
            )).rows[0]?.onboarding_assurance ?? null,
        regressionDatasetRevisionId,
        createdAt: new Date().toISOString(),
        approvedAt: null
      };

      if (context.agentSetup?.providerCredential) {
        const credential = context.agentSetup.providerCredential;
        await setJudgeProviderKeyOnClient(
          client,
          context.projectId,
          credential.provider,
          credential.apiKey,
          context.actorUserId
        );
      }
      await insertSkillVersion(
        client,
        version,
        context.projectId,
        criterionVersionId,
        context.actorUserId ?? null,
        context.onboardingCriterion
          ? {
              idempotencyKey: context.onboardingCriterion.idempotencyKey,
              requestDigest: context.onboardingCriterion.requestDigest
            }
          : undefined
      );
      await client.query(
        `update skills
         set is_starter = false,
             name = coalesce($3, name),
             description = coalesce($4, description)
         where id = $1 and project_id = $2`,
        [
          skillId,
          context.projectId,
          context.onboardingCriterion?.name ?? context.agentSetup?.skillName ?? null,
          context.onboardingCriterion?.definition ?? context.agentSetup?.skillDescription ?? null
        ]
      );
      if (context.agentSetup?.pairingId) {
        const consumed = await client.query(
          `update agent_setup_pairings
           set consumed_at = now(), claimed_at = null
           where id = $1 and project_id = $2
             and consumed_at is null and revoked_at is null and claimed_at is not null`,
          [context.agentSetup.pairingId, context.projectId]
        );
        if (!consumed.rowCount) {
          throw new AgentSetupEligibilityError("pairing_no_longer_active", "This setup connection is no longer active.");
        }
      }
      await client.query("commit");
      return version;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // Executes the golden-set regression gate for a pending version and persists
  // the outcome (status transition + regression run + override audit) in one
  // transaction. Called by the gate.run worker (async path) and by
  // createSkillVersion (sync path).
  async runRegressionGateForVersion(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    // Queue delivery is at-least-once. Keep one provider execution in flight
    // for an exact candidate/version even when two deliveries overlap, then
    // let the loser replay the immutable terminal regression row.
    const lockClient = await this.pool.connect();
    try {
      await lockClient.query(
        `select pg_advisory_lock(hashtextextended($1, 0))`,
        [`candidate-regression:${job.projectId}:${job.skillVersionId}`]
      );
      return await this.runRegressionGateForVersionLocked(job);
    } finally {
      await lockClient.query(
        `select pg_advisory_unlock(hashtextextended($1, 0))`,
        [`candidate-regression:${job.projectId}:${job.skillVersionId}`]
      ).catch(() => undefined);
      lockClient.release();
    }
  }

  private async runRegressionGateForVersionLocked(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    const version = await this.getSkillVersion(job.projectId, job.skillVersionId);
    if (!version) throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
    const criterionVersionId = String((await this.pool.query(
      `select criterion_version_id from skill_versions where project_id = $1 and id = $2`,
      [job.projectId, job.skillVersionId]
    )).rows[0]?.criterion_version_id ?? "");
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError(`Skill version ${job.skillVersionId} has no criterion binding.`);
    }

    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(
        `Skill version ${version.id} has no immutable regression dataset binding.`,
      );
    }
    if (job.datasetRevisionId !== datasetRevisionId) {
      throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
    }
    const existingRun = await this.getRegressionRunForVersion(job.projectId, version.id);
    if (existingRun) {
      if (existingRun.datasetRevisionId !== datasetRevisionId) {
        throw new DatasetRevisionConflictError(
          `Existing regression evidence for ${version.id} does not match its pinned revision.`
        );
      }
      return { version, regressionRun: existingRun };
    }
    await this.authorizeSkillVersionExecution({
      projectId: job.projectId,
      skillVersionId: version.id,
      context: "candidate_regression_evidence",
      resourceKind: "regression_revision",
      resourceId: datasetRevisionId,
      idempotencyKey: `provider-start:candidate-regression:${version.id}:${datasetRevisionId}`
    });
    const revision = await this.dependencies.getDatasetRevisionDetail(job.projectId, datasetRevisionId);
    if (!revision || revision.role !== "regression_golden") {
      throw new Error(`Pinned regression dataset revision is unavailable: ${datasetRevisionId}`);
    }
    const goldenSet: GoldenSetEntry[] = revision.items.map((item) => {
      if (!item.referenceLabel) {
        throw new DatasetRevisionConflictError(
          `Regression revision item ${item.id} has no reference label`
        );
      }
      const caseId = item.sourceCaseId ?? item.id;
      return {
        id: item.sourceGoldenEntryId ?? item.id,
        caseId,
        traceId: item.sourceTraceId ?? caseId,
        agreedLabel: item.referenceLabel,
        reason: item.note ?? "Frozen regression case.",
        promotedBy: "Frozen regression revision",
        promotedAt: item.createdAt,
        sourceSkillVersionId: version.id,
        criterionVersionId
      };
    });
    const traces = new Map(revision.items.map((item) => {
      const caseId = item.sourceCaseId ?? item.id;
      return [caseId, {
        id: item.sourceTraceId ?? caseId,
        input: item.payloadSnapshot.input,
        output: item.payloadSnapshot.output,
        metadata: item.payloadSnapshot.metadata,
        ...(item.payloadSnapshot.steps ? { steps: item.payloadSnapshot.steps } : {})
      } satisfies Trace] as const;
    }));
    // prior-version comparison — the most recent version EXCLUDING the
    // pending one under gate (which is already inserted by now).
    const priorVersionId = await this.latestVersionId(
      version.skillId,
      criterionVersionId,
      version.id
    );
    const priorRun = priorVersionId
      ? await this.getRegressionRunForVersion(job.projectId, priorVersionId)
      : null;
    // The gate must re-judge with the provider the version actually pins —
    // never the mock fallback (see createSkillVersionPending, which refuses at
    // submit time; this re-check covers env changes between enqueue and run).
    const gateProvider = version.modelBinding.provider;
    const gateKey = gateProvider !== "mock"
      ? await this.dependencies.getJudgeProviderCredential(job.projectId, gateProvider)
      : null;
    const judgeProvider = this.judgeProviderFactory(version.modelBinding, gateKey ? { apiKey: gateKey } : undefined);
    if (gateProvider !== "mock" && judgeProvider.name === "mock") {
      throw new RegressionGateUnavailableError(version.modelBinding.provider);
    }
    const computedRegressionRun = await runGoldenSetRegression({
      skillVersion: version,
      goldenSet,
      traces,
      overrideReason: job.overrideReason,
      actorUserId: job.actorUserId,
      judgeProvider,
      previousVerdicts: previousVerdictsFromRun(priorRun)
    });
    const regressionRun: RegressionRunResult = {
      ...computedRegressionRun,
      datasetRevisionId
    };

    version.status = regressionRun.status === "blocked" ? "regressing" : "approved";
    version.goldenSetAgreement = regressionRun.compared === 0 ? null : (regressionRun.compared - regressionRun.regressed) / regressionRun.compared;
    const directions = regressionDirectionCounts(regressionRun.cases);
    version.tooStrictCount = directions.tooStrict;
    version.tooLenientCount = directions.tooLenient;
    version.ambiguousCount = directions.ambiguous;
    version.knownLimitations = regressionRun.goldenSetMissing
      ? ["no golden-set cases are available; regression gate is advisory only"]
      : regressionRun.regressed > 0
        ? ["regressed on one or more golden-set cases"]
        : [];
    version.approvedAt = regressionRun.status === "blocked" ? null : new Date().toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update skill_versions
         set status = $3, golden_set_agreement = $4, too_strict_count = $5,
             too_lenient_count = $6, ambiguous_count = $7, known_limitations = $8,
             approved_at = $9
         where id = $1 and project_id = $2`,
        [
          version.id,
          job.projectId,
          version.status,
          version.goldenSetAgreement,
          version.tooStrictCount,
          version.tooLenientCount,
          version.ambiguousCount,
          version.knownLimitations,
          version.approvedAt
        ]
      );
      await insertRegressionRun(client, regressionRun, { projectId: job.projectId, actorUserId: job.actorUserId });
      await client.query(
        `insert into dataset_exposure_events
         (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
          subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
         values ($1,$2,$3,'evaluator_execution','development','regression_run','evaluator_version',
                 $4,$5,'regression_run',$6,null,'{}'::jsonb,$7)
         on conflict (project_id, idempotency_key) do nothing`,
        [
          `dse_${randomUUID()}`,
          job.projectId,
          datasetRevisionId,
          version.id,
          job.actorUserId ?? null,
          regressionRun.id,
          `regression-run:${regressionRun.id}`
        ]
      );
      if (regressionRun.overrideReason) {
        await client.query(
          `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            `audit_${randomUUID()}`,
            job.projectId,
            job.actorUserId ?? null,
            "skill_version.override",
            "skill_version",
            version.id,
            JSON.stringify({ overrideReason: regressionRun.overrideReason })
          ]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    return { version, regressionRun };
  }

  async failRegressionGateForVersion(job: GateRunJob, error: unknown): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query(
        `select status, regression_dataset_revision_id from skill_versions
         where id = $1 and project_id = $2
         for update`,
        [job.skillVersionId, job.projectId]
      );
      if (!locked.rows[0]) {
        throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
      }
      // Idempotency: a late/replayed finalizer cannot replace a successful,
      // blocked, overridden, or already-failed outcome.
      if (String(locked.rows[0].status) !== "calibrating") {
        await client.query("commit");
        return;
      }

      const message = gateFailureMessage(error);
      const rawDatasetRevisionId = locked.rows[0].regression_dataset_revision_id;
      if (rawDatasetRevisionId === null || rawDatasetRevisionId === undefined) {
        throw new DatasetRevisionConflictError(
          `Calibrating skill version ${job.skillVersionId} has no immutable regression dataset binding.`,
        );
      }
      const datasetRevisionId = String(rawDatasetRevisionId);
      if (job.datasetRevisionId !== datasetRevisionId) {
        throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
      }
      const regressionRunId = `reg_${randomUUID()}`;
      await client.query(
        `update skill_versions
         set status = 'failed', golden_set_agreement = null,
             too_strict_count = 0, too_lenient_count = 0, ambiguous_count = 0,
             known_limitations = $3, approved_at = null
         where id = $1 and project_id = $2`,
        [job.skillVersionId, job.projectId, [`regression gate failed: ${message}`]]
      );
      await insertRegressionRun(client, {
        id: regressionRunId,
        skillVersionId: job.skillVersionId,
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
      }, { projectId: job.projectId, actorUserId: job.actorUserId });
      await client.query(
          `insert into dataset_exposure_events
           (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
            subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
           values ($1,$2,$3,'evaluator_execution','development','regression_run','evaluator_version',
                   $4,$5,'regression_run',$6,$7,'{}'::jsonb,$8)
           on conflict (project_id, idempotency_key) do nothing`,
          [
            `dse_${randomUUID()}`,
            job.projectId,
            datasetRevisionId,
            job.skillVersionId,
            job.actorUserId ?? null,
            regressionRunId,
            message,
            `regression-run:${regressionRunId}`
          ]
        );
      await client.query("commit");
    } catch (failure) {
      await client.query("rollback").catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  }

  async listSkillVersions(projectId: string, skillId: string, limit = 50): Promise<SkillVersion[]> {
    const result = await this.pool.query(
      `select version.*,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else version.status
              end as status
       from skill_versions version
       left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
       left join lateral evaluator_lifecycle_head_v1(lifecycle.id) lifecycle_head on true
       where version.project_id = $1 and version.skill_id = $2
       order by version.created_at desc
       limit $3`,
      [projectId, skillId, limit]
    );
    return result.rows.map(rowToSkillVersion);
  }

  async listRegressionRunsForVersions(projectId: string, skillVersionIds: string[]): Promise<RegressionRunResult[]> {
    if (skillVersionIds.length === 0) return [];
    const result = await this.pool.query(
      `select distinct on (skill_version_id) *
       from regression_runs
       where project_id = $1 and skill_version_id = any($2::text[])
       order by skill_version_id, created_at desc`,
      [projectId, skillVersionIds]
    );
    return result.rows.map(rowToRegressionRun);
  }

  async getRegressionRunForVersion(projectId: string, skillVersionId: string): Promise<RegressionRunResult | null> {
    const result = await this.pool.query(
      `select * from regression_runs
       where project_id = $1 and skill_version_id = $2
       order by created_at desc
       limit 1`,
      [projectId, skillVersionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return rowToRegressionRun(row);
  }

  // the most recent existing version's id (before the new insert), for
  // prior-version comparison. Null when this is the skill's first version.
  // Deliberately status-blind: the baseline is the previous ATTEMPT, blocked
  // or not — the same version the editor seeds from (getLatestSkill). The
  // gate's "improved/flipped" answers "did this edit fix what the last
  // attempt got wrong", not "is this better than production".
  private async latestVersionId(
    skillId: string,
    criterionVersionId: string,
    excludeVersionId?: string
  ): Promise<string | null> {
    // excludeVersionId: the pending version under gate is already inserted —
    // prior-version comparison must skip it (M0 C5a).
    const result = await this.pool.query(
      `select id from skill_versions
       where skill_id = $1 and criterion_version_id = $2
         and ($3::text is null or id <> $3)
       order by created_at desc, id desc
       limit 1`,
      [skillId, criterionVersionId, excludeVersionId ?? null]
    );
    return result.rows[0]?.id ? String(result.rows[0].id) : null;
  }
}
