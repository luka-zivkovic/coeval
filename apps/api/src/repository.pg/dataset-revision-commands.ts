import { randomUUID } from "node:crypto";
import type {
  DatasetReferenceProvenance,
  DatasetRevision,
  DatasetRevisionPayloadSnapshot,
  VerdictRecord
} from "@coeval/shared";
import { verdictLabelFromPayload } from "@coeval/shared";
import type { PoolClient } from "pg";
import {
  datasetInputIdentity,
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest
} from "../lib/dataset-revision.js";
import { DatasetRevisionConflictError } from "../repository/errors.js";
import {
  normalizedPayloadSnapshot,
  parseJson,
  rowToVerdictRecord
} from "./mappers.js";

export async function getOrCreateRegressionDatasetRevisionWithClient(
  client: PoolClient,
  projectId: string,
  criterionVersionId: string,
  actorUserId?: string
): Promise<string> {
  const project = await client.query(`select id from projects where id = $1 for update`, [projectId]);
  if (!project.rows[0]) throw new Error(`Project not found: ${projectId}`);
  const rows = await client.query(
    `select gse.*, c.normalized_payload, rt.raw_payload
       from golden_set_entries gse
       join cases c on c.id = gse.case_id and c.project_id = gse.project_id
       left join raw_traces rt on rt.id = c.raw_trace_id
       where gse.project_id = $1
         and gse.criterion_version_id = $2
         and gse.retired_at is null
       order by gse.promoted_at asc, gse.id asc`,
    [projectId, criterionVersionId]
  );
  const verdicts = await loadHumanVerdictsForCases(
    client,
    projectId,
    rows.rows.map((row) => String(row.case_id)),
    criterionVersionId
  );
  const prepared = [] as Array<{
    sourceCaseId: string;
    sourceTraceId: string;
    sourceDatasetItemId: null;
    sourceGoldenEntryId: string;
    payloadSnapshot: DatasetRevisionPayloadSnapshot;
    inputDigest: string;
    itemDigest: string;
    referenceLabel: "pass" | "fail";
    referenceFailStep: null;
    referenceProvenance: DatasetReferenceProvenance;
    note: string;
  }>;
  for (const row of rows.rows) {
    const caseId = String(row.case_id);
    const payloadSnapshot = normalizedPayloadSnapshot(row.normalized_payload);
    const identity = await resolveCaseInputIdentity(client, projectId, caseId, row.raw_payload);
    const referenceLabel = row.agreed_label === "fail" ? "fail" : "pass";
    const matching = (verdicts.get(caseId) ?? []).filter((verdict) =>
      verdictLabelFromPayload(verdict.payload) === referenceLabel &&
      (verdict.source === "human" || verdict.source === "adjudicated")
    );
    const referenceProvenance: DatasetReferenceProvenance = {
      kind: "golden_promotion",
      sourceId: String(row.id),
      verdictIds: matching.map((verdict) => verdict.id),
      actorUserIds: matching.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
      basis: "Visible golden promotion; known-failure governance, not sealed validation."
    };
    const itemDigest = datasetRevisionItemDigest({
      inputIdentity: identity,
      redactedPayload: payloadSnapshot,
      referenceLabel,
      expectedFailStep: null,
      reviewProvenance: referenceProvenance,
      note: String(row.reason)
    });
    prepared.push({
      sourceCaseId: caseId,
      sourceTraceId: String(row.trace_id),
      sourceDatasetItemId: null,
      sourceGoldenEntryId: String(row.id),
      payloadSnapshot,
      inputDigest: identity.digest,
      itemDigest,
      referenceLabel,
      referenceFailStep: null,
      referenceProvenance,
      note: String(row.reason)
    });
  }

  const revisionDigest = datasetRevisionDigest({
    role: "regression_golden",
    itemDigests: prepared.map((item) => item.itemDigest)
  });
  const pointer = await client.query(
    `select pointer.revision_id, revision.revision_digest
       from criterion_regression_revisions pointer
       join dataset_revisions revision on revision.id = pointer.revision_id
       where pointer.project_id = $1 and pointer.criterion_version_id = $2`,
    [projectId, criterionVersionId]
  );
  if (pointer.rows[0]?.revision_digest === revisionDigest) return String(pointer.rows[0].revision_id);

  const revisionId = await insertDatasetRevisionWithClient(client, {
    projectId,
    seriesId: `golden:${projectId}:${criterionVersionId}`,
    sourceDatasetId: null,
    criterionVersionId,
    role: "regression_golden",
    sourceKind: "golden_snapshot",
    provenanceLevel: prepared.length > 0 && prepared.every((item) => item.referenceProvenance.verdictIds.length > 0)
      ? "reviewed_unblinded"
      : "legacy",
    createdByUserId: actorUserId,
    items: prepared
  });
  await client.query(
    `insert into dataset_exposure_events
       (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
        subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
       values ($1,$2,$3,'legacy_pretracking','development','legacy_import','system',
               'golden-registry',$4,'golden_registry',null,null,'{}'::jsonb,$5)`,
    [`dse_${randomUUID()}`, projectId, revisionId, actorUserId ?? null, `regression-visible:${revisionId}`]
  );
  await client.query(
    `insert into criterion_regression_revisions (project_id, criterion_version_id, revision_id)
       values ($1,$2,$3)
       on conflict (project_id, criterion_version_id) do update
       set revision_id = excluded.revision_id, updated_at = now()`,
    [projectId, criterionVersionId, revisionId]
  );
  return revisionId;
}

