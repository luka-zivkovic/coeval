import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_LOCK_ID = 918273645;
const FROZEN_BASELINE_ID = "0001_baseline";
const FROZEN_BASELINE_SHA256 = "a2d3f9fd5322303b444c56e6c092ff2fa9f4a8318a07514989aee3a844814973";

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await ensureMigrationsTable(client);

    const migrationsDir = join(__dirname, "..", "migrations");
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const knownIds = new Set(files.map((file) => file.replace(/\.sql$/, "")));
    const applied = await client.query<{ id: string }>("select id from coeval_migrations order by id");
    const unknownIds = applied.rows.map((row) => row.id).filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(
        `Database migration history is newer than or incompatible with this release ` +
        `(unknown migrations: ${unknownIds.join(", ")}). Restore a compatible Coeval image; ` +
        "do not reset a persistent database.",
      );
    }

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (id === FROZEN_BASELINE_ID && checksum !== FROZEN_BASELINE_SHA256) {
        throw new Error(
          `Frozen Coeval baseline checksum changed (${checksum}); expected ${FROZEN_BASELINE_SHA256}. ` +
          "Add a new forward migration instead of editing 0001_baseline.sql.",
        );
      }

      const existing = await client.query<{ checksum: string | null }>(
        "select checksum from coeval_migrations where id = $1",
        [id],
      );
      if (existing.rows[0]) {
        const recorded = existing.rows[0].checksum;
        if (recorded === null && id === FROZEN_BASELINE_ID) {
          // Existing installations created before the first persistent
          // deployment have an id-only ledger. The accepted baseline hash is
          // fixed above, so this is a metadata backfill, not a schema rewrite.
          await client.query("update coeval_migrations set checksum = $2 where id = $1", [id, checksum]);
          continue;
        }
        if (recorded !== checksum) {
          throw new Error(
            `Applied migration ${id} checksum does not match this release. ` +
            "Restore an image containing the original migration; do not mutate migration history.",
          );
        }
        continue;
      }

      await client.query(sql);
      await client.query("insert into coeval_migrations (id, checksum) values ($1, $2)", [id, checksum]);
    }

    await client.query("alter table coeval_migrations alter column checksum set not null");

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists coeval_migrations (
      id text primary key,
      checksum text,
      applied_at timestamptz not null default now()
    )
  `);
  await client.query("alter table coeval_migrations add column if not exists checksum text");
}
