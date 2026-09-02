import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillVersion } from "@coeval/shared";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as commands from "../src/repository.pg/skill-version-commands.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const COMMAND_PATH = path.join(API_DIRECTORY, "src/repository.pg/skill-version-commands.ts");
const EXPECTED_COMMAND_EXPORTS = [
  "getOrCreateGovernedReviewerSubject",
  "insertSkillVersion",
  "nextVersion"
] as const;
const EXPECTED_SUBJECT_ID = "grs_95325d9944d37e8d6cc6153e5cab447e454ec2882c2198b5";

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

function versionFixture(): SkillVersion {
  return {
    id: "skill-version-2",
    skillId: "skill-1",
    criterionVersionId: "criterion-version-1",
    version: "1.2.4",
    status: "draft",
    rubricMarkdown: "Pass correct answers; fail incorrect answers.",
    prompt: "Judge the trace.",
    modelBinding: {
      provider: "mock",
      modelId: "mock",
      modelVersion: "skill-command-test",
      temperature: 0
    },
    outputSchema: { type: "object", required: ["pass"] },
    goldenSetAgreement: null,
    tooStrictCount: 1,
    tooLenientCount: 2,
    ambiguousCount: 3,
    knownLimitations: ["Known limitation"],
    verdictKind: "scalar",
    scalarRange: [0, 10],
    categoricalChoiceScores: null,
    rubricProvenance: "human-authored",
    onboardingAssurance: "starter_unvalidated",
    regressionDatasetRevisionId: "dataset-revision-1",
    createdAt: "2026-09-02T00:00:00.000Z",
    approvedAt: null
  };
}

