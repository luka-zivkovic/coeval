import { createHash } from "node:crypto";
import {
  GovernedBlindTaskViewSchema,
  GovernedDatasetReferenceProvenanceSchema,
  GovernedReviewAdjudicationSchema,
  GovernedReviewAlignmentEventSchema,
  GovernedReviewBatchEventSchema,
  GovernedReviewBatchSchema,
  GovernedReviewInstructionVersionSchema,
  GovernedReviewItemSchema,
  GovernedReviewLabelSchema,
  GovernedReviewSelectionPlanSchema,
  GovernedReviewTaskEventSchema,
  GovernedReviewTaskSchema,
  GovernedTruthResolutionSchema,
  ImportedHumanTruthSchema,
  RepresentativeClaimEligibilitySchema,
  type CriterionVersion,
  type GovernedBlindTaskView,
  type GovernedDatasetReferenceProvenance,
  type GovernedReviewAdjudication,
  type GovernedReviewAlignmentEvent,
  type GovernedReviewBatch,
  type GovernedReviewBatchEvent,
  type GovernedReviewBatchState,
  type GovernedReviewInstructionVersion,
  type GovernedReviewItem,
  type GovernedReviewLabel,
  type GovernedReviewSelectionPlan,
  type GovernedReviewTask,
  type GovernedReviewTaskEvent,
  type GovernedTruthResolution,
  type ImportedHumanTruth,
  type RepresentativeClaimEligibility,
  type RepresentativeClaimReason
} from "@coeval/shared";
import { canonicalJson, sha256Digest } from "./assessment-receipt.js";
import { evaluatorSuiteCriterionDigest } from "./evaluator-suite.js";
import { governedContentV1Digest } from "./governed-content-digest.js";
export {
  GOVERNED_CONTENT_CANONICALIZATION_VERSION,
  canonicalGovernedJsonV1,
  governedContentV1CanonicalBytes,
  governedContentV1Digest,
  verifyGovernedContentV1Digest
} from "./governed-content-digest.js";

const FORBIDDEN_BLIND_KEYS = new Set([
  "caseId", "traceId", "sourceCaseId", "sourceTraceId", "datasetId", "datasetItemId",
  "datasetRevisionId", "datasetRevisionItemId", "sourceDatasetRevisionId",
  "sourceDatasetRevisionItemId", "sourceRevisionId", "sourceRevisionItemId", "sealedIntakeId",
  "sealedIntakeItemId", "sealedIntakePopulationId", "skillVersionId",
  "evaluatorVersionId", "evaluatorOutput", "evaluatorOutputs", "evaluatorLabel",
  "evaluatorRationale", "judgeLabel", "judgedLabel", "judgeRationale", "judgeRun",
  "rawJudgeCall", "rawRequest", "rawResponse", "expectedLabel", "expectedFailStep",
  "goldenLabel", "latestHumanLabel", "peerLabel", "peerLabels", "adjudication",
  "verdict", "verdicts"
]);
const NORMALIZED_FORBIDDEN_BLIND_KEYS = new Set(
  [...FORBIDDEN_BLIND_KEYS].map((key) => normalizeBlindKey(key))
);

const MAX_GOVERNED_REVIEW_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_IMPORTED_SOURCE_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_COLLECTION_PROVENANCE_BYTES = 256 * 1024;

export function governedReviewInstructionDigest(
  input: Omit<GovernedReviewInstructionVersion, "instructionDigest"> | GovernedReviewInstructionVersion
): string {
  const instruction = input as GovernedReviewInstructionVersion;
  return governedContentV1Digest("review-instruction/v1", {
    allowedLabels: instruction.allowedLabels,
    criterionVersionId: instruction.criterionVersionId,
    failureCodeGuidance: instruction.failureCodeGuidance,
    id: instruction.instructionVersionId,
    instructions: instruction.instructions,
    predecessorInstructionVersionId: instruction.predecessorInstructionVersionId,
    revision: instruction.revision,
    title: instruction.title
  });
}

// The remaining shared schemas are closed domain artifacts, not lossless
// projections of their wider relational rows. Their digest helpers therefore
// say DomainArtifact and use distinct, full kind names. Persisted row digests
// must be verified with governedContentV1Digest and the migration's exact
// kind/content projection; they are never interchangeable by short name.

export function verifyGovernedReviewInstructionVersion(raw: unknown): GovernedReviewInstructionVersion {
  const instruction = GovernedReviewInstructionVersionSchema.parse(raw);
  if (instruction.instructionDigest !== governedReviewInstructionDigest(instruction)) {
    throw new Error("governed review instruction digest mismatch");
  }
  if ((instruction.revision === 1) !== (instruction.predecessorInstructionVersionId === null)) {
    throw new Error("governed review instruction predecessor is inconsistent with its revision");
  }
  return instruction;
}

export function governedReviewItemDomainArtifactDigest(
  input: Omit<GovernedReviewItem, "itemDigest"> | GovernedReviewItem
): string {
  const { itemDigest: _excluded, ...unsigned } = input as GovernedReviewItem;
  return governedContentV1Digest("coeval/governed-review-item-domain-artifact/v1", unsigned);
}

export function verifyGovernedReviewItem(raw: unknown): GovernedReviewItem {
  const item = GovernedReviewItemSchema.parse(raw);
  assertCanonicalJsonSize(item.payloadSnapshot, "governed review payload snapshot", MAX_GOVERNED_REVIEW_PAYLOAD_BYTES);
  if (item.itemDigest !== governedReviewItemDomainArtifactDigest(item)) {
    throw new Error("governed review item domain-artifact digest mismatch");
  }
  return item;
}

export function governedReviewSelectionDrawDomainArtifactDigest(plan: Pick<
  GovernedReviewSelectionPlan,
  "method" | "seed" | "rngVersion" | "drawItemDigests"
>): string {
  return governedContentV1Digest("coeval/governed-review-selection-draw-domain-artifact/v1", {
    method: plan.method,
    seed: plan.seed,
    rngVersion: plan.rngVersion,
    drawItemDigests: plan.drawItemDigests
  });
}

export function governedReviewStratumDrawDomainArtifactDigest(input: {
  key: string;
  drawItemDigests: readonly string[];
}): string {
  return governedContentV1Digest(
    "coeval/governed-review-selection-stratum-draw-domain-artifact/v1",
    { key: input.key, drawItemDigests: input.drawItemDigests }
  );
}

export function governedReviewSelectionPlanDomainArtifactDigest(
  input: Omit<GovernedReviewSelectionPlan, "selectionPlanDigest"> | GovernedReviewSelectionPlan
): string {
  const { selectionPlanDigest: _excluded, ...unsigned } = input as GovernedReviewSelectionPlan;
  return governedContentV1Digest("coeval/governed-review-selection-domain-artifact/v1", unsigned);
}

