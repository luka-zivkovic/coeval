import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/lib/assessment-receipt.js";
import {
  GovernedReviewIdempotencyConflictError,
  GovernedReviewNotFoundError,
  GovernedReviewStreamConflictError,
  assertBlindProjectionSafe,
  createGovernedReviewRouter,
  executeGovernedReviewSelection,
  type AppendGovernedReviewAdjudicationInput,
  type AppendGovernedReviewAlignmentEventInput,
  type CreateGovernedReviewBatchInput,
  type CreateImportedTruthInput,
  type CreateGovernedReviewInstructionInput,
  type CreateSealedReviewIntakeInput,
  type GovernedAdjudicationProjection,
  type GovernedAlignmentEventProjection,
  type GovernedBatchAction,
  type GovernedBlindTaskViewArtifact,
  type GovernedPostBarrierItemProjection,
  type GovernedReviewActor,
  type GovernedReviewBatchProjection,
  type GovernedReviewInstructionProjection,
  type GovernedReviewListQuery,
  type GovernedReviewRepository,
  type GovernedReviewStreamCommand,
  type GovernedReviewerTaskProjection,
  type GovernedReviewSubjectProjection,
  type GovernedSealedIntakeReceipt,
  type GovernedTaskMutationProjection,
  type ImportedTruthListQuery,
  type ImportedTruthProjection,
  type GovernedTaskAction
} from "../src/governed-review/index.js";

const PROJECT_ID = "project_governed";
const OWNER_HEADERS = { "x-test-user": "user_owner", "x-test-project": PROJECT_ID };
const MEMBER_HEADERS = { "x-test-user": "user_member", "x-test-project": PROJECT_ID };
const OTHER_HEADERS = { "x-test-user": "user_other", "x-test-project": PROJECT_ID };
const JSON_HEADERS = { "content-type": "application/json" };

const VIEW = {
  contract: "coeval/governed-blind-task-view/v1",
  schemaVersion: 1,
  canonicalizationVersion: "coeval-canonical-json/v1",
  taskId: "task_member",
  batchId: "batch_1",
  servePosition: 0,
  criterion: {
    criterionId: "criterion_1",
    criterionVersionId: "criterion_version_1",
    name: "Groundedness",
    definition: "The answer must be supported by the supplied evidence.",
    criterionDigest: `sha256:${"1".repeat(64)}`
  },
  instruction: {
    instructionVersionId: "instruction_1",
    title: "Review groundedness",
    instructions: "Review the complete response against groundedness.",
    failureCodeGuidance: "Record short open failure codes.",
    allowedLabels: ["pass", "fail", "cannot_determine"] as const,
    instructionDigest: `sha256:${"2".repeat(64)}`
  },
  payloadSnapshot: {
    input: { question: "What does the policy say?" },
    output: { answer: "The supplied policy permits refunds within 30 days." }
  }
};

const VIEW_BYTES = Buffer.from(canonicalJson(VIEW), "utf8");
const VIEW_DIGEST = `sha256:${createHash("sha256").update(VIEW_BYTES).digest("hex")}`;

const INSTRUCTION_INPUT = {
  criterionVersionId: "criterion_version_1",
  title: "Review groundedness",
  instructions: "Use only the supplied trace evidence.",
  failureCodeGuidance: "Record short open codes.",
  idempotencyKey: "instruction-1"
};

const BATCH_INPUT = {
  instructionVersionId: "instruction_1",
  roleIntent: "analysis_authoring",
  source: { kind: "dataset_revision", revisionId: "revision_1" },
  selection: { method: "simple_random", fixedBudget: 1 },
  reviewerUserIds: ["user_member"],
  fixedStopAt: "2030-01-01T00:00:00.000Z",
  idempotencyKey: "batch-1"
};

const CREATED_AT = "2026-08-23T00:00:00.000Z";

