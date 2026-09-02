import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository, NoCurrentSkillError } from "../src/repository.js";

describe("GET /api/v1/project — connection check", () => {
  async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "check-svc" })
    });
    return (await res.json() as { key: string }).key;
  }

  it("returns project identity and the current skill version for a valid key", async () => {
    const app = createApp(new DemoRepository());
    const key = await mintKey(app);

    const res = await app.request("/api/v1/project", {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string; name: string; mode: string; currentSkillVersionId: string | null };
    expect(body.projectId).toBe("proj_langsmith_support");
    expect(body.name).toBeTruthy();
    expect(body.mode).toMatch(/^(tracing|bench)$/);
    // The stock DemoRepository seeds a current skill, so the version is non-null.
    expect(body.currentSkillVersionId).toEqual(expect.any(String));
  });

  it("rejects a request with no API key", async () => {
    const app = createApp(new DemoRepository());
    const res = await app.request("/api/v1/project");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid Bearer key", async () => {
    const app = createApp(new DemoRepository());
    const res = await app.request("/api/v1/project", {
      headers: { authorization: "Bearer coeval_sk_bogus" }
    });
    expect(res.status).toBe(401);
  });

  it("returns currentSkillVersionId: null when no skill version is active", async () => {
    // The stock DemoRepository.getCurrentSkill never throws, so exercise the
    // null branch with a subclass that does.
    class NoSkillRepository extends DemoRepository {
      override async getCurrentSkill(): Promise<never> {
        throw new NoCurrentSkillError("proj_langsmith_support");
      }
    }
    const app = createApp(new NoSkillRepository());
    const key = await mintKey(app);

    const res = await app.request("/api/v1/project", {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { currentSkillVersionId: string | null };
    expect(body.currentSkillVersionId).toBeNull();
  });
});
