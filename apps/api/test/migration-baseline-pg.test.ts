import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; baseline migration tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

run("frozen database baseline", () => {
  it("is idempotent and records immutable migration checksums", async () => {
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
          checksum: "a2d3f9fd5322303b444c56e6c092ff2fa9f4a8318a07514989aee3a844814973",
        },
        {
          id: "0002_ironside_trace_versions",
          checksum: "269dac0e95ed4850ac153a6f7f41922467a2c284730d84aa2b94c444ed678a9f",
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

  it("upgrades legacy Ironside state without reusing an incompatible cursor or inventing trace provenance", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("baseline_ironside_upgrade");
    try {
      await runMigrations(pool);
      // Reconstruct the exact pre-0002 shape inside this isolated database so
      // the forward migration is exercised against persisted legacy rows.
      await pool.query("drop index raw_traces_source_version_lookup");
      await pool.query("alter table raw_traces drop constraint raw_traces_source_trace_version_shape");
      await pool.query("alter table raw_traces drop constraint raw_traces_source_remote_project_id_shape");
      await pool.query("alter table raw_traces drop constraint raw_traces_source_trace_cutover_shape");
      await pool.query(
        `alter table raw_traces
           drop column source_trace_version,
           drop column source_remote_project_id,
           drop column source_trace_cutover_version,
           drop column source_trace_cutover_matched`
      );
      await pool.query("delete from coeval_migrations where id = '0002_ironside_trace_versions'");

      await pool.query("insert into organizations (id, name) values ('org_upgrade', 'Upgrade')");
      await pool.query(
        "insert into projects (id, organization_id, name, trace_provider) values ('project_upgrade', 'org_upgrade', 'Upgrade', 'ironside')"
      );
      await pool.query(
        `insert into integrations (id, project_id, provider, encrypted_credentials, config)
         values (
           'int_upgrade',
           'project_upgrade',
           'ironside',
           'encrypted',
           '{"url":"https://ironside.example","sync":{"watermark":"2026-08-01T00:00:00.000Z","cursor":"legacy_cursor","windowTo":"2026-08-02T00:00:00.000Z"}}'
         )`
      );
      await pool.query(
        `insert into raw_traces
           (id, project_id, source_integration_id, source_trace_id, raw_payload, normalization_version)
         values ('raw_upgrade', 'project_upgrade', 'int_upgrade', 'trace_upgrade', '{}', 'ironside-v1')`
      );
      await pool.query(
        `insert into cases
           (id, project_id, raw_trace_id, case_type, normalized_payload, ingestion_purpose)
         values ('case_upgrade', 'project_upgrade', 'raw_upgrade', 'ironside', '{}', 'analysis_eligible_ironside')`
      );

      await runMigrations(pool);

      const integration = await pool.query<{ config: Record<string, unknown> }>(
        "select config from integrations where id = 'int_upgrade'"
      );
      expect(integration.rows[0]?.config).toMatchObject({
        sync: { cursor: null },
        nativeUpgrade: {
          kind: "legacy-reconciliation-v1",
          legacySync: {
            watermark: "2026-08-01T00:00:00.000Z",
            cursor: "legacy_cursor",
            windowTo: "2026-08-02T00:00:00.000Z"
          },
          cutoverPolicy: "content-match-first-native-version"
        }
      });
      expect((await pool.query(
        `select source_trace_version, source_remote_project_id,
                source_trace_cutover_version, source_trace_cutover_matched
           from raw_traces where id = 'raw_upgrade'`
      )).rows).toEqual([{
        source_trace_version: null,
        source_remote_project_id: null,
        source_trace_cutover_version: null,
        source_trace_cutover_matched: null
      }]);
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
        /migration history is newer than or incompatible.*0055_evaluator_lifecycle.*do not reset/s,
      );
      const applied = await pool.query<{ id: string }>("select id from coeval_migrations order by id");
      expect(applied.rows).toEqual([
        { id: "0001_baseline" },
        { id: "0002_ironside_trace_versions" },
        { id: "0055_evaluator_lifecycle" },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("backfills the accepted checksum on an id-only pre-freeze ledger", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("baseline_checksum_backfill");
    try {
      await runMigrations(pool);
      await pool.query("alter table coeval_migrations alter column checksum drop not null");
      await pool.query("update coeval_migrations set checksum = null where id = '0001_baseline'");

      await runMigrations(pool);

      const applied = await pool.query<{ checksum: string }>(
        "select checksum from coeval_migrations where id = '0001_baseline'",
      );
      expect(applied.rows).toEqual([{
        checksum: "a2d3f9fd5322303b444c56e6c092ff2fa9f4a8318a07514989aee3a844814973",
      }]);
    } finally {
      await cleanup();
    }
  });
});
