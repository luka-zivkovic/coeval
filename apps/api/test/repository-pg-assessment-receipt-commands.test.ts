import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssessmentReceiptSchema, MinimumVerdictOutputSchema } from "@coeval/shared";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  parseCanonicalReceiptBytes,
  receiptSourceSnapshotDigest
} from "../src/lib/assessment-receipt.js";
import { AssessmentReceiptUnavailableError, computeEvalRunSpend } from "../src/repository.js";
import * as commands from "../src/repository.pg/assessment-receipt-commands.js";
import {
  rowToEvalRun,
  rowToEvalRunItem,
  rowToSkillVersion
} from "../src/repository.pg/mappers.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const COMMAND_PATH = path.join(API_DIRECTORY, "src/repository.pg/assessment-receipt-commands.ts");
const EXPECTED_COMMAND_EXPORTS = [
  "bumpEvalRunCounters",
  "mintAssessmentReceiptWithClient"
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

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "eval-run-1",
    project_id: "project-1",
    dataset_id: null,
    dataset_revision_id: null,
    skill_version_id: "skill-version-1",
    trigger: "release_evidence",
    status: "completed",
    blocking: false,
    total_items: 1,
    completed_items: 1,
    failed_items: 0,
    agreed_items: 1,
    error: null,
    source_trace_test_id: null,
    created_at: "2026-09-02T00:00:00.000Z",
    started_at: "2026-09-02T00:00:01.000Z",
    finished_at: "2026-09-02T00:00:02.000Z",
    ...overrides
  };
}

function itemRow(): Record<string, unknown> {
  return {
    id: "eval-run-item-1",
    eval_run_id: "eval-run-1",
    case_id: "case-1",
    dataset_item_id: null,
    dataset_revision_item_id: null,
    client_item_id: "item-a",
    content_digest: `sha256:${"1".repeat(64)}`,
    status: "completed",
    verdict_id: "verdict-1",
    expected_label: "pass",
    expected_fail_step: null,
    failing_step: null,
    result_label: "pass",
    agreement: true,
    latency_ms: 12,
    input_tokens: 10,
    output_tokens: 4,
    provider_metadata: JSON.stringify({
      model: "observed-model",
      requestId: "request-1",
      responseId: "response-1",
      systemFingerprint: null
    }),
    cached: false,
    error: null,
    created_at: "2026-09-02T00:00:00.000Z",
    finished_at: "2026-09-02T00:00:02.000Z"
  };
}

function skillVersionRow(): Record<string, unknown> {
  return {
    id: "skill-version-1",
    skill_id: "skill-1",
    criterion_version_id: "criterion-version-1",
    version: "1.0.0",
    status: "draft",
    rubric_markdown: "Pass correct answers; fail incorrect answers.",
    prompt: "Judge the trace.",
    model_binding: JSON.stringify({
      provider: "mock",
      modelId: "mock",
      modelVersion: "receipt-command-test",
      temperature: 0
    }),
    output_schema: JSON.stringify(MinimumVerdictOutputSchema),
    golden_set_agreement: null,
    too_strict_count: 0,
    too_lenient_count: 0,
    ambiguous_count: 0,
    known_limitations: [],
    verdict_kind: "binary",
    scalar_range: null,
    categorical_choice_scores: null,
    rubric_provenance: "human-authored",
    onboarding_assurance: null,
    regression_dataset_revision_id: null,
    created_at: "2026-09-02T00:00:00.000Z",
    approved_at: null
  };
}

