import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as caseModule from "../src/repository.pg/case-evidence-repository.js";
import * as goldenModule from "../src/repository.pg/golden-evidence-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgCaseEvidenceRepository } from "../src/repository.pg/case-evidence-repository.js";
import { PgGoldenEvidenceRepository } from "../src/repository.pg/golden-evidence-repository.js";
import { AmbiguousProjectSkillError } from "../src/repository/errors.js";

const GOLDEN_PORT_METHODS = [
  "listGoldenSet",
  "getSkillFormatExamples",
  "getGoldenSetHealth",
  "getExceptionDetail",
  "getCaseDetail",
  "promoteExceptionToGoldenSet",
  "retireGoldenSetEntry",
  "getGoldenSetTraces"
] as const;

const GOLDEN_CLASS_METHODS = [
  ...GOLDEN_PORT_METHODS.slice(0, 5),
  "loadCaseDetail",
  ...GOLDEN_PORT_METHODS.slice(5, 7),
  "getGoldenSetTraces",
  "loadGoldenSetTraces"
] as const;

const CASE_PORT_METHODS = [
  "listCaseIdsForProject",
  "listCases",
  "recordVerdict",
  "listVerdicts",
  "caseExistsForProject",
  "getProjectKappaSummary",
  "getProjectJudgeHumanCalibration",
  "getDisagreementSummary",
  "getJudgeHumanDisagreementSummary",
  "getConvergenceAudit",
  "getSelfConsistencyReport",
  "listAuditEntries"
] as const;

const CASE_CLASS_METHODS = [
  ...CASE_PORT_METHODS.slice(0, 9),
  "attachActorNames",
  ...CASE_PORT_METHODS.slice(9),
  "listExceptionCases"
] as const;

const CASE_FACADE_METHODS = [
  "recordVerdict",
  "listVerdicts",
  "caseExistsForProject",
  "listCases",
  "listCaseIdsForProject",
  ...CASE_PORT_METHODS.slice(5)
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(SOURCE_DIRECTORY, "repository.pg.ts");
const GOLDEN_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/golden-evidence-repository.ts");
const CASE_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/case-evidence-repository.ts");

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

function methodNames(declaration: ts.ClassDeclaration, source: ts.SourceFile): string[] {
  return declaration.members.filter(ts.isMethodDeclaration).map((method) => method.name.getText(source));
}

function statementInventory(source: ts.SourceFile): string[] {
  return source.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => {
      const name = (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement))
        ? statement.name?.text
        : undefined;
      return `${ts.SyntaxKind[statement.kind]}:${name ?? "<anonymous>"}`;
    });
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

function expectExactPortHeritage(
  program: ts.Program,
  modulePath: string,
  className: string,
  portName: string
): void {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(modulePath);
  const ports = program.getSourceFile(path.join(SOURCE_DIRECTORY, "repository/ports.ts"));
  if (!source || !ports) throw new Error("Repository slice or port source was not loaded");
  const declaration = source.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  const portModule = checker.getSymbolAtLocation(ports);
  const expectedPort = portModule && checker.getExportsOfModule(portModule)
    .find((symbol) => symbol.name === portName);
  const heritage = declaration?.heritageClauses?.flatMap((clause) => clause.types)[0];
  if (!heritage || !expectedPort) throw new Error(`${className} heritage was not resolved`);
  expect(resolvedSymbol(checker, heritage.expression)).toBe(expectedPort);
}

