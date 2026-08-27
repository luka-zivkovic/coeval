import { Buffer } from "node:buffer";
import { z } from "zod";
import type { ManualTraceImportInput } from "@coeval/shared";
import type { CreateLangSmithFeedbackInput, LangSmithFeedbackWriter } from "./langsmith.js";

export interface LangfuseClientOptions {
  publicKey: string;
  secretKey: string;
  endpointUrl?: string | null | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface ListLangfuseTracesInput {
  limit: number;
}

export interface LangfuseTraceFetcher {
  listTraces(input: ListLangfuseTracesInput): Promise<ManualTraceImportInput[]>;
}

export class LangfuseHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operation: "listTraces" | "createScore"
  ) {
    super(message);
    this.name = "LangfuseHttpError";
  }
}

const LangfuseTraceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().optional(),
  createdAt: z.string().optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional()
}).passthrough();

const LangfuseTracesResponseSchema = z.union([
  z.array(LangfuseTraceSchema),
  z.object({ data: z.array(LangfuseTraceSchema) }),
  z.object({ traces: z.array(LangfuseTraceSchema) })
]);

export class LangfuseClient implements LangfuseTraceFetcher, LangSmithFeedbackWriter {
  private readonly endpointUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LangfuseClientOptions) {
    this.endpointUrl = (options.endpointUrl ?? "https://cloud.langfuse.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listTraces(input: ListLangfuseTracesInput): Promise<ManualTraceImportInput[]> {
    const url = new URL(`${this.endpointUrl}/api/public/traces`);
    url.searchParams.set("limit", String(input.limit));

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: this.authHeader(),
        accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new LangfuseHttpError(`Langfuse traces request failed: ${response.status}`, response.status, "listTraces");
    }

    const parsed = LangfuseTracesResponseSchema.parse(await response.json());
    const traces = Array.isArray(parsed) ? parsed : "data" in parsed ? parsed.data : parsed.traces;
    return traces.map(langfuseTraceToTraceImport);
  }

  async createFeedback(input: CreateLangSmithFeedbackInput): Promise<void> {
    const response = await this.fetchImpl(`${this.endpointUrl}/api/public/scores`, {
      method: "POST",
      headers: {
        authorization: this.authHeader(),
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...(input.feedbackId ? { id: input.feedbackId } : {}),
        traceId: input.runId,
        name: input.key,
        value: input.score,
        comment: `${input.value}: ${input.comment}`,
        metadata: {
          verdict: input.value,
          ...input.sourceInfo
        }
      })
    });
    if (response.status === 409 && input.feedbackId) return;
    if (!response.ok) {
      throw new LangfuseHttpError(`Langfuse score request failed: ${response.status}`, response.status, "createScore");
    }
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.options.publicKey}:${this.options.secretKey}`).toString("base64")}`;
  }
}

export function langfuseTraceToTraceImport(trace: z.infer<typeof LangfuseTraceSchema>): ManualTraceImportInput {
  return {
    sourceTraceId: trace.id,
    input: trace.input ?? {},
    output: trace.output ?? {},
    metadata: {
      source: "langfuse",
      name: trace.name,
      timestamp: trace.timestamp ?? trace.createdAt,
      userId: trace.userId,
      sessionId: trace.sessionId,
      extra: trace.metadata ?? {}
    }
  };
}
