import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAgentConnectSnippets } from "@coeval/shared";

const SCRIPT = fileURLToPath(new URL("../../../skills/coeval-audit/scripts/coeval-submit.mjs", import.meta.url));

describe("coeval-audit setup client", () => {
  it("injects setup secrets from env and stores the one-time project key without printing it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "coeval-audit-setup-"));
    const setupPath = join(cwd, "setup.json");
    const firstBatchPath = join(cwd, "first-batch.jsonl");
    await writeFile(setupPath, JSON.stringify({
      owner: { email: "owner@example.com", name: "Owner" },
      project: { name: "External skill audit" },
      skill: {
        rubricMarkdown: "# External skill audit\n\nPass when the contract is followed.",
        model: { provider: "custom", modelId: "judge-model", baseUrl: "https://judge.example/v1" }
      }
    }), "utf8");
    await writeFile(firstBatchPath, `${JSON.stringify({
      name: "first real run",
      input: "perform the audited task",
      output: "completed result",
      expected: "pass"
    })}\n`, "utf8");

    let receivedAuthorization = "";
    let receivedBody: Record<string, unknown> | null = null;
    let receivedBatchAuthorization = "";
    let receivedBatch: Record<string, unknown> | null = null;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === "/api/v1/bootstrap") {
        receivedAuthorization = String(request.headers.authorization ?? "");
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          projectId: "proj_bootstrap",
          skillId: "skill_bootstrap",
          skillVersionId: "skillv_bootstrap",
          mode: "bench",
          rubricProvenance: "agent-drafted",
          modelBinding: {
            provider: "custom",
            modelId: "judge-model",
            modelVersion: "judge-model",
            temperature: 0,
            baseUrl: "https://judge.example/v1"
          },
          apiKey: {
            id: "apikey_bootstrap",
            projectId: "proj_bootstrap",
            name: "Agent bootstrap",
            keyPrefix: "coeval_sk_abcdef…",
            key: "coeval_sk_abcdef-one-time-project-key",
            createdAt: "2026-08-14T00:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null
          },
          // Key-pre-filled wiring snippets, as the real bootstrap endpoint
          // returns them — the script must print them with the key MASKED.
          connect: buildAgentConnectSnippets({
            apiBaseUrl: "https://coeval.example",
            apiKey: "coeval_sk_abcdef-one-time-project-key"
          }),
          next: {
            judgeBatchPath: "/api/v1/judge/batch",
            humanReviewPath: "/exceptions",
            gateBoundary: "human-only"
          }
        }));
        return;
      }
      if (request.url === "/api/v1/judge/batch") {
        receivedBatchAuthorization = String(request.headers.authorization ?? "");
        receivedBatch = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({
          evalRunId: "eval_first",
          status: "completed",
          totalItems: 1,
          cachedItems: 0,
          skippedItems: 0,
          pollUrl: "/api/v1/eval-runs/eval_first"
        }));
        return;
      }
      if (request.url === "/api/v1/eval-runs/eval_first") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          status: "completed",
          skillVersionId: "skillv_bootstrap",
          agreedItems: 1,
          items: [{
            caseId: "case_first",
            status: "completed",
            expectedLabel: "pass",
            expectedFailStep: null,
            resultLabel: "pass",
            agreement: true,
            stepAgreement: null,
            failingStep: null
          }]
        }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock bootstrap server did not bind");

    try {
      const env = { ...process.env };
      delete env.COEVAL_KEY_TEST;
      const result = await runScript([
        "setup",
        setupPath,
        "--first-batch", firstBatchPath,
        "--owner-password-env-var", "TEST_OWNER_PASSWORD",
        "--provider-key-env-var", "TEST_PROVIDER_KEY",
        "--env-var", "COEVAL_KEY_TEST"
      ], cwd, {
        ...env,
        COEVAL_URL: `http://127.0.0.1:${address.port}`,
        COEVAL_PAIRING_TOKEN: "coeval_pair_secret-that-must-not-be-printed",
        TEST_OWNER_PASSWORD: "owner-password-that-must-not-be-printed",
        TEST_PROVIDER_KEY: "provider-key-that-must-not-be-printed"
      });

      expect(result.code).toBe(0);
      expect(receivedAuthorization).toBe("Bearer coeval_pair_secret-that-must-not-be-printed");
      expect(receivedBody).toMatchObject({
        owner: { email: "owner@example.com", password: "owner-password-that-must-not-be-printed" },
        providerApiKey: "provider-key-that-must-not-be-printed"
      });
      expect(receivedBatchAuthorization).toBe("Bearer coeval_sk_abcdef-one-time-project-key");
      expect(receivedBatch).toMatchObject({
        items: [{
          input: "perform the audited task",
          output: "completed result",
          expectedLabel: "pass"
        }]
      });
      for (const secret of [
        "coeval_pair_secret-that-must-not-be-printed",
        "owner-password-that-must-not-be-printed",
        "provider-key-that-must-not-be-printed",
        "coeval_sk_abcdef-one-time-project-key"
      ]) {
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
      }
      expect(await readFile(join(cwd, ".env"), "utf8")).toBe(
        "COEVAL_KEY_TEST=coeval_sk_abcdef-one-time-project-key\n"
      );
      expect(await readFile(join(cwd, ".coeval/.gitignore"), "utf8")).toBe("*\n");
      expect(result.stdout).toContain("human must label exceptions and promote golden cases");
      // Next-steps wiring is printed with the saved env-var name standing in
      // for the one-time key (the not-toContain loop above proves the key
      // itself never reached stdout/stderr).
      expect(result.stdout).toContain("claude mcp add coeval");
      // Shell forms keep the builder's quoting, so the masked var still
      // expands when pasted into a shell that has sourced ./.env.
      expect(result.stdout).toContain('COEVAL_API_KEY="$COEVAL_KEY_TEST"');
      expect(result.stdout).toContain("substitute it from ./.env");
      expect(result.stdout).toContain("\"COEVAL_API_KEY\": \"$COEVAL_KEY_TEST\"");
      expect(result.stdout).toContain("coeval-submit.mjs findings");
      expect(result.stdout).toContain("first batch completed — exceptions are ready for human review");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  // The "already exists" guard protects a real one-time key from being
  // clobbered. A template-style empty line (COEVAL_KEY_TEST=) holds nothing
  // worth protecting and used to dead-end setup with a misleading error.
  it("treats an empty .env placeholder as unset, but still protects a real key", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "coeval-audit-envguard-"));
    const setupPath = join(cwd, "setup.json");
    await writeFile(setupPath, JSON.stringify({
      owner: { email: "owner@example.com" },
      project: { name: "Env guard" },
      skill: {
        rubricMarkdown: "# Env guard\n\nPass when correct.",
        model: { provider: "custom", modelId: "judge-model", baseUrl: "https://judge.example/v1" }
      }
    }), "utf8");
    const env = { ...process.env };
    delete env.COEVAL_KEY_TEST;
    const baseEnv = {
      ...env,
      // Unreachable on purpose: the placeholder case must get PAST the guard
      // and fail on the network step instead.
      COEVAL_URL: "http://127.0.0.1:9",
      COEVAL_PAIRING_TOKEN: "coeval_pair_test-token"
    };
    const args = ["setup", setupPath, "--env-var", "COEVAL_KEY_TEST"];

    await writeFile(join(cwd, ".env"), "COEVAL_KEY_TEST=\n", "utf8");
    const placeholder = await runScript(args, cwd, baseEnv);
    expect(placeholder.code).not.toBe(0);
    expect(`${placeholder.stdout}\n${placeholder.stderr}`).not.toContain("already exists");

    await writeFile(join(cwd, ".env"), "COEVAL_KEY_TEST=coeval_sk_real-key\n", "utf8");
    const guarded = await runScript(args, cwd, baseEnv);
    expect(guarded.code).toBe(2);
    expect(guarded.stderr).toContain("already exists");
  });
});

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
