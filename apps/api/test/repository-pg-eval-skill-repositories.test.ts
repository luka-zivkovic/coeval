import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as evalRunModule from "../src/repository.pg/eval-run-repository.js";
import * as skillLifecycleModule from "../src/repository.pg/skill-lifecycle-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgEvalRunRepository } from "../src/repository.pg/eval-run-repository.js";
import {
  PgSkillLifecycleRepository,
  type PgSkillLifecycleRepositoryDependencies
} from "../src/repository.pg/skill-lifecycle-repository.js";

const EVAL_RUN_PORT_METHODS = [
  "createEvalRun",
  "createConvergenceEvalRun",
  "createImportedCaseEvalRun",
  "claimEvalRunDispatch",
  "rotateEvalRunDispatchJob",
  "markEvalRunDispatched",
  "releaseEvalRunDispatch",
  "armEvalRunItemDeliveryDeadline",
  "markEvalRunRunning",
  "listPendingEvalRunItems",
  "listPendingEvalRunItemDispatches",
  "claimEvalRunItemExecution",
  "rearmEvalRunItemDeliveryDeadline",
  "claimEvalRunItemRecovery",
  "beginEvalRunItemProviderCall",
  "markEvalRunItemProviderCallReturned",
  "releaseEvalRunItemExecution",
  "listStaleEvalRunItemExecutions",
  "getEvalRunItem",
  "completeEvalRunItem",
  "failEvalRunItem",
  "getEvalRun",
  "getEvalRunDetail",
  "listEvalRuns",
  "deleteUndispatchedEvalRun"
] as const;

const EVAL_RUN_CLASS_METHODS = [
  ...EVAL_RUN_PORT_METHODS.slice(0, 3),
  "createEvalRunOnce",
  ...EVAL_RUN_PORT_METHODS.slice(3)
] as const;

const EVAL_RUN_FACADE_METHODS = [
  ...EVAL_RUN_PORT_METHODS.slice(0, 12),
  "claimEvalRunItemRecovery",
  "rearmEvalRunItemDeliveryDeadline",
  ...EVAL_RUN_PORT_METHODS.slice(14)
] as const;

const SKILL_LIFECYCLE_PORT_METHODS = [
  "getCurrentSkill",
  "getCurrentSkillForCriterion",
  "getLatestSkillForCriterion",
  "getLatestSkill",
  "getSkillVersion",
  "authorizeSkillVersionExecution",
  "getCriterionVersionForSkillVersion",
  "signOffSkillVersion",
  "createSkillVersion",
  "createSkillVersionPending",
  "runRegressionGateForVersion",
  "failRegressionGateForVersion",
  "listSkillVersions",
  "listRegressionRunsForVersions",
  "getRegressionRunForVersion"
] as const;

const SKILL_LIFECYCLE_CLASS_METHODS = [
  ...SKILL_LIFECYCLE_PORT_METHODS.slice(0, 5),
  "getCriterionVersionForSkillVersion",
  "loadSkillByVersionOrder",
  "authorizeSkillVersionExecution",
  ...SKILL_LIFECYCLE_PORT_METHODS.slice(7, 11),
  "runRegressionGateForVersionLocked",
  "failRegressionGateForVersion",
  ...SKILL_LIFECYCLE_PORT_METHODS.slice(12),
  "latestVersionId"
] as const;