export function verifyGovernedReviewSelectionPlan(raw: unknown): GovernedReviewSelectionPlan {
  const plan = GovernedReviewSelectionPlanSchema.parse(raw);
  if (plan.selectionPlanDigest !== governedReviewSelectionPlanDomainArtifactDigest(plan)) {
    throw new Error("governed review selection plan domain-artifact digest mismatch");
  }
  assertCanonicalJsonSize(plan.collectionProvenance, "governed review collection provenance", MAX_COLLECTION_PROVENANCE_BYTES);
  if (plan.collectionProvenanceDigest !== sha256Digest(plan.collectionProvenance)) {
    throw new Error("governed review collection provenance digest mismatch");
  }
  if (plan.drawDigest !== governedReviewSelectionDrawDomainArtifactDigest(plan)) {
    throw new Error("governed review selection draw domain-artifact digest mismatch");
  }
  if (plan.fixedBudget !== plan.drawItemDigests.length) {
    throw new Error("governed review fixed budget does not match selected draw");
  }
  if (plan.fixedBudget > plan.populationSize) {
    throw new Error("governed review fixed budget exceeds its source population");
  }
  if (Date.parse(plan.timeWindow.startInclusive) >= Date.parse(plan.timeWindow.endExclusive)) {
    throw new Error("governed review population time window must be ascending");
  }
  assertUnique(plan.drawItemDigests, "governed review draw item digest");
  assertSortedUnique(plan.strata.map((stratum) => stratum.key), "governed review stratum key");

  const isRandom = plan.method === "simple_random" || plan.method === "stratified_random";
  if (isRandom && (plan.seed === null || plan.rngVersion === null)) {
    throw new Error("random governed review selection requires a seed and RNG version");
  }
  if (plan.method === "simple_random") {
    if (plan.strata.length > 0) throw new Error("simple random selection cannot declare strata");
    const expectedProbability = plan.fixedBudget / plan.populationSize;
    if (plan.inclusionProbability !== expectedProbability || plan.weight !== 1 / expectedProbability) {
      throw new Error("simple random selection probability or weight is inconsistent");
    }
  } else if (plan.method === "stratified_random") {
    if (plan.strata.length === 0) throw new Error("stratified governed review selection requires strata");
    if (plan.inclusionProbability !== null || plan.weight !== null) {
      throw new Error("stratified selection declares probability and weight per stratum");
    }
    const population = plan.strata.reduce((sum, stratum) => sum + stratum.populationSize, 0);
    const budget = plan.strata.reduce((sum, stratum) => sum + stratum.fixedBudget, 0);
    if (population !== plan.populationSize || budget !== plan.fixedBudget) {
      throw new Error("governed review stratum population or budget totals are inconsistent");
    }
    const stratumDraws = plan.strata.flatMap((stratum) => {
      if (stratum.fixedBudget > stratum.populationSize || stratum.drawItemDigests.length !== stratum.fixedBudget) {
        throw new Error("governed review stratum draw does not match its budget");
      }
      const probability = stratum.populationSize === 0 ? 0 : stratum.fixedBudget / stratum.populationSize;
      if (probability === 0 || stratum.inclusionProbability !== probability || stratum.weight !== 1 / probability) {
        throw new Error("governed review stratum probability or weight is inconsistent");
      }
      if (stratum.drawDigest !== governedReviewStratumDrawDomainArtifactDigest(stratum)) {
        throw new Error("governed review stratum draw domain-artifact digest mismatch");
      }
      assertUnique(stratum.drawItemDigests, `governed review stratum ${stratum.key} draw item`);
      return stratum.drawItemDigests;
    });
    assertExactSet(stratumDraws, plan.drawItemDigests, "governed review stratum draw item");
  } else {
    if (plan.strata.length > 0) throw new Error("only stratified random selection may declare strata");
    if (plan.inclusionProbability !== null || plan.weight !== null) {
      throw new Error("non-random selection cannot assert random inclusion probabilities");
    }
  }
  return plan;
}

export function governedReviewBatchDomainArtifactDigest(
  input: Omit<GovernedReviewBatch, "batchDigest"> | GovernedReviewBatch
): string {
  const { batchDigest: _excluded, ...unsigned } = input as GovernedReviewBatch;
  return governedContentV1Digest("coeval/governed-review-batch-domain-artifact/v1", unsigned);
}

export function verifyGovernedReviewBatch(
  raw: unknown,
  instruction?: GovernedReviewInstructionVersion
): GovernedReviewBatch {
  const batch = GovernedReviewBatchSchema.parse(raw);
  verifyGovernedReviewSelectionPlan(batch.selectionPlan);
  if (batch.batchDigest !== governedReviewBatchDomainArtifactDigest(batch)) {
    throw new Error("governed review batch domain-artifact digest mismatch");
  }
  if (Date.parse(batch.createdAt) >= Date.parse(batch.fixedStopAt)) {
    throw new Error("governed review fixed stop must be after batch creation");
  }
  assertContiguousPositions(batch.members.map((member) => member.servePosition), "governed review member");
  assertUnique(batch.members.map((member) => member.reviewItemId), "governed review member item");
  assertUnique(batch.members.flatMap((member) => member.taskIds), "governed review member task");
  for (const member of batch.members) {
    if (member.taskIds.length !== batch.requiredIndependentLabels) {
      throw new Error(`governed review member ${member.reviewItemId} does not have the required number of assignments`);
    }
  }
  if (batch.selectionPlan.fixedBudget !== batch.members.length) {
    throw new Error("governed review batch membership does not match its fixed selection budget");
  }
  if (batch.members.some((member, index) => member.reviewItemDigest !== batch.selectionPlan.drawItemDigests[index])) {
    throw new Error("governed review batch member order does not match the server draw");
  }
  assertSortedUnique(batch.developmentCapabilitySubjectIds, "governed review development-capability subject");
  assertSortedUnique(batch.developmentExposureSubjectIds, "governed review development exposure subject");
  if (batch.roleIntent === "sealed_validation") {
    if (batch.sourcePopulationKind !== "sealed_intake") {
      throw new Error("sealed governed review requires a sealed-intake source population");
    }
    if (!batch.evaluatorBlind) throw new Error("sealed governed review must be evaluator blind");
    if (!batch.peerBlindUntilLabelingClosed || !batch.separationOfDutiesRequired) {
      throw new Error("sealed governed review requires peer blindness and separation of duties");
    }
    if (batch.custodianRoleAtReview === null) throw new Error("sealed governed review requires a custodian role snapshot");
    if (batch.requiredIndependentLabels < 2) {
      throw new Error("sealed governed review requires at least two independent labels");
    }
    if (batch.developmentIdentityStatus !== "resolved") {
      throw new Error("sealed governed review requires resolved development identity");
    }
    assertSubjectSeparated(batch.custodianSubjectId, batch, "custodian");
  } else if (batch.sourcePopulationKind !== "dataset_revision") {
    throw new Error("nonsealed governed review requires a dataset-revision source population");
  }
  if (instruction) {
    verifyGovernedReviewInstructionVersion(instruction);
    assertSame(batch.projectId, instruction.projectId, "batch instruction project");
    assertSame(batch.criterionId, instruction.criterionId, "batch instruction criterion");
    assertSame(batch.criterionVersionId, instruction.criterionVersionId, "batch instruction criterion version");
    assertSame(batch.instructionVersionId, instruction.instructionVersionId, "batch instruction version");
    assertSame(batch.instructionDigest, instruction.instructionDigest, "batch instruction digest");
  }
  return batch;
}

