import type { ProductionDecisionLedgerRecord } from "@rubrist/shared";

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

export interface ProductionDecisionRecordRepository {
  /** Append a batch atomically: every new record is written, or none is. */
  appendRecords(input: AppendProductionRecordsInput): Promise<AppendProductionRecordsResult>;
}

export type ProductionRecordRepositoryErrorCode =
  | "empty_batch"
  | "batch_too_large"
  | "invalid_record"
  | "record_too_large"
  | "future_dated_record"
  | "conflicting_decision"
  | "project_not_found"
  | "write_contention";

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
