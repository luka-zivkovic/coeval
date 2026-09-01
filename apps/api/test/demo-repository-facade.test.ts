import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as rootRepository from "../src/repository.js";
import * as demoRepository from "../src/repository/demo-repository.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const ROOT_REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const DEMO_REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-repository.ts");

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

describe("DemoRepository facade module", () => {
  it("keeps the stable root binding behind one type-only implementation edge", () => {
    const rootSource = sourceFile(ROOT_REPOSITORY_PATH);
    const demoSource = sourceFile(DEMO_REPOSITORY_PATH);
    const program = createApiProgram();
    const compilerDemoSource = program.getSourceFile(DEMO_REPOSITORY_PATH);
    const moduleSymbol = compilerDemoSource && program.getTypeChecker().getSymbolAtLocation(compilerDemoSource);
    if (!moduleSymbol) throw new Error("Demo repository module symbol was not resolved");

    expect(Object.keys(demoRepository)).toEqual(["DemoRepository"]);
    expect(rootRepository.DemoRepository).toBe(demoRepository.DemoRepository);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name))
      .toEqual(["DemoRepository"]);

    expect(rootSource.statements.filter(ts.isExportDeclaration).map((statement) => ({
      module: statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null,
      names: statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : ["*"]
    }))).toEqual([
      { module: "./repository/contracts.js", names: ["*"] },
      { module: "./repository/demo-repository.js", names: ["DemoRepository"] },
      { module: "./repository/errors.js", names: ["*"] },
      {
        module: "./repository/golden-helpers.js",
        names: ["buildGoldenSetHealthSummary", "previousVerdictsFromRun", "runGoldenSetRegression"]
      },
      { module: "./repository/helpers.js", names: ["*"] }
    ]);
    expect(rootSource.statements.filter((statement) =>
      !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)
    ).map((statement) => `${ts.SyntaxKind[statement.kind]}:${
      ts.isInterfaceDeclaration(statement) ? statement.name.text : "<anonymous>"
    }`)).toEqual(["InterfaceDeclaration:CoevalRepository"]);

    expect(demoSource.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) =>
      `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) ? statement.name?.text : "<anonymous>"}`
    )).toEqual(["ClassDeclaration:DemoRepository"]);
    const rootTypeImports = demoSource.statements.filter((statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "../repository.js"
    );
    expect(rootTypeImports).toHaveLength(1);
    expect(rootTypeImports[0]?.importClause?.isTypeOnly).toBe(true);
    expect(rootTypeImports[0]?.importClause?.namedBindings && ts.isNamedImports(rootTypeImports[0].importClause.namedBindings)
      ? rootTypeImports[0].importClause.namedBindings.elements.map((element) => element.name.text)
      : []).toEqual(["CoevalRepository"]);

    const facade = demoSource.statements.find((statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === "DemoRepository"
    );
    if (!facade) throw new Error("DemoRepository declaration not found");
    expect(facade.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(demoSource))
    )).toEqual(["CoevalRepository"]);
    expect(facade.members.filter(ts.isMethodDeclaration)).toHaveLength(161);
  }, 30_000);
});
