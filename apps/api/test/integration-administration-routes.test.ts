import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Queue, QueueName } from "@coeval/queue";
import { createApp } from "../src/app.js";
import { LangSmithHttpError } from "../src/lib/langsmith.js";
import { DemoRepository } from "../src/repository.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { registerIntegrationAdministrationRoutes } from "../src/routes/integration-administration.js";

describe("integration administration routes", () => {
  it("owns the exact contiguous import, integration, and feedback route family", () => {
    const repository = new DemoRepository();
    const app = new Hono<{ Variables: AppVariables }>();
    registerIntegrationAdministrationRoutes(app, {
      repository,
      requestServices: createRequestServices({
        repository,
        ownerAuthorizationEnabled: false,
        rateLimitPerMinute: 60,
        batchMaxItems: 100
      })
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/import-jobs",
      "GET /api/integrations/langsmith",
      "POST /api/integrations/langsmith",
      "PATCH /api/integrations/langsmith/:integrationId",
      "DELETE /api/integrations/langsmith/:integrationId",
      "POST /api/integrations/langsmith/:integrationId/test",
      "POST /api/integrations/langsmith/:integrationId/import",
      "GET /api/integrations/langfuse",
      "POST /api/integrations/langfuse",
      "PATCH /api/integrations/langfuse/:integrationId",
      "DELETE /api/integrations/langfuse/:integrationId",
      "POST /api/integrations/langfuse/:integrationId/test",
      "POST /api/integrations/langfuse/:integrationId/import",
      "GET /api/integrations/ironside",
      "POST /api/integrations/ironside",
      "PATCH /api/integrations/ironside/:integrationId",
      "DELETE /api/integrations/ironside/:integrationId",
      "POST /api/integrations/ironside/:integrationId/test",
      "POST /api/integrations/ironside/:integrationId/import",
      "GET /api/feedback-syncs"
    ]);
  });
});


class CapturingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: object; options?: object | undefined }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_name: QueueName, _handler: (job: { id: string; data: T }) => Promise<void>): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    this.jobs.push({ name, data, options });
    return `job_${this.jobs.length}`;
  }
}

