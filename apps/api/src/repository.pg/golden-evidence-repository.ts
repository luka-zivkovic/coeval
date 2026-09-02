import { randomUUID } from "node:crypto";
import type { Trace } from "@coeval/audit/runtime";
import {
  effectiveHumanLabel,
  type ExceptionDetail,
  type GoldenSetEntry,
  type GoldenSetHealthSummary,
  type SkillFormatExample,
  type VerdictRecord
} from "@coeval/shared";
import type { Pool } from "pg";
import { redactNormalizedTracePayload, type NormalizedTraceStep } from "../lib/redaction.js";
import type {
  PromoteExceptionToGoldenSetInput,
  RetireGoldenSetEntryInput
} from "../repository.js";
import {
  CaseNotFoundError,
  DatasetRevisionConflictError,
  GoldenSetEntryAlreadyRetiredError,
  GoldenSetEntryNotFoundError,
  GoldenSetLabelConflictError
} from "../repository/errors.js";
import { buildGoldenSetHealthSummary } from "../repository/golden-helpers.js";
import type { GoldenEvidenceRepositoryPort } from "../repository/ports.js";
import { getOrCreateRegressionDatasetRevisionWithClient } from "./dataset-revision-commands.js";
import { loadGoldenSetRetirementContext } from "./golden-commands.js";
import {
  parseJson,
  rowToExceptionCase,
  rowToGoldenSetEntry,
  rowToJudgeRun,
  rowToVerdictRecord
} from "./mappers.js";

export interface PgGoldenEvidenceRepositoryDependencies {
  assertSingletonCriterion(projectId: string): Promise<void>;
  resolveGoldenCriterionVersion(projectId: string, requested?: string | undefined): Promise<string>;
}

