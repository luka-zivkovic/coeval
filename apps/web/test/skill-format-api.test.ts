import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSkillFormat } from "../src/lib/api/projects.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../contracts/fixtures/skill-format-v2.prompted.json",
  import.meta.url
), "utf8")) as Record<string, unknown>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("skill-format web API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses a skill-format/v2 export exactly as the server sent it", async () => {
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "project_1") });
    const fetchMock = vi.fn(async () => json(fixture));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchSkillFormat("skill_1", "version_1")).toEqual(fixture);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/api/skills/skill_1/versions/version_1/skill-format");
  });

  it("refuses a skill-format/v1 document and surfaces a refused export's error", async () => {
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "project_1") });
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...fixture, formatVersion: "skill-format/v1" })));
    await expect(fetchSkillFormat("skill_1", "version_1")).rejects.toThrow();

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "This evaluator version can't be exported as skill-format/v2: x" }, 422)));
    await expect(fetchSkillFormat("skill_1", "version_1")).rejects.toThrow(/can't be exported as skill-format\/v2/);
  });
});
