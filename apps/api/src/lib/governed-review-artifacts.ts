// Closed domain-artifact digests and structural verification for review inputs.
import {
  GovernedReviewBatchSchema,
  GovernedReviewInstructionVersionSchema,
  GovernedReviewItemSchema,
  GovernedReviewLabelSchema,
  GovernedReviewSelectionPlanSchema,
  GovernedReviewTaskSchema,
  type GovernedReviewBatch,
  type GovernedReviewInstructionVersion,
  type GovernedReviewItem,
  type GovernedReviewLabel,
  type GovernedReviewSelectionPlan,
  type GovernedReviewTask,
  type GovernedReviewTaskEvent
} from "@coeval/shared";
import { sha256Digest } from "./assessment-receipt.js";
import { governedContentV1Digest } from "./governed-content-digest.js";
import {
  MAX_COLLECTION_PROVENANCE_BYTES,
  MAX_GOVERNED_REVIEW_PAYLOAD_BYTES,
  assertCanonicalJsonSize,
  assertContiguousPositions,
  assertExactSet,
  assertSame,
  assertSortedUnique,
  assertSubjectSeparated,
  assertUnique
} from "./governed-review-common.js";

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

function assertLabelTaskScope(label: GovernedReviewLabel, task: GovernedReviewTask): void {
  assertSame(label.projectId, task.projectId, "label task project");
  assertSame(label.batchId, task.batchId, "label task batch");
  assertSame(label.taskId, task.taskId, "label task identity");
  assertSame(label.reviewItemId, task.reviewItemId, "label task item");
  assertSame(label.criterionVersionId, task.criterionVersionId, "label task criterion version");
  assertSame(label.instructionVersionId, task.instructionVersionId, "label task instruction version");
  assertSame(label.reviewerSubjectId, task.reviewerSubjectId, "label task reviewer subject");
}

export function governedReviewTaskEventDomainArtifactDigest(
  input: Omit<GovernedReviewTaskEvent, "eventDigest"> | GovernedReviewTaskEvent
): string {
  const { eventDigest: _excluded, ...unsigned } = input as GovernedReviewTaskEvent;
  return governedContentV1Digest("coeval/governed-review-task-event-domain-artifact/v1", unsigned);
}
