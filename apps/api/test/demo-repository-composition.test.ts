import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockJudgeProvider } from "@coeval/audit/runtime";
import { demoExceptions, demoGoldenSet, demoSkill, demoSkillPrevVersion, demoVerdicts } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { DemoRepository } from "../src/repository.js";
import * as compositionModule from "../src/repository/demo-composition.js";
import { createDemoRepositoryComposition } from "../src/repository/demo-composition.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_SLICE_PROPERTIES = [
  "caseEvidenceRepository",
  "credentialRepository",
  "projectRepository",
  "reviewQueueRepository",
  "runComparisonRepository",
  "criterionSuiteRepository",
  "datasetRepository",
  "evaluationRepository",
  "skillLifecycleRepository",
  "goldenEvidenceRepository",
  "historicalGateEvidenceRepository",
  "integrationRepository",
  "judgeFeedbackRepository",
  "traceImportRepository",
  "traceTestRepository"
] as const;

const EXPECTED_SLICE_CLASSES = [
  "DemoCaseEvidenceRepository",
  "DemoCredentialRepository",
  "DemoProjectRepository",
  "DemoReviewQueueRepository",
  "DemoRunComparisonRepository",
  "DemoCriterionSuiteRepository",
  "DemoDatasetRepository",
  "DemoEvaluationRepository",
  "DemoSkillLifecycleRepository",
  "DemoGoldenEvidenceRepository",
  "DemoHistoricalGateEvidenceRepository",
  "DemoIntegrationRepository",
  "DemoJudgeFeedbackRepository",
  "DemoTraceImportRepository",
  "DemoTraceTestRepository"
] as const;

