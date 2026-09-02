import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as datasetModule from "../src/repository.pg/dataset-repository.js";
import * as traceTestModule from "../src/repository.pg/trace-test-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgDatasetRepository } from "../src/repository.pg/dataset-repository.js";
import { PgTraceTestRepository } from "../src/repository.pg/trace-test-repository.js";
import {
  DatasetRevisionConflictError,
  DatasetRevisionNotFoundError,
  SealedValidationUnavailableError
} from "../src/repository/errors.js";

const TRACE_TEST_METHODS = [
  "createTraceTest",
  "listTraceTests",
  "getTraceTest",
  "reviseTraceTest",
  "recordTraceTestValidation",
  "enableTraceTest",
  "recordTraceTestFunnelEvent"
] as const;

const DATASET_METHODS = [
  "createDataset",
  "listDatasets",
  "getDatasetDetail",
  "archiveDataset",
  "addDatasetItems",
  "importDatasetExamples",
  "createDatasetRevision",
  "listDatasetRevisions",
  "getDatasetRevisionDetail",
  "recordDatasetRevisionContentView",
  "getOrCreateRegressionDatasetRevision",
  "removeDatasetItem"
] as const;

const DATASET_FACADE_METHODS = [
  "importDatasetExamples",
  "createDataset",
  "listDatasets",
  "getDatasetDetail",
  "archiveDataset",
  "addDatasetItems",
  "removeDatasetItem",
  "createDatasetRevision",
  "listDatasetRevisions",
  "getDatasetRevisionDetail",
  "recordDatasetRevisionContentView",
  "getOrCreateRegressionDatasetRevision"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(SOURCE_DIRECTORY, "repository.pg.ts");
const TRACE_TEST_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/trace-test-repository.ts");
const DATASET_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/dataset-repository.ts");
const CREATED_AT = "2026-09-02T00:00:00.000Z";

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

function methodNames(declaration: ts.ClassDeclaration, source: ts.SourceFile): string[] {
  return declaration.members.filter(ts.isMethodDeclaration).map((method) => method.name.getText(source));
}

function productionStatementInventory(source: ts.SourceFile): string[] {
  return source.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => ts.isClassDeclaration(statement)
      ? `${ts.SyntaxKind[statement.kind]}:${statement.name?.text ?? "<anonymous>"}`
      : ts.SyntaxKind[statement.kind]);
}

