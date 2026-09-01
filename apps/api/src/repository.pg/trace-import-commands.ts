import { randomUUID } from "node:crypto";
import type { CaseSource, ManualTraceImportInput } from "@coeval/shared";
import { isInternalTraceMetadata } from "@coeval/shared";
import type { PoolClient } from "pg";
import { datasetInputIdentity } from "../lib/dataset-revision.js";
import { normalizeTracePayload, redactNormalizedTracePayload } from "../lib/redaction.js";
import type { TraceImportContext, TraceImportResult } from "../repository/contracts.js";
import { RecursiveTraceSkippedError } from "../repository/errors.js";
import { assertTraceIngestionPurpose } from "../repository/helpers.js";

export async function lockTraceImportIdentity(
  client: PoolClient,
  projectId: string,
  source: CaseSource,
  sourceTraceId: string,
  sourceTraceVersion?: string | undefined,
  sourceRemoteProjectId?: string | undefined
): Promise<void> {
  await client.query(
    `select pg_advisory_xact_lock(
         hashtextextended(jsonb_build_array($1::text, $2::text, $3::text, $4::text, $5::text)::text, 0)
       )`,
    [
      projectId,
      source,
      sourceRemoteProjectId ?? null,
      sourceTraceId,
      sourceTraceVersion ?? null
    ]
  );
}

// The import body, callable inside a caller-owned transaction — the examples
// bulk path runs many of these plus the dataset-membership writes in ONE
// transaction so a mid-flow failure can't strand membership-less cases.
export async function importTraceOnClient(
  client: PoolClient,
  projectId: string,
  source: CaseSource,
  input: ManualTraceImportInput,
  context: TraceImportContext
): Promise<TraceImportResult> {
  assertTraceIngestionPurpose(source, context.ingestionPurpose);
  if (isInternalTraceMetadata(input.metadata)) {
    throw new RecursiveTraceSkippedError(input.sourceTraceId);
  }
  const rawTraceId = `raw_${randomUUID()}`;
  const caseId = `case_${randomUUID()}`;
  const sourceTraceId = input.sourceTraceId?.trim() || `${source}_${randomUUID()}`;
  const normalizationVersion = context.normalizationVersion ?? `${source}-v1`;
  const rawPayload = normalizeTracePayload(input);
  const normalizedPayload = redactNormalizedTracePayload(rawPayload, context.redactionConfig);

  // Purpose records the immutable first origin; it does not create a second
  // identity for the same upstream trace. Serialize this identity before
  // checking so concurrent product paths cannot both mint an origin.
  await lockTraceImportIdentity(
    client,
    projectId,
    source,
    sourceTraceId,
    context.sourceTraceVersion,
    context.sourceRemoteProjectId
  );
  const existing = await client.query(
    `select rt.id as raw_trace_id, c.id as case_id, rt.source_trace_id
       from raw_traces rt
       join cases c on c.raw_trace_id = rt.id
       where rt.project_id = $1
         and c.project_id = $1
         and rt.source_trace_id = $2
         and c.case_type = $3
         and rt.source_trace_version is not distinct from $4::text
         and rt.source_remote_project_id is not distinct from $5::text
       order by c.created_at asc, c.id asc, rt.created_at asc, rt.id asc
       limit 1`,
    [
      projectId,
      sourceTraceId,
      source,
      context.sourceTraceVersion ?? null,
      context.sourceRemoteProjectId ?? null
    ]
  );
  if (existing.rows[0]) {
    return {
      rawTraceId: String(existing.rows[0].raw_trace_id),
      caseId: String(existing.rows[0].case_id),
      sourceTraceId: String(existing.rows[0].source_trace_id),
      created: false
    };
  }

  await client.query(
    `insert into raw_traces
       (id, project_id, source_integration_id, source_remote_project_id,
        source_trace_id, source_trace_version, import_job_id, raw_payload,
        normalization_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      rawTraceId,
      projectId,
      context.sourceIntegrationId ?? null,
      context.sourceRemoteProjectId ?? null,
      sourceTraceId,
      context.sourceTraceVersion ?? null,
      context.importJobId ?? null,
      JSON.stringify(rawPayload),
      normalizationVersion
    ]
  );
  await client.query(
    `insert into cases
       (id, project_id, raw_trace_id, case_type, normalized_payload, ingestion_purpose)
       values ($1,$2,$3,$4,$5,$6)`,
    [caseId, projectId, rawTraceId, source, JSON.stringify(normalizedPayload), context.ingestionPurpose]
  );
  const inputIdentity = datasetInputIdentity({ input: input.input });
  await client.query(
    `insert into case_input_identity_records
       (id, project_id, source_case_id, record_kind, identity_basis, input_digest)
       values ($1,$2,$3,'authoring_import',$4,$5)
       on conflict (project_id, source_case_id, record_kind) do nothing`,
    [`ciir_${randomUUID()}`, projectId, caseId, inputIdentity.basis, inputIdentity.digest]
  );
  // Gate candidates are product-gate scaffolding, not imported customer
  // traffic — they must not move the imported-trace counter (mirrors the
  // refreshProjectCounters recount, which also skips them).
  if (source !== "gate_candidate" && source !== "release_evidence") {
    await client.query(
      `update projects
         set imported_trace_count = imported_trace_count + 1,
             updated_at = now()
         where id = $1`,
      [projectId]
    );
  }
  return { rawTraceId, caseId, sourceTraceId, created: true };
}
