import { describe, expect, it } from "vitest";
import type { QueueName, Queue } from "@coeval/queue";
import {
  IronsideClient,
  IronsideHttpError,
  ironsideTraceToTraceImport,
  type IronsideTraceTree
} from "../src/lib/ironside.js";
import {
  DemoRepository,
  IronsideCredentialsMissingError,
  IronsideIntegrationNotFoundError,
  NoCurrentSkillError
} from "../src/repository.js";
import { isPermanentIronsideImportError, processIronsideImportJob } from "../src/workers/ironside-import.js";
import {
  enqueueDueIronsideImports,
  parseIronsidePollImportLimit,
  parseIronsidePollIntervalMs
} from "../src/workers/ironside-poller.js";
import { processJudgeRunJob } from "../src/workers/judge.js";
import { processFeedbackSyncJob } from "../src/workers/feedback-sync.js";
import { MockJudgeProvider } from "@coeval/audit/runtime";

const PROJECT_ID = "proj_langsmith_support";

class PurposeCapturingRepository extends DemoRepository {
  readonly importedPurposes = new Array<string>();

  override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
    this.importedPurposes.push(args[3].ingestionPurpose);
    return super.importTrace(...args);
  }
}

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

function traceTree(overrides: Partial<IronsideTraceTree> = {}): IronsideTraceTree {
  return {
    id: "trace_1",
    timestamp: "2026-08-18T15:00:00.000Z",
    name: "pi:repo",
    userId: "user_1",
    sessionId: "session_1",
    environment: "dev",
    release: null,
    version: null,
    tags: ["a"],
    metadata: { repo: "repo" },
    input: { question: "Refund?" },
    output: { answer: "Yes." },
    observations: [],
    ...overrides
  };
}

describe("Ironside trace mapping", () => {
  it("normalizes a trace tree into a trace import with depth-first flattened steps", () => {
    const tree = traceTree({
      observations: [
        {
          id: "obs_root",
          parentObservationId: null,
          type: "span",
          name: "turn",
          startTime: "2026-08-18T15:00:00.000Z",
          endTime: null,
          level: "default",
          statusMessage: null,
          model: null,
          modelParameters: {},
          input: { q: 1 },
          output: { a: 1 },
          usageDetails: {},
          costDetails: {},
          completionStartTime: null,
          metadata: {},
          children: [
            {
              id: "obs_child",
              parentObservationId: "obs_root",
              type: "generation",
              name: "llm",
              startTime: "2026-08-18T15:00:01.000Z",
              endTime: null,
              level: "default",
              statusMessage: null,
              model: "claude",
              modelParameters: { temperature: "0" },
              input: { q: 2 },
              output: { a: 2 },
              usageDetails: { input_tokens: 5 },
              costDetails: {},
              completionStartTime: null,
              metadata: { k: "v" },
              children: []
            }
          ]
        },
        {
          id: "obs_sibling",
          parentObservationId: null,
          type: "event",
          name: "done",
          startTime: "2026-08-18T15:00:02.000Z",
          endTime: null,
          level: "default",
          statusMessage: null,
          model: null,
          modelParameters: {},
          input: null,
          output: null,
          usageDetails: {},
          costDetails: {},
          completionStartTime: null,
          metadata: {},
          children: []
        }
      ]
    });

    const imported = ironsideTraceToTraceImport(tree);
    expect(imported.sourceTraceId).toBe("trace_1");
    expect(imported.input).toEqual({ question: "Refund?" });
    expect(imported.output).toEqual({ answer: "Yes." });
    expect(imported.metadata).toEqual({
      source: "ironside",
      name: "pi:repo",
      timestamp: "2026-08-18T15:00:00.000Z",
      userId: "user_1",
      sessionId: "session_1",
      environment: "dev",
      tags: ["a"],
      extra: { repo: "repo" }
    });
    // depth-first: root, its child, then the sibling
    expect(imported.steps?.map((step) => step.name)).toEqual(["turn", "llm", "done"]);
    expect(imported.steps?.[1]).toEqual({
      name: "llm",
      input: { q: 2 },
      output: { a: 2 },
      metadata: {
        observationId: "obs_child",
        type: "generation",
        model: "claude",
        startTime: "2026-08-18T15:00:01.000Z",
        usageDetails: { input_tokens: 5 },
        k: "v"
      }
    });
  });

  it("caps flattened steps at the shared MAX_TRACE_STEPS", () => {
    const observations = Array.from({ length: 60 }, (_, index) => ({
      id: `obs_${index}`,
      parentObservationId: null,
      type: "span" as const,
      name: `step ${index}`,
      startTime: "2026-08-18T15:00:00.000Z",
      endTime: null,
      level: "default",
      statusMessage: null,
      model: null,
      modelParameters: {},
      input: null,
      output: null,
      usageDetails: {},
      costDetails: {},
      completionStartTime: null,
      metadata: {},
      children: []
    }));
    const imported = ironsideTraceToTraceImport(traceTree({ observations }));
    expect(imported.steps).toHaveLength(50);
  });
});

