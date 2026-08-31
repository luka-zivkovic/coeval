import { z } from "zod";
import { GoldenSetEntrySchema } from "./golden-set.js";
import { JudgeHumanDisagreementSummarySchema } from "./legacy-review.js";
import { TraceStepsSchema } from "./traces.js";
import { VerdictSourceSchema } from "./verdicts.js";

// ---------------------------------------------------------------------------
// Findings export + machine case/golden reads (GET /api/v1/findings,
// /api/v1/cases, /api/v1/golden-set — issue #10). The aggregation is bounded
// and deterministic: no LLM calls; "clustering" is exact grouping on the
// normalized first sentence of each rationale. All three endpoints are
// read-only and project-key authed — the machine surface never adjudicates
// or promotes (those dashboard actions remain ungoverned legacy evidence).

// Scan bounds. The findings surface reads at most this many newest rows per
// feed, so one request stays cheap and its output deterministic for a given
// data state; consumers needing history beyond the window page /api/v1/cases.
export const FINDINGS_VERDICT_SCAN_LIMIT = 500;
export const FINDINGS_CASE_SCAN_LIMIT = 500;
export const FINDINGS_OVERRIDE_LIMIT = 100;
export const FINDINGS_CLUSTER_LIMIT = 20;
export const FINDINGS_CLUSTER_CASE_SAMPLE = 10;
export const V1_CASES_MAX_LIMIT = 200;
export const V1_CASES_DEFAULT_LIMIT = 50;

// A human decision that contradicts the judge on the same case — the highest
// value rows in the system for skill maintenance. `source` distinguishes a
// reviewer verdict from an owner-recorded legacy adjudication. Both remain
// ungoverned evidence.
export const FindingsHumanOverrideSchema = z.object({
  caseId: z.string(),
  source: z.enum(["human", "adjudicated"]),
  label: z.string(),
  judgeLabel: z.string(),
  rationale: z.string(),
  skillVersionId: z.string().nullable(),
  createdAt: z.string()
});
export type FindingsHumanOverride = z.infer<typeof FindingsHumanOverrideSchema>;

export const FindingsFailureClusterSchema = z.object({
  // Normalized first sentence shared by every rationale in the cluster.
  key: z.string(),
  source: z.enum(["human_override", "judge"]),
  count: z.number().int().positive(),
  // Distinct cases in the cluster, capped at FINDINGS_CLUSTER_CASE_SAMPLE.
  caseIds: z.array(z.string()),
  // One full rationale from the cluster (the earliest, for determinism).
  sampleRationale: z.string()
});
export type FindingsFailureCluster = z.infer<typeof FindingsFailureClusterSchema>;

export const FindingsStratumDistributionSchema = z.object({
  // cases carry an optional metadata.stratum string; null = unstratified.
  stratum: z.string().nullable(),
  cases: z.number().int().nonnegative(),
  // Label -> count of cases whose LATEST verdict from that source has the
  // label (latest-wins per case, counts not percentages).
  judge: z.record(z.string(), z.number().int().nonnegative()),
  human: z.record(z.string(), z.number().int().nonnegative())
});
export type FindingsStratumDistribution = z.infer<typeof FindingsStratumDistributionSchema>;

export const FindingsGoldenSetSummarySchema = z.object({
  size: z.number().int().nonnegative(),
  // Entries promoted strictly after the `since` cursor; null when no cursor
  // was given (absent ≠ zero).
  entriesSince: z.number().int().nonnegative().nullable(),
  latestPromotedAt: z.string().nullable()
});
export type FindingsGoldenSetSummary = z.infer<typeof FindingsGoldenSetSummarySchema>;

export const V1FindingsResponseSchema = z.object({
  generatedAt: z.string(),
  since: z.string().nullable(),
  humanOverrides: z.array(FindingsHumanOverrideSchema),
  judgeHumanDisagreements: JudgeHumanDisagreementSummarySchema,
  verdictDistribution: z.array(FindingsStratumDistributionSchema),
  failureClusters: z.array(FindingsFailureClusterSchema),
  goldenSet: FindingsGoldenSetSummarySchema
});
export type V1FindingsResponse = z.infer<typeof V1FindingsResponseSchema>;

// GET /api/v1/cases — full stored (ingest-redacted) inputs and outputs, so a
// skill patch can be re-run on the exact cases the judge saw.
export const V1CaseVerdictSchema = z.object({
  label: z.string(),
  rationale: z.string(),
  source: VerdictSourceSchema,
  skillVersionId: z.string().nullable(),
  createdAt: z.string()
});
export type V1CaseVerdict = z.infer<typeof V1CaseVerdictSchema>;

export const V1CaseEntrySchema = z.object({
  caseId: z.string(),
  sourceTraceId: z.string(),
  createdAt: z.string(),
  stratum: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  steps: TraceStepsSchema.optional(),
  // Latest discrete verdicts. `human` prefers adjudicated over reviewer rows
  // (a recorded override outranks the verdict it overrode).
  judge: V1CaseVerdictSchema.nullable(),
  human: V1CaseVerdictSchema.nullable(),
  // human label when present, else the judge's — what `verdict=` filters on.
  effectiveLabel: z.string().nullable()
});
export type V1CaseEntry = z.infer<typeof V1CaseEntrySchema>;

export const V1CasesResponseSchema = z.object({
  cases: z.array(V1CaseEntrySchema)
});
export type V1CasesResponse = z.infer<typeof V1CasesResponseSchema>;

// GET /api/v1/golden-set — locked truth plus each entry's stored trace, so a
// gate check can be assembled from golden inputs without dashboard access.
export const V1GoldenEntrySchema = GoldenSetEntrySchema.extend({
  trace: z.object({
    input: z.unknown(),
    output: z.unknown(),
    metadata: z.record(z.string(), z.unknown())
  }).nullable()
});
export type V1GoldenEntry = z.infer<typeof V1GoldenEntrySchema>;

export const V1GoldenResponseSchema = z.object({
  entries: z.array(V1GoldenEntrySchema),
  // Registry size before any `since` filter (absent cursor ≠ empty registry).
  totalEntries: z.number().int().nonnegative()
});
export type V1GoldenResponse = z.infer<typeof V1GoldenResponseSchema>;
