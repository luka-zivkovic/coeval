import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Hono } from "hono";
import type {
  Queue,
  QueueName,
  QueueSendOptions
} from "@coeval/queue";
import type { DatasetRevisionDetail } from "@coeval/shared";
import type { CoevalRepository } from "../src/repository.js";
import {
  AmbiguousProjectSkillError,
  DemoRepository,
  NoCurrentSkillError,
  SealedValidationUnavailableError
} from "../src/repository.js";
import {
  createRequestServices,
  type AppVariables
} from "../src/request-services/index.js";
import { createTokenBucket } from "../src/request-services/rate-limit.js";

const PROJECT_ID = "proj_langsmith_support";

class RecordingQueue implements Queue {
  readonly sent: Array<{ name: QueueName; data: object; options?: QueueSendOptions }> = [];

  constructor(private readonly events: string[] = []) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work(): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: QueueSendOptions): Promise<string> {
    this.events.push("send");
    this.sent.push({ name, data, ...(options ? { options } : {}) });
    return options?.id ?? `job_${this.sent.length}`;
  }
}

async function datasetFixture(repository: DemoRepository, suffix: string) {
  const imported = await repository.importTrace(PROJECT_ID, "manual", {
    sourceTraceId: `request_service_${suffix}`,
    input: { question: "Can this run?" },
    output: { answer: "Yes" },
    metadata: {}
  }, { ingestionPurpose: "analysis_eligible_manual" });
  const dataset = await repository.createDataset({
    projectId: PROJECT_ID,
    name: `Request service dataset ${suffix}`
  });
  await repository.addDatasetItems({
    projectId: PROJECT_ID,
    datasetId: dataset.id,
    items: [{ caseId: imported.caseId, expectedLabel: "pass" }]
  });
  const detail = await repository.getDatasetDetail(PROJECT_ID, dataset.id);
  if (!detail) throw new Error("Dataset fixture was not created");
  return detail;
}

function revisionFixture(
  overrides: Pick<DatasetRevisionDetail, "role" | "sourceKind" | "items">
): DatasetRevisionDetail {
  return {
    id: "dsr_request_service",
    role: overrides.role,
    sourceKind: overrides.sourceKind,
    items: overrides.items
  } as DatasetRevisionDetail;
}

