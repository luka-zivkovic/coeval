import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const traceCommandMocks = vi.hoisted(() => ({
  importTraceOnClient: vi.fn()
}));

vi.mock("../src/repository.pg/trace-import-commands.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/repository.pg/trace-import-commands.js")>(),
  importTraceOnClient: traceCommandMocks.importTraceOnClient
}));

import * as pgRepositoryModule from "../src/repository.pg.js";
import * as traceImportModule from "../src/repository.pg/trace-import-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgTraceImportRepository } from "../src/repository.pg/trace-import-repository.js";

const EXPECTED_METHODS = [
  "importTrace",
  "createImportJob",
  "markImportJobQueued",
  "markImportJobRunning",
  "markImportJobCompleted",
  "markImportJobFailed",
  "listImportJobs"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const TRACE_IMPORT_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/trace-import-repository.ts"
);
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

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
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
      return ts.isClassDeclaration(parent) && parent.name
        ? `${parent.name.text}.constructor`
        : "<constructor>";
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

function traceImportRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const traceImportSource = program.getSourceFile(TRACE_IMPORT_REPOSITORY_PATH);
  if (!traceImportSource) throw new Error("PostgreSQL trace-import source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(traceImportSource);
  if (!moduleSymbol) throw new Error("PostgreSQL trace-import module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgTraceImportRepository");
  if (!classExport) throw new Error("PgTraceImportRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(TRACE_IMPORT_REPOSITORY_PATH)) {
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
        node.text === "PgTraceImportRepository" &&
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

function importJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "import-1",
    project_id: "project-1",
    source: "langsmith",
    source_integration_id: "integration-1",
    skill_version_id: "skillv-1",
    actor_user_id: "user-1",
    actor_email: "owner@example.com",
    actor_name: "Owner",
    queue_job_id: null,
    status: "queued",
    requested_limit: 25,
    imported_count: 0,
    queued_judge_count: 0,
    created_at: CREATED_AT,
    started_at: null,
    completed_at: null,
    error: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PostgreSQL trace-import repository slice", () => {
  it("owns exactly TraceImportRepositoryPort behind direct facade delegates", () => {
    const traceImportSource = sourceFile(TRACE_IMPORT_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const traceImportRepository = classDeclaration(traceImportSource, "PgTraceImportRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(traceImportModule)).toEqual(["PgTraceImportRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(traceImportSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(traceImportSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgTraceImportRepository"]);
    expect(traceImportRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(traceImportSource))
    )).toEqual(["TraceImportRepositoryPort"]);
    expect(traceImportRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(traceImportSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`),
      "MethodDeclaration:loadImportJobRecord"
    ]);
    expect(traceImportRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, traceImportSource))
    )).toEqual([[
      "private readonly pool: Pool",
      "private readonly resolveImportSkillVersionId: (projectId: string, requested?: string | undefined) => Promise<string>",
      'private readonly authorizeSkillVersionExecution: SkillLifecycleRepositoryPort["authorizeSkillVersionExecution"]'
    ]]);

    const expectedDelegates = new Map<string, string>([
      ["importTrace", "{ return this.traceImportRepository.importTrace(projectId, source, input, context); }"],
      ["createImportJob", "{ return this.traceImportRepository.createImportJob(input); }"],
      ["markImportJobQueued", "{ return this.traceImportRepository.markImportJobQueued(projectId, importJobId, queueJobId); }"],
      ["markImportJobRunning", "{ return this.traceImportRepository.markImportJobRunning(projectId, importJobId); }"],
      ["markImportJobCompleted", "{ return this.traceImportRepository.markImportJobCompleted(projectId, importJobId, result); }"],
      ["markImportJobFailed", "{ return this.traceImportRepository.markImportJobFailed(projectId, importJobId, error); }"],
      ["listImportJobs", "{ return this.traceImportRepository.listImportJobs(input); }"]
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

  it("constructs one slice with the exact pool and lazy resolver and authorization callbacks", async () => {
    const analysis = traceImportRepositoryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgTraceImportRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgTraceImportRepository( pool, (projectId, requested) => this.resolveImportSkillVersionId(projectId, requested), (input) => this.authorizeSkillVersionExecution(input) )"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgTraceImportRepository } from "./repository.pg/trace-import-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/trace-import-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgTraceImportRepository",
      "repository.pg.ts:NewExpression:PgTraceImportRepository",
      "repository.pg.ts:TypeReference:PgTraceImportRepository",
      "repository.pg/trace-import-repository.ts:ClassDeclaration:PgTraceImportRepository"
    ]);

    const pool = { query: vi.fn() } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "traceImportRepository") as PgTraceImportRepository;
    expect(slice).toBeInstanceOf(PgTraceImportRepository);
    expect(Object.keys(slice)).toEqual([
      "pool",
      "resolveImportSkillVersionId",
      "authorizeSkillVersionExecution"
    ]);
    expect(Reflect.get(slice, "pool")).toBe(pool);

    const resolver = vi.fn(async () => "skillv-lazy");
    const authorizer = vi.fn(async () => undefined);
    Reflect.set(repository, "resolveImportSkillVersionId", resolver);
    Reflect.set(repository, "authorizeSkillVersionExecution", authorizer);
    await expect(Reflect.get(slice, "resolveImportSkillVersionId")("project-lazy", "requested"))
      .resolves.toBe("skillv-lazy");
    const authorization = {
      projectId: "project-lazy",
      skillVersionId: "skillv-lazy",
      context: "manual_import" as const,
      resourceKind: "import_job",
      resourceId: "import-lazy",
      idempotencyKey: "import-job:import-lazy:skillv-lazy"
    };
    await Reflect.get(slice, "authorizeSkillVersionExecution")(authorization);
    expect(resolver).toHaveBeenCalledWith("project-lazy", "requested");
    expect(authorizer).toHaveBeenCalledWith(authorization);
  }, 30_000);

  it("imports a trace in one caller-owned transaction and rolls back before release", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        events.push(normalizedSql(sql));
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(() => events.push("release"))
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const imported = {
      caseId: "case-1",
      traceId: "trace-1",
      created: true
    };
    traceCommandMocks.importTraceOnClient.mockImplementationOnce(async () => {
      events.push("importTraceOnClient");
      return imported;
    });
    const repository = new PgTraceImportRepository(pool, vi.fn(), vi.fn());
    const input = {
      sourceTraceId: "source-1",
      input: { question: "hello" },
      output: { answer: "world" },
      metadata: {}
    };
    const context = { ingestionPurpose: "analysis_eligible_manual" as const };

    await expect(repository.importTrace("project-1", "manual", input, context)).resolves.toBe(imported);
    expect(events).toEqual(["begin", "importTraceOnClient", "commit", "release"]);
    expect(traceCommandMocks.importTraceOnClient).toHaveBeenCalledWith(
      client,
      "project-1",
      "manual",
      input,
      context
    );

    events.length = 0;
    traceCommandMocks.importTraceOnClient.mockImplementationOnce(async () => {
      events.push("importTraceOnClient");
      throw new Error("trace insert failed");
    });
    await expect(repository.importTrace("project-1", "manual", input, context))
      .rejects.toThrow("trace insert failed");
    expect(events).toEqual(["begin", "importTraceOnClient", "rollback", "release"]);
  });

  it("authorizes an exact evaluator version before inserting and project-scoped loading", async () => {
    const events: string[] = [];
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const resolveVersion = vi.fn(async () => {
      events.push("resolve");
      return "skillv-1";
    });
    const authorize = vi.fn(async () => {
      events.push("authorize");
    });
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        const statement = normalizedSql(sql);
        calls.push({ sql: statement, values });
        events.push(statement.startsWith("insert") ? "insert" : "load");
        if (statement.startsWith("insert")) return { rows: [{ id: values[0] }], rowCount: 1 };
        return { rows: [importJobRow({ id: values[0] })], rowCount: 1 };
      })
    } as unknown as Pool;
    const repository = new PgTraceImportRepository(pool, resolveVersion, authorize);

    const created = await repository.createImportJob({
      projectId: "project-1",
      source: "langsmith",
      sourceIntegrationId: "integration-1",
      skillVersionId: "requested-version",
      actorUserId: "user-1",
      requestedLimit: 25
    });
    expect(events).toEqual(["resolve", "authorize", "insert", "load"]);
    expect(resolveVersion).toHaveBeenCalledWith("project-1", "requested-version");
    const importJobId = created.id;
    expect(importJobId).toMatch(/^import_/);
    expect(authorize).toHaveBeenCalledWith({
      projectId: "project-1",
      skillVersionId: "skillv-1",
      context: "scheduled_import",
      resourceKind: "import_job",
      resourceId: importJobId,
      idempotencyKey: `import-job:${importJobId}:skillv-1`
    });
    expect(calls[0]?.sql).toContain("insert into import_jobs");
    expect(calls[0]?.values).toEqual([
      importJobId,
      "project-1",
      "queued",
      "langsmith",
      "integration-1",
      "user-1",
      25,
      "skillv-1"
    ]);
    expect(calls[1]?.sql).toContain("where ij.id = $1 and ij.project_id = $2");
    expect(calls[1]?.values).toEqual([importJobId, "project-1"]);
    expect(created).toMatchObject({
      id: importJobId,
      projectId: "project-1",
      source: "langsmith",
      skillVersionId: "skillv-1",
      actorEmail: "owner@example.com",
      status: "queued"
    });

    calls.length = 0;
    events.length = 0;
    await repository.createImportJob({
      projectId: "project-1",
      source: "manual",
      actorUserId: "user-manual"
    });
    expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ context: "manual_import" }));
    expect(calls[0]?.values.slice(4, 7)).toEqual([null, "user-manual", null]);

    calls.length = 0;
    await repository.createImportJob({
      projectId: "project-1",
      source: "langfuse",
      sourceIntegrationId: "integration-without-actor"
    });
    expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ context: "scheduled_import" }));
    expect(calls[0]?.values.slice(4, 7)).toEqual(["integration-without-actor", null, null]);

    const rejectedPoolQuery = vi.fn();
    const rejectedAuthorization = vi.fn(async () => {
      throw new Error("evaluator version is not authorized");
    });
    await expect(new PgTraceImportRepository(
      { query: rejectedPoolQuery } as unknown as Pool,
      vi.fn(async () => "skillv-rejected"),
      rejectedAuthorization
    ).createImportJob({ projectId: "project-1", source: "manual" }))
      .rejects.toThrow("evaluator version is not authorized");
    expect(rejectedAuthorization).toHaveBeenCalledOnce();
    expect(rejectedPoolQuery).not.toHaveBeenCalled();
  });

  it("keeps queued, running, completed, and failed transitions project-scoped", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let loadedStatus = "queued";
    let loadedError: string | null = null;
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        const statement = normalizedSql(sql);
        calls.push({ sql: statement, values });
        if (statement.includes("where ij.id = $1 and ij.project_id = $2")) {
          return {
            rows: [importJobRow({
              id: values[0],
              project_id: values[1],
              status: loadedStatus,
              error: loadedError,
              queue_job_id: loadedStatus === "queued" ? "queue-1" : null,
              completed_at: loadedStatus === "failed" ? CREATED_AT : null
            })],
            rowCount: 1
          };
        }
        if (statement.includes("set status = 'failed'")) {
          loadedStatus = "failed";
          loadedError = String(values[2]);
        }
        return { rows: [importJobRow()], rowCount: 1 };
      })
    } as unknown as Pool;
    const repository = new PgTraceImportRepository(pool, vi.fn(), vi.fn());

    await expect(repository.markImportJobQueued("project-1", "import-1", "queue-1"))
      .resolves.toMatchObject({ projectId: "project-1", queueJobId: "queue-1", status: "queued" });
    expect(calls[0]).toEqual({
      sql: expect.stringContaining("where id = $1 and project_id = $2"),
      values: ["import-1", "project-1", "queue-1"]
    });
    expect(calls[0]?.sql).toContain("set queue_job_id = $3, status = 'queued', error = null");

    calls.length = 0;
    await repository.markImportJobRunning("project-1", "import-1");
    expect(calls).toEqual([{
      sql: expect.stringContaining("set status = 'running', started_at = now(), error = null"),
      values: ["import-1", "project-1"]
    }]);
    expect(calls[0]?.sql).toContain("where id = $1 and project_id = $2");

    calls.length = 0;
    await repository.markImportJobCompleted("project-1", "import-1", {
      importedCount: 999,
      queuedJudgeCount: 3
    });
    expect(calls).toEqual([{
      sql: expect.stringContaining("set status = 'completed'"),
      values: ["import-1", "project-1", 3]
    }]);
    expect(calls[0]?.sql).toContain("from raw_traces where project_id = $2 and import_job_id = $1");
    expect(calls[0]?.sql).toContain("queued_judge_count = $3");

    calls.length = 0;
    await expect(repository.markImportJobFailed("project-1", "import-1", new Error("provider failed")))
      .resolves.toMatchObject({ status: "failed", error: "provider failed" });
    expect(calls[0]?.values).toEqual(["import-1", "project-1", "provider failed"]);
    expect(calls[0]?.sql).toContain("where id = $1 and project_id = $2");
    expect(calls[1]?.values).toEqual(["import-1", "project-1"]);

    calls.length = 0;
    loadedStatus = "queued";
    loadedError = null;
    await repository.markImportJobFailed("project-1", "import-1", "plain failure");
    expect(calls[0]?.values).toEqual(["import-1", "project-1", "plain failure"]);
  });

  it("fails closed on missing transitions and preserves ordered filtered project lists", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let missing = true;
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        const statement = normalizedSql(sql);
        calls.push({ sql: statement, values });
        if (statement.includes("order by ij.created_at desc")) {
          return {
            rows: [
              importJobRow({ id: "import-2", status: "failed", error: "boom" }),
              importJobRow({ id: "import-1", source: "manual", source_integration_id: null })
            ],
            rowCount: 2
          };
        }
        if (missing) return { rows: [], rowCount: 0 };
        return { rows: [importJobRow()], rowCount: 1 };
      })
    } as unknown as Pool;
    const repository = new PgTraceImportRepository(pool, vi.fn(), vi.fn());

    await expect(repository.markImportJobQueued("other-project", "missing", "queue"))
      .rejects.toThrow("Import job not found: missing");
    await expect(repository.markImportJobRunning("other-project", "missing"))
      .rejects.toThrow("Import job not found: missing");
    await expect(repository.markImportJobCompleted("other-project", "missing", {
      importedCount: 0,
      queuedJudgeCount: 0
    })).rejects.toThrow("Import job not found: missing");
    await expect(repository.markImportJobFailed("other-project", "missing", "boom"))
      .rejects.toThrow("Import job not found: missing");

    missing = false;
    calls.length = 0;
    await expect(repository.listImportJobs({ projectId: "project-1", status: "failed", limit: 2 }))
      .resolves.toMatchObject([
        { id: "import-2", projectId: "project-1", status: "failed", error: "boom" },
        { id: "import-1", projectId: "project-1", source: "manual", sourceIntegrationId: null }
      ]);
    expect(calls).toEqual([{
      sql: expect.stringContaining("order by ij.created_at desc limit $3"),
      values: ["project-1", "failed", 2]
    }]);
    expect(calls[0]?.sql).toContain("where ij.project_id = $1");
    expect(calls[0]?.sql).toContain("$2::text is null or ij.status = $2");
  });
});
