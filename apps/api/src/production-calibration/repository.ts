import type { ProductionCalibrationArtifact, ProductionDecisionLedgerRecord } from "@rubrist/shared";

// Durable production decision records (ADR-0013). Records are the source of
// truth for production monitoring: append-only per project, identical records
// stored once, and a decision ID bound to one content forever, so a bad write
// is rejected when it arrives instead of breaking every later report.

/** The most records one append may carry; ADR-0013 caps an ingest batch at 10,000. */
export const PRODUCTION_RECORD_APPEND_MAX_RECORDS = 10_000;

/**
 * The largest single record, as JSON bytes. Real records are a few kilobytes;
 * the bound keeps every stored row well inside the table's 256 KiB content
 * check even after PostgreSQL's jsonb text formatting adds its spacing.
 */
export const PRODUCTION_RECORD_MAX_BYTES = 65_536;

/** Who sent the records. Rubrist observes this; the record's own `by` field stays caller-asserted. */
export type ProductionRecordSubmitter =
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "user"; userId: string };

export interface AppendProductionRecordsInput {
  projectId: string;
  submitter: ProductionRecordSubmitter;
  /** Records already validated against the production decision record contract, in submission order. */
  records: readonly ProductionDecisionLedgerRecord[];
}

export interface AppendProductionRecordsResult {
  inserted: { decisions: number; actions: number; outcomes: number };
  /** Records identical to one already stored or repeated in this batch; nothing new was written for them. */
  duplicates: number;
  /** Actions and outcomes in this batch whose decision is not stored yet; they join when it arrives. */
  awaitingDecision: number;
}

/** The largest saved snapshot, in canonical JSON bytes; the table's own check enforces the same bound. */
export const PRODUCTION_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

/** The most stored records one report build may load, unless the deployment sets its own ceiling. */
export const PRODUCTION_REPORT_DEFAULT_MAX_RECORDS = 100_000;

/** Decisions a report covers, by decision time: `from` inclusive, `to` exclusive, null for no bound. */
export interface ProductionRecordWindow {
  from: Date | null;
  to: Date | null;
}

export interface LoadProductionRecordsInput {
  projectId: string;
  window: ProductionRecordWindow;
  /** A build that would load more records fails with `record_ceiling_exceeded`; it is never sampled. */
  maxRecords: number;
}

export interface LoadedProductionRecords {
  /** Ordered by `at`, then receive time, then content digest, so every build over the same records agrees. */
  records: ProductionDecisionLedgerRecord[];
  /** Digest of the sorted content digests of the loaded records. */
  recordSetDigest: string;
}

export interface SaveProductionSnapshotInput {
  projectId: string;
  userId: string;
  /** A report built from stored records; the store keeps its exact canonical bytes. */
  artifact: ProductionCalibrationArtifact;
  /** The build request's parameters, kept for listing. */
  parameters: Readonly<Record<string, unknown>>;
  recordCount: number;
  recordSetDigest: string;
}

export interface ProductionCalibrationSnapshotSummary {
  id: string;
  projectId: string;
  reportContract: string;
  artifactDigest: string;
  window: { from: string | null; to: string | null };
  parameters: Record<string, unknown>;
  recordCount: number;
  recordSetDigest: string;
  builtAt: string;
  createdByUserId: string;
  createdAt: string;
}

export interface ProductionCalibrationSnapshot {
  snapshot: ProductionCalibrationSnapshotSummary;
  /** Parsed from the stored bytes after their digest was verified. */
  artifact: ProductionCalibrationArtifact;
}

/** Retention for production records, in days (ADR-0013 section 5). */
export const PRODUCTION_RECORD_RETENTION_DEFAULT_DAYS = 90;
export const PRODUCTION_RECORD_RETENTION_MIN_DAYS = 1;
export const PRODUCTION_RECORD_RETENTION_MAX_DAYS = 730;

export interface ProductionRecordDeletionCounts {
  decisions: number;
  actions: number;
  outcomes: number;
}

export interface ProductionRetentionRun {
  /** Another instance held the retention lock, so this run deleted nothing. */
  skipped: boolean;
  /** Projects that lost records, with the receive-time cutoff that applied. */
  projects: Array<{ projectId: string; cutoff: string; deleted: ProductionRecordDeletionCounts }>;
}

export interface ProductionRecordActor {
  projectId: string;
  userId: string;
}

export interface ProductionDecisionRecordRepository {
  /** Append a batch atomically: every new record is written, or none is. */
  appendRecords(input: AppendProductionRecordsInput): Promise<AppendProductionRecordsResult>;
  /**
   * Load the decisions in the window with all of their actions and outcomes,
   * plus orphan actions and outcomes whose own `at` is in the window.
   */
  loadRecords(input: LoadProductionRecordsInput): Promise<LoadedProductionRecords>;
  saveSnapshot(input: SaveProductionSnapshotInput): Promise<ProductionCalibrationSnapshotSummary>;
  /** Newest first. */
  listSnapshots(projectId: string): Promise<ProductionCalibrationSnapshotSummary[]>;
  getSnapshot(projectId: string, snapshotId: string): Promise<ProductionCalibrationSnapshot | null>;
  getRetentionDays(projectId: string): Promise<number>;
  setRetentionDays(input: ProductionRecordActor & { retentionDays: number }): Promise<number>;
  /**
   * Delete whole decisions received before each project's cutoff with their
   * actions and outcomes, and orphans by their own receive time. One instance
   * runs at a time; each project that loses records gets an audit entry.
   */
  applyRetention(now: Date): Promise<ProductionRetentionRun>;
  /** Delete every record of one decision and leave a tombstone that rejects it later. */
  eraseDecision(input: ProductionRecordActor & { decisionId: string }): Promise<ProductionRecordDeletionCounts>;
  /** Delete every record a revoked API key sent. */
  purgeApiKeyRecords(input: ProductionRecordActor & { apiKeyId: string }): Promise<ProductionRecordDeletionCounts>;
  /** False when no such snapshot exists in the project. */
  deleteSnapshot(input: ProductionRecordActor & { snapshotId: string }): Promise<boolean>;
}

export type ProductionRecordRepositoryErrorCode =
  | "empty_batch"
  | "batch_too_large"
  | "invalid_record"
  | "record_too_large"
  | "future_dated_record"
  | "conflicting_decision"
  | "project_not_found"
  | "write_contention"
  | "record_ceiling_exceeded"
  | "snapshot_too_large"
  | "erased_decision"
  | "api_key_not_found"
  | "api_key_not_revoked"
  | "api_key_revoked";

export class ProductionRecordRepositoryError extends Error {
  constructor(
    readonly code: ProductionRecordRepositoryErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "ProductionRecordRepositoryError";
  }
}
