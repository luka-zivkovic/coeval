#!/usr/bin/env node
import { runMigrations } from "@coeval/db";
import { createAuth, ensureWorkspaceForUser } from "../lib/auth.js";
import { createPgPool } from "../lib/db.js";

const args = parseArgs(process.argv.slice(2));
const emailArg = args.email;
const passwordArg = args.password;

if (!emailArg || !passwordArg) {
  console.error("Usage: pnpm -F @coeval/api seed:user --email owner@example.com --password 'min-8-chars' [--name 'Owner']");
  process.exit(1);
}

const email = emailArg;
const password = passwordArg;
const name = args.name ?? email;

const pool = createPgPool();
if (!pool) {
  console.error("DATABASE_URL is required to seed a user.");
  process.exit(1);
}

await runMigrations(pool);
const auth = createAuth(pool);
const result = await auth.api.signUpEmail({ body: { email, password, name } }) as { user?: { id: string; email: string } };
if (!result.user?.id) {
  console.error("Better Auth did not return a created user.");
  process.exit(1);
}
await ensureWorkspaceForUser(pool, { userId: result.user.id, email, owner: true });
await pool.end();
console.log(`Seeded owner user: ${email}`);

function parseArgs(values: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      output[key] = next;
      index += 1;
    }
  }
  return output;
}
