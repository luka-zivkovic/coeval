// Append-only task, batch, alignment, adjudication, and truth state derivation.
import {
  GovernedReviewAdjudicationSchema,
  GovernedReviewAlignmentEventSchema,
  GovernedReviewBatchEventSchema,
  GovernedReviewTaskEventSchema,
  GovernedTruthResolutionSchema,
  RepresentativeClaimEligibilitySchema,
  type GovernedBlindTaskView,
  type GovernedReviewAdjudication,
  type GovernedReviewAlignmentEvent,
  type GovernedReviewBatch,
  type GovernedReviewBatchEvent,
  type GovernedReviewBatchState,
  type GovernedReviewLabel,
  type GovernedReviewTask,
  type GovernedReviewTaskEvent,
  type GovernedTruthResolution,
  type RepresentativeClaimEligibility,
  type RepresentativeClaimReason
} from "@coeval/shared";
import { canonicalJson } from "./assessment-receipt.js";
import { governedContentV1Digest } from "./governed-content-digest.js";
import {
  assertExactSet,
  assertSame,
  assertSortedUnique,
  assertSubjectSeparated,
  assertUnique,
  compareStrings,
  sha256Bytes
} from "./governed-review-common.js";
import {
  governedReviewSelectionDrawDomainArtifactDigest,
  governedReviewTaskEventDomainArtifactDigest,
  verifyGovernedReviewBatch,
  verifyGovernedReviewLabel,
  verifyGovernedReviewTask
} from "./governed-review-artifacts.js";
import { verifyGovernedBlindTaskView } from "./governed-review-evidence.js";

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

function assertEventTaskScope(event: GovernedReviewTaskEvent, task: GovernedReviewTask): void {
  assertSame(event.projectId, task.projectId, "event task project");
  assertSame(event.batchId, task.batchId, "event task batch");
  assertSame(event.taskId, task.taskId, "event task identity");
  assertSame(event.reviewItemId, task.reviewItemId, "event task item");
  assertSame(event.criterionVersionId, task.criterionVersionId, "event task criterion version");
  assertSame(event.instructionVersionId, task.instructionVersionId, "event task instruction version");
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

function invalidTaskTransition(state: GovernedReviewTaskState, event: GovernedReviewTaskEvent["type"]): Error {
  return new Error(`invalid governed review task transition: ${state} -> ${event}`);
}