export function governedReviewTaskDomainArtifactDigest(
  input: Omit<GovernedReviewTask, "taskDigest"> | GovernedReviewTask
): string {
  const { taskDigest: _excluded, ...unsigned } = input as GovernedReviewTask;
  return governedContentV1Digest("coeval/governed-review-task-domain-artifact/v1", unsigned);
}

export function verifyGovernedReviewTask(raw: unknown, batch?: GovernedReviewBatch): GovernedReviewTask {
  const task = GovernedReviewTaskSchema.parse(raw);
  if (task.taskDigest !== governedReviewTaskDomainArtifactDigest(task)) {
    throw new Error("governed review task domain-artifact digest mismatch");
  }
  if (batch) {
    verifyGovernedReviewBatch(batch);
    assertSame(task.projectId, batch.projectId, "task batch project");
    assertSame(task.batchId, batch.batchId, "task batch identity");
    assertSame(task.criterionVersionId, batch.criterionVersionId, "task criterion version");
    assertSame(task.instructionVersionId, batch.instructionVersionId, "task instruction version");
    const member = batch.members.find((candidate) => candidate.reviewItemId === task.reviewItemId);
    if (!member || !member.taskIds.includes(task.taskId)) {
      throw new Error("governed review task is not frozen in its batch membership");
    }
    if (member.servePosition !== task.servePosition) {
      throw new Error("governed review task serve position does not match its batch member");
    }
    if (task.assignmentOrdinal >= member.taskIds.length || member.taskIds[task.assignmentOrdinal] !== task.taskId) {
      throw new Error("governed review task assignment ordinal is inconsistent");
    }
    if (batch.roleIntent === "sealed_validation") assertSubjectSeparated(task.reviewerSubjectId, batch, "reviewer");
  }
  return task;
}

export function governedReviewLabelDomainArtifactDigest(
  input: Omit<GovernedReviewLabel, "labelDigest"> | GovernedReviewLabel
): string {
  const { labelDigest: _excluded, ...unsigned } = input as GovernedReviewLabel;
  return governedContentV1Digest("coeval/governed-review-label-domain-artifact/v1", unsigned);
}

export function verifyGovernedReviewLabel(raw: unknown, task?: GovernedReviewTask): GovernedReviewLabel {
  const label = GovernedReviewLabelSchema.parse(raw);
  assertSortedUnique(label.failureCodes, "governed review failure code");
  if (label.labelDigest !== governedReviewLabelDomainArtifactDigest(label)) {
    throw new Error("governed review label domain-artifact digest mismatch");
  }
  if (task) assertLabelTaskScope(label, task);
  return label;
}

export function governedReviewTaskEventDomainArtifactDigest(
  input: Omit<GovernedReviewTaskEvent, "eventDigest"> | GovernedReviewTaskEvent
): string {
  const { eventDigest: _excluded, ...unsigned } = input as GovernedReviewTaskEvent;
  return governedContentV1Digest("coeval/governed-review-task-event-domain-artifact/v1", unsigned);
}

export type GovernedReviewTaskState = "assigned" | "viewed" | "deferred" | "submitted" | "withdrawn" | "expired";

export interface GovernedReviewTaskHistory {
  state: GovernedReviewTaskState;
  activeLabel: GovernedReviewLabel | null;
  labels: GovernedReviewLabel[];
  withdrawnLabelIds: string[];
  viewDigest: string | null;
  canonicalViewBytesBase64: string | null;
  lastSequence: number;
  lastEventDigest: string | null;
}

export function deriveGovernedReviewTaskHistory(input: {
  task: GovernedReviewTask;
  events: GovernedReviewTaskEvent[];
  labels: GovernedReviewLabel[];
  revealedLabelIds?: ReadonlySet<string>;
}): GovernedReviewTaskHistory {
  const task = verifyGovernedReviewTask(input.task);
  const labels = input.labels.map((label) => verifyGovernedReviewLabel(label, task));
  assertUnique(labels.map((label) => label.labelId), "governed review label");
  const labelsById = new Map(labels.map((label) => [label.labelId, label]));
  const submitted: GovernedReviewLabel[] = [];
  const withdrawn = new Set<string>();
  let state: GovernedReviewTaskState = "assigned";
  let activeLabel: GovernedReviewLabel | null = null;
  let viewDigest: string | null = null;
  let canonicalViewBytesBase64: string | null = null;
  let previousEventDigest: string | null = null;

  for (const [index, rawEvent] of input.events.entries()) {
    const event = GovernedReviewTaskEventSchema.parse(rawEvent);
    assertOrderedEvent(event, index + 1, previousEventDigest, governedReviewTaskEventDomainArtifactDigest, "task");
    assertEventTaskScope(event, task);
    if (event.type !== "expired") {
      assertSame(event.actorSubjectId, task.reviewerSubjectId, "task event reviewer subject");
      assertSame(event.actorRoleAtReview, task.reviewerRoleAtReview, "task event reviewer role snapshot");
    }
    switch (event.type) {
      case "viewed":
        if (state !== "assigned" || viewDigest !== null) throw invalidTaskTransition(state, event.type);
        verifyViewedEventArtifact(event, task);
        viewDigest = event.viewDigest;
        canonicalViewBytesBase64 = event.canonicalViewBytesBase64;
        state = "viewed";
        break;
      case "deferred":
        if (state !== "viewed") throw invalidTaskTransition(state, event.type);
        state = "deferred";
        break;
      case "resumed":
        if (state !== "deferred") throw invalidTaskTransition(state, event.type);
        state = "viewed";
        break;
      case "label_submitted": {
        if ((state !== "viewed" && state !== "withdrawn") || activeLabel !== null || viewDigest === null) {
          throw invalidTaskTransition(state, event.type);
        }
        const label = labelsById.get(event.labelId);
        if (!label) throw new Error(`governed review submitted label not found: ${event.labelId}`);
        if (label.blindViewDigest !== viewDigest) throw new Error("governed review label used a different blind view");
        if (label.attemptNumber !== submitted.length + 1) {
          throw new Error("governed review label attempts must be contiguous");
        }
        const prior = submitted[submitted.length - 1];
        if (prior ? label.replacesLabelId !== prior.labelId : label.replacesLabelId !== null) {
          throw new Error("governed review replacement link is inconsistent with immutable attempt history");
        }
        submitted.push(label);
        activeLabel = label;
        state = "submitted";
        break;
      }
      case "label_withdrawn":
        if (state !== "submitted" || activeLabel?.labelId !== event.labelId) {
          throw invalidTaskTransition(state, event.type);
        }
        if (input.revealedLabelIds?.has(event.labelId)) {
          throw new Error("a revealed governed review label cannot be withdrawn");
        }
        withdrawn.add(event.labelId);
        activeLabel = null;
        state = "withdrawn";
        break;
      case "expired":
        if (state !== "assigned" && state !== "viewed" && state !== "withdrawn") {
          throw invalidTaskTransition(state, event.type);
        }
        if (event.actorSubjectId !== "system" || event.actorRoleAtReview !== "system") {
          throw new Error("only the server may expire a governed review task");
        }
        state = "expired";
        break;
    }
    previousEventDigest = event.eventDigest;
  }
  if (labels.some((label) => !submitted.some((candidate) => candidate.labelId === label.labelId))) {
    throw new Error("governed review label exists without a matching label_submitted event");
  }
  return {
    state, activeLabel, labels: submitted, withdrawnLabelIds: [...withdrawn].sort(compareStrings),
    viewDigest, canonicalViewBytesBase64, lastSequence: input.events.length, lastEventDigest: previousEventDigest
  };
}

