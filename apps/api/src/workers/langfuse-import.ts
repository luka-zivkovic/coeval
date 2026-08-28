import { z } from "zod";
import { LangfuseImportJobSchema, type LangfuseImportJob } from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import type { CoevalRepository, LangfuseImportContext } from "../repository.js";
import { ImportSkillVersionBindingError, LangfuseCredentialsMissingError, LangfuseIntegrationNotFoundError, NoCurrentSkillError, RecursiveTraceSkippedError } from "../repository.js";
import { LangfuseClient, type LangfuseTraceFetcher } from "../lib/langfuse.js";
import { assertImportJudgingAllowed, scheduleImportedCaseJudging } from "./import-judging.js";

export interface LangfuseImportResult {
  imported: number;
  queued: number;
}

export type LangfuseClientFactory = (context: LangfuseImportContext) => LangfuseTraceFetcher;

export async function registerLangfuseImportWorker(
  queue: Queue,
  repository: CoevalRepository,
  createClient: LangfuseClientFactory = defaultLangfuseClientFactory
): Promise<void> {
  await queue.work<LangfuseImportJob>("langfuse.import", async ({ id, data }) => {
    try {
      await processLangfuseImportJob(repository, queue, data, createClient);
    } catch (error) {
      if (isPermanentLangfuseImportError(error)) {
        console.error(`langfuse.import job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });
}

export async function processLangfuseImportJob(
  repository: CoevalRepository,
  queue: Queue,
  job: LangfuseImportJob,
  createClient: LangfuseClientFactory = defaultLangfuseClientFactory
): Promise<LangfuseImportResult> {
  const parsed = LangfuseImportJobSchema.parse(job);
  if (parsed.importJobId) await repository.markImportJobRunning(parsed.projectId, parsed.importJobId);

  try {
    if (!parsed.skillVersionId) throw new ImportSkillVersionBindingError();
    const version = await repository.getSkillVersion(parsed.projectId, parsed.skillVersionId);
    if (!version) throw new ImportSkillVersionBindingError(`Unknown import skillVersionId for project: ${parsed.skillVersionId}`);
    await assertImportJudgingAllowed(repository, parsed.projectId, version.id);
    const context = await repository.loadLangfuseImportContext(parsed);
    const traces = await createClient(context).listTraces({ limit: context.limit });

    let imported = 0;
    const caseIds: string[] = [];
    for (const trace of traces) {
      let row;
      try {
        row = await repository.importTrace(context.projectId, "langfuse", trace, {
          ingestionPurpose: "analysis_eligible_langfuse",
          sourceIntegrationId: context.id,
          importJobId: parsed.importJobId,
          normalizationVersion: "langfuse-v1",
          redactionConfig: context.redactionConfig
        });
      } catch (error) {
        if (error instanceof RecursiveTraceSkippedError) continue;
        throw error;
      }
      if (row.created) imported += 1;
      caseIds.push(row.caseId);
    }
    const judging = await scheduleImportedCaseJudging(repository, queue, {
      projectId: context.projectId,
      skillVersionId: version.id,
      caseIds
    });
    if (judging.dispatchPending) {
      throw new Error("Imported Runs were saved, but their evaluation is not durably queued yet.");
    }
    const queued = judging.scheduledCaseCount;

    if (parsed.importJobId) {
      await repository.markImportJobCompleted(parsed.projectId, parsed.importJobId, {
        importedCount: imported,
        queuedJudgeCount: queued
      });
    }
    return { imported, queued };
  } catch (error) {
    if (parsed.importJobId) await repository.markImportJobFailed(parsed.projectId, parsed.importJobId, error).catch(() => undefined);
    throw error;
  }
}

export function defaultLangfuseClientFactory(context: LangfuseImportContext): LangfuseTraceFetcher {
  return new LangfuseClient({ publicKey: context.publicKey, secretKey: context.secretKey, endpointUrl: context.endpointUrl });
}

export function isPermanentLangfuseImportError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (error instanceof LangfuseIntegrationNotFoundError) return true;
  if (error instanceof LangfuseCredentialsMissingError) return true;
  if (error instanceof ImportSkillVersionBindingError) return true;
  if (error instanceof NoCurrentSkillError) return true;
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return true;
  }
  return false;
}
