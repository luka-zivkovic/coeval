import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as pgRepositoryModule from "../src/repository.pg.js";
import * as projectModule from "../src/repository.pg/project-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import {
  PgProjectRepository,
  type PgProjectRepositoryDependencies
} from "../src/repository.pg/project-repository.js";

const EXPECTED_METHODS = [
  "listProjects",
  "getProjectSettings",
  "updateProjectSettings",
  "pruneExpiredTraces",
  "deleteProject",
  "getDashboardSummary",
  "getOnboardingEvidenceInventory"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const PROJECT_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/project-repository.ts"
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

function normalized(node: ts.Node, source: ts.SourceFile): string {
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, source)
    .replace(/\s+/g, " ")
    .trim();
}

function projectRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const projectSource = program.getSourceFile(PROJECT_REPOSITORY_PATH);
  if (!projectSource) throw new Error("PostgreSQL project source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(projectSource);
  if (!moduleSymbol) throw new Error("PostgreSQL project module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgProjectRepository");
  if (!classExport) throw new Error("PgProjectRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(PROJECT_REPOSITORY_PATH)) {
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
        node.text === "PgProjectRepository" &&
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

describe("PostgreSQL project repository slice", () => {
  it("owns exactly the ProjectRepositoryPort methods behind direct facade delegates", () => {
    const projectSource = sourceFile(PROJECT_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const projectRepository = classDeclaration(projectSource, "PgProjectRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(projectModule)).toEqual(["PgProjectRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(projectSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${(
        ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
      ) && statement.name ? statement.name.getText(projectSource) : "<anonymous>"}`))
      .toEqual([
        "InterfaceDeclaration:PgProjectRepositoryDependencies",
        "ClassDeclaration:PgProjectRepository"
      ]);
    expect(projectRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(projectSource))
    )).toEqual(["ProjectRepositoryPort"]);
    expect(projectRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(projectSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(projectRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, projectSource))
    )).toEqual([[
      "private readonly pool: Pool",
      "private readonly dependencies: PgProjectRepositoryDependencies"
    ]]);

    const expectedDelegates = new Map<string, string>([
      ["listProjects", "{ return this.projectRepository.listProjects(userId); }"],
      ["getProjectSettings", "{ return this.projectRepository.getProjectSettings(projectId); }"],
      ["updateProjectSettings", "{ return this.projectRepository.updateProjectSettings(projectId, input, context); }"],
      ["pruneExpiredTraces", "{ return this.projectRepository.pruneExpiredTraces(projectId, context); }"],
      ["deleteProject", "{ return this.projectRepository.deleteProject(projectId, input); }"],
      ["getDashboardSummary", "{ return this.projectRepository.getDashboardSummary(projectId, criterionId); }"],
      ["getOnboardingEvidenceInventory", "{ return this.projectRepository.getOnboardingEvidenceInventory(projectId); }"]
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

  it("pins the complete facade composition and one exact project-slice allocation", () => {
    const program = createApiProgram();
    const analysis = projectRepositoryAnalysis(program);
    expect(analysis.compilerExports).toEqual([
      "PgProjectRepository",
      "PgProjectRepositoryDependencies"
    ]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgProjectRepository(pool, { getCurrentSkill: (projectId) => this.getCurrentSkill(projectId), getCurrentSkillForCriterion: (projectId, criterionId) => this.getCurrentSkillForCriterion(projectId, criterionId), listGoldenSet: (projectId, criterionVersionId) => this.listGoldenSet(projectId, criterionVersionId), listExceptionCases: (projectId, criterionVersionId) => this.listExceptionCases(projectId, criterionVersionId) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgProjectRepository } from "./repository.pg/project-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/project-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgProjectRepository",
      "repository.pg.ts:NewExpression:PgProjectRepository",
      "repository.pg.ts:TypeReference:PgProjectRepository",
      "repository.pg/project-repository.ts:ClassDeclaration:PgProjectRepository"
    ]);

    const repositorySource = sourceFile(REPOSITORY_PATH);
    const repository = classDeclaration(repositorySource, "PgRepository");
    const constructor = repository.members.find(ts.isConstructorDeclaration);
    expect(constructor).toBeDefined();
    expect(constructor!.body!.statements.map((statement) => normalized(statement, repositorySource))).toEqual([
      "this.apiKeyRepository = new PgApiKeyRepository(pool);",
      "this.assessmentReceiptRepository = new PgAssessmentReceiptRepository(pool);",
      "this.criterionSuiteRepository = new PgCriterionSuiteRepository(pool);",
      "this.historicalGateEvidenceRepository = new PgHistoricalGateEvidenceRepository(pool);",
      "this.judgeCredentialRepository = new PgJudgeCredentialRepository(pool);",
      "this.projectRepository = new PgProjectRepository(pool, { getCurrentSkill: (projectId) => this.getCurrentSkill(projectId), getCurrentSkillForCriterion: (projectId, criterionId) => this.getCurrentSkillForCriterion(projectId, criterionId), listGoldenSet: (projectId, criterionVersionId) => this.listGoldenSet(projectId, criterionVersionId), listExceptionCases: (projectId, criterionVersionId) => this.listExceptionCases(projectId, criterionVersionId) });",
      "this.reviewQueueRepository = new PgReviewQueueRepository(pool, (projectId) => this.getCurrentSkill(projectId));",
      "this.runComparisonRepository = new PgRunComparisonRepository(pool);",
      "this.traceImportRepository = new PgTraceImportRepository(pool, (projectId, requested) => this.resolveImportSkillVersionId(projectId, requested), (input) => this.authorizeSkillVersionExecution(input));"
    ]);
  }, 30_000);

  it("uses the exact pool and resolves cross-port reads lazily through the facade", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "projectRepository") as PgProjectRepository;
    expect(slice).toBeInstanceOf(PgProjectRepository);
    expect(Object.keys(slice)).toEqual(["pool", "dependencies"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);

    const current = vi.fn(async () => ({ currentVersion: { id: "skillv-1" } }));
    const currentForCriterion = vi.fn(async () => ({ currentVersion: { id: "skillv-2" } }));
    const golden = vi.fn(async () => []);
    const exceptions = vi.fn(async () => []);
    Reflect.set(repository, "getCurrentSkill", current);
    Reflect.set(repository, "getCurrentSkillForCriterion", currentForCriterion);
    Reflect.set(repository, "listGoldenSet", golden);
    Reflect.set(repository, "listExceptionCases", exceptions);

    const dependencies = Reflect.get(slice, "dependencies") as PgProjectRepositoryDependencies;
    await dependencies.getCurrentSkill("project-1");
    await dependencies.getCurrentSkillForCriterion("project-1", "criterion-1");
    await dependencies.listGoldenSet("project-1", "criterionv-1");
    await dependencies.listExceptionCases("project-1", "criterionv-1");
    expect(current).toHaveBeenCalledWith("project-1");
    expect(currentForCriterion).toHaveBeenCalledWith("project-1", "criterion-1");
    expect(golden).toHaveBeenCalledWith("project-1", "criterionv-1");
    expect(exceptions).toHaveBeenCalledWith("project-1", "criterionv-1");
  });

  it("keeps project-scoped read models and governed exclusions on the injected pool", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("select id, name, mode, trace_retention_days")) {
          return {
            rows: [{ id: "project-1", name: "Project", mode: "human", trace_retention_days: 30 }],
            rowCount: 1
          };
        }
        if (sql.includes("count(*)::int as run_count")) {
          return {
            rows: [{ run_count: 5, input_count: 4, output_count: 3, steps_count: 2, metadata_count: 1 }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const dependencies = {
      getCurrentSkill: vi.fn(),
      getCurrentSkillForCriterion: vi.fn(),
      listGoldenSet: vi.fn(),
      listExceptionCases: vi.fn()
    } as unknown as PgProjectRepositoryDependencies;
    const repository = new PgProjectRepository(pool, dependencies);

    await expect(repository.listProjects("user-1")).resolves.toEqual([]);
    await expect(repository.listProjects()).resolves.toEqual([]);
    await expect(repository.getProjectSettings("project-1")).resolves.toMatchObject({
      projectId: "project-1",
      traceRetentionDays: 30
    });
    await expect(repository.getOnboardingEvidenceInventory("project-1")).resolves.toEqual({
      runCount: 5,
      inputCount: 4,
      outputCount: 3,
      stepsCount: 2,
      metadataCount: 1
    });

    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({
      sql: `select p.*
           from projects p
           join project_members pm on pm.project_id = p.id
           where pm.user_id = $1
           order by p.created_at asc`,
      values: ["user-1"]
    });
    expect(calls[1]).toEqual({
      sql: "select * from projects order by created_at asc",
      values: undefined
    });
    expect(calls[2]).toEqual({
      sql: "select id, name, mode, trace_retention_days from projects where id = $1",
      values: ["project-1"]
    });
    expect(calls[3]?.sql).toContain("c.case_type not in ('gate_candidate', 'release_evidence')");
    expect(calls[3]?.values).toEqual(["project-1"]);
  });

  it("keeps dashboard dependencies and latest-verdict queries criterion-scoped", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql === "select * from projects where id = $1") {
          return {
            rows: [{
              id: "project-1",
              name: "Project",
              mode: "human",
              trace_retention_days: null,
              imported_trace_count: 0,
              auto_judged_trace_count: 0,
              sync_back_coverage: 0,
              last_retention_pruned_at: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
              updated_at: new Date("2026-01-01T00:00:00.000Z")
            }],
            rowCount: 1
          };
        }
        if (sql.includes("select verdict, count(*)::int as count")) {
          return { rows: [{ verdict: "pass", count: 2 }], rowCount: 1 };
        }
        return { rows: [{ count: 2 }], rowCount: 1 };
      }
    } as unknown as Pool;
    const skill = {
      currentVersion: {
        id: "skillv-1",
        criterionVersionId: "criterionv-1"
      }
    };
    const dependencies = {
      getCurrentSkill: vi.fn(async () => skill),
      getCurrentSkillForCriterion: vi.fn(async () => skill),
      listGoldenSet: vi.fn(async () => [{ id: "golden-1" }]),
      listExceptionCases: vi.fn(async () => [])
    } as unknown as PgProjectRepositoryDependencies;
    const repository = new PgProjectRepository(pool, dependencies);

    await expect(repository.getDashboardSummary("project-1", "criterion-1")).resolves.toMatchObject({
      skill,
      currentVersionResultCount: 2,
      verdictDistribution: { pass: 2, fail: 0, ambiguous: 0 },
      exceptions: [],
      topCapabilityGaps: [],
      goldenSetSize: 1,
      viewerRole: "owner"
    });
    expect(dependencies.getCurrentSkill).not.toHaveBeenCalled();
    expect(dependencies.getCurrentSkillForCriterion).toHaveBeenCalledWith("project-1", "criterion-1");
    expect(dependencies.listGoldenSet).toHaveBeenCalledWith("project-1", "criterionv-1");
    expect(dependencies.listExceptionCases).toHaveBeenCalledWith("project-1", "criterionv-1");
    expect(calls[1]?.sql).toContain("select distinct on (jr.case_id)");
    expect(calls[1]?.sql).toContain("c.case_type not in ('gate_candidate', 'release_evidence')");
    expect(calls[1]?.values).toEqual(["project-1", "criterionv-1"]);
    expect(calls[2]?.sql).toContain("count(distinct jr.case_id)");
    expect(calls[2]?.values).toEqual(["project-1", "skillv-1"]);
  });
});
