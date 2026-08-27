import { z } from "zod";
import { MAX_TRACE_STEPS, type ManualTraceImportInput, type TraceStep } from "@coeval/shared";
import type { CreateLangSmithFeedbackInput, LangSmithFeedbackWriter } from "./langsmith.js";

// Client for ironside's NATIVE API (issue #153) — not the Langfuse-compat
// tier. Auth is a single Bearer API key; trace listing uses stable keyset
// cursors ((timestamp, id) DESC) instead of compat page numbers, which is the
// whole reason this source type exists.

export interface IronsideClientOptions {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
}

export class IronsideHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operation: "listTraces" | "getTrace" | "ingestScore"
  ) {
    super(message);
    this.name = "IronsideHttpError";
  }
}

export interface ListIronsideTracesInput {
  // ISO timestamps filtering the trace's own `timestamp` (inclusive on both
  // ends server-side; boundary overlap is deduped by the importer).
  from?: string | undefined;
  to?: string | undefined;
  // Opaque keyset cursor from the previous page's nextCursor.
  cursor?: string | undefined;
  limit: number;
}

const IronsideTraceSummarySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  name: z.string().nullish(),
  userId: z.string().nullish(),
  sessionId: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.string()).default({})
});
export type IronsideTraceSummary = z.infer<typeof IronsideTraceSummarySchema>;

const IronsideListTracesResponseSchema = z.object({
  traces: z.array(IronsideTraceSummarySchema),
  nextCursor: z.string().nullable()
});

export interface IronsideObservationNode {
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
  children: IronsideObservationNode[];
}

const IronsideObservationNodeSchema: z.ZodType<IronsideObservationNode> = z.lazy(() =>
  z.object({
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
    children: z.array(IronsideObservationNodeSchema)
  })
);

const IronsideTraceTreeSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  name: z.string().nullish(),
  userId: z.string().nullish(),
  sessionId: z.string().nullish(),
  environment: z.string().nullish(),
  release: z.string().nullish(),
  version: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.string()).default({}),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  observations: z.array(IronsideObservationNodeSchema).default([])
});
export type IronsideTraceTree = z.infer<typeof IronsideTraceTreeSchema>;

export interface IronsideTracesPage {
  traces: IronsideTraceSummary[];
  nextCursor: string | null;
}

// The worker's client surface: list summaries in a window, then fetch the
// full tree per trace (the list projection has no input/output/observations).
export interface IronsideTraceSource {
  listTraces(input: ListIronsideTracesInput): Promise<IronsideTracesPage>;
  getTrace(traceId: string): Promise<IronsideTraceTree>;
}

export class IronsideClient implements IronsideTraceSource, LangSmithFeedbackWriter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IronsideClientOptions) {
    this.baseUrl = options.url.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listTraces(input: ListIronsideTracesInput): Promise<IronsideTracesPage> {
    const url = new URL(`${this.baseUrl}/api/v1/traces`);
    if (input.from) url.searchParams.set("from", input.from);
    if (input.to) url.searchParams.set("to", input.to);
    if (input.cursor) url.searchParams.set("cursor", input.cursor);
    url.searchParams.set("limit", String(input.limit));

    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) {
      throw new IronsideHttpError(`Ironside traces request failed: ${response.status}`, response.status, "listTraces");
    }
    return IronsideListTracesResponseSchema.parse(await response.json());
  }

  async getTrace(traceId: string): Promise<IronsideTraceTree> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/traces/${encodeURIComponent(traceId)}`, {
      headers: this.headers()
    });
    if (!response.ok) {
      throw new IronsideHttpError(`Ironside trace request failed: ${response.status}`, response.status, "getTrace");
    }
    return IronsideTraceTreeSchema.parse(await response.json());
  }

  // Verdict writeback through the native ingest edge: one score-upsert event.
  // Ironside's contract makes this safe to retry (idempotencyKey + score-id
  // upsert) and score writes never reopen a settled trace, so the judge's own
  // verdict cannot create an import feedback loop.
  async createFeedback(input: CreateLangSmithFeedbackInput): Promise<void> {
    const metadata: Record<string, string> = { verdict: input.value };
    for (const [key, value] of Object.entries(input.sourceInfo ?? {})) {
      if (value === undefined || value === null) continue;
      metadata[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/ingest`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "score-upsert",
            ...(input.feedbackId ? { idempotencyKey: input.feedbackId } : {}),
            body: {
              ...(input.feedbackId ? { id: input.feedbackId } : {}),
              traceId: input.runId,
              name: input.key,
              dataType: "numeric",
              value: input.score,
              source: "api",
              comment: `${input.value}: ${input.comment}`,
              metadata
            }
          }
        ]
      })
    });
    if (!response.ok) {
      throw new IronsideHttpError(`Ironside score ingest failed: ${response.status}`, response.status, "ingestScore");
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: "application/json"
    };
  }
}

// Maps a native trace tree into coeval's normalized case shape. The
// observation tree flattens depth-first into TraceStep[] per the envelope
// spec, capped at the shared MAX_TRACE_STEPS so a huge trace still imports.
export function ironsideTraceToTraceImport(trace: IronsideTraceTree): ManualTraceImportInput {
  const steps: TraceStep[] = [];
  const flatten = (nodes: IronsideObservationNode[]): void => {
    for (const node of nodes) {
      if (steps.length >= MAX_TRACE_STEPS) return;
      steps.push({
        ...(node.name ? { name: node.name } : {}),
        input: node.input ?? null,
        output: node.output ?? null,
        metadata: {
          observationId: node.id,
          type: node.type,
          ...(node.model ? { model: node.model } : {}),
          startTime: node.startTime,
          ...(node.endTime ? { endTime: node.endTime } : {}),
          ...(node.usageDetails && Object.keys(node.usageDetails).length > 0 ? { usageDetails: node.usageDetails } : {}),
          ...(node.costDetails && Object.keys(node.costDetails).length > 0 ? { costDetails: node.costDetails } : {}),
          ...(node.metadata ?? {})
        }
      });
      flatten(node.children);
    }
  };
  flatten(trace.observations);

  return {
    sourceTraceId: trace.id,
    input: trace.input ?? {},
    output: trace.output ?? {},
    metadata: {
      source: "ironside",
      ...(trace.name != null ? { name: trace.name } : {}),
      timestamp: trace.timestamp,
      ...(trace.userId != null ? { userId: trace.userId } : {}),
      ...(trace.sessionId != null ? { sessionId: trace.sessionId } : {}),
      ...(trace.environment != null ? { environment: trace.environment } : {}),
      ...(trace.release != null ? { release: trace.release } : {}),
      ...(trace.version != null ? { version: trace.version } : {}),
      ...(trace.tags.length > 0 ? { tags: trace.tags } : {}),
      extra: trace.metadata
    },
    ...(steps.length > 0 ? { steps } : {})
  };
}
