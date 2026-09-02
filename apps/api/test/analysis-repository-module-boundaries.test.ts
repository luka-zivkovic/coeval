import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as populationRepositoryModule from "../src/analysis-population/repository.pg.js";
import * as populationSupportModule from "../src/analysis-population/repository.pg-support.js";
import * as studyRepositoryModule from "../src/analysis-study/repository.pg.js";
import * as studySupportModule from "../src/analysis-study/repository.pg-support.js";

const POPULATION_METHODS = [
  "createPopulation",
  "listPopulations",
  "getPopulation",
  "listMembers",
  "listSelections",
  "listExclusions",
  "listOverlaps",
  "getSelectedContent"
] as const;

const STUDY_METHODS = [
  "createStudy",
  "listStudies",
  "getStudy",
  "openStudy",
  "completeStudy",
  "abandonStudy",
  "closeStudy",
  "listStudyItems",
  "listStudyItemEvents",
  "getStudyItem",
  "appendStudyItemEvent",
  "getStudyItemContent",
  "createTaxonomy",
  "getTaxonomy",
  "listTaxonomyRevisions",
  "getTaxonomyRevision",
  "createTaxonomyRevision",
  "listObservationAssignments",
  "appendObservationAssignment",
  "getTaxonomyCoverage",
  "closeDueStudies"
] as const;

const POPULATION_SUPPORT_EXPORTS = [
  "boundErrorCode",
  "decodeCursor",
  "encodeCursor",
  "ensureGovernedSubject",
  "insertCreationExposure",
  "insertDrawItems",
  "insertExclusions",
  "insertMembers",
  "insertRequestAlias",
  "insertRevisionItems",
  "iso",
  "loadCreateResult",
  "mapPgError",
  "parseJson",
  "populationExists",
  "prepareEligibleMembers",
  "repoError",
  "requireProjectRole",
  "rowToExclusion",
  "rowToMember",
  "rowToSelection",
  "rowToSummary",
  "scanWindowPreflight",
  "summarySelect"
] as const;

const STUDY_SUPPORT_EXPORTS = [
  "PLACEHOLDER_DIGEST",
  "appendStudyEvent",
  "closeIfDue",
  "decodeCursor",
  "encodeCursor",
  "ensureDueClosure",
  "ensureGovernedSubject",
  "findAssignmentReplay",
  "findItemEventReplay",
  "findStudyEventReplay",
  "itemEventColumns",
  "itemEventResult",
  "itemExists",
  "loadCoverage",
  "loadStudyItemProjection",
  "loadStudyProjection",
  "loadTaxonomyArtifact",
  "loadTaxonomyRevisionProjection",
  "loadTaxonomyRevisionResult",
  "lockOwnedStudy",
  "lockOwnedTaxonomy",
  "mapPgError",
  "materializeClosure",
  "parseJson",
  "repoError",
  "requireOwnerActor",
  "requireProjectRole",
  "requireStudyProjection",
  "rowToAssignmentEvent",
  "rowToStudyItemEvent",
  "rowToStudyItemProjection",
  "rowToStudySummary",
  "rowToTaxonomyRevision",
  "stableId",
  "studyEventResult",
  "studyExists",
  "studyItemSelect",
  "studySummarySelect",
  "taxonomyExists",
  "transaction",
  "withoutIdempotency"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const POPULATION_REPOSITORY_PATH = path.join(SOURCE_DIRECTORY, "analysis-population/repository.pg.ts");
const POPULATION_PORT_PATH = path.join(SOURCE_DIRECTORY, "analysis-population/repository.ts");
const POPULATION_SUPPORT_PATH = path.join(SOURCE_DIRECTORY, "analysis-population/repository.pg-support.ts");
const STUDY_REPOSITORY_PATH = path.join(SOURCE_DIRECTORY, "analysis-study/repository.pg.ts");
const STUDY_PORT_PATH = path.join(SOURCE_DIRECTORY, "analysis-study/repository.ts");
const STUDY_SUPPORT_PATH = path.join(SOURCE_DIRECTORY, "analysis-study/repository.pg-support.ts");

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
  const declarations = source.statements.filter((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name
  );
  expect(declarations).toHaveLength(1);
  return declarations[0]!;
}

function normalized(node: ts.Node, source: ts.SourceFile): string {
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, source)
    .replace(/\s+/g, " ")
    .trim();
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

function compilerExports(program: ts.Program, modulePath: string): string[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(modulePath);
  if (!source) throw new Error(`Source module was not loaded: ${modulePath}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Source module symbol was not resolved: ${modulePath}`);
  return checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort();
}

function assertPortIdentity(
  program: ts.Program,
  repositoryPath: string,
  repositoryName: string,
  portPath: string,
  portName: string
): void {
  const checker = program.getTypeChecker();
  const repositorySource = program.getSourceFile(repositoryPath)!;
  const portSource = program.getSourceFile(portPath)!;
  const repository = classDeclaration(repositorySource, repositoryName);
  const heritageExpression = repository.heritageClauses?.[0]?.types[0]?.expression;
  expect(heritageExpression?.getText(repositorySource)).toBe(portName);
  const portModule = checker.getSymbolAtLocation(portSource)!;
  const expectedPort = checker.getExportsOfModule(portModule).find((symbol) => symbol.name === portName);
  expect(expectedPort).toBeDefined();
  expect(resolvedSymbol(checker, heritageExpression!)).toBe(expectedPort);
}

function assertRepositoryShape(
  source: ts.SourceFile,
  className: string,
  methodNames: readonly string[]
): void {
  const declaration = classDeclaration(source, className);
  expect(source.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) =>
    `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) ? statement.name?.text : "<anonymous>"}`
  )).toEqual([`ClassDeclaration:${className}`]);
  expect(declaration.members.map((member) => {
    if (ts.isConstructorDeclaration(member)) return "Constructor";
    if (ts.isMethodDeclaration(member)) return `MethodDeclaration:${member.name.getText(source)}`;
    return ts.SyntaxKind[member.kind];
  })).toEqual(["Constructor", ...methodNames.map((name) => `MethodDeclaration:${name}`)]);
  const constructor = declaration.members.find(ts.isConstructorDeclaration)!;
  expect(constructor.parameters.map((parameter) => normalized(parameter, source)))
    .toEqual(["private readonly pool: Pool"]);
  expect(declaration.members.filter(ts.isMethodDeclaration).flatMap((method) =>
    method.parameters
      .filter((parameter) => parameter.initializer)
      .map((parameter) => `${method.name.getText(source)}.${parameter.name.getText(source)}=${parameter.initializer!.getText(source)}`)
  )).toEqual(className === "PgAnalysisStudyRepository"
    ? ["getStudyItemContent.retryAfterDeadline=true"]
    : []);
}

