import { describe, expect, it } from "vitest";
import {
  GovernedReviewItemSchema,
  type CriterionVersion,
  type GovernedReviewAdjudication,
  type GovernedReviewAlignmentEvent,
  type GovernedReviewBatch,
  type GovernedReviewBatchEvent,
  type GovernedReviewInstructionVersion,
  type GovernedReviewItem,
  type GovernedReviewLabel,
  type GovernedReviewLabelValue,
  type GovernedReviewSelectionMethod,
  type GovernedReviewSelectionPlan,
  type GovernedReviewTask,
  type GovernedReviewTaskEvent,
  type ImportedHumanTruth
} from "@coeval/shared";
import { sha256Digest } from "../src/lib/assessment-receipt.js";
import { evaluatorSuiteCriterionDigest } from "../src/lib/evaluator-suite.js";
import {
  assertGovernedReviewTaskEventAllowed,
  buildGovernedBlindTaskView,
  canonicalGovernedBlindTaskViewBytes,
  classifyImportedHumanTruth,
  computeGovernedBinaryAgreement,
  decideGovernedReviewAdjudicationAppend,
  decideGovernedReviewIdempotency,
  deriveAuthoritativeGovernedReviewAdjudication,
  deriveGovernedReviewBatchHistory,
  deriveGovernedReviewTaskHistory,
  deriveRepresentativeClaimEligibility,
  governedBlindTaskViewDigest,
  governedReviewAdjudicationDomainArtifactDigest,
  governedReviewAlignmentEventDomainArtifactDigest,
  governedReviewBatchDomainArtifactDigest,
  governedReviewBatchEventDomainArtifactDigest,
  governedDatasetReferenceProvenanceDomainArtifactDigest,
  governedReviewInstructionDigest,
  governedReviewItemDomainArtifactDigest,
  governedReviewLabelDomainArtifactDigest,
  governedReviewRequestDigest,
  governedReviewSelectionDrawDomainArtifactDigest,
  governedReviewSelectionPlanDomainArtifactDigest,
  governedReviewTaskDomainArtifactDigest,
  governedReviewTaskEventDomainArtifactDigest,
  importedHumanTruthDomainArtifactDigest,
  resolveGovernedReviewTruth,
  transitionGovernedReviewBatchState,
  verifyGovernedBlindTaskView,
  verifyGovernedDatasetReferenceProvenance,
  verifyGovernedReviewAlignmentHistory,
  verifyGovernedReviewBatch,
  verifyGovernedReviewItem,
  verifyGovernedReviewSelectionPlan,
  verifyGovernedReviewTask,
  verifyImportedHumanTruth
} from "../src/lib/governed-review.js";

const NOW = "2026-08-23T10:00:00.000Z";
const STOP = "2026-08-24T10:00:00.000Z";
const PROJECT_ID = "project_one";
const ITEM_ID = "review_item_one";
const VIEW_DIGEST = sha256Digest("blind-view");

function criterion(overrides: Partial<CriterionVersion> = {}): CriterionVersion {
  const base = {
    id: "criterion_version_one",
    projectId: PROJECT_ID,
    criterionId: "criterion_one",
    revision: 1,
    name: "Accuracy",
    definition: "Pass only when every material claim is supported by the supplied trace.",
    sourceKind: "native" as const,
    createdByUserId: "author_subject",
    createdAt: NOW,
    ...overrides
  };
  return {
    ...base,
    criterionDigest: overrides.criterionDigest ?? evaluatorSuiteCriterionDigest({
      criterionId: base.criterionId,
      criterionVersionId: base.id,
      criterionName: base.name,
      criterionDefinition: base.definition
    })
  };
}

function instruction(overrides: Partial<GovernedReviewInstructionVersion> = {}): GovernedReviewInstructionVersion {
  const unsigned = {
    contract: "coeval/governed-review-instruction/v1" as const,
    schemaVersion: 1 as const,
    instructionVersionId: "instruction_one",
    projectId: PROJECT_ID,
    criterionId: "criterion_one",
    criterionVersionId: "criterion_version_one",
    revision: 1,
    predecessorInstructionVersionId: null,
    title: "Review accuracy",
    instructions: "Read the full input, output, and trace snapshot. Apply only the accuracy criterion.",
    failureCodeGuidance: "Use short reviewer-authored codes; do not infer evaluator codes.",
    allowedLabels: ["pass", "fail", "cannot_determine"] as ["pass", "fail", "cannot_determine"],
    createdBySubjectId: "author_subject",
    createdAt: NOW,
    ...without(overrides, "instructionDigest")
  };
  return { ...unsigned, instructionDigest: governedReviewInstructionDigest(unsigned) };
}

function item(overrides: Partial<GovernedReviewItem> = {}): GovernedReviewItem {
  const unsigned = {
    contract: "coeval/governed-review-item/v1" as const,
    schemaVersion: 1 as const,
    reviewItemId: ITEM_ID,
    projectId: PROJECT_ID,
    sourceKind: "dataset_revision_item" as const,
    sourceRevisionId: "dataset_revision_one",
    sourceRevisionItemId: "dataset_revision_item_one",
    sourceItemDigest: sha256Digest("source-revision-item"),
    sealedIntakePopulationId: null,
    inputIdentityBasis: "input-identity/v1" as const,
    inputDigest: sha256Digest({ prompt: "What is 2 + 2?" }),
    payloadSnapshot: {
      input: { prompt: "What is 2 + 2?" },
      output: { answer: "4" },
      steps: [{ name: "calculator", input: { expression: "2+2" }, output: { value: 4 } }]
    },
    createdAt: NOW,
    ...without(overrides, "itemDigest")
  };
  return { ...unsigned, itemDigest: governedReviewItemDomainArtifactDigest(unsigned) } as GovernedReviewItem;
}

