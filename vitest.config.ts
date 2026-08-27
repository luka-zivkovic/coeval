import { defineConfig } from "vitest/config";

const databaseBacked = Boolean(process.env.PG_SMOKE_DATABASE_URL);

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: !databaseBacked,
    maxWorkers: databaseBacked ? 1 : undefined
  }
});
