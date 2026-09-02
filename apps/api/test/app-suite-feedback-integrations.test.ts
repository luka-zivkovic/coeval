import { describe, expect, it } from "vitest";

import { CreateSkillVersionInputSchema, type FeedbackSyncJob } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import { processFeedbackSyncJob } from "../src/workers/feedback-sync.js";

import { processJudgeRunJob } from "../src/workers/judge.js";

import { IronsideHttpError } from "../src/lib/ironside.js";
import { BlockedIronsideFeedbackRepository, CapturingQueue } from "./app-test-support.js";

describe("feedback sync worker", () => {
  it("enqueues and posts LangSmith feedback for judged LangSmith cases", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const imported = await repository.importTrace("proj_langsmith_support", "langsmith", {
      sourceTraceId: "ls_run_feedback",
      input: { question: "Refund?" },
      output: { answer: "Refunds are available." },
      metadata: { source: "langsmith" }
    }, {
      ingestionPurpose: "analysis_eligible_langsmith",
      sourceIntegrationId: integration.id
    });
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return {
          label: "pass" as const,
          score: 0.92,
          reason: "good support answer",
          confidence: 0.9
        };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "pass" as const, score: 0.92, rationale: "good support answer" } };
      }
    };

    const run = await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);

    expect(queue.jobs).toEqual([
      {
        name: "feedback.sync",
        data: {
          projectId: "proj_langsmith_support",
          feedbackSyncJobId: expect.any(String)
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);

    let feedbackPayload: unknown;
    await processFeedbackSyncJob(
      repository,
      queue.jobs[0]!.data as FeedbackSyncJob,
      () => ({
        async createFeedback(input) {
          feedbackPayload = input;
        }
      })
    );

    expect(feedbackPayload).toMatchObject({
      feedbackId: (queue.jobs[0]!.data as FeedbackSyncJob).feedbackSyncJobId,
      runId: "ls_run_feedback",
      key: "coeval_verdict",
      score: 0.92,
      value: "pass",
      comment: "good support answer",
      sourceInfo: {
        skillVersionId: "skillv_1_2_0",
        modelBinding: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          modelVersion: "2026-04-15",
          temperature: 0
        },
        judgeRunId: run.id,
        provider: "coeval"
      }
    });

    const failuresResponse = await createApp(repository).request("/api/feedback-syncs?status=synced&limit=5");
    expect(failuresResponse.status).toBe(200);
    await expect(failuresResponse.json()).resolves.toMatchObject({
      feedbackSyncs: [
        {
          provider: "langsmith",
          status: "synced",
          attempts: 0,
          lastError: null
        }
      ]
    });

    const invalidStatusResponse = await createApp(repository).request("/api/feedback-syncs?status=synked");
    expect(invalidStatusResponse.status).toBe(400);

    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);
    expect(queue.jobs).toHaveLength(1);
  });

  it("enqueues and posts Langfuse feedback for judged Langfuse cases", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangfuseIntegration("proj_langsmith_support", {
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test"
    });
    const imported = await repository.importTrace("proj_langsmith_support", "langfuse", {
      sourceTraceId: "lf_trace_feedback",
      input: { question: "Refund?" },
      output: { answer: "Refunds are available." },
      metadata: { source: "langfuse" }
    }, {
      ingestionPurpose: "analysis_eligible_langfuse",
      sourceIntegrationId: integration.id
    });
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return {
          label: "fail" as const,
          score: 0.2,
          reason: "not grounded",
          confidence: 0.9
        };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "fail" as const, score: 0.2, rationale: "not grounded" } };
      }
    };

    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);

    expect(queue.jobs).toMatchObject([
      {
        name: "feedback.sync",
        data: {
          projectId: "proj_langsmith_support",
          feedbackSyncJobId: expect.any(String)
        }
      }
    ]);

    let feedbackPayload: unknown;
    await processFeedbackSyncJob(
      repository,
      queue.jobs[0]!.data as FeedbackSyncJob,
      () => ({
        async createFeedback(input) {
          feedbackPayload = input;
        }
      })
    );

    expect(feedbackPayload).toMatchObject({
      feedbackId: (queue.jobs[0]!.data as FeedbackSyncJob).feedbackSyncJobId,
      runId: "lf_trace_feedback",
      key: "coeval_verdict",
      score: 0.2,
      value: "fail",
      comment: "not grounded"
    });
  });
});

describe("trust digest (M3 S4)", () => {
  it("GET /api/trust-digest returns the four signals with honest empty states on the demo project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/trust-digest");
    expect(response.status).toBe(200);
    const digest = (await response.json()) as {
      version: string;
      spend: { windowRuns: number; runsCounted: number };
      nudges: unknown[];
      noSignal: string[];
      judgeHumanKappa: unknown[];
    };
    expect(digest.spend.windowRuns).toBe(10);
    // The demo project has no human overlap with the CURRENT version's judge
    // rater and no repeat judgments — explicit no-signal facts, no fabrication.
    expect(digest.judgeHumanKappa).toEqual([]);
    expect(digest.noSignal.join(" ")).toMatch(/no human verdicts overlap/);
  });
});

describe("judge model binding validation", () => {
  it("validates model provider, custom endpoint, and temperature boundaries", () => {
    const baseInput = {
      rubricMarkdown: "Test rubric.",
      prompt: "Test prompt.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
    };
    expect(() => CreateSkillVersionInputSchema.parse(baseInput)).not.toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: { ...baseInput.modelBinding, provider: "typo-provider" }
    })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: { provider: "custom", modelId: "judge", modelVersion: "judge", temperature: 0 }
    })).toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: {
        provider: "custom",
        modelId: "judge",
        modelVersion: "judge",
        temperature: 0,
        baseUrl: "https://models.example.test/v1"
      }
    })).not.toThrow();
    expect(() => CreateSkillVersionInputSchema.parse({
      ...baseInput,
      modelBinding: { ...baseInput.modelBinding, temperature: 2.1 }
    })).toThrow();
  });
});

