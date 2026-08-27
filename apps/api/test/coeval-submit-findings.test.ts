import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../skills/coeval-audit/scripts/coeval-submit.mjs", import.meta.url));

const FINDINGS = {
  generatedAt: "2026-09-01T00:00:00.000Z",
  since: null as string | null,
  humanOverrides: [
    {
      caseId: "case_a",
      source: "human",
      label: "pass",
      judgeLabel: "fail",
      rationale: "Citation was inline. Judge too strict.",
      skillVersionId: "skillv_1",
      createdAt: "2026-08-02T00:00:00.000Z"
    }
  ],
  judgeHumanDisagreements: { comparedCases: 3, disagreedCases: 1, resolvedCases: 0, cases: [] },
  verdictDistribution: [
    { stratum: "billing", cases: 2, judge: { fail: 1, pass: 1 }, human: { pass: 1 } },
    { stratum: null, cases: 1, judge: { pass: 1 }, human: {} }
  ],
  failureClusters: [
    { key: "missing citation", source: "judge", count: 2, caseIds: ["case_1", "case_2"], sampleRationale: "Missing citation. Variant one." }
  ],
  goldenSet: { size: 4, entriesSince: null as number | null, latestPromotedAt: "2026-08-15T00:00:00.000Z" }
};

function runScript(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("coeval-submit findings command", () => {
  const requests: Array<{ url: string; authorization: string }> = [];
  let baseUrl = "";
  let cwd = "";
  const server = createServer((request, response) => {
    requests.push({
      url: String(request.url),
      authorization: String(request.headers.authorization ?? "")
    });
    if (request.url?.startsWith("/api/v1/findings")) {
      const url = new URL(request.url, "http://localhost");
      const since = url.searchParams.get("since");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ...FINDINGS,
        since,
        goldenSet: { ...FINDINGS.goldenSet, entriesSince: since ? 1 : null }
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "coeval-findings-"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const env = () => ({
    ...process.env,
    COEVAL_URL: baseUrl,
    COEVAL_API_KEY: "coeval_sk_findings-test-key"
  });

  it("prints the findings JSON without leaking the API key", async () => {
    const result = await runScript(["findings"], cwd, env());
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as typeof FINDINGS;
    expect(parsed.goldenSet.size).toBe(4);
    expect(parsed.failureClusters[0]!.key).toBe("missing citation");
    expect(result.stdout).not.toContain("coeval_sk_findings-test-key");
    expect(requests.at(-1)!.authorization).toBe("Bearer coeval_sk_findings-test-key");
  });

  it("forwards --since as the cursor query parameter", async () => {
    const result = await runScript(["findings", "--since", "2026-08-01T00:00:00.000Z"], cwd, env());
    expect(result.code).toBe(0);
    expect(requests.at(-1)!.url).toBe(`/api/v1/findings?since=${encodeURIComponent("2026-08-01T00:00:00.000Z")}`);
    const parsed = JSON.parse(result.stdout) as { since: string | null };
    expect(parsed.since).toBe("2026-08-01T00:00:00.000Z");
  });

  it("renders a compact markdown brief with --md", async () => {
    const result = await runScript(["findings", "--md"], cwd, env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Coeval findings");
    expect(result.stdout).toContain("golden set: 4");
    expect(result.stdout).toContain("missing citation");
    expect(result.stdout).toContain("billing");
    expect(result.stdout).toContain("case_a");
    expect(result.stdout).not.toContain("coeval_sk_findings-test-key");
  });

  it("exits 2 when the key is missing", async () => {
    const bare: NodeJS.ProcessEnv = { ...process.env, COEVAL_URL: baseUrl };
    delete bare.COEVAL_API_KEY;
    const result = await runScript(["findings"], cwd, bare);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("COEVAL_API_KEY");
  });
});
