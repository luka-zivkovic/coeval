import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject } from "@coeval/db";
import { CreateCriterionInputSchema } from "@coeval/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import {
  CriterionStableKeyConflictError,
  DemoRepository,
  EvaluatorSuiteBindingError,
  EvaluatorSuiteIdempotencyConflictError
} from "../src/repository.js";
import * as demoCriterionRepositoryModule from "../src/repository/demo-criteria.js";
import { DemoCriterionSuiteRepository } from "../src/repository/demo-criteria.js";

const EXPECTED_METHODS = [
  "listCriteria",
  "getCriterion",
  "createCriterion",
  "createCriterionVersion",
  "listEvaluatorSuites",
  "getEvaluatorSuite",
  "createEvaluatorSuiteManifest",
  "listEvaluatorSuiteManifests",
  "getEvaluatorSuiteManifest"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const CRITERION_REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-criteria.ts");

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

function criterionSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const criterionSource = program.getSourceFile(CRITERION_REPOSITORY_PATH);
  if (!criterionSource) throw new Error("Demo criterion repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(criterionSource);
  if (!moduleSymbol) throw new Error("Demo criterion repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoCriterionSuiteRepository");
  if (!classExport) throw new Error("DemoCriterionSuiteRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(CRITERION_REPOSITORY_PATH)) {
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
        node.text === "DemoCriterionSuiteRepository" &&
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

describe("Demo criterion and evaluator-suite repository slice", () => {
  it("owns exactly the CriterionSuiteRepositoryPort methods behind the stable facade", () => {
    const criterionSource = sourceFile(CRITERION_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const criterionRepository = classDeclaration(criterionSource, "DemoCriterionSuiteRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoCriterionRepositoryModule)).toEqual(["DemoCriterionSuiteRepository"]);
    expect("DemoCriterionSuiteRepository" in repositoryModule).toBe(false);
    expect(criterionSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(criterionSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:DemoCriterionSuiteRepository"]);
    expect(criterionRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(criterionSource))
    )).toEqual(["CriterionSuiteRepositoryPort"]);
    expect(criterionRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(criterionSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(criterionRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, criterionSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([["private readonly store: DemoRepositoryStore"]]);

    const expectedDelegates = new Map<string, string>([
      ["listCriteria", "{ return this.criterionSuiteRepository.listCriteria(projectId); }"],
      ["getCriterion", "{ return this.criterionSuiteRepository.getCriterion(projectId, criterionId); }"],
      ["createCriterion", "{ return this.criterionSuiteRepository.createCriterion(projectId, input, context); }"],
      ["createCriterionVersion", "{ return this.criterionSuiteRepository.createCriterionVersion(projectId, criterionId, input, context); }"],
      ["listEvaluatorSuites", "{ return this.criterionSuiteRepository.listEvaluatorSuites(projectId); }"],
      ["getEvaluatorSuite", "{ return this.criterionSuiteRepository.getEvaluatorSuite(projectId, suiteId); }"],
      ["createEvaluatorSuiteManifest", "{ return this.criterionSuiteRepository.createEvaluatorSuiteManifest(projectId, input, context); }"],
      ["listEvaluatorSuiteManifests", "{ return this.criterionSuiteRepository.listEvaluatorSuiteManifests(projectId, suiteId); }"],
      ["getEvaluatorSuiteManifest", "{ return this.criterionSuiteRepository.getEvaluatorSuiteManifest(projectId, manifestId); }"]
    ]);
    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_METHODS.includes(method.name.getText(repositorySource) as typeof EXPECTED_METHODS[number]));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_METHODS);
    for (const method of facadeMethods) {
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource).replace(/\s+/g, " ").trim())
        .toBe(expectedDelegates.get(method.name.getText(repositorySource)));
    }
  });

  it("constructs one stateless slice with the facade's exact shared store", () => {
    const analysis = criterionSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoCriterionSuiteRepository"]);
    expect(analysis.allocations).toEqual([
      "repository/demo-composition.ts:createDemoRepositoryComposition:new DemoCriterionSuiteRepository(store)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoCriterionSuiteRepository } from "./demo-criteria.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:"./demo-criteria.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-composition.ts:ImportSpecifier:DemoCriterionSuiteRepository",
      "repository/demo-composition.ts:NewExpression:DemoCriterionSuiteRepository",
      "repository/demo-composition.ts:TypeReference:DemoCriterionSuiteRepository",
      "repository/demo-criteria.ts:ClassDeclaration:DemoCriterionSuiteRepository"
    ]);

    const repository = new DemoRepository();
    const slice = Reflect.get(repository, "criterionSuiteRepository") as DemoCriterionSuiteRepository;
    expect(slice).toBeInstanceOf(DemoCriterionSuiteRepository);
    expect(Object.keys(slice)).toEqual(["store"]);
    expect(Reflect.get(slice, "store")).toBe(Reflect.get(repository, "store"));
  }, 30_000);

  it("preserves criterion provisioning, cross-domain visibility, and suite idempotency", async () => {
    const repository = new DemoRepository();
    const projectId = demoProject.id;
    const legacyCriterion = (await repository.listCriteria(projectId))[0]!;
    const legacyDetail = await repository.getCriterion(projectId, legacyCriterion.id);
    const legacySkill = await repository.getCurrentSkillForCriterion(projectId, legacyCriterion.id);
    expect(legacyDetail?.versions.map((version) => version.revision)).toEqual([1]);
    await expect(repository.getCriterion("other-project", legacyCriterion.id)).resolves.toBeNull();

    const input = CreateCriterionInputSchema.parse({
      stableKey: "criterion-slice-groundedness",
      name: "Groundedness",
      definition: "Every material claim must be supported by supplied evidence.",
      evaluator: {
        rubricMarkdown: "# Groundedness\n\nPass only when each claim is supported.",
        prompt: "Judge groundedness.\n{{rubric_markdown}}",
        modelBinding: {
          provider: "mock",
          modelId: "mock",
          modelVersion: "test",
          temperature: 0
        }
      }
    });
    const created = await repository.createCriterion(projectId, input, { actorUserId: "owner_criteria" });
    expect(created).toMatchObject({
      criterion: {
        projectId,
        stableKey: input.stableKey,
        sourceKind: "native",
        createdByUserId: "owner_criteria"
      },
      versions: [{ revision: 1, name: input.name, definition: input.definition }],
      evaluator: {
        projectId,
        criterionId: expect.any(String),
        ownerName: "owner_criteria",
        status: "draft",
        currentVersion: { version: "0.1.0", status: "draft" }
      }
    });
    expect(created.evaluator.criterionId).toBe(created.criterion.id);
    expect(created.evaluator.currentVersion.criterionVersionId).toBe(created.versions[0]!.id);
    await expect(repository.getCurrentSkillForCriterion(projectId, created.criterion.id))
      .resolves.toEqual(created.evaluator);
    await expect(repository.createCriterion(projectId, input, {}))
      .rejects.toBeInstanceOf(CriterionStableKeyConflictError);
    await expect(repository.createCriterionVersion(projectId, "criterion_missing", {
      name: "Missing",
      definition: "Missing"
    }, {})).resolves.toBeNull();
    const revision = await repository.createCriterionVersion(projectId, created.criterion.id, {
      name: "Groundedness strict",
      definition: "Every material claim must cite the supplied evidence."
    }, { actorUserId: "owner_revision" });
    expect(revision).toMatchObject({
      projectId,
      criterionId: created.criterion.id,
      revision: 2,
      sourceKind: "native",
      createdByUserId: "owner_revision"
    });
    await expect(repository.getCriterion(projectId, created.criterion.id)).resolves.toMatchObject({
      versions: [{ id: revision!.id, revision: 2 }, { id: created.versions[0]!.id, revision: 1 }]
    });

    const request = {
      idempotencyKey: "criterion-slice-suite-1",
      members: [
        {
          criterionVersionId: legacyDetail!.versions[0]!.id,
          skillVersionId: legacySkill.currentVersion.id
        },
        {
          criterionVersionId: created.versions[0]!.id,
          skillVersionId: created.evaluator.currentVersion.id
        }
      ],
      trialPlan: null
    };
    const first = await repository.createEvaluatorSuiteManifest(projectId, request, {
      actorUserId: "owner_suite"
    });
    expect(first).toMatchObject({ projectId, revision: 1, trialPlan: null });
    expect(first.members.map((member) => member.position)).toEqual([0, 1]);
    await expect(repository.createEvaluatorSuiteManifest(projectId, request, {})).resolves.toEqual(first);
    await expect(repository.listEvaluatorSuites(projectId)).resolves.toEqual([
      expect.objectContaining({ id: first.suiteId, projectId, createdByUserId: "owner_suite" })
    ]);
    await expect(repository.getEvaluatorSuite(projectId, first.suiteId)).resolves.toMatchObject({
      id: first.suiteId,
      projectId
    });
    await expect(repository.getEvaluatorSuite("other-project", first.suiteId)).resolves.toBeNull();
    await expect(repository.getEvaluatorSuiteManifest(projectId, first.manifestId)).resolves.toEqual(first);

    const second = await repository.createEvaluatorSuiteManifest(projectId, {
      ...request,
      idempotencyKey: "criterion-slice-suite-2",
      suiteId: first.suiteId
    }, {});
    expect(second).toMatchObject({ suiteId: first.suiteId, revision: 2 });
    await expect(repository.listEvaluatorSuiteManifests(projectId, first.suiteId)).resolves.toEqual([second, first]);
    await expect(repository.createEvaluatorSuiteManifest(projectId, {
      ...request,
      trialPlan: { kind: "independent_repetitions" as const, trialsPerItem: 2 }
    }, {})).rejects.toBeInstanceOf(EvaluatorSuiteIdempotencyConflictError);
    await expect(repository.createEvaluatorSuiteManifest(projectId, {
      idempotencyKey: "criterion-slice-duplicate-member",
      members: [request.members[0]!, request.members[0]!],
      trialPlan: null
    }, {})).rejects.toBeInstanceOf(EvaluatorSuiteBindingError);
  });
});
