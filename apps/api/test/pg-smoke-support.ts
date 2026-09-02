import type { Pool } from "pg";
import type { Queue, QueueName } from "@coeval/queue";
import { MinimumVerdictOutputSchema } from "@coeval/shared";
import { describe } from "vitest";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
process.env.BETTER_AUTH_SECRET ??= "coeval-postgres-test-secret-at-least-32-bytes";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; Postgres smoke tests may not be skipped.");
}
export const runPgSmoke: typeof describe = (databaseUrl ? describe : describe.skip) as typeof describe;

export class CapturingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: object; options?: object | undefined }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_name: QueueName, _handler: (job: { id: string; data: T }) => Promise<void>): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    this.jobs.push({ name, data, options });
    return `job_${this.jobs.length}`;
  }
}

export class FailingOnceQueue extends CapturingQueue {
  private failed = false;

  override async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Queue unavailable after trace import");
    }
    return super.send(name, data, options);
  }
}

export async function seedSkill(pool: Pool): Promise<void> {
  await seedCriterion(pool);
  await pool.query(`insert into skills (id, project_id, name, description, status, criterion_id) values ('skill_test', 'proj_test', 'Test Skill', 'Smoke skill', 'draft', 'criterion_test')`);
  await pool.query(
    `insert into skill_versions
     (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
      criterion_version_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      "skillv_test",
      "skill_test",
      "proj_test",
      "0.1.0",
      "draft",
      "Pass correct answers; fail incorrect answers.",
      "Judge the trace.",
      JSON.stringify(MinimumVerdictOutputSchema),
      JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 }),
      "criterionv_test"
    ]
  );
}

export async function seedCriterion(pool: Pool, suffix = "test"): Promise<void> {
  const criterionId = `criterion_${suffix}`;
  const criterionVersionId = `criterionv_${suffix}`;
  const stableKey = `criterion-${suffix}`;
  await pool.query(
    `insert into criteria (id,project_id,stable_key,source_kind)
     values ($1,'proj_test',$2,'native')`,
    [criterionId, stableKey]
  );
  await pool.query(
    `insert into criterion_versions
       (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
     values ($1,'proj_test',$2,1,$3,$4,criterion_v1_digest($2,$1,$3,$4),'native')`,
    [criterionVersionId, criterionId, `Criterion ${suffix}`, `Criterion ${suffix} definition.`]
  );
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("waitFor timeout");
}