// PostgreSQL golden-evidence registry, portable examples, health, and case
// detail projection. Promotion and retirement preserve their existing atomic
// evidence boundaries; this governed curation slice owns no release decision.
export class PgGoldenEvidenceRepository implements GoldenEvidenceRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly dependencies: PgGoldenEvidenceRepositoryDependencies
  ) {}

  async listGoldenSet(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetEntry[]> {
    const resolvedCriterionVersionId = await this.dependencies.resolveGoldenCriterionVersion(
      projectId,
      criterionVersionId
    );
    const result = await this.pool.query(
      `select * from golden_set_entries
       where project_id = $1 and criterion_version_id = $2 and retired_at is null
       order by promoted_at desc`,
      [projectId, resolvedCriterionVersionId]
    );
    return result.rows.map(rowToGoldenSetEntry);
  }

  async getSkillFormatExamples(
    projectId: string,
    cap: number,
    criterionVersionId?: string | undefined
  ): Promise<SkillFormatExample[]> {
    const golden = (await this.listGoldenSet(projectId, criterionVersionId)).slice(0, cap);
    if (golden.length === 0) return [];
    const traces = await this.loadGoldenSetTraces(golden);
    return golden.map((entry) => {
      const trace = traces.get(entry.caseId);
      const metadata = trace?.metadata;
      return {
        id: entry.id,
        label: entry.agreedLabel,
        input: trace?.input ?? null,
        output: trace?.output ?? null,
        reason: entry.reason,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {})
      };
    });
  }

  async getGoldenSetHealth(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetHealthSummary> {
    return buildGoldenSetHealthSummary(
      projectId,
      await this.listGoldenSet(projectId, criterionVersionId)
    );
  }

  async getExceptionDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail> {
    // Exceptions are non-pass cases. The detail-by-id lookup keeps the pass
    // filter so the exceptions-queue drill-down only opens genuine exceptions.
    const detail = await this.loadCaseDetail(projectId, caseId, { exceptionsOnly: true, skillVersionId });
    if (!detail) throw new Error(`Exception not found: ${caseId}`);
    return detail;
  }

  // generic case detail. Resolves ANY judged case to its trace +
  // latest judge run regardless of verdict, so surfaces like the regression
  // diff can link a still-passing golden case to its trace without 404ing on
  // the exceptions-only filter. Returns null when the case has no judge run.
  async getCaseDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail | null> {
    return this.loadCaseDetail(projectId, caseId, { exceptionsOnly: false, skillVersionId });
  }

  private async loadCaseDetail(
    projectId: string,
    caseId: string,
    opts: { exceptionsOnly: boolean; skillVersionId?: string | undefined }
  ): Promise<ExceptionDetail | null> {
    if (!opts.skillVersionId) await this.dependencies.assertSingletonCriterion(projectId);
    const result = await this.pool.query(
      `select jr.*,
              version.criterion_version_id,
              c.normalized_payload,
              rt.source_trace_id,
              rt.raw_payload
       from judge_runs jr
       join skill_versions version
         on version.id = jr.skill_version_id
        and version.project_id = jr.project_id
       join cases c on c.id = jr.case_id
       left join raw_traces rt on rt.id = c.raw_trace_id
       where jr.project_id = $1 and jr.case_id = $2
         and ($3::text is null or jr.skill_version_id = $3)
         ${opts.exceptionsOnly ? "and jr.verdict <> 'pass'" : ""}
       order by jr.created_at desc
       limit 1`,
      [projectId, caseId, opts.skillVersionId ?? null]
    );
    const row = result.rows[0];
    if (!row) return null;
    const payload = redactNormalizedTracePayload(parseJson(row.normalized_payload) as { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; steps?: NormalizedTraceStep[] });
    const judgeRun = rowToJudgeRun(row);
    const exception = rowToExceptionCase({
      ...row,
      source_trace_id: row.source_trace_id ?? row.case_id,
      normalized_payload: row.normalized_payload
    });
    // Return the append-only evaluator + human decision evidence for this case
    // and criterion so every case host can render the same durable history.
    // The recent-history query is bounded, while the second query guarantees
    // that an older effective human/owner ruling is not pushed out by many
    // evaluator re-runs. An owner adjudication still outranks ordinary human
    // reviews via effectiveHumanLabel; malformed historical rows are skipped
    // rather than making the whole case unviewable.
    const verdictResult = await this.pool.query(
      `select verdict.*, coalesce(u.name, u.email) as actor_name
       from verdicts verdict
       join skill_versions version
         on version.id = verdict.skill_version_id
        and version.project_id = verdict.project_id
       left join "user" u on u.id = verdict.actor_user_id
       where verdict.project_id = $1
         and verdict.case_id = $2
         and version.criterion_version_id = $3
         and verdict.source in ('llm_judge', 'human', 'adjudicated')
       order by verdict.created_at desc, verdict.id desc
       limit 200`,
      [projectId, caseId, String(row.criterion_version_id)]
    );
    const effectiveRulingResult = await this.pool.query(
      `select verdict.*, coalesce(u.name, u.email) as actor_name
       from verdicts verdict
       join skill_versions version
         on version.id = verdict.skill_version_id
        and version.project_id = verdict.project_id
       left join "user" u on u.id = verdict.actor_user_id
       where verdict.project_id = $1
         and verdict.case_id = $2
         and version.criterion_version_id = $3
         and verdict.source in ('human', 'adjudicated')
       order by case when verdict.source = 'adjudicated' then 0 else 1 end,
                verdict.created_at desc,
                verdict.id desc
       limit 1`,
      [projectId, caseId, String(row.criterion_version_id)]
    );
    const verdictHistoryById = new Map<string, VerdictRecord>();
    for (const verdictRow of [...verdictResult.rows, ...effectiveRulingResult.rows]) {
      try {
        const verdict = rowToVerdictRecord(verdictRow);
        verdictHistoryById.set(verdict.id, verdict);
      } catch {
        // Preserve the rest of the audit trail when one legacy row is malformed.
      }
    }
    const verdictHistory = [...verdictHistoryById.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    );
    const goldenResult = await this.pool.query(
      `select * from golden_set_entries
       where project_id = $1
         and case_id = $2
         and criterion_version_id = $3
         and retired_at is null
       order by promoted_at desc, id desc
       limit 1`,
      [projectId, caseId, String(row.criterion_version_id)]
    );
    // the case's dataset expectations (all datasets, by name — a case
    // can carry different labels in different datasets; show every one).
    const expectationsResult = await this.pool.query(
      `select d.name as dataset_name, di.expected_label, di.expected_fail_step
       from dataset_items di
       join datasets d on d.id = di.dataset_id
       where di.case_id = $1 and di.project_id = $2 and d.archived_at is null
       order by di.added_at asc, di.id asc`,
      [caseId, projectId]
    );
    const datasetExpectations = expectationsResult.rows.map((expectation) => ({
      datasetName: String(expectation.dataset_name),
      expectedLabel: expectation.expected_label ? (String(expectation.expected_label) as "pass" | "fail") : null,
      expectedFailStep: expectation.expected_fail_step === null || expectation.expected_fail_step === undefined
        ? null
        : Number(expectation.expected_fail_step)
    }));
    return {
      exception,
      trace: {
        id: String(row.source_trace_id ?? row.case_id),
        input: payload.input ?? payload,
        output: payload.output ?? payload,
        metadata: payload.metadata ?? {},
        ...(payload.steps ? { steps: payload.steps } : {})
      },
      datasetExpectations,
      judgeRun,
      latestHumanLabel: effectiveHumanLabel(verdictHistory),
      verdictHistory,
      goldenSetEntry: goldenResult.rows[0] ? rowToGoldenSetEntry(goldenResult.rows[0]) : null,
      rawRequest: row.raw_request ? parseJson(row.raw_request) : undefined,
      rawResponse: row.raw_response ? parseJson(row.raw_response) : undefined
    };
  }

  async promoteExceptionToGoldenSet(input: PromoteExceptionToGoldenSetInput): Promise<GoldenSetEntry> {
    // Any judged case is promotable, not just exceptions: a golden set with
    // only fail entries can't catch a version that starts failing good
    // answers, so judge-passed cases are legitimate pass anchors.
    const caseType = await this.pool.query(
      `select case_type from cases where id = $1 and project_id = $2`,
      [input.caseId, input.projectId]
    );
    if (caseType.rows[0]?.case_type === "release_evidence") throw new CaseNotFoundError(input.caseId);
    const detail = await this.getCaseDetail(input.projectId, input.caseId, input.skillVersionId);
    if (!detail) throw new CaseNotFoundError(input.caseId);
    // The human-outranks-judge rule is enforced HERE, not just in the web
    // form: a client-supplied label that contradicts the recorded human
    // decision must not be frozen into the golden set (nor injected into the
    // verdicts ledger as a human judgment nobody made).
    if (
      detail.latestHumanLabel &&
      detail.latestHumanLabel !== "ambiguous" &&
      detail.latestHumanLabel !== input.agreedLabel
    ) {
      throw new GoldenSetLabelConflictError(input.caseId, input.agreedLabel, detail.latestHumanLabel);
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select id from projects where id = $1 for update`, [input.projectId]);
      const criterionVersionId = String((await client.query(
        `select criterion_version_id from skill_versions where id = $1 and project_id = $2`,
        [detail.judgeRun.skillVersionId, input.projectId]
      )).rows[0]?.criterion_version_id ?? "");
      if (!criterionVersionId) {
        throw new DatasetRevisionConflictError("Judge evaluator has no immutable criterion version binding");
      }
      // A promotion IS a human judgment on the case — record it in the v2
      // verdicts ledger (source=human) so κ / calibration count it, instead of
      // the old write-only `reviews` row nothing ever read. Same payload shape
      // recordVerdict writes; kept in this transaction so a failed golden-set
      // insert can't leave a stray verdict. Deliberately does NOT complete
      // pending review-queue items — only an explicit human verdict does that.
      await client.query(
        `insert into verdicts
         (id, project_id, case_id, skill_version_id, source, actor_user_id, verdict_kind, payload, external_run_id)
         values ($1,$2,$3,$4,'human',$5,'categorical',$6,null)`,
        [
          `verdict_${randomUUID()}`,
          input.projectId,
          input.caseId,
          detail.judgeRun.skillVersionId,
          input.actorUserId ?? null,
          JSON.stringify({
            kind: "categorical",
            choice: input.agreedLabel,
            choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
            rationale: input.reason
          })
        ]
      );
      const result = await client.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by_user_id,
          promoted_by, source_skill_version_id, criterion_version_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (project_id, criterion_version_id, case_id) where retired_at is null
         do update set agreed_label = excluded.agreed_label,
                       reason = excluded.reason,
                       promoted_by_user_id = excluded.promoted_by_user_id,
                       promoted_by = excluded.promoted_by,
                       source_skill_version_id = excluded.source_skill_version_id,
                       promoted_at = now()
         returning *`,
        [
          `gold_${randomUUID()}`,
          input.projectId,
          input.caseId,
          detail.trace.id,
          input.agreedLabel,
          input.reason,
          input.actorUserId ?? null,
          input.actorName ?? "Reviewer",
          detail.judgeRun.skillVersionId,
          criterionVersionId
        ]
      );
      await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        input.projectId,
        criterionVersionId,
        input.actorUserId
      );
      await client.query("commit");
      return rowToGoldenSetEntry(result.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async retireGoldenSetEntry(input: RetireGoldenSetEntryInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select id from projects where id = $1 for update`, [input.projectId]);
      const result = await client.query(
        `update golden_set_entries
         set retired_at = now()
         where id = $1 and project_id = $2 and retired_at is null
         returning id, case_id, criterion_version_id`,
        [input.entryId, input.projectId]
      );
      const row = result.rows[0];
      if (!row) {
        const existing = await client.query(
          `select retired_at
           from golden_set_entries
           where id = $1 and project_id = $2`,
          [input.entryId, input.projectId]
        );
        if (existing.rows[0]?.retired_at) {
          throw new GoldenSetEntryAlreadyRetiredError(
            input.entryId,
            await loadGoldenSetRetirementContext(client, input.projectId, input.entryId)
          );
        }
        throw new GoldenSetEntryNotFoundError(input.entryId);
      }
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          input.projectId,
          input.actorUserId ?? null,
          "golden_set.retire",
          "golden_set_entry",
          input.entryId,
          JSON.stringify({
            caseId: String(row.case_id),
            ...(input.reason ? { reason: input.reason } : {})
          })
        ]
      );
      await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        input.projectId,
        String(row.criterion_version_id),
        input.actorUserId
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getGoldenSetTraces(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<Map<string, Trace>> {
    return this.loadGoldenSetTraces(await this.listGoldenSet(projectId, criterionVersionId));
  }

  private async loadGoldenSetTraces(goldenSet: GoldenSetEntry[]): Promise<Map<string, Trace>> {
    const caseIds = goldenSet.map((entry) => entry.caseId);
    const output = new Map<string, Trace>();
    if (caseIds.length === 0) return output;

    const result = await this.pool.query(
      `select id, normalized_payload from cases where id = any($1::text[])`,
      [caseIds]
    );
    for (const row of result.rows) {
      const payload = redactNormalizedTracePayload(parseJson(row.normalized_payload) as { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; steps?: NormalizedTraceStep[] });
      output.set(row.id, {
        id: row.id,
        input: payload.input ?? payload,
        output: payload.output ?? payload,
        metadata: payload.metadata ?? {},
        ...(payload.steps ? { steps: payload.steps } : {})
      });
    }
    return output;
  }
}
