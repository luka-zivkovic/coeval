import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject, demoSkill } from "@coeval/db";
import { AssessmentReceiptSchema } from "@coeval/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { contentDigest } from "../src/lib/assessment-receipt.js";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import * as demoEvaluationModule from "../src/repository/demo-evaluation.js";
import { DemoEvaluationRepository } from "../src/repository/demo-evaluation.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
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
  "claimEvalRunItemRecovery",
  "rearmEvalRunItemDeliveryDeadline",
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
  "getOrFreezeAssessmentReceipt",
  "getAssessmentReceiptArtifactByReceiptId",
  "listAssessmentReceiptArtifacts",
  "compareAssessmentReceiptCopy",
  "createAssessmentReceiptCorrection",
  "deleteUndispatchedEvalRun"
] as const;

const EXPECTED_DEPENDENCIES = [
  "armEvalRunItemDeliveryDeadline",
  "createConvergenceEvalRun",
  "createEvalRun",
  "getEvalRun",
  "getEvalRunDetail",
  "getOrFreezeAssessmentReceipt",
  "getSkillVersion",
  "listPendingEvalRunItems"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const EVALUATION_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-evaluation.ts"
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

function evaluationSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(EVALUATION_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo evaluation repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo evaluation module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoEvaluationRepository");
  if (!classExport) throw new Error("DemoEvaluationRepository export was not resolved");
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
          path.resolve(resolution.resolvedFileName) === path.resolve(EVALUATION_REPOSITORY_PATH) &&
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
        node.text === "DemoEvaluationRepository" &&
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

function evaluationSlice(repository: DemoRepository): DemoEvaluationRepository {
  return Reflect.get(repository, "evaluationRepository") as DemoEvaluationRepository;
}

function repositoryStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

describe("Demo evaluation and assessment-receipt repository slice", () => {
  it("owns both coupled ports behind stable facade delegates", () => {
    const sliceSource = sourceFile(EVALUATION_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoEvaluationRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoEvaluationModule)).toEqual(["DemoEvaluationRepository"]);
    expect("DemoEvaluationRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        ts.isClassDeclaration(statement) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual(["ClassDeclaration:DemoEvaluationRepository"]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["EvalRunRepositoryPort", "AssessmentReceiptRepositoryPort"]);
    expect(slice.members.filter(ts.isMethodDeclaration)
      .filter((method) => !method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))
      .map((method) => method.name.getText(sliceSource)))
      .toEqual(EXPECTED_PUBLIC_METHODS);
    expect(slice.members.filter(ts.isMethodDeclaration)
      .filter((method) => method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))
      .map((method) => method.name.getText(sliceSource)))
      .toEqual([
        "cloneAssessmentReceiptArtifact",
        "cloneAssessmentReceiptComparison",
        "isTerminalEvalRun",
        "materializeDemoRootArtifact",
        "mintDemoRootArtifact",
        "isRunFinished",
        "maybeFinishRun"
      ]);

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    for (const name of EXPECTED_PUBLIC_METHODS) {
      const method = facadeMethods.get(name);
      if (!method?.body) throw new Error(`DemoRepository.${name} not found`);
      const args = method.parameters.map((parameter) => parameter.name.getText(repositorySource));
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body, repositorySource)
        .replace(/\s+/g, " ")
        .trim())
        .toBe(`{ return this.evaluationRepository.${name}(${args.join(", ")}); }`);
    }

    const analysis = evaluationSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoEvaluationRepository"]);
    expect(analysis.allocations).toHaveLength(1);
    expect(analysis.allocations[0]).toMatch(
      /^repository\.ts:DemoRepository\.constructor:new DemoEvaluationRepository\(this\.store, \{/
    );
    expect(analysis.moduleEdges).toEqual([
      'repository.ts:ImportDeclaration:import { DemoEvaluationRepository } from "./repository/demo-evaluation.js";'
    ]);
    expect(analysis.references).toEqual([
      "repository.ts:ImportSpecifier:DemoEvaluationRepository",
      "repository.ts:NewExpression:DemoEvaluationRepository",
      "repository.ts:TypeReference:DemoEvaluationRepository",
      "repository/demo-evaluation.ts:ClassDeclaration:DemoEvaluationRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(evaluationSlice(repositoryInstance), "store"))
      .toBe(repositoryStore(repositoryInstance));
    expect(Object.keys(Reflect.get(evaluationSlice(repositoryInstance), "dependencies") as object))
      .toEqual(EXPECTED_DEPENDENCIES);
  }, 30_000);

  it("preserves lazy facade dispatch across run and receipt composition", async () => {
    class CapturingRepository extends DemoRepository {
      readonly calls: string[] = [];

      override async armEvalRunItemDeliveryDeadline(
        ...args: Parameters<DemoRepository["armEvalRunItemDeliveryDeadline"]>
      ) {
        this.calls.push("armEvalRunItemDeliveryDeadline");
        return super.armEvalRunItemDeliveryDeadline(...args);
      }

      override async createConvergenceEvalRun(...args: Parameters<DemoRepository["createConvergenceEvalRun"]>) {
        this.calls.push("createConvergenceEvalRun");
        return super.createConvergenceEvalRun(...args);
      }

      override async createEvalRun(...args: Parameters<DemoRepository["createEvalRun"]>) {
        this.calls.push("createEvalRun");
        return super.createEvalRun(...args);
      }

      override async getEvalRun(...args: Parameters<DemoRepository["getEvalRun"]>) {
        this.calls.push("getEvalRun");
        return super.getEvalRun(...args);
      }

      override async getEvalRunDetail(...args: Parameters<DemoRepository["getEvalRunDetail"]>) {
        this.calls.push("getEvalRunDetail");
        return super.getEvalRunDetail(...args);
      }

      override async getOrFreezeAssessmentReceipt(
        ...args: Parameters<DemoRepository["getOrFreezeAssessmentReceipt"]>
      ) {
        this.calls.push("getOrFreezeAssessmentReceipt");
        return super.getOrFreezeAssessmentReceipt(...args);
      }

      override async getSkillVersion(...args: Parameters<DemoRepository["getSkillVersion"]>) {
        this.calls.push("getSkillVersion");
        return super.getSkillVersion(...args);
      }

      override async listPendingEvalRunItems(...args: Parameters<DemoRepository["listPendingEvalRunItems"]>) {
        this.calls.push("listPendingEvalRunItems");
        return super.listPendingEvalRunItems(...args);
      }
    }

    const repository = new CapturingRepository();
    const convergenceInput = {
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      caseId: "case_evaluation_dispatch"
    };
    const first = await repository.createConvergenceEvalRun(convergenceInput);
    const firstRun = repositoryStore(repository).evalRuns.find((run) => run.id === first.run.id)!;
    firstRun.status = "failed";
    repository.calls.length = 0;
    const retried = await repository.createConvergenceEvalRun(convergenceInput);
    expect(repository.calls).toEqual([
      "createConvergenceEvalRun",
      "getEvalRunDetail",
      "getEvalRun",
      "createConvergenceEvalRun",
      "createEvalRun"
    ]);

    const dispatchToken = "dispatch-token";
    await repository.claimEvalRunDispatch({
      projectId: demoProject.id,
      evalRunId: retried.run.id,
      dispatchToken
    });
    repository.calls.length = 0;
    await repository.markEvalRunDispatched({
      projectId: demoProject.id,
      evalRunId: retried.run.id,
      dispatchToken
    });
    expect(repository.calls).toEqual(["armEvalRunItemDeliveryDeadline"]);

    repository.calls.length = 0;
    await repository.listPendingEvalRunItemDispatches(demoProject.id, retried.run.id);
    expect(repository.calls).toEqual(["listPendingEvalRunItems"]);

    repository.calls.length = 0;
    const terminal = await repository.createEvalRun({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      trigger: "release_evidence",
      items: [{
        caseId: "case_evaluation_receipt",
        clientItemId: "evaluation-receipt-item",
        contentDigest: contentDigest({ question: "Persist?" }, { answer: "Yes." }),
        status: "completed",
        verdictId: "verdict_evaluation_receipt",
        resultLabel: "pass",
        cached: true
      }]
    });
    expect(repository.calls).toEqual(["createEvalRun", "getSkillVersion"]);

    const store = repositoryStore(repository);
    store.assessmentReceiptArtifacts.splice(0);
    repository.calls.length = 0;
    const frozen = await repository.getOrFreezeAssessmentReceipt(demoProject.id, terminal.id);
    expect(repository.calls).toEqual([
      "getOrFreezeAssessmentReceipt",
      "getSkillVersion",
      "getEvalRunDetail",
      "getEvalRun"
    ]);
    expect(frozen).not.toBeNull();
    expect(store.assessmentReceiptArtifacts).toHaveLength(1);
    expect(frozen).not.toBe(store.assessmentReceiptArtifacts[0]);
    expect(frozen!.canonicalBytes).not.toBe(store.assessmentReceiptArtifacts[0]!.canonicalBytes);
    expect(frozen!.canonicalBytes.equals(store.assessmentReceiptArtifacts[0]!.canonicalBytes)).toBe(true);

    repository.calls.length = 0;
    const comparison = await repository.compareAssessmentReceiptCopy({
      projectId: demoProject.id,
      evalRunId: terminal.id,
      consumerCanonicalBytes: frozen!.canonicalBytes
    });
    expect(comparison.comparisonStatus).toBe("match");
    expect(repository.calls).toEqual(["getOrFreezeAssessmentReceipt"]);
  });

  it("mints terminal receipts with item completion and rolls terminalization back on mint failure", async () => {
    class ReceiptFailureRepository extends DemoRepository {
      rejectSkillLookup = false;

      override async getSkillVersion(...args: Parameters<DemoRepository["getSkillVersion"]>) {
        if (this.rejectSkillLookup) return null;
        return super.getSkillVersion(...args);
      }
    }

    const repository = new ReceiptFailureRepository();
    const run = await repository.createEvalRun({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      trigger: "release_evidence",
      items: [{
        caseId: "case_evaluation_terminal_mint",
        clientItemId: "evaluation-terminal-mint-item",
        contentDigest: contentDigest({ question: "Mint atomically?" }, { answer: "Yes." })
      }]
    });
    await repository.markEvalRunRunning(demoProject.id, run.id);

    const store = repositoryStore(repository);
    const storedRun = store.evalRuns.find((candidate) => candidate.id === run.id)!;
    const storedItem = store.evalRunItems.find((candidate) => candidate.evalRunId === run.id)!;
    repository.rejectSkillLookup = true;
    await expect(repository.completeEvalRunItem({
      projectId: demoProject.id,
      evalRunId: run.id,
      evalRunItemId: storedItem.id,
      verdictId: "verdict_evaluation_terminal_mint",
      resultLabel: "pass"
    })).rejects.toThrow("Eval run skill version not found");
    expect(store.evalRuns.find((candidate) => candidate.id === run.id)).toBe(storedRun);
    expect(store.evalRunItems.find((candidate) => candidate.id === storedItem.id)).toBe(storedItem);
    expect(storedRun).toMatchObject({
      status: "running",
      completedItems: 0,
      failedItems: 0,
      finishedAt: null
    });
    expect(storedItem).toMatchObject({
      status: "pending",
      verdictId: null,
      resultLabel: null,
      finishedAt: null
    });
    expect(store.assessmentReceiptArtifacts).toEqual([]);

    repository.rejectSkillLookup = false;
    await expect(repository.completeEvalRunItem({
      projectId: demoProject.id,
      evalRunId: run.id,
      evalRunItemId: storedItem.id,
      verdictId: "verdict_evaluation_terminal_mint",
      resultLabel: "pass"
    })).resolves.toEqual({ runFinished: true });
    expect(storedRun).toMatchObject({ status: "completed", completedItems: 1, failedItems: 0 });
    expect(storedItem).toMatchObject({ status: "completed", verdictId: "verdict_evaluation_terminal_mint" });
    const completedArtifact = store.assessmentReceiptArtifacts.find(
      (artifact) => artifact.evalRunId === run.id
    );
    expect(completedArtifact).toMatchObject({ sourceKind: "terminal_mint", artifactRevision: 1 });
    expect(AssessmentReceiptSchema.parse(JSON.parse(completedArtifact!.canonicalBytes.toString("utf8"))))
      .toMatchObject({
        status: "complete",
        run: { status: "completed", completedItems: 1, failedItems: 0 },
        items: [expect.objectContaining({ status: "completed", judgedLabel: "pass" })]
      });

    const failedRun = await repository.createEvalRun({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      trigger: "release_evidence",
      items: [{
        caseId: "case_evaluation_terminal_failure",
        clientItemId: "evaluation-terminal-failure-item",
        contentDigest: contentDigest({ question: "Fail honestly?" }, { answer: "Yes." })
      }]
    });
    await repository.markEvalRunRunning(demoProject.id, failedRun.id);
    await expect(repository.failEvalRunItem({
      projectId: demoProject.id,
      evalRunId: failedRun.id,
      evalRunItemId: failedRun.items[0]!.id,
      error: "provider exhausted retries"
    })).resolves.toEqual({ runFinished: true });
    const failedArtifact = store.assessmentReceiptArtifacts.find(
      (artifact) => artifact.evalRunId === failedRun.id
    );
    expect(failedArtifact).toMatchObject({ sourceKind: "terminal_mint", artifactRevision: 1 });
    expect(AssessmentReceiptSchema.parse(JSON.parse(failedArtifact!.canonicalBytes.toString("utf8"))))
      .toMatchObject({
        status: "incomplete",
        run: { status: "failed", completedItems: 0, failedItems: 1 },
        items: [expect.objectContaining({ status: "failed", error: "provider exhausted retries" })]
      });
  });
});
