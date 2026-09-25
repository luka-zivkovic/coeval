import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { endpointBaseUrlDigest } from "../src/lib/evaluator-identity.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";
import { MOCK_BINDING, SEEDED_BINDING } from "./fixtures/execution-binding.js";

// A custom endpoint's URL is stored beside the binding, outside identity, and
// the database holds it to the digest the binding names (ADR-0014 section 2).

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
});
