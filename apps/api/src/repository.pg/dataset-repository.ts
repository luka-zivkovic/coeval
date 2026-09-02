import { randomUUID } from "node:crypto";
import {
  verdictLabelFromPayload,
  type Dataset,
  type DatasetDetail,
  type DatasetItem,
  type DatasetReferenceProvenance,
  type DatasetRevision,
  type DatasetRevisionDetail,
  type DatasetRevisionPayloadSnapshot
} from "@coeval/shared";
import type { Pool } from "pg";
import {
  datasetRevisionItemDigest,
  decidePublicDatasetRevisionCreation
} from "../lib/dataset-revision.js";
import type {
  AddDatasetItemsInputDb,
  CreateDatasetInputDb,
  CreateDatasetRevisionDbInput,
  ImportDatasetExamplesDbInput,
  ImportDatasetExamplesDbResult
} from "../repository.js";
import {
  CaseNotFoundError,
  DatasetNameTakenError,
  DatasetNotFoundError,
  DatasetRevisionConflictError,
  DatasetRevisionNotFoundError,
  SealedValidationUnavailableError
} from "../repository/errors.js";
import type { DatasetRepositoryPort } from "../repository/ports.js";
import {
  getOrCreateRegressionDatasetRevisionWithClient,
  insertDatasetRevisionWithClient,
  loadHumanVerdictsForCases,
  resolveCaseInputIdentity,
  resolveSingletonCriterionVersionForRegression
} from "./dataset-revision-commands.js";
import {
  isCheckViolation,
  isUniqueViolation,
  normalizedPayloadSnapshot,
  postgresErrorMessage,
  rowToDataset,
  rowToDatasetExposureEvent,
  rowToDatasetItem,
  rowToDatasetRevision,
  rowToDatasetRevisionItem
} from "./mappers.js";
import { importTraceOnClient, lockTraceImportIdentity } from "./trace-import-commands.js";

