import { z } from "zod";
import type { ManualTraceImportInput } from "@coeval/shared";

export interface LangSmithClientOptions {
  apiKey: string;
  endpointUrl?: string | null | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface ListLangSmithRunsInput {
  projectName?: string | null | undefined;
  limit: number;
}

export interface LangSmithTraceFetcher {
  listRuns(input: ListLangSmithRunsInput): Promise<ManualTraceImportInput[]>;
}

export interface CreateLangSmithFeedbackInput {
  feedbackId?: string | undefined;
  runId: string;
  key: string;
  score: number;
  value: string;
  comment: string;
  sourceInfo?: Record<string, unknown> | undefined;
}

export interface LangSmithFeedbackWriter {
  createFeedback(input: CreateLangSmithFeedbackInput): Promise<void>;
}

export class LangSmithHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operation: "listRuns" | "createFeedback"
  ) {
    super(message);
    this.name = "LangSmithHttpError";
  }
}

const LangSmithRunSchema = z.object({
  id: z.string().optional(),
  run_id: z.string().optional(),
  name: z.string().optional(),
  run_type: z.string().optional(),
  inputs: z.unknown().optional(),
  outputs: z.unknown().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional()
}).passthrough();

const LangSmithRunsResponseSchema = z.union([
  z.array(LangSmithRunSchema),
  z.object({ runs: z.array(LangSmithRunSchema) }),
  z.object({ results: z.array(LangSmithRunSchema) })
]);

export class LangSmithClient implements LangSmithTraceFetcher {
  private readonly endpointUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LangSmithClientOptions) {
    this.endpointUrl = (options.endpointUrl ?? "https://api.smith.langchain.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listRuns(input: ListLangSmithRunsInput): Promise<ManualTraceImportInput[]> {
    const url = new URL(`${this.endpointUrl}/runs`);
    url.searchParams.set("limit", String(input.limit));
    if (input.projectName) url.searchParams.set("project_name", input.projectName);

    const response = await this.fetchImpl(url, {
      headers: {
        "x-api-key": this.options.apiKey,
        "accept": "application/json"
      }
    });
    if (!response.ok) {
      throw new LangSmithHttpError(`LangSmith runs request failed: ${response.status}`, response.status, "listRuns");
    }

    const parsed = LangSmithRunsResponseSchema.parse(await response.json());
    const runs = Array.isArray(parsed) ? parsed : "runs" in parsed ? parsed.runs : parsed.results;
    return runs.map(langSmithRunToTraceImport);
  }

  async createFeedback(input: CreateLangSmithFeedbackInput): Promise<void> {
    const response = await this.fetchImpl(`${this.endpointUrl}/feedback`, {
      method: "POST",
      headers: {
        "x-api-key": this.options.apiKey,
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...(input.feedbackId ? { id: input.feedbackId } : {}),
        run_id: input.runId,
        key: input.key,
        score: input.score,
        value: input.value,
        comment: input.comment,
        source_info: input.sourceInfo ?? {}
      })
    });
    if (response.status === 409 && input.feedbackId) return;
    if (!response.ok) {
      throw new LangSmithHttpError(`LangSmith feedback request failed: ${response.status}`, response.status, "createFeedback");
    }
  }
}

export function langSmithRunToTraceImport(run: z.infer<typeof LangSmithRunSchema>): ManualTraceImportInput {
  const sourceTraceId = run.id ?? run.run_id;
  if (!sourceTraceId) throw new Error("LangSmith run missing id");
  return {
    sourceTraceId,
    input: run.inputs ?? run.input ?? {},
    output: run.outputs ?? run.output ?? {},
    metadata: {
      source: "langsmith",
      name: run.name,
      runType: run.run_type,
      startTime: run.start_time,
      endTime: run.end_time,
      extra: run.extra ?? {}
    }
  };
}