function instructionProjection(): GovernedReviewInstructionProjection {
  return {
    instructionVersionId: "instruction_1",
    criterionVersionId: "criterion_version_1",
    revision: 1,
    predecessorInstructionVersionId: null,
    title: "Review groundedness",
    instructions: "Use only the supplied trace evidence.",
    failureCodeGuidance: "Record short open codes.",
    allowedLabels: ["pass", "fail", "cannot_determine"],
    instructionDigest: `sha256:${"2".repeat(64)}`,
    createdAt: CREATED_AT
  };
}

function batchProjection(state: GovernedReviewBatchProjection["state"] = "open"): GovernedReviewBatchProjection {
  const barrierCrossed = state !== "draft" && state !== "open";
  return {
    batchId: "batch_1",
    criterionVersionId: "criterion_version_1",
    instructionVersionId: "instruction_1",
    roleIntent: "analysis_authoring",
    sourcePopulationKind: "dataset_revision",
    sourcePopulationId: "revision_1",
    evaluatorBlind: true,
    peerBlindUntilLabelingClosed: true,
    selectionMethod: "simple_random",
    batchDigest: `sha256:${"3".repeat(64)}`,
    populationDigest: `sha256:${"4".repeat(64)}`,
    drawDigest: `sha256:${"5".repeat(64)}`,
    fixedBudget: 1,
    requiredIndependentLabels: 1,
    state,
    stateVersion: state === "draft" ? 0 : 1,
    fixedStopAt: "2030-01-01T00:00:00.000Z",
    itemCount: 1,
    items: [{
      batchItemId: "item_1",
      servePosition: 0,
      resolutionKind: barrierCrossed ? "single_rater" : null,
      resolvedLabel: barrierCrossed ? "pass" : null
    }],
    completeness: state === "draft" || state === "open"
      ? null
      : { totalTasks: 1, submittedTasks: 1, deferredTasks: 0, expiredTasks: 0, pendingTasks: 0 },
    representativeness: { status: "not_evaluated", populationId: null, reasons: [] },
    datasetRevisionId: null,
    evidenceClass: null,
    createdAt: CREATED_AT
  };
}

function importedTruthProjection(): ImportedTruthProjection {
  return {
    importedTruthId: "imported_truth_1",
    criterionVersionId: "criterion_version_1",
    issuer: "External review service",
    subject: "trace-42",
    sourceArtifactDigest: `sha256:${"6".repeat(64)}`,
    sourceArtifactBytes: 42,
    verificationMethod: "self_attested",
    evidenceClass: "imported_self_attested",
    inputDigest: `sha256:${"7".repeat(64)}`,
    label: "pass",
    rationale: "The external artifact records a supported answer.",
    failureCodes: [],
    provenanceDigest: `sha256:${"8".repeat(64)}`,
    contentDigest: `sha256:${"9".repeat(64)}`,
    importedAt: CREATED_AT
  };
}

class FakeGovernedReviewRepository implements GovernedReviewRepository {
  readonly calls: Array<{ method: string; actor: GovernedReviewActor; input?: unknown }> = [];
  view: GovernedBlindTaskViewArtifact = { canonicalBytes: VIEW_BYTES, viewDigest: VIEW_DIGEST };

