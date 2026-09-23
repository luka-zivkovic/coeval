import { z } from "zod";
import {
  ProductionDecisionLedgerRecordSchema,
  type ProductionDecisionLedgerRecord
} from "@rubrist/shared";

// One ledger parser for every route that accepts decision records, so the
// compute-only preview and the durable ingest paths reject exactly the same
// input with exactly the same line numbers.

export interface LedgerParseErrorDetails {
  line: number;
  reason: "invalid_json" | "invalid_record";
  validation?: unknown;
}

export class LedgerParseError extends Error {
  constructor(message: string, readonly details: LedgerParseErrorDetails) {
    super(message);
    this.name = "LedgerParseError";
  }
}

/**
 * Parse JSON Lines text or an array of records, validating each against the
 * shared record contract. The first bad line stops the parse and is named by
 * its one-based line number (or array position).
 */
export function parseLedgerRecords(input: string | readonly unknown[]): ProductionDecisionLedgerRecord[] {
  const entries: Array<{ line: number; value: unknown }> = [];
  if (typeof input === "string") {
    const lines = input.split("\n");
    for (const [index, raw] of lines.entries()) {
      const text = raw.replace(/\r$/, "");
      if (text.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new LedgerParseError(`Line ${index + 1} is not valid JSON`, { line: index + 1, reason: "invalid_json" });
      }
      entries.push({ line: index + 1, value });
    }
  } else {
    input.forEach((value, index) => entries.push({ line: index + 1, value }));
  }
  return entries.map(({ line, value }) => {
    const parsed = ProductionDecisionLedgerRecordSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.map(String).join(".")}` : "";
      throw new LedgerParseError(
        `Line ${line} is not a valid production decision record${where}: ${issue?.message ?? "invalid record"}`,
        { line, reason: "invalid_record", validation: z.treeifyError(parsed.error) }
      );
    }
    return parsed.data;
  });
}
