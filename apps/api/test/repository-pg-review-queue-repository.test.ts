import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "@coeval/shared";
import type { Pool, PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as pgRepositoryModule from "../src/repository.pg.js";
import * as reviewQueueModule from "../src/repository.pg/review-queue-repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgReviewQueueRepository } from "../src/repository.pg/review-queue-repository.js";

const EXPECTED_METHODS = [
  "createReviewQueue",
  "listReviewQueues",
  "getReviewQueueDetail",
  "getNextPendingQueueItem",
  "addReviewQueueItems",
  "closeReviewQueue",
  "reopenReviewQueue"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const REVIEW_QUEUE_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/review-queue-repository.ts"
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

function reviewQueueRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const reviewQueueSource = program.getSourceFile(REVIEW_QUEUE_REPOSITORY_PATH);
  if (!reviewQueueSource) throw new Error("PostgreSQL review-queue source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(reviewQueueSource);
  if (!moduleSymbol) throw new Error("PostgreSQL review-queue module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgReviewQueueRepository");
  if (!classExport) throw new Error("PgReviewQueueRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(REVIEW_QUEUE_REPOSITORY_PATH)) {
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
        node.text === "PgReviewQueueRepository" &&
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

const CREATED_AT = "2026-09-02T00:00:00.000Z";

function queueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "revq-1",
    project_id: "project-1",
    name: "Review queue",
    description: null,
    status: "open",
    created_by_user_id: "user-1",
    created_at: CREATED_AT,
    closed_at: null,
    pending_count: 2,
    completed_count: 0,
    ...overrides
  };
}

function itemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "revqi-1",
    queue_id: "revq-1",
    case_id: "case-1",
    criterion_version_id: "criterionv-1",
    status: "pending",
    position: 0,
    assigned_to_user_id: null,
    created_at: CREATED_AT,
    completed_at: null,
    ...overrides
  };
}

