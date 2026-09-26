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

export type ResolutionTriggerKind = "candidate_creation" | "activation" | "binary_calibration" | "binary_calibration_run" | "on_demand";

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

export async function loadResolutionRecord(db: Db, projectId: string, skillVersionId: string): Promise<ResolutionRecord | null> {
  const row = (await db.query(
    `select record from evaluator_resolution_records where project_id=$1 and skill_version_id=$2`,
    [projectId, skillVersionId]
  )).rows[0];
  return row ? ResolutionRecordSchema.parse(parseJson(row.record)) : null;
}

/** Stores a version's latest resolution record, replacing the one before it. */
export async function saveResolutionRecord(db: Db, projectId: string, skillVersionId: string, record: ResolutionRecord): Promise<void> {
  const parsed = ResolutionRecordSchema.parse(record);
  await db.query(
    `insert into evaluator_resolution_records (skill_version_id,project_id,status,record)
     values ($1,$2,$3,$4::jsonb)
     on conflict (skill_version_id) do update
       set status=excluded.status,record=excluded.record,
           recorded_at=date_trunc('milliseconds',clock_timestamp())
     where evaluator_resolution_records.project_id=excluded.project_id`,
    [skillVersionId, projectId, parsed.status, JSON.stringify(parsed)]
  );
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

/** When the latest unknown re-check for a run happened, so a run waiting on a transient error backs off. */
export async function latestUnknownRecheckAt(db: Db, projectId: string, runId: string): Promise<Date | null> {
  const row = (await db.query(
    `select max(recorded_at) as recorded_at from evaluator_resolution_attempts
     where project_id=$1 and trigger_kind='binary_calibration_run' and trigger_ref=$2 and kind='recheck' and outcome='unknown'`,
    [projectId, runId]
  )).rows[0];
  return row?.recorded_at ? new Date(row.recorded_at) : null;
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
