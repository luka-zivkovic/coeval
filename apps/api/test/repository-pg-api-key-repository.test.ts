import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as apiKeyModule from "../src/repository.pg/api-key-repository.js";
import * as pgRepositoryModule from "../src/repository.pg.js";
import { hashApiKey } from "../src/lib/api-keys.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgApiKeyRepository } from "../src/repository.pg/api-key-repository.js";

const EXPECTED_METHODS = [
  "createApiKey",
  "listApiKeys",
  "revokeApiKey",
  "resolveApiKey"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const API_KEY_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/api-key-repository.ts"
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

function apiKeyRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const apiKeySource = program.getSourceFile(API_KEY_REPOSITORY_PATH);
  if (!apiKeySource) throw new Error("PostgreSQL API-key source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(apiKeySource);
  if (!moduleSymbol) throw new Error("PostgreSQL API-key module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgApiKeyRepository");
  if (!classExport) throw new Error("PgApiKeyRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(API_KEY_REPOSITORY_PATH)) {
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
        node.text === "PgApiKeyRepository" &&
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

describe("PostgreSQL API-key repository slice", () => {
  it("owns exactly the ApiKeyRepositoryPort methods behind direct facade delegates", () => {
    const apiKeySource = sourceFile(API_KEY_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const apiKeyRepository = classDeclaration(apiKeySource, "PgApiKeyRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(apiKeyModule)).toEqual(["PgApiKeyRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(apiKeySource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(apiKeySource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgApiKeyRepository"]);
    expect(apiKeyRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(apiKeySource))
    )).toEqual(["ApiKeyRepositoryPort"]);
    expect(apiKeyRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(apiKeySource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(apiKeyRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, apiKeySource))
    )).toEqual([["private readonly pool: Pool"]]);

    const expectedDelegates = new Map<string, string>([
      ["createApiKey", "{ return this.apiKeyRepository.createApiKey(input); }"],
      ["listApiKeys", "{ return this.apiKeyRepository.listApiKeys(projectId); }"],
      ["revokeApiKey", "{ return this.apiKeyRepository.revokeApiKey(projectId, apiKeyId); }"],
      ["resolveApiKey", "{ return this.apiKeyRepository.resolveApiKey(rawKey); }"]
    ]);
    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_METHODS.includes(
        method.name.getText(repositorySource) as typeof EXPECTED_METHODS[number]
      ));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_METHODS);
    for (const method of facadeMethods) {
      expect(normalized(method.body!, repositorySource))
        .toBe(expectedDelegates.get(method.name.getText(repositorySource)));
    }
  });

  it("constructs exactly one stateless slice with the facade pool", () => {
    const analysis = apiKeyRepositoryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgApiKeyRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgApiKeyRepository(pool)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgApiKeyRepository } from "./repository.pg/api-key-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/api-key-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgApiKeyRepository",
      "repository.pg.ts:NewExpression:PgApiKeyRepository",
      "repository.pg.ts:TypeReference:PgApiKeyRepository",
      "repository.pg/api-key-repository.ts:ClassDeclaration:PgApiKeyRepository"
    ]);

    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "apiKeyRepository") as PgApiKeyRepository;
    expect(slice).toBeInstanceOf(PgApiKeyRepository);
    expect(Object.keys(slice)).toEqual(["pool"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);
  }, 30_000);

  it("returns plaintext once while persisting and resolving only the digest", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let call = 0;
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        call += 1;
        if (call === 1 || call === 2) {
          return {
            rows: [{
              id: values?.[0],
              project_id: values?.[1],
              name: values?.[2],
              key_hash: values?.[3],
              key_prefix: values?.[4],
              created_at: createdAt,
              last_used_at: null,
              revoked_at: null
            }],
            rowCount: 1
          };
        }
        if (call === 3) {
          return {
            rows: [{
              id: "apikey-1",
              project_id: "project-1",
              name: "Agent",
              key_hash: "not-public",
              key_prefix: "coeval_sk_abc123…",
              created_at: createdAt,
              last_used_at: null,
              revoked_at: null
            }],
            rowCount: 1
          };
        }
        if (call === 4) return { rows: [], rowCount: 1 };
        if (call === 5) return { rows: [], rowCount: 0 };
        if (call === 6) return { rows: [{ id: "apikey-1", project_id: "project-1" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const repository = new PgApiKeyRepository(pool);

    const created = await repository.createApiKey({
      projectId: "project-1",
      name: "Agent",
      createdByUserId: "user-1"
    });
    expect(created).toEqual({
      id: expect.stringMatching(/^apikey_/),
      projectId: "project-1",
      name: "Agent",
      keyPrefix: `${created.key.slice(0, "coeval_sk_".length + 6)}…`,
      createdAt: createdAt.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      key: expect.stringMatching(/^coeval_sk_[A-Za-z0-9_-]{32}$/)
    });
    expect(Object.keys(created)).toEqual([
      "id",
      "projectId",
      "name",
      "keyPrefix",
      "createdAt",
      "lastUsedAt",
      "revokedAt",
      "key"
    ]);
    expect(calls[0]).toEqual({
      sql: `insert into api_keys (id, project_id, name, key_hash, key_prefix, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6)
       returning *`,
      values: [
        created.id,
        "project-1",
        "Agent",
        hashApiKey(created.key),
        created.keyPrefix,
        "user-1"
      ]
    });
    expect(JSON.stringify(calls[0])).not.toContain(created.key);

    const createdWithoutActor = await repository.createApiKey({
      projectId: "project-1",
      name: "Unowned"
    });
    expect(calls[1]).toEqual({
      sql: calls[0]!.sql,
      values: [
        createdWithoutActor.id,
        "project-1",
        "Unowned",
        hashApiKey(createdWithoutActor.key),
        createdWithoutActor.keyPrefix,
        null
      ]
    });
    expect(JSON.stringify(calls[1])).not.toContain(createdWithoutActor.key);

    await expect(repository.listApiKeys("project-1")).resolves.toEqual([{
      id: "apikey-1",
      projectId: "project-1",
      name: "Agent",
      keyPrefix: "coeval_sk_abc123…",
      createdAt: createdAt.toISOString(),
      lastUsedAt: null,
      revokedAt: null
    }]);
    await expect(repository.revokeApiKey("project-1", "apikey-1")).resolves.toBe(true);
    await expect(repository.revokeApiKey("project-1", "apikey-missing")).resolves.toBe(false);
    await expect(repository.resolveApiKey("coeval_sk_presented")).resolves.toEqual({
      projectId: "project-1",
      apiKeyId: "apikey-1"
    });
    await expect(repository.resolveApiKey("coeval_sk_missing")).resolves.toBeNull();

    expect(calls[2]).toEqual({
      sql: "select * from api_keys where project_id = $1 order by created_at desc",
      values: ["project-1"]
    });
    expect(calls[3]).toEqual({
      sql: `update api_keys set revoked_at = now()
       where id = $1 and project_id = $2 and revoked_at is null`,
      values: ["apikey-1", "project-1"]
    });
    expect(calls[4]?.values).toEqual(["apikey-missing", "project-1"]);
    expect(calls[5]).toEqual({
      sql: `update api_keys set last_used_at = now()
       where key_hash = $1 and revoked_at is null
       returning id, project_id`,
      values: [hashApiKey("coeval_sk_presented")]
    });
    expect(calls[6]?.values).toEqual([hashApiKey("coeval_sk_missing")]);
  });
});
