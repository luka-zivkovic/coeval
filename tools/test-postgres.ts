import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { Pool } from "pg";
import { runMigrations } from "../packages/db/src/migrate.js";

const execFile = promisify(execFileCallback);
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const containerName = `coeval-pg-test-${suffix}`;
const templateDatabase = `coeval_template_${suffix}`;
let ownsContainer = false;
let sourceUrl = process.env.PG_SMOKE_DATABASE_URL;

try {
  if (!sourceUrl) {
    await execFile("docker", [
      "run", "--detach", "--rm", "--name", containerName,
      "--shm-size=256m",
      "--tmpfs", "/var/lib/postgresql/data:rw,size=1g",
      "-e", "POSTGRES_USER=coeval",
      "-e", "POSTGRES_PASSWORD=coeval",
      "-e", "POSTGRES_DB=postgres",
      "-p", "127.0.0.1::5432",
      "postgres:17-alpine",
      "-c", "fsync=off",
      "-c", "full_page_writes=off",
      "-c", "synchronous_commit=off",
    ]);
    ownsContainer = true;
    await waitUntilReady(containerName);
    const { stdout } = await execFile("docker", ["port", containerName, "5432/tcp"]);
    const port = stdout.trim().split(":").at(-1);
    if (!port) throw new Error("Docker did not publish the PostgreSQL test port");
    sourceUrl = `postgres://coeval:coeval@127.0.0.1:${port}/postgres`;
  }

  const adminUrl = replaceDatabase(sourceUrl, "postgres");
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`create database ${quoteIdentifier(templateDatabase)}`);
  await admin.end();

  const templatePool = new Pool({ connectionString: replaceDatabase(sourceUrl, templateDatabase) });
  await runMigrations(templatePool);
  await templatePool.end();

  const exitCode = await runVitest({
    ...process.env,
    PG_SMOKE_DATABASE_URL: adminUrl,
    PG_TEST_TEMPLATE_DATABASE: templateDatabase,
    PG_TEST_RUN_ID: suffix,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "coeval-postgres-test-secret-at-least-32-bytes",
  });
  process.exitCode = exitCode;
} finally {
  if (sourceUrl) {
    const admin = new Pool({ connectionString: replaceDatabase(sourceUrl, "postgres") });
    try {
      const leftovers = await admin.query<{ datname: string }>(
        `select datname from pg_database where datname ~ $1`,
        [`^coeval_[a-z0-9_]+_${suffix}$`],
      );
      for (const row of leftovers.rows) {
        await admin.query(`drop database if exists ${quoteIdentifier(row.datname)} with (force)`);
      }
      await admin.query(`drop database if exists ${quoteIdentifier(templateDatabase)} with (force)`);
    } catch (error) {
      if (!ownsContainer) console.error("Failed to drop PostgreSQL test template:", error);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }
  if (ownsContainer) {
    await execFile("docker", ["rm", "--force", containerName]).catch(() => undefined);
  }
}

async function waitUntilReady(name: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await execFile("docker", ["exec", name, "pg_isready", "-U", "coeval", "-d", "postgres"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Timed out waiting for disposable PostgreSQL 17");
}

function runVitest(env: NodeJS.ProcessEnv): Promise<number> {
  const filters = process.argv.slice(2).filter((argument) => argument !== "--");
  const child = spawn("pnpm", ["exec", "vitest", "run", "--config", "vitest.pg.config.ts", ...filters], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`PostgreSQL tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function replaceDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  url.search = "";
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
