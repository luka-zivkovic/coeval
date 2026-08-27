import { describe, expect, it } from "vitest";
import { fetchJudgeModelCatalog, JudgeModelCatalogError, type JudgeModelFetch } from "../src/lib/judge-models.js";

function respondingWith(payload: unknown, capture?: (url: string, headers: Record<string, string>) => void): JudgeModelFetch {
  return async (url, init) => {
    capture?.(url, init.headers);
    return { ok: true, status: 200, async json() { return payload; } };
  };
}

describe("fetchJudgeModelCatalog", () => {
  it("returns the built-in mock without credentials", async () => {
    await expect(fetchJudgeModelCatalog({ provider: "mock" })).resolves.toEqual({
      provider: "mock",
      models: [{ id: "mock", label: "Mock heuristic", version: "mock", createdAt: null }]
    });
  });

  it("loads Anthropic models with the required headers", async () => {
    let request: { url: string; headers: Record<string, string> } | null = null;
    const catalog = await fetchJudgeModelCatalog({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      fetchImpl: respondingWith({
        data: [{ id: "claude-sonnet-snapshot", display_name: "Claude Sonnet", created_at: "2026-01-02T00:00:00Z" }]
      }, (url, headers) => { request = { url, headers }; })
    });

    expect(request).toEqual({
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: { "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-test" }
    });
    expect(catalog.models[0]).toMatchObject({
      id: "claude-sonnet-snapshot",
      label: "Claude Sonnet",
      version: "claude-sonnet-snapshot"
    });
  });

  it("keeps only OpenAI model IDs that can plausibly run the chat judge", async () => {
    const catalog = await fetchJudgeModelCatalog({
      provider: "openai",
      apiKey: "sk-openai-test",
      fetchImpl: respondingWith({ data: [
        { id: "gpt-5-2025-08-07", created: 2 },
        { id: "text-embedding-3-large", created: 3 },
        { id: "gpt-realtime", created: 4 },
        { id: "o3-2025-04-16", created: 1 }
      ] })
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-5-2025-08-07", "o3-2025-04-16"]);
    expect(catalog.models.every((model) => model.version === model.id)).toBe(true);
  });

  it("uses the runtime OpenAI base URL for model discovery", async () => {
    let requestUrl = "";
    await fetchJudgeModelCatalog({
      provider: "openai",
      apiKey: "compatible-provider-key",
      baseUrl: "https://models.example.test/v1/",
      fetchImpl: respondingWith({ data: [{ id: "gpt-compatible", created: 1 }] }, (url) => { requestUrl = url; })
    });

    expect(requestUrl).toBe("https://models.example.test/v1/models");
    expect(requestUrl).not.toContain("api.openai.com");
  });

  it("requests tool-capable text models from OpenRouter", async () => {
    let requestUrl = "";
    const catalog = await fetchJudgeModelCatalog({
      provider: "openrouter",
      apiKey: "sk-or-test",
      fetchImpl: respondingWith({ data: [
        { id: "anthropic/claude", name: "Claude", created: 2, supported_parameters: ["tools", "temperature"] },
        { id: "provider/no-tools", name: "No tools", created: 3, supported_parameters: ["temperature"] }
      ] }, (url) => { requestUrl = url; })
    });

    expect(requestUrl).toContain("output_modalities=text");
    expect(requestUrl).toContain("supported_parameters=tools");
    expect(catalog.models).toEqual([{
      id: "anthropic/claude",
      label: "Claude",
      version: "anthropic/claude",
      createdAt: "1970-01-01T00:00:02.000Z"
    }]);
  });

  it("requires credentials and keeps custom model discovery manual", async () => {
    await expect(fetchJudgeModelCatalog({ provider: "openai" })).rejects.toBeInstanceOf(JudgeModelCatalogError);
    await expect(fetchJudgeModelCatalog({ provider: "custom", apiKey: "custom-key" })).rejects.toThrow(
      "entered manually"
    );
  });

  // The HTTP layer maps kind → status: unconfigured → 409, upstream → 502.
  // Missing keys and provider outages must never share a bucket, or a
  // transient outage reads as user misconfiguration in the editor.
  it("classifies missing credentials as unconfigured and provider failures as upstream", async () => {
    const missingKey = await fetchJudgeModelCatalog({ provider: "openai" }).catch((e: JudgeModelCatalogError) => e);
    expect(missingKey).toMatchObject({ kind: "unconfigured", upstreamStatus: null });

    const fetchThrew = await fetchJudgeModelCatalog({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND api.anthropic.com"); }
    }).catch((e: JudgeModelCatalogError) => e);
    expect(fetchThrew).toMatchObject({ kind: "upstream", upstreamStatus: null });

    const upstream500 = await fetchJudgeModelCatalog({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } })
    }).catch((e: JudgeModelCatalogError) => e);
    expect(upstream500).toMatchObject({ kind: "upstream", upstreamStatus: 500 });
  });
});
