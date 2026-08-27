import { z } from "zod";
import { FeedbackSyncJobSchema, type FeedbackSyncJob } from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import type { CoevalRepository, FeedbackSyncContext } from "../repository.js";
import { FeedbackSyncCredentialsMissingError, FeedbackSyncJobNotFoundError } from "../repository.js";
import { LangSmithClient, type LangSmithFeedbackWriter } from "../lib/langsmith.js";
import { LangfuseClient } from "../lib/langfuse.js";
import { IronsideClient } from "../lib/ironside.js";

export type FeedbackWriterFactory = (context: FeedbackSyncContext) => LangSmithFeedbackWriter;
export type LangSmithFeedbackWriterFactory = FeedbackWriterFactory;

export async function registerFeedbackSyncWorker(
  queue: Queue,
  repository: CoevalRepository,
  createWriter: FeedbackWriterFactory = defaultFeedbackWriterFactory
): Promise<void> {
  await queue.work<FeedbackSyncJob>("feedback.sync", async ({ id, data }) => {
    try {
      await processFeedbackSyncJob(repository, data, createWriter);
    } catch (error) {
      if (isPermanentFeedbackSyncError(error)) {
        console.error(`feedback.sync job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });
}

export async function processFeedbackSyncJob(
  repository: CoevalRepository,
  job: FeedbackSyncJob,
  createWriter: FeedbackWriterFactory = defaultFeedbackWriterFactory
): Promise<void> {
  const parsed = FeedbackSyncJobSchema.parse(job);
  const context = await repository.loadFeedbackSyncContext(parsed);
  try {
    await createWriter(context).createFeedback({
      // LangSmith/Langfuse accept a caller-provided score/feedback id. Reusing
      // the durable feedback_sync_jobs id makes retries idempotent instead of
      // creating duplicate `coeval_verdict` rows.
      feedbackId: context.id,
      runId: context.sourceTraceId,
      key: "coeval_verdict",
      score: context.judgeRun.score,
      value: context.judgeRun.verdict,
      comment: context.judgeRun.reasoning,
      sourceInfo: {
        skillVersionId: context.judgeRun.skillVersionId,
        modelBinding: context.judgeRun.modelBinding,
        judgeRunId: context.judgeRun.id,
        provider: "coeval"
      }
    });
    await repository.markFeedbackSyncSucceeded(parsed);
  } catch (error) {
    await repository.markFeedbackSyncFailed(parsed, error);
    throw error;
  }
}

export function defaultFeedbackWriterFactory(context: FeedbackSyncContext): LangSmithFeedbackWriter {
  if (context.provider === "langfuse") {
    const integration = context.integration;
    if (!("publicKey" in integration)) throw new FeedbackSyncCredentialsMissingError(context.id);
    return new LangfuseClient({
      publicKey: integration.publicKey,
      secretKey: integration.secretKey,
      endpointUrl: integration.endpointUrl
    });
  }
  if (context.provider === "ironside") {
    const integration = context.integration;
    if (!("url" in integration) || !("apiKey" in integration)) throw new FeedbackSyncCredentialsMissingError(context.id);
    return new IronsideClient({ url: integration.url, apiKey: integration.apiKey });
  }
  const integration = context.integration;
  if (!("apiKey" in integration) || "url" in integration) throw new FeedbackSyncCredentialsMissingError(context.id);
  return new LangSmithClient({ apiKey: integration.apiKey, endpointUrl: integration.endpointUrl });
}

export const defaultLangSmithFeedbackWriterFactory = defaultFeedbackWriterFactory;

export function isPermanentFeedbackSyncError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (error instanceof FeedbackSyncJobNotFoundError) return true;
  if (error instanceof FeedbackSyncCredentialsMissingError) return true;
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return true;
  }
  return false;
}
