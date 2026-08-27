import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface PostgresTestDatabase {
  pool: Pool;
  databaseUrl: string;
  schema: string;
  cleanup(): Promise<void>;
}

export async function openPostgresTestDatabase(prefix: string): Promise<PostgresTestDatabase> {
  const sourceUrl = process.env.PG_SMOKE_DATABASE_URL;
  if (!sourceUrl) throw new Error("PG_SMOKE_DATABASE_URL is required for PostgreSQL tests");

  const templateDatabase = process.env.PG_TEST_TEMPLATE_DATABASE;
  if (templateDatabase) {
    return openTemplateClone(sourceUrl, templateDatabase, prefix);
  }
  return openSchemaDatabase(sourceUrl, prefix);
}

async function openTemplateClone(
  sourceUrl: string,
  templateDatabase: string,
  prefix: string,
): Promise<PostgresTestDatabase> {
  const adminUrl = replaceDatabase(sourceUrl, "postgres");
  const databaseName = testIdentifier(prefix);
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query(`create database ${quoteIdentifier(databaseName)} template ${quoteIdentifier(templateDatabase)}`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw error;
  }
  const databaseUrl = replaceDatabase(sourceUrl, databaseName);
  const pool = new Pool({ connectionString: databaseUrl });
  let cleaned = false;
  return {
    pool,
    databaseUrl,
    schema: "public",
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await pool.end();
      try {
        await admin.query(`drop database if exists ${quoteIdentifier(databaseName)}`);
      } catch {
        // Some repository paths intentionally own pools beyond the immediate
        // test scope. The suite runner drops any remaining run-scoped clones
        // after Vitest exits, when no client can receive a forced disconnect.
      } finally {
        await admin.end();
      }
    },
  };
}

async function openSchemaDatabase(sourceUrl: string, prefix: string): Promise<PostgresTestDatabase> {
  const schema = testIdentifier(prefix);
  const admin = new Pool({ connectionString: sourceUrl });
  try {
    await admin.query(`create schema ${quoteIdentifier(schema)}`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw error;
  }
  const url = new URL(sourceUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const databaseUrl = url.toString();
  const pool = new Pool({ connectionString: databaseUrl });
  let cleaned = false;
  return {
    pool,
    databaseUrl,
    schema,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await pool.end();
      try {
        await admin.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      } finally {
        await admin.end();
      }
    },
  };
}

function replaceDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  url.search = "";
  return url.toString();
}

function testIdentifier(prefix: string): string {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24) || "test";
  const runId = (process.env.PG_TEST_RUN_ID ?? "manual").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const unique = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}_${runId}`;
  return `coeval_${safePrefix}_${unique}`.slice(0, 63);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
