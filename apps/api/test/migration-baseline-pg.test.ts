import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; baseline migration tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

run("clean-install database baseline", () => {
  it("is idempotent and records the current baseline checksum", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("baseline_idempotent");
    try {
      await runMigrations(pool);
      await runMigrations(pool);
      const applied = await pool.query<{ id: string; checksum: string }>(
        "select id, checksum from coeval_migrations order by id",
      );
      expect(applied.rows).toEqual([
        {
          id: "0001_baseline",
          checksum: "f76b232dffdf9868da9b9d2a2a52cffd4b1642b9f36b4925548849d6fba1925c",
        }
      ]);
    } finally {
      await cleanup();
    }
  });

  it("enforces current regression pin invariants in the baseline", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("baseline_regression_pins");
    try {
      await runMigrations(pool);
      const pinConstraint = await pool.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
         from pg_constraint
         where conname = 'skill_versions_regression_pin_by_status'`
      );
      expect(pinConstraint.rows[0]?.definition).toContain("regression_dataset_revision_id IS NOT NULL");
      expect(pinConstraint.rows[0]?.definition).toContain("'draft'::text");
      expect(pinConstraint.rows[0]?.definition).toContain("'approved'::text");

      const pinForeignKeys = await pool.query<{ conname: string; confdeltype: string }>(
        `select conname, confdeltype
         from pg_constraint
         where conname in (
           'regression_runs_dataset_revision_id_fkey',
           'skill_versions_regression_dataset_revision_id_fkey'
         )
         order by conname`
      );
      expect(pinForeignKeys.rows).toEqual([
        { conname: "regression_runs_dataset_revision_id_fkey", confdeltype: "r" },
        { conname: "skill_versions_regression_dataset_revision_id_fkey", confdeltype: "r" }
      ]);

      const runPin = await pool.query<{ is_nullable: string }>(
        `select is_nullable
         from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'regression_runs'
           and column_name = 'dataset_revision_id'`
      );
      expect(runPin.rows).toEqual([{ is_nullable: "NO" }]);

      await pool.query(`insert into organizations (id,name) values ('org_pins','Pin test')`);
      await pool.query(`insert into projects (id,organization_id,name,trace_provider) values ('project_pins','org_pins','Pin test','manual')`);
      await pool.query(`insert into criteria (id,project_id,stable_key,source_kind) values ('criterion_pins','project_pins','pin-test','native')`);
      await pool.query(
        `insert into criterion_versions
           (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
         values ('criterionv_pins','project_pins','criterion_pins',1,'Pin test','Pin test definition',
                 criterion_v1_digest('criterion_pins','criterionv_pins','Pin test','Pin test definition'),'native')`
      );
      await pool.query(
        `insert into skills (id,project_id,name,description,status,criterion_id)
         values ('skill_pins','project_pins','Pin test','Pin test','draft','criterion_pins')`
      );
      await expect(pool.query(
        `insert into skill_versions
           (id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,model_binding,criterion_version_id)
         values ('skillv_unpinned','skill_pins','project_pins','1.0.0','calibrating','rubric','prompt','{}','{}','criterionv_pins')`
      )).rejects.toMatchObject({ constraint: "skill_versions_regression_pin_by_status" });
    } finally {
      await cleanup();
    }
  });

  it("rejects migration history from a newer or incompatible release without mutating it", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("baseline_stale_ledger");
    try {
      // Template clones are already migrated; CI's schema-isolated fallback is
      // empty. Establish the same current starting point in both modes before
      // poisoning the ledger with an upgrade-era identifier.
      await runMigrations(pool);
      await pool.query(
        "insert into coeval_migrations (id, checksum) values ('0055_evaluator_lifecycle', 'unknown')",
      );
      await expect(runMigrations(pool)).rejects.toThrow(
        /migration history is newer than or incompatible.*0055_evaluator_lifecycle.*recreate the disposable database/s,
      );
      const applied = await pool.query<{ id: string }>("select id from coeval_migrations order by id");
      expect(applied.rows).toEqual([
        { id: "0001_baseline" },
        { id: "0055_evaluator_lifecycle" },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("rejects a ledger without the current baseline checksum", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("baseline_checksum_required");
    try {
      await runMigrations(pool);
      await pool.query("alter table coeval_migrations alter column checksum drop not null");
      await pool.query("update coeval_migrations set checksum = null where id = '0001_baseline'");

      await expect(runMigrations(pool)).rejects.toThrow(
        /Applied migration 0001_baseline checksum does not match.*recreate the disposable database/s,
      );
    } finally {
      await cleanup();
    }
  });
});