describe("Ironside client", () => {
  it("lists traces with Bearer auth, window filters, and keyset cursor", async () => {
    let captured: { url: URL; init?: RequestInit | undefined } | undefined;
    const client = new IronsideClient({
      url: "http://ironside.test:18788/",
      apiKey: "ironside_sk_test",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: new URL(String(input)), init };
        return new Response(JSON.stringify({
          traces: [{ id: "trace_1", timestamp: "2026-08-18T15:00:00.000Z", name: null, userId: null, sessionId: null, tags: [], metadata: {} }],
          nextCursor: "cursor_abc"
        }), { status: 200 });
      }) as typeof fetch
    });

    const page = await client.listTraces({
      from: "2026-08-18T00:00:00.000Z",
      to: "2026-08-18T15:00:00.000Z",
      cursor: "cursor_prev",
      limit: 25
    });

    expect(captured?.url.pathname).toBe("/api/v1/traces");
    expect(captured?.url.searchParams.get("from")).toBe("2026-08-18T00:00:00.000Z");
    expect(captured?.url.searchParams.get("to")).toBe("2026-08-18T15:00:00.000Z");
    expect(captured?.url.searchParams.get("cursor")).toBe("cursor_prev");
    expect(captured?.url.searchParams.get("limit")).toBe("25");
    expect(captured?.init?.headers).toMatchObject({ authorization: "Bearer ironside_sk_test" });
    expect(page.traces).toHaveLength(1);
    expect(page.nextCursor).toBe("cursor_abc");
  });

  it("fetches a trace tree by id and raises typed HTTP errors", async () => {
    const client = new IronsideClient({
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test",
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/v1/traces/trace_1")) {
          return new Response(JSON.stringify(traceTree()), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch
    });

    await expect(client.getTrace("trace_1")).resolves.toMatchObject({ id: "trace_1" });
    await expect(client.getTrace("missing")).rejects.toMatchObject({ status: 404, operation: "getTrace" });
  });

  it("posts Coeval verdicts as native score-upsert ingest events", async () => {
    let captured: { url: string; init?: RequestInit | undefined } | undefined;
    const client = new IronsideClient({
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), init };
        return new Response(JSON.stringify({ batchId: "b1", received: 1 }), { status: 202 });
      }) as typeof fetch
    });

    await client.createFeedback({
      feedbackId: "fsync_123",
      runId: "trace_123",
      key: "coeval_verdict",
      score: 0.8,
      value: "pass",
      comment: "accepted",
      sourceInfo: { judgeRunId: "judge_123" }
    });

    expect(captured?.url).toBe("http://ironside.test:18788/api/v1/ingest");
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.headers).toMatchObject({
      authorization: "Bearer ironside_sk_test",
      "content-type": "application/json"
    });
    const body = JSON.parse(String(captured?.init?.body)) as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toEqual({
      type: "score-upsert",
      // Reusing the durable feedback job id keeps retries idempotent on
      // ironside's side (idempotencyKey + score-id upsert).
      idempotencyKey: "fsync_123",
      body: {
        id: "fsync_123",
        traceId: "trace_123",
        name: "coeval_verdict",
        dataType: "numeric",
        value: 0.8,
        source: "api",
        comment: "pass: accepted",
        metadata: { verdict: "pass", judgeRunId: "judge_123" }
      }
    });
  });

  it("classifies auth/not-found errors as permanent worker failures", () => {
    expect(isPermanentIronsideImportError(new IronsideHttpError("revoked key", 401, "listTraces"))).toBe(true);
    expect(isPermanentIronsideImportError(new IronsideIntegrationNotFoundError("int_missing"))).toBe(true);
    expect(isPermanentIronsideImportError(new IronsideCredentialsMissingError("int_missing"))).toBe(true);
    expect(isPermanentIronsideImportError(new NoCurrentSkillError("proj_missing"))).toBe(true);
    expect(isPermanentIronsideImportError(new IronsideHttpError("rate limited", 429, "listTraces"))).toBe(false);
  });
});

