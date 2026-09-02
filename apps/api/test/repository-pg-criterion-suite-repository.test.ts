import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as pgRepositoryModule from "../src/repository.pg.js";
import * as criterionSuiteModule from "../src/repository.pg/criterion-suite-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgCriterionSuiteRepository } from "../src/repository.pg/criterion-suite-repository.js";

const EXPECTED_METHODS = [
  "listCriteria",
  "getCriterion",
  "createCriterion",
  "createCriterionVersion",
  "listEvaluatorSuites",
  "getEvaluatorSuite",
  "createEvaluatorSuiteManifest",
  "listEvaluatorSuiteManifests",
  "getEvaluatorSuiteManifest"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const CRITERION_SUITE_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/criterion-suite-repository.ts"
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
  const declaration = source.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name
  );
  if (!declaration) throw new Error(`${name} declaration not found`);
  return declaration;
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

function criterionSuiteAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const criterionSuiteSource = program.getSourceFile(CRITERION_SUITE_PATH);
  if (!criterionSuiteSource) throw new Error("PostgreSQL criterion/suite source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(criterionSuiteSource);
  if (!moduleSymbol) throw new Error("PostgreSQL criterion/suite module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgCriterionSuiteRepository");
  if (!classExport) throw new Error("PgCriterionSuiteRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(CRITERION_SUITE_PATH)) {
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
        node.text === "PgCriterionSuiteRepository" &&
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

describe("PostgreSQL criterion and evaluator-suite repository slice", () => {
  it("owns exactly the CriterionSuiteRepositoryPort methods behind the stable facade", () => {
    const criterionSuiteSource = sourceFile(CRITERION_SUITE_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const criterionSuiteRepository = classDeclaration(
      criterionSuiteSource,
      "PgCriterionSuiteRepository"
    );
    const repository = classDeclaration(repositorySource, "PgRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(criterionSuiteModule)).toEqual(["PgCriterionSuiteRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(criterionSuiteSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(criterionSuiteSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgCriterionSuiteRepository"]);
    expect(criterionSuiteRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(criterionSuiteSource))
    )).toEqual(["CriterionSuiteRepositoryPort"]);
    expect(criterionSuiteRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(criterionSuiteSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(criterionSuiteRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, criterionSuiteSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([["private readonly pool: Pool"]]);

    const expectedDelegates = new Map<string, string>([
      ["listCriteria", "{ return this.criterionSuiteRepository.listCriteria(projectId); }"],
      ["getCriterion", "{ return this.criterionSuiteRepository.getCriterion(projectId, criterionId); }"],
      ["createCriterion", "{ return this.criterionSuiteRepository.createCriterion(projectId, input, context); }"],
      ["createCriterionVersion", "{ return this.criterionSuiteRepository.createCriterionVersion(projectId, criterionId, input, context); }"],
      ["listEvaluatorSuites", "{ return this.criterionSuiteRepository.listEvaluatorSuites(projectId); }"],
      ["getEvaluatorSuite", "{ return this.criterionSuiteRepository.getEvaluatorSuite(projectId, suiteId); }"],
      ["createEvaluatorSuiteManifest", "{ return this.criterionSuiteRepository.createEvaluatorSuiteManifest(projectId, input, context); }"],
      ["listEvaluatorSuiteManifests", "{ return this.criterionSuiteRepository.listEvaluatorSuiteManifests(projectId, suiteId); }"],
      ["getEvaluatorSuiteManifest", "{ return this.criterionSuiteRepository.getEvaluatorSuiteManifest(projectId, manifestId); }"]
    ]);
    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_METHODS.includes(
        method.name.getText(repositorySource) as typeof EXPECTED_METHODS[number]
      ));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_METHODS);
    for (const method of facadeMethods) {
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource).replace(/\s+/g, " ").trim())
        .toBe(expectedDelegates.get(method.name.getText(repositorySource)));
    }
  });

  it("constructs one stateless slice with the facade's exact pool", () => {
    const analysis = criterionSuiteAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgCriterionSuiteRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgCriterionSuiteRepository(pool)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgCriterionSuiteRepository } from "./repository.pg/criterion-suite-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/criterion-suite-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgCriterionSuiteRepository",
      "repository.pg.ts:NewExpression:PgCriterionSuiteRepository",
      "repository.pg.ts:TypeReference:PgCriterionSuiteRepository",
      "repository.pg/criterion-suite-repository.ts:ClassDeclaration:PgCriterionSuiteRepository"
    ]);

    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "criterionSuiteRepository") as PgCriterionSuiteRepository;
    expect(slice).toBeInstanceOf(PgCriterionSuiteRepository);
    expect(Object.keys(slice)).toEqual(["pool"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);
  }, 30_000);

  it("keeps all read paths project-scoped on the injected pool", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const repository = new PgCriterionSuiteRepository(pool);

    await expect(repository.listCriteria("project-1")).resolves.toEqual([]);
    await expect(repository.getCriterion("project-1", "criterion-1")).resolves.toBeNull();
    await expect(repository.listEvaluatorSuites("project-1")).resolves.toEqual([]);
    await expect(repository.getEvaluatorSuite("project-1", "suite-1")).resolves.toBeNull();
    await expect(repository.listEvaluatorSuiteManifests("project-1")).resolves.toEqual([]);
    await expect(repository.listEvaluatorSuiteManifests("project-1", "suite-1")).resolves.toEqual([]);
    await expect(repository.getEvaluatorSuiteManifest("project-1", "manifest-1")).resolves.toBeNull();

    expect(calls).toEqual([
      {
        sql: "select * from criteria where project_id = $1 order by created_at asc, id asc",
        values: ["project-1"]
      },
      {
        sql: "select * from criteria where project_id = $1 and id = $2",
        values: ["project-1", "criterion-1"]
      },
      {
        sql: "select * from evaluator_suites where project_id = $1 order by created_at desc, id desc",
        values: ["project-1"]
      },
      {
        sql: "select * from evaluator_suites where project_id = $1 and id = $2",
        values: ["project-1", "suite-1"]
      },
      {
        sql: `select canonical_bytes from evaluator_suite_manifests
       where project_id = $1${" "}
       order by suite_id asc, revision desc, id desc`,
        values: ["project-1"]
      },
      {
        sql: `select canonical_bytes from evaluator_suite_manifests
       where project_id = $1 and suite_id = $2
       order by suite_id asc, revision desc, id desc`,
        values: ["project-1", "suite-1"]
      },
      {
        sql: "select canonical_bytes from evaluator_suite_manifests where project_id = $1 and id = $2",
        values: ["project-1", "manifest-1"]
      }
    ]);
  });
});
