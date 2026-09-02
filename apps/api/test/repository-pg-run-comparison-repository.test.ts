import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as pgRepositoryModule from "../src/repository.pg.js";
import * as runComparisonModule from "../src/repository.pg/run-comparison-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgRunComparisonRepository } from "../src/repository.pg/run-comparison-repository.js";

const EXPECTED_METHODS = [
  "createRunComparison",
  "getRunComparison",
  "listRunComparisons"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const RUN_COMPARISON_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/run-comparison-repository.ts"
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

function runComparisonRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const runComparisonSource = program.getSourceFile(RUN_COMPARISON_REPOSITORY_PATH);
  if (!runComparisonSource) throw new Error("PostgreSQL run-comparison source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(runComparisonSource);
  if (!moduleSymbol) throw new Error("PostgreSQL run-comparison module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgRunComparisonRepository");
  if (!classExport) throw new Error("PgRunComparisonRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(RUN_COMPARISON_REPOSITORY_PATH)) {
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
        node.text === "PgRunComparisonRepository" &&
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

describe("PostgreSQL run-comparison repository slice", () => {
  it("owns exactly the RunComparisonRepositoryPort methods behind direct facade delegates", () => {
    const runComparisonSource = sourceFile(RUN_COMPARISON_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const runComparisonRepository = classDeclaration(runComparisonSource, "PgRunComparisonRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(runComparisonModule)).toEqual(["PgRunComparisonRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(runComparisonSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(runComparisonSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgRunComparisonRepository"]);
    expect(runComparisonRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(runComparisonSource))
    )).toEqual(["RunComparisonRepositoryPort"]);
    expect(runComparisonRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(runComparisonSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(runComparisonRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, runComparisonSource))
    )).toEqual([["private readonly pool: Pool"]]);

    const expectedDelegates = new Map<string, string>([
      ["createRunComparison", "{ return this.runComparisonRepository.createRunComparison(input); }"],
      ["getRunComparison", "{ return this.runComparisonRepository.getRunComparison(projectId, runComparisonId); }"],
      ["listRunComparisons", "{ return this.runComparisonRepository.listRunComparisons(projectId, opts); }"]
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

  it("constructs exactly one stateless slice with the facade pool", () => {
    const analysis = runComparisonRepositoryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgRunComparisonRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgRunComparisonRepository(pool)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgRunComparisonRepository } from "./repository.pg/run-comparison-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/run-comparison-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgRunComparisonRepository",
      "repository.pg.ts:NewExpression:PgRunComparisonRepository",
      "repository.pg.ts:TypeReference:PgRunComparisonRepository",
      "repository.pg/run-comparison-repository.ts:ClassDeclaration:PgRunComparisonRepository"
    ]);

    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "runComparisonRepository") as PgRunComparisonRepository;
    expect(slice).toBeInstanceOf(PgRunComparisonRepository);
    expect(Object.keys(slice)).toEqual(["pool"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);
  }, 30_000);

  it("preserves insert bindings, project-scoped reads, ordering, limits, and row mapping", async () => {
    const row = {
      id: "rcmp-row",
      project_id: "project-1",
      dataset_id: "dataset-1",
      dataset_revision_id: "revision-1",
      version_a_id: "skillv-a",
      version_b_id: "skillv-b",
      run_a_id: "run-a",
      run_b_id: "run-b",
      created_at: new Date("2026-09-02T00:00:00.000Z")
    };
    const olderRow = {
      ...row,
      id: "rcmp-older",
      dataset_revision_id: null,
      created_at: new Date("2026-09-01T00:00:00.000Z")
    };
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let call = 0;
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        call += 1;
        if (call === 1 || call === 3 || call === 5) return { rows: [row, olderRow], rowCount: 2 };
        if (call === 2) return { rows: [olderRow], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const repository = new PgRunComparisonRepository(pool);
    const expected = {
      id: "rcmp-row",
      projectId: "project-1",
      datasetId: "dataset-1",
      datasetRevisionId: "revision-1",
      versionAId: "skillv-a",
      versionBId: "skillv-b",
      runAId: "run-a",
      runBId: "run-b",
      createdAt: "2026-09-02T00:00:00.000Z"
    };
    const expectedOlder = {
      ...expected,
      id: "rcmp-older",
      datasetRevisionId: null,
      createdAt: "2026-09-01T00:00:00.000Z"
    };

    await expect(repository.createRunComparison({
      projectId: "project-1",
      datasetId: "dataset-1",
      datasetRevisionId: "revision-1",
      versionAId: "skillv-a",
      versionBId: "skillv-b",
      runAId: "run-a",
      runBId: "run-b"
    })).resolves.toEqual(expected);
    await expect(repository.createRunComparison({
      projectId: "project-1",
      datasetId: "dataset-1",
      versionAId: "skillv-a",
      versionBId: "skillv-b",
      runAId: "run-a",
      runBId: "run-b"
    })).resolves.toEqual(expectedOlder);
    await expect(repository.getRunComparison("project-1", "rcmp-row")).resolves.toEqual(expected);
    await expect(repository.getRunComparison("project-1", "rcmp-missing")).resolves.toBeNull();
    await expect(repository.listRunComparisons("project-1")).resolves.toEqual([expected, expectedOlder]);
    await expect(repository.listRunComparisons("project-1", { limit: 2 })).resolves.toEqual([]);

    expect(calls[0]?.sql).toBe(
      `insert into run_comparisons
       (id, project_id, dataset_id, dataset_revision_id, version_a_id, version_b_id, run_a_id, run_b_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`
    );
    expect(calls[0]?.values?.[0]).toEqual(expect.stringMatching(/^rcmp_/));
    expect(calls[0]?.values?.slice(1)).toEqual([
      "project-1",
      "dataset-1",
      "revision-1",
      "skillv-a",
      "skillv-b",
      "run-a",
      "run-b"
    ]);
    expect(calls[1]?.sql).toBe(calls[0]?.sql);
    expect(calls[1]?.values?.[3]).toBeNull();
    expect(calls[2]).toEqual({
      sql: "select * from run_comparisons where id = $1 and project_id = $2",
      values: ["rcmp-row", "project-1"]
    });
    expect(calls[3]?.values).toEqual(["rcmp-missing", "project-1"]);
    expect(calls[4]).toEqual({
      sql: "select * from run_comparisons where project_id = $1 order by created_at desc, id desc limit $2",
      values: ["project-1", 50]
    });
    expect(calls[5]?.values).toEqual(["project-1", 2]);
  });
});
