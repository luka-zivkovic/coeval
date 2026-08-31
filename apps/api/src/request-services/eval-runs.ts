import type {
  DatasetDetail,
  DatasetRevisionDetail,
  EvalRun,
  TraceTestRunSource
} from "@coeval/shared";
import type { Queue, QueueSendOptions } from "@coeval/queue";
import {
  DatasetRevisionConflictError,
  SealedValidationUnavailableError,
  type CoevalRepository
} from "../repository.js";
import { runEvalRunInline } from "../workers/eval-run.js";

export interface DatasetEvalRunInput {
  projectId: string;
  dataset: DatasetDetail;
  skillVersionId: string;
  createdByUserId?: string | undefined;
  sourceTraceTest?: TraceTestRunSource | undefined;
}

export interface DatasetRevisionEvalRunInput {
  projectId: string;
  revision: DatasetRevisionDetail;
  skillVersionId: string;
  createdByUserId?: string | undefined;
}

export interface EvalRunRequestService {
  createDataset(input: DatasetEvalRunInput): Promise<EvalRun>;
  createDatasetRevision(input: DatasetRevisionEvalRunInput): Promise<EvalRun>;
  dispatch(projectId: string, run: EvalRun, queueOptions?: QueueSendOptions): Promise<EvalRun>;
  startDataset(input: DatasetEvalRunInput): Promise<EvalRun>;
  startDatasetRevision(input: DatasetRevisionEvalRunInput): Promise<EvalRun>;
}

// The one dataset-to-eval-run path. Creation snapshots data without spending;
// dispatch is the only fan-out boundary and either queues the durable run or
// executes the same run inline in demo mode.
export function createEvalRunRequestService(
  repository: CoevalRepository,
  queue: Queue | undefined
): EvalRunRequestService {
  const createDataset = async (input: DatasetEvalRunInput): Promise<EvalRun> =>
    repository.createEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "manual",
      datasetId: input.dataset.id,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.sourceTraceTest ? { sourceTraceTest: input.sourceTraceTest } : {}),
      items: input.dataset.items.map((item) => ({
        caseId: item.caseId,
        datasetItemId: item.id,
        ...(item.expectedLabel ? { expectedLabel: item.expectedLabel } : {}),
        ...(item.expectedFailStep !== null ? { expectedFailStep: item.expectedFailStep } : {})
      }))
    });

  const createDatasetRevision = async (input: DatasetRevisionEvalRunInput): Promise<EvalRun> => {
    if (input.revision.role === "sealed_validation") {
      throw new SealedValidationUnavailableError();
    }
    if (input.revision.sourceKind === "analysis_population") {
      throw new DatasetRevisionConflictError(
        "Analysis population revisions cannot run through the ordinary evaluation path"
      );
    }
    const items = input.revision.items.map((item) => {
      if (!item.sourceCaseId) {
        throw new DatasetRevisionConflictError(
          `Dataset revision item ${item.id} has no judgeable case identity`
        );
      }
      return {
        caseId: item.sourceCaseId,
        datasetRevisionItemId: item.id,
        ...(item.referenceLabel ? { expectedLabel: item.referenceLabel } : {}),
        ...(item.referenceFailStep !== null ? { expectedFailStep: item.referenceFailStep } : {})
      };
    });
    return repository.createEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "manual",
      datasetRevisionId: input.revision.id,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      items
    });
  };

  const dispatch = async (
    projectId: string,
    run: EvalRun,
    queueOptions: QueueSendOptions = {}
  ): Promise<EvalRun> => {
    if (queue) {
      // Arm recovery before the external write so a process death after send
      // can be reconciled even if the queue handler never starts.
      await repository.armEvalRunItemDeliveryDeadline(projectId, run.id);
      await queue.send("eval.run", { projectId, evalRunId: run.id }, {
        retryLimit: 5,
        retryBackoff: true,
        ...queueOptions
      });
    } else {
      await runEvalRunInline(repository, projectId, run.id);
    }
    return (await repository.getEvalRun(projectId, run.id)) ?? run;
  };

  return {
    createDataset,
    createDatasetRevision,
    dispatch,
    async startDataset(input) {
      const run = await createDataset(input);
      return dispatch(input.projectId, run);
    },
    async startDatasetRevision(input) {
      const run = await createDatasetRevision(input);
      return dispatch(input.projectId, run);
    }
  };
}
