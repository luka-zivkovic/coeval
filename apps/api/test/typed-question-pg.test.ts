import { expect, it, vi } from "vitest";
import { runMigrations } from "@rubrist/db";
import type { Queue, QueueJob, QueueName, QueueSendOptions } from "@rubrist/queue";
import { TypedQuestionOutputSchema, type GateRunJob, type SkillVersion } from "@rubrist/shared";
import { createApp, type RubristApi } from "../src/app.js";
import { createAuth } from "../src/lib/auth.js";
import { PgRepository } from "../src/repository.pg.js";
import { processGateRunJob } from "../src/workers/gate.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke } from "./pg-smoke-support.js";

// A typed-question evaluator (ADR-0014 section 5) created and resolved through
// the app against PostgreSQL: the onboarding Check and a later version, the
// regression gate run by its worker, and on-demand resolution with the
// platform's TypeSafe key.

const JEV = {
  provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
  sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
  verdictProtocol: "typed-question/v1", routing: null
} as const;
const QUESTION = { type: "noul", instructions: "Is the answer grounded?", criteria: { true: "Grounded.", false: "Not grounded." } } as const;

class RecordingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: object }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_name: QueueName, _handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, _options?: QueueSendOptions): Promise<string> {
    this.jobs.push({ name, data });
    return `job_${this.jobs.length}`;
  }
}

async function signIn(app: RubristApi, email: string, password: string): Promise<string> {
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  expect(response.status).toBe(200);
  return String(response.headers.get("set-cookie"))
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

runPgSmoke("typed-question evaluators on PostgreSQL", () => {
  it("creates, gates, and resolves a typed-question evaluator through the app", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_typed_question");
    const sent: Array<Record<string, unknown>> = [];
    vi.stubEnv("TYPESAFE_API_KEY", "typesafe-platform-test");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({
        model: "jev-1.13.0", answers: { verdict: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 }
      }), { status: 200 });
    });
    try {
      await runMigrations(pool);
      const repository = new PgRepository(pool);
      const queue = new RecordingQueue();
      const app = createApp(repository, { pool, auth: createAuth(pool), queue });
      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "typed@example.com", password: "typed-password-123", name: "Typed", projectName: "Typed", mode: "bench" })
      });
      expect(setup.status).toBe(200);
      const { projectId } = await setup.json() as { projectId: string };
      const cookie = await signIn(app, "typed@example.com", "typed-password-123");
      const post = (path: string, body: unknown) => app.request(path, {
        method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body)
      });
      const starter = await repository.getLatestSkill(projectId);

      // The first Check, then a replay that sends the fixed output contract back.
      const onboarding = {
        idempotencyKey: "typed-first-check",
        criterion: { name: "Grounded", definition: "Is the answer grounded?" },
        evaluator: { typedQuestion: QUESTION, decisionThreshold: 0.5, executionBinding: JEV }
      };
      const first = await post(`/api/skills/${starter.id}/onboarding-check`, onboarding);
      expect(first.status).toBe(202);
      const { version } = await first.json() as { version: SkillVersion };
      expect(version).toMatchObject({ rubricMarkdown: null, prompt: null, typedQuestion: QUESTION, decisionThreshold: 0.5, executionBinding: JEV });
      const replay = await post(`/api/skills/${starter.id}/onboarding-check`, {
        ...onboarding,
        evaluator: { ...onboarding.evaluator, outputSchema: TypedQuestionOutputSchema }
      });
      expect(replay.status).toBe(202);
      expect(((await replay.json()) as { version: SkillVersion }).version.id).toBe(version.id);

      // The gate worker judges the regression revision with the typed evaluator.
      const gateJob = queue.jobs.find((job) => job.name === "gate.run");
      expect(gateJob).toBeDefined();
      await processGateRunJob(repository, gateJob!.data as GateRunJob, queue);
      expect((await repository.getSkillVersion(projectId, version.id))?.status).not.toBe("calibrating");

      // A later version through the version route.
      const later = { criterionVersionId: version.criterionVersionId, typedQuestion: QUESTION, executionBinding: JEV };
      const second = await post(`/api/skills/${starter.id}/versions`, { ...later, decisionThreshold: 0.7 });
      expect(second.status).toBe(202);
      expect(((await second.json()) as { version: SkillVersion }).version).toMatchObject({ decisionThreshold: 0.7, typedQuestion: QUESTION });

      // On-demand resolution confirms the binding with one probe and the platform key.
      const before = sent.length;
      const resolution = await post(`/api/evaluator-lifecycles/${version.id}/resolution`, {});
      expect(resolution.status).toBe(200);
      await expect(resolution.json()).resolves.toMatchObject({
        record: { status: "resolved", credentialSource: "environment", probes: [{ stage: "resolution", purpose: "confirm", outcome: "accepted" }] }
      });
      expect(sent.length - before).toBe(1);

      // Without a key the version route refuses, naming only TypeSafe as a way forward, and saves nothing.
      vi.stubEnv("TYPESAFE_API_KEY", "");
      const versionsBefore = (await pool.query(`select count(*)::int as count from skill_versions where skill_id=$1`, [starter.id])).rows[0]!.count;
      const keyless = await post(`/api/skills/${starter.id}/versions`, { ...later, decisionThreshold: 0.8 });
      expect(keyless.status).toBe(503);
      await expect(keyless.json()).resolves.toMatchObject({ unavailableProvider: "typesafe", availableProviders: [] });
      expect((await pool.query(`select count(*)::int as count from skill_versions where skill_id=$1`, [starter.id])).rows[0]!.count).toBe(versionsBefore);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await cleanup();
    }
  });
});
