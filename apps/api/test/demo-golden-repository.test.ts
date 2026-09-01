import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoExceptions, demoProject, demoSkill } from "@coeval/db";
import type { GoldenSetEntry } from "@coeval/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import {
  DatasetRevisionConflictError,
  DemoRepository,
  GoldenSetEntryAlreadyRetiredError,
  GoldenSetLabelConflictError
} from "../src/repository.js";
import * as demoGoldenRepositoryModule from "../src/repository/demo-golden.js";
import { DemoGoldenEvidenceRepository } from "../src/repository/demo-golden.js";
import type { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
  "listGoldenSet",
  "getSkillFormatExamples",
  "getGoldenSetHealth",
  "getExceptionDetail",
  "getCaseDetail",
  "promoteExceptionToGoldenSet",
  "retireGoldenSetEntry",
  "getGoldenSetTraces"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-repository.ts");
const GOLDEN_REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-golden.ts");

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

function goldenSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const goldenSource = program.getSourceFile(GOLDEN_REPOSITORY_PATH);
  if (!goldenSource) throw new Error("Demo golden repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(goldenSource);
  if (!moduleSymbol) throw new Error("Demo golden repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoGoldenEvidenceRepository");
  if (!classExport) throw new Error("DemoGoldenEvidenceRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(GOLDEN_REPOSITORY_PATH)) {
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
        node.text === "DemoGoldenEvidenceRepository" &&
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

describe("Demo golden evidence repository slice", () => {
  it("owns exactly the GoldenEvidenceRepositoryPort methods behind the stable facade", () => {
    const goldenSource = sourceFile(GOLDEN_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const goldenRepository = classDeclaration(goldenSource, "DemoGoldenEvidenceRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoGoldenRepositoryModule)).toEqual(["DemoGoldenEvidenceRepository"]);
    expect("DemoGoldenEvidenceRepository" in repositoryModule).toBe(false);
    expect(goldenSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name
          ? statement.name.getText(goldenSource)
          : "<anonymous>"
      }`))
      .toEqual([
        "InterfaceDeclaration:DemoGoldenEvidenceRepositoryDependencies",
        "ClassDeclaration:DemoGoldenEvidenceRepository"
      ]);
    expect(goldenRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(goldenSource))
    )).toEqual(["GoldenEvidenceRepositoryPort"]);
    expect(goldenRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(goldenSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      "MethodDeclaration:listGoldenSet",
      "MethodDeclaration:getSkillFormatExamples",
      "MethodDeclaration:getGoldenSetHealth",
      "MethodDeclaration:getExceptionDetail",
      "MethodDeclaration:getCaseDetail",
      "MethodDeclaration:buildDemoCaseDetail",
      "MethodDeclaration:promoteExceptionToGoldenSet",
      "MethodDeclaration:retireGoldenSetEntry",
      "MethodDeclaration:getGoldenSetTraces"
    ]);
    expect(goldenRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, goldenSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([[
      "private readonly store: DemoRepositoryStore",
      "private readonly dependencies: DemoGoldenEvidenceRepositoryDependencies"
    ]]);

    const expectedDelegates = new Map<string, string>([
      ["listGoldenSet", "{ return this.goldenEvidenceRepository.listGoldenSet(projectId, criterionVersionId); }"],
      ["getSkillFormatExamples", "{ return this.goldenEvidenceRepository.getSkillFormatExamples(projectId, cap, criterionVersionId); }"],
      ["getGoldenSetHealth", "{ return this.goldenEvidenceRepository.getGoldenSetHealth(projectId, criterionVersionId); }"],
      ["getExceptionDetail", "{ return this.goldenEvidenceRepository.getExceptionDetail(projectId, caseId, skillVersionId); }"],
      ["getCaseDetail", "{ return this.goldenEvidenceRepository.getCaseDetail(projectId, caseId, skillVersionId); }"],
      ["promoteExceptionToGoldenSet", "{ return this.goldenEvidenceRepository.promoteExceptionToGoldenSet(input); }"],
      ["retireGoldenSetEntry", "{ return this.goldenEvidenceRepository.retireGoldenSetEntry(input); }"],
      ["getGoldenSetTraces", "{ return this.goldenEvidenceRepository.getGoldenSetTraces(projectId, criterionVersionId); }"]
    ]);
    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_PUBLIC_METHODS.includes(
        method.name.getText(repositorySource) as typeof EXPECTED_PUBLIC_METHODS[number]
      ));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_PUBLIC_METHODS);
    for (const method of facadeMethods) {
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource).replace(/\s+/g, " ").trim())
        .toBe(expectedDelegates.get(method.name.getText(repositorySource)));
    }
  });

  it("constructs one slice with the exact shared store and cross-port callbacks", () => {
    const analysis = goldenSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoGoldenEvidenceRepository"]);
    expect(analysis.allocations).toEqual([
      "repository/demo-composition.ts:createDemoRepositoryComposition:new DemoGoldenEvidenceRepository(store, { buildGoldenSetHealthSummary, getCaseDetail: (projectId, caseId, skillVersionId) => facade.getCaseDetail(projectId, caseId, skillVersionId), getDemoActorName: (actorUserId) => DEMO_ACTOR_NAMES.get(actorUserId), getOrCreateRegressionDatasetRevision: (projectId, actorUserId, criterionVersionId) => facade.getOrCreateRegressionDatasetRevision(projectId, actorUserId, criterionVersionId), listGoldenSet: (projectId, criterionVersionId) => facade.listGoldenSet(projectId, criterionVersionId), resolveGoldenCriterionVersion: (projectId, requested) => resolveGoldenCriterionVersion(facade, store, projectId, requested), syntheticTraceForBuiltinCase })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoGoldenEvidenceRepository } from "./demo-golden.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:"./demo-golden.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-composition.ts:ImportSpecifier:DemoGoldenEvidenceRepository",
      "repository/demo-composition.ts:NewExpression:DemoGoldenEvidenceRepository",
      "repository/demo-composition.ts:TypeReference:DemoGoldenEvidenceRepository",
      "repository/demo-golden.ts:ClassDeclaration:DemoGoldenEvidenceRepository"
    ]);

    const repository = new DemoRepository();
    const slice = Reflect.get(repository, "goldenEvidenceRepository") as DemoGoldenEvidenceRepository;
    expect(slice).toBeInstanceOf(DemoGoldenEvidenceRepository);
    expect(Object.keys(slice)).toEqual(["store", "dependencies"]);
    expect(Reflect.get(slice, "store")).toBe(Reflect.get(repository, "store"));
    expect(Object.keys(Reflect.get(slice, "dependencies") as object)).toEqual([
      "buildGoldenSetHealthSummary",
      "getCaseDetail",
      "getDemoActorName",
      "getOrCreateRegressionDatasetRevision",
      "listGoldenSet",
      "resolveGoldenCriterionVersion",
      "syntheticTraceForBuiltinCase"
    ]);
  }, 30_000);

  it("preserves facade polymorphism for same-port composite reads", async () => {
    const entry: GoldenSetEntry = {
      id: "gold_dispatch_probe",
      caseId: "case_dispatch_probe",
      traceId: "trace_dispatch_probe",
      agreedLabel: "fail",
      reason: "Dispatch probe",
      promotedBy: "Reviewer",
      promotedAt: demoProject.updatedAt,
      sourceSkillVersionId: demoSkill.currentVersion.id,
      criterionVersionId: demoSkill.currentVersion.criterionVersionId
    };
    class DispatchProbeRepository extends DemoRepository {
      listCalls = 0;
      detailCalls = 0;

      override async listGoldenSet(): Promise<GoldenSetEntry[]> {
        this.listCalls += 1;
        return [entry];
      }

      override async getCaseDetail(
        projectId: string,
        caseId: string,
        skillVersionId?: string | undefined
      ) {
        this.detailCalls += 1;
        return super.getCaseDetail(projectId, caseId, skillVersionId);
      }
    }

    const repository = new DispatchProbeRepository();
    const store = Reflect.get(repository, "store") as DemoRepositoryStore;
    store.traces.set(entry.caseId, {
      id: entry.traceId,
      input: { prompt: "probe" },
      output: { response: "probe" },
      metadata: { source: "test" }
    });

    await expect(repository.getSkillFormatExamples(demoProject.id, 1)).resolves.toMatchObject([
      { id: entry.id, input: { prompt: "probe" }, output: { response: "probe" } }
    ]);
    await expect(repository.getGoldenSetHealth(demoProject.id)).resolves.toMatchObject({ totalActive: 1 });
    await expect(repository.getExceptionDetail(demoProject.id, entry.caseId, demoSkill.currentVersion.id))
      .resolves.toMatchObject({ exception: { id: entry.caseId } });
    await expect(repository.getGoldenSetTraces(demoProject.id)).resolves.toEqual(new Map([
      [entry.caseId, store.traces.get(entry.caseId)!]
    ]));
    expect(repository.listCalls).toBe(5);
    expect(repository.detailCalls).toBe(2);
  });

  it("preserves promotion, retirement, version scoping, and shared revision visibility", async () => {
    const repository = new DemoRepository();
    const store = Reflect.get(repository, "store") as DemoRepositoryStore;
    const exception = demoExceptions.find((candidate) => candidate.verdict !== "ambiguous");
    if (!exception || exception.verdict === "ambiguous") throw new Error("Non-ambiguous demo exception not found");

    await expect(repository.listGoldenSet(demoProject.id, "criterion_version_missing"))
      .rejects.toBeInstanceOf(DatasetRevisionConflictError);
    const promoted = await repository.promoteExceptionToGoldenSet({
      projectId: demoProject.id,
      caseId: exception.id,
      agreedLabel: exception.verdict,
      reason: "Reviewed for direct slice coverage",
      actorUserId: "user_maya",
      actorName: "Maya",
      skillVersionId: demoSkill.currentVersion.id
    });
    expect(store.promotedGoldenSet[0]).toBe(promoted);
    expect(store.verdicts.at(-1)).toMatchObject({
      caseId: exception.id,
      source: "human",
      actorUserId: "user_maya"
    });
    expect(store.regressionDatasetRevisionId).not.toBeNull();
    const promotedRevisionId = store.regressionDatasetRevisionId;
    const promotedRevision = store.datasetRevisions.find((revision) => revision.id === promotedRevisionId);
    expect(promotedRevision).toBeDefined();
    await expect(repository.listGoldenSet(demoProject.id)).resolves.toContain(promoted);

    await repository.retireGoldenSetEntry({
      projectId: demoProject.id,
      entryId: promoted.id,
      actorUserId: "user_maya",
      reason: "No longer representative"
    });
    await expect(repository.listGoldenSet(demoProject.id)).resolves.not.toContain(promoted);
    expect(store.regressionDatasetRevisionId).not.toBe(promotedRevisionId);
    expect(store.datasetRevisions.find((revision) => revision.id === store.regressionDatasetRevisionId))
      .toMatchObject({ revisionNumber: promotedRevision!.revisionNumber + 1 });
    await expect(repository.retireGoldenSetEntry({
      projectId: demoProject.id,
      entryId: promoted.id,
      actorUserId: "user_maya"
    })).rejects.toBeInstanceOf(GoldenSetEntryAlreadyRetiredError);
  });

  it("rejects promotion labels that contradict recorded human truth", async () => {
    const repository = new DemoRepository();
    const exception = demoExceptions.find((candidate) => candidate.verdict === "fail");
    if (!exception) throw new Error("Failing demo exception not found");
    await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: exception.id,
      source: "human",
      actorUserId: "user_maya",
      skillVersionId: demoSkill.currentVersion.id,
      payload: {
        kind: "categorical",
        choice: "pass",
        choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
        rationale: "Human review overturned the evaluator."
      }
    });
    const store = Reflect.get(repository, "store") as DemoRepositoryStore;
    const promotedBefore = store.promotedGoldenSet.length;
    const verdictsBefore = store.verdicts.length;

    await expect(repository.promoteExceptionToGoldenSet({
      projectId: demoProject.id,
      caseId: exception.id,
      agreedLabel: "fail",
      reason: "Stale evaluator label",
      actorUserId: "user_maya",
      skillVersionId: demoSkill.currentVersion.id
    })).rejects.toBeInstanceOf(GoldenSetLabelConflictError);
    expect(store.promotedGoldenSet).toHaveLength(promotedBefore);
    expect(store.verdicts).toHaveLength(verdictsBefore);
  });
});
