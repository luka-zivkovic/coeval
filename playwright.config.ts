import { defineConfig } from "@playwright/test";

// Fix-claims regression checks for the E2E sim harness (tools/sim/RUNBOOK.md).
// These run against an ALREADY-RUNNING dev stack seeded by a sim session —
// they are read-only invariant checks, not CI tests: most specs skip
// themselves when the data they assert about doesn't exist yet.
//
// Env: COEVAL_WEB (default http://localhost:5175), SIM_EMAIL, SIM_PASSWORD.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.COEVAL_WEB ?? "http://localhost:5175",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "auth", testMatch: /auth\.setup\.ts/ },
    {
      name: "fix-claims",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["auth"],
      use: { storageState: "e2e/.auth/state.json" }
    }
  ]
});
