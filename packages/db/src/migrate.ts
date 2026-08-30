import { createHash } from "node:crypto";
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
        `Database migration history is newer than or incompatible with this release ` +
        `(unknown migrations: ${unknownIds.join(", ")}). This pre-launch release supports ` +
        "clean installations only; recreate the disposable database.",
      );
    }

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");

      const existing = await client.query<{ checksum: string | null }>(
        "select checksum from coeval_migrations where id = $1",
        [id],
      );
      if (existing.rows[0]) {
        const recorded = existing.rows[0].checksum;
        if (recorded !== checksum) {
          throw new Error(
            `Applied migration ${id} checksum does not match this release. ` +
            "This pre-launch release supports clean installations only; recreate the disposable database.",
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
