import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/api/test/**/*-pg.test.ts",
      "apps/api/test/governed-content-digest.test.ts",
      "apps/api/test/pg-auth.test.ts",
      "apps/api/test/pg-smoke.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
