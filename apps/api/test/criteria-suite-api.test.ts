import { describe, expect, it } from "vitest";
import {
  CreateCriterionInputSchema,
  CreateSkillVersionInputSchema,
  type Criterion,
  type CreatedCriterion,
  type EvaluatorSuiteManifest
} from "@coeval/shared";
import { createApp } from "../src/app.js";
import { AmbiguousProjectSkillError, DatasetRevisionConflictError, DemoRepository } from "../src/repository.js";
import { canonicalEvaluatorSuiteManifestBytes } from "../src/lib/evaluator-suite.js";
import type { Queue, QueueJob, QueueName, QueueSendOptions } from "@coeval/queue";
import { enqueueDueLangSmithImports } from "../src/workers/langsmith-poller.js";
import { enqueueDueLangfuseImports } from "../src/workers/langfuse-poller.js";
import { enqueueDueIronsideImports } from "../src/workers/ironside-poller.js";

const PROJECT_ID = "proj_langsmith_support";
const TRACE = {
  sourceTraceId: "criteria-suite-same-case",
  input: { question: "Is this answer grounded?" },
  output: { answer: "Yes, with cited evidence." },
  metadata: { test: "criteria-suite" }
};

async function setup() {
  const repository = new DemoRepository();
  const app = createApp(repository);
  const keyResponse = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "criteria-suite-test" })
  });
  const { key } = await keyResponse.json() as { key: string };
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`
  };
  return { repository, app, headers };
}

const criterionInput = {
  stableKey: "groundedness",
  name: "Groundedness",
  definition: "The response must be supported by the supplied evidence.",
  evaluator: {
    rubricMarkdown: "# Groundedness\n\nPass only when every material claim is supported.",
    prompt: "Judge groundedness using the rubric.\n{{rubric_markdown}}",
    modelBinding: {
      provider: "mock",
      modelId: "mock",
      modelVersion: "test",
      temperature: 0
    }
  }
};

class CapturingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: Record<string, unknown> }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, _options?: QueueSendOptions): Promise<string> {
    this.jobs.push({ name, data: data as Record<string, unknown> });
    return `job_${this.jobs.length}`;
  }
  async work<T extends object>(_name: QueueName, _handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {}
}

describe("criterion and evaluator-suite API", () => {
  it("requires an owner session for criterion and manifest writes in auth mode", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository, {
      auth: { api: { getSession: async () => null } } as never,
      pool: {} as never
    });
    const key = (await repository.createApiKey({
      projectId: PROJECT_ID,
      name: "read-judge-key"
    })).key;
    const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };

    for (const [path, body] of [
      ["/api/v1/criteria", criterionInput],
      ["/api/v1/criteria/criterion_test/versions", { name: "v2", definition: "v2" }],
      ["/api/v1/evaluator-suite-manifests", { idempotencyKey: "owner-only", members: [], trialPlan: null }]
    ] as const) {
      const response = await app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "owner_session_required" });
    }
  });

  it("rejects non-scalar Unicode text before hashing immutable identities", async () => {
    const { app, headers } = await setup();
    const response = await app.request("/api/v1/criteria", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...criterionInput, name: `Broken ${String.fromCharCode(0xd800)}` })
    });
    expect(response.status).toBe(400);
  });

  it("authenticates strict criterion routes and atomically provisions a usable evaluator", async () => {
    const { repository, app, headers } = await setup();
    expect((await app.request("/api/v1/criteria")).status).toBe(401);

    const rejected = await app.request("/api/v1/criteria", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...criterionInput, releaseThreshold: 0.9 })
    });
    expect(rejected.status).toBe(400);

    const createdResponse = await app.request("/api/v1/criteria", {
      method: "POST",
      headers,
      body: JSON.stringify(criterionInput)
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as CreatedCriterion;
    expect(created).toMatchObject({
      criterion: { stableKey: "groundedness", sourceKind: "native" },
      versions: [{ revision: 1, name: "Groundedness" }],
      evaluator: {
        name: "Groundedness",
        currentVersion: { status: "draft", version: "0.1.0" }
      }
    });
    expect(created.evaluator.currentVersion.skillId).toBe(created.evaluator.id);

    const duplicate = await app.request("/api/v1/criteria", {
      method: "POST",
      headers,
      body: JSON.stringify(criterionInput)
    });
    expect(duplicate.status).toBe(409);

    const revised = await app.request(`/api/v1/criteria/${created.criterion.id}/versions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Groundedness", definition: "Every factual claim must cite supplied evidence." })
    });
    expect(revised.status).toBe(201);
    await expect(revised.json()).resolves.toMatchObject({ version: { revision: 2 } });

    const detail = await app.request(`/api/v1/criteria/${created.criterion.id}`, { headers });
    const body = await detail.json() as { versions: Array<{ revision: number; definition: string }> };
    expect(body.versions.map((version) => version.revision)).toEqual([2, 1]);
    expect(body.versions[1]?.definition).toBe(criterionInput.definition);

    await expect(repository.createSkillVersionPending(
      created.evaluator.id,
      CreateSkillVersionInputSchema.parse({
        rubricMarkdown: criterionInput.evaluator.rubricMarkdown,
        prompt: criterionInput.evaluator.prompt,
        modelBinding: criterionInput.evaluator.modelBinding
      }),
      { projectId: PROJECT_ID }
    )).rejects.toBeInstanceOf(DatasetRevisionConflictError);

    const unjudged = await repository.importTrace(PROJECT_ID, "manual", {
      sourceTraceId: "definition-ambiguous-human",
      input: { q: "q" },
      output: { a: "a" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    await expect(repository.recordVerdict({
      projectId: PROJECT_ID,
      caseId: unjudged.caseId,
      source: "human",
      payload: { kind: "binary", pass: true, rationale: "Must choose the definition." }
    })).rejects.toBeInstanceOf(AmbiguousProjectSkillError);
  });

  it("pins manual and provider imports on two-criterion projects", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    const app = createApp(repository, { queue });
    const integrations = {
      langsmith: await repository.createLangSmithIntegration(PROJECT_ID, {
        apiKey: "ls-test",
        projectName: "support"
      }),
      langfuse: await repository.createLangfuseIntegration(PROJECT_ID, {
        publicKey: "pk-test",
        secretKey: "sk-test"
      }),
      ironside: await repository.createIronsideIntegration(PROJECT_ID, {
        url: "http://ironside.test",
        apiKey: "ironside-test"
      }, {
        protocolVersion: "ironside/evaluator/v1",
        project: { id: "remote_criteria", name: "Criteria test" },
        capabilities: ["traces:read", "scores:write"],
        settlement: { kind: "quiet_period", quietPeriodSeconds: 0 }
      })
    };
    const native = await repository.createCriterion(PROJECT_ID, CreateCriterionInputSchema.parse(criterionInput), {});
    await repository.signOffSkillVersion(
      PROJECT_ID,
      native.evaluator.id,
      native.evaluator.currentVersion.id,
      {}
    );
    for (const provider of ["langsmith", "langfuse", "ironside"] as const) {
      const response = await app.request(`/api/integrations/${provider}/${integrations[provider].id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillVersionId: native.evaluator.currentVersion.id })
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        integration: { skillVersionId: native.evaluator.currentVersion.id }
      });
    }

    const dashboard = await app.request(`/api/dashboard?criterionId=${encodeURIComponent(native.criterion.id)}`);
    expect(dashboard.status).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      skill: { criterionId: native.criterion.id, currentVersion: { criterionVersionId: native.versions[0]!.id } }
    });
    expect((await app.request("/api/dashboard")).status).toBe(409);
    expect((await app.request("/api/dashboard?criterionId=criterion_foreign")).status).toBe(404);
    expect((await app.request("/api/skills/current?criterionId=criterion_foreign")).status).toBe(404);
    expect((await app.request("/api/skills/current?criterionId=criterion_foreign&scope=latest")).status).toBe(404);

    const manualBody = { sourceTraceId: "manual-pinned", input: { q: "q" }, output: { a: "a" } };
    expect((await app.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manualBody)
    })).status).toBe(409);
    const manual = await app.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...manualBody, skillVersionId: native.evaluator.currentVersion.id })
    });
    expect(manual.status).toBe(201);
    expect(queue.jobs.at(-1)).toMatchObject({ name: "eval.run" });
    const manualEvalRunId = String(queue.jobs.at(-1)?.data.evalRunId);
    await expect(repository.getEvalRun(PROJECT_ID, manualEvalRunId)).resolves.toMatchObject({
      skillVersionId: native.evaluator.currentVersion.id
    });

    for (const provider of ["langsmith", "langfuse", "ironside"] as const) {
      const path = `/api/integrations/${provider}/${integrations[provider].id}/import`;
      expect((await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 })
      })).status).toBe(409);
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1, skillVersionId: native.evaluator.currentVersion.id })
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        importJob: { skillVersionId: native.evaluator.currentVersion.id }
      });
      expect(queue.jobs.at(-1)).toMatchObject({
        name: `${provider}.import`,
        data: { skillVersionId: native.evaluator.currentVersion.id }
      });
    }

    const now = new Date("2026-08-23T12:00:00.000Z");
    await expect(repository.claimDueLangSmithImportTargets({ now, intervalMs: 1, batchSize: 10, defaultLimit: 25 }))
      .resolves.toMatchObject([{ skillVersionId: native.evaluator.currentVersion.id }]);
    await expect(repository.claimDueLangfuseImportTargets({ now, intervalMs: 1, batchSize: 10, defaultLimit: 25 }))
      .resolves.toMatchObject([{ skillVersionId: native.evaluator.currentVersion.id }]);
    await expect(repository.claimDueIronsideImportTargets({ now, intervalMs: 1, batchSize: 10, defaultLimit: 25 }))
      .resolves.toMatchObject([{ skillVersionId: native.evaluator.currentVersion.id }]);

    const internal = repository as unknown as {
      langSmithIntegrations: Map<string, { skillVersionId: string | null }>;
      langfuseIntegrations: Map<string, { skillVersionId: string | null }>;
      ironsideIntegrations: Map<string, { skillVersionId: string | null }>;
    };
    internal.langSmithIntegrations.get(integrations.langsmith.id)!.skillVersionId = null;
    internal.langfuseIntegrations.get(integrations.langfuse.id)!.skillVersionId = null;
    internal.ironsideIntegrations.get(integrations.ironside.id)!.skillVersionId = null;
    const later = new Date(now.getTime() + 10 * 60_000);
    await expect(enqueueDueLangSmithImports(repository, queue, { now: later })).resolves.toEqual({ claimed: 0, queued: 0 });
    await expect(enqueueDueLangfuseImports(repository, queue, { now: later })).resolves.toEqual({ claimed: 0, queued: 0 });
    await expect(enqueueDueIronsideImports(repository, queue, { now: later })).resolves.toEqual({ claimed: 0, queued: 0 });
    const failedSelections = await repository.listImportJobs({ projectId: PROJECT_ID, status: "failed", limit: 10 });
    expect(failedSelections).toHaveLength(3);
    expect(new Set(failedSelections.map((job) => job.source))).toEqual(new Set(["langsmith", "langfuse", "ironside"]));
    expect(failedSelections.every((job) => job.skillVersionId === null)).toBe(true);
    expect(failedSelections.every((job) => job.error?.startsWith("skill_version_required:"))).toBe(true);
  });

  it("creates canonical multi-criterion manifests with exact retry and revision semantics", async () => {
    const { repository, app, headers } = await setup();
    const initialCriteria = await (await app.request("/api/v1/criteria", { headers })).json() as { criteria: Criterion[] };
    const legacyCriterion = initialCriteria.criteria[0]!;
    const legacyDetail = await (await app.request(`/api/v1/criteria/${legacyCriterion.id}`, { headers })).json() as {
      versions: Array<{ id: string }>;
    };
    const legacySkill = await (await app.request(`/api/v1/criteria/${legacyCriterion.id}/current-skill`, { headers })).json() as {
      skill: { currentVersion: { id: string } };
    };

    const native = await (await app.request("/api/v1/criteria", {
      method: "POST",
      headers,
      body: JSON.stringify(criterionInput)
    })).json() as CreatedCriterion;
    const members = [
      {
        criterionVersionId: legacyDetail.versions[0]!.id,
        skillVersionId: legacySkill.skill.currentVersion.id
      },
      {
        criterionVersionId: native.versions[0]!.id,
        skillVersionId: native.evaluator.currentVersion.id
      }
    ];
    const request = { idempotencyKey: "suite-create-1", members, trialPlan: null };

    const first = await app.request("/api/v1/evaluator-suite-manifests", {
      method: "POST",
      headers,
      body: JSON.stringify(request)
    });
    expect(first.status).toBe(201);
    const firstBytes = await first.text();
    const manifest = JSON.parse(firstBytes) as EvaluatorSuiteManifest;
    expect(firstBytes).toBe(canonicalEvaluatorSuiteManifestBytes(manifest).toString("utf8"));
    expect(manifest).toMatchObject({ revision: 1, trialPlan: null });
    expect(manifest.members.map((member) => member.position)).toEqual([0, 1]);
    expect(manifest.members.every((member) => member.applicability.kind === "all_items")).toBe(true);

    const retry = await app.request("/api/v1/evaluator-suite-manifests", {
      method: "POST",
      headers,
      body: JSON.stringify(request)
    });
    expect(retry.status).toBe(201);
    expect(await retry.text()).toBe(firstBytes);

    const fetched = await app.request(`/api/v1/evaluator-suite-manifests/${manifest.manifestId}`, { headers });
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(firstBytes);

    const changedRetry = await app.request("/api/v1/evaluator-suite-manifests", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, trialPlan: { kind: "independent_repetitions", trialsPerItem: 2 } })
    });
    expect(changedRetry.status).toBe(409);

    const append = await app.request("/api/v1/evaluator-suite-manifests", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: "suite-create-2",
        suiteId: manifest.suiteId,
        members,
        trialPlan: null
      })
    });
    expect(append.status).toBe(201);
    await expect(append.json()).resolves.toMatchObject({ suiteId: manifest.suiteId, revision: 2 });

    const duplicateMember = await app.request("/api/v1/evaluator-suite-manifests", {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "suite-duplicate", members: [members[0], members[0]], trialPlan: null })
    });
    expect(duplicateMember.status).toBe(409);

    const policyField = await app.request("/api/v1/evaluator-suite-manifests", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, idempotencyKey: "suite-policy", weights: [0.5, 0.5] })
    });
    expect(policyField.status).toBe(400);

    const revisedCriterionResponse = await app.request(
      `/api/v1/criteria/${native.criterion.id}/versions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Groundedness strict",
          definition: "Every material claim must quote the supplied evidence."
        })
      }
    );
    const revisedCriterion = await revisedCriterionResponse.json() as { version: { id: string } };
    const revisedEvaluator = await repository.createSkillVersionPending(
      native.evaluator.id,
      CreateSkillVersionInputSchema.parse({
        criterionVersionId: revisedCriterion.version.id,
        rubricMarkdown: criterionInput.evaluator.rubricMarkdown,
        prompt: criterionInput.evaluator.prompt,
        modelBinding: criterionInput.evaluator.modelBinding
      }),
      { projectId: PROJECT_ID }
    );
    const definitionScopedConvergence = await repository.getConvergenceAudit(
      PROJECT_ID,
      native.evaluator.id,
      revisedEvaluator.id
    );
    // The only older evaluator belongs to criterion definition v1. Definition
    // v2 starts a fresh comparison lineage instead of borrowing that baseline.
    expect(definitionScopedConvergence.audit.beforeVersionId).toBeNull();
    const latestScopedSkill = await app.request(
      `/api/v1/criteria/${native.criterion.id}/current-skill?scope=latest`,
      { headers }
    );
    expect(latestScopedSkill.status).toBe(200);
    await expect(latestScopedSkill.json()).resolves.toMatchObject({
      skill: { currentVersion: { id: revisedEvaluator.id, criterionVersionId: revisedCriterion.version.id } }
    });
    const duplicateStableCriterion = await app.request("/api/v1/evaluator-suite-manifests", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: "suite-duplicate-stable-criterion",
        members: [
          {
            criterionVersionId: native.versions[0]!.id,
            skillVersionId: native.evaluator.currentVersion.id
          },
          {
            criterionVersionId: revisedCriterion.version.id,
            skillVersionId: revisedEvaluator.id
          }
        ],
        trialPlan: null
      })
    });
    expect(duplicateStableCriterion.status).toBe(409);
  });

  it("fails closed on singleton selectors and scopes human truth to the chosen criterion", async () => {
    const { repository, app, headers } = await setup();
    const legacyCriteria = await repository.listCriteria(PROJECT_ID);
    const legacyCriterion = legacyCriteria[0]!;
    const legacyCriterionDetail = await repository.getCriterion(PROJECT_ID, legacyCriterion.id);
    const legacyCriterionVersionId = legacyCriterionDetail!.versions[0]!.id;
    const legacySkill = await repository.getCurrentSkillForCriterion(PROJECT_ID, legacyCriterion.id);
    const nativeResponse = await app.request("/api/v1/criteria", {
      method: "POST",
      headers,
      body: JSON.stringify(criterionInput)
    });
    const native = await nativeResponse.json() as CreatedCriterion;

    await Promise.all([
      repository.createEvalRun({
        projectId: PROJECT_ID,
        skillVersionId: legacySkill.currentVersion.id,
        trigger: "manual",
        items: []
      }),
      repository.createEvalRun({
        projectId: PROJECT_ID,
        skillVersionId: native.evaluator.currentVersion.id,
        trigger: "manual",
        items: []
      })
    ]);

    expect((await app.request("/api/skills/current")).status).toBe(409);
    expect((await app.request("/api/golden-set")).status).toBe(409);
    expect((await app.request("/api/golden-set/health")).status).toBe(409);
    expect((await app.request("/api/trust-digest")).status).toBe(409);
    expect((await app.request("/api/projects/kappa")).status).toBe(409);
    expect((await app.request("/api/projects/judge-human-calibration")).status).toBe(409);
    expect((await app.request("/api/projects/disagreements")).status).toBe(409);
    expect((await app.request("/api/projects/judge-human-disagreements")).status).toBe(409);
    for (const path of [
      "/api/projects/kappa",
      "/api/projects/judge-human-calibration",
      "/api/projects/disagreements",
      "/api/projects/judge-human-disagreements"
    ]) {
      expect((await app.request(`${path}?criterionVersionId=criterionv_foreign`)).status).toBe(400);
    }
    expect((await app.request(
      `/api/golden-set?criterionVersionId=${encodeURIComponent(native.versions[0]!.id)}`
    )).status).toBe(200);
    expect((await app.request(
      `/api/golden-set/health?criterionVersionId=${encodeURIComponent(native.versions[0]!.id)}`
    )).status).toBe(200);
    const nativeTrust = await app.request(
      `/api/trust-digest?skillVersionId=${encodeURIComponent(native.evaluator.currentVersion.id)}`
    );
    expect(nativeTrust.status).toBe(200);
    await expect(nativeTrust.json()).resolves.toMatchObject({ spend: { runsCounted: 1 } });
    expect((await app.request(
      `/api/skills/${native.evaluator.id}/versions/${native.evaluator.currentVersion.id}/card`
    )).status).toBe(200);
    expect((await app.request(
      `/api/skills/${native.evaluator.id}/versions/${native.evaluator.currentVersion.id}/skill-format`
    )).status).toBe(200);
    const unpinned = await app.request("/api/v1/judge", {
      method: "POST",
      headers,
      body: JSON.stringify({ trace: TRACE })
    });
    expect(unpinned.status).toBe(400);

    const judge = (skillVersionId: string) => app.request("/api/v1/judge", {
      method: "POST",
      headers,
      body: JSON.stringify({ trace: TRACE, skillVersionId })
    });
    const legacyJudged = await judge(legacySkill.currentVersion.id);
    expect(legacyJudged.status).toBe(201);
    const { caseId } = await legacyJudged.json() as { caseId: string };
    const nativeJudged = await judge(native.evaluator.currentVersion.id);
    expect(nativeJudged.status).toBe(201);

    const ambiguousQueue = await app.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ambiguous queue", caseIds: [caseId] })
    });
    expect(ambiguousQueue.status).toBe(409);

    const queueResponse = await app.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Criterion-scoped queue",
        criterionVersionId: legacyCriterionVersionId,
        caseIds: [caseId]
      })
    });
    expect(queueResponse.status).toBe(201);
    const { queue } = await queueResponse.json() as { queue: { id: string } };
    const add = await app.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            caseId,
            criterionVersionId: legacyCriterionVersionId,
            assignedToUserId: "reviewer_same"
          },
          {
            caseId,
            criterionVersionId: native.versions[0]!.id,
            assignedToUserId: "reviewer_same"
          }
        ]
      })
    });
    expect(add.status).toBe(201);
    await expect(add.json()).resolves.toMatchObject({ addedCount: 2 });
    const ambiguousPull = await app.request(`/api/review-queues/${queue.id}/next`);
    expect(ambiguousPull.status).toBe(409);
    const scopedPull = await app.request(
      `/api/review-queues/${queue.id}/next?criterionVersionId=${encodeURIComponent(native.versions[0]!.id)}`
    );
    expect(scopedPull.status).toBe(200);
    await expect(scopedPull.json()).resolves.toMatchObject({
      item: { criterionVersionId: native.versions[0]!.id }
    });

    const ambiguousHuman = await app.request(`/api/cases/${caseId}/verdicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationale: "Reviewed." } })
    });
    expect(ambiguousHuman.status).toBe(409);

    const boundHuman = await app.request(`/api/cases/${caseId}/verdicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: legacySkill.currentVersion.id,
        payload: { kind: "binary", pass: true, rationale: "Criterion A only." }
      })
    });
    expect(boundHuman.status).toBe(201);
    // Demo HTTP requests have no signed-in reviewer identity, so add one
    // actor-bound verdict to exercise the actual judge↔human κ pairing while
    // preserving the API assertion above.
    const legacyActorVerdict = await repository.recordVerdict({
      projectId: PROJECT_ID,
      caseId,
      source: "human",
      skillVersionId: legacySkill.currentVersion.id,
      actorUserId: "reviewer_criterion_a",
      payload: { kind: "binary", pass: true, rationale: "Criterion A only." }
    });

    const legacyCalibration = await repository.getProjectJudgeHumanCalibration(
      PROJECT_ID,
      legacyCriterionVersionId
    );
    const nativeCalibration = await repository.getProjectJudgeHumanCalibration(
      PROJECT_ID,
      native.versions[0]!.id
    );
    expect(legacyCalibration.overlappingCases).toBe(1);
    expect(nativeCalibration.overlappingCases).toBe(0);
    const nativeCalibrationRoute = await app.request(
      `/api/projects/judge-human-calibration?criterionVersionId=${encodeURIComponent(native.versions[0]!.id)}`
    );
    expect(nativeCalibrationRoute.status).toBe(200);
    await expect(nativeCalibrationRoute.json()).resolves.toMatchObject({ overlappingCases: 0 });

    const queueDetail = await repository.getReviewQueueDetail(PROJECT_ID, queue.id);
    const unassignedLegacy = queueDetail?.items.find((item) =>
      item.criterionVersionId === legacyCriterionVersionId && item.assignedToUserId === null
    );
    const nativeItem = queueDetail?.items.find((item) =>
      item.criterionVersionId === native.versions[0]!.id
    );
    expect(unassignedLegacy?.status).toBe("completed");
    expect(nativeItem?.status).toBe("pending");

    const legacyDetail = await repository.getCaseDetail(PROJECT_ID, caseId, legacySkill.currentVersion.id);
    const nativeDetail = await repository.getCaseDetail(PROJECT_ID, caseId, native.evaluator.currentVersion.id);
    expect(legacyDetail?.latestHumanLabel).toBe("pass");
    expect(nativeDetail?.latestHumanLabel).toBeNull();

    await repository.promoteExceptionToGoldenSet({
      projectId: PROJECT_ID,
      caseId,
      skillVersionId: legacySkill.currentVersion.id,
      agreedLabel: "pass",
      reason: "Criterion A known-good case.",
      actorUserId: "reviewer_criterion_a",
      actorName: "Criterion A reviewer"
    });
    const revisionBeforeForeignEvidence = await repository.getOrCreateRegressionDatasetRevision(
      PROJECT_ID,
      "reviewer_criterion_a",
      legacyCriterionVersionId
    );
    const foreignVerdict = await repository.recordVerdict({
      projectId: PROJECT_ID,
      caseId,
      source: "human",
      skillVersionId: native.evaluator.currentVersion.id,
      actorUserId: "reviewer_criterion_b",
      payload: { kind: "binary", pass: true, rationale: "Criterion B happens to agree." }
    });
    const scopedVerdicts = await app.request(
      `/api/cases/${caseId}/verdicts?skillVersionId=${encodeURIComponent(legacySkill.currentVersion.id)}`
    );
    expect(scopedVerdicts.status).toBe(200);
    const scopedVerdictBody = await scopedVerdicts.json() as { verdicts: Array<{ skillVersionId: string | null }> };
    expect(scopedVerdictBody.verdicts.length).toBeGreaterThan(0);
    expect(scopedVerdictBody.verdicts.every((verdict) => verdict.skillVersionId === legacySkill.currentVersion.id)).toBe(true);
    const criterionHistory = await app.request(
      `/api/projects/verdicts?criterionId=${encodeURIComponent(legacyCriterion.id)}`
    );
    expect(criterionHistory.status).toBe(200);
    const criterionHistoryBody = await criterionHistory.json() as { verdicts: Array<{ id: string }> };
    expect(criterionHistoryBody.verdicts.map((verdict) => verdict.id)).toContain(legacyActorVerdict.id);
    expect(criterionHistoryBody.verdicts.map((verdict) => verdict.id)).not.toContain(foreignVerdict.id);
    const revisionAfterForeignEvidence = await repository.getOrCreateRegressionDatasetRevision(
      PROJECT_ID,
      "reviewer_criterion_a",
      legacyCriterionVersionId
    );
    expect(revisionAfterForeignEvidence.id).toBe(revisionBeforeForeignEvidence.id);
    expect(revisionAfterForeignEvidence.revisionDigest).toBe(revisionBeforeForeignEvidence.revisionDigest);
    expect(revisionAfterForeignEvidence.items[0]?.itemDigest)
      .toBe(revisionBeforeForeignEvidence.items[0]?.itemDigest);
    expect(revisionAfterForeignEvidence.items[0]?.referenceProvenance.verdictIds)
      .toContain(legacyActorVerdict.id);
    expect(revisionAfterForeignEvidence.items[0]?.referenceProvenance.verdictIds)
      .not.toContain(foreignVerdict.id);
  });
});
