import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

describe("API keys", () => {
  it("mints a key once, lists it masked, and revokes it", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);

    const createRes = await app.request("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci" })
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; key: string; keyPrefix: string };
    expect(created.key).toMatch(/^coeval_sk_/);

    const listRes = await app.request("/api/api-keys");
    const list = await listRes.json() as { apiKeys: Array<{ id: string; key?: string; keyPrefix: string }> };
    expect(list.apiKeys).toHaveLength(1);
    // The raw key is never returned again.
    expect(list.apiKeys[0]!.key).toBeUndefined();
    expect(list.apiKeys[0]!.keyPrefix).toBe(created.keyPrefix);

    const revokeRes = await app.request(`/api/api-keys/${created.id}`, { method: "DELETE" });
    expect(revokeRes.status).toBe(200);
  });
});