function selectionPlan(
  reviewItemDigests: string[],
  overrides: Partial<GovernedReviewSelectionPlan> = {}
): GovernedReviewSelectionPlan {
  const method = overrides.method ?? "simple_random";
  const random = method === "simple_random" || method === "stratified_random";
  const populationSize = overrides.populationSize ?? 10;
  const fixedBudget = overrides.fixedBudget ?? reviewItemDigests.length;
  const unsignedBase = {
    contract: "coeval/governed-review-selection/v1" as const,
    schemaVersion: 1 as const,
    method,
    sourcePopulationId: "population_one",
    sourcePopulationDefinition: "All immutable revision items collected during the frozen window.",
    timeWindow: { startInclusive: NOW, endExclusive: STOP },
    populationSize,
    populationDigest: sha256Digest("population"),
    collectionProvenance: { collector: "coeval", sourceRevisionId: "dataset_revision_one" },
    collectionProvenanceDigest: sha256Digest({ collector: "coeval", sourceRevisionId: "dataset_revision_one" }),
    frozenFrameDigest: sha256Digest("frozen-frame"),
    seed: random ? "seed_one" : null,
    rngVersion: random ? "xoshiro256/v1" : null,
    selectionAlgorithmVersion: "governed-selection/v1",
    inclusionProbability: method === "simple_random" ? fixedBudget / populationSize : null,
    weight: method === "simple_random" ? populationSize / fixedBudget : null,
    fixedBudget,
    stoppingRule: "fixed" as const,
    drawExecutor: "coeval_server" as const,
    drawItemDigests: reviewItemDigests,
    strata: [],
    ...without(overrides, "selectionPlanDigest", "drawDigest")
  };
  const withDraw = { ...unsignedBase, drawDigest: governedReviewSelectionDrawDomainArtifactDigest(unsignedBase) };
  return { ...withDraw, selectionPlanDigest: governedReviewSelectionPlanDomainArtifactDigest(withDraw) } as GovernedReviewSelectionPlan;
}

function batch(
  requiredIndependentLabels = 2,
  overrides: Partial<GovernedReviewBatch> = {}
): GovernedReviewBatch {
  const reviewItem = item();
  const taskIds = Array.from({ length: requiredIndependentLabels }, (_, index) => `task_${index + 1}`);
  const plan = overrides.selectionPlan ?? selectionPlan([reviewItem.itemDigest]);
  const unsigned = {
    contract: "coeval/governed-review-batch/v1" as const,
    schemaVersion: 1 as const,
    batchId: "batch_one",
    projectId: PROJECT_ID,
    criterionId: "criterion_one",
    criterionVersionId: "criterion_version_one",
    instructionVersionId: "instruction_one",
    instructionDigest: instruction().instructionDigest,
    roleIntent: "iterative_development" as const,
    sourcePopulationKind: "dataset_revision" as const,
    selectionPlan: plan,
    requiredIndependentLabels,
    evaluatorBlind: true,
    peerBlindUntilLabelingClosed: true,
    separationOfDutiesRequired: false,
    custodianSubjectId: "custodian_subject",
    custodianRoleAtReview: null,
    developmentIdentityStatus: "resolved" as const,
    developmentCapabilitySubjectIds: ["developer_subject"],
    developmentExposureSubjectIds: ["exposed_subject"],
    stateMachineVersion: "governed-review-state/v1" as const,
    idempotencyKey: "create_batch_one",
    requestDigest: governedReviewRequestDigest({ taskIds, item: ITEM_ID }),
    members: [{ reviewItemId: ITEM_ID, reviewItemDigest: reviewItem.itemDigest, servePosition: 0, taskIds }],
    fixedStopAt: STOP,
    createdAt: NOW,
    ...without(overrides, "batchDigest", "selectionPlan")
  };
  return { ...unsigned, selectionPlan: plan, batchDigest: governedReviewBatchDomainArtifactDigest({ ...unsigned, selectionPlan: plan }) } as GovernedReviewBatch;
}

function task(ordinal = 0, reviewer = `reviewer_${ordinal + 1}`, overrides: Partial<GovernedReviewTask> = {}): GovernedReviewTask {
  const unsigned = {
    contract: "coeval/governed-review-task/v1" as const,
    schemaVersion: 1 as const,
    taskId: `task_${ordinal + 1}`,
    projectId: PROJECT_ID,
    batchId: "batch_one",
    reviewItemId: ITEM_ID,
    criterionVersionId: "criterion_version_one",
    instructionVersionId: "instruction_one",
    reviewerSubjectId: reviewer,
    reviewerRoleAtReview: "reviewer",
    assignmentOrdinal: ordinal,
    servePosition: 0,
    createdAt: NOW,
    ...without(overrides, "taskDigest")
  };
  return { ...unsigned, taskDigest: governedReviewTaskDomainArtifactDigest(unsigned) };
}