export function assertGovernedReviewTaskEventAllowed(
  batchState: GovernedReviewBatchState,
  _eventType: GovernedReviewTaskEvent["type"]
): void {
  if (batchState !== "open") {
    throw new Error("governed review task events are forbidden after the labeling barrier closes");
  }
}

export function deriveActiveGovernedReviewLabels(histories: GovernedReviewTaskHistory[]): GovernedReviewLabel[] {
  const active = histories.flatMap((history) => history.activeLabel ? [history.activeLabel] : []);
  assertUnique(active.map((label) => label.taskId), "active governed review task label");
  assertUnique(active.map((label) => label.reviewerSubjectId), "active governed review reviewer label");
  return active.sort((left, right) => compareStrings(left.labelId, right.labelId));
}

export function governedReviewBatchEventDomainArtifactDigest(
  input: Omit<GovernedReviewBatchEvent, "eventDigest"> | GovernedReviewBatchEvent
): string {
  const { eventDigest: _excluded, ...unsigned } = input as GovernedReviewBatchEvent;
  return governedContentV1Digest("coeval/governed-review-batch-event-domain-artifact/v1", unsigned);
}

export interface GovernedReviewBatchHistory {
  state: GovernedReviewBatchState;
  barrierActiveLabelIds: string[];
  deferredTaskIds: string[];
  expiredTaskIds: string[];
  resolvedReviewItemIds: string[];
  incompleteReviewItemIds: string[];
  lastSequence: number;
  lastEventDigest: string | null;
}

export function deriveGovernedReviewBatchHistory(input: {
  batch: GovernedReviewBatch;
  events: GovernedReviewBatchEvent[];
  activeLabels?: GovernedReviewLabel[];
}): GovernedReviewBatchHistory {
  const batch = verifyGovernedReviewBatch(input.batch);
  const allTaskIds = batch.members.flatMap((member) => member.taskIds).sort(compareStrings);
  const allItemIds = batch.members.map((member) => member.reviewItemId).sort(compareStrings);
  const labels = (input.activeLabels ?? []).map((label) => verifyGovernedReviewLabel(label));
  let state: GovernedReviewBatchState = "draft";
  let previousEventDigest: string | null = null;
  let barrierActiveLabelIds: string[] = [];
  let deferredTaskIds: string[] = [];
  let expiredTaskIds: string[] = [];
  let resolvedReviewItemIds: string[] = [];
  let incompleteReviewItemIds: string[] = [];

  for (const [index, rawEvent] of input.events.entries()) {
    const event = GovernedReviewBatchEventSchema.parse(rawEvent);
    assertOrderedEvent(event, index + 1, previousEventDigest, governedReviewBatchEventDomainArtifactDigest, "batch");
    assertSame(event.projectId, batch.projectId, "batch event project");
    assertSame(event.batchId, batch.batchId, "batch event identity");
    const next = batchEventTargetState(event.type);
    transitionGovernedReviewBatchState(state, next);
    if (event.type === "labeling_closed") {
      assertSortedUnique(event.activeLabelIds, "labeling barrier active label");
      assertSortedUnique(event.deferredTaskIds, "labeling barrier deferred task");
      assertSortedUnique(event.expiredTaskIds, "labeling barrier expired task");
      const active = labels.filter((label) => event.activeLabelIds.includes(label.labelId));
      assertExactSet(active.map((label) => label.labelId), event.activeLabelIds, "labeling barrier active label");
      assertUnique(active.map((label) => label.taskId), "labeling barrier submitted task");
      for (const label of active) {
        assertSame(label.projectId, batch.projectId, "labeling barrier label project");
        assertSame(label.batchId, batch.batchId, "labeling barrier label batch");
        assertSame(label.criterionVersionId, batch.criterionVersionId, "labeling barrier label criterion version");
        assertSame(label.instructionVersionId, batch.instructionVersionId, "labeling barrier label instruction version");
        const member = batch.members.find((candidate) => candidate.reviewItemId === label.reviewItemId);
        if (!member?.taskIds.includes(label.taskId)) {
          throw new Error("labeling barrier label is outside the frozen batch assignments");
        }
      }
      for (const member of batch.members) {
        assertUnique(
          active.filter((label) => label.reviewItemId === member.reviewItemId).map((label) => label.reviewerSubjectId),
          `labeling barrier reviewer for ${member.reviewItemId}`
        );
      }
      const terminalTaskIds = [...active.map((label) => label.taskId), ...event.deferredTaskIds, ...event.expiredTaskIds];
      assertExactSet(terminalTaskIds, allTaskIds, "labeling barrier terminal task");
      if (!event.closedAtFixedStop && event.expiredTaskIds.length > 0) {
        throw new Error("governed review tasks may expire only at the fixed stop");
      }
      const closedAtOrAfterStop = Date.parse(event.occurredAt) >= Date.parse(batch.fixedStopAt);
      if (event.closedAtFixedStop !== closedAtOrAfterStop) {
        throw new Error("governed review labeling closure fixed-stop evidence is inconsistent with server time");
      }
      barrierActiveLabelIds = [...event.activeLabelIds];
      deferredTaskIds = [...event.deferredTaskIds];
      expiredTaskIds = [...event.expiredTaskIds];
    } else if (event.type === "resolved") {
      assertSortedUnique(event.resolvedReviewItemIds, "resolved governed review item");
      assertExactSet(event.resolvedReviewItemIds, allItemIds, "resolved governed review item");
      resolvedReviewItemIds = [...event.resolvedReviewItemIds];
    } else if (event.type === "incomplete") {
      assertSortedUnique(event.gapReviewItemIds, "incomplete governed review item");
      if (event.gapReviewItemIds.some((id) => !allItemIds.includes(id))) {
        throw new Error("incomplete governed review item is outside the frozen batch");
      }
      incompleteReviewItemIds = [...event.gapReviewItemIds];
    } else if (event.type === "frozen") {
      assertExactSet(resolvedReviewItemIds, allItemIds, "frozen governed review item");
      if (incompleteReviewItemIds.length > 0) throw new Error("an incomplete governed review batch cannot freeze");
    }
    state = next;
    previousEventDigest = event.eventDigest;
  }
  return {
    state, barrierActiveLabelIds, deferredTaskIds, expiredTaskIds, resolvedReviewItemIds,
    incompleteReviewItemIds, lastSequence: input.events.length, lastEventDigest: previousEventDigest
  };
}

export function transitionGovernedReviewBatchState(
  state: GovernedReviewBatchState,
  next: GovernedReviewBatchState
): GovernedReviewBatchState {
  const edges: Record<GovernedReviewBatchState, readonly GovernedReviewBatchState[]> = {
    draft: ["open", "abandoned"],
    open: ["labeling_closed", "abandoned"],
    labeling_closed: ["resolved", "alignment_open", "adjudicating", "incomplete"],
    alignment_open: ["adjudicating", "incomplete"],
    adjudicating: ["resolved", "incomplete"],
    resolved: ["frozen"],
    abandoned: [], incomplete: [], frozen: []
  };
  if (!edges[state].includes(next)) throw new Error(`invalid governed review batch transition: ${state} -> ${next}`);
  return next;
}

