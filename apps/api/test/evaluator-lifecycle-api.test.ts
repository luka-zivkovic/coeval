import { describe, expect, it, vi } from "vitest";
import {
  MinimumVerdictOutputSchema,
  type EvaluatorCandidateCreateResult
} from "@coeval/shared";
import type { EvaluatorLifecycleRepository } from "../src/evaluator-lifecycle/repository.js";
import { createEvaluatorLifecycleRouter } from "../src/evaluator-lifecycle/routes.js";
import { evaluatorCandidateRequestDigest } from "../src/lib/evaluator-lifecycle.js";

function repository(): EvaluatorLifecycleRepository {
  return {
    createCandidate: vi.fn(),
    getLifecycle: vi.fn(),
    listLifecycles: vi.fn(),
    activate: vi.fn(),
    retire: vi.fn(),
    authorizeExecution: vi.fn()
  };
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const CANDIDATE_INPUT = {
  criterionId: "criterion", criterionVersionId: "criterion-version",
  governedBatchId: "batch", expectedBatchDigest: DIGEST,
  truthDatasetRevisionId: "truth", expectedTruthRevisionDigest: DIGEST,
  expectedTruthContentDigest: DIGEST, skillName: "Evaluator",
  skillDescription: "Exact evaluator", rubricMarkdown: "Exact rubric",
  prompt: "Judge the response.", modelBinding: {
    provider: "mock" as const, modelId: "mock", modelVersion: "v1", temperature: 0
  }, outputSchema: MinimumVerdictOutputSchema, idempotencyKey: "candidate-key"
};

function candidateResult(replayed: boolean): EvaluatorCandidateCreateResult {
  const version = {
    id: "skill-version", skillId: "skill", criterionVersionId: "criterion-version",
    version: "1.0.0", status: "calibrating" as const, rubricMarkdown: "Exact rubric",
    prompt: "Judge the response.", modelBinding: {
      provider: "mock" as const, modelId: "mock", modelVersion: "v1", temperature: 0
    }, outputSchema: MinimumVerdictOutputSchema, goldenSetAgreement: null,
    tooStrictCount: 0, tooLenientCount: 0, ambiguousCount: 0, knownLimitations: [],
    verdictKind: "binary" as const, scalarRange: null, categoricalChoiceScores: null,
    rubricProvenance: "human-authored" as const, regressionDatasetRevisionId: "regression",
    createdAt: "2026-08-24T00:00:00.000Z", approvedAt: null
  };
  const lifecycle = {
    id: "lifecycle", contractVersion: "coeval/evaluator-lifecycle/v1" as const,
    projectId: "project", criterionId: "criterion", criterionVersionId: "criterion-version",
    skillId: "skill", skillVersionId: "skill-version", promotionId: "promotion",
    governedBatchId: "batch", governedBatchDigest: DIGEST,
    truthDatasetRevisionId: "truth", truthRevisionDigest: DIGEST, truthContentDigest: DIGEST,
    truthItemCount: 1, regressionDatasetRevisionId: "regression",
    regressionRevisionDigest: DIGEST, regressionContentDigest: DIGEST, regressionItemCount: 1,
    developerExposureEventId: "exposure", createdByUserId: "owner",
    createdBySubjectId: "subject", idempotencyKey: "candidate-key",
    requestDigest: evaluatorCandidateRequestDigest("project", CANDIDATE_INPUT),
    contentDigest: DIGEST, createdAt: "2026-08-24T00:00:00.000Z"
  };
  return {
    skill: {
      id: "skill", projectId: "project", criterionId: "criterion", name: "Evaluator",
      description: "Exact evaluator", ownerName: "Owner", status: "calibrating", isStarter: false,
      currentVersion: version
    },
    projection: {
      lifecycle,
      currentEvent: {
        id: "event", contractVersion: "coeval/evaluator-lifecycle-event/v1", lifecycleId: "lifecycle",
        projectId: "project", criterionId: "criterion", skillVersionId: "skill-version",
        sequence: "1", transition: "candidate_created", state: "candidate",
        predecessorEventId: null, predecessorEventDigest: null, activationBundleId: null,
        activationEvidence: null, replacedSkillVersionId: null, actorUserId: "owner",
        actorSubjectId: "subject", actorRole: "owner",
        reason: "Candidate created from exact frozen governed nonsealed truth.",
        idempotencyKey: "candidate-created:lifecycle", requestDigest: DIGEST, contentDigest: DIGEST,
        occurredAt: "2026-08-24T00:00:00.000Z"
      },
      currentCalibrationAdmissibility: "not_applicable",
      implicitExecutionAllowed: false,
      implicitDenialReasons: ["not_active"]
    },
    replayed
  };
}

describe("evaluator lifecycle API boundary", () => {
  it("requires a database-backed project-member session", async () => {
    const repo = repository();
    const demo = createEvaluatorLifecycleRouter({
      repository: null,
      databaseMode: false,
      requestIdentity: () => ({ userId: null, projectId: "project" }),
      resolveProjectRole: async () => null
    });
    expect((await demo.request("/candidates", { method: "POST", body: "{}" })).status).toBe(501);

    const apiKey = createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: null, projectId: "project", apiKeyId: "key" }),
      resolveProjectRole: async () => "owner"
    });
    expect((await apiKey.request("/candidates", { method: "POST", body: "{}" })).status).toBe(401);
    expect(repo.createCandidate).not.toHaveBeenCalled();
  });

  it("keeps lifecycle writes owner-only while members may read", async () => {
    const repo = repository();
    vi.mocked(repo.listLifecycles).mockResolvedValue({ items: [], nextCursor: null, totalCount: "0" });
    const member = createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: "member", projectId: "project" }),
      resolveProjectRole: async () => "member"
    });
    expect((await member.request("/candidates", { method: "POST", body: "{}" })).status).toBe(403);
    const read = await member.request("/");
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      page: { items: [], nextCursor: null, totalCount: "0" },
      projectRole: "member"
    });
  });

  it("rejects unknown candidate fields before repository access", async () => {
    const repo = repository();
    const owner = createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: "owner", projectId: "project" }),
      resolveProjectRole: async () => "owner"
    });
    const response = await owner.request("/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callerControlledState: "active" })
    });
    expect(response.status).toBe(400);
    expect(repo.createCandidate).not.toHaveBeenCalled();
  });

  it("rejects candidate sampling values outside the current runtime contract", async () => {
    const repo = repository();
    const owner = createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: "owner", projectId: "project" }),
      resolveProjectRole: async () => "owner"
    });
    const response = await owner.request("/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...CANDIDATE_INPUT,
        modelBinding: { ...CANDIDATE_INPUT.modelBinding, provider: "Anthropic", temperature: 3 }
      })
    });
    expect(response.status).toBe(400);
    expect(repo.createCandidate).not.toHaveBeenCalled();
  });

  it("normalizes candidate provider identifiers before repository writes", async () => {
    const repo = repository();
    vi.mocked(repo.createCandidate).mockResolvedValue(candidateResult(false));
    const owner = createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: "owner", projectId: "project" }),
      resolveProjectRole: async () => "owner"
    });
    const response = await owner.request("/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...CANDIDATE_INPUT,
        modelBinding: { ...CANDIDATE_INPUT.modelBinding, provider: " Mock " }
      })
    });
    expect(response.status).toBe(201);
    expect(repo.createCandidate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelBinding: expect.objectContaining({ provider: "mock" }) })
    );
  });

  it("retries regression dispatch after an exact committed candidate replay", async () => {
    const repo = repository();
    vi.mocked(repo.createCandidate).mockResolvedValue(candidateResult(true));
    const enqueueRegression = vi.fn(async () => undefined);
    const owner = createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: "owner", projectId: "project" }),
      resolveProjectRole: async () => "owner",
      enqueueRegression
    });
    const response = await owner.request("/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CANDIDATE_INPUT)
    });
    expect(response.status).toBe(200);
    expect(enqueueRegression).toHaveBeenCalledWith({
      projectId: "project", skillVersionId: "skill-version",
      datasetRevisionId: "regression", actorUserId: "owner"
    });
  });
});
