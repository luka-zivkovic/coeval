import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { RecursiveTraceSkippedError } from "../src/repository.js";
import * as commands from "../src/repository.pg/trace-import-commands.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const COMMAND_PATH = path.join(API_DIRECTORY, "src/repository.pg/trace-import-commands.ts");
const EXPECTED_COMMAND_EXPORTS = ["importTraceOnClient", "lockTraceImportIdentity"] as const;

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

describe("PostgreSQL trace-import client commands", () => {
  it("pins the two caller-owned PoolClient commands and forbids transaction ownership", () => {
    const source = sourceFile();
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMMAND_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Trace-import command module symbol was not resolved");

    expect(Object.keys(commands).sort()).toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(functions.map((statement) => statement.name?.text)).toEqual([
      "lockTraceImportIdentity",
      "importTraceOnClient"
    ]);
    expect(functions.map((statement) => statement.parameters[0]?.type?.getText(source)))
      .toEqual(["PoolClient", "PoolClient"]);
    expect(source.statements.filter((statement) =>
      !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement)
    )).toEqual([]);
    expect(source.text).not.toMatch(
      /\.connect\s*\(|\.query\s*\(\s*["'`](?:begin|commit|rollback)\b|\.release\s*\(/i
    );
  }, 30_000);

  it("preserves the advisory-lock identity and exact query arguments", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
      }
    } as unknown as PoolClient;

    await commands.lockTraceImportIdentity(client, "project-1", "langsmith", "trace-1", "v2", "remote-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql.replace(/\s+/g, " ").trim()).toContain(
      "select pg_advisory_xact_lock( hashtextextended(jsonb_build_array"
    );
    expect(calls[0]?.values).toEqual(["project-1", "langsmith", "remote-1", "trace-1", "v2"]);
  });

  it("returns an existing imported identity without writing", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return sql.includes("from raw_traces rt")
          ? { rows: [{ raw_trace_id: "raw-existing", case_id: "case-existing", source_trace_id: "trace-existing" }] }
          : { rows: [] };
      }
    } as unknown as PoolClient;

    await expect(commands.importTraceOnClient(client, "project-1", "manual", {
      sourceTraceId: " trace-existing ",
      input: { prompt: "hello" },
      output: { answer: "world" },
      metadata: {}
    }, {
      ingestionPurpose: "analysis_eligible_manual",
      sourceTraceVersion: "v1",
      sourceRemoteProjectId: "remote-1"
    })).resolves.toEqual({
      rawTraceId: "raw-existing",
      caseId: "case-existing",
      sourceTraceId: "trace-existing",
      created: false
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.values).toEqual(["project-1", "trace-existing", "manual", "v1", "remote-1"]);
    expect(calls.map((call) => call.sql).join("\n")).not.toContain("insert into");
  });

  it("preserves insert order, redaction, input identity, and imported-trace counting", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
      }
    } as unknown as PoolClient;

    const result = await commands.importTraceOnClient(client, "project-1", "manual", {
      sourceTraceId: "trace-new",
      input: { prompt: "hello", api_key: "secret" },
      output: { answer: "world", token: "secret" },
      metadata: {}
    }, {
      ingestionPurpose: "analysis_eligible_manual",
      sourceIntegrationId: "integration-1",
      sourceRemoteProjectId: "remote-1",
      sourceTraceVersion: "v1",
      importJobId: "job-1"
    });

    expect(result).toMatchObject({ sourceTraceId: "trace-new", created: true });
    expect(result.rawTraceId).toMatch(/^raw_/);
    expect(result.caseId).toMatch(/^case_/);
    expect(calls.map((call) => call.sql.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("select pg_advisory_xact_lock"),
      expect.stringContaining("from raw_traces rt"),
      expect.stringContaining("insert into raw_traces"),
      expect.stringContaining("insert into cases"),
      expect.stringContaining("insert into case_input_identity_records"),
      expect.stringContaining("update projects")
    ]);
    expect(calls[2]?.values?.slice(0, 7)).toEqual([
      result.rawTraceId,
      "project-1",
      "integration-1",
      "remote-1",
      "trace-new",
      "v1",
      "job-1"
    ]);
    expect(String(calls[2]?.values?.[7])).toContain('"api_key":"secret"');
    expect(String(calls[3]?.values?.[4])).toContain('"api_key":"[REDACTED]"');
    expect(String(calls[3]?.values?.[4])).toContain('"token":"[REDACTED]"');
    const inputIdentity = datasetInputIdentity({ input: { prompt: "hello", api_key: "secret" } });
    expect(calls[4]?.values?.slice(1)).toEqual([
      "project-1",
      result.caseId,
      inputIdentity.basis,
      inputIdentity.digest
    ]);
    expect(calls[5]?.values).toEqual(["project-1"]);
  });

  it("keeps gate evidence out of the imported-trace counter and rejects recursive imports before querying", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      }
    } as unknown as PoolClient;

    await commands.importTraceOnClient(client, "project-1", "release_evidence", {
      sourceTraceId: "gate-1",
      input: {},
      output: {},
      metadata: {}
    }, { ingestionPurpose: "release_evidence" });
    expect(calls).toHaveLength(5);
    expect(calls.join("\n")).not.toContain("update projects");

    calls.splice(0);
    await expect(commands.importTraceOnClient(client, "project-1", "gate_candidate", {
      sourceTraceId: "gate-candidate-1",
      input: {},
      output: {},
      metadata: {}
    }, { ingestionPurpose: "release_evidence" })).rejects.toThrow(
      "Ingestion purpose release_evidence is not valid for case source gate_candidate"
    );
    expect(calls).toEqual([]);

    await expect(commands.importTraceOnClient(client, "project-1", "manual", {
      sourceTraceId: "invalid-purpose-1",
      input: {},
      output: {},
      metadata: { coeval: { internal: true } }
    }, { ingestionPurpose: "release_evidence" })).rejects.toThrow(
      "Ingestion purpose release_evidence is not valid for case source manual"
    );
    expect(calls).toEqual([]);

    await expect(commands.importTraceOnClient(client, "project-1", "manual", {
      sourceTraceId: "recursive-1",
      input: {},
      output: {},
      metadata: { coeval: { internal: true } }
    }, { ingestionPurpose: "analysis_eligible_manual" })).rejects.toBeInstanceOf(RecursiveTraceSkippedError);
    expect(calls).toEqual([]);
  });
});
