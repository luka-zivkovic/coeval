import { z } from "zod";
import { IronsideImportJobSchema, type IronsideImportJob } from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import type { CoevalRepository, IronsideImportContext } from "../repository.js";
import {
  ImportSkillVersionBindingError,
  IronsideCredentialsMissingError,
  IronsideIntegrationRevalidationRequiredError,
  IronsideIntegrationNotFoundError,
  NoCurrentSkillError,
  RecursiveTraceSkippedError
} from "../repository.js";
import {
  IronsideClient,
  IronsideHttpError,
  IronsideTraceTooLargeError,
  ironsideTraceToTraceImport,
  type IronsideTraceSource
} from "../lib/ironside.js";
import { assertImportJudgingAllowed, scheduleImportedCaseJudging } from "./import-judging.js";

export interface IronsideImportResult {
  imported: number;
  queued: number;
  scanned: number;
  drained: boolean;
}

export type IronsideClientFactory = (context: Pick<IronsideImportContext, "url" | "apiKey">) => IronsideTraceSource;

const MAX_IRONSIDE_PAGES_PER_JOB = 100;
const MAX_IRONSIDE_IMPORT_WALL_MS = 30_000;
// Opaque cursors commit whole pages. One trace per page guarantees that a
// slow-but-successful detail request can still advance durable progress instead
// of replaying the same expensive prefix at every aggregate deadline.
const IRONSIDE_TRACE_PAGE_SIZE = 1;