function label(
  reviewTask: GovernedReviewTask,
  value: GovernedReviewLabelValue,
  overrides: Partial<GovernedReviewLabel> = {}
): GovernedReviewLabel {
  const unsigned = {
    contract: "coeval/governed-review-label/v1" as const,
    schemaVersion: 1 as const,
    labelId: `label_${reviewTask.taskId}_${overrides.attemptNumber ?? 1}`,
    projectId: reviewTask.projectId,
    batchId: reviewTask.batchId,
    taskId: reviewTask.taskId,
    reviewItemId: reviewTask.reviewItemId,
    criterionVersionId: reviewTask.criterionVersionId,
    instructionVersionId: reviewTask.instructionVersionId,
    reviewerSubjectId: reviewTask.reviewerSubjectId,
    attemptNumber: 1,
    replacesLabelId: null,
    value,
    rationale: value === "cannot_determine" ? "The relevant evidence is absent." : `Evidence supports ${value}.`,
    failureCodes: value === "fail" ? ["unsupported claim"] : [],
    blindViewDigest: VIEW_DIGEST,
    submittedAt: NOW,
    ...without(overrides, "labelDigest")
  };
  return { ...unsigned, labelDigest: governedReviewLabelDomainArtifactDigest(unsigned) } as GovernedReviewLabel;
}

function blindView(reviewTask = task()): ReturnType<typeof buildGovernedBlindTaskView> {
  return buildGovernedBlindTaskView({ task: reviewTask, item: item(), instruction: instruction(), criterion: criterion() });
}

function taskEvent(
  reviewTask: GovernedReviewTask,
  sequence: number,
  type: GovernedReviewTaskEvent["type"],
  extra: Record<string, unknown>,
  previousEventDigest: string | null
): GovernedReviewTaskEvent {
  const unsigned = {
    contract: "coeval/governed-review-task-event/v1" as const,
    schemaVersion: 1 as const,
    eventId: `task_event_${sequence}`,
    projectId: reviewTask.projectId,
    batchId: reviewTask.batchId,
    taskId: reviewTask.taskId,
    reviewItemId: reviewTask.reviewItemId,
    criterionVersionId: reviewTask.criterionVersionId,
    instructionVersionId: reviewTask.instructionVersionId,
    sequence,
    stateVersion: sequence,
    expectedPreviousStateVersion: sequence - 1,
    actorSubjectId: type === "expired" ? "system" : reviewTask.reviewerSubjectId,
    actorRoleAtReview: type === "expired" ? "system" : reviewTask.reviewerRoleAtReview,
    previousEventDigest,
    occurredAt: `2026-08-23T10:00:0${sequence}.000Z`,
    type,
    ...extra
  };
  return { ...unsigned, eventDigest: governedReviewTaskEventDomainArtifactDigest(unsigned as GovernedReviewTaskEvent) } as GovernedReviewTaskEvent;
}

function viewedEvent(reviewTask: GovernedReviewTask, sequence = 1, previous: string | null = null): GovernedReviewTaskEvent {
  const view = blindView(reviewTask);
  const bytes = canonicalGovernedBlindTaskViewBytes(view);
  return taskEvent(reviewTask, sequence, "viewed", {
    viewContractVersion: view.contract,
    canonicalizationVersion: view.canonicalizationVersion,
    canonicalViewBytesBase64: bytes.toString("base64"),
    viewDigest: governedBlindTaskViewDigest(view),
    exposureClass: "provenance",
    activity: "governed_review"
  }, previous);
}

function adjudication(
  labels: GovernedReviewLabel[],
  overrides: Partial<GovernedReviewAdjudication> = {}
): GovernedReviewAdjudication {
  const unsigned = {
    contract: "coeval/governed-review-adjudication/v1" as const,
    schemaVersion: 1 as const,
    adjudicationId: overrides.adjudicationId ?? "adjudication_one",
    projectId: PROJECT_ID,
    batchId: "batch_one",
    reviewItemId: ITEM_ID,
    criterionVersionId: "criterion_version_one",
    instructionVersionId: "instruction_one",
    adjudicatorSubjectId: "adjudicator_subject",
    adjudicatorRoleAtReview: "adjudicator",
    sequence: 1,
    expectedPreviousChainVersion: 0,
    consideredLabelIds: labels.map((entry) => entry.labelId).sort(),
    decision: "pass" as const,
    rationale: "The trace supports the response after considering both independent labels.",
    basis: "Apply the frozen accuracy instruction to the complete independent evidence set.",
    predecessorAdjudicationId: null,
    correctionReason: null,
    createdAt: NOW,
    ...without(overrides, "adjudicationDigest")
  };
  return { ...unsigned, adjudicationDigest: governedReviewAdjudicationDomainArtifactDigest(unsigned) } as GovernedReviewAdjudication;
}

function batchEvent(
  reviewBatch: GovernedReviewBatch,
  sequence: number,
  type: GovernedReviewBatchEvent["type"],
  extra: Record<string, unknown>,
  previousEventDigest: string | null
): GovernedReviewBatchEvent {
  const unsigned = {
    contract: "coeval/governed-review-batch-event/v1" as const,
    schemaVersion: 1 as const,
    batchEventId: `batch_event_${sequence}`,
    projectId: reviewBatch.projectId,
    batchId: reviewBatch.batchId,
    sequence,
    stateVersion: sequence,
    expectedPreviousStateVersion: sequence - 1,
    actorSubjectId: "operator_subject",
    actorRoleAtReview: "review_operator",
    previousEventDigest,
    occurredAt: `2026-08-23T11:00:0${sequence}.000Z`,
    type,
    ...extra
  };
  return { ...unsigned, eventDigest: governedReviewBatchEventDomainArtifactDigest(unsigned as GovernedReviewBatchEvent) } as GovernedReviewBatchEvent;
}

