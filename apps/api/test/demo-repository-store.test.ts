import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import * as demoStoreModule from "../src/repository/demo-store.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_STORE_FIELDS = [
  "traces",
  "caseInputIdentities",
  "traceSources",
  "judgeRuns",
  "verdicts",
  "skillVersions",
  "regressionRuns",
  "reviewQueues",
  "reviewQueueItems",
  "langSmithIntegrations",
  "langSmithLastPolledAt",
  "langfuseIntegrations",
  "langfuseLastPolledAt",
  "ironsideIntegrations",
  "ironsideLastPolledAt",
  "feedbackJobs",
  "feedbackJobAttempts",
  "feedbackJobLastError",
  "feedbackJobRunIds",
  "promotedGoldenSet",
  "retiredGoldenSetEntries",
  "importJobs",
  "apiKeys",
  "traceTests",
  "traceTestRevisions",
  "traceTestValidations",
  "traceTestFunnelEvents",
  "datasets",
  "datasetItems",
  "datasetRevisions",
  "datasetRevisionItems",
  "datasetExposureEvents",
  "datasetRevisionIdempotency",
  "regressionDatasetRevisionId",
  "regressionDatasetRevisionIdsByCriterion",
  "evalRuns",
  "evalRunItems",
  "convergenceEvalRuns",
  "importedCaseEvalRuns",
  "evalRunDispatches",
  "evalRunItemQueueJobs",
  "evalRunItemDeliveryDeadlines",
  "evalRunItemExecutions",
  "assessmentReceiptArtifacts",
  "assessmentReceiptComparisons",
  "runComparisons",
  "criteria",
  "criterionVersions",
  "evaluatorSuites",
  "evaluatorSuiteManifests",
  "skillVersionCriteria",
  "onboardingCheckRequests",
  "criterionSkills",
  "judgeProviderKeys",
  "gateChecks"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const STORE_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-store.ts");
const REPOSITORY_HELPERS_PATH = path.join(API_SOURCE_DIRECTORY, "repository/helpers.ts");
const REPOSITORY_SOURCE_DIRECTORY = path.dirname(STORE_PATH);

interface StoreBoundaryAnalysis {
  compilerExports: string[];
  productionAllocations: string[];
  productionLoaderFactoryReferences: string[];
  productionLoaderCalls: string[];
  productionModuleObjectMutations: string[];
  productionReferences: string[];
  repositoryGraphFiles: string[];
  repositoryGraphModuleVariables: string[];
  repositoryGraphStaticOrAccessorMembers: string[];
  repositoryClasses: string[];
  repositoryImports: string[];
  repositoryUnexpectedMemberKinds: string[];
  repositoryModuleVariables: string[];
  repositoryTopLevelDeclarations: string[];
  repositoryUnexpectedStatements: string[];
  storeModuleEdges: string[];
  storeModuleSpecifierMentions: string[];
  storeMemberKinds: string[];
  storeTopLevelDeclarations: string[];
}

function sourceFile(relativeUrl: string): ts.SourceFile {
  const url = new URL(relativeUrl, import.meta.url);
  return ts.createSourceFile(url.pathname, fs.readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function classDeclaration(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const declaration = source.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name
  );
  if (!declaration) throw new Error(`${name} declaration not found`);
  return declaration;
}

function storeAccessNames(...declarations: ts.ClassDeclaration[]): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === "store"
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  for (const declaration of declarations) visit(declaration);
  return [...names].sort();
}

function demoStoreCreations(declaration: ts.ClassDeclaration, source: ts.SourceFile): string[] {
  const creations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === "DemoRepositoryStore") {
      creations.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return creations;
}

function createApiProgram(overrides: ReadonlyMap<string, string> = new Map()): ts.Program {
  const configPath = ts.findConfigFile(API_DIRECTORY, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const normalizedOverrides = new Map(
    [...overrides].map(([fileName, source]) => [path.resolve(fileName), source])
  );
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const override = normalizedOverrides.get(path.resolve(fileName));
    return override === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, override, languageVersion, true, ts.ScriptKind.TS);
  };
  return ts.createProgram(parsed.fileNames, parsed.options, host);
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function resolvedConstructorSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const direct = resolvedSymbol(checker, node);
  const type = checker.getTypeAtLocation(node);
  if (type.getConstructSignatures().length > 0) {
    const symbol = type.getSymbol();
    if (symbol) return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }
  return direct;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) return unwrapExpression(node.expression);
  return node;
}