describe("PostgreSQL assessment-receipt client commands", () => {
  it("pins two caller-owned PoolClient commands and their complete private module surface", () => {
    const source = sourceFile();
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMMAND_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Assessment-receipt command module symbol was not resolved");

    expect(Object.keys(commands).sort()).toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(functions.map((statement) => statement.name?.text)).toEqual([
      "mintAssessmentReceiptWithClient",
      "bumpEvalRunCounters"
    ]);
    expect(functions.map((statement) => statement.parameters[0]?.type?.getText(source)))
      .toEqual(["PoolClient", "PoolClient"]);
    expect(source.statements.filter((statement) =>
      !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement)
    )).toEqual([]);
    expect(source.text).not.toMatch(
      /\.connect\s*\(|\.query\s*\(\s*["'`](?:begin|commit|rollback)\b|\.release\s*\(/i
    );
  }, 30_000);

  it("updates counters once and reports only terminal statuses", async () => {
    const statuses = ["pending", "running", "completed", "failed", undefined] as const;
    for (const status of statuses) {
      const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          return { rows: status === undefined ? [] : [{ status }] };
        }
      } as unknown as PoolClient;
      const result = await commands.bumpEvalRunCounters(client, "project-1", "eval-run-1", {
        completed: 2,
        failed: 3,
        agreed: 1,
        error: "first failure"
      });
      expect(result).toBe(status === "completed" || status === "failed");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql.replace(/\s+/g, " ").trim()).toBe(
        "update eval_runs " +
        "set completed_items = completed_items + $3, " +
        "failed_items = failed_items + $4, " +
        "agreed_items = agreed_items + $5, " +
        "error = coalesce(error, $6), " +
        "status = case when completed_items + failed_items + $3 + $4 >= total_items " +
        "then case when completed_items + $3 = 0 and failed_items + $4 > 0 then 'failed' else 'completed' end " +
        "else status end, " +
        "finished_at = case when completed_items + failed_items + $3 + $4 >= total_items then now() else finished_at end " +
        "where id = $1 and project_id = $2 and status in ('pending', 'running') returning status"
      );
      expect(calls[0]?.values).toEqual([
        "eval-run-1",
        "project-1",
        2,
        3,
        1,
        "first failure"
      ]);
    }
  });

  it("locks the run before checking an existing immutable root and returns missing runs", async () => {
    const missingCalls: string[] = [];
    const missingClient = {
      query: async (sql: string) => {
        missingCalls.push(sql);
        return { rows: [] };
      }
    } as unknown as PoolClient;
    await expect(commands.mintAssessmentReceiptWithClient(
      missingClient,
      "project-1",
      "missing-run",
      "historical_freeze"
    )).resolves.toBeNull();
    expect(missingCalls).toHaveLength(1);
    expect(missingCalls[0]).toContain("for update");
  });

  it("fails closed before source loading for non-release and nonterminal runs", async () => {
    for (const [run, reason] of [
      [runRow({ trigger: "api_batch" }), "not_release_evidence"],
      [runRow({ status: "running" }), "not_terminal"]
    ] as const) {
      const calls: string[] = [];
      const client = {
        query: async (sql: string) => {
          calls.push(sql);
          if (calls.length === 1) return { rows: [run] };
          if (calls.length === 2) return { rows: [] };
          throw new Error("source rows must not be loaded after a failed gate");
        }
      } as unknown as PoolClient;
      await expect(commands.mintAssessmentReceiptWithClient(
        client,
        "project-1",
        "eval-run-1",
        "historical_freeze"
      )).rejects.toMatchObject({ reason });
      expect(calls).toHaveLength(2);
    }
  });

  it("fails closed when the pinned skill version has vanished", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("from eval_runs")) return { rows: [runRow()] };
        if (sql.includes("from assessment_receipt_artifacts")) return { rows: [] };
        if (sql.includes("from eval_run_items")) return { rows: [itemRow()] };
        if (sql.includes("from skill_versions")) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }
    } as unknown as PoolClient;
    await expect(commands.mintAssessmentReceiptWithClient(
      client,
      "project-1",
      "eval-run-1",
      "terminal_mint"
    )).rejects.toMatchObject({ reason: "missing_source" });
    expect(calls).toHaveLength(4);
  });

  it("mints exact canonical bytes once and replays the stored root", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let artifactRow: Record<string, unknown> | undefined;
    let currentRun = runRow();
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("from eval_runs")) return { rows: [currentRun] };
        if (sql.includes("from assessment_receipt_artifacts")) {
          return { rows: artifactRow ? [artifactRow] : [] };
        }
        if (sql.includes("from eval_run_items")) return { rows: [itemRow()] };
        if (sql.includes("from skill_versions")) return { rows: [skillVersionRow()] };
        if (sql.includes("insert into assessment_receipt_artifacts")) {
          artifactRow = {
            id: values?.[0],
            project_id: values?.[1],
            eval_run_id: values?.[2],
            receipt_id: values?.[3],
            contract_version: 1,
            artifact_revision: 1,
            canonical_bytes: values?.[4],
            artifact_digest: values?.[5],
            evidence_digest: values?.[6],
            source_snapshot_digest: values?.[7],
            source_kind: values?.[8],
            predecessor_artifact_id: null,
            correction_reason: null,
            created_by_user_id: null,
            created_at: "2026-09-02T00:00:03.000Z"
          };
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }
    } as unknown as PoolClient;

    const first = await commands.mintAssessmentReceiptWithClient(
      client,
      "project-1",
      "eval-run-1",
      "terminal_mint"
    );
    expect(first).toMatchObject({
      id: "rart_eval-run-1_v1_r1",
      sourceKind: "terminal_mint",
      artifactRevision: 1
    });
    const parsed = parseCanonicalReceiptBytes(first!.canonicalBytes);
    expect(AssessmentReceiptSchema.parse(parsed)).toEqual(parsed);
    expect(parsed).toMatchObject({
      projectId: "project-1",
      evalRunId: "eval-run-1",
      schemaVersion: 1,
      status: "complete",
      items: [{ clientItemId: "item-a", judgedLabel: "pass", status: "completed" }]
    });
    const expectedRun = rowToEvalRun(runRow());
    const expectedItems = [rowToEvalRunItem(itemRow())];
    expect(first?.sourceSnapshotDigest).toBe(receiptSourceSnapshotDigest({
      run: { ...expectedRun, items: expectedItems, spend: computeEvalRunSpend(expectedItems) },
      skillVersion: rowToSkillVersion(skillVersionRow())
    }));
    expect(calls.map(({ sql }) => sql.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("from eval_runs where id = $1 and project_id = $2 for update"),
      expect.stringContaining("from assessment_receipt_artifacts"),
      expect.stringContaining("from eval_run_items"),
      expect.stringContaining("from skill_versions"),
      expect.stringContaining("insert into assessment_receipt_artifacts"),
      expect.stringContaining("from assessment_receipt_artifacts")
    ]);

    const beforeReplay = calls.length;
    currentRun = runRow({ trigger: "api_batch", status: "running" });
    const replay = await commands.mintAssessmentReceiptWithClient(
      client,
      "project-1",
      "eval-run-1",
      "historical_freeze"
    );
    expect(replay?.canonicalBytes.equals(first!.canonicalBytes)).toBe(true);
    expect(calls.slice(beforeReplay).map(({ sql }) => sql.replace(/\s+/g, " ").trim()))
      .toEqual([
        expect.stringContaining("from eval_runs where id = $1 and project_id = $2 for update"),
        expect.stringContaining("from assessment_receipt_artifacts")
      ]);
  });

  it("fails if the immutable root vanishes after the idempotent insert", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("from eval_runs")) return { rows: [runRow()] };
        if (sql.includes("from assessment_receipt_artifacts")) return { rows: [] };
        if (sql.includes("from eval_run_items")) return { rows: [itemRow()] };
        if (sql.includes("from skill_versions")) return { rows: [skillVersionRow()] };
        if (sql.includes("insert into assessment_receipt_artifacts")) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }
    } as unknown as PoolClient;
    await expect(commands.mintAssessmentReceiptWithClient(
      client,
      "project-1",
      "eval-run-1",
      "terminal_mint"
    )).rejects.toThrow("Assessment receipt artifact vanished after mint: eval-run-1");
  });

  it("keeps receipt availability failures as the repository's stable error type", async () => {
    const client = {
      query: async (sql: string) => sql.includes("from eval_runs")
        ? { rows: [runRow({ trigger: "manual" })] }
        : { rows: [] }
    } as unknown as PoolClient;
    await expect(commands.mintAssessmentReceiptWithClient(
      client,
      "project-1",
      "eval-run-1",
      "historical_freeze"
    )).rejects.toBeInstanceOf(AssessmentReceiptUnavailableError);
  });
});