describe("Ironside import worker (reconcile sweep)", () => {
  const now = new Date("2026-08-18T16:00:00.000Z");
  // default quiet period 300s → settled window ends at 15:55
  const settledTo = "2026-08-18T15:55:00.000Z";

  it("sweeps the settled window, imports traces, enqueues judge jobs, and advances the watermark", async () => {
    const queue = new CapturingQueue();
    const repository = new PurposeCapturingRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test"
    });

    const listCalls: Array<Record<string, unknown>> = [];
    const result = await processIronsideImportJob(repository, queue, {
      projectId: PROJECT_ID,
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 25
    }, () => ({
      async listTraces(input) {
        listCalls.push({ ...input });
        return {
          traces: [
            { id: "trace_1", timestamp: "2026-08-18T15:10:00.000Z", name: null, userId: null, sessionId: null, tags: [], metadata: {} }
          ],
          nextCursor: null
        };
      },
      async getTrace(id) {
        return traceTree({ id });
      }
    }), now);

    expect(result).toEqual({ imported: 1, queued: 1, scanned: 1, drained: true });
    expect(repository.importedPurposes).toEqual(["analysis_eligible_ironside"]);
    expect(listCalls).toEqual([{ to: settledTo, limit: 25 }]);
    expect(queue.jobs).toEqual([
      {
        name: "judge.run",
        data: { projectId: PROJECT_ID, caseId: expect.any(String), skillVersionId: "skillv_1_2_0" },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);

    const context = await repository.loadIronsideImportContext({ projectId: PROJECT_ID, integrationId: integration.id, limit: 25 });
    expect(context.syncState).toEqual({ watermark: settledTo, cursor: null, windowTo: null });
  });

  it("persists the keyset cursor when the budget is hit and resumes the SAME window next run", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test",
      pollLimit: 1
    });

    const listCalls: Array<Record<string, unknown>> = [];
    const client = {
      async listTraces(input: { cursor?: string | undefined }) {
        listCalls.push({ ...input });
        if (!input.cursor) {
          return {
            traces: [{ id: "trace_new", timestamp: "2026-08-18T15:50:00.000Z", name: null, userId: null, sessionId: null, tags: [], metadata: {} }],
            nextCursor: "cursor_page2"
          };
        }
        return {
          traces: [{ id: "trace_old", timestamp: "2026-08-18T15:10:00.000Z", name: null, userId: null, sessionId: null, tags: [], metadata: {} }],
          nextCursor: null
        };
      },
      async getTrace(id: string) {
        return traceTree({ id });
      }
    };

    const first = await processIronsideImportJob(repository, queue, {
      projectId: PROJECT_ID,
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, () => client, now);
    expect(first).toEqual({ imported: 1, queued: 1, scanned: 1, drained: false });

    let context = await repository.loadIronsideImportContext({ projectId: PROJECT_ID, integrationId: integration.id, limit: 1 });
    expect(context.syncState).toEqual({ watermark: null, cursor: "cursor_page2", windowTo: settledTo });

    // Second run resumes with the stored cursor against the STORED window end,
    // even though "now" moved on.
    const later = new Date("2026-08-18T16:10:00.000Z");
    const second = await processIronsideImportJob(repository, queue, {
      projectId: PROJECT_ID,
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 1
    }, () => client, later);
    expect(second).toEqual({ imported: 1, queued: 1, scanned: 1, drained: true });
    expect(listCalls).toEqual([
      { to: settledTo, limit: 1 },
      { to: settledTo, cursor: "cursor_page2", limit: 1 }
    ]);

    context = await repository.loadIronsideImportContext({ projectId: PROJECT_ID, integrationId: integration.id, limit: 1 });
    expect(context.syncState).toEqual({ watermark: settledTo, cursor: null, windowTo: null });
  });

  it("does nothing when no traces settled since the last sweep", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test"
    });
    await repository.saveIronsideSyncState(PROJECT_ID, integration.id, {
      watermark: "2026-08-18T15:58:00.000Z",
      cursor: null,
      windowTo: null
    });

    const result = await processIronsideImportJob(repository, queue, {
      projectId: PROJECT_ID,
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 25
    }, () => ({
      async listTraces() {
        throw new Error("must not list when the window is empty");
      },
      async getTrace(): Promise<IronsideTraceTree> {
        throw new Error("must not fetch");
      }
    }), now);

    expect(result).toEqual({ imported: 0, queued: 0, scanned: 0, drained: true });
    expect(queue.jobs).toEqual([]);
    // watermark must NOT move backwards to the (older) settled bound
    const context = await repository.loadIronsideImportContext({ projectId: PROJECT_ID, integrationId: integration.id, limit: 25 });
    expect(context.syncState.watermark).toBe("2026-08-18T15:58:00.000Z");
  });

  it("re-imports an already-imported trace as a no-op (idempotent overlap)", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test"
    });
    const client = {
      async listTraces() {
        return {
          traces: [{ id: "trace_dup", timestamp: "2026-08-18T15:10:00.000Z", name: null, userId: null, sessionId: null, tags: [], metadata: {} }],
          nextCursor: null
        };
      },
      async getTrace(id: string) {
        return traceTree({ id });
      }
    };

    const first = await processIronsideImportJob(repository, queue, { projectId: PROJECT_ID, integrationId: integration.id, skillVersionId: "skillv_1_2_0", limit: 25 }, () => client, now);
    expect(first.imported).toBe(1);

    await repository.saveIronsideSyncState(PROJECT_ID, integration.id, { watermark: null, cursor: null, windowTo: null });
    const second = await processIronsideImportJob(repository, queue, { projectId: PROJECT_ID, integrationId: integration.id, skillVersionId: "skillv_1_2_0", limit: 25 }, () => client, now);
    expect(second.imported).toBe(0);
    expect(second.scanned).toBe(1);
  });
});