  async listInstructions(actor: GovernedReviewActor, criterionVersionId?: string): Promise<GovernedReviewInstructionProjection[]> {
    this.record("listInstructions", actor, criterionVersionId);
    return [{ ...instructionProjection(), criterionVersionId: criterionVersionId ?? "criterion_version_1" }];
  }
  async createInstruction(actor: GovernedReviewActor, input: CreateGovernedReviewInstructionInput): Promise<GovernedReviewInstructionProjection> {
    this.record("createInstruction", actor, input);
    return instructionProjection();
  }
  async listAssignableSubjects(actor: GovernedReviewActor): Promise<GovernedReviewSubjectProjection[]> {
    this.record("listAssignableSubjects", actor);
    return [{ subjectId: "subject_member", userId: "user_member", name: "Member", email: null, projectRole: "member" }];
  }
  async createSealedIntake(actor: GovernedReviewActor, input: CreateSealedReviewIntakeInput): Promise<GovernedSealedIntakeReceipt> {
    this.record("createSealedIntake", actor, input);
    return {
      intakeId: "intake_1",
      protection: "sealed",
      populationDefinition: input.populationDefinition,
      itemCount: input.items.length,
      frameDigest: `sha256:${"a".repeat(64)}`,
      predecessorRevisionId: input.predecessorRevisionId ?? null,
      createdAt: CREATED_AT
    };
  }
  async createBatchDraft(actor: GovernedReviewActor, input: CreateGovernedReviewBatchInput): Promise<GovernedReviewBatchProjection> {
    this.record("createBatchDraft", actor, input);
    return batchProjection("draft");
  }
  async listBatches(actor: GovernedReviewActor, query: GovernedReviewListQuery): Promise<GovernedReviewBatchProjection[]> {
    this.record("listBatches", actor, query);
    return [batchProjection()];
  }
  async getBatchSummary(actor: GovernedReviewActor, batchId: string): Promise<GovernedReviewBatchProjection> {
    this.record("getBatchSummary", actor, batchId);
    return { ...batchProjection(), batchId };
  }
  async transitionBatch(
    actor: GovernedReviewActor,
    batchId: string,
    action: GovernedBatchAction,
    command: GovernedReviewStreamCommand
  ): Promise<GovernedReviewBatchProjection> {
    this.record("transitionBatch", actor, { batchId, action, command });
    if (command.idempotencyKey === "stream-conflict") {
      throw new GovernedReviewStreamConflictError({ currentState: "labeling_closed", currentVersion: 4 });
    }
    if (command.idempotencyKey === "idempotency-conflict") {
      throw new GovernedReviewIdempotencyConflictError();
    }
    return { ...batchProjection(action === "open" ? "open" : action === "freeze" ? "frozen" : "labeling_closed"), batchId };
  }
  async listReviewerTasks(actor: GovernedReviewActor): Promise<GovernedReviewerTaskProjection[]> {
    this.record("listReviewerTasks", actor);
    return [{
      taskId: "task_member", batchId: "batch_1", criterionVersionId: "criterion_version_1",
      instructionVersionId: "instruction_1", criterionName: "Groundedness",
      instructionTitle: "Review groundedness", state: "assigned", stateVersion: 0,
      servePosition: 0, fixedStopAt: "2030-01-01T00:00:00.000Z", activeLabelId: null
    }];
  }
  async getOrCreateBlindTaskView(actor: GovernedReviewActor, taskId: string): Promise<GovernedBlindTaskViewArtifact> {
    this.record("getOrCreateBlindTaskView", actor, taskId);
    if (taskId !== "task_member" || actor.userId !== "user_member") throw new GovernedReviewNotFoundError();
    return this.view;
  }
  async appendTaskAction(
    actor: GovernedReviewActor,
    taskId: string,
    action: GovernedTaskAction
  ): Promise<GovernedTaskMutationProjection> {
    this.record("appendTaskAction", actor, { taskId, action });
    if (taskId !== "task_member" || actor.userId !== "user_member") throw new GovernedReviewNotFoundError();
    return {
      taskId,
      state: action.kind === "submit_label" ? "submitted" : action.kind === "withdraw_label" ? "withdrawn" : action.kind === "resume" ? "viewed" : "deferred",
      stateVersion: action.input.expectedStreamVersion + 1,
      activeLabelId: action.kind === "submit_label" ? "label_1" : null
    };
  }
  async getPostBarrierItemView(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    purpose: "alignment" | "adjudication"
  ): Promise<GovernedPostBarrierItemProjection> {
    this.record("getPostBarrierItemView", actor, { batchId, itemId, purpose });
    return {
      batchId, batchItemId: itemId, alignmentVersion: 0,
      criterion: { criterionVersionId: "criterion_version_1", name: "Groundedness", definition: "Supported by evidence." },
      instruction: { instructionVersionId: "instruction_1", title: "Review", instructions: "Review it.", failureCodeGuidance: "Use short codes." },
      payloadSnapshot: { input: { q: "Refund?" }, output: { a: "30 days" } },
      activeLabels: [],
      resolution: { kind: "coverage_gap", resolvedLabel: null, adjudicationId: null }
    };
  }
  async appendAlignmentEvent(
    actor: GovernedReviewActor,
    batchId: string,
    input: AppendGovernedReviewAlignmentEventInput
  ): Promise<GovernedAlignmentEventProjection> {
    this.record("appendAlignmentEvent", actor, { batchId, input });
    return {
      alignmentEventId: "alignment_event_1", batchId, sequence: input.expectedAlignmentVersion + 1,
      kind: input.kind, content: input.content,
      proposedInstructionVersionId: input.proposedInstructionVersionId ?? null,
      visibleLabelCount: 0, occurredAt: CREATED_AT
    };
  }
  async appendAdjudication(
    actor: GovernedReviewActor,
    batchId: string,
    itemId: string,
    input: AppendGovernedReviewAdjudicationInput
  ): Promise<GovernedAdjudicationProjection> {
    this.record("appendAdjudication", actor, { batchId, itemId, input });
    return {
      adjudicationId: "adjudication_1", batchId, batchItemId: itemId, chainVersion: 1,
      predecessorAdjudicationId: input.expectedHeadAdjudicationId, decision: input.decision,
      rationale: input.rationale, basis: input.basis, correctionReason: input.correctionReason ?? null,
      consideredLabelIds: [], createdAt: CREATED_AT
    };
  }
  async createImportedTruth(actor: GovernedReviewActor, input: CreateImportedTruthInput): Promise<ImportedTruthProjection> {
    this.record("createImportedTruth", actor, input);
    return importedTruthProjection();
  }
  async listImportedTruth(actor: GovernedReviewActor, query: ImportedTruthListQuery): Promise<ImportedTruthProjection[]> {
    this.record("listImportedTruth", actor, query);
    return [importedTruthProjection()];
  }

