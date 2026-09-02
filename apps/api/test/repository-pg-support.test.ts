import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as pgRepository from "../src/repository.pg.js";
import * as commands from "../src/repository.pg/golden-commands.js";
import * as mappers from "../src/repository.pg/mappers.js";

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg.ts");
const COMMAND_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg/golden-commands.ts");
const MAPPERS_PATH = path.join(API_SOURCE_DIRECTORY, "repository.pg/mappers.ts");

const EXPECTED_MAPPER_EXPORTS = [
  "GATE_CHECK_RUN_COLUMNS",
  "gateFailureMessage",
  "isCheckViolation",
  "isUniqueViolation",
  "normalizedPayloadSnapshot",
  "parseJson",
  "postgresErrorMessage",
  "rowToApiKey",
  "rowToAssessmentReceiptArtifact",
  "rowToAssessmentReceiptComparison",
  "rowToCriterion",
  "rowToCriterionVersion",
  "rowToDataset",
  "rowToDatasetExposureEvent",
  "rowToDatasetItem",
  "rowToDatasetRevision",
  "rowToDatasetRevisionItem",
  "rowToEvalRun",
  "rowToEvalRunItem",
  "rowToEvaluatorSuite",
  "rowToExceptionCase",
  "rowToFeedbackSyncJobRecord",
  "rowToGateCheck",
  "rowToGateCheckItem",
  "rowToGoldenSetEntry",
  "rowToImportJobRecord",
  "rowToIronsideIntegration",
  "rowToJudgeRun",
  "rowToLangSmithIntegration",
  "rowToLangfuseIntegration",
  "rowToProject",
  "rowToProjectSettings",
  "rowToRegressionRun",
  "rowToReviewQueue",
  "rowToReviewQueueItem",
  "rowToRunComparison",
  "rowToSkill",
  "rowToSkillVersion",
  "rowToTraceTestRevision",
  "rowToTraceTestSummary",
  "rowToTraceTestValidation",
  "rowToVerdictRecord",
  "toFeedbackSyncProvider",
  "toFeedbackSyncStatus",
  "toIso"
] as const;

const EXPECTED_MAPPER_FUNCTIONS = [
  "rowToProject",
  "rowToProjectSettings",
  "rowToCriterion",
  "rowToCriterionVersion",
  "criterionSourceKind",
  "rowToEvaluatorSuite",
  "rowToSkill",
  "rowToGoldenSetEntry",
  "rowToSkillVersion",
  "rowToJudgeRun",
  "isUniqueViolation",
  "isCheckViolation",
  "postgresErrorMessage",
  "rowToTraceTestSummary",
  "rowToTraceTestRevision",
  "rowToTraceTestValidation",
  "rowToDataset",
  "rowToDatasetItem",
  "normalizedPayloadSnapshot",
  "rowToDatasetRevision",
  "rowToDatasetRevisionItem",
  "rowToDatasetExposureEvent",
  "rowToEvalRun",
  "rowToAssessmentReceiptArtifact",
  "rowToAssessmentReceiptComparison",
  "rowToRunComparison",
  "rowToEvalRunItem",
  "rowToGateCheck",
  "rowToGateCheckItem",
  "rowToApiKey",
  "rowToExceptionCase",
  "rowToLangSmithIntegration",
  "rowToLangfuseIntegration",
  "rowToIronsideIntegration",
  "toFeedbackSyncProvider",
  "rowToFeedbackSyncJobRecord",
  "rowToImportJobRecord",
  "toImportJobStatus",
  "rowToVerdictRecord",
  "rowToReviewQueue",
  "rowToReviewQueueItem",
  "rowToRegressionRun",
  "toIso",
  "parseJson",
  "toSkillStatus",
  "gateFailureMessage",
  "toFeedbackSyncStatus"
] as const;

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

