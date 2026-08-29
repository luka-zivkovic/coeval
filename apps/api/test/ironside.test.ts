import { describe, expect, it } from "vitest";
import type { QueueName, Queue } from "@coeval/queue";
import type { IronsideEvaluatorContext, IronsideEvaluatorTrace } from "@coeval/shared";
import { MockJudgeProvider } from "@coeval/audit/runtime";
import { IronsideClient, IronsideHttpError, ironsideTraceToTraceImport } from "../src/lib/ironside.js";
import {
  DemoRepository,
  IronsideCredentialsMissingError,
  IronsideIntegrationNotFoundError,
  NoCurrentSkillError
} from "../src/repository.js";
import { isPermanentIronsideImportError, processIronsideImportJob } from "../src/workers/ironside-import.js";
import { enqueueDueIronsideImports, parseIronsidePollImportLimit, parseIronsidePollIntervalMs } from "../src/workers/ironside-poller.js";
import { processJudgeRunJob } from "../src/workers/judge.js";
import { processFeedbackSyncJob } from "../src/workers/feedback-sync.js";

const PROJECT_ID = "proj_langsmith_support";
const TRACE_VERSION_1 = "2026-08-18T15:05:00.000Z";
const TRACE_VERSION_2 = "2026-08-18T15:15:00.000Z";

const remoteContext: IronsideEvaluatorContext = {
  protocolVersion: "ironside/evaluator/v1",
  project: { id: "project_remote", name: "Production agents" },
  capabilities: ["traces:read", "scores:write"],
  settlement: { kind: "quiet_period", quietPeriodSeconds: 300 }
};

class PurposeCapturingRepository extends DemoRepository {
  readonly imports = new Array<{ purpose: string; version?: string | undefined }>();

  override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
    this.imports.push({ purpose: args[3].ingestionPurpose, version: args[3].sourceTraceVersion });
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

function traceTree(overrides: Partial<IronsideEvaluatorTrace> = {}): IronsideEvaluatorTrace {
  return {
    id: "trace_1",
    traceVersion: TRACE_VERSION_1,
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

function summary(id = "trace_1", traceVersion = TRACE_VERSION_1) {
  return {
    traceId: id,
    traceVersion,
    timestamp: "2026-08-18T15:00:00.000Z",
    name: null,
    userId: null,
    sessionId: null,
    environment: null,
    tags: [],
    metadata: {}
  };
}

describe("Ironside native evaluator client", () => {
  it("validates project identity, protocol, and scoped capabilities", async () => {
    const client = new IronsideClient({
      url: "http://ironside.test:18788/",
      apiKey: "ironside_sk_test",
      fetchImpl: (async () => new Response(JSON.stringify(remoteContext), { status: 200 })) as typeof fetch
    });
    await expect(client.getContext()).resolves.toEqual(remoteContext);
  });

  it("uses the opaque evaluator feed cursor and exact trace version", async () => {
    const requests: URL[] = [];
    const client = new IronsideClient({
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test",
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requests.push(url);
        if (url.pathname.endsWith("/trace_1")) return new Response(JSON.stringify(traceTree()), { status: 200 });
        return new Response(JSON.stringify({
          protocolVersion: "ironside/evaluator/v1",
          traces: [summary()],
          nextCursor: "cursor_next",
          hasMore: false
        }), { status: 200 });
      }) as typeof fetch
    });

    await expect(client.listTraces({ cursor: "cursor_prev", limit: 25 })).resolves.toMatchObject({ nextCursor: "cursor_next" });
    await expect(client.getTrace("trace_1", TRACE_VERSION_1)).resolves.toMatchObject({ id: "trace_1", traceVersion: TRACE_VERSION_1 });
    expect(requests[0]?.pathname).toBe("/api/v1/evaluator/traces");
    expect(requests[0]?.searchParams.get("cursor")).toBe("cursor_prev");
    expect(requests[1]?.searchParams.get("version")).toBe(TRACE_VERSION_1);
  });

  it("writes a criterion-specific native assessment", async () => {
    let captured: { url: string; init?: RequestInit | undefined } | undefined;
    const client = new IronsideClient({
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), init };
        return new Response(JSON.stringify({ id: "fsync_123" }), { status: 201 });
      }) as typeof fetch
    });
    await client.createFeedback({
      feedbackId: "fsync_123",
      runId: "trace_123",
      key: "coeval_assessment/response-quality",
      score: 0.8,
      value: "pass",
      comment: "accepted",
      sourceInfo: { skillVersionId: "skillv_1", criterionKey: "response-quality", judgeRunId: "judge_123" }
    });
    expect(captured?.url).toBe("http://ironside.test:18788/api/v1/evaluator/scores");
    expect(JSON.parse(String(captured?.init?.body))).toMatchObject({
      id: "fsync_123",
      traceId: "trace_123",
      name: "coeval_assessment/response-quality",
      value: 0.8,
      assessmentLabel: "pass",
      evaluator: { provider: "coeval", versionId: "skillv_1", criterionKey: "response-quality" }
    });
  });

  it("classifies credential and missing-resource errors as permanent", () => {
    expect(isPermanentIronsideImportError(new IronsideHttpError("revoked", 401, "listTraces"))).toBe(true);
    expect(isPermanentIronsideImportError(new IronsideIntegrationNotFoundError("missing"))).toBe(true);
    expect(isPermanentIronsideImportError(new IronsideCredentialsMissingError("missing"))).toBe(true);
    expect(isPermanentIronsideImportError(new NoCurrentSkillError("missing"))).toBe(true);
    expect(isPermanentIronsideImportError(new IronsideHttpError("busy", 429, "listTraces"))).toBe(false);
  });
});