function relativeSourceName(source: ts.SourceFile): string {
  return path.relative(API_SOURCE_DIRECTORY, source.fileName).split(path.sep).join("/");
}

function isTopLevelDeclaration(node: ts.Node): boolean {
  if (node.parent && ts.isSourceFile(node.parent)) return true;
  return ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent);
}

function expressionHasModuleOrigin(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen = new Set<ts.Symbol>()
): boolean {
  const expression = unwrapExpression(input);
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return false;
  const rawSymbol = checker.getSymbolAtLocation(expression);
  if (!rawSymbol) return false;
  if (rawSymbol.flags & ts.SymbolFlags.Alias) return true;
  if (seen.has(rawSymbol)) return false;
  seen.add(rawSymbol);
  for (const declaration of rawSymbol.declarations ?? []) {
    if (isTopLevelDeclaration(declaration)) return true;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (expressionHasModuleOrigin(checker, declaration.initializer, seen)) return true;
    }
  }
  return false;
}

function propertyReceiver(node: ts.Expression): ts.Expression | null {
  const expression = unwrapExpression(node);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : null;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function storeBoundaryAnalysis(program: ts.Program): StoreBoundaryAnalysis {
  const checker = program.getTypeChecker();
  const repositorySource = program.getSourceFile(REPOSITORY_PATH);
  const storeSource = program.getSourceFile(STORE_PATH);
  if (!repositorySource || !storeSource) throw new Error("Demo repository sources were not loaded by TypeScript");

  const storeModuleSymbol = checker.getSymbolAtLocation(storeSource);
  if (!storeModuleSymbol) throw new Error("Demo store module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(storeModuleSymbol);
  const storeExport = compilerExports.find((symbol) => symbol.name === "DemoRepositoryStore");
  if (!storeExport) throw new Error("DemoRepositoryStore export was not resolved");
  const storeSymbol = storeExport.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(storeExport)
    : storeExport;

  const productionReferences: string[] = [];
  const productionAllocations: string[] = [];
  const productionLoaderCalls: string[] = [];
  const productionLoaderFactoryReferences: string[] = [];
  const productionModuleObjectMutations: string[] = [];
  const storeModuleEdges: string[] = [];
  const storeModuleSpecifierMentions: string[] = [];
  const moduleEdge = (source: ts.SourceFile, kind: string, specifier: ts.StringLiteralLike, text: string): void => {
    const resolution = ts.resolveModuleName(
      specifier.text,
      source.fileName,
      program.getCompilerOptions(),
      ts.sys
    ).resolvedModule;
    if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(STORE_PATH)) {
      storeModuleEdges.push(
        `${relativeSourceName(source)}:${kind}:${text.replace(/\s+/g, " ").trim()}`
      );
    }
  };
  for (const source of program.getSourceFiles()) {
    const sourcePath = path.resolve(source.fileName);
    if (
      source.isDeclarationFile ||
      (sourcePath !== API_SOURCE_DIRECTORY && !sourcePath.startsWith(`${API_SOURCE_DIRECTORY}${path.sep}`))
    ) continue;
    const isRepositoryGraphSource = sourcePath === path.resolve(REPOSITORY_PATH) ||
      sourcePath.startsWith(`${path.resolve(REPOSITORY_SOURCE_DIRECTORY)}${path.sep}`);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const resolution = ts.resolveModuleName(
          node.text,
          source.fileName,
          program.getCompilerOptions(),
          ts.sys
        ).resolvedModule;
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(STORE_PATH)) {
          storeModuleSpecifierMentions.push(
            `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.getText(source)}`
          );
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        moduleEdge(source, "static-import", node.moduleSpecifier, node.getText(source));
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        moduleEdge(source, "re-export", node.moduleSpecifier, node.getText(source));
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        moduleEdge(source, "import-equals", node.moduleReference.expression, node.getText(source));
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        productionLoaderCalls.push(
          `${relativeSourceName(source)}:${node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require"}:${node.getText(source)}`
        );
        if (argument && ts.isStringLiteralLike(argument)) {
          moduleEdge(source, "dynamic-loader", argument, node.getText(source));
        }
      }
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        let loaderFactoryName: string | undefined;
        if (ts.isPropertyAccessExpression(node)) loaderFactoryName = node.name.text;
        else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
          loaderFactoryName = node.argumentExpression.text;
        } else if (
          ts.isIdentifier(node) &&
          !ts.isPropertyAccessExpression(node.parent) &&
          !ts.isElementAccessExpression(node.parent)
        ) {
          loaderFactoryName = resolvedSymbol(checker, node)?.name;
        }
        if (loaderFactoryName === "createRequire" || loaderFactoryName === "getBuiltinModule") {
          productionLoaderFactoryReferences.push(
            `${relativeSourceName(source)}:${node.getText(source)}`
          );
        }
      }
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        resolvedConstructorSymbol(checker, node) === storeSymbol &&
        !(
          (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
          resolvedConstructorSymbol(checker, node.parent) === storeSymbol
        )
      ) {
        productionReferences.push(
          `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.getText(source)}`
        );
      }
      if (ts.isNewExpression(node) && resolvedConstructorSymbol(checker, node.expression) === storeSymbol) {
        productionAllocations.push(`${relativeSourceName(source)}:${node.getText(source)}`);
      }
      if (isRepositoryGraphSource && ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        const receiver = propertyReceiver(node.left);
        if (receiver && expressionHasModuleOrigin(checker, receiver)) {
          productionModuleObjectMutations.push(
            `${relativeSourceName(source)}:${node.left.getText(source)}:${node.operatorToken.getText(source)}`
          );
        }
      } else if (isRepositoryGraphSource &&
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const receiver = propertyReceiver(node.operand);
        if (receiver && expressionHasModuleOrigin(checker, receiver)) {
          productionModuleObjectMutations.push(`${relativeSourceName(source)}:${node.getText(source)}`);
        }
      } else if (isRepositoryGraphSource && ts.isDeleteExpression(node)) {
        const receiver = propertyReceiver(node.expression);
        if (receiver && expressionHasModuleOrigin(checker, receiver)) {
          productionModuleObjectMutations.push(`${relativeSourceName(source)}:${node.getText(source)}`);
        }
      } else if (isRepositoryGraphSource && ts.isCallExpression(node) && node.arguments[0]) {
        const callee = unwrapExpression(node.expression);
        const mutatorName = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
            ? callee.argumentExpression.text
            : undefined;
        const targetArgumentMutators = [
          "assign",
          "defineProperties",
          "defineProperty",
          "deleteProperty",
          "setPrototypeOf"
        ];
        const receiverMutators = [
          "add",
          "clear",
          "copyWithin",
          "delete",
          "fill",
          "pop",
          "push",
          "reverse",
          "set",
          "shift",
          "sort",
          "splice",
          "unshift"
        ];
        const receiver = propertyReceiver(callee);
        if (mutatorName && (
          (targetArgumentMutators.includes(mutatorName) && expressionHasModuleOrigin(checker, node.arguments[0])) ||
          (receiverMutators.includes(mutatorName) && receiver !== null && expressionHasModuleOrigin(checker, receiver))
        )) {
          productionModuleObjectMutations.push(`${relativeSourceName(source)}:${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const repositoryModuleVariables = repositorySource.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations.map((declaration) =>
      printer.printNode(ts.EmitHint.Unspecified, declaration, repositorySource)
        .replace(/\s+/g, " ")
        .trim()
    ));
  const repositoryImports = repositorySource.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, repositorySource)
      .replace(/\s+/g, " ")
      .trim());
  const repositoryGraphSources = program.getSourceFiles()
    .filter((source) => {
      const sourcePath = path.resolve(source.fileName);
      return sourcePath === path.resolve(REPOSITORY_PATH) ||
        sourcePath.startsWith(`${path.resolve(REPOSITORY_SOURCE_DIRECTORY)}${path.sep}`);
    })
    .sort((left, right) => relativeSourceName(left).localeCompare(relativeSourceName(right)));
  const repositoryGraphModuleVariables = repositoryGraphSources.flatMap((source) => source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations.map((declaration) =>
      `${relativeSourceName(source)}:${printer.printNode(ts.EmitHint.Unspecified, declaration, source)
        .replace(/\s+/g, " ")
        .trim()}`
    )));
  const repositoryGraphStaticOrAccessorMembers = repositoryGraphSources.flatMap((source) => source.statements
    .filter(ts.isClassDeclaration)
    .flatMap((declaration) => declaration.members
      .filter((member) =>
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member) ||
        (ts.canHaveModifiers(member) &&
          ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true)
      )
      .map((member) => `${relativeSourceName(source)}:${ts.SyntaxKind[member.kind]}:${member.name?.getText(source) ?? "<anonymous>"}`)));
  const repositoryTopLevelDeclarations = repositorySource.statements
    .filter((statement) => !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
    .flatMap((statement) => {
      if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.map((declaration) =>
          `VariableStatement:${declaration.name.getText(repositorySource)}`
        );
      }
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
      ) return [`${ts.SyntaxKind[statement.kind]}:${statement.name?.getText(repositorySource) ?? "<anonymous>"}`];
      return [ts.SyntaxKind[statement.kind]];
    });
  const repositoryClasses = repositorySource.statements
    .filter(ts.isClassDeclaration)
    .map((declaration) => declaration.name?.text ?? "<anonymous>");
  const repositoryDeclaration = classDeclaration(repositorySource, "DemoRepository");
  const repositoryUnexpectedMemberKinds = repositoryDeclaration.members
    .filter((member) =>
      !ts.isPropertyDeclaration(member) &&
      !ts.isConstructorDeclaration(member) &&
      !ts.isMethodDeclaration(member)
    )
    .map((member) => ts.SyntaxKind[member.kind]);
  const repositoryUnexpectedStatements = repositorySource.statements
    .filter((statement) =>
      ts.isExpressionStatement(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    )
    .map((statement) => ts.SyntaxKind[statement.kind]);
  const storeDeclaration = classDeclaration(storeSource, "DemoRepositoryStore");
  const storeTopLevelDeclarations = storeSource.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => ts.isClassDeclaration(statement)
      ? `ClassDeclaration:${statement.name?.text ?? "<anonymous>"}`
      : ts.SyntaxKind[statement.kind]);

  return {
    compilerExports: compilerExports.map((symbol) => symbol.name).sort(),
    productionAllocations: productionAllocations.sort(),
    productionLoaderFactoryReferences: productionLoaderFactoryReferences.sort(),
    productionLoaderCalls: productionLoaderCalls.sort(),
    productionModuleObjectMutations: productionModuleObjectMutations.sort(),
    productionReferences: productionReferences.sort(),
    repositoryGraphFiles: repositoryGraphSources.map(relativeSourceName),
    repositoryGraphModuleVariables,
    repositoryGraphStaticOrAccessorMembers,
    repositoryClasses,
    repositoryImports,
    repositoryUnexpectedMemberKinds,
    repositoryModuleVariables,
    repositoryTopLevelDeclarations,
    repositoryUnexpectedStatements,
    storeModuleEdges: storeModuleEdges.sort(),
    storeModuleSpecifierMentions: storeModuleSpecifierMentions.sort(),
    storeMemberKinds: storeDeclaration.members.map((member) => ts.SyntaxKind[member.kind]),
    storeTopLevelDeclarations
  };
}

function replaceOnce(source: string, search: string, replacement: string): string {
  const index = source.indexOf(search);
  if (index === -1) throw new Error(`Mutation target not found: ${search}`);
  if (source.indexOf(search, index + search.length) !== -1) {
    throw new Error(`Mutation target is not unique: ${search}`);
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

describe("DemoRepository shared store", () => {
  it("owns the exact mutable state inventory without changing the public repository module", () => {
    const store = new DemoRepositoryStore();
    expect(Object.keys(store)).toEqual(EXPECTED_STORE_FIELDS);
    expect(Object.keys(demoStoreModule)).toEqual(["DemoRepositoryStore"]);
    expect("DemoRepositoryStore" in repositoryModule).toBe(false);

    const first = Reflect.get(new DemoRepository(), "store") as unknown;
    const second = Reflect.get(new DemoRepository(), "store") as unknown;
    expect(first).toBeInstanceOf(DemoRepositoryStore);
    expect(second).toBeInstanceOf(DemoRepositoryStore);
    expect(first).not.toBe(second);
  });

  it("keeps one facade-owned store and routes every state access through it", () => {
    const repositorySource = sourceFile("../src/repository.ts");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const criterionSuiteRepository = classDeclaration(
      sourceFile("../src/repository/demo-criteria.ts"),
      "DemoCriterionSuiteRepository"
    );
    const projectRepository = classDeclaration(
      sourceFile("../src/repository/demo-projects.ts"),
      "DemoProjectRepository"
    );
    const skillLifecycleRepository = classDeclaration(
      sourceFile("../src/repository/demo-skills.ts"),
      "DemoSkillLifecycleRepository"
    );
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
    const properties = repository.members.filter(ts.isPropertyDeclaration);
    expect(properties.map((property) =>
      printer.printNode(ts.EmitHint.Unspecified, property, repositorySource).replace(/\s+/g, " ").trim()
    )).toEqual([
      "private readonly criterionSuiteRepository: DemoCriterionSuiteRepository;",
      "private readonly projectRepository: DemoProjectRepository;",
      "private readonly skillLifecycleRepository: DemoSkillLifecycleRepository;",
      "private readonly store = new DemoRepositoryStore();"
    ]);

    const constructors = repository.members.filter(ts.isConstructorDeclaration);
    expect(constructors).toHaveLength(1);
    expect(constructors[0]?.parameters.map((parameter) =>
      printer.printNode(ts.EmitHint.Unspecified, parameter, repositorySource).replace(/\s+/g, " ").trim()
    )).toEqual([
      "private readonly judgeProvider: JudgeProvider = new MockJudgeProvider()",
      "options: { seedVerdicts?: boolean; } = {}"
    ]);
    expect(demoStoreCreations(repository, repositorySource)).toEqual(["new DemoRepositoryStore()"]);
    expect(storeAccessNames(repository, criterionSuiteRepository, projectRepository, skillLifecycleRepository))
      .toEqual([...EXPECTED_STORE_FIELDS].sort());
  });

  it("pins store ownership across production and module state across the repository graph", () => {
    const analysis = storeBoundaryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoRepositoryStore"]);
    expect(analysis.storeModuleEdges).toEqual([
      'repository.ts:static-import:import { DemoRepositoryStore } from "./repository/demo-store.js";',
      'repository/demo-criteria.ts:static-import:import type { DemoRepositoryStore } from "./demo-store.js";',
      'repository/demo-projects.ts:static-import:import type { DemoRepositoryStore } from "./demo-store.js";',
      'repository/demo-skills.ts:static-import:import type { DemoRepositoryStore } from "./demo-store.js";'
    ]);
    expect(analysis.storeModuleSpecifierMentions).toEqual([
      'repository.ts:ImportDeclaration:"./repository/demo-store.js"',
      'repository/demo-criteria.ts:ImportDeclaration:"./demo-store.js"',
      'repository/demo-projects.ts:ImportDeclaration:"./demo-store.js"',
      'repository/demo-skills.ts:ImportDeclaration:"./demo-store.js"'
    ]);
    expect(analysis.productionLoaderCalls).toEqual([]);
    expect(analysis.productionLoaderFactoryReferences).toEqual([]);
    expect(analysis.productionModuleObjectMutations).toEqual([
      "repository/demo-skills.ts:demoSkill.isStarter:="
    ]);
    expect(analysis.productionAllocations).toEqual([
      "repository.ts:new DemoRepositoryStore()"
    ]);
    expect(analysis.productionReferences).toEqual([
      "repository.ts:ImportSpecifier:DemoRepositoryStore",
      "repository.ts:NewExpression:DemoRepositoryStore",
      "repository/demo-criteria.ts:ImportSpecifier:DemoRepositoryStore",
      "repository/demo-criteria.ts:TypeReference:DemoRepositoryStore",
      "repository/demo-projects.ts:ImportSpecifier:DemoRepositoryStore",
      "repository/demo-projects.ts:TypeReference:DemoRepositoryStore",
      "repository/demo-skills.ts:ImportSpecifier:DemoRepositoryStore",
      "repository/demo-skills.ts:TypeReference:DemoRepositoryStore",
      "repository/demo-store.ts:ClassDeclaration:DemoRepositoryStore"
    ]);
    expect(analysis.repositoryClasses).toEqual(["DemoRepository"]);
    expect(analysis.repositoryGraphFiles).toEqual([
      "repository.ts",
      "repository/contracts.ts",
      "repository/demo-criteria.ts",
      "repository/demo-projects.ts",
      "repository/demo-skills.ts",
      "repository/demo-store.ts",
      "repository/errors.ts",
      "repository/helpers.ts",
      "repository/ports.ts"
    ]);
    expect(analysis.repositoryGraphModuleVariables).toMatchSnapshot("repository graph module state");
    expect(analysis.repositoryGraphStaticOrAccessorMembers).toEqual([]);
    expect(analysis.repositoryImports).toMatchSnapshot("demo repository imports");
    expect(analysis.repositoryUnexpectedMemberKinds).toEqual([]);
    expect(analysis.repositoryModuleVariables).toEqual([
      'DEMO_ACTOR_NAMES = new Map<string, string>([ ["user_maya", "Maya"], ["user_jules", "Jules"], ["user_priya", "Priya"] ])'
    ]);
    expect(analysis.repositoryTopLevelDeclarations).toEqual([
      "TypeAliasDeclaration:BinaryJudgeProvider",
      "InterfaceDeclaration:CoevalRepository",
      "ClassDeclaration:DemoRepository",
      "FunctionDeclaration:toPublicLangSmithIntegration",
      "FunctionDeclaration:toPublicIronsideIntegration",
      "FunctionDeclaration:toPublicLangfuseIntegration",
      "FunctionDeclaration:runGoldenSetRegression",
      "FunctionDeclaration:previousVerdictsFromRun",
      "FunctionDeclaration:buildGoldenSetHealthSummary",
      "FunctionDeclaration:duplicateGoldenSetGroups",
      "FunctionDeclaration:ageInDays",
      "FunctionDeclaration:goldenSetHealthRecommendations",
      "FunctionDeclaration:demoTraceForGoldenEntry",
      "VariableStatement:DEMO_ACTOR_NAMES",
      "FunctionDeclaration:attachDemoActorNames"
    ]);
    expect(analysis.repositoryUnexpectedStatements).toEqual([]);
    expect(analysis.storeTopLevelDeclarations).toEqual(["ClassDeclaration:DemoRepositoryStore"]);
    expect(analysis.storeMemberKinds).toEqual(
      EXPECTED_STORE_FIELDS.map(() => "PropertyDeclaration")
    );
  }, 30_000);

  it("rejects aliased and reflective allocations plus type-erased module loading", () => {
    const repositorySource = fs.readFileSync(REPOSITORY_PATH, "utf8");
    const allocationMutation = replaceOnce(
      repositorySource,
      "  async listProjects(): Promise<Project[]> {",
      "  async listProjects(): Promise<Project[]> {\n" +
        "    const DetachedDemoRepositoryStore = DemoRepositoryStore;\n" +
        "    void new DetachedDemoRepositoryStore();\n" +
        "    void Reflect.construct(DemoRepositoryStore, []);"
    );
    const allocationAnalysis = storeBoundaryAnalysis(createApiProgram(new Map([
      [REPOSITORY_PATH, allocationMutation]
    ])));
    expect(allocationAnalysis.productionAllocations).toEqual([
      "repository.ts:new DemoRepositoryStore()",
      "repository.ts:new DetachedDemoRepositoryStore()"
    ]);
    expect(allocationAnalysis.productionReferences).toContain(
      "repository.ts:CallExpression:DemoRepositoryStore"
    );

    const erasedModuleMutation = replaceOnce(
      repositorySource,
      'import { DemoRepositoryStore } from "./repository/demo-store.js";',
      'import { DemoRepositoryStore } from "./repository/demo-store.js";\n' +
        'import * as HiddenDemoStoreNamespace from "./repository/demo-store.js";'
    );
    const erasedAllocationAndLoaderMutation = replaceOnce(
      erasedModuleMutation,
      "  async listProjects(): Promise<Project[]> {",
      "  async listProjects(): Promise<Project[]> {\n" +
        '    void new (HiddenDemoStoreNamespace as any)["DemoRepositoryStore"]();\n' +
        '    void import("./repository/demo-store.js").then((module: any) => new module["DemoRepositoryStore"]());\n' +
        '    const hiddenRequire = process.getBuiltinModule("node:module").createRequire(import.meta.url);\n' +
        '    const hiddenStoreModule = hiddenRequire("./repository/demo-store.js") as any;\n' +
        '    void new hiddenStoreModule["DemoRepositoryStore"]();'
    );
    const erasedModuleAnalysis = storeBoundaryAnalysis(createApiProgram(new Map([
      [REPOSITORY_PATH, erasedAllocationAndLoaderMutation]
    ])));
    expect(erasedModuleAnalysis.storeModuleEdges).toEqual([
      'repository.ts:dynamic-loader:import("./repository/demo-store.js")',
      'repository.ts:static-import:import * as HiddenDemoStoreNamespace from "./repository/demo-store.js";',
      'repository.ts:static-import:import { DemoRepositoryStore } from "./repository/demo-store.js";',
      'repository/demo-criteria.ts:static-import:import type { DemoRepositoryStore } from "./demo-store.js";',
      'repository/demo-projects.ts:static-import:import type { DemoRepositoryStore } from "./demo-store.js";',
      'repository/demo-skills.ts:static-import:import type { DemoRepositoryStore } from "./demo-store.js";'
    ]);
    expect(erasedModuleAnalysis.productionLoaderCalls).toEqual([
      'repository.ts:import:import("./repository/demo-store.js")'
    ]);
    expect(erasedModuleAnalysis.productionLoaderFactoryReferences).toEqual([
      'repository.ts:process.getBuiltinModule',
      'repository.ts:process.getBuiltinModule("node:module").createRequire'
    ]);
    expect(erasedModuleAnalysis.storeModuleSpecifierMentions).toEqual([
      'repository.ts:CallExpression:"./repository/demo-store.js"',
      'repository.ts:CallExpression:"./repository/demo-store.js"',
      'repository.ts:ImportDeclaration:"./repository/demo-store.js"',
      'repository.ts:ImportDeclaration:"./repository/demo-store.js"',
      'repository/demo-criteria.ts:ImportDeclaration:"./demo-store.js"',
      'repository/demo-projects.ts:ImportDeclaration:"./demo-store.js"',
      'repository/demo-skills.ts:ImportDeclaration:"./demo-store.js"'
    ]);
  }, 30_000);

  it("rejects hidden module state, function-object state, accessors, and extra exports", () => {
    const repositorySource = fs.readFileSync(REPOSITORY_PATH, "utf8");
    const storeSource = fs.readFileSync(STORE_PATH, "utf8");
    const hiddenStateMutation = replaceOnce(
      replaceOnce(
        replaceOnce(
          repositorySource,
          "const DEMO_ACTOR_NAMES = new Map<string, string>([",
          "const HIDDEN_DEMO_STATE = new Map<string, string>();\n" +
            "const DEMO_ACTOR_NAMES = new Map<string, string>(["
        ),
        "function toPublicLangSmithIntegration(integration: LangSmithImportContext): LangSmithIntegration {",
        "function hiddenDemoState(): Map<string, string> {\n" +
          "  return (hiddenDemoState as any).state ??= new Map<string, string>();\n" +
          "}\n\n" +
          "function toPublicLangSmithIntegration(integration: LangSmithImportContext): LangSmithIntegration {"
      ),
      "  async listProjects(): Promise<Project[]> {",
      "  async listProjects(): Promise<Project[]> {\n" +
        '    const localOwner = toPublicLangSmithIntegration as typeof toPublicLangSmithIntegration & { state?: Map<string, string> };\n' +
        '    localOwner.state ??= new Map<string, string>();\n' +
        '    Object.defineProperty(localOwner, "definedState", { value: new Map<string, string>() });\n' +
        '    const importedOwner = traceTestValidationStatus as typeof traceTestValidationStatus & { state?: Map<string, string> };\n' +
        '    importedOwner.state ??= new Map<string, string>();\n' +
        '    Reflect.deleteProperty(importedOwner, "legacyState");\n' +
        '    DEMO_ACTOR_NAMES.set("hidden", "state");\n' +
        '    hiddenDemoState().set("hidden", "state");'
    );
    const helpersSource = fs.readFileSync(REPOSITORY_HELPERS_PATH, "utf8");
    const hiddenHelperStateMutation = replaceOnce(
      helpersSource,
      "): TraceTestValidationStatus {\n  const results = [badResult, goodResult];",
      "): TraceTestValidationStatus {\n" +
        "  const owner = traceTestValidationStatus as typeof traceTestValidationStatus & { state?: Map<string, string> };\n" +
        "  owner.state ??= new Map<string, string>();\n" +
        "  const results = [badResult, goodResult];"
    );
    const accessorAndExportMutation = replaceOnce(
      storeSource,
      "  readonly traces = new Map<string, Trace>();",
      "  get hiddenState(): Map<string, Trace> { return new Map(); }\n" +
        "  readonly traces = new Map<string, Trace>();"
    ) + "\nexport const GLOBAL_DEMO_STORE = new DemoRepositoryStore();\n";
    const shapeAnalysis = storeBoundaryAnalysis(createApiProgram(new Map([
      [REPOSITORY_PATH, hiddenStateMutation],
      [REPOSITORY_HELPERS_PATH, hiddenHelperStateMutation],
      [STORE_PATH, accessorAndExportMutation]
    ])));
    expect(shapeAnalysis.repositoryModuleVariables).not.toEqual([
      'DEMO_ACTOR_NAMES = new Map<string, string>([ ["user_maya", "Maya"], ["user_jules", "Jules"], ["user_priya", "Priya"] ])'
    ]);
    expect(shapeAnalysis.repositoryTopLevelDeclarations).toContain(
      "FunctionDeclaration:hiddenDemoState"
    );
    expect(shapeAnalysis.productionModuleObjectMutations).toEqual([
      "repository.ts:(hiddenDemoState as any).state:??=",
      'repository.ts:DEMO_ACTOR_NAMES.set("hidden", "state")',
      'repository.ts:Object.defineProperty(localOwner, "definedState", { value: new Map<string, string>() })',
      'repository.ts:Reflect.deleteProperty(importedOwner, "legacyState")',
      "repository.ts:importedOwner.state:??=",
      "repository.ts:localOwner.state:??=",
      "repository/demo-skills.ts:demoSkill.isStarter:=",
      "repository/helpers.ts:owner.state:??="
    ]);
    expect(shapeAnalysis.repositoryGraphModuleVariables).not.toEqual(
      storeBoundaryAnalysis(createApiProgram()).repositoryGraphModuleVariables
    );
    expect(shapeAnalysis.repositoryGraphStaticOrAccessorMembers).toContain(
      "repository/demo-store.ts:GetAccessor:hiddenState"
    );
    expect(shapeAnalysis.storeMemberKinds).toContain("GetAccessor");
    expect(shapeAnalysis.compilerExports).toContain("GLOBAL_DEMO_STORE");
    expect(shapeAnalysis.storeTopLevelDeclarations).not.toEqual(["ClassDeclaration:DemoRepositoryStore"]);
  }, 30_000);

  it("rejects typed namespace bracket allocation as a different construction path", () => {
    const repositorySource = fs.readFileSync(REPOSITORY_PATH, "utf8");
    const bracketAllocationMutation = replaceOnce(
      replaceOnce(
        repositorySource,
        'import { DemoRepositoryStore } from "./repository/demo-store.js";',
        'import * as DemoStoreNamespace from "./repository/demo-store.js";'
      ),
      "private readonly store = new DemoRepositoryStore();",
      'private readonly store = new DemoStoreNamespace["DemoRepositoryStore"]();'
    );
    const bracketAllocationAnalysis = storeBoundaryAnalysis(createApiProgram(new Map([
      [REPOSITORY_PATH, bracketAllocationMutation]
    ])));
    expect(bracketAllocationAnalysis.productionAllocations).toEqual([
      'repository.ts:new DemoStoreNamespace["DemoRepositoryStore"]()'
    ]);
    expect(bracketAllocationAnalysis.productionReferences).not.toEqual([
      "repository.ts:ImportSpecifier:DemoRepositoryStore",
      "repository.ts:NewExpression:DemoRepositoryStore",
      "repository/demo-store.ts:ClassDeclaration:DemoRepositoryStore"
    ]);
  }, 30_000);

  it("pins every store field declaration and initializer", () => {
    const storeSource = sourceFile("../src/repository/demo-store.ts");
    const store = classDeclaration(storeSource, "DemoRepositoryStore");
    expect(storeSource.statements.filter(ts.isImportDeclaration).every((statement) =>
      statement.importClause?.isTypeOnly === true
    )).toBe(true);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
    const fields = store.members.filter(ts.isPropertyDeclaration).map((field) => ({
      name: field.name.getText(storeSource),
      declaration: printer.printNode(ts.EmitHint.Unspecified, field, storeSource)
        .replace(/\s+/g, " ")
        .trim()
    }));
    expect(fields.map((field) => field.name)).toEqual(EXPECTED_STORE_FIELDS);
    expect(fields).toMatchSnapshot("demo repository store fields");
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
    expect(imported.items.every((item) => item.created)).toBe(true);
    for (const item of imported.items) {
      expect(store.traces.has(item.caseId)).toBe(true);
      expect(store.traceSources.has(item.caseId)).toBe(true);
      expect(store.caseInputIdentities.has(item.caseId)).toBe(true);
      expect(store.datasetItems.some((candidate) => candidate.caseId === item.caseId)).toBe(true);
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
