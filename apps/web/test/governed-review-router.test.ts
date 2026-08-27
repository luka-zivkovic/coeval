import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("governed blind router boundary", () => {
  it("mounts blind tasks as a separate top-level route before RootLayout", async () => {
    const app = await source("../src/App.tsx");
    const blindRoute = app.indexOf('path: "governed-review"');
    const rootRoute = app.indexOf("element: <RootLayout />");

    expect(blindRoute).toBeGreaterThan(-1);
    expect(rootRoute).toBeGreaterThan(-1);
    expect(blindRoute).toBeLessThan(rootRoute);
    expect(app).toContain('{ path: "tasks", element: <GovernedReviewTasksScreen /> }');
    expect(app).toContain('{ path: "tasks/:taskId", element: <GovernedReviewTaskScreen /> }');
  });

  it("keeps the blind shell and screens out of ordinary dashboard and evidence clients", async () => {
    const files = await Promise.all([
      source("../src/layouts/blind-review-layout.tsx"),
      source("../src/screens/governed-review-tasks.tsx"),
      source("../src/screens/governed-review-task.tsx")
    ]);
    const combined = files.join("\n");

    for (const forbiddenImport of [
      "@/lib/api",
      "dashboard-context",
      "criterion-context",
      "review-player",
      "trace-detail"
    ]) {
      expect(combined).not.toContain(forbiddenImport);
    }
    for (const forbiddenEndpoint of ["/api/dashboard", "/api/cases", "/api/verdicts", "/api/review-queues"]) {
      expect(combined).not.toContain(forbiddenEndpoint);
    }
  });

  it("marks the historical review navigation as ungoverned", async () => {
    const sidebar = await source("../src/components/layout/sidebar.tsx");
    expect(sidebar).toContain("Human truth · governed");
    expect(sidebar).toContain("Review sessions · ungoverned");
    expect(sidebar).toContain("Needs a human · ungoverned");
  });
});
