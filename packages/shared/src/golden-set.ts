import { z } from "zod";
import { VerdictLabelSchema } from "./judge.js";

export const GoldenSetEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  reason: z.string(),
  promotedBy: z.string(),
  promotedAt: z.string(),
  sourceSkillVersionId: z.string(),
  criterionVersionId: z.string()
});
export type GoldenSetEntry = z.infer<typeof GoldenSetEntrySchema>;

export const GOLDEN_SET_REASON_MAX_LENGTH = 1000;

export const PromoteGoldenSetInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  reason: z.string().min(1).max(GOLDEN_SET_REASON_MAX_LENGTH)
});
export type PromoteGoldenSetInput = z.infer<typeof PromoteGoldenSetInputSchema>;

export const RetireGoldenSetEntryInputSchema = z.object({
  reason: z.string().min(1).max(GOLDEN_SET_REASON_MAX_LENGTH).optional()
});
export type RetireGoldenSetEntryInput = z.infer<typeof RetireGoldenSetEntryInputSchema>;

export const GoldenSetRetirementContextSchema = z.object({
  retiredAt: z.string().nullable(),
  retiredByUserId: z.string().nullable(),
  retiredBy: z.string().nullable(),
  reason: z.string().nullable()
});
export type GoldenSetRetirementContext = z.infer<typeof GoldenSetRetirementContextSchema>;

export const GOLDEN_SET_STALE_AFTER_DAYS = 90;

export const GoldenSetHealthStatusSchema = z.enum(["healthy", "needs_action"]);
export type GoldenSetHealthStatus = z.infer<typeof GoldenSetHealthStatusSchema>;

export const GoldenSetHealthEntrySchema = z.object({
  id: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  promotedAt: z.string(),
  ageDays: z.number().int().nonnegative(),
  reason: z.string()
});
export type GoldenSetHealthEntry = z.infer<typeof GoldenSetHealthEntrySchema>;

export const GoldenSetDuplicateGroupSchema = z.object({
  traceId: z.string(),
  entryCount: z.number().int().min(2),
  entries: z.array(GoldenSetHealthEntrySchema)
});
export type GoldenSetDuplicateGroup = z.infer<typeof GoldenSetDuplicateGroupSchema>;

export const GoldenSetHealthSummarySchema = z.object({
  projectId: z.string(),
  status: GoldenSetHealthStatusSchema,
  totalActive: z.number().int().nonnegative(),
  // Server-authoritative threshold; can become project-specific without changing clients.
  staleAfterDays: z.number().int().positive(),
  staleCount: z.number().int().nonnegative(),
  freshCount: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  oldestPromotedAt: z.string().nullable(),
  newestPromotedAt: z.string().nullable(),
  staleEntries: z.array(GoldenSetHealthEntrySchema),
  duplicateCount: z.number().int().nonnegative(),
  duplicateGroups: z.array(GoldenSetDuplicateGroupSchema),
  recommendations: z.array(z.string())
});
export type GoldenSetHealthSummary = z.infer<typeof GoldenSetHealthSummarySchema>;
