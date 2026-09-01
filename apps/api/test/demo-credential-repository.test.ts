import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import * as demoCredentialModule from "../src/repository/demo-credentials.js";
import { DemoCredentialRepository } from "../src/repository/demo-credentials.js";
import type { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
  "setJudgeProviderKey",
  "listJudgeProviderKeys",
  "deleteJudgeProviderKey",
  "getJudgeProviderCredential",
  "createApiKey",
  "listApiKeys",
  "revokeApiKey",
  "resolveApiKey"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const CREDENTIAL_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-credentials.ts"
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

function credentialSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(CREDENTIAL_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo credential repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo credential repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoCredentialRepository");
  if (!classExport) throw new Error("DemoCredentialRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(CREDENTIAL_REPOSITORY_PATH)) {
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
        node.text === "DemoCredentialRepository" &&
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

describe("Demo credential repository slice", () => {
  it("owns exactly the API-key and judge-credential ports behind stable facade delegates", () => {
    const sliceSource = sourceFile(CREDENTIAL_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoCredentialRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoCredentialModule)).toEqual(["DemoCredentialRepository"]);
    expect("DemoCredentialRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual(["ClassDeclaration:DemoCredentialRepository"]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["ApiKeyRepositoryPort", "JudgeCredentialRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      "MethodDeclaration:setJudgeProviderKey",
      "MethodDeclaration:listJudgeProviderKeys",
      "MethodDeclaration:deleteJudgeProviderKey",
      "MethodDeclaration:getJudgeProviderCredential",
      "MethodDeclaration:createApiKey",
      "MethodDeclaration:listApiKeys",
      "MethodDeclaration:revokeApiKey",
      "MethodDeclaration:resolveApiKey"
    ]);
    expect(slice.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, sliceSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([["private readonly store: DemoRepositoryStore"]]);

    const expectedDelegates = new Map<string, string>([
      ["setJudgeProviderKey", "{ return this.credentialRepository.setJudgeProviderKey(projectId, provider, apiKey); }"],
      ["listJudgeProviderKeys", "{ return this.credentialRepository.listJudgeProviderKeys(projectId); }"],
      ["deleteJudgeProviderKey", "{ return this.credentialRepository.deleteJudgeProviderKey(projectId, provider); }"],
      ["getJudgeProviderCredential", "{ return this.credentialRepository.getJudgeProviderCredential(projectId, provider); }"],
      ["createApiKey", "{ return this.credentialRepository.createApiKey(input); }"],
      ["listApiKeys", "{ return this.credentialRepository.listApiKeys(projectId); }"],
      ["revokeApiKey", "{ return this.credentialRepository.revokeApiKey(projectId, apiKeyId); }"],
      ["resolveApiKey", "{ return this.credentialRepository.resolveApiKey(rawKey); }"]
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

  it("constructs one credential slice over the exact facade-owned store", () => {
    const analysis = credentialSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoCredentialRepository"]);
    expect(analysis.allocations).toEqual([
      "repository/demo-composition.ts:createDemoRepositoryComposition:new DemoCredentialRepository(store)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoCredentialRepository } from "./demo-credentials.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:"./demo-credentials.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-composition.ts:ImportSpecifier:DemoCredentialRepository",
      "repository/demo-composition.ts:NewExpression:DemoCredentialRepository",
      "repository/demo-composition.ts:TypeReference:DemoCredentialRepository",
      "repository/demo-credentials.ts:ClassDeclaration:DemoCredentialRepository"
    ]);

    const repository = new DemoRepository();
    const slice = Reflect.get(repository, "credentialRepository") as DemoCredentialRepository;
    expect(slice).toBeInstanceOf(DemoCredentialRepository);
    expect(Object.keys(slice)).toEqual(["store"]);
    expect(Reflect.get(slice, "store")).toBe(Reflect.get(repository, "store"));
  }, 30_000);

  it("keeps judge secrets worker-only while masked reads remain project-scoped and sorted", async () => {
    const repository = new DemoRepository();
    const store = Reflect.get(repository, "store") as DemoRepositoryStore;
    const anthropicRaw = "test-anthropic-secret-raw-key-abcdef123456";
    const openAiRaw = "test-openai-secret-raw-key-987654321";
    const foreignRaw = "foreign-secret-key-123456789";

    const openAi = await repository.setJudgeProviderKey("project-a", "openai", openAiRaw);
    const anthropic = await repository.setJudgeProviderKey("project-a", "anthropic", anthropicRaw);
    await repository.setJudgeProviderKey("project-b", "anthropic", foreignRaw);
    expect(openAi.keyDisplay).toBe("test-opena…4321");
    expect(anthropic.keyDisplay).toBe("test-anthr…3456");
    expect(JSON.stringify(openAi)).not.toContain(openAiRaw);
    expect(JSON.stringify(anthropic)).not.toContain(anthropicRaw);

    const listed = await repository.listJudgeProviderKeys("project-a");
    expect(listed.map((key) => key.provider)).toEqual(["anthropic", "openai"]);
    expect(JSON.stringify(listed)).not.toContain(anthropicRaw);
    expect(JSON.stringify(listed)).not.toContain(openAiRaw);
    expect(JSON.stringify(listed)).not.toContain(foreignRaw);
    listed[0]!.keyDisplay = "tampered-copy";
    await expect(repository.listJudgeProviderKeys("project-a")).resolves.toEqual([
      expect.objectContaining({ provider: "anthropic", keyDisplay: "test-anthr…3456" }),
      expect.objectContaining({ provider: "openai", keyDisplay: "test-opena…4321" })
    ]);
    expect(await repository.getJudgeProviderCredential("project-a", "anthropic")).toBe(anthropicRaw);
    expect(await repository.getJudgeProviderCredential("project-b", "anthropic")).toBe(foreignRaw);
    expect(await repository.getJudgeProviderCredential("missing-project", "anthropic")).toBeNull();

    const replacement = "replacement-anthropic-key-999999";
    await repository.setJudgeProviderKey("project-a", "anthropic", replacement);
    expect(await repository.getJudgeProviderCredential("project-a", "anthropic")).toBe(replacement);
    expect(store.judgeProviderKeys.size).toBe(3);
    expect(await repository.deleteJudgeProviderKey("project-b", "openai")).toBe(false);
    expect(await repository.deleteJudgeProviderKey("project-a", "anthropic")).toBe(true);
    expect(await repository.deleteJudgeProviderKey("project-a", "anthropic")).toBe(false);
    expect(await repository.getJudgeProviderCredential("project-a", "anthropic")).toBeNull();

    const short = await repository.setJudgeProviderKey("project-a", "custom", "tiny-key");
    expect(short.keyDisplay).toBe("tiny…");
  });

  it("returns each project API key once, persists only its hash, and resolves until revocation", async () => {
    const repository = new DemoRepository();
    const store = Reflect.get(repository, "store") as DemoRepositoryStore;
    const [first, second, foreign] = await (async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime("2026-09-01T00:00:00.000Z");
        const first = await repository.createApiKey({ projectId: "project-a", name: "z-old" });
        vi.setSystemTime("2026-09-01T00:00:01.000Z");
        const second = await repository.createApiKey({ projectId: "project-a", name: "a-new" });
        vi.setSystemTime("2026-09-01T00:00:02.000Z");
        const foreign = await repository.createApiKey({ projectId: "project-b", name: "foreign" });
        return [first, second, foreign] as const;
      } finally {
        vi.useRealTimers();
      }
    })();

    expect(first.key).toMatch(/^coeval_sk_/);
    expect(second.key).toMatch(/^coeval_sk_/);
    expect(foreign.key).toMatch(/^coeval_sk_/);
    expect(first.key).not.toBe(second.key);
    expect(first.key.startsWith(first.keyPrefix.slice(0, -1))).toBe(true);
    expect(JSON.stringify(store.apiKeys)).not.toContain(first.key);
    expect(JSON.stringify(store.apiKeys)).not.toContain(second.key);
    first.name = "tampered-return-copy";

    const listed = await repository.listApiKeys("project-a");
    expect(listed).toHaveLength(2);
    expect(listed.map((key) => key.id)).toEqual([second.id, first.id]);
    expect(listed.find((key) => key.id === first.id)?.name).toBe("z-old");
    expect(JSON.stringify(listed)).not.toContain(first.key);
    expect(JSON.stringify(listed)).not.toContain(second.key);
    expect(await repository.listApiKeys("project-b")).toMatchObject([{ id: foreign.id }]);
    expect(await repository.listApiKeys("missing-project")).toEqual([]);

    expect(await repository.resolveApiKey(first.key)).toEqual({
      projectId: "project-a",
      apiKeyId: first.id
    });
    expect(store.apiKeys.find((entry) => entry.record.id === first.id)?.record.lastUsedAt)
      .toEqual(expect.any(String));
    expect(await repository.resolveApiKey("coeval_sk_missing")).toBeNull();
    expect(await repository.revokeApiKey("project-b", first.id)).toBe(false);
    expect(await repository.revokeApiKey("project-a", first.id)).toBe(true);
    expect(await repository.revokeApiKey("project-a", first.id)).toBe(false);
    expect(await repository.resolveApiKey(first.key)).toBeNull();
    expect(await repository.resolveApiKey(second.key)).toEqual({
      projectId: "project-a",
      apiKeyId: second.id
    });
    await expect(repository.listApiKeys("project-a")).resolves.toContainEqual(
      expect.objectContaining({ id: first.id, revokedAt: expect.any(String) })
    );
  });
});
