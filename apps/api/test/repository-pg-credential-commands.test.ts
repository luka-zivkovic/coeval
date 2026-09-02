import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { decryptJson } from "../src/lib/encryption.js";
import * as commands from "../src/repository.pg/credential-commands.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const COMMAND_PATH = path.join(API_DIRECTORY, "src/repository.pg/credential-commands.ts");
const EXPECTED_COMMAND_EXPORTS = ["setJudgeProviderKeyOnClient"];

function sourceFile(): ts.SourceFile {
  return ts.createSourceFile(
    COMMAND_PATH,
    fs.readFileSync(COMMAND_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function createApiProgram(): ts.Program {
  const configPath = ts.findConfigFile(API_DIRECTORY, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

describe("PostgreSQL credential client commands", () => {
  it("pins one caller-owned PoolClient command and its complete private module surface", () => {
    const source = sourceFile();
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMMAND_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Credential command module symbol was not resolved");

    expect(Object.keys(commands).sort()).toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(functions.map((statement) => statement.name?.text)).toEqual([
      "setJudgeProviderKeyOnClient"
    ]);
    expect(functions.map((statement) => statement.parameters[0]?.type?.getText(source)))
      .toEqual(["PoolClient"]);
    expect(source.statements.filter((statement) =>
      !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement)
    )).toEqual([]);
    expect(source.text).not.toMatch(
      /\.connect\s*\(|\.query\s*\(\s*["'`](?:begin|commit|rollback)\b|\.release\s*\(/i
    );
  }, 30_000);

  it("encrypts and masks the key before appending the exact audit record on the same client", async () => {
    const originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "credential-command-test-secret-at-least-32-bytes";
    try {
      for (const actorUserId of ["user-1", undefined] as const) {
        const rawKey = "test-anthropic-secret-raw-key-abcdef123456";
        const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
        const client = {
          query: async (sql: string, values?: unknown[]) => {
            calls.push({ sql, values });
            if (sql.includes("insert into judge_provider_keys")) {
              return {
                rows: [{
                  provider: "openai",
                  key_display: "row-owned-display",
                  created_at: new Date("2026-09-02T00:00:00.000Z")
                }],
                rowCount: 1
              };
            }
            if (sql.includes("insert into audit_logs")) return { rows: [], rowCount: 1 };
            throw new Error(`unexpected query: ${sql}`);
          }
        } as unknown as PoolClient;

        await expect(commands.setJudgeProviderKeyOnClient(
          client,
          "project-1",
          "anthropic",
          rawKey,
          actorUserId
        )).resolves.toEqual({
          provider: "openai",
          keyDisplay: "row-owned-display",
          createdAt: "2026-09-02T00:00:00.000Z"
        });

        expect(calls).toHaveLength(2);
        expect(calls[0]?.sql.replace(/\s+/g, " ").trim()).toBe(
          "insert into judge_provider_keys (id, project_id, provider, encrypted_credentials, key_display) " +
          "values ($1, $2, $3, $4, $5) on conflict (project_id, provider) do update set " +
          "encrypted_credentials = excluded.encrypted_credentials, key_display = excluded.key_display, " +
          "created_at = now() returning provider, key_display, created_at"
        );
        const credentialValues = calls[0]?.values;
        expect(credentialValues).toHaveLength(5);
        expect(credentialValues?.[0]).toMatch(/^jpk_[0-9a-f-]{36}$/);
        expect(credentialValues?.slice(1, 3)).toEqual(["project-1", "anthropic"]);
        expect(credentialValues?.[3]).toMatch(/^aes-256-gcm:v1:/);
        expect(String(credentialValues?.[3])).not.toContain(rawKey);
        expect(decryptJson<{ apiKey: string }>(String(credentialValues?.[3]))).toEqual({ apiKey: rawKey });
        expect(credentialValues?.[4]).toBe("test-anthr…3456");

        expect(calls[1]?.sql.replace(/\s+/g, " ").trim()).toBe(
          "insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata) " +
          "values ($1,$2,$3,$4,$5,$6,$7)"
        );
        const auditValues = calls[1]?.values;
        expect(auditValues?.[0]).toMatch(/^audit_[0-9a-f-]{36}$/);
        expect(auditValues?.slice(1)).toEqual([
          "project-1",
          actorUserId ?? null,
          "project.judge_key.set",
          "judge_provider_key",
          "anthropic",
          JSON.stringify({ provider: "anthropic" })
        ]);
        expect(JSON.stringify(auditValues)).not.toContain(rawKey);
      }
    } finally {
      if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });

  it("does not append an audit record when the credential upsert fails", async () => {
    const originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "credential-command-test-secret-at-least-32-bytes";
    try {
      const calls: string[] = [];
      const client = {
        query: async (sql: string) => {
          calls.push(sql);
          throw new Error("credential write failed");
        }
      } as unknown as PoolClient;

      await expect(commands.setJudgeProviderKeyOnClient(
        client,
        "project-1",
        "anthropic",
        "test-key",
        "user-1"
      )).rejects.toThrow("credential write failed");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("insert into judge_provider_keys");
    } finally {
      if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });

  it("fails closed when the paired audit append fails", async () => {
    const originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "credential-command-test-secret-at-least-32-bytes";
    try {
      const calls: string[] = [];
      const client = {
        query: async (sql: string) => {
          calls.push(sql);
          if (sql.includes("insert into judge_provider_keys")) {
            return {
              rows: [{
                provider: "anthropic",
                key_display: "test…",
                created_at: "2026-09-02T00:00:00.000Z"
              }],
              rowCount: 1
            };
          }
          throw new Error("audit append failed");
        }
      } as unknown as PoolClient;

      await expect(commands.setJudgeProviderKeyOnClient(
        client,
        "project-1",
        "anthropic",
        "test-key",
        "user-1"
      )).rejects.toThrow("audit append failed");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("insert into judge_provider_keys");
      expect(calls[1]).toContain("insert into audit_logs");
    } finally {
      if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });
});
