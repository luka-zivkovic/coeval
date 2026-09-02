import { describe, expect, it } from "vitest";

import { type FeedbackSyncJob } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import { isPermanentFeedbackSyncError, processFeedbackSyncJob } from "../src/workers/feedback-sync.js";

import { processEvalItemJob, processEvalRunJob } from "../src/workers/eval-run.js";

import { processJudgeRunJob } from "../src/workers/judge.js";
import { processLangfuseImportJob } from "../src/workers/langfuse-import.js";
import { enqueueDueLangfuseImports } from "../src/workers/langfuse-poller.js";
import { processLangSmithImportJob } from "../src/workers/langsmith-import.js";
import { enqueueDueLangSmithImports, parsePollImportLimit, parsePollIntervalMs } from "../src/workers/langsmith-poller.js";
import { EXCLUDED_VALUE, REDACTED_VALUE } from "../src/lib/redaction.js";
import { LangSmithHttpError } from "../src/lib/langsmith.js";

import { CapturingQueue, FailingOnceQueue, PurposeCapturingRepository } from "./app-test-support.js";

describe("judge worker", () => {
  it("processes queued judge jobs into judge runs", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "manual_trace_worker",
      input: { question: "Plain question" },
      output: { answer: "Plain answer" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const run = await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, {
      name: "test-worker-provider",
      async judge() {
        return {
          label: "pass",
          score: 0.95,
          reason: "worker verdict persisted",
          confidence: 0.9
        };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary", label: "pass", score: 0.95, rationale: "worker verdict persisted" } };
      }
    });

    expect(run).toMatchObject({
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0",
      verdict: "pass",
      reasoning: "worker verdict persisted"
    });
  });
});

