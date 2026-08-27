import {
  GovernedBlindTaskViewSchema,
  type GovernedBlindTaskView,
  type GovernedReviewLabelValue,
  type GovernedReviewRoleIntent,
  type GovernedReviewSelectionMethod
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "coeval.project";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_BLIND_VIEW_BYTES = 2 * 1024 * 1024;

const FORBIDDEN_BLIND_KEYS = new Set([
  "caseid", "traceid", "sourcecaseid", "sourcetraceid", "datasetid", "datasetitemid",
  "datasetrevisionid", "datasetrevisionitemid", "sourcedatasetrevisionid",
  "sourcedatasetrevisionitemid", "sealedintakeid", "sealedintakeitemid", "skillversionid",
  "evaluatorversionid", "evaluatoroutput", "evaluatoroutputs", "evaluatorlabel",
  "evaluatorrationale", "judgelabel", "judgedlabel", "judgerationale", "judgerun",
  "rawjudgecall", "rawrequest", "rawresponse", "expectedlabel", "expectedfailstep",
  "goldenlabel", "latesthumanlabel", "peerlabel", "peerlabels", "adjudication",
  "verdict", "verdicts"
]);

export type JsonRecord = Record<string, unknown>;

export class GovernedReviewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "GovernedReviewApiError";
  }
}

export interface GovernedInstructionSummary {
  instructionVersionId: string;
  criterionVersionId: string | null;
  title: string;
  revision: number | null;
  instructionDigest: string | null;
  createdAt: string | null;
}

export interface GovernedAssignableSubject {
  subjectId: string;
  userId: string;
  displayName: string | null;
  email: string | null;
  role: string | null;
}

export type GovernedBatchState =
  | "draft"
  | "open"
  | "labeling_closed"
  | "alignment_open"
  | "adjudicating"
  | "resolved"
  | "abandoned"
  | "incomplete"
  | "frozen";

export interface GovernedBatchMemberSummary {
  reviewItemId: string;
  batchItemId: string | null;
  servePosition: number | null;
  taskIds: string[];
  resolutionKind: string | null;
  resolvedLabel: "pass" | "fail" | null;
}

export interface GovernedBatchSummary {
  batchId: string;
  state: GovernedBatchState | null;
  stateVersion: number | null;
  criterionVersionId: string | null;
  instructionVersionId: string | null;
  instructionDigest: string | null;
  roleIntent: GovernedReviewRoleIntent | null;
  sourcePopulationKind: "dataset_revision" | "analysis_promotion_handoff" | "sealed_intake" | null;
  sourcePopulationId: string | null;
  selectionMethod: GovernedReviewSelectionMethod | null;
  populationSize: number | null;
  fixedBudget: number | null;
  requiredIndependentLabels: number | null;
  itemCount: number | null;
  evaluatorBlind: boolean | null;
  peerBlindUntilLabelingClosed: boolean | null;
  fixedStopAt: string | null;
  batchDigest: string | null;
  populationDigest: string | null;
  drawDigest: string | null;
  representativeOfPopulationId: string | null;
  representativeReason: string | null;
  representativeness: {
    status: "not_evaluated" | "eligible" | "ineligible" | null;
    populationId: string | null;
    reasons: string[];
  };
  datasetRevisionId: string | null;
  evidenceClass: "governed_blind" | null;
  coverage: {
    totalTasks: number | null;
    submittedTasks: number | null;
    deferredTasks: number | null;
    expiredTasks: number | null;
    resolvedItems: number | null;
    unresolvedItems: number | null;
    complete: boolean | null;
  };
  members: GovernedBatchMemberSummary[];
  createdAt: string | null;
  raw: JsonRecord;
}

export interface GovernedTaskSummary {
  taskId: string;
  batchId: string | null;
  reviewItemId: string | null;
  criterionName: string | null;
  instructionTitle: string | null;
  state: string | null;
  stateVersion: number | null;
  servePosition: number | null;
  roleIntent: GovernedReviewRoleIntent | null;
  fixedStopAt: string | null;
  activeLabelId: string | null;
  raw: JsonRecord;
}

