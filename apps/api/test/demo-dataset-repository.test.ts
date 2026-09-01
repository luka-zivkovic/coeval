import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";
import * as demoDatasetModule from "../src/repository/demo-datasets.js";
import { DemoDatasetRepository } from "../src/repository/demo-datasets.js";
import {
  DatasetNotFoundError,
  DatasetRevisionNotFoundError
} from "../src/repository/errors.js";

const EXPECTED_PUBLIC_METHODS = [
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

const EXPECTED_DEPENDENCIES = [
  "addDatasetItems",
  "caseExistsForProject",
  "getDatasetDetail",
  "getDatasetRevisionDetail",
  "importTrace",
  "listGoldenSet",
  "traceForGoldenEntry"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const DATASET_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-datasets.ts"
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

function datasetSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(DATASET_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo dataset repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo dataset module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoDatasetRepository");
  if (!classExport) throw new Error("DemoDatasetRepository export was not resolved");
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
        if (
          resolution &&
          path.resolve(resolution.resolvedFileName) === path.resolve(DATASET_REPOSITORY_PATH) &&
          (
            ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            ts.isImportEqualsDeclaration(node.parent) ||
            ts.isCallExpression(node.parent)
          )
        ) {
          moduleEdges.push(
            `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.parent.getText(source)
              .replace(/\s+/g, " ")
              .trim()}`
          );
        }
      }
      if (
        ts.isIdentifier(node) &&
        node.text === "DemoDatasetRepository" &&
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
    references: references.sort()
  };
}

function datasetSlice(repository: DemoRepository): DemoDatasetRepository {
  return Reflect.get(repository, "datasetRepository") as DemoDatasetRepository;
}

function datasetStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

describe("Demo dataset repository slice", () => {
  it("owns exactly DatasetRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(DATASET_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoDatasetRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoDatasetModule)).toEqual(["DemoDatasetRepository"]);
    expect("DemoDatasetRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        ts.isClassDeclaration(statement) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual(["ClassDeclaration:DemoDatasetRepository"]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["DatasetRepositoryPort"]);
    expect(slice.members.filter(ts.isMethodDeclaration)
      .filter((method) => !method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))
      .map((method) => method.name.getText(sliceSource)))
      .toEqual(EXPECTED_PUBLIC_METHODS);
    expect(slice.members.filter(ts.isMethodDeclaration)
      .filter((method) => method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))
      .map((method) => method.name.getText(sliceSource)))
      .toEqual(["createDemoExposure", "toDataset", "traceIdForCase"]);

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    const expectedDelegateBodies: Record<(typeof EXPECTED_PUBLIC_METHODS)[number], string> = {
      createDataset: "{ return this.datasetRepository.createDataset(input); }",
      listDatasets: "{ return this.datasetRepository.listDatasets(projectId); }",
      getDatasetDetail: "{ return this.datasetRepository.getDatasetDetail(projectId, datasetId); }",
      archiveDataset: "{ return this.datasetRepository.archiveDataset(projectId, datasetId); }",
      addDatasetItems: "{ return this.datasetRepository.addDatasetItems(input); }",
      importDatasetExamples: "{ return this.datasetRepository.importDatasetExamples(input); }",
      createDatasetRevision: "{ return this.datasetRepository.createDatasetRevision(input); }",
      listDatasetRevisions: "{ return this.datasetRepository.listDatasetRevisions(projectId, sourceDatasetId); }",
      getDatasetRevisionDetail: "{ return this.datasetRepository.getDatasetRevisionDetail(projectId, revisionId); }",
      recordDatasetRevisionContentView: "{ return this.datasetRepository.recordDatasetRevisionContentView(input); }",
      getOrCreateRegressionDatasetRevision: "{ return this.datasetRepository.getOrCreateRegressionDatasetRevision(projectId, actorUserId, criterionVersionId); }",
      removeDatasetItem: "{ return this.datasetRepository.removeDatasetItem(projectId, datasetId, itemId); }"
    };
    for (const name of EXPECTED_PUBLIC_METHODS) {
      const method = facadeMethods.get(name);
      if (!method) throw new Error(`DemoRepository.${name} not found`);
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim())
        .toBe(expectedDelegateBodies[name]);
    }

    const analysis = datasetSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoDatasetRepository"]);
    expect(analysis.allocations).toHaveLength(1);
    expect(analysis.allocations[0]).toMatch(/^repository\.ts:DemoRepository\.constructor:new DemoDatasetRepository\(this\.store, \{/);
    expect(analysis.moduleEdges).toEqual([
      'repository.ts:ImportDeclaration:import { DemoDatasetRepository } from "./repository/demo-datasets.js";'
    ]);
    expect(analysis.references).toEqual([
      "repository.ts:ImportSpecifier:DemoDatasetRepository",
      "repository.ts:NewExpression:DemoDatasetRepository",
      "repository.ts:TypeReference:DemoDatasetRepository",
      "repository/demo-datasets.ts:ClassDeclaration:DemoDatasetRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(datasetSlice(repositoryInstance), "store"))
      .toBe(datasetStore(repositoryInstance));
    expect(Object.keys(Reflect.get(datasetSlice(repositoryInstance), "dependencies") as object))
      .toEqual(EXPECTED_DEPENDENCIES);
  }, 30_000);

  it("preserves lazy facade dispatch across dataset, trace, and golden seams", async () => {
    class CapturingRepository extends DemoRepository {
      readonly calls: string[] = [];

      override async addDatasetItems(input: Parameters<DemoRepository["addDatasetItems"]>[0]) {
        this.calls.push("addDatasetItems");
        return super.addDatasetItems(input);
      }

      override async caseExistsForProject(projectId: string, caseId: string) {
        this.calls.push("caseExistsForProject");
        return super.caseExistsForProject(projectId, caseId);
      }

      override async getDatasetDetail(projectId: string, datasetId: string) {
        this.calls.push("getDatasetDetail");
        return super.getDatasetDetail(projectId, datasetId);
      }

      override async getDatasetRevisionDetail(projectId: string, revisionId: string) {
        this.calls.push("getDatasetRevisionDetail");
        return super.getDatasetRevisionDetail(projectId, revisionId);
      }

      override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
        this.calls.push("importTrace");
        return super.importTrace(...args);
      }

      override async listGoldenSet(...args: Parameters<DemoRepository["listGoldenSet"]>) {
        this.calls.push("listGoldenSet");
        return super.listGoldenSet(...args);
      }
    }

    const repository = new CapturingRepository();
    const dataset = await repository.createDataset({
      projectId: demoProject.id,
      name: "Facade dispatch"
    });
    await repository.importDatasetExamples({
      projectId: demoProject.id,
      datasetId: dataset.id,
      ingestionPurpose: "dataset_example",
      items: [{
        sourceTraceId: "dataset_facade_dispatch",
        input: { question: "Dispatch?" },
        output: { answer: "Preserved." },
        metadata: {}
      }]
    });
    const revision = await repository.createDatasetRevision({
      projectId: demoProject.id,
      datasetId: dataset.id,
      role: "analysis_authoring"
    });
    await repository.getOrCreateRegressionDatasetRevision(demoProject.id);
    await repository.getOrCreateRegressionDatasetRevision(demoProject.id);

    expect(revision.items).toHaveLength(1);
    expect(repository.calls).toEqual(expect.arrayContaining([
      "importTrace",
      "addDatasetItems",
      "caseExistsForProject",
      "getDatasetDetail",
      "listGoldenSet",
      "getDatasetRevisionDetail"
    ]));
  });

  it("keeps tenant predicates and returned immutable revision values isolated", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "dataset_isolation",
      input: { question: "Original" },
      output: { answer: "Original" },
      metadata: { source: "test" }
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const dataset = await repository.createDataset({
      projectId: demoProject.id,
      name: "Isolation"
    });
    const [item] = await repository.addDatasetItems({
      projectId: demoProject.id,
      datasetId: dataset.id,
      items: [{ caseId: imported.caseId, expectedLabel: "pass" }]
    });
    const revision = await repository.createDatasetRevision({
      projectId: demoProject.id,
      datasetId: dataset.id,
      role: "analysis_authoring",
      createdByUserId: "user_author"
    });

    expect(await repository.listDatasets("proj_foreign")).toEqual([]);
    expect(await repository.getDatasetDetail("proj_foreign", dataset.id)).toBeNull();
    expect(await repository.archiveDataset("proj_foreign", dataset.id)).toBe(false);
    await expect(repository.addDatasetItems({
      projectId: "proj_foreign",
      datasetId: dataset.id,
      items: [{ caseId: imported.caseId }]
    })).rejects.toBeInstanceOf(DatasetNotFoundError);
    expect(await repository.removeDatasetItem("proj_foreign", dataset.id, item!.id)).toBe(false);
    expect(await repository.listDatasetRevisions("proj_foreign")).toEqual([]);
    expect(await repository.getDatasetRevisionDetail("proj_foreign", revision.id)).toBeNull();
    await expect(repository.recordDatasetRevisionContentView({
      projectId: "proj_foreign",
      revisionId: revision.id,
      actorUserId: "user_foreign"
    })).rejects.toBeInstanceOf(DatasetRevisionNotFoundError);

    const returnedInput = revision.items[0]!.payloadSnapshot.input as { question: string };
    returnedInput.question = "Mutated";
    revision.items[0]!.referenceProvenance.verdictIds.push("verdict_mutated");
    revision.exposures[0]!.details.mutated = true;
    const reread = await repository.getDatasetRevisionDetail(demoProject.id, revision.id);
    expect(reread?.items[0]?.payloadSnapshot.input).toEqual({ question: "Original" });
    expect(reread?.items[0]?.referenceProvenance.verdictIds).toEqual([]);
    expect(reread?.exposures[0]?.details).toEqual({});

    const readInput = reread!.items[0]!.payloadSnapshot.input as { question: string };
    readInput.question = "Mutated read";
    reread!.items[0]!.referenceProvenance.verdictIds.push("verdict_read_mutated");
    reread!.exposures[0]!.details.readMutated = true;
    const rereadAgain = await repository.getDatasetRevisionDetail(demoProject.id, revision.id);
    expect(rereadAgain?.items[0]?.payloadSnapshot.input).toEqual({ question: "Original" });
    expect(rereadAgain?.items[0]?.referenceProvenance.verdictIds).toEqual([]);
    expect(rereadAgain?.exposures[0]?.details).toEqual({});

    const [listedRevision] = await repository.listDatasetRevisions(demoProject.id);
    listedRevision!.createdByUserId = "user_mutated";
    expect((await repository.listDatasetRevisions(demoProject.id))[0]?.createdByUserId)
      .toBe("user_author");
  });

  it("rolls back all four cross-domain collections in place after a mid-import failure", async () => {
    class FailingDemoRepository extends DemoRepository {
      private addDatasetItemsCalls = 0;

      override async addDatasetItems(input: Parameters<DemoRepository["addDatasetItems"]>[0]) {
        this.addDatasetItemsCalls += 1;
        if (this.addDatasetItemsCalls === 2) throw new Error("injected dataset item failure");
        return super.addDatasetItems(input);
      }
    }

    const repository = new FailingDemoRepository();
    const project = (await repository.listProjects())[0]!;
    const dataset = await repository.createDataset({
      projectId: project.id,
      name: "Atomic import rollback"
    });
    const store = Reflect.get(repository, "store") as DemoRepositoryStore;
    const collectionReferences = {
      traces: store.traces,
      traceSources: store.traceSources,
      caseInputIdentities: store.caseInputIdentities,
      datasetItems: store.datasetItems
    };
    const before = {
      traces: [...store.traces.entries()],
      traceSources: [...store.traceSources.entries()],
      caseInputIdentities: [...store.caseInputIdentities.entries()],
      datasetItems: [...store.datasetItems]
    };
    const input: Parameters<DemoRepository["importDatasetExamples"]>[0] = {
      projectId: project.id,
      datasetId: dataset.id,
      ingestionPurpose: "dataset_example",
      items: [
        { sourceTraceId: "atomic_rollback_1", input: "q1", output: "a1", metadata: {}, expectedLabel: "pass" },
        { sourceTraceId: "atomic_rollback_2", input: "q2", output: "a2", metadata: {}, expectedLabel: "fail" }
      ]
    };

    await expect(repository.importDatasetExamples(input)).rejects.toThrow("injected dataset item failure");
    expect(store.traces).toBe(collectionReferences.traces);
    expect(store.traceSources).toBe(collectionReferences.traceSources);
    expect(store.caseInputIdentities).toBe(collectionReferences.caseInputIdentities);
    expect(store.datasetItems).toBe(collectionReferences.datasetItems);
    expect([...store.traces.entries()]).toEqual(before.traces);
    expect([...store.traceSources.entries()]).toEqual(before.traceSources);
    expect([...store.caseInputIdentities.entries()]).toEqual(before.caseInputIdentities);
    expect(store.datasetItems).toEqual(before.datasetItems);

    const imported = await repository.importDatasetExamples(input);
    expect(imported.items).toHaveLength(2);
    expect(imported.items.every((candidate) => candidate.created)).toBe(true);
    for (const importedItem of imported.items) {
      expect(store.traces.has(importedItem.caseId)).toBe(true);
      expect(store.traceSources.has(importedItem.caseId)).toBe(true);
      expect(store.caseInputIdentities.has(importedItem.caseId)).toBe(true);
      expect(store.datasetItems.some((candidate) => candidate.caseId === importedItem.caseId)).toBe(true);
    }
    expect(store.traces.size).toBe(before.traces.length + 2);
    expect(store.traceSources.size).toBe(before.traceSources.length + 2);
    expect(store.caseInputIdentities.size).toBe(before.caseInputIdentities.length + 2);
    expect(store.datasetItems).toHaveLength(before.datasetItems.length + 2);
    expect((await repository.getDatasetDetail(project.id, dataset.id))?.items).toHaveLength(2);
    expect(store.traces).toBe(collectionReferences.traces);
    expect(store.traceSources).toBe(collectionReferences.traceSources);
    expect(store.caseInputIdentities).toBe(collectionReferences.caseInputIdentities);
    expect(store.datasetItems).toBe(collectionReferences.datasetItems);
  });
});