describe("governed review immutable contracts", () => {
  it("binds nonsealed items to an exact immutable revision item and rejects source ambiguity", () => {
    expect(verifyGovernedReviewItem(item())).toEqual(item());
    const ambiguous = { ...item(), sealedIntakePopulationId: "sealed" };
    ambiguous.itemDigest = governedReviewItemDomainArtifactDigest(ambiguous);
    expect(() => verifyGovernedReviewItem(ambiguous)).toThrow();
    expect(() => GovernedReviewItemSchema.parse({ ...item(), payloadSnapshot: { input: {}, output: {}, metadata: {} } })).toThrow();
  });

  it("requires a nonblank rationale for every label and preserves failure-code bytes verbatim", () => {
    const reviewTask = task();
    const blank = label(reviewTask, "cannot_determine", { rationale: "   " });
    expect(() => deriveGovernedReviewTaskHistory({ task: reviewTask, events: [], labels: [blank] })).toThrow();
    const code = "  reviewer code with intentional spacing  ";
    const withVerbatimCode = label(reviewTask, "fail", { failureCodes: [code] });
    expect(withVerbatimCode.failureCodes).toEqual([code]);
  });

  it("keeps instruction bytes immutable and isolates criterion versions", () => {
    const original = instruction();
    expect(original.instructions).toContain("full input, output, and trace snapshot");
    expect(() => buildGovernedBlindTaskView({
      task: task(), item: item(), instruction: original,
      criterion: criterion({ id: "criterion_version_other" })
    })).toThrow("criterion version mismatch");
    expect(() => verifyGovernedReviewBatch(batch(), instruction({ criterionVersionId: "criterion_version_other" }))).toThrow();
  });

  it("fails closed when sealed source, blindness, or capability separation is inconsistent", () => {
    const sealed = batch(2, {
      roleIntent: "sealed_validation",
      sourcePopulationKind: "sealed_intake",
      separationOfDutiesRequired: true,
      custodianRoleAtReview: "sealed_custodian"
    });
    expect(verifyGovernedReviewBatch(sealed)).toEqual(sealed);
    expect(() => verifyGovernedReviewTask(task(0, "developer_subject"), sealed)).toThrow("capability or exposure");
    const leaked = batch(2, {
      roleIntent: "sealed_validation",
      sourcePopulationKind: "sealed_intake",
      peerBlindUntilLabelingClosed: false,
      separationOfDutiesRequired: true,
      custodianRoleAtReview: "sealed_custodian"
    });
    expect(() => verifyGovernedReviewBatch(leaked)).toThrow("peer blindness");
  });

  it("rejects recursive evaluator/expected-label canaries and exposes only the allowlisted view", () => {
    const poisoned = item({ payloadSnapshot: {
      input: { nested: { judge_label: "pass" } },
      output: { answer: "4" }
    } });
    expect(() => buildGovernedBlindTaskView({ task: task(), item: poisoned, instruction: instruction(), criterion: criterion() }))
      .toThrow("forbidden field");

    const view = blindView();
    const rendered = canonicalGovernedBlindTaskViewBytes(view).toString("utf8");
    for (const canary of ["sourceCaseId", "sourceDatasetRevisionItemId", "evaluatorLabel", "expectedLabel", "peerLabels", "adjudication"]) {
      expect(rendered).not.toContain(`\"${canary}\"`);
    }
    expect(verifyGovernedBlindTaskView(JSON.parse(rendered))).toEqual(view);
  });

  it("makes canonical digests deterministic and detects tampered exact view bytes", () => {
    expect(governedReviewRequestDigest({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(governedReviewRequestDigest({ a: { c: 3, d: 4 }, b: 2 }));
    const reviewTask = task();
    const viewed = viewedEvent(reviewTask);
    const tampered = structuredClone(viewed) as Extract<GovernedReviewTaskEvent, { type: "viewed" }>;
    tampered.canonicalViewBytesBase64 = Buffer.from("{}", "utf8").toString("base64");
    tampered.eventDigest = governedReviewTaskEventDomainArtifactDigest(tampered);
    expect(() => deriveGovernedReviewTaskHistory({ task: reviewTask, events: [tampered], labels: [] }))
      .toThrow(/view|task/i);
  });

  it("treats semantic idempotency replay and conflict distinctly", () => {
    const digest = governedReviewRequestDigest({ itemIds: ["a"], labels: 2 });
    expect(decideGovernedReviewIdempotency(digest, { labels: 2, itemIds: ["a"] }).status).toBe("replay");
    expect(decideGovernedReviewIdempotency(digest, { labels: 3, itemIds: ["a"] }).status).toBe("conflict");
  });
});

describe("task event truth and the independent-submission barrier", () => {
  it("derives undo history without overwriting the original label", () => {
    const reviewTask = task();
    const view = blindView(reviewTask);
    const first = label(reviewTask, "pass", { blindViewDigest: governedBlindTaskViewDigest(view) });
    const replacement = label(reviewTask, "fail", {
      labelId: "label_replacement", attemptNumber: 2, replacesLabelId: first.labelId,
      blindViewDigest: governedBlindTaskViewDigest(view)
    });
    const e1 = viewedEvent(reviewTask);
    const e2 = taskEvent(reviewTask, 2, "label_submitted", { labelId: first.labelId }, e1.eventDigest);
    const e3 = taskEvent(reviewTask, 3, "label_withdrawn", { labelId: first.labelId, reason: "Correction" }, e2.eventDigest);
    const e4 = taskEvent(reviewTask, 4, "label_submitted", { labelId: replacement.labelId }, e3.eventDigest);
    const history = deriveGovernedReviewTaskHistory({ task: reviewTask, events: [e1, e2, e3, e4], labels: [first, replacement] });
    expect(history.state).toBe("submitted");
    expect(history.activeLabel?.labelId).toBe(replacement.labelId);
    expect(history.labels.map((entry) => entry.labelId)).toEqual([first.labelId, replacement.labelId]);
    expect(history.withdrawnLabelIds).toEqual([first.labelId]);
  });

  it("rejects event reorder, skipped stream versions, self-overwrite, and revealed withdrawal", () => {
    const reviewTask = task();
    const view = blindView(reviewTask);
    const first = label(reviewTask, "pass", { blindViewDigest: governedBlindTaskViewDigest(view) });
    const e1 = viewedEvent(reviewTask);
    const e2 = taskEvent(reviewTask, 2, "label_submitted", { labelId: first.labelId }, e1.eventDigest);
    expect(() => deriveGovernedReviewTaskHistory({ task: reviewTask, events: [e2, e1], labels: [first] })).toThrow(/contiguous/);
    const staleCas = { ...e1, expectedPreviousStateVersion: 1 };
    staleCas.eventDigest = governedReviewTaskEventDomainArtifactDigest(staleCas);
    expect(() => deriveGovernedReviewTaskHistory({ task: reviewTask, events: [staleCas], labels: [] })).toThrow(/version/);
    const duplicate = taskEvent(reviewTask, 3, "label_submitted", { labelId: first.labelId }, e2.eventDigest);
    expect(() => deriveGovernedReviewTaskHistory({ task: reviewTask, events: [e1, e2, duplicate], labels: [first] }))
      .toThrow("invalid governed review task transition");
    const withdrawal = taskEvent(reviewTask, 3, "label_withdrawn", { labelId: first.labelId, reason: "Changed" }, e2.eventDigest);
    expect(() => deriveGovernedReviewTaskHistory({
      task: reviewTask, events: [e1, e2, withdrawal], labels: [first], revealedLabelIds: new Set([first.labelId])
    })).toThrow("revealed");
  });

  it("supports defer/resume and server expiry exactly where the task table allows", () => {
    const reviewTask = task();
    const e1 = viewedEvent(reviewTask);
    const e2 = taskEvent(reviewTask, 2, "deferred", { reason: "Need source context" }, e1.eventDigest);
    const e3 = taskEvent(reviewTask, 3, "resumed", { reason: "Context supplied" }, e2.eventDigest);
    expect(deriveGovernedReviewTaskHistory({ task: reviewTask, events: [e1, e2, e3], labels: [] }).state).toBe("viewed");
    const expired = taskEvent(reviewTask, 1, "expired", { reason: "fixed_stop_reached" }, null);
    expect(deriveGovernedReviewTaskHistory({ task: reviewTask, events: [expired], labels: [] }).state).toBe("expired");
  });

  it("forbids every task mutation after labeling_closed", () => {
    for (const type of ["viewed", "deferred", "resumed", "label_submitted", "label_withdrawn", "expired"] as const) {
      expect(() => assertGovernedReviewTaskEventAllowed("labeling_closed", type)).toThrow("forbidden");
    }
  });
});

describe("batch state and alignment evidence", () => {
  it.each([
    ["draft", "open"], ["draft", "abandoned"], ["open", "labeling_closed"],
    ["labeling_closed", "resolved"], ["labeling_closed", "alignment_open"],
    ["labeling_closed", "adjudicating"], ["labeling_closed", "incomplete"],
    ["alignment_open", "adjudicating"], ["alignment_open", "incomplete"],
    ["adjudicating", "resolved"], ["adjudicating", "incomplete"], ["resolved", "frozen"]
  ] as const)("allows the accepted edge %s -> %s", (from, to) => {
    expect(transitionGovernedReviewBatchState(from, to)).toBe(to);
  });

  it("keeps incomplete terminal and disallows partial freeze", () => {
    expect(() => transitionGovernedReviewBatchState("incomplete", "frozen")).toThrow();
    expect(() => transitionGovernedReviewBatchState("alignment_open", "resolved")).toThrow();
  });

  it("closes only with the exact terminal task denominator", () => {
    const reviewBatch = batch(2);
    const labels = [label(task(0), "pass"), label(task(1), "pass")];
    const opened = batchEvent(reviewBatch, 1, "opened", {}, null);
    const closed = batchEvent(reviewBatch, 2, "labeling_closed", {
      activeLabelIds: labels.map((entry) => entry.labelId).sort(), deferredTaskIds: [], expiredTaskIds: [], closedAtFixedStop: false
    }, opened.eventDigest);
    expect(deriveGovernedReviewBatchHistory({ batch: reviewBatch, events: [opened, closed], activeLabels: labels }).state)
      .toBe("labeling_closed");
    const missing = batchEvent(reviewBatch, 2, "labeling_closed", {
      activeLabelIds: [labels[0]!.labelId], deferredTaskIds: [], expiredTaskIds: [], closedAtFixedStop: false
    }, opened.eventDigest);
    expect(() => deriveGovernedReviewBatchHistory({ batch: reviewBatch, events: [opened, missing], activeLabels: labels }))
      .toThrow("terminal task");
    const wrongProject = { ...labels[1]!, projectId: "project_other" };
    wrongProject.labelDigest = governedReviewLabelDomainArtifactDigest(wrongProject);
    expect(() => deriveGovernedReviewBatchHistory({
      batch: reviewBatch, events: [opened, closed], activeLabels: [labels[0]!, wrongProject]
    })).toThrow("label project");
  });

  it("records exact post-barrier label visibility in a contiguous alignment stream", () => {
    const reviewBatch = batch(2);
    const visible = ["label_task_1_1", "label_task_2_1"];
    const unsigned = {
      contract: "coeval/governed-review-alignment-event/v1" as const, schemaVersion: 1 as const,
      alignmentEventId: "alignment_one", projectId: PROJECT_ID, batchId: reviewBatch.batchId,
      sequence: 1, expectedPreviousSequence: 0, actorSubjectId: "alignment_subject", actorRoleAtReview: "alignment_facilitator",
      visibleActiveLabelIds: visible, kind: "comment_recorded" as const,
      content: "The reviewers disagreed about whether the trace supports the final claim.",
      previousEventDigest: null, occurredAt: NOW
    };
    const event = { ...unsigned, eventDigest: governedReviewAlignmentEventDomainArtifactDigest(unsigned as GovernedReviewAlignmentEvent) };
    expect(verifyGovernedReviewAlignmentHistory({
      batch: reviewBatch, batchState: "alignment_open", barrierActiveLabelIds: visible, events: [event]
    })).toHaveLength(1);
    expect(() => verifyGovernedReviewAlignmentHistory({
      batch: reviewBatch, batchState: "alignment_open", barrierActiveLabelIds: [visible[0]!], events: [event]
    })).toThrow("visible active label");
  });
});

describe("exact truth resolution without majority voting", () => {
  it("implements unanimous, single-rater, coverage-gap, and cannot-determine rows", () => {
    const two = batch(2);
    const passes = [label(task(0), "pass"), label(task(1), "pass")];
    expect(resolveGovernedReviewTruth({
      batch: two, batchState: "labeling_closed", reviewItemId: ITEM_ID, activeLabels: passes,
      barrierActiveLabelIds: labelIds(passes)
    })).toMatchObject({ status: "resolved", basis: "unanimous", referenceLabel: "pass" });
    expect(resolveGovernedReviewTruth({
      batch: batch(1), batchState: "labeling_closed", reviewItemId: ITEM_ID, activeLabels: [label(task(0), "fail")],
      barrierActiveLabelIds: ["label_task_1_1"]
    })).toMatchObject({ status: "resolved", basis: "single_rater", singleRater: true, referenceLabel: "fail" });
    expect(resolveGovernedReviewTruth({
      batch: two, batchState: "labeling_closed", reviewItemId: ITEM_ID, activeLabels: [passes[0]!],
      barrierActiveLabelIds: [passes[0]!.labelId]
    })).toMatchObject({ status: "unresolved", basis: "coverage_gap" });
    expect(resolveGovernedReviewTruth({
      batch: two, batchState: "labeling_closed", reviewItemId: ITEM_ID,
      activeLabels: [label(task(0), "cannot_determine"), label(task(1), "pass")],
      barrierActiveLabelIds: ["label_task_1_1", "label_task_2_1"]
    })).toMatchObject({ status: "unresolved", basis: "requires_adjudication" });
  });

  it("rejects a 2-to-1 majority and requires adjudication over the exact frozen label set", () => {
    const reviewBatch = batch(3);
    const labels = [label(task(0), "pass"), label(task(1), "pass"), label(task(2), "fail")];
    expect(resolveGovernedReviewTruth({
      batch: reviewBatch, batchState: "labeling_closed", reviewItemId: ITEM_ID, activeLabels: labels,
      barrierActiveLabelIds: labelIds(labels)
    })).toMatchObject({ status: "unresolved", basis: "requires_adjudication", referenceLabel: null });
    const incompleteAdjudication = adjudication(labels.slice(0, 2));
    expect(() => resolveGovernedReviewTruth({
      batch: reviewBatch, batchState: "adjudicating", reviewItemId: ITEM_ID,
      activeLabels: labels, barrierActiveLabelIds: labelIds(labels), adjudications: [incompleteAdjudication]
    })).toThrow("considered label");
    const exact = adjudication(labels, { decision: "fail" });
    expect(resolveGovernedReviewTruth({
      batch: reviewBatch, batchState: "adjudicating", reviewItemId: ITEM_ID,
      activeLabels: labels, barrierActiveLabelIds: labelIds(labels), adjudications: [exact]
    })).toMatchObject({ status: "resolved", basis: "adjudicated", referenceLabel: "fail" });
  });

  it("will not substitute a different active label set for the frozen barrier evidence", () => {
    const labels = [label(task(0), "pass"), label(task(1), "pass")];
    expect(() => resolveGovernedReviewTruth({
      batch: batch(2), batchState: "labeling_closed", reviewItemId: ITEM_ID, activeLabels: labels,
      barrierActiveLabelIds: [labels[0]!.labelId, "label_substituted"]
    })).toThrow("barrier active label");
  });

  it("treats unresolvable adjudication as incomplete truth and never a reference label", () => {
    const labels = [label(task(0), "pass"), label(task(1), "fail")];
    const result = resolveGovernedReviewTruth({
      batch: batch(2), batchState: "adjudicating", reviewItemId: ITEM_ID,
      activeLabels: labels, barrierActiveLabelIds: labelIds(labels),
      adjudications: [adjudication(labels, { decision: "unresolvable" })]
    });
    expect(result).toMatchObject({ status: "unresolved", basis: "unresolvable", referenceLabel: null });
  });

  it("rejects truth derivation before reveal and rejects cross-project or cross-criterion labels", () => {
    const reviewBatch = batch(2);
    const labels = [label(task(0), "pass"), label(task(1), "pass")];
    expect(() => resolveGovernedReviewTruth({
      batch: reviewBatch, batchState: "open", reviewItemId: ITEM_ID, activeLabels: labels,
      barrierActiveLabelIds: labelIds(labels)
    }))
      .toThrow("barrier");
    const poisoned = { ...labels[1]!, criterionVersionId: "other_criterion" };
    poisoned.labelDigest = governedReviewLabelDomainArtifactDigest(poisoned);
    expect(() => resolveGovernedReviewTruth({
      batch: reviewBatch, batchState: "labeling_closed", reviewItemId: ITEM_ID,
      activeLabels: [labels[0]!, poisoned], barrierActiveLabelIds: labelIds(labels)
    })).toThrow("criterion version");
  });
});

describe("adjudication CAS and immutable authoritative heads", () => {
  it("accepts one nonbranching successor and detects stale CAS", () => {
    const labels = [label(task(0), "pass"), label(task(1), "fail")];
    const first = adjudication(labels);
    const correction = adjudication(labels, {
      adjudicationId: "adjudication_two", sequence: 2,
      expectedPreviousChainVersion: 1,
      predecessorAdjudicationId: first.adjudicationId, correctionReason: "The first decision misread step two.", decision: "fail"
    });
    expect(deriveAuthoritativeGovernedReviewAdjudication({
      batch: batch(2), reviewItemId: ITEM_ID, activeLabels: labels, adjudications: [first, correction]
    })?.adjudicationId).toBe(correction.adjudicationId);
    expect(decideGovernedReviewAdjudicationAppend(correction.adjudicationId, first.adjudicationId)).toBe("conflict");
    expect(decideGovernedReviewAdjudicationAppend(correction.adjudicationId, correction.adjudicationId)).toBe("append");
  });

  it("rejects branches, reordering, and a rater adjudicating their own item", () => {
    const labels = [label(task(0), "pass"), label(task(1), "fail")];
    const first = adjudication(labels);
    const branch = adjudication(labels, {
      adjudicationId: "adjudication_three", sequence: 2,
      expectedPreviousChainVersion: 1,
      predecessorAdjudicationId: "not_the_head", correctionReason: "Correction"
    });
    expect(() => deriveAuthoritativeGovernedReviewAdjudication({
      batch: batch(2), reviewItemId: ITEM_ID, activeLabels: labels, adjudications: [first, branch]
    })).toThrow("branches");
    expect(() => deriveAuthoritativeGovernedReviewAdjudication({
      batch: batch(2), reviewItemId: ITEM_ID, activeLabels: labels,
      adjudications: [adjudication(labels, { adjudicatorSubjectId: labels[0]!.reviewerSubjectId })]
    })).toThrow("cannot be a rater");
  });
});

describe("representative claims and imported provenance", () => {
  it("derives a claim only for the exact complete server-drawn population frame", () => {
    expect(deriveRepresentativeClaimEligibility({
      batch: batch(2), batchState: "resolved", resolvedReviewItemIds: [ITEM_ID], deferredTaskIds: [],
      expiredTaskIds: [], cannotDetermineLabelIds: []
    })).toEqual({
      representativeClaimEligible: true, representativeOfPopulationId: "population_one", reasons: ["eligible"],
      selectedItems: 1, resolvedItems: 1
    });
    expect(deriveRepresentativeClaimEligibility({
      batch: batch(2), batchState: "incomplete", resolvedReviewItemIds: [], deferredTaskIds: ["task_1"], expiredTaskIds: [],
      cannotDetermineLabelIds: ["label_task_2_1"]
    })).toMatchObject({
      representativeClaimEligible: false, representativeOfPopulationId: null,
      reasons: expect.arrayContaining(["review_coverage_incomplete", "deferred_assignments", "cannot_determine_present"])
    });
    expect(deriveRepresentativeClaimEligibility({
      batch: batch(2), batchState: "labeling_closed", resolvedReviewItemIds: [ITEM_ID],
      deferredTaskIds: [], expiredTaskIds: [], cannotDetermineLabelIds: []
    })).toMatchObject({ representativeClaimEligible: false, representativeOfPopulationId: null });
  });

  it.each(["convenience", "systematic", "uncertainty", "failure_hunting", "manual"] as GovernedReviewSelectionMethod[])(
    "never upgrades a %s sample to representative",
    (method) => {
      const reviewItem = item();
      const biasedPlan = selectionPlan([reviewItem.itemDigest], { method, seed: null, rngVersion: null, inclusionProbability: null, weight: null });
      const biasedBatch = batch(2, { selectionPlan: biasedPlan });
      expect(deriveRepresentativeClaimEligibility({
        batch: biasedBatch, batchState: "resolved", resolvedReviewItemIds: [ITEM_ID], deferredTaskIds: [],
        expiredTaskIds: [], cannotDetermineLabelIds: []
      })).toMatchObject({ representativeClaimEligible: false, reasons: ["selection_method_not_eligible"] });
    }
  );

  it("never upgrades caller-supplied proof-shaped JSON to verified attestation", () => {
    const claimedVerified = importedTruth("verified_signature", sha256Digest({ proof: "signature" }));
    expect(classifyImportedHumanTruth(without(claimedVerified, "classification", "importDigest"))).toBe("imported_self_attested");
    expect(verifyImportedHumanTruth(claimedVerified).classification).toBe("imported_self_attested");
    const self = importedTruth("self_attested", null);
    expect(verifyImportedHumanTruth(self).classification).toBe("imported_self_attested");
    const missing = importedTruth("unverified", null, { issuer: null, classification: "unverified" });
    expect(verifyImportedHumanTruth(missing).classification).toBe("unverified");
    const inflated = { ...self, classification: "imported_verified_attested" as const };
    inflated.importDigest = importedHumanTruthDomainArtifactDigest(inflated);
    expect(() => verifyImportedHumanTruth(inflated)).toThrow("classification");
    const completeButUnverified = importedTruth("unverified", null);
    expect(classifyImportedHumanTruth(without(completeButUnverified, "classification", "importDigest"))).toBe("imported_self_attested");
    const tamperedEvidence = { ...claimedVerified, verificationEvidence: { proof: "different" } };
    tamperedEvidence.importDigest = importedHumanTruthDomainArtifactDigest(tamperedEvidence);
    expect(() => verifyImportedHumanTruth(tamperedEvidence)).toThrow("verification evidence digest");
  });

  it("keeps governed materialization links separate from legacy verdict/user provenance", () => {
    const unsigned = {
      contract: "coeval/governed-dataset-reference-provenance/v1" as const, schemaVersion: 1 as const,
      kind: "governed_labels" as const, projectId: PROJECT_ID, datasetRevisionId: "revision_out",
      datasetRevisionItemId: "revision_item_out", criterionVersionId: "criterion_version_one",
      referenceLabel: "pass" as const, batchItemId: "batch_item_one",
      labelIds: ["label_task_1_1", "label_task_2_1"], resolutionBasis: "unanimous" as const,
      createdAt: NOW
    };
    const provenance = {
      ...unsigned,
      provenanceDigest: governedDatasetReferenceProvenanceDomainArtifactDigest(unsigned)
    };
    expect(verifyGovernedDatasetReferenceProvenance(provenance)).toEqual(provenance);
    expect(provenance).not.toHaveProperty("verdictIds");
    expect(provenance).not.toHaveProperty("actorUserIds");
  });
});

describe("agreement diagnostics", () => {
  it("leaves one-class kappa undefined instead of reporting perfect calibration", () => {
    expect(computeGovernedBinaryAgreement([
      { reviewerA: "pass", reviewerB: "pass" },
      { reviewerA: "pass", reviewerB: "pass" }
    ])).toEqual({ support: 2, observedAgreement: 1, kappa: null, undefinedReason: "one_class" });
  });
});

function importedTruth(
  verificationMethod: NonNullable<ImportedHumanTruth["verificationMethod"]>,
  verificationEvidenceDigest: string | null,
  overrides: Partial<ImportedHumanTruth> = {}
): ImportedHumanTruth {
  const sourceArtifact = { input: { prompt: "2+2" }, output: { answer: "4" } };
  const verificationEvidence = verificationEvidenceDigest === null ? null : { proof: "signature" };
  const instructionText = "Decide whether the answer is accurate.";
  const attestation = {
    attestedBySubjectId: "issuer_subject",
    statement: "Raters were blind to the evaluated system output.",
    attestedAt: NOW,
    attestationDigest: ""
  };
  attestation.attestationDigest = sha256Digest(without(attestation, "attestationDigest"));
  const unsignedBase = {
    contract: "coeval/imported-human-truth/v1" as const,
    schemaVersion: 1 as const,
    importedTruthId: "import_one",
    projectId: PROJECT_ID,
    criterionId: "criterion_one",
    criterionVersionId: "criterion_version_one",
    issuer: "External Lab",
    subject: "study_subject_one",
    sourceSystem: "external_lab",
    sourceRecordId: "record_one",
    sourceDigest: sha256Digest(sourceArtifact),
    sourceArtifact,
    transportMethod: "signed-json",
    verificationMethod,
    verificationEvidence,
    verificationEvidenceDigest,
    instructionText,
    instructionDigest: sha256Digest(instructionText),
    raters: [{ subjectId: "external_reviewer", roleAtReview: "reviewer" }],
    label: "pass" as const,
    rationale: "The answer is mathematically correct.",
    failureCodes: [],
    adjudicatorSubjectId: "external_adjudicator",
    adjudicationDecision: "pass" as const,
    adjudicationRationale: "The independent evidence supports the imported pass label.",
    blindAttestation: attestation,
    classification: "imported_self_attested" as const,
    importedAt: NOW,
    ...without(overrides, "importDigest")
  };
  return { ...unsignedBase, importDigest: importedHumanTruthDomainArtifactDigest(unsignedBase as ImportedHumanTruth) } as ImportedHumanTruth;
}

function labelIds(labels: GovernedReviewLabel[]): string[] {
  return labels.map((entry) => entry.labelId).sort();
}

function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