function classMemberInventory(declaration: ts.ClassDeclaration, source: ts.SourceFile): string[] {
  return declaration.members.map((member) => {
    if (ts.isConstructorDeclaration(member)) return "Constructor";
    if (ts.isMethodDeclaration(member)) {
      return `${ts.SyntaxKind[member.kind]}:${member.name.getText(source)}`;
    }
    return ts.SyntaxKind[member.kind];
  });
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
  return path.relative(SOURCE_DIRECTORY, source.fileName).split(path.sep).join("/");
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

function repositorySliceAnalysis(program: ts.Program, modulePath: string, className: string) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(modulePath);
  if (!sliceSource) throw new Error(`${className} source was not loaded`);
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error(`${className} module symbol was not resolved`);
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === className);
  if (!classExport) throw new Error(`${className} export was not resolved`);
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
      (sourcePath !== SOURCE_DIRECTORY && !sourcePath.startsWith(`${SOURCE_DIRECTORY}${path.sep}`))
    ) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const resolution = ts.resolveModuleName(
          node.text,
          source.fileName,
          program.getCompilerOptions(),
          ts.sys
        ).resolvedModule;
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(modulePath)) {
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
      if (ts.isIdentifier(node) && node.text === className && resolvedSymbol(checker, node) === classSymbol) {
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

describe("PostgreSQL trace-test and dataset repository slices", () => {
  it("owns both complete ports behind direct facade delegates", () => {
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const repository = classDeclaration(repositorySource, "PgRepository");
    const traceTestSource = sourceFile(TRACE_TEST_PATH);
    const traceTest = classDeclaration(traceTestSource, "PgTraceTestRepository");
    const datasetSource = sourceFile(DATASET_PATH);
    const dataset = classDeclaration(datasetSource, "PgDatasetRepository");

    expect(Object.keys(traceTestModule)).toEqual(["PgTraceTestRepository"]);
    expect(Object.keys(datasetModule)).toEqual(["PgDatasetRepository"]);
    expect(traceTest.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(traceTestSource))
    )).toEqual(["TraceTestRepositoryPort"]);
    expect(dataset.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(datasetSource))
    )).toEqual(["DatasetRepositoryPort"]);
    expect(productionStatementInventory(traceTestSource)).toEqual([
      "ClassDeclaration:PgTraceTestRepository"
    ]);
    expect(productionStatementInventory(datasetSource)).toEqual([
      "ClassDeclaration:PgDatasetRepository"
    ]);
    expect(classMemberInventory(traceTest, traceTestSource)).toEqual([
      "Constructor",
      ...TRACE_TEST_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(classMemberInventory(dataset, datasetSource)).toEqual([
      "Constructor",
      ...DATASET_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    for (const [declaration, source] of [
      [traceTest, traceTestSource],
      [dataset, datasetSource]
    ] as const) {
      const constructors = declaration.members.filter(ts.isConstructorDeclaration);
      expect(constructors).toHaveLength(1);
      expect(constructors[0]!.parameters.map((parameter) => normalized(parameter, source)))
        .toEqual(["private readonly pool: Pool"]);
    }
    expect(methodNames(traceTest, traceTestSource)).toEqual(TRACE_TEST_METHODS);
    expect(methodNames(dataset, datasetSource)).toEqual(DATASET_METHODS);

    for (const [field, names, facadeNames] of [
      ["traceTestRepository", TRACE_TEST_METHODS, TRACE_TEST_METHODS],
      ["datasetRepository", DATASET_METHODS, DATASET_FACADE_METHODS]
    ] as const) {
      const methods = repository.members.filter(ts.isMethodDeclaration).filter((method) =>
        (names as readonly string[]).includes(method.name.getText(repositorySource))
      );
      expect(methods.map((method) => method.name.getText(repositorySource))).toEqual(facadeNames);
      expect(methods).toHaveLength(names.length);
      for (const method of methods) {
        const name = method.name.getText(repositorySource);
        const parameters = method.parameters.map((parameter) => parameter.name.getText(repositorySource));
        expect(normalized(method.body!, repositorySource))
          .toBe(`{ return this.${field}.${name}(${parameters.join(", ")}); }`);
      }
    }
  });

  it("allocates each slice exactly once through its canonical module edge", () => {
    const program = createApiProgram();
    const traceTest = repositorySliceAnalysis(program, TRACE_TEST_PATH, "PgTraceTestRepository");
    const dataset = repositorySliceAnalysis(program, DATASET_PATH, "PgDatasetRepository");

    expect(traceTest).toEqual({
      allocations: ["repository.pg.ts:PgRepository.constructor:new PgTraceTestRepository(pool)"],
      compilerExports: ["PgTraceTestRepository"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgTraceTestRepository } from "./repository.pg/trace-test-repository.js";'
      ],
      moduleSpecifierMentions: [
        'repository.pg.ts:ImportDeclaration:"./repository.pg/trace-test-repository.js"'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgTraceTestRepository",
        "repository.pg.ts:NewExpression:PgTraceTestRepository",
        "repository.pg.ts:TypeReference:PgTraceTestRepository",
        "repository.pg/trace-test-repository.ts:ClassDeclaration:PgTraceTestRepository"
      ]
    });
    expect(dataset).toEqual({
      allocations: ["repository.pg.ts:PgRepository.constructor:new PgDatasetRepository(pool)"],
      compilerExports: ["PgDatasetRepository"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgDatasetRepository } from "./repository.pg/dataset-repository.js";'
      ],
      moduleSpecifierMentions: [
        'repository.pg.ts:ImportDeclaration:"./repository.pg/dataset-repository.js"'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgDatasetRepository",
        "repository.pg.ts:NewExpression:PgDatasetRepository",
        "repository.pg.ts:TypeReference:PgDatasetRepository",
        "repository.pg/dataset-repository.ts:ClassDeclaration:PgDatasetRepository"
      ]
    });
  }, 30_000);

  it("uses one exact pool for both slices and preserves project-scoped read ordering", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        return { rows: [], rowCount: 0 };
      })
    } as unknown as Pool;
    const repository = new PgRepository(pool);
    const traceTest = Reflect.get(repository, "traceTestRepository") as PgTraceTestRepository;
    const dataset = Reflect.get(repository, "datasetRepository") as PgDatasetRepository;

    expect(traceTest).toBeInstanceOf(PgTraceTestRepository);
    expect(dataset).toBeInstanceOf(PgDatasetRepository);
    expect(Object.keys(traceTest)).toEqual(["pool"]);
    expect(Object.keys(dataset)).toEqual(["pool"]);
    expect(Reflect.get(traceTest, "pool")).toBe(pool);
    expect(Reflect.get(dataset, "pool")).toBe(pool);

    await expect(traceTest.listTraceTests("project-1", "source-1")).resolves.toEqual([]);
    await expect(dataset.listDatasets("project-1")).resolves.toEqual([]);
    expect(calls[0]?.values).toEqual(["project-1", "source-1"]);
    expect(calls[0]?.sql).toContain("order by updated_at desc, id desc");
    expect(calls[1]?.values).toEqual(["project-1"]);
    expect(calls[1]?.sql).toContain("where d.project_id = $1 and d.archived_at is null");
    expect(calls[1]?.sql).toContain("order by d.created_at desc");
  });

  it("keeps trace-test funnel idempotency and dataset content-view exposure project-scoped", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let contentViewExists = true;
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        return { rows: sql.includes("dataset_exposure_events") && contentViewExists ? [{ id: "dse-1" }] : [], rowCount: 1 };
      })
    } as unknown as Pool;
    const traceTest = new PgTraceTestRepository(pool);
    const dataset = new PgDatasetRepository(pool);

    await traceTest.recordTraceTestFunnelEvent({
      projectId: "project-1",
      journeyId: "journey-1",
      event: "started",
      elapsedMs: 125,
      intent: "make",
      actorUserId: "user-1"
    });
    expect(calls[0]?.sql).toContain("on conflict (project_id, target_id, action)");
    expect(calls[0]?.sql).toContain("where target_type = 'trace_test_funnel'");
    expect(calls[0]?.values.slice(1)).toEqual([
      "project-1",
      "user-1",
      "trace_test.funnel.started",
      "journey-1",
      JSON.stringify({ event: "started", elapsedMs: 125, intent: "make" })
    ]);

    await expect(dataset.recordDatasetRevisionContentView({
      projectId: "project-1",
      revisionId: "revision-1",
      actorUserId: "user-1"
    })).resolves.toBeUndefined();
    expect(calls[1]?.sql).toContain("where revision.id = $2 and revision.project_id = $3");
    expect(calls[1]?.values.slice(1, 5)).toEqual(["revision-1", "project-1", "person", "user-1"]);

    contentViewExists = false;
    await expect(dataset.recordDatasetRevisionContentView({
      projectId: "project-1",
      revisionId: "missing"
    })).rejects.toBeInstanceOf(DatasetRevisionNotFoundError);
    expect(calls[2]?.values.slice(1, 5)).toEqual(["missing", "project-1", "system", null]);
  });

  it("preserves dataset create mapping and active-name conflict translation", async () => {
    const row = {
      id: "dataset-1",
      project_id: "project-1",
      name: "Evaluation set",
      description: null,
      kind: "custom",
      created_at: CREATED_AT,
      archived_at: null
    };
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [row], rowCount: 1 }));
    const repository = new PgDatasetRepository({ query } as unknown as Pool);
    await expect(repository.createDataset({
      projectId: "project-1",
      name: "  Evaluation set  "
    })).resolves.toMatchObject({
      id: "dataset-1",
      projectId: "project-1",
      name: "Evaluation set",
      itemCount: 0
    });
    expect(query.mock.calls[0]?.[1]?.slice(1)).toEqual([
      "project-1",
      "Evaluation set",
      null,
      "custom",
      null
    ]);

    const conflict = { code: "23505" };
    query.mockRejectedValueOnce(conflict);
    await expect(repository.createDataset({
      projectId: "project-1",
      name: "  Evaluation set  "
    })).rejects.toMatchObject({
      name: "DatasetNameTakenError",
      message: 'An active dataset named "Evaluation set" already exists in this project'
    });
  });

  it("rejects governed revision roles before acquiring a transaction client", async () => {
    const connect = vi.fn();
    const repository = new PgDatasetRepository({ connect } as unknown as Pool);

    await expect(repository.createDatasetRevision({
      projectId: "project-1",
      datasetId: "dataset-1",
      role: "sealed_validation"
    })).rejects.toBeInstanceOf(SealedValidationUnavailableError);
    await expect(repository.createDatasetRevision({
      projectId: "project-1",
      datasetId: "dataset-1",
      role: "regression_golden"
    })).rejects.toMatchObject({
      name: "DatasetRevisionConflictError",
      message: "Regression/golden revisions are created only by promotion and retirement governance"
    } satisfies Partial<DatasetRevisionConflictError>);
    expect(connect).not.toHaveBeenCalled();
  });
});