export async function registerIronsideImportWorker(
  queue: Queue,
  repository: CoevalRepository,
  createClient: IronsideClientFactory = defaultIronsideClientFactory
): Promise<void> {
  await queue.work<IronsideImportJob>("ironside.import", async ({ id, data }) => {
    try {
      await processIronsideImportJob(repository, queue, data, createClient);
    } catch (error) {
      if (isPermanentIronsideImportError(error)) {
        console.error(`ironside.import job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });
}

export async function processIronsideImportJob(
  repository: CoevalRepository,
  queue: Queue,
  job: IronsideImportJob,
  createClient: IronsideClientFactory = defaultIronsideClientFactory,
  _now: Date = new Date()
): Promise<IronsideImportResult> {
  const parsed = IronsideImportJobSchema.parse(job);
  if (parsed.importJobId) await repository.markImportJobRunning(parsed.projectId, parsed.importJobId);

  try {
    if (!parsed.skillVersionId) throw new ImportSkillVersionBindingError();
    const version = await repository.getSkillVersion(parsed.projectId, parsed.skillVersionId);
    if (!version) throw new ImportSkillVersionBindingError(`Unknown import skillVersionId for project: ${parsed.skillVersionId}`);
    await assertImportJudgingAllowed(repository, parsed.projectId, version.id);
    const context = await repository.loadIronsideImportContext(parsed);
    if (context.revalidationRequired || context.remoteProjectId.startsWith("unverified:")) {
      throw new IronsideIntegrationRevalidationRequiredError(context.id);
    }
    const client = createClient(context);
    const remote = await client.getContext();
    if (remote.project.id !== context.remoteProjectId) {
      const checkedAt = new Date().toISOString();
      const quarantined = await repository.quarantineIronsideIntegration(
        context.projectId,
        context.id,
        context.remoteProjectId,
        {
        ok: false,
        checkedAt,
        error: `Configured credentials resolve to Ironside project ${remote.project.id}, expected ${context.remoteProjectId}`
        }
      );
      if (!quarantined) throw new Error("Ironside integration changed during identity check");
      throw new IronsideIntegrationRevalidationRequiredError(context.id);
    }

    let cursor = context.syncState.cursor;
    const initialCursor = cursor;
    let imported = 0;
    let scanned = 0;
    let drained = false;
    const caseIds: string[] = [];
    let pages = 0;
    const deadline = Date.now() + MAX_IRONSIDE_IMPORT_WALL_MS;

    while (
      !drained &&
      scanned < context.limit &&
      pages < MAX_IRONSIDE_PAGES_PER_JOB &&
      Date.now() < deadline
    ) {
      pages += 1;
      const page = await client.listTraces({
        ...(cursor ? { cursor } : {}),
        limit: IRONSIDE_TRACE_PAGE_SIZE
      });
      if (page.traces.length > IRONSIDE_TRACE_PAGE_SIZE) {
        throw new Error("Ironside evaluator feed returned more traces than requested");
      }
      const pageStartCursor = cursor;
      let completedPage = true;

      for (const summary of page.traces) {
        if (Date.now() >= deadline) {
          completedPage = false;
          break;
        }
        scanned += 1;
        let tree;
        try {
          tree = await client.getTrace(summary.traceId, summary.traceVersion);
        } catch (error) {
          // A trace can reopen between the feed page and detail request. The
          // old version may be replaced, retained away, or temporarily become
          // unsettled after a quiet-period change. Retain the page-start cursor
          // for every 404/409: exact source dedupe makes the prefix replay safe,
          // and a later list either serves the settled version or advances the
          // retention orphan itself. Advancing here could permanently skip a
          // version that receives no new publication.
          if (error instanceof IronsideHttpError && (error.status === 404 || error.status === 409)) {
            completedPage = false;
            break;
          }
          throw error;
        }
        let row;
        try {
          row = await repository.importTrace(context.projectId, "ironside", ironsideTraceToTraceImport(tree), {
            ingestionPurpose: "analysis_eligible_ironside",
            sourceIntegrationId: context.id,
            sourceTraceVersion: tree.traceVersion,
            sourceRemoteProjectId: context.remoteProjectId,
            importJobId: parsed.importJobId,
            normalizationVersion: "ironside-evaluator-v1",
            redactionConfig: context.redactionConfig
          });
        } catch (error) {
          if (error instanceof RecursiveTraceSkippedError) continue;
          if (error instanceof IronsideTraceTooLargeError) {
            console.error(`Skipping Ironside trace ${summary.traceId} instead of truncating it:`, error);
            continue;
          }
          throw error;
        }
        if (row.created) imported += 1;
        // Include no-op imports too: a worker retry may have committed the
        // trace snapshot immediately before failing to durably queue judging.
        caseIds.push(row.caseId);
      }

      if (!completedPage) {
        // A feed cursor commits the entire page. Retain its starting point
        // when yielding mid-page; exact source dedupe makes the safe prefix a
        // no-op on retry without dropping the unvisited suffix.
        cursor = pageStartCursor;
        break;
      }

      const previousCursor = cursor;
      cursor = page.nextCursor;
      drained = !page.hasMore;
      if (!drained && page.traces.length === 0 && cursor === previousCursor) break;
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

    await repository.saveIronsideSyncState(
      context.projectId,
      context.id,
      { cursor },
      initialCursor
    );
    if (parsed.importJobId) {
      await repository.markImportJobCompleted(parsed.projectId, parsed.importJobId, {
        importedCount: imported,
        queuedJudgeCount: queued
      });
    }
    return { imported, queued, scanned, drained };
  } catch (error) {
    if (parsed.importJobId) await repository.markImportJobFailed(parsed.projectId, parsed.importJobId, error).catch(() => undefined);
    throw error;
  }
}

export function defaultIronsideClientFactory(context: Pick<IronsideImportContext, "url" | "apiKey">): IronsideTraceSource {
  return new IronsideClient({ url: context.url, apiKey: context.apiKey });
}

export function isPermanentIronsideImportError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (error instanceof IronsideIntegrationNotFoundError) return true;
  if (error instanceof IronsideCredentialsMissingError) return true;
  if (error instanceof IronsideIntegrationRevalidationRequiredError) return true;
  if (error instanceof ImportSkillVersionBindingError) return true;
  if (error instanceof NoCurrentSkillError) return true;
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return true;
  }
  return false;
}