describe("Ironside versioned feed import", () => {
  it("persists the opaque cursor and imports reopened trace versions independently", async () => {
    const queue = new CapturingQueue();
    const repository = new PurposeCapturingRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test"
    }, remoteContext);
    let page = 0;
    const client = {
      async getContext() { return remoteContext; },
      async listTraces(input: { cursor?: string | undefined }) {
        page += 1;
        expect(input.cursor).toBe(page === 1 ? undefined : "cursor_v1");
        const version = page === 1 ? TRACE_VERSION_1 : TRACE_VERSION_2;
        return {
          protocolVersion: "ironside/evaluator/v1" as const,
          traces: [summary("trace_reopened", version)],
          nextCursor: page === 1 ? "cursor_v1" : "cursor_v2",
          hasMore: false
        };
      },
      async getTrace(id: string, version: string) { return traceTree({ id, traceVersion: version }); }
    };

    const first = await processIronsideImportJob(repository, queue, {
      projectId: PROJECT_ID, integrationId: integration.id, skillVersionId: "skillv_1_2_0", limit: 25
    }, () => client);
    const second = await processIronsideImportJob(repository, queue, {
      projectId: PROJECT_ID, integrationId: integration.id, skillVersionId: "skillv_1_2_0", limit: 25
    }, () => client);

    expect(first).toEqual({ imported: 1, queued: 1, scanned: 1, drained: true });
    expect(second).toEqual({ imported: 1, queued: 1, scanned: 1, drained: true });
    expect(repository.imports).toEqual([
      { purpose: "analysis_eligible_ironside", version: TRACE_VERSION_1 },
      { purpose: "analysis_eligible_ironside", version: TRACE_VERSION_2 }
    ]);
    await expect(repository.loadIronsideImportContext({ projectId: PROJECT_ID, integrationId: integration.id, limit: 25 }))
      .resolves.toMatchObject({ syncState: { cursor: "cursor_v2" } });
  });

  it("advances past a version that reopened before detail retrieval", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788", apiKey: "ironside_sk_test"
    }, remoteContext);
    const result = await processIronsideImportJob(repository, queue, {
      projectId: PROJECT_ID, integrationId: integration.id, skillVersionId: "skillv_1_2_0", limit: 25
    }, () => ({
      async getContext() { return remoteContext; },
      async listTraces() {
        return { protocolVersion: "ironside/evaluator/v1", traces: [summary()], nextCursor: "cursor_after", hasMore: false } as const;
      },
      async getTrace() { throw new IronsideHttpError("reopened", 409, "getTrace"); }
    }));
    expect(result).toEqual({ imported: 0, queued: 0, scanned: 1, drained: true });
    await expect(repository.loadIronsideImportContext({ projectId: PROJECT_ID, integrationId: integration.id, limit: 25 }))
      .resolves.toMatchObject({ syncState: { cursor: "cursor_after" } });
  });
});