// PostgreSQL mutable dataset authoring and immutable revision persistence.
// Import and freeze operations retain their caller-owned atomic boundaries;
// regression revisions remain governed evidence, not release policy.
export class PgDatasetRepository implements DatasetRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async createDataset(input: CreateDatasetInputDb): Promise<Dataset> {
    try {
      const result = await this.pool.query(
        `insert into datasets (id, project_id, name, description, kind, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6)
         returning *`,
        [
          `ds_${randomUUID()}`,
          input.projectId,
          input.name.trim(),
          input.description ?? null,
          input.kind ?? "custom",
          input.createdByUserId ?? null
        ]
      );
      return rowToDataset(result.rows[0], 0);
    } catch (error) {
      // The partial unique index on (project_id, name) where archived_at is
      // null is the real guard — translate its violation to the domain error.
      if (isUniqueViolation(error)) throw new DatasetNameTakenError(input.name.trim());
      throw error;
    }
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    const result = await this.pool.query(
      `select d.*, count(di.id)::int as item_count
       from datasets d
       left join dataset_items di on di.dataset_id = d.id
       where d.project_id = $1 and d.archived_at is null
       group by d.id
       order by d.created_at desc`,
      [projectId]
    );
    return result.rows.map((row) => rowToDataset(row, Number(row.item_count)));
  }

  async getDatasetDetail(projectId: string, datasetId: string): Promise<DatasetDetail | null> {
    const datasetResult = await this.pool.query(
      `select * from datasets where id = $1 and project_id = $2`,
      [datasetId, projectId]
    );
    const datasetRow = datasetResult.rows[0];
    if (!datasetRow) return null;
    const itemsResult = await this.pool.query(
      `select * from dataset_items where dataset_id = $1 order by added_at asc, id asc`,
      [datasetId]
    );
    const items = itemsResult.rows.map(rowToDatasetItem);
    return { ...rowToDataset(datasetRow, items.length), items };
  }

  async archiveDataset(projectId: string, datasetId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update datasets set archived_at = now()
       where id = $1 and project_id = $2 and archived_at is null`,
      [datasetId, projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async addDatasetItems(input: AddDatasetItemsInputDb): Promise<DatasetItem[]> {
    const datasetResult = await this.pool.query(
      `select id from datasets where id = $1 and project_id = $2 and archived_at is null`,
      [input.datasetId, input.projectId]
    );
    if (!datasetResult.rows[0]) throw new DatasetNotFoundError(input.datasetId);

    // Validate every case belongs to the project before inserting any — the
    // caller gets all-or-nothing semantics on bad input.
    const caseIds = [...new Set(input.items.map((item) => item.caseId))];
    const known = await this.pool.query(
      `select id from cases where project_id = $1 and id = any($2::text[])`,
      [input.projectId, caseIds]
    );
    const knownIds = new Set(known.rows.map((row) => String(row.id)));
    const missing = caseIds.find((caseId) => !knownIds.has(caseId));
    if (missing) throw new CaseNotFoundError(missing);

    for (const item of input.items) {
      // Idempotent add with label upsert: re-adding a case can update its
      // expected label / note, but a label-less append (e.g. the batch judge
      // route) never nulls an existing label — coalesce keeps the old value.
      // Eval-run history is safe either way: expected_label is snapshotted
      // onto eval_run_items at run creation. trace_id mirrors the user-facing
      // id convention elsewhere (source_trace_id when imported, case id
      // otherwise).
      await this.pool.query(
        `insert into dataset_items (id, dataset_id, project_id, case_id, trace_id, expected_label, expected_fail_step, note)
         select $1, $2, $3, c.id, coalesce(rt.source_trace_id, c.id), $5, $6, $7
         from cases c
         left join raw_traces rt on rt.id = c.raw_trace_id
         where c.id = $4 and c.project_id = $3
         on conflict (dataset_id, case_id) do update set
           expected_label = coalesce(excluded.expected_label, dataset_items.expected_label),
           -- Locked M2 invariant: an explicit re-label to pass CLEARS the
           -- stored step; a fail (or label-less) upsert without a step keeps it.
           expected_fail_step = case
             when excluded.expected_label = 'pass' then null
             when excluded.expected_fail_step is not null then excluded.expected_fail_step
             else dataset_items.expected_fail_step
           end,
           note = coalesce(excluded.note, dataset_items.note)`,
        [
          `dsi_${randomUUID()}`,
          input.datasetId,
          input.projectId,
          item.caseId,
          item.expectedLabel ?? null,
          item.expectedFailStep ?? null,
          item.note ?? null
        ]
      );
    }
    const itemsResult = await this.pool.query(
      `select * from dataset_items where dataset_id = $1 order by added_at asc, id asc`,
      [input.datasetId]
    );
    return itemsResult.rows.map(rowToDatasetItem);
  }

  // Skill Bench bulk ingestion (M0 C2): mint/dedup every example case AND its
  // dataset membership in one transaction — all-or-nothing, no orphaned cases
  // on a mid-flow failure. Items must be pre-deduped by sourceTraceId (the
  // route coalesces within-batch duplicates before calling).
  async importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Re-check the dataset INSIDE the transaction — the route's pre-check
      // can race a concurrent archive.
      const dataset = await client.query(
        `select id from datasets where id = $1 and project_id = $2 and archived_at is null for update`,
        [input.datasetId, input.projectId]
      );
      if (!dataset.rows[0]) throw new DatasetNotFoundError(input.datasetId);

      // A batch holds every import-identity lock until commit. Acquire its
      // unique identities in one canonical order so concurrent batches with
      // reversed item order cannot deadlock. importTraceOnClient reacquires
      // the same transaction lock per item, which is safe and immediate.
      const sourceTraceIds = [...new Set(input.items
        .map((item) => item.sourceTraceId.trim())
        .filter((sourceTraceId) => sourceTraceId.length > 0))]
        .sort();
      for (const sourceTraceId of sourceTraceIds) {
        await lockTraceImportIdentity(client, input.projectId, "manual", sourceTraceId);
      }

      const results: ImportDatasetExamplesDbResult["items"] = [];
      for (const item of input.items) {
        const imported = await importTraceOnClient(client, input.projectId, "manual", {
          sourceTraceId: item.sourceTraceId,
          input: item.input,
          output: item.output,
          metadata: item.metadata,
          ...(item.steps ? { steps: item.steps } : {})
        }, { ingestionPurpose: input.ingestionPurpose });
        // Same coalescing upsert as addDatasetItems (kept in sync): labels
        // update on re-import, label-less appends never null a stored label.
        const datasetItem = await client.query(
          `insert into dataset_items (id, dataset_id, project_id, case_id, trace_id, expected_label, expected_fail_step, note)
           select $1, $2, $3, c.id, coalesce(rt.source_trace_id, c.id), $5, $6, $7
           from cases c
           left join raw_traces rt on rt.id = c.raw_trace_id
           where c.id = $4 and c.project_id = $3
           on conflict (dataset_id, case_id) do update set
             expected_label = coalesce(excluded.expected_label, dataset_items.expected_label),
             expected_fail_step = case
             when excluded.expected_label = 'pass' then null
             when excluded.expected_fail_step is not null then excluded.expected_fail_step
             else dataset_items.expected_fail_step
           end,
             note = coalesce(excluded.note, dataset_items.note)
           returning id`,
          [
            `dsi_${randomUUID()}`,
            input.datasetId,
            input.projectId,
            imported.caseId,
            item.expectedLabel ?? null,
            item.expectedFailStep ?? null,
            item.note ?? null
          ]
        );
        results.push({
          sourceTraceId: imported.sourceTraceId,
          caseId: imported.caseId,
          created: imported.created,
          datasetItemId: datasetItem.rows[0] ? String(datasetItem.rows[0].id) : null
        });
      }
      await client.query("commit");
      return { items: results };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createDatasetRevision(input: CreateDatasetRevisionDbInput): Promise<DatasetRevisionDetail> {
    const creation = decidePublicDatasetRevisionCreation(input.role);
    if (!creation.allowed) {
      if (creation.code === "rejected_public_sealed_creation_unavailable") throw new SealedValidationUnavailableError();
      if (creation.code === "rejected_public_regression_creation_unavailable") {
        throw new DatasetRevisionConflictError(
          "Regression/golden revisions are created only by promotion and retirement governance"
        );
      }
      throw new DatasetRevisionConflictError("Unknown dataset revision role");
    }
    const client = await this.pool.connect();
    let revisionId: string | null = null;
    try {
      await client.query("begin");
      const project = await client.query(`select id from projects where id = $1 for update`, [input.projectId]);
      if (!project.rows[0]) throw new Error(`Project not found: ${input.projectId}`);
      const datasetResult = await client.query(
        `select * from datasets
         where id = $1 and project_id = $2 and archived_at is null
         for update`,
        [input.datasetId, input.projectId]
      );
      if (!datasetResult.rows[0]) throw new DatasetNotFoundError(input.datasetId);

      if (input.idempotencyKey) {
        const existing = await client.query(
          `select id, source_dataset_id, role
           from dataset_revisions where project_id = $1 and idempotency_key = $2`,
          [input.projectId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (
            String(existing.rows[0].source_dataset_id) !== input.datasetId ||
            String(existing.rows[0].role) !== input.role
          ) {
            throw new DatasetRevisionConflictError("Idempotency key was already used for a different dataset revision request");
          }
          revisionId = String(existing.rows[0].id);
          await client.query("commit");
          const detail = await this.getDatasetRevisionDetail(input.projectId, revisionId);
          if (!detail) throw new DatasetRevisionConflictError("Idempotent dataset revision vanished");
          return detail;
        }
      }

      const rows = await client.query(
        `select di.*, c.normalized_payload, rt.raw_payload
         from dataset_items di
         join cases c on c.id = di.case_id and c.project_id = di.project_id
         left join raw_traces rt on rt.id = c.raw_trace_id
         where di.dataset_id = $1 and di.project_id = $2
         order by di.added_at asc, di.id asc`,
        [input.datasetId, input.projectId]
      );
      if (rows.rows.length === 0) throw new DatasetRevisionConflictError("Cannot freeze an empty working collection");

      const verdicts = await loadHumanVerdictsForCases(client, input.projectId, rows.rows.map((row) => String(row.case_id)));
      const prepared = [] as Array<{
        sourceCaseId: string;
        sourceTraceId: string;
        sourceDatasetItemId: string;
        sourceGoldenEntryId: null;
        payloadSnapshot: DatasetRevisionPayloadSnapshot;
        inputDigest: string;
        itemDigest: string;
        referenceLabel: "pass" | "fail" | null;
        referenceFailStep: number | null;
        referenceProvenance: DatasetReferenceProvenance;
        note: string | null;
      }>;
      for (const row of rows.rows) {
        const caseId = String(row.case_id);
        const payloadSnapshot = normalizedPayloadSnapshot(row.normalized_payload);
        const identity = await resolveCaseInputIdentity(client, input.projectId, caseId, row.raw_payload);
        const referenceLabel = row.expected_label === "pass" || row.expected_label === "fail"
          ? row.expected_label as "pass" | "fail"
          : null;
        const matching = referenceLabel
          ? (verdicts.get(caseId) ?? []).filter((verdict) => verdictLabelFromPayload(verdict.payload) === referenceLabel)
          : [];
        const adjudicated = matching.filter((verdict) => verdict.source === "adjudicated");
        const human = matching.filter((verdict) => verdict.source === "human");
        const supporting = adjudicated.length > 0 ? adjudicated : human;
        const referenceProvenance: DatasetReferenceProvenance = referenceLabel === null
          ? {
              kind: "unlabeled",
              sourceId: String(row.id),
              verdictIds: [],
              actorUserIds: [],
              basis: "No reference label was present when the collection was frozen."
            }
          : supporting.length > 0
            ? {
                kind: adjudicated.length > 0 ? "adjudication" : "human_verdict",
                sourceId: String(row.id),
                verdictIds: supporting.map((verdict) => verdict.id),
                actorUserIds: supporting.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
                basis: adjudicated.length > 0
                  ? "Dataset expectation matched retained adjudicated truth."
                  : "Dataset expectation matched retained human verdict history."
              }
            : {
                kind: "dataset_claim",
                sourceId: String(row.id),
                verdictIds: [],
                actorUserIds: [],
                basis: "Mutable collection expectation; not adjudicated human truth."
              };
        const referenceFailStep = row.expected_fail_step === null || row.expected_fail_step === undefined
          ? null
          : Number(row.expected_fail_step);
        const itemDigest = datasetRevisionItemDigest({
          inputIdentity: identity,
          redactedPayload: payloadSnapshot,
          referenceLabel,
          expectedFailStep: referenceFailStep,
          reviewProvenance: referenceProvenance,
          note: row.note === null || row.note === undefined ? null : String(row.note)
        });
        prepared.push({
          sourceCaseId: caseId,
          sourceTraceId: String(row.trace_id),
          sourceDatasetItemId: String(row.id),
          sourceGoldenEntryId: null,
          payloadSnapshot,
          inputDigest: identity.digest,
          itemDigest,
          referenceLabel,
          referenceFailStep,
          referenceProvenance,
          note: row.note === null || row.note === undefined ? null : String(row.note)
        });
      }

      const sealedOverlap = await client.query(
        `select distinct revision.id
         from dataset_revision_items item
         join dataset_revisions revision on revision.id = item.revision_id
         where revision.project_id = $1
           and revision.role = 'sealed_validation'
           and item.input_digest = any($2::text[])
         limit 1`,
        [input.projectId, prepared.map((item) => item.inputDigest)]
      );
      if (sealedOverlap.rows[0]) {
        throw new DatasetRevisionConflictError(
          "Working collection overlaps sealed validation input; explicit governed declassification is required before nonsealed use"
        );
      }

      revisionId = await insertDatasetRevisionWithClient(client, {
        projectId: input.projectId,
        seriesId: `dataset:${input.datasetId}`,
        sourceDatasetId: input.datasetId,
        role: input.role,
        sourceKind: "collection_snapshot",
        provenanceLevel: "unverified",
        expectedParentRevisionId: input.expectedParentRevisionId,
        idempotencyKey: input.idempotencyKey,
        reuseLatestContent: input.reuseLatestContent,
        createdByUserId: input.createdByUserId,
        items: prepared
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (isCheckViolation(error)) {
        throw new DatasetRevisionConflictError(postgresErrorMessage(error));
      }
      throw error;
    } finally {
      client.release();
    }
    const detail = revisionId ? await this.getDatasetRevisionDetail(input.projectId, revisionId) : null;
    if (!detail) throw new DatasetRevisionConflictError("Dataset revision vanished after creation");
    return detail;
  }

  async listDatasetRevisions(projectId: string, sourceDatasetId?: string): Promise<DatasetRevision[]> {
    const result = await this.pool.query(
      `select revision.*,
              exists (
                select 1 from dataset_exposure_events exposure
                where exposure.revision_id = revision.id and exposure.exposure_class = 'development'
              ) as has_development_exposure
       from dataset_revisions revision
       where revision.project_id = $1
         and ($2::text is null or revision.source_dataset_id = $2)
       order by revision.created_at desc, revision.id desc`,
      [projectId, sourceDatasetId ?? null]
    );
    return result.rows.map(rowToDatasetRevision);
  }

  async getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null> {
    const [revisionResult, itemResult, exposureResult] = await Promise.all([
      this.pool.query(
        `select revision.*,
                exists (
                  select 1 from dataset_exposure_events exposure
                  where exposure.revision_id = revision.id and exposure.exposure_class = 'development'
                ) as has_development_exposure
         from dataset_revisions revision
         where revision.id = $1 and revision.project_id = $2`,
        [revisionId, projectId]
      ),
      this.pool.query(
        `select * from dataset_revision_items
         where revision_id = $1 and project_id = $2
         order by position asc`,
        [revisionId, projectId]
      ),
      this.pool.query(
        `select * from dataset_exposure_events
         where revision_id = $1 and project_id = $2
         order by occurred_at asc, id asc`,
        [revisionId, projectId]
      )
    ]);
    if (!revisionResult.rows[0]) return null;
    return {
      ...rowToDatasetRevision(revisionResult.rows[0]),
      items: itemResult.rows.map(rowToDatasetRevisionItem),
      exposures: exposureResult.rows.map(rowToDatasetExposureEvent)
    };
  }

  async recordDatasetRevisionContentView(input: {
    projectId: string;
    revisionId: string;
    actorUserId?: string | undefined;
  }): Promise<void> {
    const inserted = await this.pool.query(
      `insert into dataset_exposure_events
       (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
        subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
       select $1, revision.project_id, revision.id, 'human_access', 'development', 'content_view',
              $4, $5, $5, 'dataset_revision', revision.id, null, '{}'::jsonb, $6
       from dataset_revisions revision
       where revision.id = $2 and revision.project_id = $3
       returning id`,
      [
        `dse_${randomUUID()}`,
        input.revisionId,
        input.projectId,
        input.actorUserId ? "person" : "system",
        input.actorUserId ?? null,
        `content-view:${input.revisionId}:${randomUUID()}`
      ]
    );
    if (!inserted.rows[0]) throw new DatasetRevisionNotFoundError(input.revisionId);
  }

  async getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string,
    criterionVersionId?: string
  ): Promise<DatasetRevisionDetail> {
    const client = await this.pool.connect();
    let revisionId: string;
    try {
      await client.query("begin");
      const resolvedCriterionVersionId = criterionVersionId
        ?? await resolveSingletonCriterionVersionForRegression(client, projectId);
      revisionId = await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        projectId,
        resolvedCriterionVersionId,
        actorUserId
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const detail = await this.getDatasetRevisionDetail(projectId, revisionId);
    if (!detail) throw new DatasetRevisionConflictError("Regression dataset revision vanished after creation");
    return detail;
  }

  async removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from dataset_items where id = $1 and dataset_id = $2 and project_id = $3`,
      [itemId, datasetId, projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
