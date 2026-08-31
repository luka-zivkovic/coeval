import { z } from "zod";

import { TraceSourceSchema } from "./traces.js";

export const TraceRedactionConfigSchema = z.object({
  excludedPaths: z.array(z.string().min(1).refine((path) => !/\[(?!\d+\]|\*\])/.test(path), {
    message: "Only numeric indexes like [0] and wildcards like [*] are supported in redaction paths"
  })).optional(),
  sensitiveKeyPatterns: z.array(z.string().min(1)).optional(),
  maxStringChars: z.number().int().positive().max(100_000).optional()
});
export type TraceRedactionConfig = z.infer<typeof TraceRedactionConfigSchema>;

export const LangSmithIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  apiKey: z.string().min(1),
  projectName: z.string().min(1).optional(),
  endpointUrl: z.url().optional(),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type LangSmithIntegrationInput = z.infer<typeof LangSmithIntegrationInputSchema>;

export const UpdateLangSmithIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
}).refine((input) => Object.keys(input).length > 0, {
  message: "At least one LangSmith integration setting is required"
});
export type UpdateLangSmithIntegrationInput = z.infer<typeof UpdateLangSmithIntegrationInputSchema>;

export const LangSmithConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  sampleRunCount: z.number().int().nonnegative().optional(),
  status: z.number().int().positive().optional(),
  error: z.string().optional()
});
export type LangSmithConnectionTestResult = z.infer<typeof LangSmithConnectionTestResultSchema>;

export const LangSmithIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("langsmith"),
  skillVersionId: z.string().nullable(),
  projectName: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: LangSmithConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type LangSmithIntegration = z.infer<typeof LangSmithIntegrationSchema>;

export const LangfuseIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
  endpointUrl: z.url().optional(),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type LangfuseIntegrationInput = z.infer<typeof LangfuseIntegrationInputSchema>;

export const UpdateLangfuseIntegrationInputSchema = UpdateLangSmithIntegrationInputSchema;
export type UpdateLangfuseIntegrationInput = z.infer<typeof UpdateLangfuseIntegrationInputSchema>;

export const LangfuseConnectionTestResultSchema = LangSmithConnectionTestResultSchema;
export type LangfuseConnectionTestResult = z.infer<typeof LangfuseConnectionTestResultSchema>;

export const LangfuseIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("langfuse"),
  skillVersionId: z.string().nullable(),
  projectName: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: LangfuseConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type LangfuseIntegration = z.infer<typeof LangfuseIntegrationSchema>;

export const IRONSIDE_EVALUATOR_PROTOCOL_VERSION = "ironside/evaluator/v1" as const;

export const IronsideEvaluatorContextSchema = z.object({
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  // Capability names are additive. Require the two native evaluator grants
  // in the client, but tolerate future unrelated capabilities on the key.
  capabilities: z.array(z.string().min(1)),
  settlement: z.object({
    kind: z.literal("quiet_period"),
    quietPeriodSeconds: z.number().int().nonnegative()
  })
});
export type IronsideEvaluatorContext = z.infer<typeof IronsideEvaluatorContextSchema>;

export const IronsideEvaluatorTraceSummarySchema = z.object({
  traceId: z.string().min(1),
  traceVersion: z.iso.datetime({ offset: true }),
  timestamp: z.iso.datetime({ offset: true }),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string())
});
export type IronsideEvaluatorTraceSummary = z.infer<typeof IronsideEvaluatorTraceSummarySchema>;

export const IronsideEvaluatorTraceFeedSchema = z.object({
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  traces: z.array(IronsideEvaluatorTraceSummarySchema),
  nextCursor: z.string().min(1),
  hasMore: z.boolean()
});
export type IronsideEvaluatorTraceFeed = z.infer<typeof IronsideEvaluatorTraceFeedSchema>;

export interface IronsideEvaluatorObservationNode {
  id: string;
  parentObservationId?: string | null | undefined;
  type: string;
  name?: string | null | undefined;
  startTime: string;
  endTime?: string | null | undefined;
  level?: string | null | undefined;
  statusMessage?: string | null | undefined;
  model?: string | null | undefined;
  modelParameters?: Record<string, string> | undefined;
  input?: unknown;
  output?: unknown;
  usageDetails?: Record<string, number> | undefined;
  costDetails?: Record<string, number> | undefined;
  completionStartTime?: string | null | undefined;
  metadata?: Record<string, string> | undefined;
  children: IronsideEvaluatorObservationNode[];
}

export const IronsideEvaluatorObservationNodeSchema: z.ZodType<IronsideEvaluatorObservationNode> = z.lazy(() => z.object({
  id: z.string(),
  parentObservationId: z.string().nullish(),
  type: z.string(),
  name: z.string().nullish(),
  startTime: z.string(),
  endTime: z.string().nullish(),
  level: z.string().nullish(),
  statusMessage: z.string().nullish(),
  model: z.string().nullish(),
  modelParameters: z.record(z.string(), z.string()).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  usageDetails: z.record(z.string(), z.number()).optional(),
  costDetails: z.record(z.string(), z.number()).optional(),
  completionStartTime: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).optional(),
  children: z.array(IronsideEvaluatorObservationNodeSchema)
}));

