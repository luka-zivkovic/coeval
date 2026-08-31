import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const apiSourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const factoryNames = new Set([
  "createEvalRunRequestService",
  "createRequestServices",
  "createSkillVersionResolver",
  "createTokenBucket"
]);

type FactoryReference = {
  factory: string;
  kind: "call" | "import" | "reference";
  file: string;
  owner?: string | undefined;
};

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? "<anonymous>";
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (current.name) return current.name.text;
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        return current.parent.name.text;
      }
      if (ts.isPropertyAssignment(current.parent)) {
        return current.parent.name.getText();
      }
      return "<anonymous>";
    }
    if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)) {
      return current.name.getText();
    }
    if (ts.isConstructorDeclaration(current)) return "constructor";
  }
  return undefined;
}

function ownerForFactoryCall(source: string): string | undefined {
  const file = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.ES2022, true);
  let owner: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "createRequestServices") {
      owner = enclosingFunctionName(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return owner;
}

function referenceKind(identifier: ts.Identifier): Pick<FactoryReference, "kind" | "owner"> {
  if (ts.isImportSpecifier(identifier.parent)) return { kind: "import" };
  if (ts.isCallExpression(identifier.parent) && identifier.parent.expression === identifier) {
    return { kind: "call", owner: enclosingFunctionName(identifier.parent) };
  }
  if (ts.isPropertyAccessExpression(identifier.parent) && identifier.parent.name === identifier &&
    ts.isCallExpression(identifier.parent.parent) && identifier.parent.parent.expression === identifier.parent) {
    return { kind: "call", owner: enclosingFunctionName(identifier.parent.parent) };
  }
  return { kind: "reference" };
}

describe("request service composition boundary", () => {
  it("stops ownership at the nearest function-like boundary", () => {
    expect(ownerForFactoryCall(`
      function createApp() {
        createRequestServices({});
      }
    `)).toBe("createApp");
    expect(ownerForFactoryCall(`
      function createApp() {
        app.use("*", async () => {
          createRequestServices({});
        });
      }
    `)).toBe("<anonymous>");
    expect(ownerForFactoryCall(`
      const container = {
        build() {
          createRequestServices({});
        }
      };
    `)).toBe("build");
  });

  it("keeps one app container and one owner for every subservice factory", async () => {
    const paths = await sourceFiles(apiSourceRoot);
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true
    };
    const program = ts.createProgram(paths, compilerOptions);
    const checker = program.getTypeChecker();
    const references = new Map<string, FactoryReference>();
    const factoryModuleEdges: Array<{
      factory: string;
      file: string;
      kind: "dynamic" | "named" | "namespace" | "re-export" | "side-effect";
      module: string;
    }> = [];

    const recordFactoryModuleEdge = (
      source: ts.SourceFile,
      specifier: ts.StringLiteralLike,
      kind: "dynamic" | "named" | "namespace" | "re-export" | "side-effect",
      importedNames?: readonly string[]
    ): void => {
      const resolved = ts.resolveModuleName(
        specifier.text,
        source.fileName,
        compilerOptions,
        ts.sys
      ).resolvedModule?.resolvedFileName;
      if (!resolved) return;
      const target = program.getSourceFile(resolved);
      if (!target) return;
      const declaredFactories = target.statements.flatMap((statement) =>
        ts.isFunctionDeclaration(statement) && statement.name && factoryNames.has(statement.name.text)
          ? [statement.name.text]
          : []
      );
      for (const factory of declaredFactories) {
        if (importedNames && !importedNames.includes(factory)) continue;
        factoryModuleEdges.push({
          factory,
          file: relative(apiSourceRoot, source.fileName),
          kind,
          module: relative(apiSourceRoot, resolved)
        });
      }
    };

    for (const source of program.getSourceFiles()) {
      if (!paths.includes(source.fileName)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const bindings = node.importClause?.namedBindings;
          if (!node.importClause) {
            recordFactoryModuleEdge(source, node.moduleSpecifier, "side-effect");
          } else if (bindings && ts.isNamespaceImport(bindings)) {
            recordFactoryModuleEdge(source, node.moduleSpecifier, "namespace");
          } else if (bindings && ts.isNamedImports(bindings)) {
            recordFactoryModuleEdge(source, node.moduleSpecifier, "named", bindings.elements.map((element) =>
              (element.propertyName ?? element.name).text
            ));
          }
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)) {
          const names = node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text)
            : undefined;
          recordFactoryModuleEdge(source, node.moduleSpecifier, "re-export", names);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const [argument] = node.arguments;
          if (argument && ts.isStringLiteralLike(argument)) {
            recordFactoryModuleEdge(source, argument, "dynamic");
          }
        }
        if (ts.isIdentifier(node)) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            symbol = checker.getAliasedSymbol(symbol);
          }
          const declaration = symbol?.declarations?.find((candidate) =>
            ts.isFunctionDeclaration(candidate) && candidate.name && factoryNames.has(candidate.name.text)
          );
          if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name &&
            node !== declaration.name) {
            const identityNode = ts.isImportSpecifier(node.parent) ? node.parent : node;
            const classified = referenceKind(node);
            references.set(`${source.fileName}:${identityNode.pos}:${declaration.name.text}`, {
              factory: declaration.name.text,
              ...classified,
              file: relative(apiSourceRoot, source.fileName)
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(factoryModuleEdges.sort((left, right) =>
      left.factory.localeCompare(right.factory) ||
      left.file.localeCompare(right.file) ||
      left.module.localeCompare(right.module) ||
      left.kind.localeCompare(right.kind)
    )).toEqual([
      {
        factory: "createEvalRunRequestService",
        file: "request-services/index.ts",
        kind: "named",
        module: "request-services/eval-runs.ts"
      },
      {
        factory: "createRequestServices",
        file: "app.ts",
        kind: "named",
        module: "request-services/index.ts"
      },
      {
        factory: "createSkillVersionResolver",
        file: "request-services/index.ts",
        kind: "named",
        module: "request-services/skill-versions.ts"
      },
      {
        factory: "createTokenBucket",
        file: "request-services/index.ts",
        kind: "named",
        module: "request-services/rate-limit.ts"
      }
    ]);

    expect([...references.values()].sort((left, right) =>
      left.factory.localeCompare(right.factory) ||
      left.kind.localeCompare(right.kind) ||
      left.file.localeCompare(right.file)
    )).toEqual([
      { factory: "createEvalRunRequestService", kind: "call", file: "request-services/index.ts", owner: "createRequestServices" },
      { factory: "createEvalRunRequestService", kind: "import", file: "request-services/index.ts" },
      { factory: "createRequestServices", kind: "call", file: "app.ts", owner: "createApp" },
      { factory: "createRequestServices", kind: "import", file: "app.ts" },
      { factory: "createSkillVersionResolver", kind: "call", file: "request-services/index.ts", owner: "createRequestServices" },
      { factory: "createSkillVersionResolver", kind: "import", file: "request-services/index.ts" },
      { factory: "createTokenBucket", kind: "call", file: "request-services/index.ts", owner: "createRequestServices" },
      { factory: "createTokenBucket", kind: "import", file: "request-services/index.ts" }
    ]);
  }, 30_000);
});
