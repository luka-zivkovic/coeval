import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegressionRunResult } from "@coeval/shared";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as commands from "../src/repository.pg/regression-run-commands.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const COMMAND_PATH = path.join(API_DIRECTORY, "src/repository.pg/regression-run-commands.ts");
const EXPECTED_COMMAND_EXPORTS = ["insertRegressionRun"];

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

function regressionRunFixture(): RegressionRunResult {
  return {
    id: "regression-run-1",
    skillVersionId: "skill-version-1",
    datasetRevisionId: "dataset-revision-1",
    status: "overridden",
    compared: 8,
    regressed: 1,
    improved: 2,
    flipped: 3,
    overrideReason: "Known evaluator migration accepted by an owner.",
    error: "provider returned one malformed result",
    goldenSetMissing: true,
    cases: [{
      caseId: "case-1",
      traceId: "trace-1",
      agreedLabel: "pass",
      newLabel: "fail",
      change: "regress",
      rationale: "The new evaluator rejected the previously accepted case."
    }],
    createdAt: "2026-09-02T00:00:00.000Z"
  };
}

describe("PostgreSQL regression-run client commands", () => {
  it("pins one caller-owned PoolClient command and its complete private module surface", () => {
    const source = sourceFile();
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMMAND_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Regression-run command module symbol was not resolved");

    expect(Object.keys(commands).sort()).toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(functions.map((statement) => statement.name?.text)).toEqual([
      "insertRegressionRun"
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

  it("binds the complete immutable regression result and derives criterion ownership in SQL", async () => {
    const regressionRun = regressionRunFixture();
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
    } as unknown as PoolClient;

    await commands.insertRegressionRun(client, regressionRun, {
      projectId: "project-1",
      actorUserId: "user-1"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql.replace(/\s+/g, " ").trim()).toBe(
      "insert into regression_runs " +
      "(id, project_id, skill_version_id, dataset_revision_id, status, compared, regressed, improved, flipped, " +
      "override_reason, override_actor_user_id, golden_set_missing, cases, error_message, created_at, " +
      "criterion_version_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, " +
      "(select criterion_version_id from skill_versions where id=$3 and project_id=$2))"
    );
    expect(calls[0]?.values).toEqual([
      "regression-run-1",
      "project-1",
      "skill-version-1",
      "dataset-revision-1",
      "overridden",
      8,
      1,
      2,
      3,
      "Known evaluator migration accepted by an owner.",
      "user-1",
      true,
      JSON.stringify(regressionRun.cases),
      "provider returned one malformed result",
      "2026-09-02T00:00:00.000Z"
    ]);
  });

  it("stores absent override, actor, and error fields as null without changing case evidence", async () => {
    const regressionRun: RegressionRunResult = {
      ...regressionRunFixture(),
      status: "passed",
      overrideReason: undefined,
      error: undefined,
      goldenSetMissing: false,
      cases: []
    };
    const calls: Array<unknown[] | undefined> = [];
    const client = {
      query: async (_sql: string, values?: unknown[]) => {
        calls.push(values);
        return { rows: [], rowCount: 1 };
      }
    } as unknown as PoolClient;

    await commands.insertRegressionRun(client, regressionRun, { projectId: "project-1" });

    expect(calls).toEqual([[
      "regression-run-1",
      "project-1",
      "skill-version-1",
      "dataset-revision-1",
      "passed",
      8,
      1,
      2,
      3,
      null,
      null,
      false,
      "[]",
      null,
      "2026-09-02T00:00:00.000Z"
    ]]);
  });

  it("propagates insert failures to the caller-owned transaction", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        throw new Error("regression-run insert failed");
      }
    } as unknown as PoolClient;

    await expect(commands.insertRegressionRun(
      client,
      regressionRunFixture(),
      { projectId: "project-1", actorUserId: "user-1" }
    )).rejects.toThrow("regression-run insert failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("insert into regression_runs");
  });
});