const EXPECTED_FACADE_PROPERTIES = [
  "caseEvidenceRepository",
  "credentialRepository",
  "criterionSuiteRepository",
  "datasetRepository",
  "evaluationRepository",
  "goldenEvidenceRepository",
  "historicalGateEvidenceRepository",
  "integrationRepository",
  "judgeFeedbackRepository",
  "projectRepository",
  "reviewQueueRepository",
  "runComparisonRepository",
  "skillLifecycleRepository",
  "traceImportRepository",
  "traceTestRepository"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const COMPOSITION_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-composition.ts");

function sourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function createApiProgram(): ts.Program {
  const configPath = ts.findConfigFile(API_DIRECTORY, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function functionDeclaration(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  if (!declaration) throw new Error(`${name} declaration not found`);
  return declaration;
}

describe("DemoRepository composition", () => {
  it("pins the exact type/runtime surface, slice set, construction order, and root handoff", () => {
    const compositionSource = sourceFile(COMPOSITION_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMPOSITION_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Demo composition module symbol was not resolved");

    expect(Object.keys(compositionModule)).toEqual(["createDemoRepositoryComposition"]);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(["DemoRepositoryComposition", "createDemoRepositoryComposition"]);
    expect(compositionSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.isVariableStatement(statement) ? "VariableStatement" : ts.SyntaxKind[statement.kind]}:${
        (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) && statement.name
          ? statement.name.text
          : ts.isVariableStatement(statement)
            ? statement.declarationList.declarations.map((declaration) => declaration.name.getText(compositionSource)).join(",")
            : "<anonymous>"
      }`))
      .toEqual([
        "TypeAliasDeclaration:DemoRepositoryFacade",
        "InterfaceDeclaration:DemoRepositoryComposition",
        "VariableStatement:DEMO_ACTOR_NAMES",
        "FunctionDeclaration:demoTraceForGoldenEntry",
        "FunctionDeclaration:syntheticTraceForBuiltinCase",
        "FunctionDeclaration:seedDemoRepositoryStore",
        "FunctionDeclaration:isEvidenceScaffoldingCase",
        "FunctionDeclaration:resolveImportSkillVersionId",
        "FunctionDeclaration:resolveGoldenCriterionVersion",
        "FunctionDeclaration:createDemoRepositoryComposition"
      ]);

    const compositionInterface = compositionSource.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "DemoRepositoryComposition"
    );
    if (!compositionInterface) throw new Error("DemoRepositoryComposition interface not found");
    expect(compositionInterface.members.map((member) => member.name?.getText(compositionSource)))
      .toEqual(EXPECTED_SLICE_PROPERTIES);
    expect(compositionInterface.members.every((member) =>
      ts.isPropertySignature(member) && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
    )).toBe(true);

    const createComposition = functionDeclaration(compositionSource, "createDemoRepositoryComposition");
    const allocations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && EXPECTED_SLICE_CLASSES.includes(
        node.expression.getText(compositionSource) as typeof EXPECTED_SLICE_CLASSES[number]
      )) allocations.push(node.expression.getText(compositionSource));
      ts.forEachChild(node, visit);
    };
    visit(createComposition);
    expect(allocations).toEqual(EXPECTED_SLICE_CLASSES);
    const returnStatement = createComposition.body?.statements.find(ts.isReturnStatement);
    if (!returnStatement?.expression || !ts.isObjectLiteralExpression(returnStatement.expression)) {
      throw new Error("Composition return object not found");
    }
    expect(returnStatement.expression.properties.map((property) => property.name?.getText(compositionSource)))
      .toEqual(EXPECTED_SLICE_PROPERTIES);

    expect(repositorySource.statements.filter((statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "DemoRepository"
    )).toHaveLength(0);
    const repositoryClass = repositorySource.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === "DemoRepository"
    );
    if (!repositoryClass) throw new Error("DemoRepository class not found");
    expect(repositoryClass.members.filter(ts.isPropertyDeclaration).map((property) => property.name.getText(repositorySource)))
      .toEqual([...EXPECTED_FACADE_PROPERTIES, "store"]);
    expect(repositoryClass.members.filter(ts.isPropertyDeclaration).slice(0, -1).every((property) =>
      property.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) &&
      property.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) &&
      property.exclamationToken !== undefined
    )).toBe(true);
    const constructor = repositoryClass.members.find(ts.isConstructorDeclaration);
    expect(constructor?.body?.getText(repositorySource).replace(/\s+/g, " ").trim()).toBe(
      "{ Object.assign(this, createDemoRepositoryComposition(this, this.store, this.judgeProvider, options)); }"
    );
  }, 30_000);

  it("constructs every stateless slice once without eagerly reading the facade", () => {
    const facade = new Proxy({}, {
      get(_target, property) {
        throw new Error(`Facade property read during composition: ${String(property)}`);
      }
    }) as Parameters<typeof createDemoRepositoryComposition>[0];
    const store = new DemoRepositoryStore();
    const judgeProvider = new MockJudgeProvider();
    const composition = createDemoRepositoryComposition(facade, store, judgeProvider);

    expect(Object.keys(composition)).toEqual(EXPECTED_SLICE_PROPERTIES);
    for (const property of EXPECTED_SLICE_PROPERTIES) {
      expect(Reflect.get(composition[property], "store")).toBe(store);
      expect(Object.getOwnPropertyDescriptor(composition, property)).toEqual({
        configurable: true,
        enumerable: true,
        value: composition[property],
        writable: true
      });
    }
    expect(Reflect.get(composition.skillLifecycleRepository, "judgeProvider")).toBe(judgeProvider);
    expect(Object.keys(new DemoRepository())).toEqual([
      "judgeProvider",
      ...EXPECTED_FACADE_PROPERTIES,
      "store"
    ]);
  });

  it("preserves exact default and seeded fixture identities", () => {
    const facade = new Proxy({}, {
      get(_target, property) {
        throw new Error(`Facade property read during composition: ${String(property)}`);
      }
    }) as Parameters<typeof createDemoRepositoryComposition>[0];
    const defaultStore = new DemoRepositoryStore();
    createDemoRepositoryComposition(facade, defaultStore, new MockJudgeProvider());
    expect(defaultStore.verdicts).toEqual([]);
    expect(defaultStore.skillVersions).toBeNull();

    const seededStore = new DemoRepositoryStore();
    createDemoRepositoryComposition(facade, seededStore, new MockJudgeProvider(), { seedVerdicts: true });
    expect(seededStore.verdicts).toEqual(demoVerdicts);
    expect(seededStore.verdicts.every((verdict, index) => verdict === demoVerdicts[index])).toBe(true);
    expect(seededStore.skillVersions).toEqual([demoSkillPrevVersion, demoSkill.currentVersion]);
    expect(seededStore.skillVersions?.[0]).not.toBe(demoSkillPrevVersion);
    expect(seededStore.skillVersions?.[1]).not.toBe(demoSkill.currentVersion);
    expect(seededStore.skillVersionCriteria).toEqual(new Map([
      [demoSkillPrevVersion.id, demoSkill.currentVersion.criterionVersionId],
      [demoSkill.currentVersion.id, demoSkill.currentVersion.criterionVersionId]
    ]));
    expect(seededStore.criterionSkills.get(demoSkill.criterionId)).toBe(demoSkill);
    expect(seededStore.caseInputIdentities).toEqual(new Map([
      ...demoGoldenSet.map((entry) => [
        entry.caseId,
        datasetInputIdentity({ input: { caseId: entry.caseId } })
      ] as const),
      ...demoExceptions.map((exception) => [
        exception.id,
        datasetInputIdentity({ input: { text: "Demo customer support question" } })
      ] as const)
    ]));
  });
});
