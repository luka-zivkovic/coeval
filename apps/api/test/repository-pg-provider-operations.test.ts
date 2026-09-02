import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as integrationModule from "../src/repository.pg/integration-repository.js";
import * as judgeFeedbackModule from "../src/repository.pg/judge-feedback-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgIntegrationRepository } from "../src/repository.pg/integration-repository.js";
import { PgJudgeFeedbackRepository } from "../src/repository.pg/judge-feedback-repository.js";
import {
  IronsideIntegrationNotFoundError,
  NoCurrentSkillError
} from "../src/repository/errors.js";

const INTEGRATION_METHODS = [
  "createLangSmithIntegration",
  "listLangSmithIntegrations",
  "updateLangSmithIntegration",
  "recordLangSmithConnectionTest",
  "deleteLangSmithIntegration",
  "claimDueLangSmithImportTargets",
  "loadLangSmithImportContext",
  "createLangfuseIntegration",
  "listLangfuseIntegrations",
  "updateLangfuseIntegration",
  "recordLangfuseConnectionTest",
  "deleteLangfuseIntegration",
  "claimDueLangfuseImportTargets",
  "loadLangfuseImportContext",
  "createIronsideIntegration",
  "listIronsideIntegrations",
  "updateIronsideIntegration",
  "recordIronsideConnectionTest",
  "quarantineIronsideIntegration",
  "deleteIronsideIntegration",
  "claimDueIronsideImportTargets",
  "loadIronsideImportContext",
  "saveIronsideSyncState"
] as const;

