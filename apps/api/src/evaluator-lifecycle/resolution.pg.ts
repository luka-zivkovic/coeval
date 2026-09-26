import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ExecutionBindingSchema,
  ResolutionRecordSchema,
  VerdictKindSchema,
  type CapabilityProbe,
  type ExecutionBinding,
  type ResolutionRecord
} from "@rubrist/shared";
import type { GovernedBinding } from "../lib/binding-resolution.js";
import { sha256Digest } from "../lib/canonical-json.js";

// Persistence of resolution records and attempts (ADR-0014 section 4). The
// record is the latest resolution of a version's binding; every attempt and
// re-check is appended against the gate, run, or request that triggered it.

type Db = Pool | PoolClient;

export type ResolutionTriggerKind = "candidate_creation" | "activation" | "binary_calibration" | "binary_calibration_run" | "on_demand" | "version_save";

export interface ResolutionAttemptInput {
  projectId: string;
  skillVersionId: string | null;
  executionBinding: ExecutionBinding;
  kind: "resolution" | "recheck";
  triggerKind: ResolutionTriggerKind;
  triggerRef: string;
  outcome: ResolutionRecord["status"] | "holds" | "no_longer_holds" | "unknown";
  probes: readonly CapabilityProbe[];
}

const parseJson = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;

/**
 * A version's resolution record, only if it was resolved for exactly this
 * binding: a record for another binding (the version's binding changed out of
 * band) is no record at all.
 */
export async function loadResolutionRecord(
  db: Db,
  projectId: string,
  skillVersionId: string,
  binding: ExecutionBinding
): Promise<ResolutionRecord | null> {
  const row = (await db.query(
    `select record,binding_digest from evaluator_resolution_records where project_id=$1 and skill_version_id=$2`,
    [projectId, skillVersionId]
  )).rows[0];
  if (!row || String(row.binding_digest) !== sha256Digest(binding)) return null;
  return ResolutionRecordSchema.parse(parseJson(row.record));
}

/**
 * Stores a version's latest resolution record and returns the one stored. A
 * failed record for the same binding is never replaced (only a new evaluator
 * version fixes it), so a concurrent resolution can't turn failed into
 * resolved; the stored failed record is returned instead.
 */
export async function saveResolutionRecord(
  db: Db,
  projectId: string,
  skillVersionId: string,
  binding: ExecutionBinding,
  record: ResolutionRecord
): Promise<ResolutionRecord | null> {
  const parsed = ResolutionRecordSchema.parse(record);
  await db.query(
    `insert into evaluator_resolution_records (skill_version_id,project_id,binding_digest,status,record)
     values ($1,$2,$3,$4,$5::jsonb)
     on conflict (skill_version_id) do update
       set binding_digest=excluded.binding_digest,status=excluded.status,record=excluded.record,
           recorded_at=date_trunc('milliseconds',clock_timestamp())
     where evaluator_resolution_records.project_id=excluded.project_id
       and (evaluator_resolution_records.status<>'failed'
         or evaluator_resolution_records.binding_digest<>excluded.binding_digest)`,
    [skillVersionId, projectId, sha256Digest(binding), parsed.status, JSON.stringify(parsed)]
  );
  const owner = (await db.query(`select project_id from evaluator_resolution_records where skill_version_id=$1`, [skillVersionId])).rows[0];
  if (owner && String(owner.project_id) !== projectId) {
    throw new Error("The evaluator version's resolution record belongs to another project");
  }
  return loadResolutionRecord(db, projectId, skillVersionId, binding);
}

export async function appendResolutionAttempt(db: Db, input: ResolutionAttemptInput): Promise<void> {
  await db.query(
    `insert into evaluator_resolution_attempts
       (id,project_id,skill_version_id,binding_digest,kind,trigger_kind,trigger_ref,outcome,probes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [`era_${randomUUID()}`, input.projectId, input.skillVersionId, sha256Digest(input.executionBinding), input.kind,
      input.triggerKind, input.triggerRef, input.outcome, JSON.stringify(input.probes)]
  );
}

/**
 * How long ago, by the database clock, a run's latest re-check ended unknown,
 * so a run waiting on a transient error backs off; `null` when none did.
 */
export async function msSinceUnknownRecheck(db: Db, projectId: string, runId: string): Promise<number | null> {
  const row = (await db.query(
    `select floor(extract(epoch from (clock_timestamp()-max(recorded_at)))*1000)::bigint as elapsed
     from evaluator_resolution_attempts
     where project_id=$1 and trigger_kind='binary_calibration_run' and trigger_ref=$2 and kind='recheck' and outcome='unknown'`,
    [projectId, runId]
  )).rows[0];
  return row?.elapsed == null ? null : Number(row.elapsed);
}

/** A saved version's binding and verdict shape, as the gates and re-check resolve it; `null` when absent. */
export async function loadGovernedBinding(db: Db, projectId: string, skillVersionId: string): Promise<GovernedBinding | null> {
  const row = (await db.query(
    `select execution_binding,custom_endpoint_url,verdict_kind,scalar_range,categorical_choice_scores
     from skill_versions where project_id=$1 and id=$2`,
    [projectId, skillVersionId]
  )).rows[0];
  if (!row) return null;
  return {
    projectId,
    executionBinding: ExecutionBindingSchema.parse(parseJson(row.execution_binding)),
    customEndpointUrl: row.custom_endpoint_url == null ? null : String(row.custom_endpoint_url),
    spec: {
      verdictKind: VerdictKindSchema.parse(row.verdict_kind),
      scalarRange: row.scalar_range == null ? null : parseJson(row.scalar_range) as [number, number],
      categoricalChoiceScores: row.categorical_choice_scores == null ? null : parseJson(row.categorical_choice_scores) as Record<string, number>
    }
  };
}