describe("LangSmith import worker", () => {
  it("imports LangSmith runs and enqueues judge jobs", async () => {
    const queue = new CapturingQueue();
    const repository = new PurposeCapturingRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });

    const result = await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_1",
            input: { question: "Refund?" },
            output: { answer: "Refunds are available." },
            metadata: { source: "langsmith" }
          }
        ];
      }
    }));

    expect(result).toEqual({ imported: 1, queued: 1 });
    expect(repository.importedPurposes).toEqual(["analysis_eligible_langsmith"]);
    expect(queue.jobs).toEqual([
      {
        name: "eval.run",
        data: {
          projectId: "proj_langsmith_support",
          evalRunId: expect.any(String)
        },
        options: { id: expect.any(String), retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("C7/B9: LangSmith end-to-end — import -> judge -> sync-back in one governed chain", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });

    // 1. Import from the mocked LangSmith server -> case + durable eval run.
    const imported = await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, () => ({
      async listRuns() {
        return [{
          sourceTraceId: "ls_e2e_run",
          input: { question: "Can I get a refund on a gift order?" },
          output: { answer: "Yes — gift orders follow the standard 30-day policy." },
          metadata: { source: "langsmith" }
        }];
      }
    }));
    expect(imported).toEqual({ imported: 1, queued: 1 });
    const evalRunJob = queue.jobs.find((job) => job.name === "eval.run")!;

    // 2. Judge the imported case -> verdict recorded + feedback.sync enqueued.
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return { label: "pass" as const, score: 0.9, reason: "policy applied", confidence: 0.9 };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "pass" as const, score: 0.9, rationale: "policy applied" } };
      }
    };
    await processEvalRunJob(repository, queue, evalRunJob.data as { projectId: string; evalRunId: string });
    const itemJob = queue.jobs.find((job) => job.name === "eval.item")!;
    await processEvalItemJob(
      repository,
      itemJob.data as { projectId: string; evalRunId: string; evalRunItemId: string; caseId: string; skillVersionId: string },
      judgeProvider,
      "langsmith-e2e",
      queue
    );
    const syncJob = queue.jobs.find((job) => job.name === "feedback.sync")!;
    expect(syncJob).toBeDefined();

    // 3. Sync back to the mocked server -> payload verified, job synced.
    let posted: unknown;
    await processFeedbackSyncJob(repository, syncJob.data as FeedbackSyncJob, () => ({
      async createFeedback(input) {
        posted = input;
      }
    }));
    expect(posted).toMatchObject({ runId: "ls_e2e_run", key: "coeval_verdict", value: "pass" });
    const synced = await createApp(repository).request("/api/feedback-syncs?status=synced&limit=5");
    await expect(synced.json()).resolves.toMatchObject({
      feedbackSyncs: [{ provider: "langsmith", status: "synced", attempts: 0, lastError: null }]
    });
  });

  it("C7/B9: failure path — a sync-back error marks the job failed and stays retryable", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const imported = await repository.importTrace("proj_langsmith_support", "langsmith", {
      sourceTraceId: "ls_e2e_fail",
      input: { question: "q" },
      output: { answer: "a" },
      metadata: { source: "langsmith" }
    }, {
      ingestionPurpose: "analysis_eligible_langsmith",
      sourceIntegrationId: integration.id
    });
    const judgeProvider = {
      name: "test-worker-provider",
      async judge() {
        return { label: "fail" as const, score: 0.1, reason: "bad", confidence: 0.8 };
      },
      async judgeStructured() {
        return { verdict: { kind: "binary" as const, label: "fail" as const, score: 0.1, rationale: "bad" } };
      }
    };
    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, judgeProvider, queue);
    const syncJob = queue.jobs.find((job) => job.name === "feedback.sync")!;

    // Transient upstream failure (500): the job records failed + the error and
    // RETHROWS so pg-boss retries; a later success path stays possible.
    const transient = new LangSmithHttpError("LangSmith is down", 500, "createFeedback");
    await expect(processFeedbackSyncJob(repository, syncJob.data as FeedbackSyncJob, () => ({
      async createFeedback() {
        throw transient;
      }
    }))).rejects.toThrow("LangSmith is down");
    expect(isPermanentFeedbackSyncError(transient)).toBe(false);
    const failed = await createApp(repository).request("/api/feedback-syncs?status=failed&limit=5");
    await expect(failed.json()).resolves.toMatchObject({
      feedbackSyncs: [{ provider: "langsmith", status: "failed", attempts: 1, lastError: expect.stringContaining("LangSmith is down") }]
    });

    // Auth failure (401) is permanent: the worker wrapper drops it, no retry.
    expect(isPermanentFeedbackSyncError(new LangSmithHttpError("bad key", 401, "createFeedback"))).toBe(true);
  });

  it("counts only net-new traces as imported on LangSmith retries", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const createClient = () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_retry",
            input: { question: "Retry?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    });

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, createClient)).resolves.toEqual({ imported: 1, queued: 1 });

    const retryJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 1
    });
    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1,
      importJobId: retryJob.id
    }, createClient)).resolves.toEqual({ imported: 0, queued: 1 });

    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        id: retryJob.id,
        status: "completed",
        importedCount: 0,
        queuedJudgeCount: 1
      }
    ]);
  });

  it("keeps same import job net-new count across worker retries", async () => {
    const queue = new FailingOnceQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const importJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 2
    });
    const createClient = () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_retry_same_job_1",
            input: { question: "First?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          },
          {
            sourceTraceId: "ls_run_retry_same_job_2",
            input: { question: "Second?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    });

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2,
      importJobId: importJob.id
    }, createClient)).rejects.toThrow("Queue unavailable after trace import");

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2,
      importJobId: importJob.id
    }, createClient)).resolves.toEqual({ imported: 0, queued: 2 });

    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        id: importJob.id,
        status: "completed",
        importedCount: 2,
        queuedJudgeCount: 2,
        error: null
      }
    ]);
  });

  it("marks LangSmith import jobs completed or failed", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });
    const importJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 1
    });

    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1,
      importJobId: importJob.id
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_status",
            input: { question: "Status?" },
            output: { answer: "ok" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    }))).resolves.toEqual({ imported: 1, queued: 1 });
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        id: importJob.id,
        status: "completed",
        importedCount: 1,
        queuedJudgeCount: 1,
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        error: null
      }
    ]);

    const failedJob = await repository.createImportJob({
      projectId: "proj_langsmith_support",
      source: "langsmith",
      sourceIntegrationId: integration.id,
      requestedLimit: 1
    });
    await expect(processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1,
      importJobId: failedJob.id
    }, () => ({
      async listRuns() {
        throw new Error("LangSmith unavailable");
      }
    }))).rejects.toThrow("LangSmith unavailable");
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", status: "failed", limit: 5 })).resolves.toMatchObject([
      {
        id: failedJob.id,
        status: "failed",
        error: "LangSmith unavailable",
        completedAt: expect.any(String)
      }
    ]);
  });

  it("applies integration redaction rules during LangSmith import", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent",
      redaction: {
        excludedPaths: ["input.retrievalContext"]
      }
    });

    await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_sensitive_run",
            input: { question: "Refund?", retrievalContext: "large private context", api_key: "sk-live-secret" },
            output: { answer: "Refunds are available.", token: "customer-token" },
            metadata: { source: "langsmith" }
          }
        ];
      }
    }));

    const evalRunId = (queue.jobs[0]!.data as { evalRunId: string }).evalRunId;
    const caseId = (await repository.getEvalRunDetail("proj_langsmith_support", evalRunId))!.items[0]!.caseId;
    await expect(repository.loadJudgeRunContext({
      projectId: "proj_langsmith_support",
      caseId,
      skillVersionId: "skillv_1_2_0"
    })).resolves.toMatchObject({
      trace: {
        input: {
          question: "Refund?",
          retrievalContext: EXCLUDED_VALUE,
          api_key: REDACTED_VALUE
        },
        output: {
          answer: "Refunds are available.",
          token: REDACTED_VALUE
        }
      }
    });
  });
});

