import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_LOCK_ID = 918273645;

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
        `Pre-baseline database detected (unknown migrations: ${unknownIds.join(", ")}). ` +
        "ADR-0011 requires pre-launch databases to be dropped and recreated.",
      );
    }

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const existing = await client.query("select id from coeval_migrations where id = $1", [id]);
      if (existing.rowCount && existing.rowCount > 0) continue;

      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("insert into coeval_migrations (id) values ($1)", [id]);
    }

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
      applied_at timestamptz not null default now()
    )
  `);
}