export async function resolveSingletonCriterionVersionForRegression(
  client: PoolClient,
  projectId: string
): Promise<string> {
  const result = await client.query(
    `select latest.id
       from criteria criterion
       join lateral (
         select version.id
         from criterion_versions version
         where version.project_id = criterion.project_id
           and version.criterion_id = criterion.id
         order by version.revision desc, version.id desc
         limit 1
       ) latest on true
       where criterion.project_id = $1
       order by criterion.id`,
    [projectId]
  );
  if (result.rows.length !== 1) {
    throw new DatasetRevisionConflictError(
      `Project ${projectId} requires an explicit criterionVersionId for regression evidence.`
    );
  }
  return String(result.rows[0].id);
}

export async function insertDatasetRevisionWithClient(
  client: PoolClient,
  input: {
    projectId: string;
    seriesId: string;
    sourceDatasetId: string | null;
    criterionVersionId?: string | undefined;
    role: DatasetRevision["role"];
    sourceKind: DatasetRevision["sourceKind"];
    provenanceLevel: DatasetRevision["provenanceLevel"];
    expectedParentRevisionId?: string | undefined;
    idempotencyKey?: string | undefined;
    reuseLatestContent?: boolean | undefined;
    createdByUserId?: string | undefined;
    items: Array<{
      sourceCaseId: string | null;
      sourceTraceId: string | null;
      sourceDatasetItemId: string | null;
      sourceGoldenEntryId: string | null;
      payloadSnapshot: DatasetRevisionPayloadSnapshot;
      inputDigest: string;
      itemDigest: string;
      referenceLabel: "pass" | "fail" | null;
      referenceFailStep: number | null;
      referenceProvenance: DatasetReferenceProvenance;
      note: string | null;
    }>;
  }
): Promise<string> {
  const parentResult = await client.query(
    `select id, revision_number, role, content_digest from dataset_revisions
       where project_id = $1 and series_id = $2
       order by revision_number desc
       limit 1
       for update`,
    [input.projectId, input.seriesId]
  );
  const parentId = parentResult.rows[0] ? String(parentResult.rows[0].id) : null;
  if (input.expectedParentRevisionId !== undefined && input.expectedParentRevisionId !== parentId) {
    throw new DatasetRevisionConflictError(
      `Dataset revision changed from ${input.expectedParentRevisionId} to ${parentId ?? "none"}`
    );
  }
  const revisionId = `dsr_${randomUUID()}`;
  const itemDigests = input.items.map((item) => item.itemDigest);
  const contentDigest = datasetRevisionContentDigest(itemDigests);
  const revisionDigest = datasetRevisionDigest({ role: input.role, itemDigests });
  if (
    input.reuseLatestContent &&
    parentResult.rows[0]?.role === input.role &&
    parentResult.rows[0]?.content_digest === contentDigest
  ) {
    return String(parentResult.rows[0].id);
  }
  await client.query(
    `insert into dataset_revisions
       (id, project_id, series_id, revision_number, source_dataset_id, parent_revision_id,
        role, source_kind, identity_basis, content_digest, revision_digest, item_count,
        provenance_level, created_by_user_id, idempotency_key, criterion_version_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'input-identity/v1',$9,$10,$11,$12,$13,$14,$15)`,
    [
      revisionId,
      input.projectId,
      input.seriesId,
      Number(parentResult.rows[0]?.revision_number ?? 0) + 1,
      input.sourceDatasetId,
      parentId,
      input.role,
      input.sourceKind,
      contentDigest,
      revisionDigest,
      input.items.length,
      input.provenanceLevel,
      input.createdByUserId ?? null,
      input.idempotencyKey ?? null,
      input.criterionVersionId ?? null
    ]
  );
  for (const [position, item] of input.items.entries()) {
    await client.query(
      `insert into dataset_revision_items
         (id, revision_id, project_id, position, source_case_id, source_trace_id,
          source_dataset_item_id, source_golden_entry_id, input_digest, item_digest,
          payload_snapshot, reference_label, reference_fail_step, reference_provenance, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        `dsri_${randomUUID()}`,
        revisionId,
        input.projectId,
        position,
        item.sourceCaseId,
        item.sourceTraceId,
        item.sourceDatasetItemId,
        item.sourceGoldenEntryId,
        item.inputDigest,
        item.itemDigest,
        JSON.stringify(item.payloadSnapshot),
        item.referenceLabel,
        item.referenceFailStep,
        JSON.stringify(item.referenceProvenance),
        item.note
      ]
    );
  }
  await client.query(
    `insert into dataset_exposure_events
       (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
        subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
       values ($1,$2,$3,'created','lineage','revision_create',$4,$5,$6,
               'dataset_revision',$3,null,'{}'::jsonb,$7)`,
    [
      `dse_${randomUUID()}`,
      input.projectId,
      revisionId,
      input.createdByUserId ? "person" : "system",
      input.createdByUserId ?? null,
      input.createdByUserId ?? null,
      `revision-created:${revisionId}`
    ]
  );
  return revisionId;
}

export async function resolveCaseInputIdentity(
  client: PoolClient,
  projectId: string,
  caseId: string,
  rawPayloadValue: unknown
): Promise<ReturnType<typeof datasetInputIdentity>> {
  const existing = await client.query(
    `select identity_basis, input_digest
       from case_input_identity_records
       where project_id = $1 and source_case_id = $2 and input_digest is not null
       order by case when record_kind = 'authoring_import' then 0 else 1 end, created_at asc
       limit 1`,
    [projectId, caseId]
  );
  if (existing.rows[0]) {
    return { basis: "input-identity/v1", digest: String(existing.rows[0].input_digest) };
  }
  const rawPayload = parseJson(rawPayloadValue) as { input?: unknown } | null;
  if (!rawPayload || !("input" in rawPayload)) {
    throw new DatasetRevisionConflictError(
      `Case ${caseId} has no retained pre-redaction input identity; it remains legacy-exposed and cannot be frozen as exact evidence.`
    );
  }
  const identity = datasetInputIdentity({ input: rawPayload.input });
  await client.query(
    `insert into case_input_identity_records
       (id, project_id, source_case_id, record_kind, identity_basis, input_digest)
       values ($1,$2,$3,'identity_resolved',$4,$5)
       on conflict (project_id, source_case_id, record_kind) do nothing`,
    [`ciir_${randomUUID()}`, projectId, caseId, identity.basis, identity.digest]
  );
  return identity;
}

export async function loadHumanVerdictsForCases(
  client: PoolClient,
  projectId: string,
  caseIds: string[],
  criterionVersionId?: string | undefined
): Promise<Map<string, VerdictRecord[]>> {
  const byCase = new Map<string, VerdictRecord[]>();
  if (caseIds.length === 0) return byCase;
  const result = await client.query(
    `select verdict.* from verdicts verdict
       where verdict.project_id = $1 and verdict.case_id = any($2::text[])
         and verdict.source in ('human','adjudicated')
         and ($3::text is null or exists (
           select 1
           from skill_versions evaluator
           where evaluator.project_id = verdict.project_id
             and evaluator.id = verdict.skill_version_id
             and evaluator.criterion_version_id = $3
         ))
       order by verdict.created_at asc, verdict.id asc`,
    [projectId, caseIds, criterionVersionId ?? null]
  );
  for (const row of result.rows) {
    const verdict = rowToVerdictRecord(row);
    const bucket = byCase.get(verdict.caseId);
    if (bucket) bucket.push(verdict);
    else byCase.set(verdict.caseId, [verdict]);
  }
  return byCase;
}
