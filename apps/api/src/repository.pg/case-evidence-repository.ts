import { randomUUID } from "node:crypto";
import {
  type ConvergenceAuditPage,
  type ConvergenceCaseChange,
  type DisagreementSummary,
  type ExceptionCase,
  type JudgeCardAuditEntry,
  type JudgeHumanDisagreementSummary,
  type KappaSummary,
  type SelfConsistencyReport,
  type Skill,
  type VerdictRecord
} from "@coeval/shared";
import type { Pool } from "pg";
import { EXCEPTION_LIST_LIMIT } from "../lib/exception-rows.js";
import {
  computeConvergenceAudit,
  computeDisagreementSummary,
  computeJudgeHumanCalibration,
  computeJudgeHumanDisagreement,
  computeKappaSummary,
  computeSelfConsistency
} from "../lib/kappa.js";
import { redactNormalizedTracePayload, type NormalizedTraceStep } from "../lib/redaction.js";
import type {
  CaseListEntry,
  ConvergenceAuditPageInput,
  ListCasesOptions,
  ListVerdictsInput,
  RecordVerdictInput
} from "../repository.js";
import {
  AmbiguousProjectSkillError,
  CaseNotFoundError,
  InvalidConvergenceCursorError
} from "../repository/errors.js";
import {
  convergencePageLimit,
  decodeConvergenceCursor,
  encodeConvergenceCursor
} from "../repository/helpers.js";
import type { CaseEvidenceRepositoryPort } from "../repository/ports.js";
import {
  parseJson,
  rowToExceptionCase,
  rowToVerdictRecord,
  toIso
} from "./mappers.js";

export interface PgCaseEvidenceRepositoryDependencies {
  assertSingletonCriterion(projectId: string): Promise<void>;
  getCurrentSkill(projectId: string): Promise<Skill>;
  resolveGoldenCriterionVersion(projectId: string, requested?: string | undefined): Promise<string>;
}