  private record(method: string, actor: GovernedReviewActor, input?: unknown): void {
    this.calls.push({ method, actor, input });
  }
}

function testApp(input: {
  repository?: FakeGovernedReviewRepository | null;
  authMode?: boolean;
  roleFor?: (userId: string) => "owner" | "member" | null;
} = {}) {
  const repository = input.repository === undefined ? new FakeGovernedReviewRepository() : input.repository;
  const app = new Hono();
  app.route("/api/governed-review", createGovernedReviewRouter({
    repository,
    authMode: input.authMode ?? true,
    requestIdentity: (c) => ({
      userId: c.req.header("x-test-user") ?? null,
      projectId: c.req.header("x-test-project") ?? "",
      ...(c.req.header("authorization") ? { apiKeyId: "api-key-only" } : {})
    }),
    resolveProjectRole: async ({ userId }) => input.roleFor
      ? input.roleFor(userId)
      : userId === "user_owner" ? "owner" : userId === "user_member" || userId === "user_other" ? "member" : null
  }));
  return { app, repository };
}

function jsonRequest(method: string, body: unknown, headers = OWNER_HEADERS): RequestInit {
  return {
    method,
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body)
  };
}

describe("governed review session-only API", () => {
  it("requires database-backed auth and never falls back to demo or API-key access", async () => {
    const unavailable = testApp({ repository: null, authMode: false }).app;
    const demoResponse = await unavailable.request("/api/governed-review/tasks", { headers: MEMBER_HEADERS });
    expect(demoResponse.status).toBe(501);
    await expect(demoResponse.json()).resolves.toMatchObject({ code: "governed_review_requires_auth" });
    expect(demoResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(demoResponse.headers.get("vary")).toContain("Cookie");

    const authenticated = testApp().app;
    const apiKeyOnly = await authenticated.request("/api/governed-review/tasks", {
      headers: { authorization: "Bearer coeval_sk_not_a_session", "x-test-project": PROJECT_ID }
    });
    expect(apiKeyOnly.status).toBe(401);
    await expect(apiKeyOnly.json()).resolves.toMatchObject({ code: "governed_review_session_required" });

    const outsider = testApp({ roleFor: () => null }).app;
    const denied = await outsider.request("/api/governed-review/tasks", { headers: OTHER_HEADERS });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: "governed_review_project_forbidden" });
  });

  it("enforces owner control-plane gates while allowing member review and custodian intake", async () => {
    const { app, repository } = testApp();
    for (const [path, body] of [
      ["/api/governed-review/instructions", INSTRUCTION_INPUT],
      ["/api/governed-review/batches", BATCH_INPUT],
      ["/api/governed-review/batches/batch_1/open", { expectedStateVersion: 0, idempotencyKey: "open-1" }],
      ["/api/governed-review/batches/batch_1/close-labeling", { expectedStateVersion: 1, idempotencyKey: "close-1" }],
      ["/api/governed-review/batches/batch_1/alignment/open", { expectedStateVersion: 2, idempotencyKey: "align-open-1" }],
      ["/api/governed-review/batches/batch_1/adjudication/start", { expectedStateVersion: 3, idempotencyKey: "adjudicate-1" }],
      ["/api/governed-review/batches/batch_1/finalize", { expectedStateVersion: 4, idempotencyKey: "finalize-1" }],
      ["/api/governed-review/batches/batch_1/freeze", { expectedStateVersion: 5, idempotencyKey: "freeze-1" }],
      ["/api/governed-review/batches/batch_1/alignment/events", {
        expectedAlignmentVersion: 0,
        kind: "comment_recorded",
        content: "A member must not reveal labels by opening alignment.",
        idempotencyKey: "alignment-member-1"
      }],
      ["/api/governed-review/batches/batch_1/items/item_1/adjudications", {
        expectedHeadAdjudicationId: null,
        decision: "pass",
        rationale: "A member must not adjudicate.",
        basis: "Denied before repository dispatch.",
        idempotencyKey: "adjudication-member-1"
      }]
    ] as const) {
      const response = await app.request(path, jsonRequest("POST", body, MEMBER_HEADERS));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "governed_review_owner_required" });
    }

    const subjects = await app.request("/api/governed-review/subjects", { headers: MEMBER_HEADERS });
    expect(subjects.status).toBe(403);

    const intake = await app.request("/api/governed-review/sealed-intakes", jsonRequest("POST", {
      populationDefinition: "Complete finite support-policy corpus",
      items: [{ clientItemId: "sealed-1", input: { q: "Refund?" }, output: { a: "30 days" } }],
      idempotencyKey: "intake-1"
    }, MEMBER_HEADERS));
    expect(intake.status).toBe(201);
    expect(repository!.calls.at(-1)).toMatchObject({ method: "createSealedIntake", actor: { projectRole: "member" } });

    const taskList = await app.request("/api/governed-review/tasks", { headers: MEMBER_HEADERS });
    expect(taskList.status).toBe(200);
  });

  it("withholds peer progress and resolution evidence from pre-barrier list/detail projections", async () => {
    const { app } = testApp();
    const list = await app.request("/api/governed-review/batches", { headers: MEMBER_HEADERS });
    const detail = await app.request("/api/governed-review/batches/batch_1", { headers: MEMBER_HEADERS });
    const tasks = await app.request("/api/governed-review/tasks", { headers: MEMBER_HEADERS });
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(tasks.status).toBe(200);
    for (const response of [list, detail]) {
      const text = await response.text();
      expect(text).toContain('"completeness":null');
      expect(text).toContain('"resolutionKind":null');
      expect(text).toContain('"resolvedLabel":null');
      expect(text).not.toContain("submittedTasks");
    }
    const taskBody = await tasks.text();
    expect(taskBody).not.toContain("reviewerUserId");
    expect(taskBody).not.toContain("peer");
  });

  it("owner-gates immutable imported truth and exposes only server-derived evidence class", async () => {
    const { app, repository } = testApp();
    const input = {
      criterionVersionId: "criterion_version_1",
      issuer: "External review service",
      subject: "trace-42",
      sourceArtifact: { signedEnvelope: "opaque" },
      transportProvenance: { channel: "manual upload" },
      verificationMethod: "self_attested",
      instructionsProvenance: { digest: `sha256:${"b".repeat(64)}` },
      raterProvenance: { raters: ["external-rater"] },
      adjudicationProvenance: { method: "single-rater" },
      blindAttestation: { evaluatorBlind: true },
      payloadSnapshot: { input: { q: "Refund?" }, output: { a: "30 days" } },
      label: "pass",
      rationale: "The source artifact records a supported answer.",
      failureCodes: [],
      idempotencyKey: "import-1"
    };
    const denied = await app.request("/api/governed-review/imported-truth", jsonRequest("POST", input, MEMBER_HEADERS));
    expect(denied.status).toBe(403);

    const created = await app.request("/api/governed-review/imported-truth", jsonRequest("POST", input));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      importedTruth: { evidenceClass: "imported_self_attested", verificationMethod: "self_attested" }
    });
    const listed = await app.request(
      "/api/governed-review/imported-truth?evidenceClass=imported_self_attested",
      { headers: OWNER_HEADERS }
    );
    expect(listed.status).toBe(200);
    expect(repository!.calls.at(-1)).toMatchObject({
      method: "listImportedTruth",
      input: { evidenceClass: "imported_self_attested" }
    });
  });

  it("dispatches bounded strict owner contracts without accepting caller seeds or digests", async () => {
    const { app, repository } = testApp();
    expect((await app.request("/api/governed-review/instructions", jsonRequest("POST", INSTRUCTION_INPUT))).status).toBe(201);
    expect((await app.request("/api/governed-review/batches", jsonRequest("POST", BATCH_INPUT))).status).toBe(201);

    const injected = await app.request("/api/governed-review/batches", jsonRequest("POST", {
      ...BATCH_INPUT,
      selection: { ...BATCH_INPUT.selection, seed: "caller-controlled" }
    }));
    expect(injected.status).toBe(400);
    await expect(injected.json()).resolves.toMatchObject({ code: "invalid_governed_review_request" });

    const intakeMetadata = await app.request("/api/governed-review/sealed-intakes", jsonRequest("POST", {
      populationDefinition: "Complete finite support-policy corpus",
      items: [{
        clientItemId: "sealed-with-metadata",
        input: { q: "Refund?" },
        output: { a: "30 days" },
        metadata: { expectedLabel: "pass" }
      }],
      idempotencyKey: "intake-metadata"
    }));
    expect(intakeMetadata.status).toBe(400);
    await expect(intakeMetadata.json()).resolves.toMatchObject({ code: "invalid_governed_review_request" });

    expect(repository!.calls.map((call) => call.method)).toEqual(["createInstruction", "createBatchDraft"]);
  });

  it("returns a cross-user task lookup as 404", async () => {
    const { app } = testApp();
    const response = await app.request("/api/governed-review/tasks/task_member/view", { headers: OTHER_HEADERS });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "governed_review_not_found" });
  });

  it("serves repeated exact canonical bytes with the non-circular exposed digest header", async () => {
    const { app, repository } = testApp();
    const first = await app.request("/api/governed-review/tasks/task_member/view", { headers: MEMBER_HEADERS });
    const second = await app.request("/api/governed-review/tasks/task_member/view", { headers: MEMBER_HEADERS });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const secondBytes = Buffer.from(await second.arrayBuffer());
    expect(firstBytes.equals(VIEW_BYTES)).toBe(true);
    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(first.headers.get("x-coeval-view-digest")).toBe(VIEW_DIGEST);
    expect(first.headers.get("access-control-expose-headers")).toContain("X-Coeval-View-Digest");
    expect(JSON.parse(firstBytes.toString("utf8"))).not.toHaveProperty("viewDigest");
    expect(repository!.calls.filter((call) => call.method === "getOrCreateBlindTaskView")).toHaveLength(2);
  });

  it("fails closed when a stored blind projection contains recursive leak canaries", async () => {
    const repository = new FakeGovernedReviewRepository();
    const unsafe = {
      ...VIEW,
      payloadSnapshot: {
        ...VIEW.payloadSnapshot,
        output: { answer: "30 days", nested: { expected_label: "pass" } }
      }
    };
    const bytes = Buffer.from(canonicalJson(unsafe), "utf8");
    repository.view = {
      canonicalBytes: bytes,
      viewDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    };
    const { app } = testApp({ repository });
    const response = await app.request("/api/governed-review/tasks/task_member/view", { headers: MEMBER_HEADERS });
    expect(response.status).toBe(500);
    const body = await response.json() as { code: string; error: string };
    expect(body.code).toBe("governed_review_integrity_error");
    expect(body.error).not.toContain("expected_label");
  });

  it("dispatches defer, resume, submit, and withdraw as distinct append-only task actions", async () => {
    const { app, repository } = testApp();
    const actions = [
      ["defer", { expectedStreamVersion: 1, reason: "Need policy context", idempotencyKey: "defer-1" }],
      ["resume", { expectedStreamVersion: 2, reason: null, idempotencyKey: "resume-1" }],
      ["labels", {
        expectedStreamVersion: 3,
        viewDigest: VIEW_DIGEST,
        label: "cannot_determine",
        rationale: "The supplied evidence is insufficient.",
        failureCodes: ["missing_policy_context"],
        idempotencyKey: "label-1"
      }],
      ["withdraw", {
        expectedStreamVersion: 4,
        labelId: "label_1",
        reason: "I found relevant context in the frozen view.",
        idempotencyKey: "withdraw-1"
      }]
    ] as const;
    for (const [path, body] of actions) {
      const response = await app.request(
        `/api/governed-review/tasks/task_member/${path}`,
        jsonRequest("POST", body, MEMBER_HEADERS)
      );
      expect(response.status).toBe(path === "labels" ? 201 : 200);
    }
    const kinds = repository!.calls
      .filter((call) => call.method === "appendTaskAction")
      .map((call) => (call.input as { action: { kind: string } }).action.kind);
    expect(kinds).toEqual(["defer", "resume", "submit_label", "withdraw_label"]);
  });

  it("dispatches barrier, alignment, adjudication, finalize, and freeze without caller-derived truth", async () => {
    const { app, repository } = testApp();
    const transitions = [
      ["close-labeling", "close_labeling"],
      ["alignment/open", "open_alignment"],
      ["adjudication/start", "start_adjudication"],
      ["finalize", "finalize"],
      ["freeze", "freeze"]
    ] as const;
    for (const [path] of transitions) {
      const response = await app.request(
        `/api/governed-review/batches/batch_1/${path}`,
        jsonRequest("POST", { expectedStateVersion: 1, idempotencyKey: `action-${path}` })
      );
      expect(response.status).toBe(200);
    }

    expect((await app.request(
      "/api/governed-review/batches/batch_1/items/item_1/alignment",
      { headers: MEMBER_HEADERS }
    )).status).toBe(200);
    expect((await app.request(
      "/api/governed-review/batches/batch_1/alignment/events",
      jsonRequest("POST", {
        expectedAlignmentVersion: 0,
        kind: "instruction_change_proposed",
        content: "Clarify how missing evidence maps to cannot_determine.",
        proposedInstructionVersionId: "instruction_2",
        idempotencyKey: "alignment-1"
      })
    )).status).toBe(201);
    expect((await app.request(
      "/api/governed-review/batches/batch_1/items/item_1/adjudications",
      jsonRequest("POST", {
        expectedHeadAdjudicationId: null,
        decision: "unresolvable",
        rationale: "The frozen trace lacks the decisive policy text.",
        basis: "Complete independent label set at the barrier.",
        idempotencyKey: "adjudication-1"
      })
    )).status).toBe(201);

    const dispatched = repository!.calls
      .filter((call) => call.method === "transitionBatch")
      .map((call) => (call.input as { action: string }).action);
    expect(dispatched).toEqual(transitions.map(([, action]) => action));
  });

  it("maps named stream and idempotency conflicts without losing current state evidence", async () => {
    const { app } = testApp();
    const stream = await app.request(
      "/api/governed-review/batches/batch_1/close-labeling",
      jsonRequest("POST", { expectedStateVersion: 1, idempotencyKey: "stream-conflict" })
    );
    expect(stream.status).toBe(409);
    await expect(stream.json()).resolves.toMatchObject({
      code: "governed_review_stream_conflict",
      details: { currentState: "labeling_closed", currentVersion: 4 }
    });

    const idempotency = await app.request(
      "/api/governed-review/batches/batch_1/finalize",
      jsonRequest("POST", { expectedStateVersion: 4, idempotencyKey: "idempotency-conflict" })
    );
    expect(idempotency.status).toBe(409);
    await expect(idempotency.json()).resolves.toMatchObject({ code: "governed_review_idempotency_conflict" });
  });
});