describe("integration administration behavior", () => {
  it("creates a LangSmith integration and enqueues an import job", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    let listRunsCalled = 0;
    const appWithQueue = createApp(repository, {
      queue,
      langSmithClientFactory: () => ({
        async listRuns(input) {
          listRunsCalled += 1;
          expect(input).toMatchObject({ projectName: "Support Agent", limit: 1 });
          return [
            {
              sourceTraceId: "ls_test_connection",
              input: { question: "Health?" },
              output: { answer: "ok" },
              metadata: { source: "langsmith" }
            }
          ];
        }
      })
    });
    const createResponse = await appWithQueue.request("/api/integrations/langsmith", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "ls_test_key", projectName: "Support Agent" })
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as { integration: { id: string } };

    const listResponse = await appWithQueue.request("/api/integrations/langsmith");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      integrations: [
        {
          id: createBody.integration.id,
          pollEnabled: true,
          pollIntervalSeconds: 300,
          pollLimit: 25
        }
      ]
    });

    const patchResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollEnabled: false, pollIntervalSeconds: 600, pollLimit: 11 })
    });
    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({
      integration: {
        id: createBody.integration.id,
        pollEnabled: false,
        pollIntervalSeconds: 600,
        pollLimit: 11
      }
    });

    const testResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testResponse.status).toBe(200);
    await expect(testResponse.json()).resolves.toMatchObject({
      ok: true,
      sampleRunCount: 1
    });
    expect(listRunsCalled).toBe(1);

    const listAfterTest = await appWithQueue.request("/api/integrations/langsmith");
    expect(listAfterTest.status).toBe(200);
    await expect(listAfterTest.json()).resolves.toMatchObject({
      integrations: [
        {
          id: createBody.integration.id,
          lastTestedAt: expect.any(String),
          lastTestResult: {
            ok: true,
            sampleRunCount: 1
          }
        }
      ]
    });

    const importResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });

    expect(importResponse.status).toBe(202);
    const importBody = (await importResponse.json()) as { importJob: { id: string } };
    expect(importBody).toMatchObject({
      queued: true,
      queueJobId: "job_1",
      importJob: {
        id: expect.any(String),
        status: "queued",
        requestedLimit: 3,
        queueJobId: "job_1",
        createdAt: expect.any(String),
        startedAt: null
      }
    });
    expect(queue.jobs).toEqual([
      {
        name: "langsmith.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: createBody.integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 3,
          importJobId: importBody.importJob.id
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);
    const importJobsResponse = await appWithQueue.request("/api/import-jobs?limit=5");
    await expect(importJobsResponse.json()).resolves.toMatchObject({
      importJobs: [
        {
          id: importBody.importJob.id,
          status: "queued",
          requestedLimit: 3,
          queueJobId: "job_1",
          createdAt: expect.any(String),
          startedAt: null
        }
      ]
    });

    const deleteResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

    const listAfterDelete = await appWithQueue.request("/api/integrations/langsmith");
    await expect(listAfterDelete.json()).resolves.toEqual({ integrations: [] });

    const patchAfterDelete = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollEnabled: true })
    });
    expect(patchAfterDelete.status).toBe(404);

    const secondDeleteResponse = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
      method: "DELETE"
    });
    expect(secondDeleteResponse.status).toBe(404);

    const testAfterDelete = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testAfterDelete.status).toBe(404);

    const importAfterDelete = await appWithQueue.request(`/api/integrations/langsmith/${createBody.integration.id}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });
    expect(importAfterDelete.status).toBe(404);
  });

  it("creates a Langfuse integration and enqueues an import job", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    let listTracesCalled = 0;
    const appWithQueue = createApp(repository, {
      queue,
      langfuseClientFactory: () => ({
        async listTraces(input) {
          listTracesCalled += 1;
          expect(input).toEqual({ limit: 1 });
          return [
            {
              sourceTraceId: "lf_test_connection",
              input: { question: "Health?" },
              output: { answer: "ok" },
              metadata: { source: "langfuse" }
            }
          ];
        }
      })
    });
    const createResponse = await appWithQueue.request("/api/integrations/langfuse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "pk-lf-test", secretKey: "sk-lf-test" })
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as { integration: { id: string } };

    const testResponse = await appWithQueue.request(`/api/integrations/langfuse/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testResponse.status).toBe(200);
    await expect(testResponse.json()).resolves.toMatchObject({
      ok: true,
      sampleRunCount: 1
    });
    expect(listTracesCalled).toBe(1);

    const importResponse = await appWithQueue.request(`/api/integrations/langfuse/${createBody.integration.id}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });

    expect(importResponse.status).toBe(202);
    const importBody = (await importResponse.json()) as { importJob: { id: string } };
    expect(importBody).toMatchObject({
      queued: true,
      queueJobId: "job_1",
      importJob: {
        id: expect.any(String),
        source: "langfuse",
        sourceIntegrationId: createBody.integration.id,
        status: "queued",
        requestedLimit: 3
      }
    });
    expect(queue.jobs).toEqual([
      {
        name: "langfuse.import",
        data: {
          projectId: "proj_langsmith_support",
          integrationId: createBody.integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 3,
          importJobId: importBody.importJob.id
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("returns 500 for unexpected LangSmith integration mutation failures", async () => {
    const updateRepository = new class extends DemoRepository {
      override async updateLangSmithIntegration(): Promise<never> {
        throw new Error("Unexpected LangSmith update failure");
      }
    }();
    const updateResponse = await createApp(updateRepository).request("/api/integrations/langsmith/int_boom", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollEnabled: false })
    });
    expect(updateResponse.status).toBe(500);
    await expect(updateResponse.json()).resolves.toMatchObject({ error: "Internal server error" });

    const deleteRepository = new class extends DemoRepository {
      override async deleteLangSmithIntegration(): Promise<never> {
        throw new Error("Unexpected LangSmith delete failure");
      }
    }();
    const deleteResponse = await createApp(deleteRepository).request("/api/integrations/langsmith/int_boom", {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(500);
    await expect(deleteResponse.json()).resolves.toMatchObject({ error: "Internal server error" });

    const importRepository = new class extends DemoRepository {
      override async loadLangSmithImportContext(): Promise<never> {
        throw new Error("Unexpected LangSmith import context failure");
      }
    }();
    const importResponse = await createApp(importRepository, { queue: new CapturingQueue() }).request("/api/integrations/langsmith/int_boom/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });
    expect(importResponse.status).toBe(500);
    await expect(importResponse.json()).resolves.toMatchObject({ error: "Internal server error" });
  });

  it("persists failed LangSmith connection test details", async () => {
    const repository = new DemoRepository();
    const appWithRepository = createApp(repository, {
      langSmithClientFactory: () => ({
        async listRuns() {
          throw new LangSmithHttpError("LangSmith runs request failed: 401", 401, "listRuns");
        }
      })
    });
    const createResponse = await appWithRepository.request("/api/integrations/langsmith", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "ls_revoked", projectName: "Support Agent" })
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as { integration: { id: string } };

    const testResponse = await appWithRepository.request(`/api/integrations/langsmith/${createBody.integration.id}/test`, {
      method: "POST"
    });
    expect(testResponse.status).toBe(502);
    await expect(testResponse.json()).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "LangSmith runs request failed: 401"
    });

    const listResponse = await appWithRepository.request("/api/integrations/langsmith");
    await expect(listResponse.json()).resolves.toMatchObject({
      integrations: [
        {
          id: createBody.integration.id,
          lastTestedAt: expect.any(String),
          lastTestResult: {
            ok: false,
            status: 401,
            error: "LangSmith runs request failed: 401"
          }
        }
      ]
    });
  });

  it("rejects LangSmith poll intervals below the global ticker", async () => {
    const previousInterval = process.env.LANGSMITH_POLL_INTERVAL_MS;
    process.env.LANGSMITH_POLL_INTERVAL_MS = "300000";
    try {
      const response = await createApp(new DemoRepository()).request("/api/integrations/langsmith", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: "ls_test_key",
          projectName: "Support Agent",
          pollIntervalSeconds: 60
        })
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("pollIntervalSeconds must be at least 300 seconds")
      });
    } finally {
      if (previousInterval === undefined) {
        delete process.env.LANGSMITH_POLL_INTERVAL_MS;
      } else {
        process.env.LANGSMITH_POLL_INTERVAL_MS = previousInterval;
      }
    }
  });

  it("rejects LangSmith integration updates below the global ticker", async () => {
    const previousInterval = process.env.LANGSMITH_POLL_INTERVAL_MS;
    process.env.LANGSMITH_POLL_INTERVAL_MS = "300000";
    try {
      const repository = new DemoRepository();
      const appWithRepository = createApp(repository);
      const createResponse = await appWithRepository.request("/api/integrations/langsmith", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "ls_test_key", projectName: "Support Agent" })
      });
      const createBody = (await createResponse.json()) as { integration: { id: string } };

      const response = await appWithRepository.request(`/api/integrations/langsmith/${createBody.integration.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollIntervalSeconds: 60 })
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("pollIntervalSeconds must be at least 300 seconds")
      });
    } finally {
      if (previousInterval === undefined) {
        delete process.env.LANGSMITH_POLL_INTERVAL_MS;
      } else {
        process.env.LANGSMITH_POLL_INTERVAL_MS = previousInterval;
      }
    }
  });
});
