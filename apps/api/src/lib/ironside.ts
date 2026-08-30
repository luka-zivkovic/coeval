import {
  IRONSIDE_EVALUATOR_PROTOCOL_VERSION,
  IronsideEvaluatorContextSchema,
  IronsideEvaluatorTraceFeedSchema,
  IronsideEvaluatorTraceSchema,
  MAX_TRACE_STEPS,
  type IronsideEvaluatorContext,
  type IronsideEvaluatorObservationNode,
  type IronsideEvaluatorTrace,
  type IronsideEvaluatorTraceFeed,
  type ManualTraceImportInput,
  type TraceStep
} from "@coeval/shared";
import type { CreateLangSmithFeedbackInput, LangSmithFeedbackWriter } from "./langsmith.js";

export interface IronsideClientOptions {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_IRONSIDE_REQUEST_TIMEOUT_MS = 15_000;
export const IRONSIDE_SCORE_COMMENT_MAX_CHARS = 20_000;

export class IronsideHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operation: "getContext" | "listTraces" | "getTrace" | "createScore"
  ) {
    super(message);
    this.name = "IronsideHttpError";
  }
}

export class IronsideTraceVersionMismatchError extends Error {
  constructor(readonly expectedVersion: string, readonly actualVersion: string) {
    super(`Ironside returned trace version ${actualVersion}; expected ${expectedVersion}`);
    this.name = "IronsideTraceVersionMismatchError";
  }
}

export class IronsideTraceTooLargeError extends Error {
  constructor(
    readonly traceId: string,
    readonly observationCount: number,
    readonly maximumObservationCount: number
  ) {
    super(
      `Ironside trace ${traceId} has ${observationCount} observations; ` +
      `Coeval accepts at most ${maximumObservationCount} without truncation`
    );
    this.name = "IronsideTraceTooLargeError";
  }
}

export interface ListIronsideTracesInput {
  cursor?: string | undefined;
  limit: number;
}

export interface IronsideTraceSource {
  getContext(): Promise<IronsideEvaluatorContext>;
  listTraces(input: ListIronsideTracesInput): Promise<IronsideEvaluatorTraceFeed>;
  getTrace(traceId: string, traceVersion: string): Promise<IronsideEvaluatorTrace>;
}

export class IronsideClient implements IronsideTraceSource, LangSmithFeedbackWriter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IronsideClientOptions) {
    this.baseUrl = options.url.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getContext(): Promise<IronsideEvaluatorContext> {
    const response = await this.request(`${this.baseUrl}/api/v1/evaluator/context`, {
      headers: this.headers()
    });
    if (!response.ok) {
      throw new IronsideHttpError(`Ironside evaluator context request failed: ${response.status}`, response.status, "getContext");
    }
    const context = IronsideEvaluatorContextSchema.parse(await response.json());
    if (!context.capabilities.includes("traces:read") || !context.capabilities.includes("scores:write")) {
      throw new IronsideHttpError("Ironside key must grant traces:read and scores:write", 403, "getContext");
    }
    return context;
  }

  async listTraces(input: ListIronsideTracesInput): Promise<IronsideEvaluatorTraceFeed> {
    const url = new URL(`${this.baseUrl}/api/v1/evaluator/traces`);
    if (input.cursor) url.searchParams.set("cursor", input.cursor);
    url.searchParams.set("limit", String(input.limit));
    const response = await this.request(url, { headers: this.headers() });
    if (!response.ok) {
      throw new IronsideHttpError(`Ironside evaluator feed request failed: ${response.status}`, response.status, "listTraces");
    }
    return IronsideEvaluatorTraceFeedSchema.parse(await response.json());
  }

  async getTrace(traceId: string, traceVersion: string): Promise<IronsideEvaluatorTrace> {
    const url = new URL(`${this.baseUrl}/api/v1/evaluator/traces/${encodeURIComponent(traceId)}`);
    url.searchParams.set("version", traceVersion);
    const response = await this.request(url, { headers: this.headers() });
    if (!response.ok) {
      throw new IronsideHttpError(`Ironside evaluator trace request failed: ${response.status}`, response.status, "getTrace");
    }
    const trace = IronsideEvaluatorTraceSchema.parse(await response.json());
    if (trace.traceVersion !== traceVersion) {
      throw new IronsideTraceVersionMismatchError(traceVersion, trace.traceVersion);
    }
    return trace;
  }

  async createFeedback(input: CreateLangSmithFeedbackInput): Promise<void> {
    const versionId = String(input.sourceInfo?.skillVersionId ?? "");
    const criterionKey = String(input.sourceInfo?.criterionKey ?? "");
    if (!input.feedbackId || !versionId || !criterionKey) {
      throw new Error("Native Ironside feedback requires an id, evaluator version, and criterion key");
    }
    const response = await this.request(`${this.baseUrl}/api/v1/evaluator/scores`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        id: input.feedbackId,
        traceId: input.runId,
        name: input.key,
        value: input.score,
        assessmentLabel: input.value,
        comment: boundedIronsideScoreComment(input.comment),
        evaluator: { provider: "coeval", versionId, criterionKey },
        metadata: {
          judgeRunId: input.sourceInfo?.judgeRunId,
          sourceTraceVersion: input.sourceInfo?.sourceTraceVersion,
          modelBinding: input.sourceInfo?.modelBinding,
          protocolVersion: IRONSIDE_EVALUATOR_PROTOCOL_VERSION
        }
      })
    });
    if (!response.ok) {
      throw new IronsideHttpError(`Ironside evaluator score request failed: ${response.status}`, response.status, "createScore");
    }
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" };
  }

  private request(input: string | URL, init: RequestInit): Promise<Response> {
    return this.fetchImpl(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(
        this.options.timeoutMs ?? DEFAULT_IRONSIDE_REQUEST_TIMEOUT_MS
      )
    });
  }
}

function boundedIronsideScoreComment(comment: string | undefined): string | undefined {
  if (comment === undefined || comment.length <= IRONSIDE_SCORE_COMMENT_MAX_CHARS) {
    return comment;
  }
  const suffix = "…[TRUNCATED]";
  return `${comment.slice(0, IRONSIDE_SCORE_COMMENT_MAX_CHARS - suffix.length)}${suffix}`;
}

export function ironsideTraceToTraceImport(trace: IronsideEvaluatorTrace): ManualTraceImportInput {
  const pending = [...trace.observations];
  let observationCount = 0;
  while (pending.length > 0) {
    const node = pending.pop()!;
    observationCount += 1;
    if (observationCount > MAX_TRACE_STEPS) {
      throw new IronsideTraceTooLargeError(trace.id, observationCount, MAX_TRACE_STEPS);
    }
    pending.push(...node.children);
  }

  const steps: TraceStep[] = [];
  const flatten = (nodes: IronsideEvaluatorObservationNode[]): void => {
    for (const node of nodes) {
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
      sourceTraceVersion: trace.traceVersion,
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
