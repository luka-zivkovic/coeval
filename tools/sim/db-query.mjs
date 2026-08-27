// Ad-hoc SQL against the sim database (DATABASE_URL from repo-root .env).
// Usage: node tools/sim/db-query.mjs "select count(*) from public.verdicts"
// Prints rows as JSON. The shared dev DB also contains leftover test schemas
// from pg-smoke runs — always qualify tables with `public.`.
import { query, closePool } from "./lib.mjs";

const sql = process.argv[2];
if (!sql) {
  console.error('usage: node tools/sim/db-query.mjs "<sql>"');
  process.exit(1);
}
try {
  const rows = await query(sql);
  console.log(JSON.stringify(rows, null, 1));
} catch (error) {
  console.error("ERROR:", error.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