export function governedReviewAlignmentEventDomainArtifactDigest(
  input: Omit<GovernedReviewAlignmentEvent, "eventDigest"> | GovernedReviewAlignmentEvent
): string {
  const { eventDigest: _excluded, ...unsigned } = input as GovernedReviewAlignmentEvent;
  return governedContentV1Digest("coeval/governed-review-alignment-event-domain-artifact/v1", unsigned);
}

export function verifyGovernedReviewAlignmentHistory(input: {
  batch: GovernedReviewBatch;
  batchState: GovernedReviewBatchState;
  barrierActiveLabelIds: string[];
  events: GovernedReviewAlignmentEvent[];
}): GovernedReviewAlignmentEvent[] {
  const batch = verifyGovernedReviewBatch(input.batch);
  if (input.batchState !== "alignment_open") throw new Error("alignment events may be appended only while alignment is open");
  assertSortedUnique(input.barrierActiveLabelIds, "alignment barrier active label");
  let previousEventDigest: string | null = null;
  return input.events.map((rawEvent, index) => {
    const event = GovernedReviewAlignmentEventSchema.parse(rawEvent);
    assertOrderedAlignmentEvent(event, index + 1, previousEventDigest);
    assertSame(event.projectId, batch.projectId, "alignment event project");
    assertSame(event.batchId, batch.batchId, "alignment event batch");
    assertSortedUnique(event.visibleActiveLabelIds, "alignment visible active label");
    assertExactSet(event.visibleActiveLabelIds, input.barrierActiveLabelIds, "alignment visible active label");
    previousEventDigest = event.eventDigest;
    return event;
  });
}

export function governedReviewAdjudicationDomainArtifactDigest(
  input: Omit<GovernedReviewAdjudication, "adjudicationDigest"> | GovernedReviewAdjudication
): string {
  const { adjudicationDigest: _excluded, ...unsigned } = input as GovernedReviewAdjudication;
  return governedContentV1Digest("coeval/governed-review-adjudication-domain-artifact/v1", unsigned);
}

export function verifyGovernedReviewAdjudication(raw: unknown): GovernedReviewAdjudication {
  const adjudication = GovernedReviewAdjudicationSchema.parse(raw);
  assertSortedUnique(adjudication.consideredLabelIds, "governed review adjudication considered label");
  if (adjudication.adjudicationDigest !== governedReviewAdjudicationDomainArtifactDigest(adjudication)) {
    throw new Error("governed review adjudication domain-artifact digest mismatch");
  }
  if ((adjudication.sequence === 1) !== (adjudication.predecessorAdjudicationId === null)) {
    throw new Error("governed review adjudication predecessor is inconsistent with its sequence");
  }
  if ((adjudication.sequence === 1) !== (adjudication.correctionReason === null)) {
    throw new Error("governed review adjudication correction reason is inconsistent with its sequence");
  }
  if (adjudication.expectedPreviousChainVersion !== adjudication.sequence - 1) {
    throw new Error("governed review adjudication expected chain version is inconsistent with its sequence");
  }
  return adjudication;
}

export function deriveAuthoritativeGovernedReviewAdjudication(input: {
  batch: GovernedReviewBatch;
  reviewItemId: string;
  activeLabels: GovernedReviewLabel[];
  adjudications: GovernedReviewAdjudication[];
}): GovernedReviewAdjudication | null {
  const batch = verifyGovernedReviewBatch(input.batch);
  const labels = input.activeLabels.map((label) => verifyGovernedReviewLabel(label));
  const labelIds = labels.map((label) => label.labelId).sort(compareStrings);
  let current: GovernedReviewAdjudication | null = null;
  for (const [index, raw] of input.adjudications.entries()) {
    const adjudication = verifyGovernedReviewAdjudication(raw);
    if (adjudication.sequence !== index + 1 || adjudication.expectedPreviousChainVersion !== index) {
      throw new Error("governed review adjudication sequence/CAS version must be contiguous");
    }
    if (adjudication.predecessorAdjudicationId !== current?.adjudicationId &&
      !(current === null && adjudication.predecessorAdjudicationId === null)) {
      throw new Error("governed review adjudication chain branches or skips its authoritative head");
    }
    assertSame(adjudication.projectId, batch.projectId, "adjudication project");
    assertSame(adjudication.batchId, batch.batchId, "adjudication batch");
    assertSame(adjudication.reviewItemId, input.reviewItemId, "adjudication item");
    assertSame(adjudication.criterionVersionId, batch.criterionVersionId, "adjudication criterion version");
    assertSame(adjudication.instructionVersionId, batch.instructionVersionId, "adjudication instruction version");
    assertExactSet(adjudication.consideredLabelIds, labelIds, "adjudication considered label");
    if (labels.some((label) => label.reviewerSubjectId === adjudication.adjudicatorSubjectId)) {
      throw new Error("governed review adjudicator cannot be a rater for the item");
    }
    if (batch.roleIntent === "sealed_validation") assertSubjectSeparated(adjudication.adjudicatorSubjectId, batch, "adjudicator");
    current = adjudication;
  }
  return current;
}

export function decideGovernedReviewAdjudicationAppend(
  authoritativeHeadId: string | null,
  expectedCurrentAdjudicationId: string | null
): "append" | "conflict" {
  return authoritativeHeadId === expectedCurrentAdjudicationId ? "append" : "conflict";
}