describe("PostgreSQL review-queue repository slice", () => {
  it("owns exactly ReviewQueueRepositoryPort behind direct facade delegates", () => {
    const reviewQueueSource = sourceFile(REVIEW_QUEUE_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const reviewQueueRepository = classDeclaration(reviewQueueSource, "PgReviewQueueRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(reviewQueueModule)).toEqual(["PgReviewQueueRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(reviewQueueSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(reviewQueueSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgReviewQueueRepository"]);
    expect(reviewQueueRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(reviewQueueSource))
    )).toEqual(["ReviewQueueRepositoryPort"]);
    expect(reviewQueueRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(reviewQueueSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`),
      "MethodDeclaration:resolveReviewCriterionVersion"
    ]);
    expect(reviewQueueRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, reviewQueueSource))
    )).toEqual([[
      "private readonly pool: Pool",
      "private readonly getCurrentSkill: (projectId: string) => Promise<Skill>"
    ]]);

    const expectedDelegates = new Map<string, string>([
      ["createReviewQueue", "{ return this.reviewQueueRepository.createReviewQueue(input); }"],
      ["listReviewQueues", "{ return this.reviewQueueRepository.listReviewQueues(projectId, opts); }"],
      ["getReviewQueueDetail", "{ return this.reviewQueueRepository.getReviewQueueDetail(projectId, queueId); }"],
      ["getNextPendingQueueItem", "{ return this.reviewQueueRepository.getNextPendingQueueItem(projectId, queueId, opts); }"],
      ["addReviewQueueItems", "{ return this.reviewQueueRepository.addReviewQueueItems(input); }"],
      ["closeReviewQueue", "{ return this.reviewQueueRepository.closeReviewQueue(projectId, queueId); }"],
      ["reopenReviewQueue", "{ return this.reviewQueueRepository.reopenReviewQueue(projectId, queueId); }"]
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

  it("constructs one slice with the exact pool and lazy current-skill callback", async () => {
    const analysis = reviewQueueRepositoryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgReviewQueueRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgReviewQueueRepository( pool, (projectId) => this.getCurrentSkill(projectId) )"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgReviewQueueRepository } from "./repository.pg/review-queue-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/review-queue-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgReviewQueueRepository",
      "repository.pg.ts:NewExpression:PgReviewQueueRepository",
      "repository.pg.ts:TypeReference:PgReviewQueueRepository",
      "repository.pg/review-queue-repository.ts:ClassDeclaration:PgReviewQueueRepository"
    ]);

    const pool = { query: vi.fn() } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "reviewQueueRepository") as PgReviewQueueRepository;
    expect(slice).toBeInstanceOf(PgReviewQueueRepository);
    expect(Object.keys(slice)).toEqual(["pool", "getCurrentSkill"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);
    const replacement = vi.fn(async () => ({ currentVersion: { id: "skillv-lazy" } }));
    Reflect.set(repository, "getCurrentSkill", replacement);
    await expect(Reflect.get(slice, "getCurrentSkill")("project-lazy"))
      .resolves.toEqual({ currentVersion: { id: "skillv-lazy" } });
    expect(replacement).toHaveBeenCalledWith("project-lazy");
  }, 30_000);

  it("creates a deduplicated queue on the resolved current criterion in one transaction", async () => {
    const poolQueries: Array<{ sql: string; values: unknown[] }> = [];
    const clientQueries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const currentSkill = vi.fn(async (): Promise<Skill> => ({
      currentVersion: { id: "skillv-current" }
    } as Skill));
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        clientQueries.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string, values: unknown[]) => {
        poolQueries.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        if (sql.includes("from skill_versions")) {
          return { rows: [{ criterion_version_id: "criterionv-current" }], rowCount: 1 };
        }
        if (sql.includes("select id from cases")) {
          return { rows: [{ id: "case-1" }, { id: "case-2" }], rowCount: 2 };
        }
        if (sql.includes("select rq.*")) {
          return { rows: [queueRow({ id: String(values[0]) })], rowCount: 1 };
        }
        if (sql.includes("select * from review_queue_items")) {
          return { rows: [itemRow({ queue_id: String(values[0]) })], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as Pool;

    const queue = await new PgReviewQueueRepository(pool, currentSkill).createReviewQueue({
      projectId: "project-1",
      name: "Review queue",
      description: "Needs human review",
      caseIds: ["case-1", "case-1", "case-2"],
      createdByUserId: "user-1"
    });

    expect(currentSkill).toHaveBeenCalledWith("project-1");
    expect(queue).toMatchObject({
      id: expect.stringMatching(/^revq_/),
      projectId: "project-1",
      pendingCount: 2
    });
    expect(poolQueries[0]).toEqual({
      sql: expect.stringContaining("from skill_versions"),
      values: ["project-1", "skillv-current"]
    });
    expect(poolQueries[1]).toEqual({
      sql: expect.stringContaining("select id from cases"),
      values: ["project-1", ["case-1", "case-2"]]
    });
    expect(clientQueries.map((query) => query.sql)).toEqual([
      "begin",
      expect.stringContaining("insert into review_queues"),
      expect.stringContaining("insert into review_queue_items"),
      expect.stringContaining("insert into review_queue_items"),
      "commit"
    ]);
    expect(clientQueries[1]?.values).toEqual([
      queue.id,
      "project-1",
      "Review queue",
      "Needs human review",
      "user-1"
    ]);
    expect(clientQueries[2]?.values?.slice(1)).toEqual([
      queue.id,
      "case-1",
      "criterionv-current",
      0
    ]);
    expect(clientQueries[3]?.values?.slice(1)).toEqual([
      queue.id,
      "case-2",
      "criterionv-current",
      1
    ]);
    expect(client.release).toHaveBeenCalledOnce();

    const failureEvents: string[] = [];
    const failureClient = {
      query: vi.fn(async (sql: string) => {
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        failureEvents.push(normalizedSql);
        if (normalizedSql.includes("insert into review_queues")) throw new Error("insert failed");
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(() => failureEvents.push("release"))
    } as unknown as PoolClient;
    const failurePool = {
      connect: vi.fn(async () => failureClient),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from criterion_versions")) return { rows: [{ id: "criterionv-1" }], rowCount: 1 };
        if (sql.includes("select id from cases")) return { rows: [{ id: "case-1" }], rowCount: 1 };
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as Pool;
    await expect(new PgReviewQueueRepository(failurePool, currentSkill).createReviewQueue({
      projectId: "project-1",
      name: "Failure",
      criterionVersionId: "criterionv-1",
      caseIds: ["case-1"]
    })).rejects.toThrow("insert failed");
    expect(failureEvents).toEqual([
      "begin",
      expect.stringContaining("insert into review_queues"),
      "rollback",
      "release"
    ]);
  });

  it("preserves project-scoped list, detail, criterion ambiguity, and explicit selection", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        if (sql.includes("count(distinct criterion_version_id)")) {
          return { rows: [{ criterion_count: 2 }], rowCount: 1 };
        }
        if (sql.includes("from criterion_versions")) return { rows: [{ id: "criterionv-1" }], rowCount: 1 };
        if (sql.includes("select rqi.*")) return { rows: [itemRow()], rowCount: 1 };
        if (sql.includes("select rq.*") && sql.includes("order by rq.created_at desc")) {
          return { rows: [queueRow({ status: "closed" })], rowCount: 1 };
        }
        if (sql.includes("select rq.*")) return { rows: [queueRow()], rowCount: 1 };
        if (sql.includes("select * from review_queue_items")) {
          return { rows: [itemRow(), itemRow({ id: "revqi-2", position: 1 })], rowCount: 2 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as Pool;
    const repository = new PgReviewQueueRepository(pool, vi.fn());

    await expect(repository.listReviewQueues("project-1", { status: "closed" }))
      .resolves.toEqual([expect.objectContaining({ projectId: "project-1", status: "closed" })]);
    expect(calls[0]?.values).toEqual(["project-1", "closed"]);
    expect(calls[0]?.sql).toContain("order by rq.created_at desc");
    await expect(repository.getReviewQueueDetail("project-1", "revq-1"))
      .resolves.toMatchObject({ items: [{ position: 0 }, { position: 1 }] });
    expect(calls[1]?.values).toEqual(["revq-1", "project-1"]);
    expect(calls[2]?.values).toEqual(["revq-1"]);
    expect(calls[2]?.sql).toContain("order by position asc");

    await expect(repository.getNextPendingQueueItem("project-1", "revq-1"))
      .rejects.toMatchObject({ name: "AmbiguousProjectSkillError" });
    expect(calls.at(-1)?.values).toEqual(["revq-1"]);
    await expect(repository.getNextPendingQueueItem("project-1", "revq-1", {
      assignedToUserId: "reviewer-1",
      criterionVersionId: "criterionv-1"
    })).resolves.toMatchObject({ id: "revqi-1", criterionVersionId: "criterionv-1" });
    expect(calls.at(-2)?.values).toEqual(["project-1", "criterionv-1"]);
    expect(calls.at(-1)?.values).toEqual([
      "revq-1",
      "project-1",
      "reviewer-1",
      "criterionv-1"
    ]);
    expect(calls.at(-1)?.sql).toContain("rq.status = 'open'");
    expect(calls.at(-1)?.sql).toContain(
      "$3::text is null or rqi.assigned_to_user_id is null or rqi.assigned_to_user_id = $3"
    );
    expect(calls.at(-1)?.sql).toContain("order by rqi.position asc");
  });

  it("adds deduplicated items with contiguous successful positions in one transaction", async () => {
    const poolCalls: Array<{ sql: string; values: unknown[] }> = [];
    const clientCalls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let insertAttempt = 0;
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        clientCalls.push({ sql: normalizedSql, values });
        if (!normalizedSql.includes("insert into review_queue_items")) return { rows: [], rowCount: 1 };
        insertAttempt += 1;
        if (insertAttempt === 2) return { rows: [], rowCount: 0 };
        return {
          rows: [itemRow({
            id: `revqi-${insertAttempt}`,
            case_id: values?.[2],
            criterion_version_id: values?.[3],
            position: values?.[4],
            assigned_to_user_id: values?.[5]
          })],
          rowCount: 1
        };
      }),
      release: vi.fn()
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string, values: unknown[]) => {
        poolCalls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        if (sql.includes("select id from review_queues")) return { rows: [{ id: "revq-1" }], rowCount: 1 };
        if (sql.includes("select id from cases")) {
          return { rows: [{ id: "case-1" }, { id: "case-2" }, { id: "case-3" }], rowCount: 3 };
        }
        if (sql.includes("from criterion_versions")) return { rows: [{ id: values[1] }], rowCount: 1 };
        if (sql.includes("select count(*)")) return { rows: [{ count: 2 }], rowCount: 1 };
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as Pool;
    const repository = new PgReviewQueueRepository(pool, vi.fn());

    const added = await repository.addReviewQueueItems({
      projectId: "project-1",
      queueId: "revq-1",
      items: [
        { caseId: "case-1", criterionVersionId: "criterionv-1", assignedToUserId: "user-1" },
        { caseId: "case-2", criterionVersionId: "criterionv-1", assignedToUserId: "user-1" },
        { caseId: "case-3", criterionVersionId: "criterionv-1", assignedToUserId: "user-2" }
      ]
    });

    expect(added.map((item) => [item.caseId, item.position])).toEqual([
      ["case-1", 2],
      ["case-3", 3]
    ]);
    const inserts = clientCalls.filter((call) => call.sql.includes("insert into review_queue_items"));
    expect(inserts.every((call) => call.sql.includes("on conflict do nothing"))).toBe(true);
    expect(inserts.map((call) => call.values?.slice(1))).toEqual([
      ["revq-1", "case-1", "criterionv-1", 2, "user-1"],
      ["revq-1", "case-2", "criterionv-1", 3, "user-1"],
      ["revq-1", "case-3", "criterionv-1", 3, "user-2"]
    ]);
    expect(clientCalls.map((call) => call.sql)).toEqual([
      "begin",
      expect.stringContaining("insert into review_queue_items"),
      expect.stringContaining("insert into review_queue_items"),
      expect.stringContaining("insert into review_queue_items"),
      "commit"
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(poolCalls[0]?.values).toEqual(["revq-1", "project-1"]);
    expect(poolCalls[1]?.values).toEqual(["project-1", ["case-1", "case-2", "case-3"]]);

    const failureEvents: string[] = [];
    const failureClient = {
      query: vi.fn(async (sql: string) => {
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        failureEvents.push(normalizedSql);
        if (normalizedSql.includes("insert into review_queue_items")) throw new Error("item insert failed");
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(() => failureEvents.push("release"))
    } as unknown as PoolClient;
    const failurePool = {
      connect: vi.fn(async () => failureClient),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("select id from review_queues")) return { rows: [{ id: "revq-1" }], rowCount: 1 };
        if (sql.includes("select id from cases")) return { rows: [{ id: "case-1" }], rowCount: 1 };
        if (sql.includes("from criterion_versions")) return { rows: [{ id: "criterionv-1" }], rowCount: 1 };
        if (sql.includes("select count(*)")) return { rows: [{ count: 2 }], rowCount: 1 };
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as Pool;
    await expect(new PgReviewQueueRepository(failurePool, vi.fn()).addReviewQueueItems({
      projectId: "project-1",
      queueId: "revq-1",
      items: [{ caseId: "case-1", criterionVersionId: "criterionv-1" }]
    })).rejects.toThrow("item insert failed");
    expect(failureEvents).toEqual([
      "begin",
      expect.stringContaining("insert into review_queue_items"),
      "rollback",
      "release"
    ]);
  });

  it("keeps close and reopen idempotent, project-scoped, and mapped through detail reads", async () => {
    let status = "open";
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        calls.push({ sql: normalizedSql, values });
        if (sql.includes("update review_queues") && sql.includes("status = 'closed'")) {
          if (status === "closed") return { rows: [], rowCount: 0 };
          status = "closed";
          return { rows: [{ id: "revq-1" }], rowCount: 1 };
        }
        if (sql.includes("update review_queues") && sql.includes("status = 'open'")) {
          status = "open";
          return { rows: [{ id: "revq-1" }], rowCount: 1 };
        }
        if (sql.includes("select rq.*")) {
          return { rows: [queueRow({ status, closed_at: status === "closed" ? CREATED_AT : null })], rowCount: 1 };
        }
        if (sql.includes("select * from review_queue_items")) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as Pool;
    const repository = new PgReviewQueueRepository(pool, vi.fn());

    await expect(repository.closeReviewQueue("project-1", "revq-1"))
      .resolves.toMatchObject({ status: "closed", closedAt: CREATED_AT });
    await expect(repository.closeReviewQueue("project-1", "revq-1"))
      .resolves.toMatchObject({ status: "closed", closedAt: CREATED_AT });
    await expect(repository.reopenReviewQueue("project-1", "revq-1"))
      .resolves.toMatchObject({ status: "open", closedAt: null });
    const updates = calls.filter((call) => call.sql.startsWith("update review_queues"));
    expect(updates.map((call) => call.values)).toEqual([
      ["revq-1", "project-1"],
      ["revq-1", "project-1"],
      ["revq-1", "project-1"]
    ]);
    expect(updates[0]?.sql).toContain("set status = 'closed', closed_at = now()");
    expect(updates[0]?.sql).toContain("project_id = $2 and status <> 'closed'");
    expect(updates[1]?.sql).toContain("project_id = $2 and status <> 'closed'");
    expect(updates[2]?.sql).toContain("set status = 'open', closed_at = null");
    expect(updates[2]?.sql).toContain("project_id = $2 and status <> 'open'");
  });
});
