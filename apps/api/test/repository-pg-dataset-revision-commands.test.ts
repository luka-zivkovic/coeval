import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  datasetInputIdentity,
  datasetRevisionContentDigest,
  datasetRevisionDigest
} from "../src/lib/dataset-revision.js";
import { DatasetRevisionConflictError } from "../src/repository.js";
import * as commands from "../src/repository.pg/dataset-revision-commands.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const COMMAND_PATH = path.join(API_DIRECTORY, "src/repository.pg/dataset-revision-commands.ts");
const EXPECTED_COMMAND_EXPORTS = [
  "getOrCreateRegressionDatasetRevisionWithClient",
  "insertDatasetRevisionWithClient",
  "loadHumanVerdictsForCases",
  "resolveCaseInputIdentity",
  "resolveSingletonCriterionVersionForRegression"
] as const;

function sourceFile(): ts.SourceFile {
  return ts.createSourceFile(
    COMMAND_PATH,
    fs.readFileSync(COMMAND_PATH, "utf8"),
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

describe("PostgreSQL dataset-revision client commands", () => {
  it("pins five caller-owned PoolClient commands and their complete private module surface", () => {
    const source = sourceFile();
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMMAND_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Dataset-revision command module symbol was not resolved");

    expect(Object.keys(commands).sort()).toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(functions.map((statement) => statement.name?.text)).toEqual([
      "getOrCreateRegressionDatasetRevisionWithClient",
      "resolveSingletonCriterionVersionForRegression",
      "insertDatasetRevisionWithClient",
      "resolveCaseInputIdentity",
      "loadHumanVerdictsForCases"
    ]);
    expect(functions.map((statement) => statement.parameters[0]?.type?.getText(source)))
      .toEqual(["PoolClient", "PoolClient", "PoolClient", "PoolClient", "PoolClient"]);
    expect(source.statements.filter((statement) =>
      !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement)
    )).toEqual([]);
    expect(source.text).not.toMatch(
      /\.connect\s*\(|\.query\s*\(\s*["'`](?:begin|commit|rollback)\b|\.release\s*\(/i
    );
  }, 30_000);

  it("resolves exactly one criterion version and fails closed otherwise", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const rows: Array<Record<string, unknown>> = [{ id: "criterion-version-1" }];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows };
      }
    } as unknown as PoolClient;

    await expect(commands.resolveSingletonCriterionVersionForRegression(client, "project-1"))
      .resolves.toBe("criterion-version-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(["project-1"]);
    expect(calls[0]?.sql.replace(/\s+/g, " ").trim()).toContain("from criteria criterion join lateral");

    rows.splice(0);
    await expect(commands.resolveSingletonCriterionVersionForRegression(client, "project-1"))
      .rejects.toThrow("Project project-1 requires an explicit criterionVersionId for regression evidence.");
    rows.push({ id: "criterion-version-1" }, { id: "criterion-version-2" });
    await expect(commands.resolveSingletonCriterionVersionForRegression(client, "project-1"))
      .rejects.toBeInstanceOf(DatasetRevisionConflictError);
  });

  it("preserves stored and recovered case-input identities", async () => {
    const existingCalls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const existingClient = {
      query: async (sql: string, values?: unknown[]) => {
        existingCalls.push({ sql, values });
        return { rows: [{ identity_basis: "ignored-legacy-basis", input_digest: "digest-existing" }] };
      }
    } as unknown as PoolClient;

    await expect(commands.resolveCaseInputIdentity(
      existingClient,
      "project-1",
      "case-1",
      { input: { ignored: true } }
    )).resolves.toEqual({ basis: "input-identity/v1", digest: "digest-existing" });
    expect(existingCalls).toHaveLength(1);
    expect(existingCalls[0]?.values).toEqual(["project-1", "case-1"]);

    const recoveredCalls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const recoveredClient = {
      query: async (sql: string, values?: unknown[]) => {
        recoveredCalls.push({ sql, values });
        return { rows: [] };
      }
    } as unknown as PoolClient;
    const expected = datasetInputIdentity({ input: { prompt: "hello" } });
    await expect(commands.resolveCaseInputIdentity(
      recoveredClient,
      "project-1",
      "case-2",
      JSON.stringify({ input: { prompt: "hello" }, output: {} })
    )).resolves.toEqual(expected);
    expect(recoveredCalls).toHaveLength(2);
    expect(recoveredCalls[1]?.sql).toContain("insert into case_input_identity_records");
    expect(recoveredCalls[1]?.values?.slice(1)).toEqual([
      "project-1",
      "case-2",
      expected.basis,
      expected.digest
    ]);

    const missingClient = {
      query: async () => ({ rows: [] })
    } as unknown as PoolClient;
    await expect(commands.resolveCaseInputIdentity(missingClient, "project-1", "case-3", null))
      .rejects.toThrow(
        "Case case-3 has no retained pre-redaction input identity; it remains legacy-exposed and cannot be frozen as exact evidence."
      );
  });

  it("loads only requested human verdict history and preserves per-case order", async () => {
    const noQueryClient = {
      query: async () => {
        throw new Error("empty case ids must not query");
      }
    } as unknown as PoolClient;
    await expect(commands.loadHumanVerdictsForCases(noQueryClient, "project-1", []))
      .resolves.toEqual(new Map());

    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const row = (id: string, caseId: string, source: "human" | "adjudicated", pass: boolean) => ({
      id,
      project_id: "project-1",
      case_id: caseId,
      skill_version_id: "skill-version-1",
      source,
      actor_user_id: "user-1",
      actor_name: "Reviewer",
      payload: JSON.stringify({ kind: "binary", pass, rationale: id }),
      external_run_id: null,
      created_at: "2026-09-02T00:00:00.000Z"
    });
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [
          row("verdict-1", "case-1", "human", true),
          row("verdict-2", "case-1", "adjudicated", false),
          row("verdict-3", "case-2", "human", true)
        ] };
      }
    } as unknown as PoolClient;

    const byCase = await commands.loadHumanVerdictsForCases(
      client,
      "project-1",
      ["case-1", "case-2"],
      "criterion-version-1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual([
      "project-1",
      ["case-1", "case-2"],
      "criterion-version-1"
    ]);
    expect([...byCase.keys()]).toEqual(["case-1", "case-2"]);
    expect(byCase.get("case-1")?.map((verdict) => [verdict.id, verdict.source, verdict.payload]))
      .toEqual([
        ["verdict-1", "human", { kind: "binary", pass: true, rationale: "verdict-1" }],
        ["verdict-2", "adjudicated", { kind: "binary", pass: false, rationale: "verdict-2" }]
      ]);
    expect(byCase.get("case-2")?.map((verdict) => verdict.id)).toEqual(["verdict-3"]);
  });

  it("preserves immutable revision insert order, parent checks, and exposure recording", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
      }
    } as unknown as PoolClient;
    const input = {
      projectId: "project-1",
      seriesId: "series-1",
      sourceDatasetId: "dataset-1",
      criterionVersionId: "criterion-version-1",
      role: "regression_golden" as const,
      sourceKind: "golden_snapshot" as const,
      provenanceLevel: "legacy" as const,
      createdByUserId: "user-1",
      items: [{
        sourceCaseId: "case-1",
        sourceTraceId: "trace-1",
        sourceDatasetItemId: null,
        sourceGoldenEntryId: "golden-1",
        payloadSnapshot: { input: { prompt: "hello" }, output: { answer: "world" }, metadata: {} },
        inputDigest: `sha256:${"0".repeat(64)}`,
        itemDigest: `sha256:${"1".repeat(64)}`,
        referenceLabel: "pass" as const,
        referenceFailStep: null,
        referenceProvenance: {
          kind: "golden_promotion" as const,
          sourceId: "golden-1",
          verdictIds: ["verdict-1"],
          actorUserIds: ["user-1"],
          basis: "Visible golden promotion"
        },
        note: "known good"
      }]
    };

    const revisionId = await commands.insertDatasetRevisionWithClient(client, input);
    expect(revisionId).toMatch(/^dsr_/);
    expect(calls.map((call) => call.sql.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("from dataset_revisions"),
      expect.stringContaining("insert into dataset_revisions"),
      expect.stringContaining("insert into dataset_revision_items"),
      expect.stringContaining("insert into dataset_exposure_events")
    ]);
    expect(calls[1]?.values?.slice(0, 8)).toEqual([
      revisionId,
      "project-1",
      "series-1",
      1,
      "dataset-1",
      null,
      "regression_golden",
      "golden_snapshot"
    ]);
    expect(calls[2]?.values?.slice(1, 5)).toEqual([revisionId, "project-1", 0, "case-1"]);
    expect(calls[3]?.values?.slice(1, 3)).toEqual(["project-1", revisionId]);

    const conflictingClient = {
      query: async () => ({ rows: [{ id: "revision-current", revision_number: 2 }] })
    } as unknown as PoolClient;
    await expect(commands.insertDatasetRevisionWithClient(conflictingClient, {
      ...input,
      expectedParentRevisionId: "revision-expected"
    })).rejects.toThrow("Dataset revision changed from revision-expected to revision-current");

    const reusedCalls: string[] = [];
    const reusedClient = {
      query: async (sql: string) => {
        reusedCalls.push(sql);
        return { rows: [{
          id: "revision-reused",
          revision_number: 3,
          role: input.role,
          content_digest: datasetRevisionContentDigest(input.items.map((item) => item.itemDigest))
        }] };
      }
    } as unknown as PoolClient;
    await expect(commands.insertDatasetRevisionWithClient(reusedClient, {
      ...input,
      reuseLatestContent: true
    })).resolves.toBe("revision-reused");
    expect(reusedCalls).toHaveLength(1);
    expect(reusedCalls[0]).toContain("for update");
  });

  it("reuses an unchanged golden regression pointer without inserting a revision", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const emptyDigest = datasetRevisionDigest({ role: "regression_golden", itemDigests: [] });
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("from projects")) return { rows: [{ id: "project-1" }] };
        if (sql.includes("from golden_set_entries")) return { rows: [] };
        if (sql.includes("from criterion_regression_revisions")) {
          return { rows: [{ revision_id: "revision-existing", revision_digest: emptyDigest }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }
    } as unknown as PoolClient;

    await expect(commands.getOrCreateRegressionDatasetRevisionWithClient(
      client,
      "project-1",
      "criterion-version-1",
      "user-1"
    )).resolves.toBe("revision-existing");
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.sql).join("\n")).not.toContain("insert into");
  });
});