// PostgreSQL case, verdict, agreement, disagreement, convergence, and audit
// read models. This evidence is descriptive input to Analyze and Measure; it
// neither adjudicates truth nor owns a release decision or policy threshold.
export class PgCaseEvidenceRepository implements CaseEvidenceRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly dependencies: PgCaseEvidenceRepositoryDependencies
  ) {}

  async listCaseIdsForProject(projectId: string, limit = 10_000): Promise<string[]> {
    // Governed evaluation scaffolding is excluded: this feeds
    // the approval-time judge backfill, which must never re-judge (and pay
    // provider tokens for) accumulated product-gate scaffolding.
    const result = await this.pool.query(
      `select id from cases
       where project_id = $1 and case_type not in ('gate_candidate', 'release_evidence')
       order by created_at desc limit $2`,
      [projectId, limit]
    );
    return result.rows.map((row) => String(row.id));
  }

  async listCases(projectId: string, opts: ListCasesOptions = {}): Promise<CaseListEntry[]> {
    // Machine read for /api/v1/findings + /api/v1/cases. Gate/release-evidence
    // scaffolding is excluded (same rule as listCaseIdsForProject); payloads
    // pass the same on-read redaction as every other trace reader.
    const result = await this.pool.query(
      `select c.id, c.created_at, c.normalized_payload,
              coalesce(rt.source_trace_id, c.id) as source_trace_id
       from cases c
       left join raw_traces rt on rt.id = c.raw_trace_id
       where c.project_id = $1
         and c.case_type not in ('gate_candidate', 'release_evidence')
         and ($2::timestamptz is null or c.created_at > $2)
       order by c.created_at desc, c.id
       limit $3`,
      [projectId, opts.since ?? null, opts.limit ?? 500]
    );
    return result.rows.map((row) => {
      const payload = redactNormalizedTracePayload(parseJson(row.normalized_payload) as { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; steps?: NormalizedTraceStep[] });
      return {
        caseId: String(row.id),
        sourceTraceId: String(row.source_trace_id),
        createdAt: new Date(row.created_at).toISOString(),
        trace: {
          input: payload.input ?? null,
          output: payload.output ?? null,
          metadata: payload.metadata ?? {},
          ...(payload.steps ? { steps: payload.steps } : {})
        }
      };
    });
  }

  async recordVerdict(input: RecordVerdictInput): Promise<VerdictRecord> {
    if (input.externalRunId) {
      const existing = await this.pool.query(
        `select * from verdicts
         where project_id = $1 and source = 'imported_external' and external_run_id = $2
         limit 1`,
        [input.projectId, input.externalRunId]
      );
      if (existing.rows[0]) return rowToVerdictRecord(existing.rows[0]);
    }
    let skillVersionId = input.skillVersionId;
    if (input.source === "human" || input.source === "adjudicated") {
      if (skillVersionId) {
        const binding = await this.pool.query(
          `select 1
           from skill_versions evaluator
           join cases review_case on review_case.project_id = evaluator.project_id
           where evaluator.project_id = $1
             and review_case.id = $2
             and evaluator.id = $3
           limit 1`,
          [input.projectId, input.caseId, skillVersionId]
        );
        if (!binding.rowCount) throw new CaseNotFoundError(input.caseId);
      } else {
        await this.dependencies.assertSingletonCriterion(input.projectId);
        const definitionCount = Number((await this.pool.query(
          `select count(*)::int as count from criterion_versions where project_id = $1`,
          [input.projectId]
        )).rows[0]?.count ?? 0);
        if (definitionCount > 1) {
          throw new AmbiguousProjectSkillError(input.projectId, definitionCount);
        }
        const binding = await this.pool.query(
          `select run.skill_version_id
           from judge_runs run
           join skill_versions version
             on version.id = run.skill_version_id
            and version.project_id = run.project_id
           where run.project_id = $1 and run.case_id = $2
           order by run.created_at desc, run.id desc
           limit 1`,
          [input.projectId, input.caseId]
        );
        if (binding.rows[0]) {
          skillVersionId = String(binding.rows[0].skill_version_id);
        } else {
          // A reviewer can label an imported case before its first judge run;
          // persist the current evaluator as an explicit immutable binding.
          skillVersionId = (await this.dependencies.getCurrentSkill(input.projectId)).currentVersion.id;
        }
      }
    }
    const result = await this.pool.query(
      `insert into verdicts
       (id, project_id, case_id, skill_version_id, source, actor_user_id, verdict_kind, payload, external_run_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning *`,
      [
        `verdict_${randomUUID()}`,
        input.projectId,
        input.caseId,
        skillVersionId ?? null,
        input.source,
        input.actorUserId ?? null,
        input.payload.kind,
        JSON.stringify(input.payload),
        input.externalRunId ?? null
      ]
    );
    // a human verdict completes any pending queue items pointing at
    // this case across every queue. LLM-judge + imported_external don't count.
    // Done in a separate statement (not the same transaction) — failure here
    // shouldn't roll back the verdict insert; queue progression is best-
    // effort and recoverable.
    if (input.source === "human") {
      // scope to items unassigned OR assigned to this actor.
      // Items assigned to OTHER reviewers stay pending — they're the κ-overlap
      // partner row and must wait for that reviewer's own verdict.
      await this.pool.query(
        `update review_queue_items rqi
         set status = 'completed', completed_at = now()
         from review_queues rq
         where rqi.queue_id = rq.id
           and rq.project_id = $1
           and rqi.case_id = $2
           and rqi.status = 'pending'
           and rqi.criterion_version_id = (
             select criterion_version_id
             from skill_versions
             where id = $4 and project_id = $1
           )
           and (rqi.assigned_to_user_id is null or rqi.assigned_to_user_id = $3)`,
        [input.projectId, input.caseId, input.actorUserId ?? null, skillVersionId]
      ).catch(() => undefined);
    }
    return rowToVerdictRecord(result.rows[0]);
  }

  async listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]> {
    const result = await this.pool.query(
      `select verdict.*, coalesce(u.name, u.email) as actor_name
       from verdicts verdict
       left join "user" u on u.id = verdict.actor_user_id
       where verdict.project_id = $1
         and ($2::text is null or verdict.case_id = $2)
         and ($3::text is null or verdict.source = $3)
         and ($4::text is null or verdict.skill_version_id = $4)
         and ($5::text is null or exists (
           select 1
           from skill_versions version
           join skills skill on skill.id = version.skill_id and skill.project_id = version.project_id
           where version.id = verdict.skill_version_id
             and version.project_id = verdict.project_id
             and skill.criterion_id = $5
         ))
         and ($6::text = 'all' or exists (
           select 1 from cases verdict_case
           where verdict_case.id = verdict.case_id
             and verdict_case.project_id = verdict.project_id
             and verdict_case.case_type not in ('gate_candidate', 'release_evidence')
         ))
       order by verdict.created_at desc
       limit $7`,
      [
        input.projectId,
        input.caseId ?? null,
        input.source ?? null,
        input.skillVersionId ?? null,
        input.criterionId ?? null,
        input.evidenceScope ?? "all",
        input.limit
      ]
    );
    return result.rows.map(rowToVerdictRecord);
  }

  async caseExistsForProject(projectId: string, caseId: string): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from cases where id = $1 and project_id = $2 limit 1`,
      [caseId, projectId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getProjectKappaSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<KappaSummary> {
    // Load human verdicts only — κ measures inter-human agreement (PR #42).
    // Capped at 50k to bound memory; teams with more verdicts will need a
    // partitioned aggregation pass later. Practical scale today: dozens of
    // reviewers × thousands of cases is well under the cap.
    const resolved = await this.dependencies.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source = 'human'
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved]
    );
    return computeKappaSummary(result.rows.map(rowToVerdictRecord));
  }

  async getProjectJudgeHumanCalibration(
    projectId: string,
    criterionVersionId?: string | undefined,
    skillVersionId?: string | undefined
  ): Promise<KappaSummary> {
    // load BOTH human and llm_judge verdicts so the pure helper can
    // pair them. imported_external rows are excluded — they don't participate
    // in calibration. Same 50k cap as above.
    const resolved = await this.dependencies.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source in ('human', 'llm_judge')
         and ($3::text is null or verdict.source <> 'llm_judge' or verdict.skill_version_id = $3)
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved, skillVersionId ?? null]
    );
    return computeJudgeHumanCalibration(result.rows.map(rowToVerdictRecord));
  }

  async getDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<DisagreementSummary> {
    // Human verdicts drive the splits; adjudicated rows annotate which splits
    // are resolved (A2.2b-2). Same cap as the κ summary.
    const resolved = await this.dependencies.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source in ('human', 'adjudicated')
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved]
    );
    const summary = computeDisagreementSummary(result.rows.map(rowToVerdictRecord));
    await this.attachActorNames(summary.cases.map((entry) => entry.labels));
    return summary;
  }

  async getJudgeHumanDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<JudgeHumanDisagreementSummary> {
    // Load human + llm_judge verdicts (same as calibration) so the helper can
    // pair the judge's verdict against each human's, plus adjudicated rows to
    // annotate resolution (A2.2b-2). asc order makes "latest judge verdict wins"
    // resolve correctly. Same 50k cap.
    const resolved = await this.dependencies.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source in ('human', 'llm_judge', 'adjudicated')
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved]
    );
    const summary = computeJudgeHumanDisagreement(result.rows.map(rowToVerdictRecord));
    await this.attachActorNames(summary.cases.map((entry) => entry.humanLabels));
    return summary;
  }

  // Reviewer ids in the trust feeds are Better Auth user ids — opaque UUIDs.
  // Resolve them to display names in one query and decorate the label lists
  // in place, so the feeds read "Maya · Pass", not "ba434f1c-… · Pass".
  private async attachActorNames(labelLists: Array<Array<{ actorUserId: string; actorName?: string | null | undefined }>>): Promise<void> {
    const distinct = [...new Set(labelLists.flat().map((label) => label.actorUserId))].filter(Boolean);
    if (distinct.length === 0) return;
    const result = await this.pool.query(
      `select id, name, email from "user" where id = any($1)`,
      [distinct]
    );
    const names = new Map<string, string>();
    for (const row of result.rows) {
      const name = (row.name as string | null) || (row.email as string | null);
      if (name) names.set(String(row.id), name);
    }
    for (const labels of labelLists) {
      for (const label of labels) label.actorName = names.get(label.actorUserId) ?? null;
    }
  }

  async getConvergenceAudit(
    projectId: string,
    skillId: string,
    versionId: string,
    input: ConvergenceAuditPageInput = {}
  ): Promise<ConvergenceAuditPage> {
    const target = await this.pool.query(
      `select criterion_version_id,
              to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_text
       from skill_versions
       where project_id = $1 and skill_id = $2 and id = $3`,
      [projectId, skillId, versionId]
    );
    if (!target.rows[0]) {
      return {
        audit: computeConvergenceAudit([], { beforeVersionId: null, afterVersionId: versionId }),
        nextCursor: null,
        nextUncoveredCaseId: null
      };
    }
    const criterionVersionId = String(target.rows[0].criterion_version_id);
    // The predecessor = the skill's version created immediately before this one.
    const pred = await this.pool.query(
      `select id from skill_versions
       where project_id = $1 and skill_id = $2
         and criterion_version_id = $3
         and (created_at, id) < ($4, $5)
       order by created_at desc, id desc
       limit 1`,
      [projectId, skillId, criterionVersionId, String(target.rows[0].created_at_text), versionId]
    );
    const beforeVersionId = pred.rows[0]?.id ? String(pred.rows[0].id) : null;

    const limit = convergencePageLimit(input.limit);
    const cursor = decodeConvergenceCursor(input.cursor ?? null);
    if (cursor && (
      cursor.versionId !== versionId ||
      cursor.criterionVersionId !== criterionVersionId ||
      cursor.beforeVersionId !== beforeVersionId
    )) {
      throw new InvalidConvergenceCursorError();
    }
    const snapshot = cursor ?? (await this.pool.query(
      `select to_char(verdict.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_text,
              verdict.id
       from verdicts verdict
       left join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1
         and verdict.payload->>'kind' in ('binary', 'categorical')
         and ((verdict.source = 'adjudicated' and evaluator.criterion_version_id = $4)
              or (verdict.source = 'llm_judge' and verdict.skill_version_id in ($2, $3)))
       order by verdict.created_at desc, verdict.id desc
       limit 1`,
      [projectId, versionId, beforeVersionId, criterionVersionId]
    )).rows[0];
    // node-postgres converts timestamptz to JS Date and truncates PostgreSQL's
    // microseconds. Keep the watermark as lossless SQL text or the newest row
    // can compare greater than its own rounded snapshot on page one.
    const snapshotCreatedAt = cursor?.snapshotCreatedAt ?? (
      snapshot?.created_at_text ? String(snapshot.created_at_text) : null
    );
    const snapshotId = cursor?.snapshotId ?? (snapshot?.id ? String(snapshot.id) : null);
    const label = (alias: string) => `case when ${alias}.payload is null then null else case
      when ${alias}.payload->>'kind' = 'binary' then
        case when ${alias}.payload ? 'label' then ${alias}.payload->>'label'
             when (${alias}.payload->>'pass')::boolean then 'pass' else 'fail' end
      else ${alias}.payload->>'choice'
    end end`;

    // Resolve one exact latest row per case in SQL before aggregating. The
    // headline scans no arbitrary verdict cap; only the independently paged
    // disclosure is bounded. Corrections appended after the old 50k boundary
    // therefore participate in both numerator and denominators.
    const result = await this.pool.query(
      `with adjudicated_head as (
         select distinct on (verdict.case_id) verdict.case_id, verdict.payload
         from verdicts verdict
         join skill_versions evaluator
           on evaluator.id = verdict.skill_version_id
          and evaluator.project_id = verdict.project_id
         where verdict.project_id = $1
           and verdict.source = 'adjudicated'
           and evaluator.criterion_version_id = $4
           and verdict.payload->>'kind' in ('binary', 'categorical')
           and ($8::timestamptz is null or (verdict.created_at, verdict.id) <= ($8::timestamptz, $9::text))
         order by verdict.case_id, verdict.created_at desc, verdict.id desc
       ), after_head as (
         select distinct on (verdict.case_id) verdict.case_id, verdict.payload
         from verdicts verdict
         where verdict.project_id = $1
           and verdict.source = 'llm_judge'
           and verdict.skill_version_id = $2
           and verdict.payload->>'kind' in ('binary', 'categorical')
           and ($8::timestamptz is null or (verdict.created_at, verdict.id) <= ($8::timestamptz, $9::text))
         order by verdict.case_id, verdict.created_at desc, verdict.id desc
       ), before_head as (
         select distinct on (verdict.case_id) verdict.case_id, verdict.payload
         from verdicts verdict
         where verdict.project_id = $1
           and verdict.source = 'llm_judge'
           and $3::text is not null
           and verdict.skill_version_id = $3
           and verdict.payload->>'kind' in ('binary', 'categorical')
           and ($8::timestamptz is null or (verdict.created_at, verdict.id) <= ($8::timestamptz, $9::text))
         order by verdict.case_id, verdict.created_at desc, verdict.id desc
       ), labels as (
         select adjudicated.case_id,
                ${label("adjudicated")} as adjudicated_label,
                ${label("prior")} as before_label,
                ${label("current")} as after_label
         from adjudicated_head adjudicated
         join after_head current on current.case_id = adjudicated.case_id
         left join before_head prior on prior.case_id = adjudicated.case_id
       ), classified as (
         select labels.*,
                case
                  when after_label = adjudicated_label and before_label is not null and before_label <> adjudicated_label then 'improved'
                  when after_label <> adjudicated_label and before_label = adjudicated_label then 'regressed'
                  when after_label = adjudicated_label then 'still_agree'
                  else 'still_disagree'
                end as change,
                case
                  when after_label <> adjudicated_label and before_label = adjudicated_label then 0
                  when after_label = adjudicated_label and before_label is not null and before_label <> adjudicated_label then 1
                  when after_label <> adjudicated_label then 2
                  else 3
                end as change_rank
         from labels
       ), summary as (
         select (select count(*)::int from adjudicated_head) as adjudicated_total,
                count(*)::int as compared_cases,
                count(*) filter (where after_label = adjudicated_label)::int as after_agreed,
                count(*) filter (where before_label is not null)::int as before_known,
                count(*) filter (where before_label = adjudicated_label)::int as before_agreed,
                count(*) filter (where change = 'improved')::int as improved,
                count(*) filter (where change = 'regressed')::int as regressed
         from classified
       ), page as (
         select * from classified
         where $5::int is null
            or (change_rank, case_id) > ($5::int, $6::text)
         order by change_rank, case_id
         limit $7
       )
       select summary.*,
              page.case_id, page.adjudicated_label, page.before_label,
              page.after_label, page.change, page.change_rank,
              (select adjudicated.case_id
               from adjudicated_head adjudicated
               left join after_head current on current.case_id = adjudicated.case_id
               where current.case_id is null
               order by adjudicated.case_id
               limit 1) as next_uncovered_case_id
       from summary
       left join page on true
       order by page.change_rank, page.case_id`,
      [
        projectId,
        versionId,
        beforeVersionId,
        criterionVersionId,
        cursor?.rank ?? null,
        cursor?.caseId ?? null,
        limit + 1,
        snapshotCreatedAt,
        snapshotId
      ]
    );

    const summary = result.rows[0] ?? {};
    const caseRows = result.rows.filter((row) => row.case_id !== null && row.case_id !== undefined);
    const hasMore = caseRows.length > limit;
    const visibleRows = caseRows.slice(0, limit);
    const cases = visibleRows.map((row) => ({
      caseId: String(row.case_id),
      adjudicatedLabel: String(row.adjudicated_label),
      beforeLabel: row.before_label === null || row.before_label === undefined ? null : String(row.before_label),
      afterLabel: String(row.after_label),
      change: String(row.change) as ConvergenceCaseChange
    }));
    const last = visibleRows.at(-1) ?? null;
    return {
      audit: {
        afterVersionId: versionId,
        beforeVersionId,
        adjudicatedTotal: Number(summary.adjudicated_total ?? 0),
        comparedCases: Number(summary.compared_cases ?? 0),
        afterAgreed: Number(summary.after_agreed ?? 0),
        beforeKnown: Number(summary.before_known ?? 0),
        beforeAgreed: Number(summary.before_agreed ?? 0),
        improved: Number(summary.improved ?? 0),
        regressed: Number(summary.regressed ?? 0),
        cases
      },
      nextCursor: hasMore && last && snapshotCreatedAt && snapshotId
        ? encodeConvergenceCursor({
            versionId,
            criterionVersionId,
            beforeVersionId,
            snapshotCreatedAt,
            snapshotId,
            rank: Number(last.change_rank),
            caseId: String(last.case_id)
          })
        : null,
      nextUncoveredCaseId: summary.next_uncovered_case_id === null || summary.next_uncovered_case_id === undefined
        ? null
        : String(summary.next_uncovered_case_id)
    };
  }

  async getSelfConsistencyReport(projectId: string, versionId: string): Promise<SelfConsistencyReport> {
    // All of this version's judge verdicts; computeSelfConsistency groups the
    // repeats per case. Pinned to the version (a re-run by a different version
    // isn't a consistency sample for this one).
    const result = await this.pool.query(
      `select * from verdicts
       where project_id = $1 and source = 'llm_judge' and skill_version_id = $2
       order by created_at asc
       limit 50000`,
      [projectId, versionId]
    );
    return computeSelfConsistency(result.rows.map(rowToVerdictRecord), versionId);
  }

  async listAuditEntries(projectId: string, targetType: string, targetId: string): Promise<JudgeCardAuditEntry[]> {
    const result = await this.pool.query(
      `select id, action, actor_user_id, created_at, metadata
       from audit_logs
       where project_id = $1 and target_type = $2 and target_id = $3
       order by created_at asc, id asc`,
      [projectId, targetType, targetId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
      createdAt: toIso(row.created_at),
      metadata: row.metadata === null || row.metadata === undefined ? null : (parseJson(row.metadata) as Record<string, unknown>)
    }));
  }

  async listExceptionCases(projectId: string, criterionVersionId?: string | undefined): Promise<ExceptionCase[]> {
    // Reduced entirely in SQL, mirroring pinExceptionJudgeRunRows
    // (lib/exception-rows.ts — the unit-tested spec): pinned = the FIRST open
    // non-pass run per case (open = created after the case's latest
    // human/adjudicated verdict), latest = the newest run overall (feeds the
    // re-judged-since marker), golden cases excluded, newest-pinned-first,
    // capped at EXCEPTION_LIST_LIMIT. The previous implementation loaded
    // EVERY judge_run row for the project (raw_response + normalized_payload
    // JSON included) on every dashboard load and reduced in JS — unbounded.
    // JSON columns are now fetched only for the final ≤limit rows.
    const result = await this.pool.query(
      `with resolved as (
         select verdict.case_id,
                version.criterion_version_id,
                max(verdict.created_at) as resolved_at
         from verdicts verdict
         join skill_versions version
           on version.id = verdict.skill_version_id
          and version.project_id = verdict.project_id
         where verdict.project_id = $1 and verdict.source in ('human', 'adjudicated')
         group by verdict.case_id, version.criterion_version_id
       ),
       pinned as (
         select distinct on (jr.case_id, version.criterion_version_id)
                jr.id as judge_run_id,
                jr.case_id,
                jr.skill_version_id,
                version.criterion_version_id,
                jr.verdict,
                jr.reasoning,
                jr.created_at
         from judge_runs jr
         join skill_versions version
           on version.id = jr.skill_version_id
          and version.project_id = jr.project_id
         join cases jc on jc.id = jr.case_id
         left join resolved r
           on r.case_id = jr.case_id
          and r.criterion_version_id = version.criterion_version_id
         where jr.project_id = $1
           and ($2::text is null or version.criterion_version_id = $2)
           and jr.verdict <> 'pass'
           -- Product-gate candidates are scaffolding, never exceptions: a
           -- fail-labeled golden case correctly judged 'fail' would otherwise
           -- flood the queue on every deploy gate.
           and jc.case_type not in ('gate_candidate', 'release_evidence')
           and (r.resolved_at is null or jr.created_at > r.resolved_at)
           and not exists (
             select 1
             from golden_set_entries gse
             where gse.project_id = $1
               and gse.case_id = jr.case_id
               and gse.criterion_version_id = version.criterion_version_id
               and gse.retired_at is null
           )
         order by jr.case_id, version.criterion_version_id, jr.created_at asc, jr.id asc
       ),
       capped as (
         select * from pinned order by created_at desc, judge_run_id desc limit $3
       ),
       latest as (
         select distinct on (jr.case_id, version.criterion_version_id)
                jr.case_id,
                version.criterion_version_id,
                jr.id as latest_judge_run_id,
                jr.verdict as latest_verdict,
                jr.reasoning as latest_reasoning,
                jr.created_at as latest_created_at
         from judge_runs jr
         join skill_versions version
           on version.id = jr.skill_version_id
          and version.project_id = jr.project_id
         where jr.project_id = $1
           and exists (
             select 1 from capped
             where capped.case_id = jr.case_id
               and capped.criterion_version_id = version.criterion_version_id
           )
         order by jr.case_id, version.criterion_version_id, jr.created_at desc, jr.id desc
       )
       select p.judge_run_id, p.case_id, p.skill_version_id, p.criterion_version_id,
              p.verdict, p.reasoning, pjr.raw_response, p.created_at,
              l.latest_judge_run_id, l.latest_verdict, l.latest_reasoning, l.latest_created_at,
              c.normalized_payload,
              rt.source_trace_id
       from capped p
       join judge_runs pjr on pjr.id = p.judge_run_id
       join latest l
         on l.case_id = p.case_id
        and l.criterion_version_id = p.criterion_version_id
       join cases c on c.id = p.case_id
       left join raw_traces rt on rt.id = c.raw_trace_id
       order by p.created_at desc, p.judge_run_id desc`,
      [projectId, criterionVersionId ?? null, EXCEPTION_LIST_LIMIT]
    );
    return result.rows.map(rowToExceptionCase);
  }
}