const SKILL_LIFECYCLE_FACADE_METHODS = [
  "getCurrentSkill",
  "getLatestSkill",
  "getCurrentSkillForCriterion",
  "getLatestSkillForCriterion",
  "getSkillVersion",
  "getCriterionVersionForSkillVersion",
  "authorizeSkillVersionExecution",
  "listSkillVersions",
  "signOffSkillVersion",
  "getRegressionRunForVersion",
  "listRegressionRunsForVersions",
  "createSkillVersion",
  "createSkillVersionPending",
  "runRegressionGateForVersion",
  "failRegressionGateForVersion"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(SOURCE_DIRECTORY, "repository.pg.ts");
const PORTS_PATH = path.join(SOURCE_DIRECTORY, "repository/ports.ts");
const EVAL_RUN_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/eval-run-repository.ts");
const SKILL_LIFECYCLE_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/skill-lifecycle-repository.ts");

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

function interfaceDeclaration(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const declarations = source.statements.filter((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === name
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

function methodSignature(method: ts.MethodDeclaration, source: ts.SourceFile): string {
  return source.text.slice(method.getStart(source), method.body!.getStart(source))
    .replace(/\s+/g, " ")
    .trim();
}

function memberInventory(declaration: ts.ClassDeclaration, source: ts.SourceFile): string[] {
  return declaration.members.map((member) => {
    if (ts.isConstructorDeclaration(member)) return "Constructor";
    if (ts.isMethodDeclaration(member)) return `MethodDeclaration:${member.name.getText(source)}`;
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
    if (ts.isFunctionLike(current)) return "<anonymous>";
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
        if (
          resolution &&
          path.resolve(resolution.resolvedFileName) === path.resolve(modulePath) &&
          (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent))
        ) {
          moduleEdges.push(
            `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.parent.getText(source)
              .replace(/\s+/g, " ")
              .trim()}`
          );
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
    references: references.sort()
  };
}

function assertPortIdentity(
  program: ts.Program,
  classPath: string,
  className: string,
  portName: string
): void {
  const checker = program.getTypeChecker();
  const classSource = program.getSourceFile(classPath)!;
  const portsSource = program.getSourceFile(PORTS_PATH)!;
  const declaration = classDeclaration(classSource, className);
  const heritageExpression = declaration.heritageClauses?.[0]?.types[0]?.expression;
  expect(heritageExpression?.getText(classSource)).toBe(portName);
  const portsModule = checker.getSymbolAtLocation(portsSource)!;
  const expectedPort = checker.getExportsOfModule(portsModule).find((symbol) => symbol.name === portName);
  expect(expectedPort).toBeDefined();
  expect(resolvedSymbol(checker, heritageExpression!)).toBe(expectedPort);
}

function assertDirectDelegates(
  repository: ts.ClassDeclaration,
  repositorySource: ts.SourceFile,
  slice: ts.ClassDeclaration,
  sliceSource: ts.SourceFile,
  methodNames: readonly string[],
  fieldName: string
): void {
  const methods = repository.members.filter(ts.isMethodDeclaration).filter((method) =>
    methodNames.includes(method.name.getText(repositorySource))
  );
  expect(methods.map((method) => method.name.getText(repositorySource))).toEqual(methodNames);
  for (const method of methods) {
    const name = method.name.getText(repositorySource);
    const sliceMethod = slice.members.find((member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText(sliceSource) === name
    );
    expect(sliceMethod).toBeDefined();
    expect(methodSignature(method, repositorySource)).toBe(methodSignature(sliceMethod!, sliceSource));
    const args = method.parameters.map((parameter) => parameter.name.getText(repositorySource)).join(", ");
    expect(normalized(method.body!, repositorySource)).toBe(
      `{ return this.${fieldName}.${name}(${args}); }`
    );
  }
}

describe("PostgreSQL eval-run and skill-lifecycle repository slices", () => {
  it("pins both complete ports behind exact direct facade delegates", () => {
    const evalSource = sourceFile(EVAL_RUN_PATH);
    const skillSource = sourceFile(SKILL_LIFECYCLE_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const portsSource = sourceFile(PORTS_PATH);
    const evalRepository = classDeclaration(evalSource, "PgEvalRunRepository");
    const skillRepository = classDeclaration(skillSource, "PgSkillLifecycleRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");
    const skillDependencies = interfaceDeclaration(
      skillSource,
      "PgSkillLifecycleRepositoryDependencies"
    );

    expect(Object.keys(evalRunModule)).toEqual(["PgEvalRunRepository"]);
    expect(Object.keys(skillLifecycleModule)).toEqual(["PgSkillLifecycleRepository"]);
    expect(evalSource.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) =>
      `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) ? statement.name?.text : "<anonymous>"}`
    )).toEqual(["ClassDeclaration:PgEvalRunRepository"]);
    expect(skillSource.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => {
      const name = (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement))
        ? statement.name?.text
        : undefined;
      return `${ts.SyntaxKind[statement.kind]}:${name ?? "<anonymous>"}`;
    })).toEqual([
      "InterfaceDeclaration:PgSkillLifecycleRepositoryDependencies",
      "ClassDeclaration:PgSkillLifecycleRepository"
    ]);
    expect(interfaceDeclaration(portsSource, "EvalRunRepositoryPort").members
      .filter(ts.isMethodSignature).map((method) => method.name.getText(portsSource)))
      .toEqual(EVAL_RUN_PORT_METHODS);
    expect(interfaceDeclaration(portsSource, "SkillLifecycleRepositoryPort").members
      .filter(ts.isMethodSignature).map((method) => method.name.getText(portsSource)))
      .toEqual(SKILL_LIFECYCLE_PORT_METHODS);
    expect(skillDependencies.members.map((member) => member.name?.getText(skillSource))).toEqual([
      "assertSingletonCriterion",
      "getDatasetRevisionDetail",
      "getJudgeProviderCredential"
    ]);
    expect(memberInventory(evalRepository, evalSource)).toEqual([
      "Constructor",
      ...EVAL_RUN_CLASS_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(memberInventory(skillRepository, skillSource)).toEqual([
      "Constructor",
      ...SKILL_LIFECYCLE_CLASS_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(evalRepository.members.filter(ts.isMethodDeclaration).filter((method) =>
      ts.getModifiers(method)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    ).map((method) => method.name.getText(evalSource))).toEqual(["createEvalRunOnce"]);
    expect(skillRepository.members.filter(ts.isMethodDeclaration).filter((method) =>
      ts.getModifiers(method)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    ).map((method) => method.name.getText(skillSource))).toEqual([
      "loadSkillByVersionOrder",
      "runRegressionGateForVersionLocked",
      "latestVersionId"
    ]);
    expect(evalRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, evalSource))
    )).toEqual([["private readonly pool: Pool"]]);
    expect(skillRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, skillSource))
    )).toEqual([[
      "private readonly pool: Pool",
      "private readonly judgeProviderFactory: JudgeProviderFactory",
      "private readonly dependencies: PgSkillLifecycleRepositoryDependencies"
    ]]);
    assertDirectDelegates(
      repository,
      repositorySource,
      evalRepository,
      evalSource,
      EVAL_RUN_FACADE_METHODS,
      "evalRunRepository"
    );
    assertDirectDelegates(
      repository,
      repositorySource,
      skillRepository,
      skillSource,
      SKILL_LIFECYCLE_FACADE_METHODS,
      "skillLifecycleRepository"
    );
  });

  it("pins exact port symbols, one allocation, and one canonical module edge per slice", () => {
    const program = createApiProgram();
    assertPortIdentity(program, EVAL_RUN_PATH, "PgEvalRunRepository", "EvalRunRepositoryPort");
    assertPortIdentity(program, SKILL_LIFECYCLE_PATH, "PgSkillLifecycleRepository", "SkillLifecycleRepositoryPort");

    expect(repositorySliceAnalysis(program, EVAL_RUN_PATH, "PgEvalRunRepository")).toEqual({
      allocations: [
        "repository.pg.ts:PgRepository.constructor:new PgEvalRunRepository(pool)"
      ],
      compilerExports: ["PgEvalRunRepository"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgEvalRunRepository } from "./repository.pg/eval-run-repository.js";'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgEvalRunRepository",
        "repository.pg.ts:NewExpression:PgEvalRunRepository",
        "repository.pg.ts:TypeReference:PgEvalRunRepository",
        "repository.pg/eval-run-repository.ts:ClassDeclaration:PgEvalRunRepository"
      ]
    });
    expect(repositorySliceAnalysis(program, SKILL_LIFECYCLE_PATH, "PgSkillLifecycleRepository")).toEqual({
      allocations: [
        "repository.pg.ts:PgRepository.constructor:new PgSkillLifecycleRepository( pool, judgeProviderFactory, { assertSingletonCriterion: (projectId) => this.assertSingletonCriterion(projectId), getDatasetRevisionDetail: (projectId, revisionId) => this.getDatasetRevisionDetail(projectId, revisionId), getJudgeProviderCredential: (projectId, provider) => this.getJudgeProviderCredential(projectId, provider) } )"
      ],
      compilerExports: ["PgSkillLifecycleRepository", "PgSkillLifecycleRepositoryDependencies"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgSkillLifecycleRepository } from "./repository.pg/skill-lifecycle-repository.js";'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgSkillLifecycleRepository",
        "repository.pg.ts:NewExpression:PgSkillLifecycleRepository",
        "repository.pg.ts:TypeReference:PgSkillLifecycleRepository",
        "repository.pg/skill-lifecycle-repository.ts:ClassDeclaration:PgSkillLifecycleRepository"
      ]
    });
  }, 30_000);

  it("uses the exact pool and resolves skill dependencies lazily through the facade", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Pool;
    const factory = vi.fn();
    const repository = new PgRepository(pool, factory as never);
    const evalRun = Reflect.get(repository, "evalRunRepository") as PgEvalRunRepository;
    const skill = Reflect.get(repository, "skillLifecycleRepository") as PgSkillLifecycleRepository;
    expect(evalRun).toBeInstanceOf(PgEvalRunRepository);
    expect(skill).toBeInstanceOf(PgSkillLifecycleRepository);
    expect(Object.keys(evalRun)).toEqual(["pool"]);
    expect(Object.keys(skill)).toEqual(["pool", "judgeProviderFactory", "dependencies"]);
    expect(Reflect.get(evalRun, "pool")).toBe(pool);
    expect(Reflect.get(skill, "pool")).toBe(pool);
    expect(Reflect.get(skill, "judgeProviderFactory")).toBe(factory);

    const singleton = vi.fn(async () => undefined);
    const revision = vi.fn(async () => null);
    const credential = vi.fn(async () => null);
    Reflect.set(repository, "assertSingletonCriterion", singleton);
    Reflect.set(repository, "getDatasetRevisionDetail", revision);
    Reflect.set(repository, "getJudgeProviderCredential", credential);
    const dependencies = Reflect.get(skill, "dependencies") as PgSkillLifecycleRepositoryDependencies;
    await dependencies.assertSingletonCriterion("project-1");
    await dependencies.getDatasetRevisionDetail("project-1", "revision-1");
    await dependencies.getJudgeProviderCredential("project-1", "openai");
    expect(singleton).toHaveBeenCalledWith("project-1");
    expect(revision).toHaveBeenCalledWith("project-1", "revision-1");
    expect(credential).toHaveBeenCalledWith("project-1", "openai");
  });

  it("keeps credential and revision reads before their transaction connections", () => {
    const skillSource = sourceFile(SKILL_LIFECYCLE_PATH);
    const skillRepository = classDeclaration(skillSource, "PgSkillLifecycleRepository");
    const callPositions = (methodName: string): Map<string, number[]> => {
      const method = skillRepository.members.find((member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && member.name.getText(skillSource) === methodName
      );
      if (!method) throw new Error(`${methodName} was not found`);
      const positions = new Map<string, number[]>();
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = node.expression.getText(skillSource);
          positions.set(name, [...(positions.get(name) ?? []), node.getStart(skillSource)]);
        }
        ts.forEachChild(node, visit);
      };
      visit(method);
      return positions;
    };

    const pending = callPositions("createSkillVersionPending");
    expect(pending.get("this.dependencies.getJudgeProviderCredential")).toHaveLength(1);
    expect(pending.get("this.pool.connect")).toHaveLength(1);
    expect(pending.get("this.dependencies.getJudgeProviderCredential")![0])
      .toBeLessThan(pending.get("this.pool.connect")![0]!);

    const regression = callPositions("runRegressionGateForVersionLocked");
    expect(regression.get("this.dependencies.getDatasetRevisionDetail")).toHaveLength(1);
    expect(regression.get("this.dependencies.getJudgeProviderCredential")).toHaveLength(1);
    expect(regression.get("this.pool.connect")).toHaveLength(1);
    const transactionConnect = regression.get("this.pool.connect")![0]!;
    expect(regression.get("this.dependencies.getDatasetRevisionDetail")![0]).toBeLessThan(transactionConnect);
    expect(regression.get("this.dependencies.getJudgeProviderCredential")![0]).toBeLessThan(transactionConnect);
  });

  it("rejects analysis-population revisions before an eval run is inserted", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("select source_kind from dataset_revisions")) {
          return { rows: [{ source_kind: "analysis_population" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgEvalRunRepository(pool);
    await expect(repository.createEvalRun({
      projectId: "project-1",
      datasetRevisionId: "revision-1",
      skillVersionId: "skillv-1",
      trigger: "manual",
      items: []
    })).rejects.toThrow("Analysis population revisions cannot run through the ordinary evaluation path");
    expect(calls).toEqual([
      "begin",
      expect.stringContaining("select source_kind from dataset_revisions"),
      "rollback"
    ]);
    expect(calls.some((sql) => sql.includes("insert into eval_runs"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