describe("governed review selection and projection helpers", () => {
  const frame = Array.from({ length: 8 }, (_, index) => ({
    id: `item_${index}`,
    digest: `sha256:${index.toString(16).padStart(64, "0")}`
  }));

  it("executes deterministic server-seeded simple, systematic, and stratified draws", () => {
    const simpleA = executeGovernedReviewSelection({
      frame,
      selection: { method: "simple_random", fixedBudget: 3 },
      seed: "fixed-test-seed"
    });
    const simpleB = executeGovernedReviewSelection({
      frame: [...frame].reverse(),
      selection: { method: "simple_random", fixedBudget: 3 },
      seed: "fixed-test-seed"
    });
    expect(simpleA).toEqual(simpleB);
    expect(simpleA.selected).toHaveLength(3);

    const systematic = executeGovernedReviewSelection({
      frame,
      selection: { method: "systematic", fixedBudget: 4 },
      seed: "fixed-test-seed"
    });
    expect(new Set(systematic.selected.map((item) => item.id)).size).toBe(4);

    const stratified = executeGovernedReviewSelection({
      frame,
      selection: {
        method: "stratified_random",
        strata: [
          { key: "a", definition: "First half", sourceItemIds: frame.slice(0, 4).map((item) => item.id), fixedBudget: 2 },
          { key: "b", definition: "Second half", sourceItemIds: frame.slice(4).map((item) => item.id), fixedBudget: 2 }
        ]
      },
      seed: "fixed-test-seed"
    });
    expect(stratified.selected).toHaveLength(4);
    expect(stratified.strata.map((stratum) => stratum.key)).toEqual(["a", "b"]);
  });

  it("rejects incomplete strata, foreign directed selections, and recursive leak keys", () => {
    expect(() => executeGovernedReviewSelection({
      frame,
      selection: {
        method: "stratified_random",
        strata: [{ key: "partial", definition: "Not a partition", sourceItemIds: ["item_0"], fixedBudget: 1 }]
      },
      seed: "fixed-test-seed"
    })).toThrow(/partition/);
    expect(() => executeGovernedReviewSelection({
      frame,
      selection: { method: "manual", selectedSourceItemIds: ["foreign"] }
    })).toThrow(/not in the frozen frame/);
    expect(() => assertBlindProjectionSafe({ output: { nested: { raw_judge_call: {} } } })).toThrow(/forbidden key/);
  });
});
