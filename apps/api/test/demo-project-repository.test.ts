import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoGoldenSet, demoProject, demoSkill, getDemoDashboardSummary } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import * as demoProjectRepositoryModule from "../src/repository/demo-projects.js";
import { DemoProjectRepository } from "../src/repository/demo-projects.js";

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
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const PROJECT_REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-projects.ts");

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

interface ProjectSliceAnalysis {
  allocations: string[];
  compilerExports: string[];
  moduleEdges: string[];
  moduleSpecifierMentions: string[];
  references: string[];
}

function projectSliceAnalysis(program: ts.Program): ProjectSliceAnalysis {
  const checker = program.getTypeChecker();
  const projectSource = program.getSourceFile(PROJECT_REPOSITORY_PATH);
  if (!projectSource) throw new Error("Demo project repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(projectSource);
  if (!moduleSymbol) throw new Error("Demo project repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoProjectRepository");
  if (!classExport) throw new Error("DemoProjectRepository export was not resolved");
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
        node.text === "DemoProjectRepository" &&
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

describe("Demo project repository slice", () => {
  it("owns exactly the ProjectRepositoryPort methods behind the stable facade", () => {
    const projectSource = sourceFile(PROJECT_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const projectRepository = classDeclaration(projectSource, "DemoProjectRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoProjectRepositoryModule)).toEqual(["DemoProjectRepository"]);
    expect("DemoProjectRepository" in repositoryModule).toBe(false);
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
    expect(projectRepository.members.filter(ts.isMethodDeclaration).map((method) => method.name.getText(projectSource)))
      .toEqual(EXPECTED_METHODS);
    expect(projectRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, projectSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([[
      "private readonly store: DemoRepositoryStore",
      "private readonly dependencies: DemoProjectRepositoryDependencies"
    ]]);

    const expectedDelegates = new Map<string, string>([
      ["listProjects", "{ return this.projectRepository.listProjects(); }"],
      ["getProjectSettings", "{ return this.projectRepository.getProjectSettings(); }"],
      ["updateProjectSettings", "{ return this.projectRepository.updateProjectSettings(_projectId, input); }"],
      ["pruneExpiredTraces", "{ return this.projectRepository.pruneExpiredTraces(); }"],
      ["deleteProject", "{ return this.projectRepository.deleteProject(_projectId, input); }"],
      ["getDashboardSummary", "{ return this.projectRepository.getDashboardSummary(projectId, criterionId); }"],
      ["getOnboardingEvidenceInventory", "{ return this.projectRepository.getOnboardingEvidenceInventory(projectId); }"]
    ]);
    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_METHODS.includes(method.name.getText(repositorySource) as typeof EXPECTED_METHODS[number]));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_METHODS);
    for (const method of facadeMethods) {
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource).replace(/\s+/g, " ").trim())
        .toBe(expectedDelegates.get(method.name.getText(repositorySource)));
    }
  });

  it("constructs one slice at the facade boundary and pins its exact module ownership", () => {
    const analysis = projectSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoProjectRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.ts:DemoRepository.constructor:new DemoProjectRepository(this.store, { getCurrentSkill: (projectId) => this.getCurrentSkill(projectId), getCurrentSkillForCriterion: (projectId, criterionId) => this.getCurrentSkillForCriterion(projectId, criterionId), isEvidenceScaffoldingCase: (caseId) => this.isEvidenceScaffoldingCase(caseId), listGoldenSet: (projectId, criterionVersionId) => this.listGoldenSet(projectId, criterionVersionId), syntheticTraceForBuiltinCase: (caseId) => this.syntheticTraceForBuiltinCase(caseId) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.ts:ImportDeclaration:import { DemoProjectRepository } from "./repository/demo-projects.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.ts:ImportDeclaration:"./repository/demo-projects.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.ts:ImportSpecifier:DemoProjectRepository",
      "repository.ts:NewExpression:DemoProjectRepository",
      "repository.ts:TypeReference:DemoProjectRepository",
      "repository/demo-projects.ts:ClassDeclaration:DemoProjectRepository"
    ]);
  }, 30_000);

  it("shares the exact store with other facade domains and preserves project behavior", async () => {
    const repository = new DemoRepository();
    const store = Reflect.get(repository, "store") as unknown;
    const projectRepository = Reflect.get(repository, "projectRepository") as DemoProjectRepository;
    expect(projectRepository).toBeInstanceOf(DemoProjectRepository);
    expect(Object.keys(projectRepository)).toEqual(["store", "dependencies"]);
    expect(Reflect.get(projectRepository, "store")).toBe(store);
    expect(Object.keys(Reflect.get(projectRepository, "dependencies") as object).sort()).toEqual([
      "getCurrentSkill",
      "getCurrentSkillForCriterion",
      "isEvidenceScaffoldingCase",
      "listGoldenSet",
      "syntheticTraceForBuiltinCase"
    ]);

    await expect(repository.listProjects()).resolves.toEqual([demoProject]);
    await expect(repository.getProjectSettings()).resolves.toEqual({
      projectId: demoProject.id,
      name: demoProject.name,
      mode: demoProject.mode,
      traceRetentionDays: demoProject.traceRetentionDays
    });
    await expect(repository.updateProjectSettings(demoProject.id, {
      mode: "bench",
      traceRetentionDays: 30
    })).resolves.toEqual({
      projectId: demoProject.id,
      name: demoProject.name,
      mode: "bench",
      traceRetentionDays: 30
    });
    await expect(repository.updateProjectSettings(demoProject.id, {
      traceRetentionDays: null
    })).resolves.toEqual({
      projectId: demoProject.id,
      name: demoProject.name,
      mode: demoProject.mode,
      traceRetentionDays: null
    });
    await expect(repository.pruneExpiredTraces()).resolves.toEqual({
      projectId: demoProject.id,
      traceRetentionDays: demoProject.traceRetentionDays,
      cutoff: null,
      deletedCases: 0,
      deletedRawTraces: 0,
      skippedActiveGoldenCases: 0,
      skippedImmutableRevisionCases: 0
    });
    await expect(repository.deleteProject(demoProject.id, { confirmProjectName: "wrong" }))
      .rejects.toThrow("Project confirmation did not match");
    await expect(repository.deleteProject(demoProject.id, { confirmProjectName: demoProject.name })).resolves.toBeUndefined();
    await expect(repository.getOnboardingEvidenceInventory("other-project")).resolves.toEqual({
      runCount: 0,
      inputCount: 0,
      outputCount: 0,
      stepsCount: 0,
      metadataCount: 0
    });

    const baseline = getDemoDashboardSummary();
    const initialDashboard = await repository.getDashboardSummary(demoProject.id);
    expect(initialDashboard.currentVersionResultCount).toBe(baseline.currentVersionResultCount);
    expect(initialDashboard.verdictDistribution).toEqual(baseline.verdictDistribution);
    expect(initialDashboard.goldenSetSize).toBe(demoGoldenSet.length);
    const capabilityGapCounts = new Map<string, number>();
    for (const exception of initialDashboard.exceptions) {
      if (!exception.capabilityGap) continue;
      capabilityGapCounts.set(
        exception.capabilityGap,
        (capabilityGapCounts.get(exception.capabilityGap) ?? 0) + 1
      );
    }
    expect(initialDashboard.topCapabilityGaps).toEqual(
      [...capabilityGapCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 5)
        .map(([name, count]) => ({
          id: `gap_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
          name,
          count,
          severity: count >= 5 ? "high" : count >= 2 ? "medium" : "low"
        }))
    );

    const imported = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "project-slice-shared-store",
      input: { prompt: "Can another slice see me?" },
      output: { answer: "yes" },
      metadata: { suite: "project-slice" },
      steps: [{ name: "lookup", input: { key: "shared" }, output: { found: true } }]
    }, { ingestionPurpose: "analysis_eligible_manual" });
    await expect(projectRepository.getOnboardingEvidenceInventory(demoProject.id)).resolves.toEqual({
      runCount: 1,
      inputCount: 1,
      outputCount: 1,
      stepsCount: 1,
      metadataCount: 1
    });
    await repository.recordJudgeRun({
      projectId: demoProject.id,
      caseId: imported.caseId,
      skillVersionId: demoSkill.currentVersion.id,
      verdict: {
        label: "pass",
        score: 1,
        reason: "The project slice reads the shared trace and judge-run state.",
        confidence: 1
      }
    });
    const after = await repository.getDashboardSummary(demoProject.id);
    expect(after.project).toMatchObject({
      id: demoProject.id,
      name: demoProject.name,
      importedTraceCount: baseline.project.importedTraceCount + 1,
      autoJudgedTraceCount: baseline.project.autoJudgedTraceCount + 1
    });
    expect(after.currentVersionResultCount).toBe(baseline.currentVersionResultCount + 1);
    expect(after.verdictDistribution).toEqual({ pass: 1, fail: 0, ambiguous: 0 });
    expect(after.exceptions).toEqual(initialDashboard.exceptions);
    expect(after.topCapabilityGaps).toEqual(initialDashboard.topCapabilityGaps);
    expect(after.goldenSetSize).toBe(initialDashboard.goldenSetSize);
  });
});
