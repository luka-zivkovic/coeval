import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject, demoSkill } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { AmbiguousProjectSkillError, DemoRepository } from "../src/repository.js";
import * as demoReviewQueueModule from "../src/repository/demo-review-queues.js";
import { DemoReviewQueueRepository } from "../src/repository/demo-review-queues.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
  "createReviewQueue",
  "listReviewQueues",
  "getReviewQueueDetail",
  "getNextPendingQueueItem",
  "closeReviewQueue",
  "reopenReviewQueue",
  "addReviewQueueItems"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const REVIEW_QUEUE_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-review-queues.ts"
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
      return ts.isClassDeclaration(parent) && parent.name
        ? `${parent.name.text}.constructor`
        : "<constructor>";
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

function reviewQueueSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(REVIEW_QUEUE_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo review-queue repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo review-queue module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoReviewQueueRepository");
  if (!classExport) throw new Error("DemoReviewQueueRepository export was not resolved");
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
        node.text === "DemoReviewQueueRepository" &&
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

function reviewQueueSlice(repository: DemoRepository): DemoReviewQueueRepository {
  return Reflect.get(repository, "reviewQueueRepository") as DemoReviewQueueRepository;
}

function reviewQueueStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

describe("Demo review-queue repository slice", () => {
  it("owns exactly ReviewQueueRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(REVIEW_QUEUE_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoReviewQueueRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoReviewQueueModule)).toEqual(["DemoReviewQueueRepository"]);
    expect("DemoReviewQueueRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual([
        "InterfaceDeclaration:DemoReviewQueueRepositoryDependencies",
        "ClassDeclaration:DemoReviewQueueRepository"
      ]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["ReviewQueueRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_PUBLIC_METHODS.map((name) => `MethodDeclaration:${name}`),
      "MethodDeclaration:resolveReviewCriterionVersion",
      "MethodDeclaration:toReviewQueue"
    ]);

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    const expectedDelegateBodies: Record<(typeof EXPECTED_PUBLIC_METHODS)[number], string> = {
      createReviewQueue: "{ return this.reviewQueueRepository.createReviewQueue(input); }",
      listReviewQueues: "{ return this.reviewQueueRepository.listReviewQueues(projectId, opts); }",
      getReviewQueueDetail: "{ return this.reviewQueueRepository.getReviewQueueDetail(projectId, queueId); }",
      getNextPendingQueueItem: "{ return this.reviewQueueRepository.getNextPendingQueueItem(projectId, queueId, opts); }",
      closeReviewQueue: "{ return this.reviewQueueRepository.closeReviewQueue(projectId, queueId); }",
      reopenReviewQueue: "{ return this.reviewQueueRepository.reopenReviewQueue(projectId, queueId); }",
      addReviewQueueItems: "{ return this.reviewQueueRepository.addReviewQueueItems(input); }"
    };
    for (const name of EXPECTED_PUBLIC_METHODS) {
      const method = facadeMethods.get(name);
      if (!method) throw new Error(`DemoRepository.${name} not found`);
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim())
        .toBe(expectedDelegateBodies[name]);
    }

    const analysis = reviewQueueSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoReviewQueueRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.ts:DemoRepository.constructor:new DemoReviewQueueRepository(this.store, { caseExistsForProject: (projectId, caseId) => this.caseExistsForProject(projectId, caseId), getCurrentSkill: (projectId) => this.getCurrentSkill(projectId) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.ts:ImportDeclaration:import { DemoReviewQueueRepository } from "./repository/demo-review-queues.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.ts:ImportDeclaration:"./repository/demo-review-queues.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.ts:ImportSpecifier:DemoReviewQueueRepository",
      "repository.ts:NewExpression:DemoReviewQueueRepository",
      "repository.ts:TypeReference:DemoReviewQueueRepository",
      "repository/demo-review-queues.ts:ClassDeclaration:DemoReviewQueueRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(reviewQueueSlice(repositoryInstance), "store"))
      .toBe(reviewQueueStore(repositoryInstance));
  }, 30_000);

  it("preserves validation, immutable binding, tuple dedupe, positions, and facade polymorphism", async () => {
    class CapturingRepository extends DemoRepository {
      readonly caseChecks: string[] = [];
      currentSkillCalls = 0;

      override async caseExistsForProject(projectId: string, caseId: string): Promise<boolean> {
        this.caseChecks.push(`${projectId}:${caseId}`);
        return super.caseExistsForProject(projectId, caseId);
      }

      override async getCurrentSkill(projectId: string): ReturnType<DemoRepository["getCurrentSkill"]> {
        this.currentSkillCalls += 1;
        return super.getCurrentSkill(projectId);
      }
    }

    const repository = new CapturingRepository();
    const store = reviewQueueStore(repository);
    const criterionVersionId = store.skillVersionCriteria.get(demoSkill.currentVersion.id)!;
    const queue = await repository.createReviewQueue({
      projectId: demoProject.id,
      name: "First-pass review",
      caseIds: ["case_exc_001", "case_exc_001", "case_exc_002"]
    });
    expect(repository.caseChecks).toEqual([
      `${demoProject.id}:case_exc_001`,
      `${demoProject.id}:case_exc_001`,
      `${demoProject.id}:case_exc_002`
    ]);
    expect(repository.currentSkillCalls).toBe(1);
    expect(queue).toMatchObject({ pendingCount: 2, completedCount: 0, status: "open" });
    expect((await repository.getReviewQueueDetail(demoProject.id, queue.id))?.items).toEqual([
      expect.objectContaining({ caseId: "case_exc_001", criterionVersionId, position: 0 }),
      expect.objectContaining({ caseId: "case_exc_002", criterionVersionId, position: 1 })
    ]);

    const countsBeforeInvalidCreate = [store.reviewQueues.length, store.reviewQueueItems.length];
    await expect(repository.createReviewQueue({
      projectId: demoProject.id,
      name: "Must roll back",
      caseIds: ["case_exc_003", "case_missing"]
    })).rejects.toThrow("Case not found in project: case_missing");
    expect([store.reviewQueues.length, store.reviewQueueItems.length]).toEqual(countsBeforeInvalidCreate);

    const added = await repository.addReviewQueueItems({
      projectId: demoProject.id,
      queueId: queue.id,
      items: [
        { caseId: "case_exc_003", assignedToUserId: "reviewer_a" },
        { caseId: "case_exc_003", assignedToUserId: "reviewer_a" },
        { caseId: "case_exc_003", assignedToUserId: "reviewer_b" },
        { caseId: "case_exc_001", assignedToUserId: "reviewer_a" }
      ]
    });
    expect(added.map((item) => [item.caseId, item.assignedToUserId, item.position])).toEqual([
      ["case_exc_003", "reviewer_a", 2],
      ["case_exc_003", "reviewer_b", 3],
      ["case_exc_001", "reviewer_a", 4]
    ]);
    await expect(repository.addReviewQueueItems({
      projectId: demoProject.id,
      queueId: queue.id,
      items: [{ caseId: "case_exc_003", assignedToUserId: "reviewer_a" }]
    })).resolves.toEqual([]);
    const itemCountBeforeInvalidAdd = store.reviewQueueItems.length;
    await expect(repository.addReviewQueueItems({
      projectId: demoProject.id,
      queueId: queue.id,
      items: [
        { caseId: "case_exc_003", assignedToUserId: "reviewer_c" },
        { caseId: "case_missing" }
      ]
    })).rejects.toThrow("Case not found in project: case_missing");
    expect(store.reviewQueueItems).toHaveLength(itemCountBeforeInvalidAdd);
  });

  it("preserves criterion ambiguity, queue lifecycle, project isolation, and FIFO assignment", async () => {
    const repository = new DemoRepository();
    const store = reviewQueueStore(repository);
    const firstCriterionVersionId = store.skillVersionCriteria.get(demoSkill.currentVersion.id)!;
    const secondCriterionVersionId = "criterionv_review_second";
    store.criterionVersions.push({
      ...structuredClone(store.criterionVersions[0]!),
      id: secondCriterionVersionId,
      revision: 2
    });
    store.skillVersionCriteria.set("skillv_review_second", secondCriterionVersionId);

    const queue = await repository.createReviewQueue({
      projectId: demoProject.id,
      name: "Two criteria",
      caseIds: ["case_exc_001"]
    });
    await repository.addReviewQueueItems({
      projectId: demoProject.id,
      queueId: queue.id,
      items: [{ caseId: "case_exc_002", criterionVersionId: secondCriterionVersionId }]
    });
    await expect(repository.getNextPendingQueueItem(demoProject.id, queue.id))
      .rejects.toBeInstanceOf(AmbiguousProjectSkillError);
    await expect(repository.getNextPendingQueueItem(demoProject.id, queue.id, {
      criterionVersionId: firstCriterionVersionId
    })).resolves.toMatchObject({ caseId: "case_exc_001", position: 0 });
    await expect(repository.getNextPendingQueueItem(demoProject.id, queue.id, {
      criterionVersionId: secondCriterionVersionId
    })).resolves.toMatchObject({ caseId: "case_exc_002", position: 1 });
    await expect(repository.addReviewQueueItems({
      projectId: demoProject.id,
      queueId: queue.id,
      items: [{ caseId: "case_exc_003", criterionVersionId: "criterionv_foreign" }]
    })).rejects.toThrow(
      "Criterion version is not bound to an evaluator in this project: criterionv_foreign"
    );

    expect(await repository.getReviewQueueDetail("project_other", queue.id)).toBeNull();
    expect(await repository.listReviewQueues("project_other")).toEqual([]);
    const closed = await repository.closeReviewQueue(demoProject.id, queue.id);
    const closedAgain = await repository.closeReviewQueue(demoProject.id, queue.id);
    expect(closed).toMatchObject({ status: "closed", closedAt: expect.any(String) });
    expect(closedAgain?.closedAt).toBe(closed?.closedAt);
    expect(await repository.getNextPendingQueueItem(demoProject.id, queue.id, {
      criterionVersionId: firstCriterionVersionId
    })).toBeNull();
    expect(await repository.closeReviewQueue("project_other", queue.id)).toBeNull();
    expect(await repository.reopenReviewQueue("project_other", queue.id)).toBeNull();
    expect(await repository.reopenReviewQueue(demoProject.id, queue.id)).toMatchObject({
      status: "open",
      closedAt: null
    });
  });

  it("keeps verdict completion on the exact shared queue-item identities", async () => {
    const repository = new DemoRepository();
    const queue = await repository.createReviewQueue({
      projectId: demoProject.id,
      name: "Reviewer overlap",
      caseIds: ["case_exc_001"]
    });
    await repository.addReviewQueueItems({
      projectId: demoProject.id,
      queueId: queue.id,
      items: [
        { caseId: "case_exc_001", assignedToUserId: "reviewer_a" },
        { caseId: "case_exc_001", assignedToUserId: "reviewer_b" }
      ]
    });
    const identitiesBefore = (await repository.getReviewQueueDetail(demoProject.id, queue.id))!.items;

    await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "Reviewed by A." }
    });
    const afterA = (await repository.getReviewQueueDetail(demoProject.id, queue.id))!;
    expect(afterA.queue).toMatchObject({ pendingCount: 1, completedCount: 2 });
    expect(afterA.items).toEqual(identitiesBefore);
    expect(afterA.items.map((item) => [item.assignedToUserId, item.status])).toEqual([
      [null, "completed"],
      ["reviewer_a", "completed"],
      ["reviewer_b", "pending"]
    ]);

    await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_b",
      payload: { kind: "binary", pass: false, rationale: "Reviewed by B." }
    });
    await expect(repository.getReviewQueueDetail(demoProject.id, queue.id)).resolves.toMatchObject({
      queue: { pendingCount: 0, completedCount: 3 },
      items: [
        { status: "completed" },
        { status: "completed" },
        { status: "completed" }
      ]
    });
  });
});
