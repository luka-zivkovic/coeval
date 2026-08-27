import { z } from "zod";
import { IronsideImportJobSchema, type IronsideImportJob } from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import type { CoevalRepository, IronsideImportContext } from "../repository.js";
import { ImportSkillVersionBindingError, IronsideCredentialsMissingError, IronsideIntegrationNotFoundError, NoCurrentSkillError, RecursiveTraceSkippedError } from "../repository.js";
import { IronsideClient, ironsideTraceToTraceImport, type IronsideTraceSource } from "../lib/ironside.js";

// Reconcile sweep over ironside's native GET /api/v1/traces (issue #153).
//
// The invariant: coeval imports only SETTLED traces — those older than the
// connection's quiet period (ironside spec/trace-envelope-v1.md; interim
// approximation keyed on the trace's own timestamp until ironside ships
// explicit finalization semantics). Each job sweeps one window
// (watermark, now - quietPeriod] with the API's keyset cursor:
//   - window drained  -> watermark advances to the window end
//   - budget hit      -> the cursor + window end persist, and the NEXT job
//                        resumes the same window instead of restarting it
// Overlap at window boundaries is safe: importTrace dedupes on
// (project, source_trace_id) — at-least-once, never lossy.

export interface IronsideImportResult {
  imported: number;
  queued: number;
  scanned: number;
  drained: boolean;
}

export type IronsideClientFactory = (context: IronsideImportContext) => IronsideTraceSource;

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
  now: Date = new Date()
): Promise<IronsideImportResult> {
  const parsed = IronsideImportJobSchema.parse(job);
  if (parsed.importJobId) await repository.markImportJobRunning(parsed.projectId, parsed.importJobId);

  try {
    if (!parsed.skillVersionId) throw new ImportSkillVersionBindingError();
    const version = await repository.getSkillVersion(parsed.projectId, parsed.skillVersionId);
    if (!version) throw new ImportSkillVersionBindingError(`Unknown import skillVersionId for project: ${parsed.skillVersionId}`);
    const context = await repository.loadIronsideImportContext(parsed);
    const client = createClient(context);

    const settledTo = new Date(now.getTime() - context.quietPeriodSeconds * 1000).toISOString();
    const state = context.syncState;
    const resuming = state.cursor !== null && state.windowTo !== null;
    // A resumed window keeps its ORIGINAL end: the keyset cursor was minted
    // against that ordering, and the watermark may only advance to a bound
    // the sweep actually covered.
    const windowTo = resuming ? state.windowTo! : settledTo;
    const from = state.watermark ?? undefined;
    let cursor = resuming ? state.cursor : null;

    let imported = 0;
    let queued = 0;
    let scanned = 0;

    if (from !== undefined && from >= windowTo) {
      // Nothing settled since the last sweep. The watermark must not move
      // (especially not BACKWARDS if the quiet period grew).
      if (parsed.importJobId) {
        await repository.markImportJobCompleted(parsed.projectId, parsed.importJobId, { importedCount: 0, queuedJudgeCount: 0 });
      }
      return { imported: 0, queued: 0, scanned: 0, drained: true };
    }

    let drained = false;
    while (!drained && scanned < context.limit) {
      const page = await client.listTraces({
        ...(from !== undefined ? { from } : {}),
        to: windowTo,
        ...(cursor ? { cursor } : {}),
        limit: Math.min(context.limit - scanned, 100)
      });

      for (const summary of page.traces) {
        scanned += 1;
        const tree = await client.getTrace(summary.id);
        let row;
        try {
          row = await repository.importTrace(context.projectId, "ironside", ironsideTraceToTraceImport(tree), {
            ingestionPurpose: "analysis_eligible_ironside",
            sourceIntegrationId: context.id,
            importJobId: parsed.importJobId,
            normalizationVersion: "ironside-v1",
            redactionConfig: context.redactionConfig
          });
        } catch (error) {
          if (error instanceof RecursiveTraceSkippedError) continue;
          throw error;
        }
        if (row.created) imported += 1;
        const jobId = await queue.send("judge.run", {
          projectId: context.projectId,
          caseId: row.caseId,
          skillVersionId: version.id
        }, { retryLimit: 5, retryBackoff: true });
        if (jobId) queued += 1;
      }

      cursor = page.nextCursor;
      if (!cursor) drained = true;
    }

    await repository.saveIronsideSyncState(context.projectId, context.id, drained
      ? { watermark: windowTo, cursor: null, windowTo: null }
      : { watermark: state.watermark ?? null, cursor, windowTo });

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

export function defaultIronsideClientFactory(context: IronsideImportContext): IronsideTraceSource {
  return new IronsideClient({ url: context.url, apiKey: context.apiKey });
}

export function isPermanentIronsideImportError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (error instanceof IronsideIntegrationNotFoundError) return true;
  if (error instanceof IronsideCredentialsMissingError) return true;
  if (error instanceof ImportSkillVersionBindingError) return true;
  if (error instanceof NoCurrentSkillError) return true;
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return true;
  }
  return false;
}