describe("Ironside poller", () => {
  it("claims due ironside integrations and enqueues import jobs once per interval", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test",
      pollLimit: 7
    });

    await expect(enqueueDueIronsideImports(repository, queue, {
      now: new Date("2026-05-01T00:00:00.000Z"),
      intervalMs: 300_000
    })).resolves.toEqual({ claimed: 1, queued: 1 });

    expect(queue.jobs).toEqual([
      {
        name: "ironside.import",
        data: {
          projectId: PROJECT_ID,
          integrationId: integration.id,
          skillVersionId: "skillv_1_2_0",
          limit: 7,
          importJobId: expect.any(String)
        },
        options: { retryLimit: 5, retryBackoff: true }
      }
    ]);

    await expect(enqueueDueIronsideImports(repository, queue, {
      now: new Date("2026-05-01T00:01:00.000Z"),
      intervalMs: 300_000
    })).resolves.toEqual({ claimed: 0, queued: 0 });
  });

  it("parses poll configuration defensively", () => {
    expect(parseIronsidePollIntervalMs("15000")).toBe(15000);
    expect(parseIronsidePollIntervalMs("nope")).toBe(300000);
    expect(parseIronsidePollIntervalMs(undefined)).toBe(300000);
    expect(parseIronsidePollImportLimit("250")).toBe(100);
    expect(parseIronsidePollImportLimit("nope")).toBe(25);
  });
});

describe("Ironside feedback sync", () => {
  it("enqueues and posts verdict scores for judged ironside cases", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test"
    });
    const imported = await repository.importTrace(PROJECT_ID, "ironside", {
      sourceTraceId: "ironside_trace_feedback",
      input: { question: "Refund?" },
      output: { answer: "Refunds are available." },
      metadata: { source: "ironside" }
    }, {
      ingestionPurpose: "analysis_eligible_ironside",
      sourceIntegrationId: integration.id
    });

    await processJudgeRunJob(repository, {
      projectId: PROJECT_ID,
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    }, new MockJudgeProvider(), queue);

    const feedbackJob = queue.jobs.find((job) => job.name === "feedback.sync");
    expect(feedbackJob).toBeDefined();

    let captured: { url: string; init?: RequestInit | undefined } | undefined;
    await processFeedbackSyncJob(repository, feedbackJob!.data as { projectId: string; feedbackSyncJobId: string }, (context) => {
      expect(context.provider).toBe("ironside");
      return new IronsideClient({
        url: "http://ironside.test:18788",
        apiKey: "ironside_sk_test",
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          captured = { url: String(input), init };
          return new Response(JSON.stringify({ batchId: "b1", received: 1 }), { status: 202 });
        }) as typeof fetch
      });
    });

    expect(captured?.url).toBe("http://ironside.test:18788/api/v1/ingest");
    const body = JSON.parse(String(captured?.init?.body)) as { events: Array<{ body: { traceId: string } }> };
    expect(body.events[0]?.body.traceId).toBe("ironside_trace_feedback");
  });
});