export function resolveGovernedReviewTruth(input: {
  batch: GovernedReviewBatch;
  batchState: GovernedReviewBatchState;
  reviewItemId: string;
  activeLabels: GovernedReviewLabel[];
  barrierActiveLabelIds: string[];
  adjudications?: GovernedReviewAdjudication[];
}): GovernedTruthResolution {
  const batch = verifyGovernedReviewBatch(input.batch);
  if (input.batchState === "draft" || input.batchState === "open" || input.batchState === "abandoned") {
    throw new Error("governed review truth cannot be resolved before the labeling barrier closes");
  }
  const member = batch.members.find((candidate) => candidate.reviewItemId === input.reviewItemId);
  if (!member) throw new Error("governed review truth item is not a member of its batch");
  const activeLabels = input.activeLabels.map((label) => verifyGovernedReviewLabel(label));
  assertSortedUnique(input.barrierActiveLabelIds, "truth barrier active label");
  assertUnique(activeLabels.map((label) => label.labelId), "active governed review label");
  assertUnique(activeLabels.map((label) => label.taskId), "active governed review label task");
  assertUnique(activeLabels.map((label) => label.reviewerSubjectId), "active governed review label reviewer");
  for (const label of activeLabels) {
    assertSame(label.projectId, batch.projectId, "truth label project");
    assertSame(label.batchId, batch.batchId, "truth label batch");
    assertSame(label.reviewItemId, input.reviewItemId, "truth label item");
    assertSame(label.criterionVersionId, batch.criterionVersionId, "truth label criterion version");
    assertSame(label.instructionVersionId, batch.instructionVersionId, "truth label instruction version");
    if (!member.taskIds.includes(label.taskId)) throw new Error("truth label does not belong to a required assignment");
  }
  const consideredLabelIds = activeLabels.map((label) => label.labelId).sort(compareStrings);
  assertExactSet(consideredLabelIds, input.barrierActiveLabelIds, "truth barrier active label");
  const exactRequiredTasks = activeLabels.length === member.taskIds.length &&
    activeLabels.every((label) => member.taskIds.includes(label.taskId));
  if (!exactRequiredTasks) {
    if ((input.adjudications?.length ?? 0) > 0) throw new Error("governed review adjudication cannot bypass a coverage gap");
    return GovernedTruthResolutionSchema.parse({
      status: "unresolved", referenceLabel: null, basis: "coverage_gap", singleRater: false,
      consideredLabelIds, requiredIndependentLabels: batch.requiredIndependentLabels,
      activeIndependentLabels: activeLabels.length
    });
  }
  const values = new Set(activeLabels.map((label) => label.value));
  const binaryValues = new Set(activeLabels.flatMap((label) => label.value === "cannot_determine" ? [] : [label.value]));
  const requiresAdjudication = values.has("cannot_determine") || binaryValues.size > 1;
  const adjudications = input.adjudications ?? [];
  if (!requiresAdjudication) {
    if (adjudications.length > 0) throw new Error("adjudication requires disagreement or cannot_determine evidence");
    const referenceLabel = activeLabels[0]?.value;
    if (referenceLabel !== "pass" && referenceLabel !== "fail") throw new Error("complete truth lacks a binary label");
    const singleRater = batch.requiredIndependentLabels === 1;
    return GovernedTruthResolutionSchema.parse({
      status: "resolved", referenceLabel, basis: singleRater ? "single_rater" : "unanimous", singleRater,
      consideredLabelIds, requiredIndependentLabels: batch.requiredIndependentLabels,
      activeIndependentLabels: activeLabels.length
    });
  }
  const head = deriveAuthoritativeGovernedReviewAdjudication({
    batch, reviewItemId: input.reviewItemId, activeLabels, adjudications
  });
  if (!head) {
    return GovernedTruthResolutionSchema.parse({
      status: "unresolved", referenceLabel: null, basis: "requires_adjudication", singleRater: false,
      consideredLabelIds, requiredIndependentLabels: batch.requiredIndependentLabels,
      activeIndependentLabels: activeLabels.length
    });
  }
  return GovernedTruthResolutionSchema.parse({
    status: head.decision === "unresolvable" ? "unresolved" : "resolved",
    referenceLabel: head.decision === "unresolvable" ? null : head.decision,
    basis: head.decision === "unresolvable" ? "unresolvable" : "adjudicated", singleRater: false,
    consideredLabelIds, requiredIndependentLabels: batch.requiredIndependentLabels,
    activeIndependentLabels: activeLabels.length
  });
}

export function deriveRepresentativeClaimEligibility(input: {
  batch: GovernedReviewBatch;
  batchState: GovernedReviewBatchState;
  resolvedReviewItemIds: string[];
  deferredTaskIds: string[];
  expiredTaskIds: string[];
  cannotDetermineLabelIds: string[];
}): RepresentativeClaimEligibility {
  const batch = verifyGovernedReviewBatch(input.batch);
  const plan = batch.selectionPlan;
  const reasons: RepresentativeClaimReason[] = [];
  const selectedIds = batch.members.map((member) => member.reviewItemId);
  assertSortedUnique(input.resolvedReviewItemIds, "resolved governed review item");
  assertSortedUnique(input.deferredTaskIds, "deferred governed review task");
  assertSortedUnique(input.expiredTaskIds, "expired governed review task");
  assertSortedUnique(input.cannotDetermineLabelIds, "cannot-determine governed review label");
  if (input.resolvedReviewItemIds.some((id) => !selectedIds.includes(id))) {
    throw new Error("representative coverage names an item outside the governed batch");
  }
  if (input.batchState !== "resolved" && input.batchState !== "frozen") reasons.push("review_coverage_incomplete");
  if (plan.method !== "simple_random" && plan.method !== "stratified_random") reasons.push("selection_method_not_eligible");
  if (!plan.populationDigest || !plan.frozenFrameDigest) reasons.push("population_frame_incomplete");
  if (!plan.collectionProvenanceDigest) reasons.push("collection_provenance_unverified");
  if (plan.drawExecutor !== "coeval_server") reasons.push("draw_not_server_executed");
  if ((plan.method === "simple_random" || plan.method === "stratified_random") &&
    (plan.drawDigest !== governedReviewSelectionDrawDomainArtifactDigest(plan) || plan.seed === null || plan.rngVersion === null)) {
    reasons.push("draw_not_reproducible");
  }
  if (plan.fixedBudget !== plan.drawItemDigests.length || plan.fixedBudget !== batch.members.length) reasons.push("fixed_budget_mismatch");
  if (plan.method === "stratified_random" && plan.strata.length === 0) reasons.push("strata_incomplete");
  if (input.resolvedReviewItemIds.length !== selectedIds.length) reasons.push("review_coverage_incomplete");
  if (input.deferredTaskIds.length > 0) reasons.push("deferred_assignments");
  if (input.expiredTaskIds.length > 0) reasons.push("review_coverage_incomplete");
  if (input.cannotDetermineLabelIds.length > 0) reasons.push("cannot_determine_present");
  if (input.resolvedReviewItemIds.length !== selectedIds.length) reasons.push("unresolved_items");
  const uniqueReasons = [...new Set(reasons)];
  return RepresentativeClaimEligibilitySchema.parse({
    representativeClaimEligible: uniqueReasons.length === 0,
    representativeOfPopulationId: uniqueReasons.length === 0 ? plan.sourcePopulationId : null,
    reasons: uniqueReasons.length === 0 ? ["eligible"] : uniqueReasons,
    selectedItems: selectedIds.length,
    resolvedItems: input.resolvedReviewItemIds.length
  });
}

export function governedReviewRequestDigest(value: unknown): string {
  return governedContentV1Digest("coeval/governed-review-request/v1", value);
}

export function decideGovernedReviewIdempotency(
  existingRequestDigest: string,
  candidateSemanticRequest: unknown
): { status: "replay" | "conflict"; candidateRequestDigest: string } {
  const candidateRequestDigest = governedReviewRequestDigest(candidateSemanticRequest);
  return { status: existingRequestDigest === candidateRequestDigest ? "replay" : "conflict", candidateRequestDigest };
}

