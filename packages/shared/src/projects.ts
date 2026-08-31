import { z } from "zod";

// Skill Bench: how a project gets its evidence. 'tracing' = a trace stream
// (LangSmith/Langfuse/manual imports); 'bench' = curated example datasets, no
// tracing infra. Branches onboarding/IA/copy only — the judging pipe is shared.
export const ProjectModeSchema = z.enum(["tracing", "bench"]);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: ProjectModeSchema,
  traceProvider: z.enum(["langsmith", "langfuse", "ironside", "manual", "unknown"]),
  importedTraceCount: z.number().int().nonnegative(),
  autoJudgedTraceCount: z.number().int().nonnegative(),
  syncBackCoverage: z.number().min(0).max(1),
  traceRetentionDays: z.number().int().positive().nullable(),
  updatedAt: z.string()
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSettingsSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  mode: ProjectModeSchema,
  traceRetentionDays: z.number().int().positive().nullable()
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const UpdateProjectSettingsInputSchema = z.object({
  traceRetentionDays: z.number().int().positive().max(3650).nullable(),
  mode: ProjectModeSchema.optional()
});
export type UpdateProjectSettingsInput = z.infer<typeof UpdateProjectSettingsInputSchema>;

export const RetentionPruneResultSchema = z.object({
  projectId: z.string(),
  traceRetentionDays: z.number().int().positive().nullable(),
  cutoff: z.string().nullable(),
  deletedCases: z.number().int().nonnegative(),
  deletedRawTraces: z.number().int().nonnegative(),
  skippedActiveGoldenCases: z.number().int().nonnegative(),
  skippedImmutableRevisionCases: z.number().int().nonnegative()
});
export type RetentionPruneResult = z.infer<typeof RetentionPruneResultSchema>;

export const DeleteProjectInputSchema = z.object({
  confirmProjectName: z.string().min(1)
});
export type DeleteProjectInput = z.infer<typeof DeleteProjectInputSchema>;

// The release gate technically arms at the FIRST promoted golden case (the
// regression runs against whatever golden set exists); 5+ is the recommended
// size before the gate's verdict means much. Copy that mentions a threshold
// must derive from these two numbers — hardcoded fives drifted into three
// mutually contradictory banners once already.
export const GOLDEN_GATE_ARMS_AT = 1;
export const GOLDEN_GATE_RECOMMENDED = 5;

// Agreement statistics are mathematically computable with fewer cases, but
// rendering a precise κ from one or two overlaps invites false confidence.
// The UI shows collection progress until this minimum shared sample exists.
export const KAPPA_MIN_SHARED_CASES = 5;

// Project names are capped by the API on both creation paths (owner setup and
// POST /api/projects); the UI mirrors it via input maxLength.
export const PROJECT_NAME_MAX_LENGTH = 120;
