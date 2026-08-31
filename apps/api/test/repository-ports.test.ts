import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as ports from "../src/repository/ports.js";

const EXPECTED_PORT_METHODS = {
  ProjectRepositoryPort: [
    "listProjects", "getProjectSettings", "updateProjectSettings", "pruneExpiredTraces",
    "deleteProject", "getDashboardSummary", "getOnboardingEvidenceInventory"
  ],
  CriterionSuiteRepositoryPort: [
    "listCriteria", "getCriterion", "createCriterion", "createCriterionVersion",
    "listEvaluatorSuites", "getEvaluatorSuite", "createEvaluatorSuiteManifest",
    "listEvaluatorSuiteManifests", "getEvaluatorSuiteManifest"
  ],
  SkillLifecycleRepositoryPort: [
    "getCurrentSkill", "getCurrentSkillForCriterion", "getLatestSkillForCriterion",
    "getLatestSkill", "getSkillVersion", "authorizeSkillVersionExecution",
    "getCriterionVersionForSkillVersion", "signOffSkillVersion", "createSkillVersion",
    "createSkillVersionPending", "runRegressionGateForVersion", "failRegressionGateForVersion",
    "listSkillVersions", "listRegressionRunsForVersions", "getRegressionRunForVersion"
  ],
  GoldenEvidenceRepositoryPort: [
    "listGoldenSet", "getSkillFormatExamples", "getGoldenSetHealth", "getExceptionDetail",
    "getCaseDetail", "promoteExceptionToGoldenSet", "retireGoldenSetEntry", "getGoldenSetTraces"
  ],
  TraceImportRepositoryPort: [
    "importTrace", "createImportJob", "markImportJobQueued", "markImportJobRunning",
    "markImportJobCompleted", "markImportJobFailed", "listImportJobs"
  ],
  IntegrationRepositoryPort: [
    "listLangSmithIntegrations", "createLangSmithIntegration", "updateLangSmithIntegration",
    "recordLangSmithConnectionTest", "deleteLangSmithIntegration", "claimDueLangSmithImportTargets",
    "loadLangSmithImportContext", "listLangfuseIntegrations", "createLangfuseIntegration",
    "updateLangfuseIntegration", "recordLangfuseConnectionTest", "deleteLangfuseIntegration",
    "claimDueLangfuseImportTargets", "loadLangfuseImportContext", "listIronsideIntegrations",
    "createIronsideIntegration", "updateIronsideIntegration", "recordIronsideConnectionTest",
    "quarantineIronsideIntegration", "deleteIronsideIntegration", "claimDueIronsideImportTargets",
    "loadIronsideImportContext", "saveIronsideSyncState"
  ],
  JudgeFeedbackRepositoryPort: [
    "loadJudgeRunContext", "recordJudgeRun", "createFeedbackSyncJob", "loadFeedbackSyncContext",
    "listFeedbackSyncJobs", "markFeedbackSyncSucceeded", "markFeedbackSyncFailed",
    "markFeedbackSyncBlocked", "markFeedbackSyncPending", "listBlockedIronsideFeedbackSyncJobs"
  ],
  CaseEvidenceRepositoryPort: [
    "listCaseIdsForProject", "listCases", "recordVerdict", "listVerdicts",
    "caseExistsForProject", "getProjectKappaSummary", "getProjectJudgeHumanCalibration",
    "getDisagreementSummary", "getJudgeHumanDisagreementSummary", "getConvergenceAudit",
    "getSelfConsistencyReport", "listAuditEntries"
  ],
  ReviewQueueRepositoryPort: [
    "createReviewQueue", "listReviewQueues", "getReviewQueueDetail", "getNextPendingQueueItem",
    "closeReviewQueue", "reopenReviewQueue", "addReviewQueueItems"
  ],
  ApiKeyRepositoryPort: ["createApiKey", "listApiKeys", "revokeApiKey", "resolveApiKey"],
  TraceTestRepositoryPort: [
    "createTraceTest", "listTraceTests", "getTraceTest", "reviseTraceTest",
    "recordTraceTestValidation", "enableTraceTest", "recordTraceTestFunnelEvent"
  ],
  DatasetRepositoryPort: [
    "createDataset", "listDatasets", "getDatasetDetail", "archiveDataset", "addDatasetItems",
    "importDatasetExamples", "createDatasetRevision", "listDatasetRevisions",
    "getDatasetRevisionDetail", "recordDatasetRevisionContentView",
    "getOrCreateRegressionDatasetRevision", "removeDatasetItem"
  ],
  JudgeCredentialRepositoryPort: [
    "setJudgeProviderKey", "listJudgeProviderKeys", "deleteJudgeProviderKey",
    "getJudgeProviderCredential"
  ],
  EvalRunRepositoryPort: [
    "createEvalRun", "createConvergenceEvalRun", "createImportedCaseEvalRun",
    "claimEvalRunDispatch", "rotateEvalRunDispatchJob", "markEvalRunDispatched",
    "releaseEvalRunDispatch", "armEvalRunItemDeliveryDeadline", "markEvalRunRunning",
    "listPendingEvalRunItems", "listPendingEvalRunItemDispatches", "claimEvalRunItemExecution",
    "rearmEvalRunItemDeliveryDeadline", "claimEvalRunItemRecovery", "beginEvalRunItemProviderCall",
    "markEvalRunItemProviderCallReturned", "releaseEvalRunItemExecution",
    "listStaleEvalRunItemExecutions", "getEvalRunItem", "completeEvalRunItem",
    "failEvalRunItem", "getEvalRun", "getEvalRunDetail", "listEvalRuns",
    "deleteUndispatchedEvalRun"
  ],
  AssessmentReceiptRepositoryPort: [
    "getOrFreezeAssessmentReceipt", "getAssessmentReceiptArtifactByReceiptId",
    "listAssessmentReceiptArtifacts", "compareAssessmentReceiptCopy",
    "createAssessmentReceiptCorrection"
  ],
  RunComparisonRepositoryPort: ["createRunComparison", "getRunComparison", "listRunComparisons"],
  HistoricalGateEvidenceRepositoryPort: ["createGateCheck", "getGateCheckDetail", "listGateChecks"]
} as const;

