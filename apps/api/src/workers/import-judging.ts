import type { Queue } from "@coeval/queue";
import {
  ImportSkillVersionBindingError,
  NoCurrentSkillError,
  type CoevalRepository
} from "../repository.js";
import { dispatchEvalRunOnce, runExistingCaseBackfill } from "./gate.js";

export interface ImportedCaseJudgingResult {
  scheduledCaseCount: number;
  evalRunIds: string[];
  backfillRunId: string | null;
  dispatchPending: boolean;
}

export async function assertImportJudgingAllowed(
  repository: CoevalRepository,
  projectId: string,
  skillVersionId: string
): Promise<void> {
  const version = await repository.getSkillVersion(projectId, skillVersionId);
  const criterionVersion = version
    ? await repository.getCriterionVersionForSkillVersion(projectId, skillVersionId)
    : null;
  let currentSkill = null;
  if (criterionVersion) {
    try {
      currentSkill = await repository.getCurrentSkillForCriterion(projectId, criterionVersion.criterionId);
    } catch (error) {
      if (!(error instanceof NoCurrentSkillError)) throw error;
    }
  }
  const starterDraft = currentSkill?.isStarter === true && version?.status === "draft";
  if (
    !version ||
    !currentSkill ||
    currentSkill.currentVersion.id !== version.id ||
    (!starterDraft && version.status !== "approved" && version.status !== "production")
  ) {
    throw new ImportSkillVersionBindingError(
      "Imported Runs can be evaluated only by the current runnable Check."
    );
  }
}

// Before the first customer-evidence Result, every importer converges on the
// unique backfill run. Later cases use one durable, unique run per
// (project, Check version, case), so concurrent imports and worker retries
// cannot enqueue a second provider call.
export async function scheduleImportedCaseJudging(
  repository: CoevalRepository,
  queue: Queue | undefined,
  input: { projectId: string; skillVersionId: string; caseIds: string[] }
): Promise<ImportedCaseJudgingResult> {
  await assertImportJudgingAllowed(repository, input.projectId, input.skillVersionId);
  const caseIds = [...new Set(input.caseIds)];
  if (caseIds.length === 0) {
    return {
      scheduledCaseCount: 0,
      evalRunIds: [],
      backfillRunId: null,
      dispatchPending: false
    };
  }

  const [existingResult] = await repository.listVerdicts({
    projectId: input.projectId,
    source: "llm_judge",
    skillVersionId: input.skillVersionId,
    evidenceScope: "customer",
    limit: 1
  });
  const existingBackfill = (await repository.listEvalRuns(input.projectId, {
    limit: 100,
    skillVersionId: input.skillVersionId
  })).find((run) => run.trigger === "backfill");

  let remaining = caseIds;
  let scheduledCaseCount = 0;
  let backfillRunId: string | null = null;
  let dispatchPending = false;
  const evalRunIds: string[] = [];
  if (existingBackfill || !existingResult) {
    const backfill = await runExistingCaseBackfill(
      repository,
      input.projectId,
      input.skillVersionId,
      queue
    );
    if (backfill) {
      backfillRunId = backfill.run.id;
      evalRunIds.push(backfill.run.id);
      dispatchPending = backfill.dispatchState === "busy";
      const detail = await repository.getEvalRunDetail(input.projectId, backfill.run.id);
      const covered = new Set(detail?.items.map((item) => item.caseId) ?? []);
      if (detail?.status === "pending" || detail?.status === "running") {
        scheduledCaseCount += caseIds.filter((caseId) => covered.has(caseId)).length;
      }
      remaining = caseIds.filter((caseId) => !covered.has(caseId));
    }
  }

  for (const caseId of remaining) {
    const [recorded] = await repository.listVerdicts({
      projectId: input.projectId,
      caseId,
      source: "llm_judge",
      skillVersionId: input.skillVersionId,
      evidenceScope: "customer",
      limit: 1
    });
    if (recorded) continue;
    const importedRun = await repository.createImportedCaseEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      caseId
    });
    const dispatchState = await dispatchEvalRunOnce(repository, importedRun.run, queue);
    evalRunIds.push(importedRun.run.id);
    if (importedRun.run.status === "pending" || importedRun.run.status === "running") {
      scheduledCaseCount += 1;
    }
    if (dispatchState === "busy") dispatchPending = true;
  }

  return {
    scheduledCaseCount,
    evalRunIds: [...new Set(evalRunIds)],
    backfillRunId,
    dispatchPending
  };
}
