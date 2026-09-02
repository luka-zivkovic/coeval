import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as historicalGateModule from "../src/repository.pg/historical-gate-evidence-repository.js";
import * as pgRepositoryModule from "../src/repository.pg.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgHistoricalGateEvidenceRepository } from "../src/repository.pg/historical-gate-evidence-repository.js";
import type { CreateGateCheckInputDb } from "../src/repository.js";

const EXPECTED_METHODS = [
  "createGateCheck",
  "getGateCheckDetail",
  "listGateChecks"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const HISTORICAL_GATE_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/historical-gate-evidence-repository.ts"
);

function sourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function classDeclaration(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const declarations = source.statements.filter((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name
  );
  expect(declarations).toHaveLength(1);
  return declarations[0]!;
}

function normalized(node: ts.Node, source: ts.SourceFile): string {
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, source)
    .replace(/\s+/g, " ")
    .trim();
}

function createApiProgram(): ts.Program {
  const configPath = ts.findConfigFile(API_DIRECTORY, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function resolvedConstructorSymbol(checker: ts.TypeChecker, node: ts.Expression): ts.Symbol | undefined {
  const direct = resolvedSymbol(checker, node);
  const typeSymbol = checker.getTypeAtLocation(node).getSymbol();
  const symbol = typeSymbol ?? direct;
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function relativeSourceName(source: ts.SourceFile): string {
  return path.relative(API_SOURCE_DIRECTORY, source.fileName).split(path.sep).join("/");
}

function nearestFunctionOwner(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isConstructorDeclaration(current)) {
      const parent = current.parent;
      return ts.isClassDeclaration(parent) && parent.name ? `${parent.name.text}.constructor` : "<constructor>";
    }
    if (ts.isMethodDeclaration(current)) {
      const parent = current.parent;
      const className = ts.isClassDeclaration(parent) ? parent.name?.text : undefined;
      return `${className ?? "<class>"}.${current.name.getText()}`;
    }
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      return ts.isFunctionDeclaration(current) && current.name ? current.name.text : "<anonymous>";
    }
  }
  return "<module>";
}

function historicalGateRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const historicalGateSource = program.getSourceFile(HISTORICAL_GATE_REPOSITORY_PATH);
  if (!historicalGateSource) throw new Error("PostgreSQL historical gate source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(historicalGateSource);
  if (!moduleSymbol) throw new Error("PostgreSQL historical gate module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgHistoricalGateEvidenceRepository");
  if (!classExport) throw new Error("PgHistoricalGateEvidenceRepository export was not resolved");
  const classSymbol = classExport.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(classExport)
    : classExport;
  const allocations: string[] = [];
  const moduleEdges: string[] = [];
  const moduleSpecifierMentions: string[] = [];
  const references: string[] = [];

  for (const source of program.getSourceFiles()) {
    const sourcePath = path.resolve(source.fileName);
    if (
      source.isDeclarationFile ||
      (sourcePath !== API_SOURCE_DIRECTORY && !sourcePath.startsWith(`${API_SOURCE_DIRECTORY}${path.sep}`))
    ) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const resolution = ts.resolveModuleName(
          node.text,
          source.fileName,
          program.getCompilerOptions(),
          ts.sys
        ).resolvedModule;
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(HISTORICAL_GATE_REPOSITORY_PATH)) {
          moduleSpecifierMentions.push(
            `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.getText(source)}`
          );
          if (
            ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            ts.isImportEqualsDeclaration(node.parent) ||
            ts.isCallExpression(node.parent)
          ) {
            moduleEdges.push(
              `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.parent.getText(source)
                .replace(/\s+/g, " ")
                .trim()}`
            );
          }
        }
      }
      if (
        ts.isIdentifier(node) &&
        node.text === "PgHistoricalGateEvidenceRepository" &&
        resolvedSymbol(checker, node) === classSymbol
      ) {
        references.push(`${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.text}`);
      }
      if (ts.isNewExpression(node) && resolvedConstructorSymbol(checker, node.expression) === classSymbol) {
        allocations.push(
          `${relativeSourceName(source)}:${nearestFunctionOwner(node)}:${node.getText(source)
            .replace(/\s+/g, " ")
            .trim()}`
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return {
    allocations: allocations.sort(),
    compilerExports: compilerExports.map((symbol) => symbol.name).sort(),
    moduleEdges: moduleEdges.sort(),
    moduleSpecifierMentions: moduleSpecifierMentions.sort(),
    references: references.sort()
  };
}

function gateInput(): CreateGateCheckInputDb {
  return {
    projectId: "project-1",
    skillVersionId: "skillv-1",
    evalRunId: "run-1",
    maxDisagreements: 0,
    items: [
      {
        goldenEntryId: "gold-1",
        goldenCaseId: "case-golden-1",
        caseKey: "trace-golden-1",
        candidateCaseId: "case-candidate-1",
        expectedLabel: "pass"
      },
      {
        goldenEntryId: "gold-2",
        goldenCaseId: "case-golden-2",
        caseKey: "trace-golden-2",
        candidateCaseId: "case-candidate-2",
        expectedLabel: "fail"
      }
    ]
  };
}

describe("PostgreSQL historical gate-evidence repository slice", () => {
  it("owns exactly the HistoricalGateEvidenceRepositoryPort methods behind direct facade delegates", () => {
    const historicalGateSource = sourceFile(HISTORICAL_GATE_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const historicalGateRepository = classDeclaration(
      historicalGateSource,
      "PgHistoricalGateEvidenceRepository"
    );
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(historicalGateModule)).toEqual(["PgHistoricalGateEvidenceRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(historicalGateSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(historicalGateSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgHistoricalGateEvidenceRepository"]);
    expect(historicalGateRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(historicalGateSource))
    )).toEqual(["HistoricalGateEvidenceRepositoryPort"]);
    expect(historicalGateRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(historicalGateSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(historicalGateRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, historicalGateSource))
    )).toEqual([["private readonly pool: Pool"]]);

    const expectedDelegates = new Map<string, string>([
      ["createGateCheck", "{ return this.historicalGateEvidenceRepository.createGateCheck(input); }"],
      ["getGateCheckDetail", "{ return this.historicalGateEvidenceRepository.getGateCheckDetail(projectId, gateCheckId); }"],
      ["listGateChecks", "{ return this.historicalGateEvidenceRepository.listGateChecks(projectId, opts); }"]
    ]);
    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_METHODS.includes(
        method.name.getText(repositorySource) as typeof EXPECTED_METHODS[number]
      ));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_METHODS);
    for (const method of facadeMethods) {
      expect(normalized(method.body!, repositorySource))
        .toBe(expectedDelegates.get(method.name.getText(repositorySource)));
    }
  });

  it("constructs exactly one slice with the facade pool", () => {
    const analysis = historicalGateRepositoryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgHistoricalGateEvidenceRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgHistoricalGateEvidenceRepository(pool)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgHistoricalGateEvidenceRepository } from "./repository.pg/historical-gate-evidence-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/historical-gate-evidence-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgHistoricalGateEvidenceRepository",
      "repository.pg.ts:NewExpression:PgHistoricalGateEvidenceRepository",
      "repository.pg.ts:TypeReference:PgHistoricalGateEvidenceRepository",
      "repository.pg/historical-gate-evidence-repository.ts:ClassDeclaration:PgHistoricalGateEvidenceRepository"
    ]);

    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "historicalGateEvidenceRepository") as PgHistoricalGateEvidenceRepository;
    expect(slice).toBeInstanceOf(PgHistoricalGateEvidenceRepository);
    expect(Object.keys(slice)).toEqual(["pool"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);
  }, 30_000);

  it("commits the gate and item atomically before loading the derived projection", async () => {
    const events: string[] = [];
    const clientCalls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const poolCalls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let gateCheckId = "";
    const gateItemIds: string[] = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        events.push(`client:${sql.replace(/\s+/g, " ").trim()}`);
        clientCalls.push({ sql, values });
        if (sql.includes("insert into gate_checks")) gateCheckId = String(values?.[0]);
        if (sql.includes("insert into gate_check_items")) gateItemIds.push(String(values?.[0]));
        return { rows: [], rowCount: 1 };
      },
      release: () => events.push("release")
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string, values?: unknown[]) => {
        events.push(`pool:${sql.replace(/\s+/g, " ").trim()}`);
        poolCalls.push({ sql, values });
        if (poolCalls.length === 1) {
          return {
            rows: [{
              id: gateCheckId,
              project_id: "project-1",
              skill_version_id: "skillv-1",
              eval_run_id: "run-1",
              label: null,
              metadata: "{}",
              max_disagreements: 0,
              run_status: "completed",
              run_total_items: 2,
              run_completed_items: 2,
              run_failed_items: 0,
              run_agreed_items: 2,
              created_at: new Date("2026-09-02T00:00:00.000Z"),
              run_finished_at: new Date("2026-09-02T00:01:00.000Z")
            }],
            rowCount: 1
          };
        }
        return {
          rows: [
            {
              id: gateItemIds[0],
              gate_check_id: gateCheckId,
              golden_entry_id: "gold-1",
              golden_case_id: "case-golden-1",
              candidate_case_id: "case-candidate-1",
              case_key: "trace-golden-1",
              expected_label: "pass",
              eval_status: "completed",
              result_label: "pass",
              agreement: true,
              cached: false,
              eval_error: null,
              created_at: new Date("2026-09-02T00:00:00.000Z")
            },
            {
              id: gateItemIds[1],
              gate_check_id: gateCheckId,
              golden_entry_id: "gold-2",
              golden_case_id: "case-golden-2",
              candidate_case_id: "case-candidate-2",
              case_key: "trace-golden-2",
              expected_label: "fail",
              eval_status: "completed",
              result_label: "fail",
              agreement: true,
              cached: true,
              eval_error: null,
              created_at: new Date("2026-09-02T00:00:01.000Z")
            }
          ],
          rowCount: 2
        };
      }
    } as unknown as Pool;
    const repository = new PgHistoricalGateEvidenceRepository(pool);

    await expect(repository.createGateCheck(gateInput())).resolves.toEqual({
      id: expect.stringMatching(/^gate_/),
      projectId: "project-1",
      skillVersionId: "skillv-1",
      evalRunId: "run-1",
      label: null,
      metadata: {},
      maxDisagreements: 0,
      status: "passed",
      totalCandidates: 2,
      judgedCandidates: 2,
      erroredCandidates: 0,
      disagreements: 0,
      createdAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:01:00.000Z",
      items: [
        {
          id: expect.stringMatching(/^gati_/),
          gateCheckId: expect.stringMatching(/^gate_/),
          goldenEntryId: "gold-1",
          goldenCaseId: "case-golden-1",
          caseKey: "trace-golden-1",
          candidateCaseId: "case-candidate-1",
          expectedLabel: "pass",
          status: "completed",
          judgedLabel: "pass",
          agreement: true,
          cached: false,
          error: null,
          createdAt: "2026-09-02T00:00:00.000Z"
        },
        {
          id: expect.stringMatching(/^gati_/),
          gateCheckId: expect.stringMatching(/^gate_/),
          goldenEntryId: "gold-2",
          goldenCaseId: "case-golden-2",
          caseKey: "trace-golden-2",
          candidateCaseId: "case-candidate-2",
          expectedLabel: "fail",
          status: "completed",
          judgedLabel: "fail",
          agreement: true,
          cached: true,
          error: null,
          createdAt: "2026-09-02T00:00:01.000Z"
        }
      ]
    });

    expect(clientCalls.map((entry) => entry.sql.replace(/\s+/g, " ").trim())).toEqual([
      "begin",
      expect.stringContaining("insert into gate_checks"),
      expect.stringContaining("insert into gate_check_items"),
      expect.stringContaining("insert into gate_check_items"),
      "commit"
    ]);
    expect(clientCalls[1]?.values).toEqual([
      expect.stringMatching(/^gate_/),
      "project-1",
      "skillv-1",
      "run-1",
      null,
      "{}",
      0,
      null
    ]);
    expect(clientCalls[2]?.values).toEqual([
      expect.stringMatching(/^gati_/),
      gateCheckId,
      "project-1",
      "gold-1",
      "case-golden-1",
      "case-candidate-1",
      "trace-golden-1",
      "pass"
    ]);
    expect(clientCalls[3]?.values).toEqual([
      expect.stringMatching(/^gati_/),
      gateCheckId,
      "project-1",
      "gold-2",
      "case-golden-2",
      "case-candidate-2",
      "trace-golden-2",
      "fail"
    ]);
    expect(clientCalls[2]?.values?.[0]).not.toBe(clientCalls[3]?.values?.[0]);
    expect(events.filter((event) => event === "release")).toEqual(["release"]);
    expect(events.indexOf("release")).toBeLessThan(events.findIndex((event) => event.startsWith("pool:")));
    expect(poolCalls[0]).toEqual({
      sql: `select gc.*, er.status as run_status, er.total_items as run_total_items,
   er.completed_items as run_completed_items, er.failed_items as run_failed_items,
   er.agreed_items as run_agreed_items, er.finished_at as run_finished_at
       from gate_checks gc
       join eval_runs er on er.id = gc.eval_run_id
       where gc.id = $1 and gc.project_id = $2`,
      values: [gateCheckId, "project-1"]
    });
    expect(poolCalls[1]).toEqual({
      sql: `select gi.*, eri.status as eval_status, eri.result_label, eri.agreement, eri.cached, eri.error as eval_error
       from gate_check_items gi
       left join eval_run_items eri
         on eri.eval_run_id = $2 and eri.case_id = gi.candidate_case_id
       where gi.gate_check_id = $1
       order by gi.created_at asc, gi.id asc`,
      values: [gateCheckId, "run-1"]
    });
  });

  it("fails closed when the committed gate cannot be reloaded", async () => {
    const calls: string[] = [];
    let released = 0;
    const client = {
      query: async (sql: string) => {
        calls.push(sql.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 1 };
      },
      release: () => {
        released += 1;
      }
    };
    const pool = {
      connect: async () => client,
      query: async () => ({ rows: [], rowCount: 0 })
    } as unknown as Pool;
    const repository = new PgHistoricalGateEvidenceRepository(pool);

    await expect(repository.createGateCheck(gateInput()))
      .rejects.toThrow(/^Gate check vanished after create: gate_/);
    expect(calls).toEqual([
      "begin",
      expect.stringContaining("insert into gate_checks"),
      expect.stringContaining("insert into gate_check_items"),
      expect.stringContaining("insert into gate_check_items"),
      "commit"
    ]);
    expect(released).toBe(1);
  });

  it("rolls back a failed item insert, rethrows the original error, and releases", async () => {
    const originalError = new Error("item insert failed");
    const calls: string[] = [];
    let released = 0;
    let itemInsertCount = 0;
    const client = {
      query: async (sql: string) => {
        calls.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("insert into gate_check_items")) {
          itemInsertCount += 1;
          if (itemInsertCount === 2) throw originalError;
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => {
        released += 1;
      }
    };
    const pool = {
      connect: async () => client,
      query: async () => {
        throw new Error("projection must not load after rollback");
      }
    } as unknown as Pool;
    const repository = new PgHistoricalGateEvidenceRepository(pool);

    await expect(repository.createGateCheck(gateInput())).rejects.toBe(originalError);
    expect(calls).toEqual([
      "begin",
      expect.stringContaining("insert into gate_checks"),
      expect.stringContaining("insert into gate_check_items"),
      expect.stringContaining("insert into gate_check_items"),
      "rollback"
    ]);
    expect(released).toBe(1);
  });

  it("keeps detail and list reads project-scoped, ordered, limited, and fail-closed", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let call = 0;
    const completeRow = {
      id: "gate-1",
      project_id: "project-1",
      skill_version_id: "skillv-1",
      eval_run_id: "run-1",
      label: "historical",
      metadata: JSON.stringify({ source: "legacy" }),
      max_disagreements: 0,
      run_status: "completed",
      run_total_items: 1,
      run_completed_items: 1,
      run_failed_items: 0,
      run_agreed_items: 0,
      created_at: new Date("2026-09-02T00:00:00.000Z"),
      run_finished_at: new Date("2026-09-02T00:01:00.000Z")
    };
    const pendingRow = {
      ...completeRow,
      id: "gate-older",
      eval_run_id: "run-older",
      run_status: "pending",
      run_completed_items: 0,
      created_at: new Date("2026-09-01T00:00:00.000Z"),
      run_finished_at: null
    };
    const errorRow = {
      ...completeRow,
      id: "gate-error",
      eval_run_id: "run-error",
      run_status: "failed",
      run_failed_items: 1,
      created_at: new Date("2026-09-01T12:00:00.000Z")
    };
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        call += 1;
        if (call === 1) return { rows: [], rowCount: 0 };
        if (call === 2) return { rows: [completeRow, errorRow, pendingRow], rowCount: 3 };
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const repository = new PgHistoricalGateEvidenceRepository(pool);

    await expect(repository.getGateCheckDetail("project-1", "gate-missing")).resolves.toBeNull();
    await expect(repository.listGateChecks("project-1")).resolves.toEqual([
      expect.objectContaining({ id: "gate-1", status: "blocked", disagreements: 1 }),
      expect.objectContaining({ id: "gate-error", status: "error", erroredCandidates: 1 }),
      expect.objectContaining({ id: "gate-older", status: "pending", disagreements: 0 })
    ]);
    await expect(repository.listGateChecks("project-1", { limit: 2 })).resolves.toEqual([]);

    expect(calls[0]).toEqual({
      sql: `select gc.*, er.status as run_status, er.total_items as run_total_items,
   er.completed_items as run_completed_items, er.failed_items as run_failed_items,
   er.agreed_items as run_agreed_items, er.finished_at as run_finished_at
       from gate_checks gc
       join eval_runs er on er.id = gc.eval_run_id
       where gc.id = $1 and gc.project_id = $2`,
      values: ["gate-missing", "project-1"]
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual({
      sql: expect.stringContaining("where gc.project_id = $1\n       order by gc.created_at desc\n       limit $2"),
      values: ["project-1", 50]
    });
    expect(calls[2]?.values).toEqual(["project-1", 2]);
  });
});
