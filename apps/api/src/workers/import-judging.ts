import type { Queue } from "@coeval/queue";
import type { CoevalRepository } from "../repository.js";
import { runExistingCaseBackfill } from "./gate.js";

export interface ImportedCaseJudgingResult {
  scheduledCaseCount: number;
  queueJobIds: string[];
  backfillRunId: string | null;
}

// The first imported evidence for a Check belongs to the durable onboarding
// backfill. Importing the same case and starting First Result may happen in
// either order, so both paths converge on the unique per-version run before a
// loose judge job is allowed. Once the Check already has a Result, imports use
// the ordinary per-case path.
export async function scheduleImportedCaseJudging(
  repository: CoevalRepository,
  queue: Queue | undefined,
  input: { projectId: string; skillVersionId: string; caseIds: string[] }
): Promise<ImportedCaseJudgingResult> {
  const caseIds = [...new Set(input.caseIds)];
  if (caseIds.length === 0) {
    return { scheduledCaseCount: 0, queueJobIds: [], backfillRunId: null };
  }

  const [existingResult] = await repository.listVerdicts({
    projectId: input.projectId,
    source: "llm_judge",
    skillVersionId: input.skillVersionId,
    limit: 1
  });
  const existingBackfill = (await repository.listEvalRuns(input.projectId, {
    limit: 100,
    skillVersionId: input.skillVersionId
  })).find((run) => run.trigger === "backfill");
  const importedCaseIds = new Set(caseIds);
  const projectCaseIds = await repository.listCaseIdsForProject(input.projectId);
  const isInitialEvidenceBatch = projectCaseIds.length > 0
    && projectCaseIds.every((caseId) => importedCaseIds.has(caseId));

  if (existingBackfill || (!existingResult && isInitialEvidenceBatch)) {
    const backfill = await runExistingCaseBackfill(
      repository,
      input.projectId,
      input.skillVersionId,
      queue
    );
    if (backfill) {
      const detail = await repository.getEvalRunDetail(input.projectId, backfill.id);
      const covered = new Set(detail?.items.map((item) => item.caseId) ?? []);
      const uncovered = caseIds.filter((caseId) => !covered.has(caseId));
      const queueJobIds = await sendLooseJudgeJobs(repository, queue, input, uncovered);
      return {
        scheduledCaseCount: caseIds.length - uncovered.length + queueJobIds.length,
        queueJobIds,
        backfillRunId: backfill.id
      };
    }
  }

  const queueJobIds = await sendLooseJudgeJobs(repository, queue, input, caseIds);
  return {
    scheduledCaseCount: queueJobIds.length,
    queueJobIds,
    backfillRunId: null
  };
}

async function sendLooseJudgeJobs(
  repository: CoevalRepository,
  queue: Queue | undefined,
  input: { projectId: string; skillVersionId: string },
  caseIds: string[]
): Promise<string[]> {
  const queueJobIds: string[] = [];
  for (const caseId of caseIds) {
    const [recorded] = await repository.listVerdicts({
      projectId: input.projectId,
      caseId,
      source: "llm_judge",
      skillVersionId: input.skillVersionId,
      limit: 1
    });
    if (recorded) continue;
    const jobId = await queue?.send("judge.run", {
      projectId: input.projectId,
      caseId,
      skillVersionId: input.skillVersionId
    }, { retryLimit: 5, retryBackoff: true });
    if (jobId) queueJobIds.push(jobId);
  }
  return queueJobIds;
}
