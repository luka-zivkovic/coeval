import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject } from "@coeval/db";
import type { DatasetRevision, EvalRun } from "@coeval/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DatasetRevisionConflictError, DemoRepository } from "../src/repository.js";
import * as demoRunComparisonModule from "../src/repository/demo-run-comparisons.js";
import { DemoRunComparisonRepository } from "../src/repository/demo-run-comparisons.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_METHODS = [
  "createRunComparison",
  "getRunComparison",
  "listRunComparisons"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-repository.ts");
const RUN_COMPARISON_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-run-comparisons.ts"
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
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      return ts.isFunctionDeclaration(current) && current.name ? current.name.text : "<anonymous>";
    }
  }
  return "<module>";
}

function runComparisonSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(RUN_COMPARISON_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo run-comparison repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo run-comparison module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoRunComparisonRepository");
  if (!classExport) throw new Error("DemoRunComparisonRepository export was not resolved");
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
        node.text === "DemoRunComparisonRepository" &&
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

function runComparisonSlice(repository: DemoRepository): DemoRunComparisonRepository {
  return Reflect.get(repository, "runComparisonRepository") as DemoRunComparisonRepository;
}

function runComparisonStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

function evalRun(id: string, projectId: string, datasetRevisionId: string): EvalRun {
  return {
    id,
    projectId,
    datasetId: null,
    datasetRevisionId,
    skillVersionId: `skill_${id}`,
    trigger: "manual",
    status: "completed",
    blocking: false,
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    agreedItems: 0,
    error: null,
    sourceTraceTest: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-09-01T00:00:00.000Z"
  };
}

function datasetRevision(id: string, projectId: string, sourceDatasetId: string): DatasetRevision {
  return {
    id,
    projectId,
    seriesId: `series_${id}`,
    revisionNumber: 1,
    sourceDatasetId,
    parentRevisionId: null,
    role: "iterative_development",
    sourceKind: "collection_snapshot",
    identityBasis: "input-identity/v1",
    contentDigest: "a".repeat(64),
    revisionDigest: "b".repeat(64),
    itemCount: 0,
    provenanceLevel: "legacy",
    exposureState: "visible_by_design",
    semanticLeakageDetection: "unsupported",
    createdByUserId: null,
    createdAt: "2026-09-01T00:00:00.000Z"
  };
}

describe("Demo run-comparison repository slice", () => {
  it("owns exactly RunComparisonRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(RUN_COMPARISON_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoRunComparisonRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoRunComparisonModule)).toEqual(["DemoRunComparisonRepository"]);
    expect("DemoRunComparisonRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        ts.isClassDeclaration(statement) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual(["ClassDeclaration:DemoRunComparisonRepository"]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["RunComparisonRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual(["Constructor", ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)]);

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    const expectedDelegateBodies: Record<(typeof EXPECTED_METHODS)[number], string> = {
      createRunComparison: "{ return this.runComparisonRepository.createRunComparison(input); }",
      getRunComparison: "{ return this.runComparisonRepository.getRunComparison(projectId, runComparisonId); }",
      listRunComparisons: "{ return this.runComparisonRepository.listRunComparisons(projectId, opts); }"
    };
    for (const name of EXPECTED_METHODS) {
      const method = facadeMethods.get(name);
      if (!method) throw new Error(`DemoRepository.${name} not found`);
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim())
        .toBe(expectedDelegateBodies[name]);
    }

    const analysis = runComparisonSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoRunComparisonRepository"]);
    expect(analysis.allocations).toEqual([
      "repository/demo-composition.ts:createDemoRepositoryComposition:new DemoRunComparisonRepository(store)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoRunComparisonRepository } from "./demo-run-comparisons.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:"./demo-run-comparisons.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-composition.ts:ImportSpecifier:DemoRunComparisonRepository",
      "repository/demo-composition.ts:NewExpression:DemoRunComparisonRepository",
      "repository/demo-composition.ts:TypeReference:DemoRunComparisonRepository",
      "repository/demo-run-comparisons.ts:ClassDeclaration:DemoRunComparisonRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(runComparisonSlice(repositoryInstance), "store"))
      .toBe(runComparisonStore(repositoryInstance));
  }, 30_000);

  it("preserves revision/run validation, project isolation, stable ordering, limits, and copy boundaries", async () => {
    const repository = new DemoRepository();
    const store = runComparisonStore(repository);
    const revision = datasetRevision("dsrev_compare", demoProject.id, "dataset_compare");
    store.datasetRevisions.push(revision);
    store.evalRuns.push(
      evalRun("run_a", demoProject.id, revision.id),
      evalRun("run_b", demoProject.id, revision.id)
    );

    const created = await repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: revision.sourceDatasetId!,
      datasetRevisionId: revision.id,
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_a",
      runBId: "run_b"
    });
    expect(created).not.toBe(store.runComparisons[0]);
    expect(created).toMatchObject({
      id: expect.stringMatching(/^rcmp_/),
      datasetRevisionId: revision.id,
      runAId: "run_a",
      runBId: "run_b"
    });
    created.datasetId = "mutated_copy";
    expect(store.runComparisons[0]?.datasetId).toBe(revision.sourceDatasetId);

    const loaded = await repository.getRunComparison(demoProject.id, created.id);
    expect(loaded).not.toBe(store.runComparisons[0]);
    expect(loaded?.datasetId).toBe(revision.sourceDatasetId);
    expect(await repository.getRunComparison(demoProject.id, "rcmp_unknown")).toBeNull();
    expect(await repository.getRunComparison("project_other", created.id)).toBeNull();

    store.runComparisons[0]!.createdAt = "2026-08-31T00:00:00.000Z";
    store.runComparisons.push(
      {
        ...store.runComparisons[0]!,
        id: "rcmp_a",
        datasetRevisionId: null,
        createdAt: "2026-09-02T00:00:00.000Z"
      },
      {
        ...store.runComparisons[0]!,
        id: "rcmp_z",
        datasetRevisionId: null,
        createdAt: "2026-09-02T00:00:00.000Z"
      },
      {
        ...store.runComparisons[0]!,
        id: "rcmp_foreign",
        projectId: "project_other",
        createdAt: "2026-09-03T00:00:00.000Z"
      }
    );
    const listed = await repository.listRunComparisons(demoProject.id, { limit: 2 });
    expect(listed.map((comparison) => comparison.id)).toEqual(["rcmp_z", "rcmp_a"]);
    expect(listed[0]).not.toBe(store.runComparisons.find((comparison) => comparison.id === "rcmp_z"));
    listed[0]!.datasetId = "mutated_list_copy";
    expect(store.runComparisons.find((comparison) => comparison.id === "rcmp_z")?.datasetId)
      .toBe(revision.sourceDatasetId);

    await expect(repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: "dataset_wrong",
      datasetRevisionId: revision.id,
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_a",
      runBId: "run_b"
    })).rejects.toBeInstanceOf(DatasetRevisionConflictError);

    store.evalRuns[1]!.datasetRevisionId = "dsrev_other";
    await expect(repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: revision.sourceDatasetId!,
      datasetRevisionId: revision.id,
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_a",
      runBId: "run_b"
    })).rejects.toThrow("Run comparison revision must match its dataset and both eval runs");
    store.evalRuns[1]!.datasetRevisionId = revision.id;

    store.evalRuns[0]!.datasetRevisionId = "dsrev_other";
    await expect(repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: revision.sourceDatasetId!,
      datasetRevisionId: revision.id,
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_a",
      runBId: "run_b"
    })).rejects.toThrow("Run comparison revision must match its dataset and both eval runs");
    store.evalRuns[0]!.datasetRevisionId = revision.id;

    store.datasetRevisions[0]!.projectId = "project_other";
    await expect(repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: revision.sourceDatasetId!,
      datasetRevisionId: revision.id,
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_a",
      runBId: "run_b"
    })).rejects.toThrow("Run comparison revision must match its dataset and both eval runs");
    store.datasetRevisions[0]!.projectId = demoProject.id;

    store.evalRuns[0]!.projectId = "project_other";
    await expect(repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: revision.sourceDatasetId!,
      datasetRevisionId: revision.id,
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_a",
      runBId: "run_b"
    })).rejects.toThrow("Run comparison revision must match its dataset and both eval runs");
    store.evalRuns[0]!.projectId = demoProject.id;

    store.evalRuns[1]!.projectId = "project_other";
    await expect(repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: revision.sourceDatasetId!,
      datasetRevisionId: revision.id,
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_a",
      runBId: "run_b"
    })).rejects.toThrow("Run comparison revision must match its dataset and both eval runs");
    store.evalRuns[1]!.projectId = demoProject.id;

    for (let index = 0; index < 51; index += 1) {
      store.runComparisons.push({
        ...store.runComparisons[0]!,
        id: `rcmp_limit_${index.toString().padStart(2, "0")}`,
        createdAt: `2026-08-${(index % 28 + 1).toString().padStart(2, "0")}T00:00:00.000Z`
      });
    }
    expect(await repository.listRunComparisons(demoProject.id)).toHaveLength(50);
  });

  it("preserves the legacy nullable-revision creation path", async () => {
    const repository = new DemoRepository();
    await expect(repository.createRunComparison({
      projectId: demoProject.id,
      datasetId: "dataset_legacy",
      versionAId: "skillv_a",
      versionBId: "skillv_b",
      runAId: "run_missing_a",
      runBId: "run_missing_b"
    })).resolves.toMatchObject({
      datasetRevisionId: null,
      runAId: "run_missing_a",
      runBId: "run_missing_b"
    });
  });
});
