import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ProductionDecisionLedgerRecord } from "@rubrist/shared";
import { LedgerParseError, parseLedgerRecords } from "./ledger.js";
import {
  ProductionRecordRepositoryError,
  type ProductionDecisionRecordRepository,
  type ProductionRecordRepositoryErrorCode
} from "./repository.js";

// Durable production ingest (ADR-0013 §4). A key with the `production_ingest`
// capability appends decision, action, and outcome records to its project;
// the /api/v1 middleware has already resolved the key and refused every other
// capability. Batches are atomic and retry-safe: identical records are no-ops.

export const PRODUCTION_INGEST_PATH = "/api/v1/production-decisions";

/** The ingest body ceiling; ADR-0013 caps a batch at 4 MiB. */
export const PRODUCTION_INGEST_MAX_BODY_BYTES = 4 * 1024 * 1024;

const JSON_BODY_SCHEMA = z.object({
  /** JSON Lines text, or an array of records. */
  records: z.union([z.string(), z.array(z.unknown())])
}).strict();

export interface ProductionIngestIdentity {
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface CreateProductionIngestRouterOptions {
  repository: ProductionDecisionRecordRepository | null;
  requestIdentity: (context: Context) => ProductionIngestIdentity;
  takeIngestRecords: (apiKeyId: string, count: number) => boolean;
}

/** HTTP status for a repository rejection; shared with the session import route. */
export function productionRecordErrorStatus(code: ProductionRecordRepositoryErrorCode): 400 | 404 | 409 | 413 | 503 {
  switch (code) {
    case "batch_too_large":
    case "record_too_large":
      return 413;
    case "conflicting_decision":
      return 409;
    case "project_not_found":
      return 404;
    case "write_contention":
      return 503;
    case "empty_batch":
    case "invalid_record":
    case "future_dated_record":
      return 400;
  }
}

export function createProductionIngestRouter(options: CreateProductionIngestRouterOptions): Hono {
  const router = new Hono();
  router.post("/", async (context) => {
    if (!options.repository) {
      return context.json({
        error: "Production ingest requires database-backed mode",
        code: "production_ingest_database_required"
      }, 501);
    }
    const identity = options.requestIdentity(context);
    if (!identity.apiKeyId) {
      return context.json({ error: "A production-ingest API key is required", code: "production_ingest_api_key_required" }, 401);
    }
    const parsed = await readRecords(context);
    if (parsed instanceof Response) return parsed;
    if (!options.takeIngestRecords(identity.apiKeyId, Math.max(1, parsed.length))) {
      context.header("retry-after", "60");
      return context.json({
        error: "Production ingest record budget exceeded for this API key",
        code: "production_ingest_rate_limited"
      }, 429);
    }
    try {
      const result = await options.repository.appendRecords({
        projectId: identity.projectId,
        submitter: { kind: "api_key", apiKeyId: identity.apiKeyId },
        records: parsed
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof ProductionRecordRepositoryError) {
        if (error.code === "write_contention") context.header("retry-after", "1");
        return context.json({
          error: error.message,
          code: `production_ingest_${error.code}`,
          details: error.details
        }, productionRecordErrorStatus(error.code));
      }
      throw error;
    }
  });
  return router;
}

/**
 * JSON Lines as the raw body (`application/x-ndjson`, `application/jsonl`, or
 * `text/plain`), or JSON `{ "records": ... }` like the preview route.
 */
async function readRecords(context: Context): Promise<ProductionDecisionLedgerRecord[] | Response> {
  const contentType = (context.req.header("content-type") ?? "").toLowerCase();
  let input: string | readonly unknown[];
  if (/^(application\/(x-)?ndjson|application\/jsonl|text\/plain)\b/.test(contentType)) {
    input = await context.req.text();
  } else {
    let body: unknown;
    try {
      body = JSON.parse(await context.req.text());
    } catch {
      return context.json({ error: "Invalid JSON request body", code: "production_ingest_invalid_request" }, 400);
    }
    const parsed = JSON_BODY_SCHEMA.safeParse(body);
    if (!parsed.success) {
      return context.json({
        error: "Send JSON Lines, or JSON of the form { \"records\": ... }",
        code: "production_ingest_invalid_request",
        details: { validation: z.treeifyError(parsed.error) }
      }, 400);
    }
    input = parsed.data.records;
  }
  try {
    return parseLedgerRecords(input);
  } catch (error) {
    if (error instanceof LedgerParseError) {
      return context.json({ error: error.message, code: "production_ingest_invalid_record", details: error.details }, 400);
    }
    throw error;
  }
}
