import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockJudgeProvider } from "@coeval/audit/runtime";
import { demoProject } from "@coeval/db";
import { CreateCriterionInputSchema, CreateSkillVersionInputSchema } from "@coeval/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository, GateRunBindingMismatchError, NoCurrentSkillError } from "../src/repository.js";
import * as demoSkillRepositoryModule from "../src/repository/demo-skills.js";
import { DemoSkillLifecycleRepository } from "../src/repository/demo-skills.js";

const EXPECTED_PUBLIC_METHODS = [
  "getCurrentSkill",
  "getCurrentSkillForCriterion",
  "authorizeSkillVersionExecution",
  "getLatestSkillForCriterion",
  "getLatestSkill",
  "getSkillVersion",
  "getCriterionVersionForSkillVersion",
  "signOffSkillVersion",
  "createSkillVersion",
  "createSkillVersionPending",
  "runRegressionGateForVersion",
  "failRegressionGateForVersion",
  "getRegressionRunForVersion",
  "listRegressionRunsForVersions",
  "listSkillVersions"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-repository.ts");
const SKILL_REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-skills.ts");

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

function skillSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const skillSource = program.getSourceFile(SKILL_REPOSITORY_PATH);
  if (!skillSource) throw new Error("Demo skill repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(skillSource);
  if (!moduleSymbol) throw new Error("Demo skill repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoSkillLifecycleRepository");
  if (!classExport) throw new Error("DemoSkillLifecycleRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(SKILL_REPOSITORY_PATH)) {
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
        node.text === "DemoSkillLifecycleRepository" &&
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

describe("Demo skill lifecycle repository slice", () => {
  it("owns exactly the SkillLifecycleRepositoryPort methods behind the stable facade", () => {
    const skillSource = sourceFile(SKILL_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const skillRepository = classDeclaration(skillSource, "DemoSkillLifecycleRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoSkillRepositoryModule)).toEqual(["DemoSkillLifecycleRepository"]);
    expect("DemoSkillLifecycleRepository" in repositoryModule).toBe(false);
    expect(skillSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name
          ? statement.name.getText(skillSource)
          : "<anonymous>"
      }`))
      .toEqual([
        "TypeAliasDeclaration:BinaryJudgeProvider",
        "InterfaceDeclaration:DemoSkillLifecycleRepositoryDependencies",
        "ClassDeclaration:DemoSkillLifecycleRepository",
        "FunctionDeclaration:gateFailureMessage",
        "FunctionDeclaration:nextPatchVersion"
      ]);
    expect(skillRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(skillSource))
    )).toEqual(["SkillLifecycleRepositoryPort"]);
    expect(skillRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(skillSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      "MethodDeclaration:getCurrentSkill",
      "MethodDeclaration:getCurrentSkillForCriterion",
      "MethodDeclaration:authorizeSkillVersionExecution",
      "MethodDeclaration:getLatestSkillForCriterion",
      "MethodDeclaration:getLatestSkill",
      "MethodDeclaration:getSkillForCriterion",
      "MethodDeclaration:getSkillVersion",
      "MethodDeclaration:getCriterionVersionForSkillVersion",
      "MethodDeclaration:signOffSkillVersion",
      "MethodDeclaration:createSkillVersion",
      "MethodDeclaration:createSkillVersionPending",
      "MethodDeclaration:runRegressionGateForVersion",
      "MethodDeclaration:failRegressionGateForVersion",
      "MethodDeclaration:getRegressionRunForVersion",
      "MethodDeclaration:listRegressionRunsForVersions",
      "MethodDeclaration:listSkillVersions"
    ]);
    expect(skillRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, skillSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([[
      "private readonly store: DemoRepositoryStore",
      "private readonly judgeProvider: BinaryJudgeProvider",
      "private readonly dependencies: DemoSkillLifecycleRepositoryDependencies"
    ]]);

    const expectedDelegates = new Map<string, string>([
      ["getCurrentSkill", "{ return this.skillLifecycleRepository.getCurrentSkill(projectId); }"],
      ["getCurrentSkillForCriterion", "{ return this.skillLifecycleRepository.getCurrentSkillForCriterion(projectId, criterionId); }"],
      ["authorizeSkillVersionExecution", "{ return this.skillLifecycleRepository.authorizeSkillVersionExecution(input); }"],
      ["getLatestSkillForCriterion", "{ return this.skillLifecycleRepository.getLatestSkillForCriterion(projectId, criterionId); }"],
      ["getLatestSkill", "{ return this.skillLifecycleRepository.getLatestSkill(projectId); }"],
      ["getSkillVersion", "{ return this.skillLifecycleRepository.getSkillVersion(projectId, skillVersionId); }"],
      ["getCriterionVersionForSkillVersion", "{ return this.skillLifecycleRepository.getCriterionVersionForSkillVersion(projectId, skillVersionId); }"],
      ["signOffSkillVersion", "{ return this.skillLifecycleRepository.signOffSkillVersion(_projectId, _skillId, versionId, _context); }"],
      ["createSkillVersion", "{ return this.skillLifecycleRepository.createSkillVersion(skillId, input, context); }"],
      ["createSkillVersionPending", "{ return this.skillLifecycleRepository.createSkillVersionPending(skillId, input, context); }"],
      ["runRegressionGateForVersion", "{ return this.skillLifecycleRepository.runRegressionGateForVersion(job); }"],
      ["failRegressionGateForVersion", "{ return this.skillLifecycleRepository.failRegressionGateForVersion(job, error); }"],
      ["getRegressionRunForVersion", "{ return this.skillLifecycleRepository.getRegressionRunForVersion(_projectId, skillVersionId); }"],
      ["listRegressionRunsForVersions", "{ return this.skillLifecycleRepository.listRegressionRunsForVersions(_projectId, skillVersionIds); }"],
      ["listSkillVersions", "{ return this.skillLifecycleRepository.listSkillVersions(_projectId, skillId, limit); }"]
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

  it("constructs one slice with the exact shared store, provider, and cross-port callbacks", () => {
    const analysis = skillSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoSkillLifecycleRepository"]);
    expect(analysis.allocations).toEqual([
      "repository/demo-composition.ts:createDemoRepositoryComposition:new DemoSkillLifecycleRepository(store, judgeProvider, { createSkillVersionPending: (skillId, input, context) => facade.createSkillVersionPending(skillId, input, context), getDatasetRevisionDetail: (projectId, revisionId) => facade.getDatasetRevisionDetail(projectId, revisionId), getOrCreateRegressionDatasetRevision: (projectId, actorUserId, resolvedCriterionVersionId) => facade.getOrCreateRegressionDatasetRevision(projectId, actorUserId, resolvedCriterionVersionId), previousVerdictsFromRun, runRegressionGateForVersion: (job) => facade.runRegressionGateForVersion(job), runGoldenSetRegression })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoSkillLifecycleRepository } from "./demo-skills.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:"./demo-skills.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-composition.ts:ImportSpecifier:DemoSkillLifecycleRepository",
      "repository/demo-composition.ts:NewExpression:DemoSkillLifecycleRepository",
      "repository/demo-composition.ts:TypeReference:DemoSkillLifecycleRepository",
      "repository/demo-skills.ts:ClassDeclaration:DemoSkillLifecycleRepository"
    ]);

    const repository = new DemoRepository();
    const slice = Reflect.get(repository, "skillLifecycleRepository") as DemoSkillLifecycleRepository;
    expect(slice).toBeInstanceOf(DemoSkillLifecycleRepository);
    expect(Object.keys(slice)).toEqual(["store", "judgeProvider", "dependencies"]);
    expect(Reflect.get(slice, "store")).toBe(Reflect.get(repository, "store"));
    expect(Reflect.get(slice, "judgeProvider")).toBe(Reflect.get(repository, "judgeProvider"));
    expect(Object.keys(Reflect.get(slice, "dependencies") as object)).toEqual([
      "createSkillVersionPending",
      "getDatasetRevisionDetail",
      "getOrCreateRegressionDatasetRevision",
      "previousVerdictsFromRun",
      "runRegressionGateForVersion",
      "runGoldenSetRegression"
    ]);
  }, 30_000);

  it("preserves guided-onboarding replay, conflicts, and native-starter guards", async () => {
    const input = CreateSkillVersionInputSchema.parse({
      rubricMarkdown: "Judge support quality.",
      prompt: "Judge the answer.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
    });
    const onboardingCriterion = {
      name: "Support answer quality",
      definition: "Did the reply answer the question correctly?",
      idempotencyKey: "demo-skill-onboarding",
      requestDigest: `sha256:${"a".repeat(64)}`
    };

    const nonNativeRepository = new DemoRepository();
    const nonNativeStore = Reflect.get(nonNativeRepository, "store") as {
      criteria: Array<{ sourceKind: string }>;
      criterionSkills: Map<string, { isStarter: boolean }>;
    };
    nonNativeStore.criteria[0]!.sourceKind = "legacy";
    nonNativeStore.criterionSkills.values().next().value!.isStarter = true;
    await expect(nonNativeRepository.createSkillVersionPending(
      (await nonNativeRepository.getCurrentSkill()).id,
      input,
      { projectId: demoProject.id, onboardingCriterion }
    )).rejects.toMatchObject({ code: "criterion_not_native" });

    const repository = new DemoRepository();
    const repositoryStore = Reflect.get(repository, "store") as {
      criterionSkills: Map<string, { isStarter: boolean }>;
    };
    repositoryStore.criterionSkills.values().next().value!.isStarter = true;
    const starter = await repository.getCurrentSkill();
    expect(starter.isStarter).toBe(true);
    const pending = await repository.createSkillVersionPending(starter.id, input, {
      projectId: demoProject.id,
      onboardingCriterion
    });
    expect(pending.onboardingAssurance).toBe("starter_unvalidated");
    await expect(repository.getCriterionVersionForSkillVersion(demoProject.id, pending.id))
      .resolves.toMatchObject({
        id: pending.criterionVersionId,
        revision: 2,
        name: onboardingCriterion.name,
        definition: onboardingCriterion.definition,
        sourceKind: "native"
      });
    await expect(repository.getLatestSkillForCriterion(demoProject.id, starter.criterionId))
      .resolves.toMatchObject({
        isStarter: false,
        name: onboardingCriterion.name,
        description: onboardingCriterion.definition
      });
    await expect(repository.createSkillVersionPending(starter.id, input, {
      projectId: demoProject.id,
      onboardingCriterion
    })).resolves.toBe(pending);
    await expect(repository.createSkillVersionPending(starter.id, input, {
      projectId: demoProject.id,
      onboardingCriterion: {
        ...onboardingCriterion,
        requestDigest: `sha256:${"b".repeat(64)}`
      }
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repository.createSkillVersionPending(starter.id, input, {
      projectId: demoProject.id,
      onboardingCriterion: {
        ...onboardingCriterion,
        idempotencyKey: "demo-skill-onboarding-second"
      }
    })).rejects.toMatchObject({ code: "project_already_configured" });
  });

  it("preserves cross-slice definition ownership and signoff object identity", async () => {
    const repository = new DemoRepository();
    const slice = Reflect.get(repository, "skillLifecycleRepository") as DemoSkillLifecycleRepository;
    const current = await repository.getLatestSkill();
    const created = await repository.createCriterion(demoProject.id, CreateCriterionInputSchema.parse({
      stableKey: "skill-slice-signoff",
      name: "Signoff criterion",
      definition: "The response satisfies the signed-off criterion.",
      evaluator: {
        rubricMarkdown: "# Signoff criterion",
        prompt: "Judge the response.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
      }
    }), { actorUserId: "owner_skill_slice" });
    const storedDraft = await slice.getSkillVersion(demoProject.id, created.evaluator.currentVersion.id);
    expect(storedDraft).not.toBeNull();
    const signed = await slice.signOffSkillVersion(
      demoProject.id,
      created.evaluator.id,
      created.evaluator.currentVersion.id,
      { actorUserId: "owner_skill_slice" }
    );
    expect(signed).toBe(storedDraft);
    expect(signed).toMatchObject({ status: "approved", approvedAt: expect.any(String) });

    const input = CreateSkillVersionInputSchema.parse({
      criterionVersionId: created.versions[0]!.id,
      rubricMarkdown: "Judge support quality.",
      prompt: "Judge the answer.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
    });
    await expect(slice.createSkillVersionPending(current.id, input, { projectId: demoProject.id }))
      .rejects.toThrow(/does not own criterion version/);
  });

  it("preserves facade polymorphism for the composite create operation", async () => {
    class DispatchCapturingRepository extends DemoRepository {
      pendingCalls = 0;
      gateCalls = 0;

      override async createSkillVersionPending(
        ...args: Parameters<DemoRepository["createSkillVersionPending"]>
      ): ReturnType<DemoRepository["createSkillVersionPending"]> {
        this.pendingCalls += 1;
        return super.createSkillVersionPending(...args);
      }

      override async runRegressionGateForVersion(
        ...args: Parameters<DemoRepository["runRegressionGateForVersion"]>
      ): ReturnType<DemoRepository["runRegressionGateForVersion"]> {
        this.gateCalls += 1;
        return super.runRegressionGateForVersion(...args);
      }
    }

    const repository = new DispatchCapturingRepository();
    const current = await repository.getLatestSkill();
    await repository.createSkillVersion(current.id, CreateSkillVersionInputSchema.parse({
      rubricMarkdown: "Judge support quality.",
      prompt: "Judge the answer.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
    }), { projectId: demoProject.id });
    expect(repository.pendingCalls).toBe(1);
    expect(repository.gateCalls).toBe(1);
  });

  it("preserves selector, immutable regression binding, terminalization, and shared visibility", async () => {
    let judgeCalls = 0;
    const provider = new class extends MockJudgeProvider {
      override async judge(input: Parameters<MockJudgeProvider["judge"]>[0]) {
        judgeCalls += 1;
        return super.judge(input);
      }
    }();
    const repository = new DemoRepository(provider);
    const slice = Reflect.get(repository, "skillLifecycleRepository") as DemoSkillLifecycleRepository;
    const current = await slice.getCurrentSkill();
    expect(current).toEqual(await repository.getCurrentSkillForCriterion(demoProject.id, current.criterionId));
    await expect(slice.getCurrentSkill("other-project")).rejects.toBeInstanceOf(NoCurrentSkillError);
    await expect(slice.getCurrentSkillForCriterion("other-project", current.criterionId))
      .rejects.toBeInstanceOf(NoCurrentSkillError);
    await expect(slice.getSkillVersion("other-project", current.currentVersion.id)).resolves.toBeNull();
    await expect(slice.getCriterionVersionForSkillVersion("other-project", current.currentVersion.id))
      .resolves.toBeNull();
    await expect(slice.getCriterionVersionForSkillVersion(demoProject.id, current.currentVersion.id))
      .resolves.toMatchObject({ id: current.currentVersion.criterionVersionId });
    const expectedPrompt = current.currentVersion.prompt;
    const liveIsolationProbe = await slice.getCurrentSkillForCriterion(demoProject.id, current.criterionId);
    liveIsolationProbe.currentVersion.prompt = "mutated outside the repository";
    await expect(slice.getCurrentSkillForCriterion(demoProject.id, current.criterionId))
      .resolves.toMatchObject({ currentVersion: { prompt: expectedPrompt } });
    await expect(slice.authorizeSkillVersionExecution({
      projectId: demoProject.id,
      skillVersionId: current.currentVersion.id,
      context: "explicit_nonproduction_dataset",
      resourceKind: "dataset_revision",
      resourceId: "revision_demo",
      idempotencyKey: "demo-skill-slice-auth"
    })).resolves.toBeUndefined();

    const input = CreateSkillVersionInputSchema.parse({
      rubricMarkdown: "Judge support quality.",
      prompt: "Judge the answer.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
    });
    const pending = await slice.createSkillVersionPending(current.id, input, { projectId: demoProject.id });
    expect(pending).toMatchObject({
      skillId: current.id,
      criterionVersionId: current.currentVersion.criterionVersionId,
      status: "calibrating",
      regressionDatasetRevisionId: expect.any(String)
    });
    const [major = "0", minor = "0", patch = "0"] = current.currentVersion.version.split(".");
    expect(pending.version).toBe(`${major}.${minor}.${Number(patch) + 1}`);
    await expect(repository.getSkillVersion(demoProject.id, pending.id)).resolves.toBe(pending);
    await expect(slice.getLatestSkillForCriterion(demoProject.id, current.criterionId))
      .resolves.toMatchObject({ currentVersion: { id: pending.id } });
    await expect(slice.getCurrentSkillForCriterion(demoProject.id, current.criterionId))
      .resolves.toMatchObject({ currentVersion: { id: current.currentVersion.id } });
    await expect(slice.runRegressionGateForVersion({
      projectId: demoProject.id,
      skillVersionId: pending.id,
      datasetRevisionId: "wrong-revision",
      timeScope: "new"
    })).rejects.toBeInstanceOf(GateRunBindingMismatchError);

    const completed = await slice.runRegressionGateForVersion({
      projectId: demoProject.id,
      skillVersionId: pending.id,
      datasetRevisionId: pending.regressionDatasetRevisionId!,
      timeScope: "new"
    });
    expect(completed.version).toBe(pending);
    expect(judgeCalls).toBe(2);
    expect(completed.regressionRun).toMatchObject({
      datasetRevisionId: pending.regressionDatasetRevisionId,
      compared: 2,
      goldenSetMissing: false
    });
    const regressionRevision = await repository.getDatasetRevisionDetail(
      demoProject.id,
      pending.regressionDatasetRevisionId!
    );
    expect(regressionRevision?.exposures).toContainEqual(expect.objectContaining({
      revisionId: pending.regressionDatasetRevisionId,
      kind: "evaluator_execution",
      activity: "regression_run",
      subjectKind: "evaluator_version",
      subjectId: pending.id,
      evidenceRefKind: "regression_run",
      evidenceRefId: completed.regressionRun.id
    }));

    const dependencies = Reflect.get(slice, "dependencies") as Record<string, unknown>;
    const originalPreviousVerdicts = dependencies.previousVerdictsFromRun as (
      run: unknown
    ) => Map<string, never>;
    let previousRegressionRun: unknown;
    dependencies.previousVerdictsFromRun = (run: unknown) => {
      previousRegressionRun = run;
      return originalPreviousVerdicts(run);
    };
    const comparison = await slice.createSkillVersionPending(current.id, input, { projectId: demoProject.id });
    await slice.runRegressionGateForVersion({
      projectId: demoProject.id,
      skillVersionId: comparison.id,
      datasetRevisionId: comparison.regressionDatasetRevisionId!,
      timeScope: "new"
    });
    expect(previousRegressionRun).toBe(completed.regressionRun);
    pending.createdAt = "2099-01-01T00:00:00.000Z";
    comparison.createdAt = "2099-01-02T00:00:00.000Z";
    await expect(repository.getRegressionRunForVersion(demoProject.id, pending.id))
      .resolves.toBe(completed.regressionRun);
    await expect(repository.listRegressionRunsForVersions(demoProject.id, ["missing", pending.id]))
      .resolves.toEqual([completed.regressionRun]);
    expect((await repository.listSkillVersions(demoProject.id, current.id, 1))[0]).toBe(comparison);

    const doomed = await slice.createSkillVersionPending(current.id, input, { projectId: demoProject.id });
    const failureJob = {
      projectId: demoProject.id,
      skillVersionId: doomed.id,
      datasetRevisionId: doomed.regressionDatasetRevisionId!,
      timeScope: "new" as const
    };
    await expect(slice.failRegressionGateForVersion({
      ...failureJob,
      datasetRevisionId: "wrong-revision"
    }, new Error("must not terminalize"))).rejects.toBeInstanceOf(GateRunBindingMismatchError);
    expect(doomed.status).toBe("calibrating");
    await slice.failRegressionGateForVersion(failureJob, new Error("x".repeat(2_500)));
    await expect(repository.getRegressionRunForVersion(demoProject.id, doomed.id)).resolves.toMatchObject({
      status: "error",
      error: "x".repeat(2_000),
      datasetRevisionId: doomed.regressionDatasetRevisionId
    });
    await expect(repository.listRegressionRunsForVersions(demoProject.id, [pending.id]))
      .resolves.toEqual([completed.regressionRun]);
    await expect(repository.listRegressionRunsForVersions(demoProject.id, [doomed.id]))
      .resolves.toEqual([await repository.getRegressionRunForVersion(demoProject.id, doomed.id)]);
    const firstFailure = await repository.getRegressionRunForVersion(demoProject.id, doomed.id);
    await slice.failRegressionGateForVersion(failureJob, new Error("late retry"));
    await expect(repository.getRegressionRunForVersion(demoProject.id, doomed.id)).resolves.toBe(firstFailure);
  });
});
