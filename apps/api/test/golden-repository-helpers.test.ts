import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repository from "../src/repository.js";
import * as goldenHelpers from "../src/repository/golden-helpers.js";

const EXPECTED_PUBLIC_HELPERS = [
  "buildGoldenSetHealthSummary",
  "previousVerdictsFromRun",
  "runGoldenSetRegression"
] as const;

const EXPECTED_ALL_FUNCTIONS = [
  "runGoldenSetRegression",
  "previousVerdictsFromRun",
  "buildGoldenSetHealthSummary",
  "duplicateGoldenSetGroups",
  "ageInDays",
  "goldenSetHealthRecommendations"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const GOLDEN_HELPERS_PATH = path.join(API_SOURCE_DIRECTORY, "repository/golden-helpers.ts");

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

function exported(statement: ts.FunctionDeclaration): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function signature(
  declaration: ts.FunctionDeclaration,
  source: ts.SourceFile,
  printer: ts.Printer
): string {
  return printer.printNode(
    ts.EmitHint.Unspecified,
    ts.factory.updateFunctionDeclaration(
      declaration,
      declaration.modifiers,
      declaration.asteriskToken,
      declaration.name,
      declaration.typeParameters,
      declaration.parameters,
      declaration.type,
      undefined
    ),
    source
  ).replace(/\s+/g, " ").trim();
}

describe("golden repository helpers", () => {
  it("preserves the exact root surface behind one pure helper module", () => {
    const helperSource = sourceFile(GOLDEN_HELPERS_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const functions = helperSource.statements.filter(ts.isFunctionDeclaration);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(GOLDEN_HELPERS_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Golden helper module symbol was not resolved");

    expect(Object.keys(goldenHelpers).sort()).toEqual(EXPECTED_PUBLIC_HELPERS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_PUBLIC_HELPERS);
    for (const name of EXPECTED_PUBLIC_HELPERS) {
      expect(repository[name]).toBe(goldenHelpers[name]);
    }
    expect(functions.map((declaration) => declaration.name?.text)).toEqual(EXPECTED_ALL_FUNCTIONS);
    expect(functions.filter(exported).map((declaration) => declaration.name?.text).sort())
      .toEqual(EXPECTED_PUBLIC_HELPERS);
    expect(functions.map((declaration) => ({
      exported: exported(declaration),
      name: declaration.name?.text,
      signature: signature(declaration, helperSource, printer)
    }))).toMatchSnapshot("golden helper signatures");
    expect(helperSource.statements.filter(ts.isVariableStatement)).toEqual([]);
    expect(helperSource.statements.filter(ts.isClassDeclaration)).toEqual([]);
    expect(helperSource.statements.filter(ts.isTypeAliasDeclaration).map((declaration) => ({
      exported: declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true,
      name: declaration.name.text
    }))).toEqual([{ exported: false, name: "BinaryJudgeProvider" }]);
    expect(helperSource.statements.filter(ts.isImportDeclaration).map((declaration) =>
      (declaration.moduleSpecifier as ts.StringLiteral).text
    )).toEqual([
      "node:crypto",
      "@coeval/audit/runtime",
      "@coeval/shared",
      "./errors.js"
    ]);
    expect(repositorySource.statements.filter((statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./repository/golden-helpers.js"
    ).map((statement) => ts.SyntaxKind[statement.kind])).toEqual([
      "ImportDeclaration",
      "ExportDeclaration"
    ]);
  });
});
