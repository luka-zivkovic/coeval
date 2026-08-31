import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repository from "../src/repository.js";
import * as contracts from "../src/repository/contracts.js";
import * as errors from "../src/repository/errors.js";
import * as helpers from "../src/repository/helpers.js";

const EXPECTED_RUNTIME_EXPORTS = [
  "AgentSetupEligibilityError",
  "AmbiguousProjectSkillError",
  "AssessmentReceiptIntegrityError",
  "AssessmentReceiptUnavailableError",
  "CaseNotFoundError",
  "CriterionStableKeyConflictError",
  "DatasetNameTakenError",
  "DatasetNotFoundError",
  "DatasetRevisionConflictError",
  "DatasetRevisionNotFoundError",
  "DemoRepository",
  "EvaluatorSuiteBindingError",
  "EvaluatorSuiteIdempotencyConflictError",
  "FeedbackSyncCredentialsMissingError",
  "FeedbackSyncJobNotFoundError",
  "GateRunBindingMismatchError",
  "GoldenSetEntryAlreadyRetiredError",
  "GoldenSetEntryNotFoundError",
  "GoldenSetLabelConflictError",
  "ImportSkillVersionBindingError",
  "InvalidConvergenceCursorError",
  "IronsideCredentialsMissingError",
  "IronsideIntegrationAlreadyExistsError",
  "IronsideIntegrationChangedError",
  "IronsideIntegrationNotFoundError",
  "IronsideIntegrationRevalidationRequiredError",
  "LangSmithCredentialsMissingError",
  "LangSmithIntegrationNotFoundError",
  "LangfuseCredentialsMissingError",
  "LangfuseIntegrationNotFoundError",
  "NoCurrentSkillError",
  "OnboardingCheckConflictError",
  "RecursiveTraceSkippedError",
  "RegressionGateJudgeError",
  "RegressionGateUnavailableError",
  "SealedValidationUnavailableError",
  "SkillVersionNotSignableError",
  "TRACE_INGESTION_PURPOSES_BY_SOURCE",
  "TraceTestNotFoundError",
  "TraceTestRevisionConflictError",
  "TraceTestSourceNotFoundError",
  "TraceTestValidationNotReadyError",
  "assertTraceIngestionPurpose",
  "buildGoldenSetHealthSummary",
  "computeEvalRunSpend",
  "convergenceChangeRank",
  "convergencePageLimit",
  "decodeConvergenceCursor",
  "encodeConvergenceCursor",
  "judgeKeyDisplay",
  "previousVerdictsFromRun",
  "runGoldenSetRegression",
  "traceTestValidationDiagnostic",
  "traceTestValidationIsEnableEligible",
  "traceTestValidationStatus"
] as const;

const EXPECTED_TYPE_ONLY_EXPORTS = [
  "AddDatasetItemsInputDb",
  "AddQueueItemsInputDb",
  "AssessmentReceiptArtifact",
  "AssessmentReceiptArtifactSource",
  "AssessmentReceiptComparison",
  "CaseListEntry",
  "ClaimIronsideImportTargetsInput",
  "ClaimLangSmithImportTargetsInput",
  "ClaimLangfuseImportTargetsInput",
  "CoevalRepository",
  "CompareAssessmentReceiptCopyInput",
  "CompleteEvalRunItemInputDb",
  "CompleteImportJobInput",
  "ConvergenceAuditPageInput",
  "ConvergenceCursor",
  "CreateApiKeyInputDb",
  "CreateAssessmentReceiptCorrectionInput",
  "CreateConvergenceEvalRunInputDb",
  "CreateDatasetInputDb",
  "CreateDatasetRevisionDbInput",
  "CreateEvalRunInputDb",
  "CreateGateCheckInputDb",
  "CreateImportJobInput",
  "CreateImportedCaseEvalRunInputDb",
  "CreateReviewQueueInputDb",
  "CreateRunComparisonInputDb",
  "CreateSkillVersionContext",
  "CreateTraceTestInputDb",
  "EnableTraceTestInputDb",
  "EvalRunDispatchClaim",
  "EvalRunDispatchInputDb",
  "EvalRunItemExecutionClaim",
  "EvalRunItemExecutionInputDb",
  "EvalRunItemReleaseDisposition",
  "EvalRunItemReleaseOptions",
  "FailEvalRunItemInputDb",
  "FeedbackSyncContext",
  "FeedbackSyncJobListItem",
  "FeedbackSyncJobRecord",
  "FeedbackSyncProvider",
  "FeedbackSyncStatus",
  "ImportDatasetExamplesDbInput",
  "ImportDatasetExamplesDbResult",
  "IronsideCredentials",
  "IronsideImportContext",
  "JudgeRunContext",
  "LangSmithCredentials",
  "LangSmithImportContext",
  "LangfuseCredentials",
  "LangfuseImportContext",
  "ListCasesOptions",
  "ListFeedbackSyncJobsInput",
  "ListImportJobsInput",
  "ListVerdictsInput",
  "PreparedDatasetRevisionItem",
  "PromoteExceptionToGoldenSetInput",
  "RecordJudgeRunInput",
  "RecordTraceTestFunnelEventInputDb",
  "RecordTraceTestValidationInputDb",
  "RecordVerdictInput",
  "RetireGoldenSetEntryInput",
  "ReviseTraceTestInputDb",
  "StaleEvalRunItemExecution",
  "TraceImportContext",
  "TraceImportResult"
] as const;

function repositoryCompilerExports(): { all: string[]; typeOnly: string[] } {
  const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
  const configPath = ts.findConfigFile(apiDirectory, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const repositoryPath = fileURLToPath(new URL("../src/repository.ts", import.meta.url));
  const program = ts.createProgram([repositoryPath], parsed.options);
  const source = program.getSourceFile(repositoryPath);
  if (!source) throw new Error("Repository source was not loaded by TypeScript");

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error("Repository module symbol was not resolved by TypeScript");

  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  return {
    all: moduleExports.map((symbol) => symbol.name).sort(),
    typeOnly: moduleExports.filter((symbol) => {
      const resolved = symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
      return (resolved.flags & ts.SymbolFlags.Value) === 0;
    })
      .map((symbol) => symbol.name)
      .sort()
  };
}

describe("repository module barrel", () => {
  it("preserves the exact runtime API and sibling binding identity", () => {
    expect(Object.keys(repository).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
    expect(Object.keys(contracts)).toEqual([]);

    for (const [name, value] of Object.entries({ ...errors, ...helpers })) {
      expect(repository, `missing root export ${name}`).toHaveProperty(name);
      expect(repository[name as keyof typeof repository], `root export ${name} must preserve identity`).toBe(value);
    }
  });

  it("preserves the exact type-only API", () => {
    const compilerExports = repositoryCompilerExports();
    expect(compilerExports.all).toEqual(
      [...EXPECTED_RUNTIME_EXPORTS, ...EXPECTED_TYPE_ONLY_EXPORTS].sort()
    );
    expect(compilerExports.typeOnly).toEqual(EXPECTED_TYPE_ONLY_EXPORTS);
  }, 30_000);
});
