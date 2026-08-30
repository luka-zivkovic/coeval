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

export class IronsideTraceIdentityMismatchError extends Error {
  constructor(readonly expectedTraceId: string, readonly actualTraceId: string) {
    super(`Ironside returned trace ${actualTraceId}; expected ${expectedTraceId}`);
    this.name = "IronsideTraceIdentityMismatchError";
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
    if (trace.id !== traceId) {
      throw new IronsideTraceIdentityMismatchError(traceId, trace.id);
    }
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
    // Avoid Function.apply/argument-count limits on pathologically wide
    // traces. The explicit loop remains bounded by MAX_TRACE_STEPS without
    // first expanding every child into one variadic call.
    for (const child of node.children) pending.push(child);
  }

  const steps: TraceStep[] = [];
  const flatten = (nodes: IronsideEvaluatorObservationNode[]): void => {
    for (const node of nodes) {
      steps.push({
        ...(node.name ? { name: postgresJsonSafeString(node.name) } : {}),
        input: postgresJsonSafeValue(node.input ?? null),
        output: postgresJsonSafeValue(node.output ?? null),
        metadata: postgresJsonSafeValue({
          observationId: node.id,
          type: node.type,
          ...(node.model ? { model: node.model } : {}),
          startTime: node.startTime,
          ...(node.endTime ? { endTime: node.endTime } : {}),
          ...(node.usageDetails && Object.keys(node.usageDetails).length > 0 ? { usageDetails: node.usageDetails } : {}),
          ...(node.costDetails && Object.keys(node.costDetails).length > 0 ? { costDetails: node.costDetails } : {}),
          ...(node.metadata ?? {})
        }) as Record<string, unknown>
      });
      flatten(node.children);
    }
  };
  flatten(trace.observations);

  return {
    sourceTraceId: trace.id,
    input: postgresJsonSafeValue(trace.input ?? {}),
    output: postgresJsonSafeValue(trace.output ?? {}),
    metadata: postgresJsonSafeValue({
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
    }) as Record<string, unknown>,
    ...(steps.length > 0 ? { steps } : {})
  };
}

/**
 * PostgreSQL jsonb cannot represent U+0000 or unpaired UTF-16 surrogates,
 * even though either can arrive in parsed evaluator payload strings. Encode
 * them before raw/normalized payloads reach the repository. Backslashes are
 * escaped first, making the mapping injective: real NUL cannot collide with a
 * pre-existing literal `\\0`, and encoded object keys cannot overwrite one
 * another in Object.fromEntries.
 */
function postgresJsonSafeValue(value: unknown): unknown {
  if (typeof value === "string") return postgresJsonSafeString(value);
  if (Array.isArray(value)) return value.map(postgresJsonSafeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        postgresJsonSafeString(key),
        postgresJsonSafeValue(entry)
      ])
    );
  }
  return value;
}

function postgresJsonSafeString(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      encoded += "\\\\";
    } else if (code === 0) {
      encoded += "\\0";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        encoded += value.slice(index, index + 2);
        index += 1;
      } else {
        encoded += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      encoded += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      encoded += value.charAt(index);
    }
  }
  return encoded;
}
