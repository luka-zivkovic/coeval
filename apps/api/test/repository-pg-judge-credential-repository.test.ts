import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as judgeCredentialModule from "../src/repository.pg/judge-credential-repository.js";
import * as pgRepositoryModule from "../src/repository.pg.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgJudgeCredentialRepository } from "../src/repository.pg/judge-credential-repository.js";

const EXPECTED_METHODS = [
  "setJudgeProviderKey",
  "listJudgeProviderKeys",
  "deleteJudgeProviderKey",
  "getJudgeProviderCredential"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const JUDGE_CREDENTIAL_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/judge-credential-repository.ts"
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

function judgeCredentialRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const judgeCredentialSource = program.getSourceFile(JUDGE_CREDENTIAL_REPOSITORY_PATH);
  if (!judgeCredentialSource) throw new Error("PostgreSQL judge-credential source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(judgeCredentialSource);
  if (!moduleSymbol) throw new Error("PostgreSQL judge-credential module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgJudgeCredentialRepository");
  if (!classExport) throw new Error("PgJudgeCredentialRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(JUDGE_CREDENTIAL_REPOSITORY_PATH)) {
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
        node.text === "PgJudgeCredentialRepository" &&
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

describe("PostgreSQL judge-credential repository slice", () => {
  it("owns exactly the JudgeCredentialRepositoryPort methods behind direct facade delegates", () => {
    const judgeCredentialSource = sourceFile(JUDGE_CREDENTIAL_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const judgeCredentialRepository = classDeclaration(judgeCredentialSource, "PgJudgeCredentialRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(judgeCredentialModule)).toEqual(["PgJudgeCredentialRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(judgeCredentialSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(judgeCredentialSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgJudgeCredentialRepository"]);
    expect(judgeCredentialRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(judgeCredentialSource))
    )).toEqual(["JudgeCredentialRepositoryPort"]);
    expect(judgeCredentialRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(judgeCredentialSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(judgeCredentialRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, judgeCredentialSource))
    )).toEqual([["private readonly pool: Pool"]]);

    const expectedDelegates = new Map<string, string>([
      ["setJudgeProviderKey", "{ return this.judgeCredentialRepository.setJudgeProviderKey(projectId, provider, apiKey, actorUserId); }"],
      ["listJudgeProviderKeys", "{ return this.judgeCredentialRepository.listJudgeProviderKeys(projectId); }"],
      ["deleteJudgeProviderKey", "{ return this.judgeCredentialRepository.deleteJudgeProviderKey(projectId, provider, actorUserId); }"],
      ["getJudgeProviderCredential", "{ return this.judgeCredentialRepository.getJudgeProviderCredential(projectId, provider); }"]
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
    const analysis = judgeCredentialRepositoryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgJudgeCredentialRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgJudgeCredentialRepository(pool)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgJudgeCredentialRepository } from "./repository.pg/judge-credential-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/judge-credential-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgJudgeCredentialRepository",
      "repository.pg.ts:NewExpression:PgJudgeCredentialRepository",
      "repository.pg.ts:TypeReference:PgJudgeCredentialRepository",
      "repository.pg/judge-credential-repository.ts:ClassDeclaration:PgJudgeCredentialRepository"
    ]);

    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "judgeCredentialRepository") as PgJudgeCredentialRepository;
    expect(slice).toBeInstanceOf(PgJudgeCredentialRepository);
    expect(Object.keys(slice)).toEqual(["pool"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);
  }, 30_000);

  it("keeps key writes and paired audit records inside one caller-owned transaction", async () => {
    const originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "judge-credential-repository-test-secret-at-least-32-bytes";
    try {
      const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
      let released = 0;
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          if (sql.includes("insert into judge_provider_keys")) {
            return {
              rows: [{
                provider: "anthropic",
                key_display: "test…3456",
                created_at: new Date("2026-09-02T00:00:00.000Z")
              }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => {
          released += 1;
        }
      };
      const pool = { connect: async () => client } as unknown as Pool;
      const repository = new PgJudgeCredentialRepository(pool);

      await expect(repository.setJudgeProviderKey(
        "project-1",
        "anthropic",
        "test-secret-raw-key-123456",
        "user-1"
      )).resolves.toEqual({
        provider: "anthropic",
        keyDisplay: "test…3456",
        createdAt: "2026-09-02T00:00:00.000Z"
      });
      expect(calls.map((entry) => entry.sql.replace(/\s+/g, " ").trim())).toEqual([
        "begin",
        expect.stringContaining("insert into judge_provider_keys"),
        expect.stringContaining("insert into audit_logs"),
        "commit"
      ]);
      expect(JSON.stringify(calls)).not.toContain("test-secret-raw-key-123456");
      expect(released).toBe(1);
    } finally {
      if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });

  it("rolls back failed key writes, preserves the original error, and always releases", async () => {
    const originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "judge-credential-repository-test-secret-at-least-32-bytes";
    try {
      const originalError = new Error("audit write failed");
      const calls: string[] = [];
      let released = 0;
      const client = {
        query: async (sql: string) => {
          calls.push(sql.replace(/\s+/g, " ").trim());
          if (sql.includes("insert into judge_provider_keys")) {
            return {
              rows: [{
                provider: "anthropic",
                key_display: "test…3456",
                created_at: new Date("2026-09-02T00:00:00.000Z")
              }],
              rowCount: 1
            };
          }
          if (sql.includes("insert into audit_logs")) throw originalError;
          if (sql === "rollback") throw new Error("rollback failed");
          return { rows: [], rowCount: 1 };
        },
        release: () => {
          released += 1;
        }
      };
      const pool = { connect: async () => client } as unknown as Pool;
      const repository = new PgJudgeCredentialRepository(pool);

      await expect(repository.setJudgeProviderKey(
        "project-1",
        "anthropic",
        "test-secret-raw-key-123456",
        "user-1"
      )).rejects.toBe(originalError);
      expect(calls).toEqual([
        "begin",
        expect.stringContaining("insert into judge_provider_keys"),
        expect.stringContaining("insert into audit_logs"),
        "rollback"
      ]);
      expect(released).toBe(1);
    } finally {
      if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });

  it("keeps owner reads masked, deletion audited, and worker lookup decrypted", async () => {
    const { encryptJson } = await import("../src/lib/encryption.js");
    const originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "judge-credential-repository-test-secret-at-least-32-bytes";
    try {
      const encrypted = encryptJson({ apiKey: "worker-only-secret" });
      const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
      let call = 0;
      const pool = {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          call += 1;
          if (call === 1) {
            return {
              rows: [{
                provider: "anthropic",
                key_display: "masked…cret",
                created_at: new Date("2026-09-02T00:00:00.000Z")
              }],
              rowCount: 1
            };
          }
          if (call === 2 || call === 3) return { rows: [], rowCount: 1 };
          if (call === 4) return { rows: [], rowCount: 0 };
          if (call === 5) return { rows: [{ encrypted_credentials: encrypted }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
      } as unknown as Pool;
      const repository = new PgJudgeCredentialRepository(pool);

      await expect(repository.listJudgeProviderKeys("project-1")).resolves.toEqual([{
        provider: "anthropic",
        keyDisplay: "masked…cret",
        createdAt: "2026-09-02T00:00:00.000Z"
      }]);
      await expect(repository.deleteJudgeProviderKey("project-1", "anthropic")).resolves.toBe(true);
      await expect(repository.deleteJudgeProviderKey("project-1", "openai")).resolves.toBe(false);
      await expect(repository.getJudgeProviderCredential("project-1", "anthropic"))
        .resolves.toBe("worker-only-secret");
      await expect(repository.getJudgeProviderCredential("project-1", "openai"))
        .resolves.toBeNull();

      expect(calls[0]).toEqual({
        sql: `select provider, key_display, created_at from judge_provider_keys
       where project_id = $1 order by provider asc`,
        values: ["project-1"]
      });
      expect(calls[1]).toEqual({
        sql: "delete from judge_provider_keys where project_id = $1 and provider = $2",
        values: ["project-1", "anthropic"]
      });
      expect(calls[2]?.sql).toContain("insert into audit_logs");
      expect(calls[2]?.values?.slice(1)).toEqual([
        "project-1",
        null,
        "project.judge_key.removed",
        "judge_provider_key",
        "anthropic",
        JSON.stringify({ provider: "anthropic" })
      ]);
      expect(calls[3]?.values).toEqual(["project-1", "openai"]);
      expect(calls[4]).toEqual({
        sql: `select encrypted_credentials from judge_provider_keys
       where project_id = $1 and provider = $2`,
        values: ["project-1", "anthropic"]
      });
      expect(calls[5]?.values).toEqual(["project-1", "openai"]);
      expect(JSON.stringify(calls[0])).not.toContain(encrypted);
    } finally {
      if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });
});