const FEEDBACK_METHODS = [
  "loadJudgeRunContext",
  "recordJudgeRun",
  "createFeedbackSyncJob",
  "loadFeedbackSyncContext",
  "listFeedbackSyncJobs",
  "markFeedbackSyncSucceeded",
  "markFeedbackSyncFailed",
  "markFeedbackSyncBlocked",
  "markFeedbackSyncPending",
  "listBlockedIronsideFeedbackSyncJobs"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(SOURCE_DIRECTORY, "repository.pg.ts");
const INTEGRATION_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/integration-repository.ts");
const FEEDBACK_PATH = path.join(SOURCE_DIRECTORY, "repository.pg/judge-feedback-repository.ts");
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
  const classes = source.statements.filter((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name
  );
  expect(classes).toHaveLength(1);
  return classes[0]!;
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

function methodNames(declaration: ts.ClassDeclaration, source: ts.SourceFile): string[] {
  return declaration.members.filter(ts.isMethodDeclaration).map((method) => method.name.getText(source));
}

function integrationRow(provider: "langsmith" | "langfuse" | "ironside", overrides: Record<string, unknown> = {}) {
  return {
    id: `integration-${provider}`,
    project_id: "project-1",
    provider,
    config: provider === "ironside"
      ? JSON.stringify({
          url: "https://ironside.example",
          remoteProjectId: "remote-1",
          remoteProjectName: "Remote",
          protocolVersion: "ironside/evaluator/v1",
          settlementQuietPeriodSeconds: 60,
          connectionRevision: 1,
          revalidationRequired: false,
          skillVersionId: "skillv-1",
          sync: { cursor: null }
        })
      : JSON.stringify({ projectName: "Remote", skillVersionId: "skillv-1" }),
    poll_enabled: true,
    poll_interval_seconds: 300,
    poll_limit: 25,
    last_tested_at: null,
    last_test_result: null,
    created_at: CREATED_AT,
    ...overrides
  };
}

describe("PostgreSQL provider-operation repository slices", () => {
  it("owns both complete ports behind direct facade delegates", () => {
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const repository = classDeclaration(repositorySource, "PgRepository");
    const integrationSource = sourceFile(INTEGRATION_PATH);
    const integration = classDeclaration(integrationSource, "PgIntegrationRepository");
    const feedbackSource = sourceFile(FEEDBACK_PATH);
    const feedback = classDeclaration(feedbackSource, "PgJudgeFeedbackRepository");

    expect(Object.keys(integrationModule)).toEqual(["PgIntegrationRepository"]);
    expect(Object.keys(judgeFeedbackModule)).toEqual(["PgJudgeFeedbackRepository"]);
    expect(integration.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(integrationSource))
    )).toEqual(["IntegrationRepositoryPort"]);
    expect(feedback.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(feedbackSource))
    )).toEqual(["JudgeFeedbackRepositoryPort"]);
    expect(methodNames(integration, integrationSource)).toEqual([
      "resolveIntegrationSkillVersionId",
      "recordImportSelectionFailure",
      ...INTEGRATION_METHODS
    ]);
    expect(methodNames(feedback, feedbackSource)).toEqual([
      "loadJudgeRunContext",
      "recordJudgeRun",
      ...FEEDBACK_METHODS.slice(2),
      "refreshSyncBackCoverage"
    ]);

    for (const [field, names] of [
      ["integrationRepository", INTEGRATION_METHODS],
      ["judgeFeedbackRepository", FEEDBACK_METHODS]
    ] as const) {
      const methods = repository.members.filter(ts.isMethodDeclaration).filter((method) =>
        (names as readonly string[]).includes(method.name.getText(repositorySource))
      );
      expect(methods.map((method) => method.name.getText(repositorySource))).toEqual(names);
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
    const integration = repositorySliceAnalysis(program, INTEGRATION_PATH, "PgIntegrationRepository");
    const feedback = repositorySliceAnalysis(program, FEEDBACK_PATH, "PgJudgeFeedbackRepository");

    expect(integration).toEqual({
      allocations: [
        "repository.pg.ts:PgRepository.constructor:new PgIntegrationRepository( pool, (projectId, requested, requiredContext) => this.resolveImportSkillVersionId(projectId, requested, requiredContext), (input) => this.authorizeSkillVersionExecution(input) )"
      ],
      compilerExports: ["PgIntegrationRepository"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgIntegrationRepository } from "./repository.pg/integration-repository.js";'
      ],
      moduleSpecifierMentions: [
        'repository.pg.ts:ImportDeclaration:"./repository.pg/integration-repository.js"'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgIntegrationRepository",
        "repository.pg.ts:NewExpression:PgIntegrationRepository",
        "repository.pg.ts:TypeReference:PgIntegrationRepository",
        "repository.pg/integration-repository.ts:ClassDeclaration:PgIntegrationRepository"
      ]
    });
    expect(feedback).toEqual({
      allocations: [
        "repository.pg.ts:PgRepository.constructor:new PgJudgeFeedbackRepository( pool, async (projectId) => (await this.getCurrentSkill(projectId)).currentVersion.id, (input) => this.authorizeSkillVersionExecution(input) )"
      ],
      compilerExports: ["PgJudgeFeedbackRepository"],
      moduleEdges: [
        'repository.pg.ts:ImportDeclaration:import { PgJudgeFeedbackRepository } from "./repository.pg/judge-feedback-repository.js";'
      ],
      moduleSpecifierMentions: [
        'repository.pg.ts:ImportDeclaration:"./repository.pg/judge-feedback-repository.js"'
      ],
      references: [
        "repository.pg.ts:ImportSpecifier:PgJudgeFeedbackRepository",
        "repository.pg.ts:NewExpression:PgJudgeFeedbackRepository",
        "repository.pg.ts:TypeReference:PgJudgeFeedbackRepository",
        "repository.pg/judge-feedback-repository.ts:ClassDeclaration:PgJudgeFeedbackRepository"
      ]
    });
  }, 30_000);

  it("constructs one of each slice with the exact pool and lazy facade callbacks", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const integration = Reflect.get(repository, "integrationRepository") as PgIntegrationRepository;
    const feedback = Reflect.get(repository, "judgeFeedbackRepository") as PgJudgeFeedbackRepository;

    expect(integration).toBeInstanceOf(PgIntegrationRepository);
    expect(feedback).toBeInstanceOf(PgJudgeFeedbackRepository);
    expect(Object.keys(integration)).toEqual([
      "pool",
      "resolveImportSkillVersionId",
      "authorizeSkillVersionExecution"
    ]);
    expect(Object.keys(feedback)).toEqual([
      "pool",
      "getCurrentSkillVersionId",
      "authorizeSkillVersionExecution"
    ]);
    expect(Reflect.get(integration, "pool")).toBe(pool);
    expect(Reflect.get(feedback, "pool")).toBe(pool);

    const resolver = vi.fn(async () => "skillv-lazy");
    const current = vi.fn(async () => ({ currentVersion: { id: "skillv-current" } }));
    const authorize = vi.fn(async () => undefined);
    Reflect.set(repository, "resolveImportSkillVersionId", resolver);
    Reflect.set(repository, "getCurrentSkill", current);
    Reflect.set(repository, "authorizeSkillVersionExecution", authorize);
    await expect(Reflect.get(integration, "resolveImportSkillVersionId")(
      "project-1",
      "skillv-requested",
      "scheduled_import"
    )).resolves.toBe("skillv-lazy");
    await expect(Reflect.get(feedback, "getCurrentSkillVersionId")("project-1"))
      .resolves.toBe("skillv-current");
    const authorization = {
      projectId: "project-1",
      skillVersionId: "skillv-lazy",
      context: "scheduled_import" as const,
      resourceKind: "langsmith_import",
      resourceId: "import-1",
      idempotencyKey: "provider-start:langsmith:import-1:skillv-lazy"
    };
    await Reflect.get(feedback, "authorizeSkillVersionExecution")(authorization);
    expect(resolver).toHaveBeenCalledWith("project-1", "skillv-requested", "scheduled_import");
    expect(current).toHaveBeenCalledWith("project-1");
    expect(authorize).toHaveBeenCalledWith(authorization);
  });

  it("claims provider targets with exact-version selection and records fail-closed selection evidence", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        if (sql.includes("with due as")) {
          return {
            rows: [
              { id: "integration-ok", project_id: "project-1", poll_limit: 250, config: JSON.stringify({ skillVersionId: "skillv-ok" }) },
              { id: "integration-missing", project_id: "project-2", poll_limit: 0, config: JSON.stringify({}) }
            ],
            rowCount: 2
          };
        }
        if (sql.includes("insert into import_jobs")) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as Pool;
    const resolve = vi.fn(async (projectId: string) => {
      if (projectId === "project-2") throw new NoCurrentSkillError("project-2");
      return "skillv-ok";
    });
    const repository = new PgIntegrationRepository(pool, resolve, vi.fn());
    const now = new Date("2026-09-02T01:00:00.000Z");

    await expect(repository.claimDueLangSmithImportTargets({
      now,
      batchSize: 10,
      defaultLimit: 25,
      intervalMs: 300_000
    })).resolves.toEqual([{
      projectId: "project-1",
      integrationId: "integration-ok",
      skillVersionId: "skillv-ok",
      limit: 100
    }]);
    expect(resolve).toHaveBeenNthCalledWith(1, "project-1", "skillv-ok", "scheduled_import");
    expect(resolve).toHaveBeenNthCalledWith(2, "project-2", undefined, "scheduled_import");
    expect(calls[0]?.values).toEqual([now.toISOString(), 10]);
    expect(calls[1]?.sql).toContain("insert into import_jobs");
    expect(calls[1]?.values.slice(1)).toEqual([
      "project-2",
      "langsmith",
      "integration-missing",
      1,
      now.toISOString(),
      "skill_version_required: configure an exact evaluator version before scheduled import"
    ]);

    const unexpected = new Error("resolver unavailable");
    resolve.mockRejectedValueOnce(unexpected);
    await expect(repository.claimDueLangSmithImportTargets({
      now,
      batchSize: 10,
      defaultLimit: 25,
      intervalMs: 300_000
    })).rejects.toBe(unexpected);
  });

  it("preserves provider-specific project scoping, ordering, and opaque cursor compare-and-set", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        if (sql.includes("from integrations") && sql.includes("provider = 'langsmith'")) {
          return { rows: [integrationRow("langsmith")], rowCount: 1 };
        }
        return { rows: [], rowCount: values[0] === "missing" || values[4] === "wrong" ? 0 : 1 };
      })
    } as unknown as Pool;
    const repository = new PgIntegrationRepository(pool, vi.fn(), vi.fn());

    await expect(repository.listLangSmithIntegrations("project-1"))
      .resolves.toMatchObject([{ projectId: "project-1", provider: "langsmith", skillVersionId: "skillv-1" }]);
    expect(calls[0]?.sql).toContain("where project_id = $1 and provider = 'langsmith'");
    expect(calls[0]?.sql).toContain("order by created_at desc");
    expect(calls[0]?.values).toEqual(["project-1"]);

    await expect(repository.saveIronsideSyncState(
      "project-1",
      "integration-ironside",
      { cursor: "next" },
      "previous"
    )).resolves.toBe(true);
    expect(calls[1]?.values).toEqual([
      "integration-ironside",
      "project-1",
      JSON.stringify({ cursor: "next" }),
      true,
      "previous"
    ]);
    expect(calls[1]?.sql).toContain("provider = 'ironside'");
    expect(calls[1]?.sql).toContain("config #>> '{sync,cursor}' is not distinct from $5::text");

    await expect(repository.saveIronsideSyncState(
      "project-1",
      "integration-ironside",
      { cursor: "next" },
      "wrong"
    )).resolves.toBe(false);
    expect(calls[2]?.values).toEqual([
      "integration-ironside",
      "project-1",
      JSON.stringify({ cursor: "next" }),
      true,
      "wrong"
    ]);

    await expect(repository.saveIronsideSyncState(
      "project-1",
      "missing",
      { cursor: null }
    )).rejects.toBeInstanceOf(IronsideIntegrationNotFoundError);
    expect(calls[3]?.values).toEqual([
      "missing",
      "project-1",
      JSON.stringify({ cursor: null }),
      false,
      null
    ]);
  });

  it("keeps judge-run idempotency and sync-back coverage updates project-scoped and ordered", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const judgeRow = {
      id: "judge-1",
      project_id: "project-1",
      case_id: "case-1",
      skill_version_id: "skillv-1",
      verdict: "pass",
      score: 1,
      reasoning: "ok",
      provider_metadata: JSON.stringify({ model: "model-1" }),
      created_at: CREATED_AT
    };
    let existing = true;
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        if (sql.startsWith("select * from judge_runs")) {
          return { rows: existing ? [judgeRow] : [], rowCount: existing ? 1 : 0 };
        }
        if (sql.includes("insert into judge_runs")) return { rows: [judgeRow], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      })
    } as unknown as Pool;
    const repository = new PgJudgeFeedbackRepository(pool, vi.fn(), vi.fn());
    const input = {
      projectId: "project-1",
      caseId: "case-1",
      skillVersionId: "skillv-1",
      verdict: { label: "pass" as const, score: 1, reason: "ok", confidence: 1 }
    };

    await expect(repository.recordJudgeRun(input)).resolves.toMatchObject({ id: "judge-1" });
    expect(calls).toHaveLength(1);
    existing = false;
    calls.length = 0;
    await expect(repository.recordJudgeRun(input)).resolves.toMatchObject({ id: "judge-1" });
    expect(calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("select * from judge_runs"),
      expect.stringContaining("insert into judge_runs"),
      expect.stringContaining("update projects")
    ]);
    expect(calls[2]?.values).toEqual(["project-1", "case-1", "judge-1"]);

    calls.length = 0;
    await repository.markFeedbackSyncFailed(
      { projectId: "project-1", feedbackSyncJobId: "feedback-1" },
      new Error("upstream failed")
    );
    expect(calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("update feedback_sync_jobs set status = 'failed'"),
      expect.stringContaining("set sync_back_coverage = coalesce")
    ]);
    expect(calls[0]?.values).toEqual(["feedback-1", "project-1", "upstream failed"]);
    expect(calls[1]?.values).toEqual(["project-1"]);
    expect(calls[1]?.sql).toContain("fsj.provider in ('langsmith', 'langfuse', 'ironside')");
  });
});