describe("LangSmith poller", () => {
  it("claims due integrations and enqueues import jobs once per interval", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent",
      pollIntervalSeconds: 60,
      pollLimit: 7
    });
    const now = new Date("2026-05-02T00:00:00.000Z");

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now,
      intervalMs: 60_000,
      importLimit: 7
    })).resolves.toEqual({ claimed: 1, queued: 1 });
    expect(queue.jobs).toEqual([
      {
        name: "langsmith.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 7,
          importJobId: expect.any(String)
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);
    await expect(repository.listImportJobs({ projectId: "proj_langsmith_support", limit: 5 })).resolves.toMatchObject([
      {
        source: "langsmith",
        sourceIntegrationId: integration.id,
        status: "queued",
        requestedLimit: 7,
        queueJobId: "job_1"
      }
    ]);

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now,
      intervalMs: 60_000,
      importLimit: 7
    })).resolves.toEqual({ claimed: 0, queued: 0 });
    expect(queue.jobs).toHaveLength(1);

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now: new Date("2026-05-02T00:01:01.000Z"),
      intervalMs: 60_000,
      importLimit: 7
    })).resolves.toEqual({ claimed: 1, queued: 1 });
    expect(queue.jobs).toHaveLength(2);
  });

  it("skips disabled LangSmith polling integrations", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent",
      pollEnabled: false
    });

    await expect(enqueueDueLangSmithImports(repository, queue, {
      now: new Date("2026-05-02T00:00:00.000Z"),
      importLimit: 100
    })).resolves.toEqual({ claimed: 0, queued: 0 });
    expect(queue.jobs).toHaveLength(0);
  });

  it("parses poll interval configuration defensively", () => {
    expect(parsePollIntervalMs("15000")).toBe(15000);
    expect(parsePollIntervalMs("not-a-number")).toBe(300000);
    expect(parsePollIntervalMs(undefined)).toBe(300000);
    expect(parsePollImportLimit("250")).toBe(100);
    expect(parsePollImportLimit("nope")).toBe(25);
  });
});

describe("Langfuse import worker", () => {
  it("imports Langfuse traces and enqueues judge jobs", async () => {
    const queue = new CapturingQueue();
    const repository = new PurposeCapturingRepository();
    const integration = await repository.createLangfuseIntegration("proj_langsmith_support", {
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test"
    });

    const result = await processLangfuseImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 2
    }, () => ({
      async listTraces() {
        return [
          {
            sourceTraceId: "lf_trace_1",
            input: { question: "Refund?" },
            output: { answer: "Refunds are available." },
            metadata: { source: "langfuse" }
          }
        ];
      }
    }));

    expect(result).toEqual({ imported: 1, queued: 1 });
    expect(repository.importedPurposes).toEqual(["analysis_eligible_langfuse"]);
    expect(queue.jobs).toEqual([
      {
        name: "eval.run",
        data: {
          projectId: "proj_langsmith_support",
          evalRunId: expect.any(String)
        },
        options: { id: expect.any(String), retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("claims due Langfuse integrations and enqueues import jobs once per interval", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createLangfuseIntegration("proj_langsmith_support", {
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      pollLimit: 7
    });

    await expect(enqueueDueLangfuseImports(repository, queue, {
      now: new Date("2026-05-01T00:00:00.000Z"),
      intervalMs: 300_000
    })).resolves.toEqual({ claimed: 1, queued: 1 });

    expect(queue.jobs).toEqual([
      {
        name: "langfuse.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 7,
          importJobId: expect.any(String)
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);

    await expect(enqueueDueLangfuseImports(repository, queue, {
      now: new Date("2026-05-01T00:01:00.000Z"),
      intervalMs: 300_000
    })).resolves.toEqual({ claimed: 0, queued: 0 });
  });
});