describe("PostgreSQL golden and case evidence repository slices", () => {
  it("owns both complete ports and internal helpers behind direct facade delegates", () => {
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const repository = classDeclaration(repositorySource, "PgRepository");
    const goldenSource = sourceFile(GOLDEN_PATH);
    const golden = classDeclaration(goldenSource, "PgGoldenEvidenceRepository");
    const caseSource = sourceFile(CASE_PATH);
    const cases = classDeclaration(caseSource, "PgCaseEvidenceRepository");
    const goldenDependencies = interfaceDeclaration(
      goldenSource,
      "PgGoldenEvidenceRepositoryDependencies"
    );
    const caseDependencies = interfaceDeclaration(
      caseSource,
      "PgCaseEvidenceRepositoryDependencies"
    );

    expect(Object.keys(goldenModule)).toEqual(["PgGoldenEvidenceRepository"]);
    expect(Object.keys(caseModule)).toEqual(["PgCaseEvidenceRepository"]);
    expect(statementInventory(goldenSource)).toEqual([
      "InterfaceDeclaration:PgGoldenEvidenceRepositoryDependencies",
      "ClassDeclaration:PgGoldenEvidenceRepository"
    ]);
    expect(statementInventory(caseSource)).toEqual([
      "InterfaceDeclaration:PgCaseEvidenceRepositoryDependencies",
      "ClassDeclaration:PgCaseEvidenceRepository"
    ]);
    expect(golden.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(goldenSource))
    )).toEqual(["GoldenEvidenceRepositoryPort"]);
    expect(cases.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(caseSource))
    )).toEqual(["CaseEvidenceRepositoryPort"]);
    expect(memberInventory(golden, goldenSource)).toEqual([
      "Constructor",
      ...GOLDEN_CLASS_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(memberInventory(cases, caseSource)).toEqual([
      "Constructor",
      ...CASE_CLASS_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(goldenDependencies.members.map((member) => member.name?.getText(goldenSource))).toEqual([
      "assertSingletonCriterion",
      "resolveGoldenCriterionVersion"
    ]);
    expect(caseDependencies.members.map((member) => member.name?.getText(caseSource))).toEqual([
      "assertSingletonCriterion",
      "getCurrentSkill",
      "resolveGoldenCriterionVersion"
    ]);
    expect(golden.members.filter(ts.isMethodDeclaration).filter((method) =>
      ts.getModifiers(method)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    ).map((method) => method.name.getText(goldenSource))).toEqual([
      "loadCaseDetail",
      "loadGoldenSetTraces"
    ]);
    expect(cases.members.filter(ts.isMethodDeclaration).filter((method) =>
      ts.getModifiers(method)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    ).map((method) => method.name.getText(caseSource))).toEqual(["attachActorNames"]);
    expect(golden.members.filter(ts.isConstructorDeclaration)[0]!.parameters.map((parameter) =>
      normalized(parameter, goldenSource)
    )).toEqual([
      "private readonly pool: Pool",
      "private readonly dependencies: PgGoldenEvidenceRepositoryDependencies"
    ]);
    expect(cases.members.filter(ts.isConstructorDeclaration)[0]!.parameters.map((parameter) =>
      normalized(parameter, caseSource)
    )).toEqual([
      "private readonly pool: Pool",
      "private readonly dependencies: PgCaseEvidenceRepositoryDependencies"
    ]);

    for (const [field, names, facadeNames] of [
      ["goldenEvidenceRepository", GOLDEN_PORT_METHODS, GOLDEN_PORT_METHODS],
      ["caseEvidenceRepository", CASE_PORT_METHODS, CASE_FACADE_METHODS]
    ] as const) {
      const methods = repository.members.filter(ts.isMethodDeclaration).filter((method) =>
        (names as readonly string[]).includes(method.name.getText(repositorySource))
      );
      expect(methods.map((method) => method.name.getText(repositorySource))).toEqual(facadeNames);
      for (const method of methods) {
        const name = method.name.getText(repositorySource);
        const parameters = method.parameters.map((parameter) => parameter.name.getText(repositorySource));
        expect(normalized(method.body!, repositorySource))
          .toBe(`{ return this.${field}.${name}(${parameters.join(", ")}); }`);
      }
    }
    const listExceptions = repository.members.find((member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText(repositorySource) === "listExceptionCases"
    );
    expect(listExceptions).toBeDefined();
    expect(normalized(listExceptions!.body!, repositorySource))
      .toBe("{ return this.caseEvidenceRepository.listExceptionCases(projectId, criterionVersionId); }");
  });

  it("allocates each slice once through its canonical module edge", () => {
    const program = createApiProgram();
    const golden = repositorySliceAnalysis(program, GOLDEN_PATH, "PgGoldenEvidenceRepository");
    const cases = repositorySliceAnalysis(program, CASE_PATH, "PgCaseEvidenceRepository");
    expectExactPortHeritage(
      program,
      GOLDEN_PATH,
      "PgGoldenEvidenceRepository",
      "GoldenEvidenceRepositoryPort"
    );
    expectExactPortHeritage(
      program,
      CASE_PATH,
      "PgCaseEvidenceRepository",
      "CaseEvidenceRepositoryPort"
    );

    expect(golden).toEqual({
      allocations: [
        "repository.pg.ts:PgRepository.constructor:new PgGoldenEvidenceRepository(pool, { assertSingletonCriterion: (projectId) => this.assertSingletonCriterion(projectId), resolveGoldenCriterionVersion: (projectId, requested) => this.resolveGoldenCriterionVersion(projectId, requested) })"
      ],
      compilerExports: ["PgGoldenEvidenceRepository", "PgGoldenEvidenceRepositoryDependencies"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgGoldenEvidenceRepository } from "./repository.pg/golden-evidence-repository.js";'
      ],
      moduleSpecifierMentions: [
        'repository.pg.ts:ImportDeclaration:"./repository.pg/golden-evidence-repository.js"'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgGoldenEvidenceRepository",
        "repository.pg.ts:NewExpression:PgGoldenEvidenceRepository",
        "repository.pg.ts:TypeReference:PgGoldenEvidenceRepository",
        "repository.pg/golden-evidence-repository.ts:ClassDeclaration:PgGoldenEvidenceRepository"
      ]
    });
    expect(cases).toEqual({
      allocations: [
        "repository.pg.ts:PgRepository.constructor:new PgCaseEvidenceRepository(pool, { assertSingletonCriterion: (projectId) => this.assertSingletonCriterion(projectId), getCurrentSkill: (projectId) => this.getCurrentSkill(projectId), resolveGoldenCriterionVersion: (projectId, requested) => this.resolveGoldenCriterionVersion(projectId, requested) })"
      ],
      compilerExports: ["PgCaseEvidenceRepository", "PgCaseEvidenceRepositoryDependencies"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgCaseEvidenceRepository } from "./repository.pg/case-evidence-repository.js";'
      ],
      moduleSpecifierMentions: [
        'repository.pg.ts:ImportDeclaration:"./repository.pg/case-evidence-repository.js"'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgCaseEvidenceRepository",
        "repository.pg.ts:NewExpression:PgCaseEvidenceRepository",
        "repository.pg.ts:TypeReference:PgCaseEvidenceRepository",
        "repository.pg/case-evidence-repository.ts:ClassDeclaration:PgCaseEvidenceRepository"
      ]
    });
  }, 30_000);

  it("uses one exact pool and resolves cross-port dependencies lazily through the facade", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const golden = Reflect.get(repository, "goldenEvidenceRepository") as PgGoldenEvidenceRepository;
    const cases = Reflect.get(repository, "caseEvidenceRepository") as PgCaseEvidenceRepository;
    expect(Object.keys(golden)).toEqual(["pool", "dependencies"]);
    expect(Object.keys(cases)).toEqual(["pool", "dependencies"]);
    expect(Reflect.get(golden, "pool")).toBe(pool);
    expect(Reflect.get(cases, "pool")).toBe(pool);

    const assertSingleton = vi.fn(async () => undefined);
    const getCurrentSkill = vi.fn(async () => ({ currentVersion: { id: "skillv-1" } }));
    const resolveGolden = vi.fn(async () => "criterionv-1");
    Reflect.set(repository, "assertSingletonCriterion", assertSingleton);
    Reflect.set(repository, "getCurrentSkill", getCurrentSkill);
    Reflect.set(repository, "resolveGoldenCriterionVersion", resolveGolden);
    const goldenDependencies = Reflect.get(golden, "dependencies");
    const caseDependencies = Reflect.get(cases, "dependencies");
    await goldenDependencies.assertSingletonCriterion("project-1");
    await goldenDependencies.resolveGoldenCriterionVersion("project-1", "criterionv-requested");
    await caseDependencies.assertSingletonCriterion("project-1");
    await caseDependencies.getCurrentSkill("project-1");
    await caseDependencies.resolveGoldenCriterionVersion("project-1");
    expect(assertSingleton).toHaveBeenCalledTimes(2);
    expect(getCurrentSkill).toHaveBeenCalledWith("project-1");
    expect(resolveGolden).toHaveBeenNthCalledWith(1, "project-1", "criterionv-requested");
    expect(resolveGolden).toHaveBeenNthCalledWith(2, "project-1", undefined);
  });

  it("preserves project-scoped golden and case read ordering", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        return { rows: [], rowCount: 0 };
      })
    } as unknown as Pool;
    const golden = new PgGoldenEvidenceRepository(pool, {
      assertSingletonCriterion: vi.fn(async () => undefined),
      resolveGoldenCriterionVersion: vi.fn(async () => "criterionv-1")
    });
    const cases = new PgCaseEvidenceRepository(pool, {
      assertSingletonCriterion: vi.fn(async () => undefined),
      getCurrentSkill: vi.fn(async () => ({ currentVersion: { id: "skillv-1" } } as never)),
      resolveGoldenCriterionVersion: vi.fn(async () => "criterionv-1")
    });

    await expect(golden.listGoldenSet("project-1")).resolves.toEqual([]);
    await expect(cases.listCases("project-1", { since: "2026-09-01T00:00:00.000Z", limit: 25 }))
      .resolves.toEqual([]);
    await expect(cases.listCaseIdsForProject("project-1", 30)).resolves.toEqual([]);
    expect(calls[0]?.values).toEqual(["project-1", "criterionv-1"]);
    expect(calls[0]?.sql).toContain("order by promoted_at desc");
    expect(calls[1]?.values).toEqual(["project-1", "2026-09-01T00:00:00.000Z", 25]);
    expect(calls[1]?.sql).toContain("order by c.created_at desc, c.id");
    expect(calls[2]?.values).toEqual(["project-1", 30]);
    expect(calls[2]?.sql).toContain("case_type not in ('gate_candidate', 'release_evidence')");
  });

  it("fails closed on ambiguous human-verdict binding before current-skill fallback or insert", async () => {
    const getCurrentSkill = vi.fn(async () => ({ currentVersion: { id: "skillv-1" } } as never));
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("count(*)::int as count") ? [{ count: 2 }] : [],
      rowCount: 0
    }));
    const repository = new PgCaseEvidenceRepository({ query } as unknown as Pool, {
      assertSingletonCriterion: vi.fn(async () => undefined),
      getCurrentSkill,
      resolveGoldenCriterionVersion: vi.fn(async () => "criterionv-1")
    });

    await expect(repository.recordVerdict({
      projectId: "project-1",
      caseId: "case-1",
      source: "human",
      actorUserId: "user-1",
      payload: { kind: "binary", pass: true, rationale: "Reviewed." }
    })).rejects.toBeInstanceOf(AmbiguousProjectSkillError);
    expect(getCurrentSkill).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into verdicts"))).toBe(false);
  });
});
