import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const gatePath = fileURLToPath(new URL("./gate.mjs", import.meta.url));
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runGate(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gatePath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe("tools/ci/gate.mjs", () => {
  it("rejects removed --product usage locally without an HTTP request", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(500).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
      const dir = await mkdtemp(join(tmpdir(), "coeval-product-gate-"));
      tempDirs.push(dir);
      const candidatesPath = join(dir, "candidates.jsonl");
      await writeFile(candidatesPath, '{"goldenCaseId":"case_1","output":"candidate"}\n');

      const result = await runGate(["--product", candidatesPath], {
        COEVAL_URL: `http://127.0.0.1:${address.port}`,
        COEVAL_API_KEY: "coeval_sk_test"
      });

      assert.equal(result.code, 2);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /--product has been removed/);
      assert.match(result.stderr, /purpose="release_evidence"/);
      assert.match(result.stderr, /apply rollout policy in your release layer/);
      assert.equal(requestCount, 0);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