function namespaceReferences(source: ts.SourceFile, namespace: string): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === namespace
    ) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...names].sort();
}

function supportCalls(
  source: ts.SourceFile,
  namespace: string,
  names: readonly string[],
  root: ts.Node = source
): Array<{ name: string; firstArgument: string }> {
  const calls: Array<{ name: string; firstArgument: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === namespace &&
      names.includes(node.expression.name.text)
    ) {
      calls.push({
        name: node.expression.name.text,
        firstArgument: node.arguments[0]?.getText(source) ?? "<missing>"
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function relativeSourceName(source: ts.SourceFile): string {
  return path.relative(SOURCE_DIRECTORY, source.fileName).split(path.sep).join("/");
}

function moduleEdges(program: ts.Program, targetPath: string): string[] {
  const edges: string[] = [];
  for (const source of program.getSourceFiles()) {
    const sourcePath = path.resolve(source.fileName);
    if (
      source.isDeclarationFile ||
      (sourcePath !== SOURCE_DIRECTORY && !sourcePath.startsWith(`${SOURCE_DIRECTORY}${path.sep}`))
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
          path.resolve(resolution.resolvedFileName) === path.resolve(targetPath) &&
          (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent))
        ) {
          edges.push(`${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return edges.sort();
}

function assertSupportShape(source: ts.SourceFile, exports: readonly string[]): void {
  const exportedNames = source.statements.flatMap((statement): string[] => {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    ) === true;
    if (!exported) return [];
    if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text];
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((declaration) => declaration.name.getText(source));
    }
    return [];
  });
  expect(exportedNames.sort()).toEqual(exports);
  expect(source.statements.filter(ts.isClassDeclaration)).toHaveLength(0);
  expect(source.statements.filter(ts.isVariableStatement).flatMap((statement) =>
    statement.declarationList.declarations.map((declaration) => declaration.name.getText(source))
  )).toEqual(source.fileName.includes("analysis-population")
    ? ["SCAN_BATCH_SIZE", "PAYLOAD_SCAN_BATCH_SIZE", "INSERT_BATCH_SIZE"]
    : ["PLACEHOLDER_DIGEST"]);
  expect(source.statements.filter(ts.isVariableStatement).every((statement) =>
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
  )).toBe(true);
}

describe("analysis PostgreSQL repository module boundaries", () => {
  it("keeps the complete public repositories and exact internal support surfaces", () => {
    const populationSource = sourceFile(POPULATION_REPOSITORY_PATH);
    const populationSupportSource = sourceFile(POPULATION_SUPPORT_PATH);
    const studySource = sourceFile(STUDY_REPOSITORY_PATH);
    const studySupportSource = sourceFile(STUDY_SUPPORT_PATH);

    expect(Object.keys(populationRepositoryModule)).toEqual(["PgAnalysisPopulationRepository"]);
    expect(Object.keys(studyRepositoryModule)).toEqual(["PgAnalysisStudyRepository"]);
    expect(Object.keys(populationSupportModule).sort()).toEqual(POPULATION_SUPPORT_EXPORTS);
    expect(Object.keys(studySupportModule).sort()).toEqual(STUDY_SUPPORT_EXPORTS);
    assertRepositoryShape(populationSource, "PgAnalysisPopulationRepository", POPULATION_METHODS);
    assertRepositoryShape(studySource, "PgAnalysisStudyRepository", STUDY_METHODS);
    assertSupportShape(populationSupportSource, POPULATION_SUPPORT_EXPORTS);
    assertSupportShape(studySupportSource, STUDY_SUPPORT_EXPORTS);
    expect(namespaceReferences(populationSource, "populationSupport")).toEqual(POPULATION_SUPPORT_EXPORTS);
    expect(namespaceReferences(studySource, "studySupport")).toEqual(STUDY_SUPPORT_EXPORTS);

    const populationRepository = classDeclaration(populationSource, "PgAnalysisPopulationRepository");
    const createPopulation = populationRepository.members.find((member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText(populationSource) === "createPopulation"
    )!;
    const populationFreezeCalls = supportCalls(populationSource, "populationSupport", [
      "ensureGovernedSubject",
      "insertCreationExposure",
      "insertDrawItems",
      "insertExclusions",
      "insertMembers",
      "insertRequestAlias",
      "insertRevisionItems",
      "loadCreateResult",
      "prepareEligibleMembers",
      "requireProjectRole",
      "scanWindowPreflight"
    ], createPopulation);
    expect(populationFreezeCalls.every((call) => call.firstArgument === "client")).toBe(true);
    expect(Object.fromEntries([...new Set(populationFreezeCalls.map((call) => call.name))].sort().map((name) => [
      name,
      populationFreezeCalls.filter((call) => call.name === name).length
    ]))).toEqual({
      ensureGovernedSubject: 1,
      insertCreationExposure: 1,
      insertDrawItems: 1,
      insertExclusions: 1,
      insertMembers: 1,
      insertRequestAlias: 2,
      insertRevisionItems: 1,
      loadCreateResult: 3,
      prepareEligibleMembers: 1,
      requireProjectRole: 1,
      scanWindowPreflight: 1
    });

    const studyPoolCalls = supportCalls(studySource, "studySupport", [
      "appendStudyEvent",
      "ensureDueClosure",
      "transaction"
    ]);
    expect(studyPoolCalls.every((call) => call.firstArgument === "this.pool")).toBe(true);
    expect(Object.fromEntries(["appendStudyEvent", "ensureDueClosure", "transaction"].map((name) => [
      name,
      studyPoolCalls.filter((call) => call.name === name).length
    ]))).toEqual({ appendStudyEvent: 3, ensureDueClosure: 12, transaction: 12 });
  });

  it("pins the exact support module ownership and repository port symbols", () => {
    const program = createApiProgram();
    expect(compilerExports(program, POPULATION_REPOSITORY_PATH))
      .toEqual(["PgAnalysisPopulationRepository"]);
    expect(compilerExports(program, STUDY_REPOSITORY_PATH))
      .toEqual(["PgAnalysisStudyRepository"]);
    expect(compilerExports(program, POPULATION_SUPPORT_PATH)).toEqual(POPULATION_SUPPORT_EXPORTS);
    expect(compilerExports(program, STUDY_SUPPORT_PATH)).toEqual(STUDY_SUPPORT_EXPORTS);
    assertPortIdentity(
      program,
      POPULATION_REPOSITORY_PATH,
      "PgAnalysisPopulationRepository",
      POPULATION_PORT_PATH,
      "AnalysisPopulationRepository"
    );
    assertPortIdentity(
      program,
      STUDY_REPOSITORY_PATH,
      "PgAnalysisStudyRepository",
      STUDY_PORT_PATH,
      "AnalysisStudyRepository"
    );
    expect(moduleEdges(program, POPULATION_SUPPORT_PATH))
      .toEqual(["analysis-population/repository.pg.ts:ImportDeclaration"]);
    expect(moduleEdges(program, STUDY_SUPPORT_PATH))
      .toEqual(["analysis-study/repository.pg.ts:ImportDeclaration"]);
  }, 30_000);
});
