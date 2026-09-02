import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AssessmentReceiptSchema,
  type AssessmentReceipt
} from "@coeval/shared";
import type { Pool, PoolClient } from "pg";
import ts from "typescript";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  canonicalReceiptBytes,
  evidenceDigestForReceipt,
  receiptArtifactDigest
} from "../src/lib/assessment-receipt.js";
import type { AssessmentReceiptArtifact } from "../src/repository.js";

const receiptCommandMocks = vi.hoisted(() => ({
  mintAssessmentReceiptWithClient: vi.fn()
}));

vi.mock("../src/repository.pg/assessment-receipt-commands.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/repository.pg/assessment-receipt-commands.js")>(),
  mintAssessmentReceiptWithClient: receiptCommandMocks.mintAssessmentReceiptWithClient
}));

import * as assessmentReceiptModule from "../src/repository.pg/assessment-receipt-repository.js";
import * as pgRepositoryModule from "../src/repository.pg.js";
import { PgRepository } from "../src/repository.pg.js";
import { PgAssessmentReceiptRepository } from "../src/repository.pg/assessment-receipt-repository.js";

const EXPECTED_METHODS = [
  "getOrFreezeAssessmentReceipt",
  "getAssessmentReceiptArtifactByReceiptId",
  "listAssessmentReceiptArtifacts",
  "compareAssessmentReceiptCopy",
  "createAssessmentReceiptCorrection"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const ASSESSMENT_RECEIPT_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository.pg/assessment-receipt-repository.ts"
);
const fixture = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL("../../../contracts/fixtures/assessment-receipt-v1.complete.json", import.meta.url)),
  "utf8"
)) as { receipt: unknown };
const ROOT_RECEIPT = AssessmentReceiptSchema.parse(fixture.receipt);
const ROOT_BYTES = canonicalReceiptBytes(ROOT_RECEIPT);

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

function assessmentReceiptRepositoryAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const receiptSource = program.getSourceFile(ASSESSMENT_RECEIPT_REPOSITORY_PATH);
  if (!receiptSource) throw new Error("PostgreSQL assessment-receipt source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(receiptSource);
  if (!moduleSymbol) throw new Error("PostgreSQL assessment-receipt module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "PgAssessmentReceiptRepository");
  if (!classExport) throw new Error("PgAssessmentReceiptRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(ASSESSMENT_RECEIPT_REPOSITORY_PATH)) {
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
        node.text === "PgAssessmentReceiptRepository" &&
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

function rootArtifact(receipt: AssessmentReceipt = ROOT_RECEIPT): AssessmentReceiptArtifact {
  const canonicalBytes = canonicalReceiptBytes(receipt);
  return {
    id: "rart-contract-run-1-v1-r1",
    projectId: receipt.projectId,
    evalRunId: receipt.evalRunId,
    receiptId: receipt.receiptId,
    contractVersion: receipt.schemaVersion,
    artifactRevision: 1,
    canonicalBytes,
    artifactDigest: receiptArtifactDigest(canonicalBytes),
    evidenceDigest: receipt.evidenceDigest,
    sourceSnapshotDigest: `sha256:${"1".repeat(64)}`,
    sourceKind: "historical_freeze",
    predecessorArtifactId: null,
    correctionReason: null,
    createdByUserId: null,
    createdAt: "2026-09-02T00:00:00.000Z"
  };
}

function artifactRow(artifact: AssessmentReceiptArtifact): Record<string, unknown> {
  return {
    id: artifact.id,
    project_id: artifact.projectId,
    eval_run_id: artifact.evalRunId,
    receipt_id: artifact.receiptId,
    contract_version: artifact.contractVersion,
    artifact_revision: artifact.artifactRevision,
    canonical_bytes: artifact.canonicalBytes,
    artifact_digest: artifact.artifactDigest,
    evidence_digest: artifact.evidenceDigest,
    source_snapshot_digest: artifact.sourceSnapshotDigest,
    source_kind: artifact.sourceKind,
    predecessor_artifact_id: artifact.predecessorArtifactId,
    correction_reason: artifact.correctionReason,
    created_by_user_id: artifact.createdByUserId,
    created_at: new Date(artifact.createdAt)
  };
}

function correctedReceipt(root: AssessmentReceipt): AssessmentReceipt {
  const unsigned = {
    ...structuredClone(root),
    receiptId: `${root.receiptId}-correction-2`,
    items: root.items.map((item, index) => index === 0 ? { ...item, judgedLabel: "fail" as const } : item)
  };
  const { evidenceDigest: _old, ...withoutDigest } = unsigned;
  return AssessmentReceiptSchema.parse({
    ...withoutDigest,
    evidenceDigest: evidenceDigestForReceipt(withoutDigest as AssessmentReceipt)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PostgreSQL assessment-receipt repository slice", () => {
  it("owns exactly the AssessmentReceiptRepositoryPort methods behind direct facade delegates", () => {
    const receiptSource = sourceFile(ASSESSMENT_RECEIPT_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const receiptRepository = classDeclaration(receiptSource, "PgAssessmentReceiptRepository");
    const repository = classDeclaration(repositorySource, "PgRepository");

    expect(Object.keys(assessmentReceiptModule)).toEqual(["PgAssessmentReceiptRepository"]);
    expect(Object.keys(pgRepositoryModule)).toEqual(["PgRepository"]);
    expect(receiptSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) && statement.name
        ? statement.name.getText(receiptSource)
        : "<anonymous>"}`))
      .toEqual(["ClassDeclaration:PgAssessmentReceiptRepository"]);
    expect(receiptRepository.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(receiptSource))
    )).toEqual(["AssessmentReceiptRepositoryPort"]);
    expect(receiptRepository.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(receiptSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(receiptRepository.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) => normalized(parameter, receiptSource))
    )).toEqual([["private readonly pool: Pool"]]);

    const expectedDelegates = new Map<string, string>([
      ["getOrFreezeAssessmentReceipt", "{ return this.assessmentReceiptRepository.getOrFreezeAssessmentReceipt(projectId, evalRunId); }"],
      ["getAssessmentReceiptArtifactByReceiptId", "{ return this.assessmentReceiptRepository.getAssessmentReceiptArtifactByReceiptId(projectId, receiptId); }"],
      ["listAssessmentReceiptArtifacts", "{ return this.assessmentReceiptRepository.listAssessmentReceiptArtifacts(projectId, evalRunId); }"],
      ["compareAssessmentReceiptCopy", "{ return this.assessmentReceiptRepository.compareAssessmentReceiptCopy(input); }"],
      ["createAssessmentReceiptCorrection", "{ return this.assessmentReceiptRepository.createAssessmentReceiptCorrection(input); }"]
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
    const analysis = assessmentReceiptRepositoryAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["PgAssessmentReceiptRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.pg.ts:PgRepository.constructor:new PgAssessmentReceiptRepository(pool)"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.pg.ts:ImportDeclaration:import { PgAssessmentReceiptRepository } from "./repository.pg/assessment-receipt-repository.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.pg.ts:ImportDeclaration:"./repository.pg/assessment-receipt-repository.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.pg.ts:ImportSpecifier:PgAssessmentReceiptRepository",
      "repository.pg.ts:NewExpression:PgAssessmentReceiptRepository",
      "repository.pg.ts:TypeReference:PgAssessmentReceiptRepository",
      "repository.pg/assessment-receipt-repository.ts:ClassDeclaration:PgAssessmentReceiptRepository"
    ]);

    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const repository = new PgRepository(pool);
    const slice = Reflect.get(repository, "assessmentReceiptRepository") as PgAssessmentReceiptRepository;
    expect(slice).toBeInstanceOf(PgAssessmentReceiptRepository);
    expect(Object.keys(slice)).toEqual(["pool"]);
    expect(Reflect.get(slice, "pool")).toBe(pool);
  }, 30_000);

  it("keeps historical freeze inside one transaction and rolls back the original failure", async () => {
    const artifact = rootArtifact();
    const events: string[] = [];
    const originalError = new Error("freeze failed");
    const client = {
      query: vi.fn(async (sql: string) => {
        events.push(sql);
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => events.push("release"))
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgAssessmentReceiptRepository(pool);
    receiptCommandMocks.mintAssessmentReceiptWithClient.mockImplementationOnce(async (...args) => {
      events.push("mint");
      expect(args).toEqual([client, ROOT_RECEIPT.projectId, ROOT_RECEIPT.evalRunId, "historical_freeze"]);
      return artifact;
    });

    await expect(repository.getOrFreezeAssessmentReceipt(ROOT_RECEIPT.projectId, ROOT_RECEIPT.evalRunId))
      .resolves.toBe(artifact);
    expect(events).toEqual(["begin", "mint", "commit", "release"]);

    events.splice(0);
    receiptCommandMocks.mintAssessmentReceiptWithClient.mockImplementationOnce(async () => {
      events.push("mint");
      throw originalError;
    });
    await expect(repository.getOrFreezeAssessmentReceipt(ROOT_RECEIPT.projectId, ROOT_RECEIPT.evalRunId))
      .rejects.toBe(originalError);
    expect(events).toEqual(["begin", "mint", "rollback", "release"]);
  });

  it("keeps artifact reads project-scoped, revision-ordered, exact, and fail-closed", async () => {
    const root = rootArtifact();
    const successorReceipt = correctedReceipt(ROOT_RECEIPT);
    const successor = {
      ...rootArtifact(successorReceipt),
      id: "rart-contract-run-1-v1-r2",
      artifactRevision: 2,
      sourceKind: "correction" as const,
      predecessorArtifactId: root.id,
      correctionReason: "Correct label"
    };
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (calls.length === 1) return { rows: [artifactRow(successor)], rowCount: 1 };
        if (calls.length === 2) return { rows: [artifactRow(root), artifactRow(successor)], rowCount: 2 };
        return { rows: [], rowCount: 0 };
      })
    } as unknown as Pool;
    const repository = new PgAssessmentReceiptRepository(pool);

    await expect(repository.getAssessmentReceiptArtifactByReceiptId(root.projectId, successor.receiptId))
      .resolves.toEqual(successor);
    await expect(repository.listAssessmentReceiptArtifacts(root.projectId, root.evalRunId))
      .resolves.toEqual([root, successor]);
    await expect(repository.getAssessmentReceiptArtifactByReceiptId("other-project", successor.receiptId))
      .resolves.toBeNull();

    expect(calls).toEqual([
      {
        sql: "select * from assessment_receipt_artifacts where project_id = $1 and receipt_id = $2",
        values: [root.projectId, successor.receiptId]
      },
      {
        sql: `select * from assessment_receipt_artifacts
       where project_id = $1 and eval_run_id = $2
       order by artifact_revision asc`,
        values: [root.projectId, root.evalRunId]
      },
      {
        sql: "select * from assessment_receipt_artifacts where project_id = $1 and receipt_id = $2",
        values: ["other-project", successor.receiptId]
      }
    ]);
  });

  it("stores and verifies the exact consumer bytes before committing", async () => {
    const root = rootArtifact();
    const events: string[] = [];
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const comparisonRow = {
      id: "rcomp-1",
      project_id: root.projectId,
      eval_run_id: root.evalRunId,
      artifact_id: root.id,
      consumer_receipt_id: root.receiptId,
      consumer_canonical_bytes: ROOT_BYTES,
      consumer_artifact_digest: receiptArtifactDigest(ROOT_BYTES),
      comparison_status: "match",
      created_at: new Date("2026-09-02T00:02:00.000Z")
    };
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        events.push(sql.replace(/\s+/g, " ").trim());
        if (values) queries.push({ sql, values });
        if (sql.includes("select * from assessment_receipt_comparisons")) {
          return { rows: [comparisonRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(() => events.push("release"))
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgAssessmentReceiptRepository(pool);
    receiptCommandMocks.mintAssessmentReceiptWithClient.mockImplementationOnce(async (...args) => {
      events.push("mint");
      expect(args).toEqual([client, root.projectId, root.evalRunId, "historical_freeze"]);
      return root;
    });

    await expect(repository.compareAssessmentReceiptCopy({
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      consumerCanonicalBytes: ROOT_BYTES
    })).resolves.toEqual({
      id: "rcomp-1",
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      artifactId: root.id,
      consumerReceiptId: root.receiptId,
      consumerCanonicalBytes: ROOT_BYTES,
      consumerArtifactDigest: receiptArtifactDigest(ROOT_BYTES),
      comparisonStatus: "match",
      createdAt: "2026-09-02T00:02:00.000Z"
    });
    expect(events).toEqual([
      "begin",
      "mint",
      expect.stringContaining("insert into assessment_receipt_comparisons"),
      expect.stringContaining("select * from assessment_receipt_comparisons"),
      "commit",
      "release"
    ]);
    expect(queries[0]?.values).toEqual([
      expect.stringMatching(/^rcomp_/),
      root.projectId,
      root.evalRunId,
      root.id,
      root.receiptId,
      ROOT_BYTES,
      receiptArtifactDigest(ROOT_BYTES),
      "match"
    ]);
    expect(queries[1]).toEqual({
      sql: `select * from assessment_receipt_comparisons
         where artifact_id = $1 and consumer_artifact_digest = $2`,
      values: [root.id, receiptArtifactDigest(ROOT_BYTES)]
    });

    const mismatchEvents: string[] = [];
    const mismatchClient = {
      query: vi.fn(async (sql: string) => {
        mismatchEvents.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("select * from assessment_receipt_comparisons")) {
          return { rows: [{ ...comparisonRow, artifact_id: "rart-other" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(() => mismatchEvents.push("release"))
    } as unknown as PoolClient;
    const mismatchPool = { connect: vi.fn(async () => mismatchClient) } as unknown as Pool;
    receiptCommandMocks.mintAssessmentReceiptWithClient.mockImplementationOnce(async (...args) => {
      mismatchEvents.push("mint");
      expect(args).toEqual([mismatchClient, root.projectId, root.evalRunId, "historical_freeze"]);
      return root;
    });
    await expect(new PgAssessmentReceiptRepository(mismatchPool).compareAssessmentReceiptCopy({
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      consumerCanonicalBytes: ROOT_BYTES
    })).rejects.toThrow("Persisted consumer receipt comparison does not match its artifact and exact bytes");
    expect(mismatchEvents).toEqual([
      "begin",
      "mint",
      expect.stringContaining("insert into assessment_receipt_comparisons"),
      expect.stringContaining("select * from assessment_receipt_comparisons"),
      "rollback",
      "release"
    ]);

    const invalidPool = { connect: vi.fn() } as unknown as Pool;
    await expect(new PgAssessmentReceiptRepository(invalidPool).compareAssessmentReceiptCopy({
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      consumerCanonicalBytes: Buffer.from("not-json")
    })).rejects.toThrow("Assessment receipt bytes are not valid JSON");
    expect(invalidPool.connect).not.toHaveBeenCalled();
  });

  it("appends a canonical correction after the exact predecessor and commits once", async () => {
    const root = rootArtifact();
    const receipt = correctedReceipt(ROOT_RECEIPT);
    const canonicalBytes = canonicalReceiptBytes(receipt);
    const correction: AssessmentReceiptArtifact = {
      ...rootArtifact(receipt),
      id: "rart_contract-run-1_v1_r2",
      artifactRevision: 2,
      sourceKind: "correction",
      predecessorArtifactId: root.id,
      correctionReason: "Correct first label",
      createdByUserId: "user-1",
      createdAt: "2026-09-02T00:03:00.000Z"
    };
    const events: string[] = [];
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        events.push(sql.replace(/\s+/g, " ").trim());
        if (values) queries.push({ sql, values });
        if (sql.includes("where project_id = $1 and receipt_id = $2")) return { rows: [], rowCount: 0 };
        if (sql.includes("order by artifact_revision desc")) return { rows: [artifactRow(root)], rowCount: 1 };
        if (sql.includes("insert into assessment_receipt_artifacts")) {
          return { rows: [artifactRow(correction)], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => events.push("release"))
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgAssessmentReceiptRepository(pool);
    receiptCommandMocks.mintAssessmentReceiptWithClient.mockImplementationOnce(async (...args) => {
      events.push("mint");
      expect(args).toEqual([client, root.projectId, root.evalRunId, "historical_freeze"]);
      return root;
    });

    await expect(repository.createAssessmentReceiptCorrection({
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      receipt,
      reason: "  Correct first label  ",
      createdByUserId: "user-1"
    })).resolves.toEqual(correction);
    expect(events).toEqual([
      "begin",
      "mint",
      expect.stringContaining("select * from assessment_receipt_artifacts where project_id"),
      expect.stringContaining("order by artifact_revision desc limit 1"),
      expect.stringContaining("insert into assessment_receipt_artifacts"),
      "commit",
      "release"
    ]);
    expect(queries[0]?.values).toEqual([root.projectId, receipt.receiptId]);
    expect(queries[1]?.values).toEqual([root.projectId, root.evalRunId]);
    expect(queries[2]?.values).toEqual([
      "rart_contract-run-1_v1_r2",
      root.projectId,
      root.evalRunId,
      receipt.receiptId,
      2,
      canonicalBytes,
      receiptArtifactDigest(canonicalBytes),
      receipt.evidenceDigest,
      root.id,
      "Correct first label",
      "user-1"
    ]);

    const replayEvents: string[] = [];
    const replayClient = {
      query: vi.fn(async (sql: string) => {
        replayEvents.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("where project_id = $1 and receipt_id = $2")) {
          return { rows: [artifactRow(correction)], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => replayEvents.push("release"))
    } as unknown as PoolClient;
    const replayPool = { connect: vi.fn(async () => replayClient) } as unknown as Pool;
    receiptCommandMocks.mintAssessmentReceiptWithClient.mockImplementationOnce(async (...args) => {
      replayEvents.push("mint");
      expect(args).toEqual([replayClient, root.projectId, root.evalRunId, "historical_freeze"]);
      return root;
    });
    await expect(new PgAssessmentReceiptRepository(replayPool).createAssessmentReceiptCorrection({
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      receipt,
      reason: "Correct first label",
      createdByUserId: "user-1"
    })).resolves.toEqual(correction);
    expect(replayEvents).toEqual([
      "begin",
      "mint",
      expect.stringContaining("select * from assessment_receipt_artifacts where project_id"),
      "commit",
      "release"
    ]);

    const collisionEvents: string[] = [];
    const collisionClient = {
      query: vi.fn(async (sql: string) => {
        collisionEvents.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("where project_id = $1 and receipt_id = $2")) {
          return { rows: [artifactRow(root)], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => collisionEvents.push("release"))
    } as unknown as PoolClient;
    const collisionPool = { connect: vi.fn(async () => collisionClient) } as unknown as Pool;
    receiptCommandMocks.mintAssessmentReceiptWithClient.mockImplementationOnce(async (...args) => {
      collisionEvents.push("mint");
      expect(args).toEqual([collisionClient, root.projectId, root.evalRunId, "historical_freeze"]);
      return root;
    });
    await expect(new PgAssessmentReceiptRepository(collisionPool).createAssessmentReceiptCorrection({
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      receipt,
      reason: "Correct first label"
    })).rejects.toThrow("Correction receiptId is already in use");
    expect(collisionEvents).toEqual([
      "begin",
      "mint",
      expect.stringContaining("select * from assessment_receipt_artifacts where project_id"),
      "rollback",
      "release"
    ]);

    const invalidPool = { connect: vi.fn() } as unknown as Pool;
    await expect(new PgAssessmentReceiptRepository(invalidPool).createAssessmentReceiptCorrection({
      projectId: root.projectId,
      evalRunId: root.evalRunId,
      receipt,
      reason: "   "
    })).rejects.toThrow("Assessment receipt correction reason is required");
    expect(invalidPool.connect).not.toHaveBeenCalled();
  });
});
