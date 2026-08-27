import { Pool } from "pg";

export function createPgPool(databaseUrl = process.env.DATABASE_URL): Pool | null {
  if (!databaseUrl) return null;
  return new Pool({ connectionString: databaseUrl });
}