export function buildGovernedBlindTaskView(input: {
  task: GovernedReviewTask;
  item: GovernedReviewItem;
  instruction: GovernedReviewInstructionVersion;
  criterion: CriterionVersion;
}): GovernedBlindTaskView {
  const task = verifyGovernedReviewTask(input.task);
  const item = verifyGovernedReviewItem(input.item);
  const instruction = verifyGovernedReviewInstructionVersion(input.instruction);
  assertSame(task.projectId, item.projectId, "blind view task item project");
  assertSame(task.reviewItemId, item.reviewItemId, "blind view task item");
  assertSame(task.projectId, instruction.projectId, "blind view task instruction project");
  assertSame(task.criterionVersionId, instruction.criterionVersionId, "blind view criterion instruction version");
  assertSame(task.instructionVersionId, instruction.instructionVersionId, "blind view instruction version");
  assertSame(input.criterion.projectId, task.projectId, "blind view criterion project");
  assertSame(input.criterion.id, task.criterionVersionId, "blind view criterion version");
  assertSame(input.criterion.criterionId, instruction.criterionId, "blind view criterion identity");
  const expectedCriterionDigest = evaluatorSuiteCriterionDigest({
    criterionId: input.criterion.criterionId,
    criterionVersionId: input.criterion.id,
    criterionName: input.criterion.name,
    criterionDefinition: input.criterion.definition
  });
  if (input.criterion.criterionDigest !== expectedCriterionDigest) throw new Error("blind view criterion digest mismatch");
  assertNoForbiddenBlindKeys(item.payloadSnapshot);
  return GovernedBlindTaskViewSchema.parse({
    contract: "coeval/governed-blind-task-view/v1", schemaVersion: 1,
    canonicalizationVersion: "coeval-canonical-json/v1", taskId: task.taskId,
    batchId: task.batchId, servePosition: task.servePosition,
    criterion: {
      criterionId: input.criterion.criterionId, criterionVersionId: input.criterion.id,
      name: input.criterion.name, definition: input.criterion.definition,
      criterionDigest: input.criterion.criterionDigest
    },
    instruction: {
      instructionVersionId: instruction.instructionVersionId, title: instruction.title,
      instructions: instruction.instructions, failureCodeGuidance: instruction.failureCodeGuidance,
      allowedLabels: instruction.allowedLabels, instructionDigest: instruction.instructionDigest
    },
    payloadSnapshot: item.payloadSnapshot
  });
}

export function canonicalGovernedBlindTaskViewBytes(raw: unknown): Buffer {
  return Buffer.from(canonicalJson(verifyGovernedBlindTaskView(raw)), "utf8");
}

export function governedBlindTaskViewDigest(raw: unknown): string {
  return sha256Bytes(canonicalGovernedBlindTaskViewBytes(raw));
}

export function verifyGovernedBlindTaskView(raw: unknown): GovernedBlindTaskView {
  const view = GovernedBlindTaskViewSchema.parse(raw);
  assertCanonicalJsonSize(view.payloadSnapshot, "governed blind task payload snapshot", MAX_GOVERNED_REVIEW_PAYLOAD_BYTES);
  assertNoForbiddenBlindKeys(view.payloadSnapshot);
  return view;
}

export function importedHumanTruthDomainArtifactDigest(
  input: Omit<ImportedHumanTruth, "importDigest"> | ImportedHumanTruth
): string {
  const { importDigest: _excluded, ...unsigned } = input as ImportedHumanTruth;
  return governedContentV1Digest("coeval/imported-human-truth-domain-artifact/v1", unsigned);
}

export function classifyImportedHumanTruth(
  input: Omit<ImportedHumanTruth, "classification" | "importDigest">
): "imported_verified_attested" | "imported_self_attested" | "unverified" {
  const complete = input.issuer !== null && input.subject !== null && input.sourceSystem !== null &&
    input.sourceRecordId !== null && input.sourceDigest !== null && input.sourceArtifact !== null &&
    input.transportMethod !== null && input.verificationMethod !== null &&
    input.instructionText !== null && input.instructionDigest !== null && input.raters.length > 0 &&
    (input.label === "pass" || input.label === "fail") && input.rationale !== null &&
    input.adjudicatorSubjectId !== null && input.adjudicationDecision === input.label &&
    input.adjudicationRationale !== null &&
    input.blindAttestation !== null;
  if (!complete) return "unverified";
  // This pure verifier can prove completeness and byte/digest integrity, but
  // it has no trusted issuer-key registry or authenticated transport context.
  // Caller-provided proof-shaped JSON therefore remains self-attested. A
  // future server verifier may mint imported_verified_attested only after it
  // performs an independent cryptographic/transport verification.
  return "imported_self_attested";
}

export function verifyImportedHumanTruth(raw: unknown): ImportedHumanTruth {
  const imported = ImportedHumanTruthSchema.parse(raw);
  if (imported.sourceArtifact !== null) {
    assertCanonicalJsonSize(imported.sourceArtifact, "imported truth source artifact", MAX_IMPORTED_SOURCE_ARTIFACT_BYTES);
  }
  assertSortedUnique(imported.raters.map((rater) => rater.subjectId), "imported truth rater subject");
  assertSortedUnique(imported.failureCodes, "imported truth failure code");
  if (imported.sourceArtifact !== null && imported.sourceDigest !== sha256Digest(imported.sourceArtifact)) {
    throw new Error("imported truth source artifact digest mismatch");
  }
  if (imported.verificationEvidence !== null &&
    imported.verificationEvidenceDigest !== sha256Digest(imported.verificationEvidence)) {
    throw new Error("imported truth verification evidence digest mismatch");
  }
  if ((imported.verificationEvidence === null) !== (imported.verificationEvidenceDigest === null)) {
    throw new Error("imported truth verification evidence and digest must be supplied together");
  }
  if (imported.instructionText !== null && imported.instructionDigest !== sha256Digest(imported.instructionText)) {
    throw new Error("imported truth instruction digest mismatch");
  }
  if (imported.blindAttestation !== null) {
    const { attestationDigest, ...unsignedAttestation } = imported.blindAttestation;
    if (attestationDigest !== sha256Digest(unsignedAttestation)) throw new Error("imported truth blind attestation digest mismatch");
  }
  const { classification: _classification, importDigest: _importDigest, ...classifiable } = imported;
  if (imported.classification !== classifyImportedHumanTruth(classifiable)) {
    throw new Error("imported truth classification is inconsistent with its provenance");
  }
  if (imported.importDigest !== importedHumanTruthDomainArtifactDigest(imported)) {
    throw new Error("imported truth domain-artifact digest mismatch");
  }
  return imported;
}

export function governedDatasetReferenceProvenanceDomainArtifactDigest(
  input: Omit<GovernedDatasetReferenceProvenance, "provenanceDigest"> | GovernedDatasetReferenceProvenance
): string {
  const { provenanceDigest: _excluded, ...unsigned } = input as GovernedDatasetReferenceProvenance;
  return governedContentV1Digest("coeval/governed-dataset-reference-provenance-domain-artifact/v1", unsigned);
}

export function verifyGovernedDatasetReferenceProvenance(raw: unknown): GovernedDatasetReferenceProvenance {
  const provenance = GovernedDatasetReferenceProvenanceSchema.parse(raw);
  if (provenance.kind === "governed_labels") assertSortedUnique(provenance.labelIds, "governed reference label");
  if (provenance.provenanceDigest !== governedDatasetReferenceProvenanceDomainArtifactDigest(provenance)) {
    throw new Error("governed dataset reference provenance domain-artifact digest mismatch");
  }
  return provenance;
}

export interface GovernedBinaryAgreement {
  support: number;
  observedAgreement: number | null;
  kappa: number | null;
  undefinedReason: "no_overlap" | "one_class" | null;
}