describe("Ironside polling and feedback", () => {
  it("claims a due integration once per interval", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788", apiKey: "ironside_sk_test", pollLimit: 7
    }, remoteContext);
    await expect(enqueueDueIronsideImports(repository, queue, {
      now: new Date("2026-05-01T00:00:00.000Z"), intervalMs: 300_000
    })).resolves.toEqual({ claimed: 1, queued: 1 });
    expect(queue.jobs[0]).toMatchObject({
      name: "ironside.import",
      data: { projectId: PROJECT_ID, integrationId: integration.id, skillVersionId: "skillv_1_2_0", limit: 7 }
    });
    await expect(enqueueDueIronsideImports(repository, queue, {
      now: new Date("2026-05-01T00:01:00.000Z"), intervalMs: 300_000
    })).resolves.toEqual({ claimed: 0, queued: 0 });
  });

  it("writes judged assessments back to the original Ironside trace id", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(PROJECT_ID, {
      url: "http://ironside.test:18788", apiKey: "ironside_sk_test"
    }, remoteContext);
    const imported = await repository.importTrace(PROJECT_ID, "ironside", {
      sourceTraceId: "ironside_trace_feedback",
      input: { question: "Refund?" },
      output: { answer: "Refunds are available." },
      metadata: { source: "ironside" }
    }, {
      ingestionPurpose: "analysis_eligible_ironside",
      sourceIntegrationId: integration.id,
      sourceTraceVersion: TRACE_VERSION_1
    });
    await processJudgeRunJob(repository, {
      projectId: PROJECT_ID, caseId: imported.caseId, skillVersionId: "skillv_1_2_0"
    }, new MockJudgeProvider(), queue);
    const feedbackJob = queue.jobs.find((job) => job.name === "feedback.sync");
    let body: Record<string, unknown> | undefined;
    await processFeedbackSyncJob(repository, feedbackJob!.data as { projectId: string; feedbackSyncJobId: string }, () => new IronsideClient({
      url: "http://ironside.test:18788",
      apiKey: "ironside_sk_test",
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "score_1" }), { status: 201 });
      }) as typeof fetch
    }));
    expect(body).toMatchObject({
      traceId: "ironside_trace_feedback",
      name: "coeval_assessment/response-quality"
    });
  });

  it("parses poll configuration defensively", () => {
    expect(parseIronsidePollIntervalMs("15000")).toBe(15000);
    expect(parseIronsidePollIntervalMs("nope")).toBe(300000);
    expect(parseIronsidePollImportLimit("250")).toBe(100);
    expect(parseIronsidePollImportLimit("nope")).toBe(25);
  });
});

describe("Ironside trace mapping", () => {
  it("flattens observation trees and retains the remote version in metadata", () => {
    const imported = ironsideTraceToTraceImport(traceTree({
      observations: [{
        id: "obs_root", parentObservationId: null, type: "span", name: "turn",
        startTime: "2026-08-18T15:00:00.000Z", endTime: null, level: "default",
        statusMessage: null, model: null, modelParameters: {}, input: { q: 1 }, output: { a: 1 },
        usageDetails: {}, costDetails: {}, completionStartTime: null, metadata: {}, children: []
      }]
    }));
    expect(imported.sourceTraceId).toBe("trace_1");
    expect(imported.metadata).toMatchObject({ source: "ironside", sourceTraceVersion: TRACE_VERSION_1 });
    expect(imported.steps?.map((step) => step.name)).toEqual(["turn"]);
  });
});