export interface GovernedBlindTaskArtifact {
  view: GovernedBlindTaskView;
  viewDigest: string;
  canonicalBytes: Uint8Array;
  canonicalText: string;
}

export interface GovernedPeerLabel {
  labelId: string;
  reviewerSubjectId: string | null;
  value: GovernedReviewLabelValue | null;
  rationale: string | null;
  failureCodes: string[];
  active: boolean | null;
}

export interface GovernedPostBarrierItem {
  batchId: string | null;
  reviewItemId: string;
  criterion: { criterionVersionId: string | null; name: string; definition: string } | null;
  instruction: { instructionVersionId: string | null; title: string; instructions: string; failureCodeGuidance: string } | null;
  payloadSnapshot: { input: unknown; output: unknown; steps?: Array<{ name: string; input: unknown; output: unknown }> } | null;
  roleIntent: GovernedReviewRoleIntent | null;
  labels: GovernedPeerLabel[];
  resolution: {
    status: string | null;
    referenceLabel: "pass" | "fail" | null;
    basis: string | null;
  } | null;
  adjudicationHeadId: string | null;
  evaluatorEvidence: {
    label: string | null;
    rationale: string | null;
    digest: string | null;
  } | null;
  alignmentVersion: number | null;
  raw: JsonRecord;
}

export interface CreateInstructionInput {
  criterionVersionId: string;
  predecessorInstructionVersionId?: string | null;
  title: string;
  instructions: string;
  failureCodeGuidance: string;
  idempotencyKey: string;
}

export interface CreateSealedIntakeInput {
  populationDefinition: string;
  timeWindow?: { startInclusive: string; endExclusive: string } | null;
  predecessorRevisionId?: string;
  items: Array<{
    clientItemId: string;
    input: unknown;
    output: unknown;
    steps?: Array<{ name?: string; input: unknown; output: unknown }>;
  }>;
  idempotencyKey: string;
}

export interface CreateBatchInput {
  instructionVersionId: string;
  roleIntent: GovernedReviewRoleIntent;
  source:
    | { kind: "dataset_revision"; revisionId: string }
    | { kind: "analysis_promotion_handoff"; promotionId: string }
    | { kind: "sealed_intake"; intakeId: string };
  selection:
    | { method: "simple_random" | "systematic"; fixedBudget: number }
    | {
        method: "stratified_random";
        strata: Array<{
          key: string;
          definition: string;
          sourceItemIds: string[];
          fixedBudget: number;
        }>;
      }
    | {
        method: "convenience" | "uncertainty" | "failure_hunting" | "manual";
        selectedSourceItemIds: string[];
      };
  reviewerUserIds: string[];
  fixedStopAt: string;
  idempotencyKey: string;
}