function namedImports(source: ts.SourceFile, moduleName: string): string[] {
  const declaration = source.statements.find((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteralLike(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName
  );
  if (!declaration?.importClause?.namedBindings || !ts.isNamedImports(declaration.importClause.namedBindings)) {
    throw new Error(`Named import ${moduleName} not found`);
  }
  return declaration.importClause.namedBindings.elements.map((element) => element.name.text);
}

describe("PostgreSQL repository support modules", () => {
  it("pins the pure mapper surface and the sole PgRepository implementation owner", () => {
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const mapperSource = sourceFile(MAPPERS_PATH);
    const program = createApiProgram();
    const compilerMapperSource = program.getSourceFile(MAPPERS_PATH);
    const mapperModule = compilerMapperSource && program.getTypeChecker().getSymbolAtLocation(compilerMapperSource);
    if (!mapperModule) throw new Error("Mapper module symbol was not resolved");

    expect(Object.keys(pgRepository)).toEqual(["PgRepository"]);
    expect(Object.keys(mappers).sort()).toEqual(EXPECTED_MAPPER_EXPORTS);
    expect(program.getTypeChecker().getExportsOfModule(mapperModule).map((symbol) => symbol.name).sort())
      .toEqual(EXPECTED_MAPPER_EXPORTS);
    expect(mapperSource.statements.filter(ts.isFunctionDeclaration).map((statement) => statement.name?.text))
      .toEqual(EXPECTED_MAPPER_FUNCTIONS);
    expect(mapperSource.statements.filter(ts.isVariableStatement).flatMap((statement) =>
      statement.declarationList.declarations.map((declaration) => declaration.name.getText(mapperSource))
    )).toEqual(["GATE_CHECK_RUN_COLUMNS"]);
    expect(mapperSource.statements.filter((statement) =>
      !ts.isImportDeclaration(statement) &&
      !ts.isFunctionDeclaration(statement) &&
      !ts.isVariableStatement(statement)
    )).toEqual([]);
    expect(mapperSource.text).not.toMatch(/\bPool(?:Client)?\b|\.query\s*\(|\.connect\s*\(/);

    expect(namedImports(repositorySource, "./repository.pg/mappers.js").sort())
      .toEqual(EXPECTED_MAPPER_EXPORTS.filter((name) =>
        name !== "GATE_CHECK_RUN_COLUMNS" &&
        name !== "rowToApiKey" &&
        name !== "rowToAssessmentReceiptArtifact" &&
        name !== "rowToAssessmentReceiptComparison" &&
        name !== "rowToCriterion" &&
        name !== "rowToEvaluatorSuite" &&
        name !== "rowToGateCheck" &&
        name !== "rowToGateCheckItem" &&
        name !== "rowToImportJobRecord" &&
        name !== "rowToProject" &&
        name !== "rowToProjectSettings" &&
        name !== "rowToReviewQueue" &&
        name !== "rowToReviewQueueItem" &&
        name !== "rowToRunComparison"
      ));
    expect(namedImports(repositorySource, "./repository.pg/golden-commands.js"))
      .toEqual(["loadGoldenSetRetirementContext"]);
    expect(namedImports(repositorySource, "./repository.pg/dataset-revision-commands.js"))
      .toEqual([
        "getOrCreateRegressionDatasetRevisionWithClient",
        "insertDatasetRevisionWithClient",
        "loadHumanVerdictsForCases",
        "resolveCaseInputIdentity",
        "resolveSingletonCriterionVersionForRegression"
      ]);
    expect(namedImports(repositorySource, "./repository.pg/assessment-receipt-commands.js"))
      .toEqual(["bumpEvalRunCounters", "mintAssessmentReceiptWithClient"]);
    expect(namedImports(repositorySource, "./repository.pg/assessment-receipt-repository.js"))
      .toEqual(["PgAssessmentReceiptRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/api-key-repository.js"))
      .toEqual(["PgApiKeyRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/credential-commands.js"))
      .toEqual(["setJudgeProviderKeyOnClient"]);
    expect(namedImports(repositorySource, "./repository.pg/criterion-suite-repository.js"))
      .toEqual(["PgCriterionSuiteRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/historical-gate-evidence-repository.js"))
      .toEqual(["PgHistoricalGateEvidenceRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/judge-credential-repository.js"))
      .toEqual(["PgJudgeCredentialRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/project-repository.js"))
      .toEqual(["PgProjectRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/regression-run-commands.js"))
      .toEqual(["insertRegressionRun"]);
    expect(namedImports(repositorySource, "./repository.pg/review-queue-repository.js"))
      .toEqual(["PgReviewQueueRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/run-comparison-repository.js"))
      .toEqual(["PgRunComparisonRepository"]);
    expect(namedImports(repositorySource, "./repository.pg/skill-version-commands.js"))
      .toEqual(["insertSkillVersion", "nextVersion"]);
    expect(namedImports(repositorySource, "./repository.pg/trace-import-commands.js"))
      .toEqual(["importTraceOnClient", "lockTraceImportIdentity"]);
    expect(namedImports(repositorySource, "./repository.pg/trace-import-repository.js"))
      .toEqual(["PgTraceImportRepository"]);
    expect(repositorySource.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) =>
      `${ts.SyntaxKind[statement.kind]}:${ts.isClassDeclaration(statement) ? statement.name?.text : "<anonymous>"}`
    )).toEqual(["ClassDeclaration:PgRepository"]);

    const repository = repositorySource.statements.find((statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === "PgRepository"
    );
    if (!repository) throw new Error("PgRepository declaration not found");
    const methods = repository.members.filter(ts.isMethodDeclaration);
    const privateMethods = methods.filter((method) =>
      ts.getModifiers(method)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    );
    expect(methods).toHaveLength(175);
    expect(privateMethods).toHaveLength(14);
    expect(methods.length - privateMethods.length).toBe(161);
  }, 30_000);

  it("pins the extracted command as one caller-owned PoolClient query", () => {
    const commandSource = sourceFile(COMMAND_PATH);
    const program = createApiProgram();
    const compilerCommandSource = program.getSourceFile(COMMAND_PATH);
    const commandModule = compilerCommandSource && program.getTypeChecker().getSymbolAtLocation(compilerCommandSource);
    if (!commandModule) throw new Error("Golden command module symbol was not resolved");
    const functions = commandSource.statements.filter(ts.isFunctionDeclaration);
    expect(Object.keys(commands)).toEqual(["loadGoldenSetRetirementContext"]);
    expect(program.getTypeChecker().getExportsOfModule(commandModule).map((symbol) => symbol.name))
      .toEqual(["loadGoldenSetRetirementContext"]);
    expect(commandSource.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) =>
      `${ts.SyntaxKind[statement.kind]}:${ts.isFunctionDeclaration(statement) ? statement.name?.text : "<anonymous>"}`
    )).toEqual(["FunctionDeclaration:loadGoldenSetRetirementContext"]);
    expect(functions.map((statement) => statement.name?.text)).toEqual(["loadGoldenSetRetirementContext"]);
    expect(functions[0]?.parameters.map((parameter) => parameter.type?.getText(commandSource))).toEqual([
      "PoolClient",
      "string",
      "string"
    ]);
    expect(commandSource.text.match(/\.query\s*\(/g)).toHaveLength(1);
    expect(commandSource.text).not.toMatch(/\.connect\s*\(|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\.release\s*\(/);
  });

  it("preserves golden-retirement context parsing and exact query arguments", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const rows: Array<Record<string, unknown>> = [{
      retired_at: "2026-09-01T20:00:00.000Z",
      actor_user_id: "user-1",
      actor_name: "Ada",
      actor_email: "ada@example.test",
      metadata: JSON.stringify({ reason: "superseded" })
    }];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows };
      }
    } as unknown as PoolClient;

    await expect(commands.loadGoldenSetRetirementContext(client, "project-1", "entry-1")).resolves.toEqual({
      retiredAt: "2026-09-01T20:00:00.000Z",
      retiredByUserId: "user-1",
      retiredBy: "Ada <ada@example.test>",
      reason: "superseded"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(["entry-1", "project-1"]);
    expect(calls[0]?.sql.replace(/\s+/g, " ").trim()).toContain(
      "from golden_set_entries gse left join lateral"
    );

    rows.splice(0, 1);
    await expect(commands.loadGoldenSetRetirementContext(client, "project-1", "missing")).resolves.toBeNull();

    rows.push({
      retired_at: "2026-09-01T20:00:00.000Z",
      actor_user_id: "user-2",
      actor_name: null,
      actor_email: null,
      metadata: null
    });
    await expect(commands.loadGoldenSetRetirementContext(client, "project-1", "entry-2")).resolves.toMatchObject({
      retiredByUserId: "user-2",
      retiredBy: "user-2",
      reason: null
    });
  });
});