function loadRepositoryTypes(): {
  checker: ts.TypeChecker;
  portsSource: ts.SourceFile;
  portsSymbol: ts.Symbol;
  repositoryDeclaration: ts.InterfaceDeclaration;
  repositorySymbol: ts.Symbol;
} {
  const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
  const configPath = ts.findConfigFile(apiDirectory, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const portsPath = fileURLToPath(new URL("../src/repository/ports.ts", import.meta.url));
  const repositoryPath = fileURLToPath(new URL("../src/repository.ts", import.meta.url));
  const program = ts.createProgram([portsPath, repositoryPath], parsed.options);
  const checker = program.getTypeChecker();
  const portsSource = program.getSourceFile(portsPath);
  const repositorySource = program.getSourceFile(repositoryPath);
  if (!portsSource || !repositorySource) throw new Error("Repository sources were not loaded by TypeScript");
  const portsSymbol = checker.getSymbolAtLocation(portsSource);
  const repositoryModule = checker.getSymbolAtLocation(repositorySource);
  if (!portsSymbol || !repositoryModule) throw new Error("Repository module symbols were not resolved");
  const repositorySymbol = checker.getExportsOfModule(repositoryModule)
    .find((symbol) => symbol.name === "CoevalRepository");
  if (!repositorySymbol) throw new Error("CoevalRepository export was not resolved");
  const repositoryDeclarations = repositorySymbol.declarations?.filter(ts.isInterfaceDeclaration) ?? [];
  if (repositoryDeclarations.length !== 1) {
    throw new Error(`Expected one CoevalRepository interface declaration, found ${repositoryDeclarations.length}`);
  }
  const repositoryDeclaration = repositoryDeclarations[0];
  if (!repositoryDeclaration) throw new Error("CoevalRepository interface declaration was not resolved");
  return { checker, portsSource, portsSymbol, repositoryDeclaration, repositorySymbol };
}

describe("repository ports", () => {
  it("remain declaration-only at runtime", () => {
    expect(Object.keys(ports)).toEqual([]);
  });

  it("partition the complete facade into exact, disjoint method groups", () => {
    const {
      checker,
      portsSource,
      portsSymbol,
      repositoryDeclaration,
      repositorySymbol
    } = loadRepositoryTypes();
    const portSymbols = checker.getExportsOfModule(portsSymbol);
    expect(portSymbols.map((symbol) => symbol.name)).toEqual(Object.keys(EXPECTED_PORT_METHODS));

    const actual = Object.fromEntries(portSymbols.map((symbol) => [
      symbol.name,
      checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol)).map((property) => property.name)
    ]));
    expect(actual).toEqual(EXPECTED_PORT_METHODS);

    const expectedFacadeMethods = Object.values(EXPECTED_PORT_METHODS).flat();
    expect(new Set(expectedFacadeMethods).size).toBe(expectedFacadeMethods.length);
    expect(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(repositorySymbol)).map((property) => property.name))
      .toEqual(expectedFacadeMethods);

    const heritageClauses = repositoryDeclaration.heritageClauses ?? [];
    expect(heritageClauses).toHaveLength(1);
    expect(heritageClauses[0]?.token).toBe(ts.SyntaxKind.ExtendsKeyword);
    const expectedPortNames = Object.keys(EXPECTED_PORT_METHODS);
    const heritageTypes = heritageClauses[0]?.types ?? [];
    expect(heritageTypes.map((type) => type.getText())).toEqual(expectedPortNames);
    for (const [index, heritageType] of heritageTypes.entries()) {
      const heritageSymbol = checker.getSymbolAtLocation(heritageType.expression);
      if (!heritageSymbol) throw new Error(`Heritage symbol was not resolved: ${heritageType.getText()}`);
      const resolvedHeritageSymbol = heritageSymbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(heritageSymbol)
        : heritageSymbol;
      expect(
        resolvedHeritageSymbol === portSymbols[index],
        `${heritageType.getText()} must resolve to the exported repository port symbol`
      ).toBe(true);
    }
    expect(repositoryDeclaration.members).toHaveLength(0);

    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
    const declarations = Object.fromEntries(portsSource.statements
      .filter(ts.isInterfaceDeclaration)
      .map((declaration) => [
        declaration.name.text,
        declaration.members.map((member) => ({
          kind: ts.SyntaxKind[member.kind],
          signature: printer.printNode(ts.EmitHint.Unspecified, member, portsSource)
            .replace(/\s+/g, " ")
            .trim()
        }))
      ]));
    expect(declarations).toMatchSnapshot("repository port declarations");
  }, 30_000);
});
