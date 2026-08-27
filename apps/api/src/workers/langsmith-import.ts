import { z } from "zod";
import { LangSmithImportJobSchema, type LangSmithImportJob } from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import type { CoevalRepository, LangSmithImportContext } from "../repository.js";
import { ImportSkillVersionBindingError, LangSmithCredentialsMissingError, LangSmithIntegrationNotFoundError, NoCurrentSkillError, RecursiveTraceSkippedError } from "../repository.js";
import { LangSmithClient, type LangSmithTraceFetcher } from "../lib/langsmith.js";
import { scheduleImportedCaseJudging } from "./import-judging.js";

export interface LangSmithImportResult {
  imported: number;
  queued: number;
}

export type LangSmithClientFactory = (context: LangSmithImportContext) => LangSmithTraceFetcher;

export async function registerLangSmithImportWorker(
  queue: Queue,
  repository: CoevalRepository,
  createClient: LangSmithClientFactory = defaultLangSmithClientFactory
): Promise<void> {
  await queue.work<LangSmithImportJob>("langsmith.import", async ({ id, data }) => {
    try {
      await processLangSmithImportJob(repository, queue, data, createClient);
    } catch (error) {
      if (isPermanentLangSmithImportError(error)) {
        console.error(`langsmith.import job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });
}

export async function processLangSmithImportJob(
  repository: CoevalRepository,
  queue: Queue,
  job: LangSmithImportJob,
  createClient: LangSmithClientFactory = defaultLangSmithClientFactory
): Promise<LangSmithImportResult> {
  const parsed = LangSmithImportJobSchema.parse(job);
  if (parsed.importJobId) await repository.markImportJobRunning(parsed.projectId, parsed.importJobId);

  try {
    if (!parsed.skillVersionId) throw new ImportSkillVersionBindingError();
    const version = await repository.getSkillVersion(parsed.projectId, parsed.skillVersionId);
    if (!version) throw new ImportSkillVersionBindingError(`Unknown import skillVersionId for project: ${parsed.skillVersionId}`);
    const context = await repository.loadLangSmithImportContext(parsed);
    const traces = await createClient(context).listRuns({ projectName: context.projectName, limit: context.limit });

    let imported = 0;
    let skipped = 0;
    const caseIds: string[] = [];
    for (const trace of traces) {
      let row;
      try {
        row = await repository.importTrace(context.projectId, "langsmith", trace, {
          ingestionPurpose: "analysis_eligible_langsmith",
          sourceIntegrationId: context.id,
          importJobId: parsed.importJobId,
          normalizationVersion: "langsmith-v1",
          redactionConfig: context.redactionConfig
        });
      } catch (error) {
        if (error instanceof RecursiveTraceSkippedError) {
          // Anti-recursion guard (PR #46): upstream tagged this trace as
          // coeval-internal. Don't import, don't enqueue judge.run — just count
          // it as skipped so the import-job counters stay honest.
          skipped += 1;
          continue;
        }
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

export function defaultLangSmithClientFactory(context: LangSmithImportContext): LangSmithTraceFetcher {
  return new LangSmithClient({ apiKey: context.apiKey, endpointUrl: context.endpointUrl });
}

export function isPermanentLangSmithImportError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (error instanceof LangSmithIntegrationNotFoundError) return true;
  if (error instanceof LangSmithCredentialsMissingError) return true;
  if (error instanceof ImportSkillVersionBindingError) return true;
  if (error instanceof NoCurrentSkillError) return true;
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return true;
  }
  return false;
}
