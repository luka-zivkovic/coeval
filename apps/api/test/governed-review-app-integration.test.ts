import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

describe("governed-review app boundary", () => {
  it("mounts the module but refuses demo/API-key-style operation without session-backed Postgres", async () => {
    const response = await createApp(new DemoRepository()).request("/api/governed-review/tasks");
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: "governed_review_requires_auth"
    });
  });

  it("allows the project selector and exposes only the governed/legacy audit headers to browsers", async () => {
    const response = await createApp(new DemoRepository()).request("/api/governed-review/tasks", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-coeval-project"
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-coeval-project");
    const exposed = response.headers.get("access-control-expose-headers")?.toLowerCase() ?? "";
    expect(exposed).toContain("x-coeval-view-digest");
    expect(exposed).toContain("x-coeval-canonicalization");
    expect(exposed).toContain("x-coeval-governance-class");
  });
});