export function computeGovernedBinaryAgreement(
  pairs: ReadonlyArray<{ reviewerA: "pass" | "fail"; reviewerB: "pass" | "fail" }>
): GovernedBinaryAgreement {
  if (pairs.length === 0) return { support: 0, observedAgreement: null, kappa: null, undefinedReason: "no_overlap" };
  const observedAgreement = pairs.filter((pair) => pair.reviewerA === pair.reviewerB).length / pairs.length;
  const categories = new Set(pairs.flatMap((pair) => [pair.reviewerA, pair.reviewerB]));
  if (categories.size === 1) return { support: pairs.length, observedAgreement, kappa: null, undefinedReason: "one_class" };
  const pAPass = pairs.filter((pair) => pair.reviewerA === "pass").length / pairs.length;
  const pBPass = pairs.filter((pair) => pair.reviewerB === "pass").length / pairs.length;
  const expectedAgreement = pAPass * pBPass + (1 - pAPass) * (1 - pBPass);
  const kappa = expectedAgreement === 1 ? null : (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
  return { support: pairs.length, observedAgreement, kappa, undefinedReason: kappa === null ? "one_class" : null };
}

function verifyViewedEventArtifact(
  event: Extract<GovernedReviewTaskEvent, { type: "viewed" }>,
  task: GovernedReviewTask
): GovernedBlindTaskView {
  const bytes = Buffer.from(event.canonicalViewBytesBase64, "base64");
  if (bytes.toString("base64") !== event.canonicalViewBytesBase64) {
    throw new Error("governed blind task view bytes are not canonical base64");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("governed blind task view bytes are not valid UTF-8"); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error("governed blind task view bytes are not valid JSON"); }
  const view = verifyGovernedBlindTaskView(raw);
  if (canonicalJson(view) !== text) throw new Error("governed blind task view bytes are not exact canonical JSON");
  if (event.viewContractVersion !== view.contract || event.canonicalizationVersion !== view.canonicalizationVersion) {
    throw new Error("governed blind task view version mismatch");
  }
  if (event.viewDigest !== sha256Bytes(bytes)) throw new Error("governed blind task view digest mismatch");
  assertSame(view.taskId, task.taskId, "blind view task");
  assertSame(view.batchId, task.batchId, "blind view batch");
  assertSame(view.criterion.criterionVersionId, task.criterionVersionId, "blind view criterion version");
  assertSame(view.instruction.instructionVersionId, task.instructionVersionId, "blind view instruction version");
  return view;
}

function assertLabelTaskScope(label: GovernedReviewLabel, task: GovernedReviewTask): void {
  assertSame(label.projectId, task.projectId, "label task project");
  assertSame(label.batchId, task.batchId, "label task batch");
  assertSame(label.taskId, task.taskId, "label task identity");
  assertSame(label.reviewItemId, task.reviewItemId, "label task item");
  assertSame(label.criterionVersionId, task.criterionVersionId, "label task criterion version");
  assertSame(label.instructionVersionId, task.instructionVersionId, "label task instruction version");
  assertSame(label.reviewerSubjectId, task.reviewerSubjectId, "label task reviewer subject");
}

function assertEventTaskScope(event: GovernedReviewTaskEvent, task: GovernedReviewTask): void {
  assertSame(event.projectId, task.projectId, "event task project");
  assertSame(event.batchId, task.batchId, "event task batch");
  assertSame(event.taskId, task.taskId, "event task identity");
  assertSame(event.reviewItemId, task.reviewItemId, "event task item");
  assertSame(event.criterionVersionId, task.criterionVersionId, "event task criterion version");
  assertSame(event.instructionVersionId, task.instructionVersionId, "event task instruction version");
}

function assertSubjectSeparated(subjectId: string, batch: GovernedReviewBatch, role: string): void {
  if (batch.developmentCapabilitySubjectIds.includes(subjectId) || batch.developmentExposureSubjectIds.includes(subjectId)) {
    throw new Error(`sealed governed review ${role} cannot have evaluator-development capability or exposure`);
  }
}

function assertNoForbiddenBlindKeys(value: unknown, path = "payloadSnapshot"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenBlindKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (NORMALIZED_FORBIDDEN_BLIND_KEYS.has(normalizeBlindKey(key))) {
      throw new Error(`governed blind task payload contains forbidden field ${path}.${key}`);
    }
    assertNoForbiddenBlindKeys(nested, `${path}.${key}`);
  }
}

function assertCanonicalJsonSize(value: unknown, label: string, maxBytes: number): void {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its canonical JSON byte limit`);
  }
}

function assertOrderedEvent<T extends {
  sequence: number;
  stateVersion: number;
  expectedPreviousStateVersion: number;
  previousEventDigest: string | null;
  eventDigest: string;
}>(event: T, expectedSequence: number, previousEventDigest: string | null, digest: (event: T) => string, stream: string): void {
  if (
    event.sequence !== expectedSequence ||
    event.stateVersion !== expectedSequence ||
    event.expectedPreviousStateVersion !== expectedSequence - 1
  ) {
    throw new Error(`governed review ${stream} event sequence/state version must be contiguous at ${expectedSequence}`);
  }
  if (event.previousEventDigest !== previousEventDigest) {
    throw new Error(`governed review ${stream} event chain mismatch at sequence ${event.sequence}`);
  }
  if (event.eventDigest !== digest(event)) {
    throw new Error(`governed review ${stream} event digest mismatch at sequence ${event.sequence}`);
  }
}

function assertOrderedAlignmentEvent(
  event: GovernedReviewAlignmentEvent,
  expectedSequence: number,
  previousEventDigest: string | null
): void {
  if (event.sequence !== expectedSequence || event.expectedPreviousSequence !== expectedSequence - 1) {
    throw new Error(`governed review alignment event sequence/CAS version must be contiguous at ${expectedSequence}`);
  }
  if (event.previousEventDigest !== previousEventDigest) {
    throw new Error(`governed review alignment event chain mismatch at sequence ${event.sequence}`);
  }
  if (event.eventDigest !== governedReviewAlignmentEventDomainArtifactDigest(event)) {
    throw new Error(`governed review alignment event digest mismatch at sequence ${event.sequence}`);
  }
}

function batchEventTargetState(type: GovernedReviewBatchEvent["type"]): GovernedReviewBatchState {
  switch (type) {
    case "opened": return "open";
    case "labeling_closed": return "labeling_closed";
    case "alignment_opened": return "alignment_open";
    case "adjudication_started": return "adjudicating";
    case "resolved": return "resolved";
    case "incomplete": return "incomplete";
    case "frozen": return "frozen";
    case "abandoned": return "abandoned";
  }
}

function assertContiguousPositions(values: readonly number[], label: string): void {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.some((value, index) => value !== index)) throw new Error(`${label} positions must be unique and contiguous from zero`);
}

function assertSorted(values: readonly string[], label: string): void {
  const sorted = [...values].sort(compareStrings);
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(`${label} values must use deterministic lexical ordering`);
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  assertSorted(values, label);
  assertUnique(values, label);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
}

function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  assertUnique(actual, label);
  const sortedActual = [...actual].sort(compareStrings);
  const sortedExpected = [...expected].sort(compareStrings);
  if (sortedActual.length !== sortedExpected.length || sortedActual.some((value, index) => value !== sortedExpected[index])) {
    throw new Error(`${label} set does not match the frozen evidence`);
  }
}

function assertSame(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeBlindKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalidTaskTransition(state: GovernedReviewTaskState, event: GovernedReviewTaskEvent["type"]): Error {
  return new Error(`invalid governed review task transition: ${state} -> ${event}`);
}
