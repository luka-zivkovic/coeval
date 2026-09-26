import { describe, expect, it, vi } from "vitest";
import {
  MinimumVerdictOutputSchema,
  TypedQuestionOutputSchema,
  type EvaluatorCandidateCreateResult,
  type ExecutionBinding
} from "@rubrist/shared";
import { EvaluatorLifecycleRepositoryError, type EvaluatorLifecycleRepository } from "../src/evaluator-lifecycle/repository.js";
import { createEvaluatorLifecycleRouter } from "../src/evaluator-lifecycle/routes.js";
import { evaluatorCandidateRequestDigest } from "../src/lib/evaluator-lifecycle.js";
import { MOCK_BINDING, SEEDED_BINDING, bindingInput } from "./fixtures/execution-binding.js";

function repository(): EvaluatorLifecycleRepository {
  return {
    createCandidate: vi.fn(),
    getLifecycle: vi.fn(),
    listLifecycles: vi.fn(),
    activate: vi.fn(),
    retire: vi.fn(),
    authorizeExecution: vi.fn(),
    candidateExists: vi.fn(async () => false),
    getGovernedBinding: vi.fn(async () => null),
    recordResolution: vi.fn(async (_attempt, record) => record)
  };
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const CANDIDATE_INPUT = {
  criterionId: "criterion", criterionVersionId: "criterion-version",
  governedBatchId: "batch", expectedBatchDigest: DIGEST,
  truthDatasetRevisionId: "truth", expectedTruthRevisionDigest: DIGEST,
  expectedTruthContentDigest: DIGEST, skillName: "Evaluator",
  skillDescription: "Exact evaluator", rubricMarkdown: "Exact rubric",
  prompt: "Judge the response.", executionBinding: bindingInput(MOCK_BINDING),
  outputSchema: MinimumVerdictOutputSchema, idempotencyKey: "candidate-key"
};

function candidateResult(replayed: boolean): EvaluatorCandidateCreateResult {
  const version = {
    id: "skill-version", skillId: "skill", criterionVersionId: "criterion-version",
    version: "1.0.0", status: "calibrating" as const, rubricMarkdown: "Exact rubric",
    prompt: "Judge the response.", typedQuestion: null, decisionThreshold: null,
    executionBinding: structuredClone(MOCK_BINDING), customEndpointUrl: null,
    outputSchema: MinimumVerdictOutputSchema, goldenSetAgreement: null,
    tooStrictCount: 0, tooLenientCount: 0, ambiguousCount: 0, knownLimitations: [],
    verdictKind: "binary" as const, scalarRange: null, categoricalChoiceScores: null,
    rubricProvenance: "human-authored" as const, regressionDatasetRevisionId: "regression",
    createdAt: "2026-08-24T00:00:00.000Z", approvedAt: null
  };
  const lifecycle = {
    id: "lifecycle", contractVersion: "rubrist/evaluator-lifecycle/v1" as const,
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
        id: "event", contractVersion: "rubrist/evaluator-lifecycle-event/v1", lifecycleId: "lifecycle",
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
        executionBinding: { ...CANDIDATE_INPUT.executionBinding, provider: "anthropic", sampling: { temperature: 3, topP: null } }
      })
    });
    expect(response.status).toBe(400);
    expect(repo.createCandidate).not.toHaveBeenCalled();
  });

  it("takes only canonical provider identifiers, which are evaluator identity", async () => {
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
        executionBinding: { ...CANDIDATE_INPUT.executionBinding, provider: " Mock " }
      })
    });
    expect(response.status).toBe(400);
    expect(repo.createCandidate).not.toHaveBeenCalled();
  });

  it("answers a mutable model alias with 422 and the matched rule", async () => {
    const repo = repository();
    vi.mocked(repo.createCandidate).mockRejectedValue(new EvaluatorLifecycleRepositoryError(
      "mutable_model_alias",
      "An evaluator bound to the mutable model alias \"auto\" cannot become a candidate; pin a specific model id",
      { modelId: "auto", alias: "auto", rule: "rubrist-mutable-model-alias/v1" }
    ));
    const owner = createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: "owner", projectId: "project" }),
      resolveProjectRole: async () => "owner"
    });
    const response = await owner.request("/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CANDIDATE_INPUT, executionBinding: { ...CANDIDATE_INPUT.executionBinding, modelId: "auto" } })
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "evaluator_lifecycle_mutable_model_alias",
      details: { modelId: "auto", alias: "auto", rule: "rubrist-mutable-model-alias/v1" }
    });
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

  it("replays a typed-question candidate, matching its question and threshold", async () => {
    const jev: ExecutionBinding = {
      provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
      sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
      verdictProtocol: "typed-question/v1", routing: null
    };
    const question = { type: "noul" as const, instructions: "Is it correct?", criteria: { true: "Correct.", false: "Incorrect." } };
    const { rubricMarkdown: _rubric, prompt: _prompt, outputSchema: _schema, ...rest } = CANDIDATE_INPUT;
    const typedInput = { ...rest, typedQuestion: question, decisionThreshold: 0.1 + 0.2, executionBinding: bindingInput(jev) };
    const typedResult = (threshold: number): EvaluatorCandidateCreateResult => {
      const result = candidateResult(true);
      result.skill.currentVersion = {
        ...result.skill.currentVersion, rubricMarkdown: null, prompt: null, typedQuestion: question, decisionThreshold: threshold,
        executionBinding: jev, outputSchema: TypedQuestionOutputSchema as unknown as typeof MinimumVerdictOutputSchema
      };
      result.projection.lifecycle.requestDigest = evaluatorCandidateRequestDigest("project", { ...typedInput, outputSchema: TypedQuestionOutputSchema });
      return result;
    };
    const post = async (result: EvaluatorCandidateCreateResult) => {
      const repo = repository();
      vi.mocked(repo.candidateExists).mockResolvedValue(true);
      vi.mocked(repo.createCandidate).mockResolvedValue(result);
      const owner = createEvaluatorLifecycleRouter({
        repository: repo, databaseMode: true,
        requestIdentity: () => ({ userId: "owner", projectId: "project" }),
        resolveProjectRole: async () => "owner"
      });
      return owner.request("/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(typedInput) });
    };
    expect((await post(typedResult(0.1 + 0.2))).status).toBe(200);
    // A stored version whose threshold differs is not this request's candidate.
    expect((await post(typedResult(0.3))).status).toBe(500);
  });

  describe("resolution at the governed gates (ADR-0014 section 4)", () => {
    const services = { credential: vi.fn(async () => ({ apiKey: null, source: null })) };
    const mockGoverned = {
      projectId: "project",
      executionBinding: structuredClone(MOCK_BINDING),
      customEndpointUrl: null,
      typedQuestion: null,
      decisionThreshold: null,
      spec: { verdictKind: "binary" as const, scalarRange: null, categoricalChoiceScores: null }
    };
    const router = (repo: EvaluatorLifecycleRepository, bindingResolution: typeof services | null = services) => createEvaluatorLifecycleRouter({
      repository: repo,
      databaseMode: true,
      requestIdentity: () => ({ userId: "owner", projectId: "project" }),
      resolveProjectRole: async () => "owner",
      bindingResolution: bindingResolution ?? undefined
    });
    const post = (app: ReturnType<typeof router>, path: string, body: unknown) => app.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });

    it("resolves a new candidate's binding before creating it, and never re-resolves a replay", async () => {
      const repo = repository();
      vi.mocked(repo.createCandidate).mockResolvedValue(candidateResult(false));
      const app = router(repo);
      expect((await post(app, "/candidates", CANDIDATE_INPUT)).status).toBe(201);
      expect(repo.recordResolution).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project", skillVersionId: null, kind: "resolution",
        triggerKind: "candidate_creation", triggerRef: "candidate-key", outcome: "resolved"
      }), null);
      const [, , resolution] = vi.mocked(repo.createCandidate).mock.calls[0]!;
      expect(resolution).toMatchObject({
        bindingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        record: { status: "resolved", probes: [{ stage: "resolution", purpose: "confirm", outcome: "accepted" }] }
      });

      vi.mocked(repo.candidateExists).mockResolvedValue(true);
      vi.mocked(repo.createCandidate).mockResolvedValue(candidateResult(true));
      expect((await post(app, "/candidates", CANDIDATE_INPUT)).status).toBe(200);
      expect(repo.recordResolution).toHaveBeenCalledTimes(1);
      expect(vi.mocked(repo.createCandidate).mock.calls[1]![2]).toBeNull();
    });

    it("resolves an unresolved binding at activation, and leaves a resolved or failed one alone", async () => {
      const repo = repository();
      vi.mocked(repo.activate).mockRejectedValue(new EvaluatorLifecycleRepositoryError("state_conflict", "stop here"));
      vi.mocked(repo.getGovernedBinding).mockResolvedValue({ binding: mockGoverned, record: null });
      const app = router(repo);
      const activation = {
        expectedState: "candidate", expectedSequence: "1", expectedEventId: "event", expectedEventDigest: DIGEST,
        calibrationArtifactId: "artifact", expectedCalibrationArtifactDigest: DIGEST, expectedCalibrationEvidenceDigest: DIGEST,
        regressionRunId: "regression", expectedPriorActiveSkillVersionId: null, expectedPriorActiveEventId: null,
        expectedPriorActiveEventDigest: null, rationale: "Activate the calibrated candidate.", idempotencyKey: "activate-key"
      };
      await post(app, "/skill-version/activate", activation);
      expect(repo.recordResolution).toHaveBeenCalledWith(
        expect.objectContaining({ skillVersionId: "skill-version", triggerKind: "activation", triggerRef: "activate-key", outcome: "resolved" }),
        expect.objectContaining({ status: "resolved" })
      );

      const resolved = await (await import("./fixtures/execution-binding.js")).resolvedRecordFor(MOCK_BINDING);
      for (const record of [resolved, { ...resolved, status: "failed" as const }]) {
        vi.mocked(repo.recordResolution).mockClear();
        vi.mocked(repo.getGovernedBinding).mockResolvedValue({ binding: mockGoverned, record });
        await post(app, "/skill-version/activate", activation);
        expect(repo.recordResolution).not.toHaveBeenCalled();
      }
    });

    const seededGoverned = { ...mockGoverned, executionBinding: structuredClone(SEEDED_BINDING) };

    it("reads a version's resolution, and resolves on demand only where probes are configured", async () => {
      const repo = repository();
      vi.mocked(repo.getGovernedBinding).mockResolvedValue({ binding: seededGoverned, record: null });
      const read = await router(repo).request("/skill-version/resolution");
      expect(read.status).toBe(200);
      // The author sees the record, how the binding states its settings, their role, and why it can't pass a governed gate yet.
      await expect(read.json()).resolves.toEqual({
        skillVersionId: "skill-version",
        projectRole: "owner",
        record: null,
        settings: { temperature: "stated", reasoning: "stated" },
        gateRefusal: {
          message: "The execution binding can't pass a governed gate: the execution binding is unresolved, not resolved",
          problems: ["the execution binding is unresolved, not resolved"],
          providerMessage: null,
          suggestion: "Try again once the provider is reachable with a working credential."
        },
        resolvable: true
      });

      expect((await post(router(repo, null), "/skill-version/resolution", {})).status).toBe(501);
      // No key: nothing is sent, and the author is told to add one.
      const keyless = await post(router(repo), "/skill-version/resolution", {});
      expect(keyless.status).toBe(200);
      await expect(keyless.json()).resolves.toMatchObject({
        projectRole: "owner", record: { status: "unresolved", credentialSource: null, probes: [] },
        gateRefusal: { suggestion: "Add a key for anthropic in Settings, then resolve the binding again." }
      });
      expect(repo.recordResolution).toHaveBeenCalledWith(expect.objectContaining({ triggerKind: "on_demand" }), expect.anything());
      // Without probe access, a read says resolving now couldn't change anything.
      await expect((await router(repo, null).request("/skill-version/resolution")).json()).resolves.toMatchObject({ resolvable: false });

      vi.mocked(repo.getGovernedBinding).mockResolvedValue(null);
      expect((await router(repo).request("/missing/resolution")).status).toBe(404);
    });

    it("never offers to resolve an alias or the mock, and says why neither passes a governed gate", async () => {
      const repo = repository();
      const alias = { ...seededGoverned, executionBinding: { ...structuredClone(SEEDED_BINDING), modelId: "claude-latest" } };
      vi.mocked(repo.getGovernedBinding).mockResolvedValue({ binding: alias, record: null });
      await expect((await router(repo).request("/skill-version/resolution")).json()).resolves.toMatchObject({
        resolvable: false,
        gateRefusal: {
          problems: ["claude-latest is a mutable model alias, which every governed gate refuses", "the execution binding is unresolved, not resolved"],
          suggestion: "Save a new evaluator version with a pinned model id."
        }
      });
      const refused = await post(router(repo), "/skill-version/resolution", {});
      expect(refused.status).toBe(422);
      await expect(refused.json()).resolves.toMatchObject({ code: "mutable_model_alias" });
      expect(repo.recordResolution).not.toHaveBeenCalled();

      vi.mocked(repo.getGovernedBinding).mockResolvedValue({ binding: mockGoverned, record: null });
      await expect((await router(repo).request("/skill-version/resolution")).json()).resolves.toMatchObject({
        resolvable: false,
        settings: { temperature: "not_applicable", reasoning: "not_applicable" },
        gateRefusal: {
          problems: ["the built-in mock makes no provider call, so it can't run sealed calibration", "the execution binding is unresolved, not resolved"],
          suggestion: "Save a new evaluator version bound to a real provider."
        }
      });
    });

    it("lets a member read the status but not resolve it", async () => {
      const repo = repository();
      vi.mocked(repo.getGovernedBinding).mockResolvedValue({ binding: seededGoverned, record: null });
      const member = createEvaluatorLifecycleRouter({
        repository: repo, databaseMode: true, bindingResolution: services,
        requestIdentity: () => ({ userId: "member", projectId: "project" }),
        resolveProjectRole: async () => "member"
      });
      await expect((await member.request("/skill-version/resolution")).json()).resolves.toMatchObject({ projectRole: "member" });
      expect((await post(member, "/skill-version/resolution", {})).status).toBe(403);
      expect(repo.recordResolution).not.toHaveBeenCalled();
    });
  });
});