export function governedIdempotencyKey(action: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-${action}-${suffix}`;
}

export async function fetchGovernedInstructions(criterionVersionId?: string): Promise<GovernedInstructionSummary[]> {
  const query = criterionVersionId ? `?criterionVersionId=${encodeURIComponent(criterionVersionId)}` : "";
  const body = await governedJson(`/api/governed-review/instructions${query}`);
  return records(body.instructions).map(normalizeInstruction);
}

export async function createGovernedInstruction(input: CreateInstructionInput): Promise<GovernedInstructionSummary> {
  const body = await governedJson("/api/governed-review/instructions", jsonMutation(input));
  return normalizeInstruction(record(body.instruction, "instruction"));
}

export async function fetchGovernedSubjects(): Promise<GovernedAssignableSubject[]> {
  const body = await governedJson("/api/governed-review/subjects");
  return records(body.subjects).map((subject) => ({
    subjectId: requiredId(subject, ["subjectId", "id"], "reviewer subject"),
    userId: requiredId(subject, ["userId", "accountUserId"], "reviewer user"),
    displayName: stringField(subject, ["displayName", "name"]),
    email: stringField(subject, ["email"]),
    role: stringField(subject, ["role", "projectRole"])
  }));
}

export async function createGovernedSealedIntake(input: CreateSealedIntakeInput): Promise<JsonRecord> {
  const body = await governedJson("/api/governed-review/sealed-intakes", jsonMutation(input));
  return record(body.intake, "sealed intake receipt");
}

export async function fetchGovernedBatches(filters: {
  criterionVersionId?: string;
  state?: GovernedBatchState;
} = {}): Promise<GovernedBatchSummary[]> {
  const query = new URLSearchParams();
  if (filters.criterionVersionId) query.set("criterionVersionId", filters.criterionVersionId);
  if (filters.state) query.set("state", filters.state);
  const body = await governedJson(`/api/governed-review/batches${query.size ? `?${query}` : ""}`);
  return records(body.batches).map(normalizeBatch);
}

export async function createGovernedBatch(input: CreateBatchInput): Promise<GovernedBatchSummary> {
  const body = await governedJson("/api/governed-review/batches", jsonMutation(input));
  return normalizeBatch(record(body.batch, "governed batch"));
}

export async function fetchGovernedBatch(batchId: string): Promise<GovernedBatchSummary> {
  const body = await governedJson(`/api/governed-review/batches/${pathId(batchId)}`);
  return normalizeBatch(record(body.batch, "governed batch"));
}

export async function transitionGovernedBatch(
  batchId: string,
  action: "open" | "close-labeling" | "alignment/open" | "adjudication/start" | "finalize" | "freeze",
  expectedStateVersion: number
): Promise<GovernedBatchSummary> {
  const body = await governedJson(
    `/api/governed-review/batches/${pathId(batchId)}/${action}`,
    jsonMutation({ expectedStateVersion, idempotencyKey: governedIdempotencyKey(action.replaceAll("/", "-")) })
  );
  return normalizeBatch(record(body.batch, "governed batch"));
}

export async function fetchGovernedTasks(): Promise<GovernedTaskSummary[]> {
  const body = await governedJson("/api/governed-review/tasks");
  return records(body.tasks).map(normalizeTask);
}

export async function fetchGovernedBlindTaskView(taskId: string): Promise<GovernedBlindTaskArtifact> {
  const response = await governedRequest(`/api/governed-review/tasks/${pathId(taskId)}/view`);
  if (!response.ok) throw await errorFromResponse(response, "Blind review task request failed");
  const headerDigest = response.headers.get("x-coeval-view-digest");
  if (!headerDigest || !DIGEST_PATTERN.test(headerDigest)) {
    throw new Error("Blind review response omitted its exact view digest");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BLIND_VIEW_BYTES) {
    throw new Error("Blind review response has an invalid byte length");
  }
  const actualDigest = await sha256Digest(bytes);
  if (actualDigest !== headerDigest) throw new Error("Blind review bytes do not match the response digest");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Blind review response is not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Blind review response is not valid JSON");
  }
  assertBlindViewHasNoForbiddenKeys(raw);
  const view = GovernedBlindTaskViewSchema.parse(raw);
  if (view.taskId !== taskId) throw new Error("Blind review response swapped task identity");
  return { view, viewDigest: headerDigest, canonicalBytes: bytes, canonicalText: text };
}

export async function deferGovernedTask(taskId: string, expectedStreamVersion: number, reason: string): Promise<GovernedTaskSummary> {
  return taskMutation(taskId, "defer", {
    expectedStreamVersion,
    reason,
    idempotencyKey: governedIdempotencyKey("defer")
  });
}

export async function resumeGovernedTask(taskId: string, expectedStreamVersion: number, reason: string | null): Promise<GovernedTaskSummary> {
  return taskMutation(taskId, "resume", {
    expectedStreamVersion,
    reason,
    idempotencyKey: governedIdempotencyKey("resume")
  });
}

export async function submitGovernedLabel(input: {
  taskId: string;
  expectedStreamVersion: number;
  viewDigest: string;
  label: GovernedReviewLabelValue;
  rationale: string;
  failureCodes: string[];
}): Promise<GovernedTaskSummary> {
  return taskMutation(input.taskId, "labels", {
    expectedStreamVersion: input.expectedStreamVersion,
    viewDigest: input.viewDigest,
    label: input.label,
    rationale: input.rationale,
    failureCodes: input.failureCodes,
    idempotencyKey: governedIdempotencyKey("label")
  });
}

export async function withdrawGovernedLabel(input: {
  taskId: string;
  expectedStreamVersion: number;
  labelId: string;
  reason: string;
}): Promise<GovernedTaskSummary> {
  return taskMutation(input.taskId, "withdraw", {
    expectedStreamVersion: input.expectedStreamVersion,
    labelId: input.labelId,
    reason: input.reason,
    idempotencyKey: governedIdempotencyKey("withdraw")
  });
}

export async function fetchGovernedPostBarrierItem(
  batchId: string,
  itemId: string,
  purpose: "alignment" | "adjudication"
): Promise<GovernedPostBarrierItem> {
  const body = await governedJson(
    `/api/governed-review/batches/${pathId(batchId)}/items/${pathId(itemId)}/${purpose}`
  );
  return normalizePostBarrierItem(record(body.item, "post-barrier item"));
}

export async function appendGovernedAlignmentEvent(input: {
  batchId: string;
  expectedAlignmentVersion: number;
  kind: "comment_recorded" | "instruction_change_proposed" | "closed";
  content: string;
  proposedInstructionVersionId?: string | null;
}): Promise<JsonRecord> {
  const body = await governedJson(
    `/api/governed-review/batches/${pathId(input.batchId)}/alignment/events`,
    jsonMutation({
      expectedAlignmentVersion: input.expectedAlignmentVersion,
      kind: input.kind,
      content: input.content,
      ...(input.proposedInstructionVersionId ? { proposedInstructionVersionId: input.proposedInstructionVersionId } : {}),
      idempotencyKey: governedIdempotencyKey("alignment")
    })
  );
  return record(body.event, "alignment event");
}

export async function appendGovernedAdjudication(input: {
  batchId: string;
  itemId: string;
  expectedHeadAdjudicationId: string | null;
  decision: "pass" | "fail" | "unresolvable";
  rationale: string;
  basis: string;
  correctionReason?: string | null;
}): Promise<JsonRecord> {
  const body = await governedJson(
    `/api/governed-review/batches/${pathId(input.batchId)}/items/${pathId(input.itemId)}/adjudications`,
    jsonMutation({
      expectedHeadAdjudicationId: input.expectedHeadAdjudicationId,
      decision: input.decision,
      rationale: input.rationale,
      basis: input.basis,
      ...(input.correctionReason ? { correctionReason: input.correctionReason } : {}),
      idempotencyKey: governedIdempotencyKey("adjudication")
    })
  );
  return record(body.adjudication, "adjudication");
}

export function assertBlindViewHasNoForbiddenKeys(value: unknown): void {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > 250_000) throw new Error("Blind review response is too structurally complex");
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current as JsonRecord)) {
      if (FORBIDDEN_BLIND_KEYS.has(key.replace(/[-_\s]/g, "").toLowerCase())) {
        throw new Error("Blind review response contains evidence that is not allowed before the barrier");
      }
      stack.push(child);
    }
  }
}

async function taskMutation(taskId: string, action: string, input: JsonRecord): Promise<GovernedTaskSummary> {
  const body = await governedJson(
    `/api/governed-review/tasks/${pathId(taskId)}/${action}`,
    jsonMutation(input)
  );
  return normalizeTask(record(body.task, "governed task"));
}

function normalizeInstruction(value: JsonRecord): GovernedInstructionSummary {
  return {
    instructionVersionId: requiredId(value, ["instructionVersionId", "id"], "instruction version"),
    criterionVersionId: stringField(value, ["criterionVersionId"]),
    title: stringField(value, ["title"]) ?? "Untitled instruction version",
    revision: numberField(value, ["revision"]),
    instructionDigest: stringField(value, ["instructionDigest", "contentDigest", "digest"]),
    createdAt: stringField(value, ["createdAt"])
  };
}

function normalizeBatch(value: JsonRecord): GovernedBatchSummary {
  const selection = optionalRecord(value.selectionPlan) ?? optionalRecord(value.selection) ?? {};
  const coverage = optionalRecord(value.coverage) ?? optionalRecord(value.completeness) ?? {};
  const members = records(value.items ?? value.members).map((member) => ({
    reviewItemId: requiredId(member, ["reviewItemId", "batchItemId", "id"], "governed review item"),
    batchItemId: stringField(member, ["batchItemId"]),
    servePosition: numberField(member, ["servePosition", "drawPosition"]),
    taskIds: stringArray(member.taskIds),
    resolutionKind: stringField(member, ["resolutionKind"]),
    resolvedLabel: referenceLabel(stringField(member, ["resolvedLabel"]))
  }));
  return {
    batchId: requiredId(value, ["batchId", "id"], "governed batch"),
    state: batchState(stringField(value, ["state", "status"])),
    stateVersion: numberField(value, ["stateVersion", "version"]),
    criterionVersionId: stringField(value, ["criterionVersionId"]),
    instructionVersionId: stringField(value, ["instructionVersionId"]),
    instructionDigest: stringField(value, ["instructionDigest"]),
    roleIntent: roleIntent(stringField(value, ["roleIntent"])),
    sourcePopulationKind: sourcePopulationKind(stringField(value, ["sourcePopulationKind"])),
    sourcePopulationId: stringField(value, ["sourcePopulationId"]),
    selectionMethod: selectionMethod(stringField(selection, ["method"]) ?? stringField(value, ["selectionMethod"])),
    populationSize: numberField(selection, ["populationSize"]) ?? numberField(value, ["populationSize"]),
    fixedBudget: numberField(selection, ["fixedBudget"]) ?? numberField(value, ["fixedBudget"]),
    requiredIndependentLabels: numberField(value, ["requiredIndependentLabels", "requiredLabelsPerItem"]),
    itemCount: numberField(value, ["itemCount"]),
    evaluatorBlind: booleanField(value, ["evaluatorBlind"]),
    peerBlindUntilLabelingClosed: booleanField(value, ["peerBlindUntilLabelingClosed"]),
    fixedStopAt: stringField(value, ["fixedStopAt", "stopAt"]),
    batchDigest: stringField(value, ["batchDigest", "contentDigest", "digest"]),
    populationDigest: stringField(value, ["populationDigest"]),
    drawDigest: stringField(value, ["drawDigest"]),
    representativeOfPopulationId: stringField(value, ["representativeOfPopulationId"]),
    representativeReason: stringField(value, ["representativeReason", "representativeClaimReason"]),
    representativeness: normalizeRepresentativeness(optionalRecord(value.representativeness)),
    datasetRevisionId: stringField(value, ["datasetRevisionId"]),
    evidenceClass: stringField(value, ["evidenceClass"]) === "governed_blind" ? "governed_blind" : null,
    coverage: {
      totalTasks: numberField(coverage, ["totalTasks", "requiredTasks"]),
      submittedTasks: numberField(coverage, ["submittedTasks", "activeLabels"]),
      deferredTasks: numberField(coverage, ["deferredTasks"]),
      expiredTasks: numberField(coverage, ["expiredTasks"]),
      resolvedItems: numberField(coverage, ["resolvedItems"]),
      unresolvedItems: numberField(coverage, ["unresolvedItems", "gapItems"]),
      complete: booleanField(coverage, ["complete", "isComplete"])
    },
    members,
    createdAt: stringField(value, ["createdAt"]),
    raw: value
  };
}

function normalizeTask(value: JsonRecord): GovernedTaskSummary {
  return {
    taskId: requiredId(value, ["taskId", "id"], "governed task"),
    batchId: stringField(value, ["batchId"]),
    reviewItemId: stringField(value, ["reviewItemId", "itemId"]),
    criterionName: stringField(value, ["criterionName"]),
    instructionTitle: stringField(value, ["instructionTitle"]),
    state: stringField(value, ["state", "status"]),
    stateVersion: numberField(value, ["stateVersion", "streamVersion", "version"]),
    servePosition: numberField(value, ["servePosition", "serveOrder"]),
    roleIntent: roleIntent(stringField(value, ["roleIntent"])),
    fixedStopAt: stringField(value, ["fixedStopAt", "stopAt"]),
    activeLabelId: stringField(value, ["activeLabelId", "labelId"]),
    raw: value
  };
}

function normalizePostBarrierItem(value: JsonRecord): GovernedPostBarrierItem {
  const role = roleIntent(stringField(value, ["roleIntent"]));
  const labels = records(value.labels ?? value.activeLabels ?? value.independentLabels).map((label) => ({
    labelId: requiredId(label, ["labelId", "id"], "governed label"),
    reviewerSubjectId: stringField(label, ["reviewerSubjectId"]),
    value: labelValue(stringField(label, ["value", "label"])),
    rationale: stringField(label, ["rationale"]),
    failureCodes: stringArray(label.failureCodes),
    active: booleanField(label, ["active"])
  }));
  const resolutionRecord = optionalRecord(value.resolution);
  const criterion = optionalRecord(value.criterion);
  const instruction = optionalRecord(value.instruction);
  const payload = optionalRecord(value.payloadSnapshot);
  const evaluatorRecord = role === "sealed_validation"
    ? null
    : optionalRecord(value.evaluatorEvidence) ?? optionalRecord(value.evaluator);
  return {
    batchId: stringField(value, ["batchId"]),
    reviewItemId: requiredId(value, ["reviewItemId", "batchItemId", "itemId", "id"], "governed review item"),
    criterion: criterion ? {
      criterionVersionId: stringField(criterion, ["criterionVersionId"]),
      name: stringField(criterion, ["name"]) ?? "Criterion",
      definition: stringField(criterion, ["definition"]) ?? "Definition not supplied"
    } : null,
    instruction: instruction ? {
      instructionVersionId: stringField(instruction, ["instructionVersionId"]),
      title: stringField(instruction, ["title"]) ?? "Reviewer instructions",
      instructions: stringField(instruction, ["instructions"]) ?? "Instructions not supplied",
      failureCodeGuidance: stringField(instruction, ["failureCodeGuidance"]) ?? ""
    } : null,
    payloadSnapshot: payload && "input" in payload && "output" in payload ? {
      input: payload.input,
      output: payload.output,
      ...(Array.isArray(payload.steps) ? {
        steps: payload.steps.map((step, index) => {
          const value = record(step, "post-barrier payload step");
          return {
            name: stringField(value, ["name"]) ?? `Step ${index + 1}`,
            input: value.input,
            output: value.output
          };
        })
      } : {})
    } : null,
    roleIntent: role,
    labels,
    resolution: resolutionRecord ? {
      status: stringField(resolutionRecord, ["status"]),
      referenceLabel: referenceLabel(stringField(resolutionRecord, ["referenceLabel", "resolvedLabel"])),
      basis: stringField(resolutionRecord, ["basis", "kind"])
    } : null,
    adjudicationHeadId: stringField(value, ["adjudicationHeadId", "currentAdjudicationId"])
      ?? (resolutionRecord ? stringField(resolutionRecord, ["adjudicationId"]) : null),
    evaluatorEvidence: evaluatorRecord ? {
      label: stringField(evaluatorRecord, ["label", "value"]),
      rationale: stringField(evaluatorRecord, ["rationale", "reasoning"]),
      digest: stringField(evaluatorRecord, ["digest", "evidenceDigest"])
    } : null,
    alignmentVersion: numberField(value, ["alignmentVersion", "alignmentSequence"]),
    raw: value
  };
}

function jsonMutation(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function governedJson(path: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await governedRequest(path, init);
  if (!response.ok) throw await errorFromResponse(response, "Governed review request failed");
  return record(await response.json(), "governed review response");
}

function governedRequest(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const projectId = selectedProjectId();
  if (projectId) headers.set("x-coeval-project", projectId);
  return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
}

async function errorFromResponse(response: Response, fallback: string): Promise<GovernedReviewApiError> {
  const payload = await response.json().catch(() => null) as unknown;
  const body = optionalRecord(payload);
  return new GovernedReviewApiError(
    body ? stringField(body, ["error"]) ?? `${fallback}: ${response.status}` : `${fallback}: ${response.status}`,
    response.status,
    body ? stringField(body, ["code"]) : null,
    body?.details
  );
}

function selectedProjectId(): string | null {
  try {
    return globalThis.localStorage?.getItem(PROJECT_KEY) ?? null;
  } catch {
    return null;
  }
}

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot verify the blind review digest");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function pathId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240) throw new Error("Invalid governed review identity");
  return encodeURIComponent(trimmed);
}

function record(value: unknown, label: string): JsonRecord {
  const result = optionalRecord(value);
  if (!result) throw new Error(`${label} was not an object`);
  return result;
}

function optionalRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map((item) => record(item, "list item")) : [];
}

function stringField(value: JsonRecord, names: string[]): string | null {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function requiredId(value: JsonRecord, names: string[], label: string): string {
  const id = stringField(value, names);
  if (!id) throw new Error(`${label} response omitted its identity`);
  return id;
}

function numberField(value: JsonRecord, names: string[]): number | null {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function booleanField(value: JsonRecord, names: string[]): boolean | null {
  for (const name of names) {
    if (typeof value[name] === "boolean") return value[name];
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function batchState(value: string | null): GovernedBatchState | null {
  return value && [
    "draft", "open", "labeling_closed", "alignment_open", "adjudicating",
    "resolved", "abandoned", "incomplete", "frozen"
  ].includes(value) ? value as GovernedBatchState : null;
}

function roleIntent(value: string | null): GovernedReviewRoleIntent | null {
  return value && ["analysis_authoring", "iterative_development", "sealed_validation"].includes(value)
    ? value as GovernedReviewRoleIntent
    : null;
}

function sourcePopulationKind(
  value: string | null
): "dataset_revision" | "analysis_promotion_handoff" | "sealed_intake" | null {
  return value === "dataset_revision" || value === "analysis_promotion_handoff" || value === "sealed_intake"
    ? value
    : null;
}

function selectionMethod(value: string | null): GovernedReviewSelectionMethod | null {
  return value && [
    "simple_random", "stratified_random", "systematic", "convenience",
    "uncertainty", "failure_hunting", "manual"
  ].includes(value) ? value as GovernedReviewSelectionMethod : null;
}

function labelValue(value: string | null): GovernedReviewLabelValue | null {
  return value === "pass" || value === "fail" || value === "cannot_determine" ? value : null;
}

function referenceLabel(value: string | null): "pass" | "fail" | null {
  return value === "pass" || value === "fail" ? value : null;
}

function normalizeRepresentativeness(value: JsonRecord | null): GovernedBatchSummary["representativeness"] {
  const status = value ? stringField(value, ["status"]) : null;
  return {
    status: status === "not_evaluated" || status === "eligible" || status === "ineligible" ? status : null,
    populationId: value ? stringField(value, ["populationId"]) : null,
    reasons: value ? stringArray(value.reasons) : []
  };
}
