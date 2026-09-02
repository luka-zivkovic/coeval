import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as commands from "../src/repository.pg/project-counter-commands.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const COMMAND_PATH = path.join(API_DIRECTORY, "src/repository.pg/project-counter-commands.ts");
const EXPECTED_COMMAND_EXPORTS = ["refreshProjectCounters"];

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

describe("PostgreSQL project-counter client commands", () => {
  it("pins one caller-owned PoolClient command and its complete private module surface", () => {
    const source = sourceFile();
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMMAND_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Project-counter command module symbol was not resolved");

    expect(Object.keys(commands).sort()).toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(functions.map((statement) => statement.name?.text)).toEqual([
      "refreshProjectCounters"
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

  it("recomputes imported, auto-judged, and sync-back counters with exact exclusions", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
    } as unknown as PoolClient;

    await commands.refreshProjectCounters(client, "project-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(
      `update projects
       set imported_trace_count = (
             -- Gate candidates (case_type 'gate_candidate') are product-gate
             -- scaffolding, not imported traffic — excluded here and in the
             -- importTrace increment.
             select count(*)::int
             from raw_traces rt
             where rt.project_id = $1
               and not exists (
                 select 1 from cases c
                 where c.raw_trace_id = rt.id
                   and c.case_type in ('gate_candidate', 'release_evidence')
               )
           ),
           auto_judged_trace_count = (
             -- Distinct cases, not judge_runs rows: re-judges (new versions,
             -- self-consistency probes) must not push coverage past 100%.
             -- Gate candidates are excluded to match the imported count.
             select count(distinct jr.case_id)::int
             from judge_runs jr
             join cases c on c.id = jr.case_id
             where jr.project_id = $1
               and c.case_type not in ('gate_candidate', 'release_evidence')
           ),
           sync_back_coverage = coalesce((
             select count(*) filter (where fsj.status = 'synced')::numeric / nullif(count(*)::numeric, 0)
             from feedback_sync_jobs fsj
             where fsj.project_id = $1 and fsj.provider in ('langsmith', 'langfuse', 'ironside')
           ), 0),
           updated_at = now()
       where id = $1`
    );
    expect(calls[0]?.values).toEqual(["project-1"]);
  });

  it("propagates refresh failures to the caller-owned retention transaction", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        throw new Error("project-counter refresh failed");
      }
    } as unknown as PoolClient;

    await expect(commands.refreshProjectCounters(client, "project-1"))
      .rejects.toThrow("project-counter refresh failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("update projects");
  });
});