describe("request services", () => {
  it("keeps one token budget per identity and refills from one clock", () => {
    let now = 0;
    const bucket = createTokenBucket({
      capacity: 3,
      refillPerMinute: 2,
      now: () => now
    });

    expect(bucket.take("key_a", 3)).toBe(true);
    expect(bucket.take("key_a", 1)).toBe(false);
    expect(bucket.take("key_b", 1)).toBe(true);

    now = 30_000;
    expect(bucket.take("key_a", 1)).toBe(true);
    expect(bucket.take("key_a", 1)).toBe(false);
  });

  it("resolves versions through the shared lifecycle authorization path", async () => {
    type AuthorizationInput = Parameters<CoevalRepository["authorizeSkillVersionExecution"]>[0];
    const authorizations: AuthorizationInput[] = [];
    const repository = new class extends DemoRepository {
      override async authorizeSkillVersionExecution(input: AuthorizationInput): Promise<void> {
        authorizations.push(input);
      }
    }();
    const services = createRequestServices({
      repository,
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });

    const resolved = await services.resolveSkillVersionId(PROJECT_ID, undefined, {
      context: "trace_test",
      resourceKind: "trace_test_revision",
      resourceId: "ttr_1"
    });

    expect(resolved).toEqual({ id: "skillv_1_2_0" });
    expect(authorizations).toEqual([{
      projectId: PROJECT_ID,
      skillVersionId: "skillv_1_2_0",
      context: "trace_test",
      resourceKind: "trace_test_revision",
      resourceId: "ttr_1",
      idempotencyKey: "route-auth:trace_test:trace_test_revision:ttr_1:skillv_1_2_0"
    }]);
  });

  it("returns authorization failures as route-safe invalid results", async () => {
    const repository = new class extends DemoRepository {
      override async authorizeSkillVersionExecution(): Promise<void> {
        throw new Error("Evaluator version is inactive");
      }
    }();
    const services = createRequestServices({
      repository,
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });

    await expect(services.resolveSkillVersionId(PROJECT_ID, "skillv_1_2_0"))
      .resolves.toEqual({ invalid: "Evaluator version is inactive" });
  });

  it("preserves exact unknown, ambiguous, and missing-version failures", async () => {
    const unknownServices = createRequestServices({
      repository: new DemoRepository(),
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });
    await expect(unknownServices.resolveSkillVersionId(PROJECT_ID, "skillv_foreign"))
      .resolves.toEqual({
        invalid: "Unknown skillVersionId for this project: skillv_foreign"
      });

    const ambiguousServices = createRequestServices({
      repository: new class extends DemoRepository {
        override async getCurrentSkill(): Promise<never> {
          throw new AmbiguousProjectSkillError(PROJECT_ID, 2);
        }
      }(),
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });
    await expect(ambiguousServices.resolveSkillVersionId(PROJECT_ID, undefined))
      .resolves.toEqual({
        invalid: "This project has multiple criteria; provide skillVersionId explicitly."
      });

    const missingServices = createRequestServices({
      repository: new class extends DemoRepository {
        override async getCurrentSkill(): Promise<never> {
          throw new NoCurrentSkillError(PROJECT_ID);
        }
      }(),
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });
    await expect(missingServices.resolveSkillVersionId(PROJECT_ID, undefined))
      .resolves.toEqual({
        invalid: "No active skill version. Define one before judging."
      });
  });

  it("fails closed when lifecycle authorization throws a non-Error value", async () => {
    const services = createRequestServices({
      repository: new class extends DemoRepository {
        override async authorizeSkillVersionExecution(): Promise<void> {
          throw "denied";
        }
      }(),
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });

    await expect(services.resolveSkillVersionId(PROJECT_ID, "skillv_1_2_0"))
      .resolves.toEqual({
        invalid: "Evaluator version is not authorized for this operation."
      });
  });

  it("keeps provider visibility aligned with demo and database modes", async () => {
    const repository = new DemoRepository();
    await repository.setJudgeProviderKey(PROJECT_ID, "openai", "sk-test");
    const demoServices = createRequestServices({
      repository,
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });
    const databaseServices = createRequestServices({
      repository,
      pool: {} as Pool,
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });

    const demoProviders = await demoServices.listJudgeProviders(PROJECT_ID);
    const databaseProviders = await databaseServices.listJudgeProviders(PROJECT_ID);
    expect(demoProviders.find((provider) => provider.provider === "mock")?.available).toBe(true);
    expect(databaseProviders.find((provider) => provider.provider === "mock")?.available).toBe(false);
    expect(databaseProviders.find((provider) => provider.provider === "openai")?.available).toBe(true);
  });

  it("arms before queue send, merges queue options, and falls back to the created run", async () => {
    const events: string[] = [];
    const repository = new class extends DemoRepository {
      returnNullOnRefresh = false;

      override async armEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string): Promise<void> {
        events.push("arm");
        await super.armEvalRunItemDeliveryDeadline(projectId, evalRunId);
      }

      override async getEvalRun(projectId: string, evalRunId: string) {
        events.push("refresh");
        if (this.returnNullOnRefresh) return null;
        return super.getEvalRun(projectId, evalRunId);
      }
    }();
    const queue = new RecordingQueue(events);
    const detail = await datasetFixture(repository, "queued");
    const services = createRequestServices({
      repository,
      queue,
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });
    const created = await services.createDataset({
      projectId: PROJECT_ID,
      dataset: detail,
      skillVersionId: "skillv_1_2_0"
    });
    repository.returnNullOnRefresh = true;
    const dispatched = await services.dispatch(PROJECT_ID, created, {
      id: "eval-run-explicit",
      retryLimit: 9
    });

    expect(dispatched).toBe(created);
    expect(events).toEqual(["arm", "send", "refresh"]);
    expect(queue.sent).toEqual([{
      name: "eval.run",
      data: { projectId: PROJECT_ID, evalRunId: created.id },
      options: { retryLimit: 9, retryBackoff: true, id: "eval-run-explicit" }
    }]);
  });

  it("runs inline without a queue and returns the refreshed terminal run", async () => {
    const repository = new DemoRepository();
    const detail = await datasetFixture(repository, "inline");
    const services = createRequestServices({
      repository,
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });

    const run = await services.startDataset({
      projectId: PROJECT_ID,
      dataset: detail,
      skillVersionId: "skillv_1_2_0"
    });

    expect(run.datasetId).toBe(detail.id);
    expect(run.status).toBe("completed");
    expect(run.completedItems).toBe(1);
  });

  it("rejects sealed, analysis-population, and unbound revision items before persistence", async () => {
    const services = createRequestServices({
      repository: new DemoRepository(),
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100
    });
    const start = (revision: DatasetRevisionDetail) => services.createDatasetRevision({
      projectId: PROJECT_ID,
      revision,
      skillVersionId: "skillv_1_2_0"
    });

    await expect(start(revisionFixture({
      role: "sealed_validation",
      sourceKind: "sealed_intake",
      items: []
    }))).rejects.toBeInstanceOf(SealedValidationUnavailableError);
    await expect(start(revisionFixture({
      role: "analysis_authoring",
      sourceKind: "analysis_population",
      items: []
    }))).rejects.toThrow("Analysis population revisions cannot run through the ordinary evaluation path");
    await expect(start(revisionFixture({
      role: "iterative_development",
      sourceKind: "collection_snapshot",
      items: [{
        id: "dsri_unbound",
        sourceCaseId: null,
        referenceLabel: null,
        referenceFailStep: null
      } as DatasetRevisionDetail["items"][number]]
    }))).rejects.toThrow("Dataset revision item dsri_unbound has no judgeable case identity");
  });

  it("returns the exact owner guard responses and bypasses them only when disabled", async () => {
    const response = async (input: {
      enabled: boolean;
      userId: string | null;
      role: string | null;
    }) => {
      const pool = {
        query: async () => ({ rows: input.role ? [{ role: input.role }] : [] })
      } as unknown as Pool;
      const services = createRequestServices({
        repository: new DemoRepository(),
        pool,
        ownerAuthorizationEnabled: input.enabled,
        rateLimitPerMinute: 60,
        batchMaxItems: 100
      });
      const app = new Hono<{ Variables: AppVariables }>();
      app.use("*", async (context, next) => {
        context.set("user", input.userId ? { id: input.userId } : null);
        context.set("session", null);
        context.set("projectId", PROJECT_ID);
        await next();
      });
      app.get("/", async (context) => {
        const denied = await services.requireOwner(context, "edit datasets");
        return denied ?? context.json({ ok: true });
      });
      return app.request("/");
    };

    const disabled = await response({ enabled: false, userId: null, role: null });
    expect(disabled.status).toBe(200);
    const unauthenticated = await response({ enabled: true, userId: null, role: null });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ error: "Unauthorized" });
    const member = await response({ enabled: true, userId: "user_member", role: "member" });
    expect(member.status).toBe(403);
    await expect(member.json()).resolves.toEqual({ error: "Only owners can edit datasets" });
    const owner = await response({ enabled: true, userId: "user_owner", role: "owner" });
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toEqual({ ok: true });
  });
});
