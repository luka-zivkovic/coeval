import { GoldenSetRetirementContextSchema, type GoldenSetRetirementContext } from "@coeval/shared";
import type { ApiError } from "./api";
import { formatTimestamp, isPlainRecord } from "./utils";

export function formatStaleRetirementNotice(error: ApiError): string {
  if (error.status === 404) return "Golden-set entry was not found. Refreshed the golden set.";
  const retirement = retirementContextFromBody(error.body);
  if (!retirement) return "Golden-set entry was already retired. Refreshed the golden set.";

  const details = [
    retirement.retiredBy ? `by ${retirement.retiredBy}` : null,
    retirement.retiredAt ? `on ${formatTimestamp(retirement.retiredAt)}` : null
  ].filter(Boolean).join(" ");
  const reason = retirement.reason ? ` Reason: ${retirement.reason}` : "";
  return `Golden-set entry was already retired${details ? ` ${details}` : ""}. Refreshed the golden set.${reason}`;
}

export function retirementContextFromBody(body: unknown): GoldenSetRetirementContext | null {
  if (!isPlainRecord(body)) return null;
  const parsed = GoldenSetRetirementContextSchema.safeParse(body.retirement);
  return parsed.success ? parsed.data : null;
}