export const IronsideEvaluatorTraceSchema = z.object({
  id: z.string().min(1),
  traceVersion: z.iso.datetime({ offset: true }),
  timestamp: z.iso.datetime({ offset: true }),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  release: z.string().nullable(),
  version: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string()),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  observations: z.array(IronsideEvaluatorObservationNodeSchema)
});
export type IronsideEvaluatorTrace = z.infer<typeof IronsideEvaluatorTraceSchema>;

// A native connection is one Ironside project plus a scoped machine key. The
// remote service owns settlement and exposes immutable trace versions; Coeval
// persists only the opaque continuation cursor it receives from that feed.
export const IronsideIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  url: z.url(),
  apiKey: z.string().min(1),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type IronsideIntegrationInput = z.infer<typeof IronsideIntegrationInputSchema>;

export const UpdateIronsideIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  url: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
}).refine((input) => Object.keys(input).length > 0, {
  message: "At least one Ironside integration setting is required"
});
export type UpdateIronsideIntegrationInput = z.infer<typeof UpdateIronsideIntegrationInputSchema>;

export const IronsideConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  status: z.number().int().positive().optional(),
  error: z.string().optional(),
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION).optional(),
  remoteProjectId: z.string().min(1).optional(),
  remoteProjectName: z.string().min(1).optional()
});
export type IronsideConnectionTestResult = z.infer<typeof IronsideConnectionTestResultSchema>;

export const IronsideIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("ironside"),
  skillVersionId: z.string().nullable(),
  url: z.string(),
  remoteProjectId: z.string().min(1),
  remoteProjectName: z.string().min(1),
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  settlementQuietPeriodSeconds: z.number().int().nonnegative(),
  revalidationRequired: z.boolean(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: IronsideConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type IronsideIntegration = z.infer<typeof IronsideIntegrationSchema>;

// The cursor is intentionally opaque: ordering, settlement, bootstrap and
// recovery remain Ironside concerns rather than duplicated Coeval policy.
export const IronsideSyncStateSchema = z.object({
  cursor: z.string().nullable()
});
export type IronsideSyncState = z.infer<typeof IronsideSyncStateSchema>;

export const LangSmithImportJobSchema = z.object({
  projectId: z.string(),
  integrationId: z.string(),
  skillVersionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(25),
  importJobId: z.string().optional()
});
export type LangSmithImportJob = z.infer<typeof LangSmithImportJobSchema>;

export const LangSmithImportTargetSchema = z.object({
  projectId: z.string(),
  integrationId: z.string(),
  skillVersionId: z.string().min(1),
  limit: z.number().int().positive().max(100)
});
export type LangSmithImportTarget = z.infer<typeof LangSmithImportTargetSchema>;

export const LangSmithImportRequestSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(25)
});
export type LangSmithImportRequest = z.infer<typeof LangSmithImportRequestSchema>;

export const LangfuseImportJobSchema = LangSmithImportJobSchema;
export type LangfuseImportJob = z.infer<typeof LangfuseImportJobSchema>;

export const LangfuseImportTargetSchema = LangSmithImportTargetSchema;
export type LangfuseImportTarget = z.infer<typeof LangfuseImportTargetSchema>;

export const LangfuseImportRequestSchema = LangSmithImportRequestSchema;
export type LangfuseImportRequest = z.infer<typeof LangfuseImportRequestSchema>;

export const IronsideImportJobSchema = LangSmithImportJobSchema;
export type IronsideImportJob = z.infer<typeof IronsideImportJobSchema>;

export const IronsideImportTargetSchema = LangSmithImportTargetSchema;
export type IronsideImportTarget = z.infer<typeof IronsideImportTargetSchema>;

export const IronsideImportRequestSchema = LangSmithImportRequestSchema;
export type IronsideImportRequest = z.infer<typeof IronsideImportRequestSchema>;

export const ImportJobStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;

export const ImportJobRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: TraceSourceSchema,
  sourceIntegrationId: z.string().nullable(),
  // Null only for a terminal failed scheduling attempt that could not select
  // one evaluator safely (for example an unconfigured multi-criterion poller).
  skillVersionId: z.string().min(1).nullable(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorName: z.string().nullable(),
  queueJobId: z.string().nullable(),
  status: ImportJobStatusSchema,
  requestedLimit: z.number().int().positive().nullable(),
  importedCount: z.number().int().nonnegative(),
  queuedJudgeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable()
});
export type ImportJobRecord = z.infer<typeof ImportJobRecordSchema>;

export const LangSmithImportEnqueueResultSchema = z.object({
  queued: z.boolean(),
  queueJobId: z.string().nullable(),
  importJob: ImportJobRecordSchema
});
export type LangSmithImportEnqueueResult = z.infer<typeof LangSmithImportEnqueueResultSchema>;

export const LangfuseImportEnqueueResultSchema = LangSmithImportEnqueueResultSchema;
export type LangfuseImportEnqueueResult = z.infer<typeof LangfuseImportEnqueueResultSchema>;

export const IronsideImportEnqueueResultSchema = LangSmithImportEnqueueResultSchema;
export type IronsideImportEnqueueResult = z.infer<typeof IronsideImportEnqueueResultSchema>;