describe("Ironside integration lifecycle", () => {
  it("verifies an Ironside project before saving and rejects cross-project credential rotation", async () => {
    const repository = new BlockedIronsideFeedbackRepository();
    const queue = new CapturingQueue();
    let forceRemoteMismatch = false;
    const appWithIronside = createApp(repository, {
      queue,
      ironsideClientFactory: ({ apiKey }) => {
        const projectId = forceRemoteMismatch || apiKey === "key_other_project"
          ? "remote_other"
          : "remote_primary";
        return {
          async getContext() {
            if (apiKey === "key_invalid") throw new IronsideHttpError("invalid key", 401, "getContext");
            return {
              protocolVersion: "ironside/evaluator/v1",
              project: { id: projectId, name: projectId === "remote_primary" ? "Primary agents" : "Other agents" },
              capabilities: ["traces:read", "scores:write"],
              settlement: { kind: "quiet_period", quietPeriodSeconds: 120 }
            };
          },
          async listTraces() {
            return { protocolVersion: "ironside/evaluator/v1", traces: [], nextCursor: "cursor_empty", hasMore: false };
          },
          async getTrace() {
            throw new Error("not used");
          }
        };
      }
    });

    const invalidResponse = await appWithIronside.request("/api/integrations/ironside", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://ironside.example.test", apiKey: "key_invalid" })
    });
    expect(invalidResponse.status).toBe(502);
    await expect(repository.listIronsideIntegrations("proj_langsmith_support")).resolves.toEqual([]);

    const createdResponse = await appWithIronside.request("/api/integrations/ironside", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://ironside.example.test", apiKey: "key_primary" })
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { integration: { id: string; remoteProjectId: string } };
    expect(created.integration.remoteProjectId).toBe("remote_primary");
    await repository.saveIronsideSyncState("proj_langsmith_support", created.integration.id, { cursor: "cursor_saved" });
    await expect(repository.saveIronsideSyncState(
      "proj_langsmith_support",
      created.integration.id,
      { cursor: "cursor_regressed" },
      null
    )).resolves.toBe(false);

    const duplicateCreate = await appWithIronside.request("/api/integrations/ironside", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://other.example.test", apiKey: "key_other_project" })
    });
    expect(duplicateCreate.status).toBe(409);
    await expect(duplicateCreate.json()).resolves.toMatchObject({
      code: "ironside_integration_exists"
    });
    await expect(repository.loadIronsideImportContext({
      projectId: "proj_langsmith_support", integrationId: created.integration.id, limit: 1
    })).resolves.toMatchObject({ remoteProjectId: "remote_primary", syncState: { cursor: "cursor_saved" } });

    const rotatedResponse = await appWithIronside.request(`/api/integrations/ironside/${created.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "key_rotated_same_project" })
    });
    expect(rotatedResponse.status).toBe(200);
    await expect(repository.loadIronsideImportContext({
      projectId: "proj_langsmith_support", integrationId: created.integration.id, limit: 1
    })).resolves.toMatchObject({ syncState: { cursor: "cursor_saved" } });

    const mismatchResponse = await appWithIronside.request(`/api/integrations/ironside/${created.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "key_other_project" })
    });
    expect(mismatchResponse.status).toBe(409);
    await expect(mismatchResponse.json()).resolves.toMatchObject({ code: "ironside_project_mismatch" });

    forceRemoteMismatch = true;
    const testMismatch = await appWithIronside.request(
      `/api/integrations/ironside/${created.integration.id}/test`,
      { method: "POST" }
    );
    expect(testMismatch.status).toBe(409);
    await expect(repository.loadIronsideImportContext({
      projectId: "proj_langsmith_support",
      integrationId: created.integration.id,
      limit: 1
    })).resolves.toMatchObject({
      remoteProjectId: "remote_primary",
      pollEnabled: false,
      revalidationRequired: true,
      lastTestResult: { ok: false }
    });

    const blockedRebind = await appWithIronside.request(
      `/api/integrations/ironside/${created.integration.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "key_primary" })
      }
    );
    expect(blockedRebind.status).toBe(409);
    await expect(blockedRebind.json()).resolves.toMatchObject({
      code: "ironside_revalidation_requires_disconnect"
    });

    const blockedPolling = await appWithIronside.request(
      `/api/integrations/ironside/${created.integration.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollEnabled: true })
      }
    );
    expect(blockedPolling.status).toBe(409);
    await expect(blockedPolling.json()).resolves.toMatchObject({
      code: "ironside_revalidation_required"
    });

    forceRemoteMismatch = false;
    const revalidated = await appWithIronside.request(
      `/api/integrations/ironside/${created.integration.id}/test`,
      { method: "POST" }
    );
    expect(revalidated.status).toBe(200);
    expect(queue.jobs).toContainEqual({
      name: "feedback.sync",
      data: repository.blockedFeedback[0],
      options: { retryLimit: 5, retryBackoff: true }
    });
    expect(repository.redispatched).toEqual(repository.blockedFeedback);
    const enabled = await appWithIronside.request(
      `/api/integrations/ironside/${created.integration.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollEnabled: true })
      }
    );
    expect(enabled.status).toBe(200);
  });
});
