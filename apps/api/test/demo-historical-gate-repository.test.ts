import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject, demoSkill } from "@coeval/db";
import type { EvalRun, GateCheckDetail } from "@coeval/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import * as demoHistoricalGateModule from "../src/repository/demo-historical-gates.js";
import { DemoHistoricalGateEvidenceRepository } from "../src/repository/demo-historical-gates.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
  "createGateCheck",
  "getGateCheckDetail",
  "listGateChecks"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-repository.ts");
const HISTORICAL_GATE_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-historical-gates.ts"
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

function historicalGateSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(HISTORICAL_GATE_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo historical-gate repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo historical-gate module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoHistoricalGateEvidenceRepository");
  if (!classExport) throw new Error("DemoHistoricalGateEvidenceRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(HISTORICAL_GATE_REPOSITORY_PATH)) {
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
        node.text === "DemoHistoricalGateEvidenceRepository" &&
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

function historicalGateSlice(repository: DemoRepository): DemoHistoricalGateEvidenceRepository {
  return Reflect.get(repository, "historicalGateEvidenceRepository") as DemoHistoricalGateEvidenceRepository;
}

function historicalGateStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

function gateInput(evalRunId: string): Parameters<DemoRepository["createGateCheck"]>[0] {
  return {
    projectId: demoProject.id,
    skillVersionId: demoSkill.currentVersion.id,
    evalRunId,
    label: "Historical compatibility check",
    metadata: { source: "legacy-client" },
    maxDisagreements: 0,
    items: [
      {
        goldenEntryId: "golden_completed",
        goldenCaseId: "case_completed",
        caseKey: "trace_completed",
        candidateCaseId: "case_completed",
        expectedLabel: "pass"
      },
      {
        goldenEntryId: "golden_failed",
        goldenCaseId: "case_failed",
        caseKey: "trace_failed",
        candidateCaseId: "case_failed",
        expectedLabel: "fail"
      },
      {
        goldenEntryId: "golden_pending",
        goldenCaseId: "case_pending",
        caseKey: "trace_pending",
        candidateCaseId: "case_pending",
        expectedLabel: "pass"
      }
    ]
  };
}

describe("Demo historical gate-evidence repository slice", () => {
  it("owns exactly HistoricalGateEvidenceRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(HISTORICAL_GATE_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoHistoricalGateEvidenceRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoHistoricalGateModule)).toEqual(["DemoHistoricalGateEvidenceRepository"]);
    expect("DemoHistoricalGateEvidenceRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        ts.isClassDeclaration(statement) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual(["ClassDeclaration:DemoHistoricalGateEvidenceRepository"]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["HistoricalGateEvidenceRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_PUBLIC_METHODS.map((name) => `MethodDeclaration:${name}`),
      "MethodDeclaration:projectGateCheck"
    ]);
    const projectGateCheck = slice.members.find((member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText(sliceSource) === "projectGateCheck"
    );
    expect(projectGateCheck?.modifiers?.map((modifier) => ts.SyntaxKind[modifier.kind]))
      .toEqual(["PrivateKeyword"]);

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    const expectedDelegateBodies: Record<(typeof EXPECTED_PUBLIC_METHODS)[number], string> = {
      createGateCheck: "{ return this.historicalGateEvidenceRepository.createGateCheck(input); }",
      getGateCheckDetail: "{ return this.historicalGateEvidenceRepository.getGateCheckDetail(projectId, gateCheckId); }",
      listGateChecks: "{ return this.historicalGateEvidenceRepository.listGateChecks(projectId, opts); }"
    };
    for (const name of EXPECTED_PUBLIC_METHODS) {
      const method = facadeMethods.get(name);
      if (!method) throw new Error(`DemoRepository.${name} not found`);
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim())
        .toBe(expectedDelegateBodies[name]);
    }

    const analysis = historicalGateSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoHistoricalGateEvidenceRepository"]);
    expect(analysis.allocations).toEqual([
      "repository/demo-composition.ts:createDemoRepositoryComposition:new DemoHistoricalGateEvidenceRepository(store, { getEvalRun: (projectId, evalRunId) => facade.getEvalRun(projectId, evalRunId), getEvalRunDetail: (projectId, evalRunId) => facade.getEvalRunDetail(projectId, evalRunId), getGateCheckDetail: (projectId, gateCheckId) => facade.getGateCheckDetail(projectId, gateCheckId) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoHistoricalGateEvidenceRepository } from "./demo-historical-gates.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:"./demo-historical-gates.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-composition.ts:ImportSpecifier:DemoHistoricalGateEvidenceRepository",
      "repository/demo-composition.ts:NewExpression:DemoHistoricalGateEvidenceRepository",
      "repository/demo-composition.ts:TypeReference:DemoHistoricalGateEvidenceRepository",
      "repository/demo-historical-gates.ts:ClassDeclaration:DemoHistoricalGateEvidenceRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(historicalGateSlice(repositoryInstance), "store"))
      .toBe(historicalGateStore(repositoryInstance));
    expect(Object.keys(Reflect.get(historicalGateSlice(repositoryInstance), "dependencies") as object).sort())
      .toEqual(["getEvalRun", "getEvalRunDetail", "getGateCheckDetail"]);
  }, 30_000);

  it("preserves facade polymorphism, item projection, project isolation, and vanished-row failure", async () => {
    class CapturingRepository extends DemoRepository {
      readonly evalRunCalls: string[] = [];
      readonly evalRunDetailCalls: string[] = [];
      readonly gateDetailCalls: string[] = [];
      gateDetailMissing = false;

      override async getEvalRun(projectId: string, evalRunId: string) {
        this.evalRunCalls.push(`${projectId}:${evalRunId}`);
        return super.getEvalRun(projectId, evalRunId);
      }

      override async getEvalRunDetail(projectId: string, evalRunId: string) {
        this.evalRunDetailCalls.push(`${projectId}:${evalRunId}`);
        return super.getEvalRunDetail(projectId, evalRunId);
      }

      override async getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null> {
        this.gateDetailCalls.push(`${projectId}:${gateCheckId}`);
        return this.gateDetailMissing ? null : super.getGateCheckDetail(projectId, gateCheckId);
      }
    }

    const repository = new CapturingRepository();
    const store = historicalGateStore(repository);
    const run = await repository.createEvalRun({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      trigger: "product_gate",
      items: [
        { caseId: "case_completed", status: "completed", resultLabel: "pass", expectedLabel: "pass", cached: true },
        { caseId: "case_failed", expectedLabel: "fail" },
        { caseId: "case_pending", expectedLabel: "pass" }
      ]
    });
    const storedRun = store.evalRuns.find((candidate) => candidate.id === run.id)!;
    const failedItem = store.evalRunItems.find((candidate) => candidate.caseId === "case_failed")!;
    failedItem.status = "failed";
    failedItem.error = "provider unavailable";
    failedItem.finishedAt = "2020-01-03T00:00:00.000Z";
    Object.assign(storedRun, {
      status: "completed",
      completedItems: 1,
      failedItems: 1,
      agreedItems: 1,
      finishedAt: "2020-01-04T00:00:00.000Z"
    } satisfies Partial<EvalRun>);

    const input = gateInput(run.id);
    const created = await repository.createGateCheck(input);
    const stored = store.gateChecks[0]!;
    expect(repository.gateDetailCalls).toEqual([`${demoProject.id}:${stored.id}`]);
    expect(repository.evalRunDetailCalls).toEqual([`${demoProject.id}:${run.id}`]);
    expect(repository.evalRunCalls).toContain(`${demoProject.id}:${run.id}`);
    expect(created).toMatchObject({
      id: expect.stringMatching(/^gate_/),
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      evalRunId: run.id,
      label: input.label,
      metadata: input.metadata,
      maxDisagreements: 0,
      status: "error",
      totalCandidates: 3,
      judgedCandidates: 1,
      erroredCandidates: 1,
      disagreements: 0,
      createdAt: stored.createdAt,
      finishedAt: "2020-01-04T00:00:00.000Z"
    });
    expect(created.metadata).toBe(input.metadata);
    expect(created.items).toEqual([
      {
        id: expect.stringMatching(/^gati_/),
        gateCheckId: stored.id,
        goldenEntryId: "golden_completed",
        goldenCaseId: "case_completed",
        caseKey: "trace_completed",
        candidateCaseId: "case_completed",
        expectedLabel: "pass",
        status: "completed",
        judgedLabel: "pass",
        agreement: true,
        cached: true,
        error: null,
        createdAt: stored.createdAt
      },
      {
        id: expect.stringMatching(/^gati_/),
        gateCheckId: stored.id,
        goldenEntryId: "golden_failed",
        goldenCaseId: "case_failed",
        caseKey: "trace_failed",
        candidateCaseId: "case_failed",
        expectedLabel: "fail",
        status: "failed",
        judgedLabel: null,
        agreement: null,
        cached: false,
        error: "provider unavailable",
        createdAt: stored.createdAt
      },
      {
        id: expect.stringMatching(/^gati_/),
        gateCheckId: stored.id,
        goldenEntryId: "golden_pending",
        goldenCaseId: "case_pending",
        caseKey: "trace_pending",
        candidateCaseId: "case_pending",
        expectedLabel: "pass",
        status: "pending",
        judgedLabel: null,
        agreement: null,
        cached: false,
        error: null,
        createdAt: stored.createdAt
      }
    ]);
    expect(created.items[0]).not.toBe(stored.items[0]);
    expect(await repository.getGateCheckDetail(demoProject.id, "gate_unknown")).toBeNull();
    expect(await repository.getGateCheckDetail("project_other", stored.id)).toBeNull();
    stored.evalRunId = "run_missing";
    expect(await repository.getGateCheckDetail(demoProject.id, stored.id)).toBeNull();
    stored.evalRunId = run.id;

    repository.gateDetailMissing = true;
    await expect(repository.createGateCheck(gateInput(run.id)))
      .rejects.toThrow(/^Gate check vanished after create: gate_/);
    expect(store.gateChecks).toHaveLength(2);
  });

  it("preserves nullable defaults and the historical disagreement threshold", async () => {
    const repository = new DemoRepository();
    const run = await repository.createEvalRun({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      trigger: "product_gate",
      items: [
        { caseId: "case_completed", status: "completed", resultLabel: "pass", expectedLabel: "pass" },
        { caseId: "case_failed", status: "completed", resultLabel: "pass", expectedLabel: "fail" }
      ]
    });
    const items = gateInput(run.id).items.slice(0, 2);

    const blocked = await repository.createGateCheck({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      evalRunId: run.id,
      maxDisagreements: 0,
      items
    });
    expect(blocked).toMatchObject({
      label: null,
      maxDisagreements: 0,
      status: "blocked",
      disagreements: 1
    });
    expect(blocked.metadata).toEqual({});

    const passed = await repository.createGateCheck({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      evalRunId: run.id,
      maxDisagreements: 1,
      items
    });
    expect(passed).toMatchObject({
      label: null,
      maxDisagreements: 1,
      status: "passed",
      disagreements: 1
    });
    expect(passed.metadata).toEqual({});
  });

  it("preserves historical decision projection, newest-first reads, filtering, limits, and default 50", async () => {
    const repository = new DemoRepository();
    const store = historicalGateStore(repository);
    const run = await repository.createEvalRun({
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id,
      trigger: "product_gate",
      items: [{ caseId: "case_completed", status: "completed", resultLabel: "pass", expectedLabel: "pass" }]
    });
    const created = await repository.createGateCheck({
      ...gateInput(run.id),
      items: [gateInput(run.id).items[0]!]
    });
    const baseline = store.gateChecks[0]!;
    baseline.createdAt = "2020-01-01T00:00:00.000Z";
    store.gateChecks.push(
      { ...baseline, id: "gate_older", createdAt: "2019-01-01T00:00:00.000Z" },
      { ...baseline, id: "gate_newer", createdAt: "2021-01-01T00:00:00.000Z" },
      { ...baseline, id: "gate_missing_run", evalRunId: "run_missing", createdAt: "2022-01-01T00:00:00.000Z" },
      { ...baseline, id: "gate_foreign", projectId: "project_other", createdAt: "2023-01-01T00:00:00.000Z" }
    );

    const listed = await repository.listGateChecks(demoProject.id, { limit: 2 });
    expect(listed.map((check) => check.id)).toEqual(["gate_newer", created.id]);
    expect(listed[0]).toMatchObject({
      status: "passed",
      totalCandidates: 1,
      judgedCandidates: 1,
      erroredCandidates: 0,
      disagreements: 0
    });

    for (let index = 0; index < 51; index += 1) {
      store.gateChecks.push({
        ...baseline,
        id: `gate_limit_${index.toString().padStart(2, "0")}`,
        createdAt: new Date(Date.UTC(2010, 0, index + 1)).toISOString()
      });
    }
    expect(await repository.listGateChecks(demoProject.id)).toHaveLength(50);
    expect(await repository.listGateChecks("project_other")).toEqual([]);
  });
});
