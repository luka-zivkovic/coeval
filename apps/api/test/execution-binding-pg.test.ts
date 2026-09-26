import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { TypedQuestionOutputSchema, type SkillFormatV2 } from "@rubrist/shared";
import { endpointBaseUrlDigest, evaluatorIdentityFor, skillDigestV2 } from "../src/lib/evaluator-identity.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";
import { MOCK_BINDING, SEEDED_BINDING } from "./fixtures/execution-binding.js";

// A custom endpoint's URL is stored beside the binding, outside identity, and
// the database holds it to the digest the binding names (ADR-0014 section 2).
// A typed-question definition is stored in its own columns, and the database
// holds each version to exactly one definition kind (section 5).

const TYPED_FIXTURE = JSON.parse(readFileSync(
  new URL("../../../contracts/fixtures/skill-format-v2.typed-question.json", import.meta.url),
  "utf8"
)) as SkillFormatV2;

runPgSmoke("execution binding storage", () => {
  it("keeps a custom endpoint URL beside its binding only while the URL matches the digest", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      const url = "https://llm.example/v1";
      const custom = {
        ...SEEDED_BINDING,
        provider: "custom",
        endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(url) },
        reasoning: null,
        verdictProtocol: "openai.forced-function/v1"
      };
      const store = (binding: unknown, customEndpointUrl: string | null) => pool.query(
        `update skill_versions set execution_binding = $1, custom_endpoint_url = $2 where id = 'skillv_test'`,
        [JSON.stringify(binding), customEndpointUrl]
      );

      await store(custom, url);
      const stored = await repo.getSkillVersion("proj_test", "skillv_test");
      expect(stored?.executionBinding).toEqual(custom);
      expect(stored?.customEndpointUrl).toBe(url);

      await expect(store(custom, "https://other.example/v1")).rejects.toMatchObject({ code: "23514" });
      await expect(store(custom, null)).rejects.toMatchObject({ code: "23514" });
      await expect(store(custom, "")).rejects.toMatchObject({ code: "23514" });
      await expect(store(MOCK_BINDING, url)).rejects.toMatchObject({ code: "23514" });
      const { provider: _provider, ...providerless } = MOCK_BINDING;
      await expect(store(providerless, null)).rejects.toMatchObject({ code: "23514" });
    } finally {
      await cleanup();
    }
  });

  it("stores a typed-question definition in place of a rubric and prompt, and only on typed-question/v1", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      const { identity, question } = TYPED_FIXTURE.evaluator;
      const typed = {
        binding: identity.executionBinding as unknown,
        rubric: null as string | null,
        prompt: null as string | null,
        question: question as unknown,
        threshold: 0.62 as number | null,
        verdictKind: "binary",
        scalarRange: null as [number, number] | null,
        outputSchema: TypedQuestionOutputSchema as object
      };
      const store = (row: typeof typed) => pool.query(
        `update skill_versions
            set execution_binding = $1, rubric_markdown = $2, prompt = $3, typed_question = $4,
                decision_threshold = $5, verdict_kind = $6, scalar_range = $7, output_schema = $8
          where id = 'skillv_test'`,
        [
          JSON.stringify(row.binding), row.rubric, row.prompt, row.question === null ? null : JSON.stringify(row.question),
          row.threshold, row.verdictKind, row.scalarRange === null ? null : JSON.stringify(row.scalarRange), JSON.stringify(row.outputSchema)
        ]
      );

      await store(typed);
      const stored = await repo.getSkillVersion("proj_test", "skillv_test");
      expect(stored).toMatchObject({
        rubricMarkdown: null, prompt: null, typedQuestion: question, decisionThreshold: 0.62,
        executionBinding: identity.executionBinding, outputSchema: TypedQuestionOutputSchema
      });
      // The saved version names the portable vector's evaluator exactly.
      expect(evaluatorIdentityFor(stored!)).toEqual(identity);
      expect(skillDigestV2(evaluatorIdentityFor(stored!))).toBe(TYPED_FIXTURE.digests.skillDigest);
      // The contract is compared as JSON, so its key order doesn't matter.
      const { properties, ...rest } = TypedQuestionOutputSchema;
      await store({ ...typed, outputSchema: { properties, ...rest } });

      const refusals: Array<[string, Partial<typeof typed>]> = [
        ["a rubric beside the question", { rubric: "Pass correct answers." }],
        ["a prompt beside the question", { prompt: "Judge the trace." }],
        ["no question", { question: null }],
        ["a question that isn't an object", { question: "Is it grounded?" }],
        ["no threshold", { threshold: null }],
        ["threshold 0", { threshold: 0 }],
        ["threshold 1", { threshold: 1 }],
        ["a scalar verdict", { verdictKind: "scalar", scalarRange: [0, 1] }],
        ["another output contract", { outputSchema: { type: "object" } }],
        ["a question on a prompted binding", { binding: MOCK_BINDING, rubric: "r", prompt: "p" }],
        ["a threshold on a prompted binding", { binding: MOCK_BINDING, rubric: "r", prompt: "p", question: null }],
        ["a prompted binding without its rubric", { binding: MOCK_BINDING, rubric: null, prompt: "p", question: null, threshold: null }]
      ];
      for (const [name, change] of refusals) {
        await expect(store({ ...typed, ...change }), name).rejects.toMatchObject({ code: "23514", constraint: "skill_versions_definition_kind_check" });
      }
    } finally {
      await cleanup();
    }
  });
});