describe("PostgreSQL skill-version client commands", () => {
  it("pins three caller-owned PoolClient commands and their complete private module surface", () => {
    const source = sourceFile();
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const program = createApiProgram();
    const compilerSource = program.getSourceFile(COMMAND_PATH);
    const moduleSymbol = compilerSource && program.getTypeChecker().getSymbolAtLocation(compilerSource);
    if (!moduleSymbol) throw new Error("Skill-version command module symbol was not resolved");

    expect(Object.keys(commands).sort()).toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_COMMAND_EXPORTS);
    expect(functions.map((statement) => statement.name?.text)).toEqual([
      "insertSkillVersion",
      "getOrCreateGovernedReviewerSubject",
      "nextVersion"
    ]);
    expect(functions.map((statement) => statement.parameters[0]?.type?.getText(source)))
      .toEqual(["PoolClient", "PoolClient", "PoolClient"]);
    expect(source.statements.filter((statement) =>
      !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement)
    )).toEqual([]);
    expect(source.text).not.toMatch(
      /\.connect\s*\(|\.query\s*\(\s*["'`](?:begin|commit|rollback)\b|\.release\s*\(/i
    );
  }, 30_000);

  it("increments the latest patch version and starts an empty history at 0.0.1", async () => {
    for (const [stored, expected] of [
      [undefined, "0.0.1"],
      ["1.2.3", "1.2.4"],
      ["5", "5.0.1"]
    ] as const) {
      const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          return { rows: stored === undefined ? [] : [{ version: stored }] };
        }
      } as unknown as PoolClient;
      await expect(commands.nextVersion(client, "skill-1")).resolves.toBe(expected);
      expect(calls).toEqual([{
        sql: "select version from skill_versions where skill_id = $1 order by created_at desc limit 1",
        values: ["skill-1"]
      }]);
    }
  });

  it("rejects unverified actor strings without creating governed identity evidence", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }
    } as unknown as PoolClient;

    await expect(commands.getOrCreateGovernedReviewerSubject(client, "project-1", "user-1"))
      .resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql.replace(/\s+/g, " ").trim()).toBe(
      "select 1 from \"user\" account join project_members membership " +
      "on membership.user_id = account.id and membership.project_id = $1 where account.id = $2"
    );
    expect(calls[0]?.values).toEqual(["project-1", "user-1"]);
  });

  it("derives one durable project-scoped subject after membership verification", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("select 1")) return { rows: [{ ok: 1 }], rowCount: 1 };
        if (sql.includes("insert into governed_reviewer_subjects")) return { rows: [], rowCount: 1 };
        if (sql.includes("select id")) return { rows: [{ id: EXPECTED_SUBJECT_ID }], rowCount: 1 };
        throw new Error(`unexpected query: ${sql}`);
      }
    } as unknown as PoolClient;

    await expect(commands.getOrCreateGovernedReviewerSubject(client, "project-1", "user-1"))
      .resolves.toBe(EXPECTED_SUBJECT_ID);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.sql.replace(/\s+/g, " ").trim()).toBe(
      "insert into governed_reviewer_subjects (id, project_id, account_user_id, subject_digest) " +
      "values ($1, $2, $3, governed_content_v1_digest( 'governed-reviewer-subject/v1', " +
      "jsonb_build_object('projectId', $2::text, 'subjectId', $1::text) ) ) on conflict do nothing"
    );
    expect(calls[1]?.values).toEqual([EXPECTED_SUBJECT_ID, "project-1", "user-1"]);
    expect(calls[2]?.values).toEqual(["project-1", "user-1"]);
  });

  it("fails closed if the serialized subject cannot be reread", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("select 1")) return { rows: [{ ok: 1 }], rowCount: 1 };
        return { rows: [], rowCount: sql.includes("insert into") ? 1 : 0 };
      }
    } as unknown as PoolClient;
    await expect(commands.getOrCreateGovernedReviewerSubject(client, "project-1", "user-1"))
      .rejects.toThrow("Unable to establish governed evaluator-author subject");
  });

  it("binds a verified author subject and every immutable version field on one client", async () => {
    const version = versionFixture();
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("select 1")) return { rows: [{ ok: 1 }], rowCount: 1 };
        if (sql.includes("insert into governed_reviewer_subjects")) return { rows: [], rowCount: 1 };
        if (sql.includes("select id")) return { rows: [{ id: EXPECTED_SUBJECT_ID }], rowCount: 1 };
        if (sql.includes("insert into skill_versions")) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected query: ${sql}`);
      }
    } as unknown as PoolClient;

    await commands.insertSkillVersion(
      client,
      version,
      "project-1",
      "criterion-version-1",
      "user-1",
      { idempotencyKey: "idempotency-1", requestDigest: `sha256:${"2".repeat(64)}` }
    );
    expect(calls).toHaveLength(4);
    expect(calls[3]?.sql.replace(/\s+/g, " ").trim()).toBe(
      "insert into skill_versions " +
      "(id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding, " +
      "golden_set_agreement, too_strict_count, too_lenient_count, ambiguous_count, known_limitations, " +
      "verdict_kind, scalar_range, categorical_choice_scores, rubric_provenance, " +
      "regression_dataset_revision_id, created_at, approved_at, criterion_version_id, " +
      "created_by_user_id, created_by_subject_id, developer_identity_status, " +
      "onboarding_idempotency_key, onboarding_request_digest, onboarding_assurance) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)"
    );
    expect(calls[3]?.values).toEqual([
      "skill-version-2",
      "skill-1",
      "project-1",
      "1.2.4",
      "draft",
      version.rubricMarkdown,
      version.prompt,
      JSON.stringify(version.outputSchema),
      JSON.stringify(version.modelBinding),
      null,
      1,
      2,
      3,
      ["Known limitation"],
      "scalar",
      JSON.stringify(version.scalarRange),
      null,
      "human-authored",
      "dataset-revision-1",
      "2026-09-02T00:00:00.000Z",
      null,
      "criterion-version-1",
      "user-1",
      EXPECTED_SUBJECT_ID,
      "recorded",
      "idempotency-1",
      `sha256:${"2".repeat(64)}`,
      "starter_unvalidated"
    ]);
  });

  it("keeps absent or unverified authors unknown without retaining account PII", async () => {
    const version = versionFixture();
    for (const actorUserId of [null, "unverified-user"] as const) {
      const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          if (sql.includes("select 1")) return { rows: [], rowCount: 0 };
          if (sql.includes("insert into skill_versions")) return { rows: [], rowCount: 1 };
          throw new Error(`unexpected query: ${sql}`);
        }
      } as unknown as PoolClient;

      await commands.insertSkillVersion(
        client,
        version,
        "project-1",
        "criterion-version-1",
        actorUserId
      );
      const versionInsert = calls.find(({ sql }) => sql.includes("insert into skill_versions"));
      expect(versionInsert?.values?.slice(22, 28)).toEqual([
        null,
        null,
        "unknown_legacy",
        null,
        null,
        "starter_unvalidated"
      ]);
      expect(calls.filter(({ sql }) => sql.includes("governed_reviewer_subjects"))).toEqual([]);
      expect(calls).toHaveLength(actorUserId === null ? 1 : 2);
    }
  });
});
