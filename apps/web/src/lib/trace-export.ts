import type { VerdictSource } from "@coeval/shared";
import { buildVerdictExportUrl } from "./api.js";

export type TraceSourceFilter = "all" | VerdictSource;

export const VERDICT_SOURCE_LABEL: Record<VerdictSource, string> = {
  llm_judge: "LLM judge",
  human: "Human",
  adjudicated: "Adjudicated",
  imported_external: "Imported"
};

export function buildTraceExportPresentation(input: {
  criterionId: string | null;
  sourceFilter: TraceSourceFilter;
  versionFilter: string;
}): { url: string; title: string } {
  const { criterionId, sourceFilter, versionFilter } = input;
  const url = buildVerdictExportUrl({
    format: "jsonl",
    ...(sourceFilter !== "all" ? { source: sourceFilter } : {}),
    ...(versionFilter !== "all" ? { skillVersionId: versionFilter } : {}),
    ...(criterionId ? { criterionId } : {})
  });
  const title = [
    "Exports verdict rows for the selected criterion",
    sourceFilter !== "all" ? `source ${VERDICT_SOURCE_LABEL[sourceFilter]}` : "every source",
    versionFilter !== "all" ? `version ${versionFilter}` : "every evaluator version"
  ].join(" · ") + ". Verdict-label, search, and random-sample filters are not applied.";

  return { url, title };
}
