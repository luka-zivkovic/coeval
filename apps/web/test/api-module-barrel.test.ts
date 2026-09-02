import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as api from "../src/lib/api.js";
import * as datasetsEvaluation from "../src/lib/api/datasets-evaluation.js";
import * as integrations from "../src/lib/api/integrations.js";
import * as projects from "../src/lib/api/projects.js";
import * as traceReview from "../src/lib/api/trace-review.js";
import * as transport from "../src/lib/api/transport.js";

const EXPECTED_PUBLIC_EXPORTS = [
  "ApiError",
  "CompletedSkillVersionResult",
  "CreateSkillVersionResult",
  "SkillVersionBackfillEnsureResult",
  "SkillVersionBackfillSummary",
  "adjudicateCase",
  "assistTraceTestDraft",
  "buildVerdictExportUrl",
  "createAgentSetupPairing",
  "createApiKey",
  "createDataset",
  "createDatasetRevision",
  "createDatasetRevisionEvalRun",
  "createEvalRun",
  "createIronsideIntegration",
  "createLangSmithIntegration",
  "createLangfuseIntegration",
  "createOnboardingCheck",
  "createProject",
  "createReviewQueue",
  "createRunComparison",
  "createSkillVersion",
  "createTraceTest",
  "deleteIronsideIntegration",
  "deleteJudgeKey",
  "deleteLangSmithIntegration",
  "deleteLangfuseIntegration",
  "deleteProject",
  "enableTraceTest",
  "ensureSkillVersionBackfill",
  "fetchAgentSetupPairing",
  "fetchApiKeys",
  "fetchCaseDetail",
  "fetchCaseVerdicts",
  "fetchCriteria",
  "fetchCriterionDetail",
  "fetchCurrentSkill",
  "fetchDashboard",
  "fetchDatasetDetail",
  "fetchDatasetRevision",
  "fetchDatasetRevisionMetadata",
  "fetchDatasetRevisions",
  "fetchDatasets",
  "fetchDisagreements",
  "fetchEvalRunDetail",
  "fetchEvalRuns",
  "fetchFeedbackSyncs",
  "fetchGoldenSet",
  "fetchGoldenSetHealth",
  "fetchImportJobs",
  "fetchIronsideIntegrations",
  "fetchJudgeCard",
  "fetchJudgeCardMarkdown",
  "fetchJudgeHumanCalibration",
  "fetchJudgeHumanDisagreements",
  "fetchJudgeKeys",
  "fetchJudgeModels",
  "fetchJudgeProviders",
  "fetchKappaSummary",
  "fetchLangSmithIntegrations",
  "fetchLangfuseIntegrations",
  "fetchLatestSkill",
  "fetchOnboardingEvidenceInventory",
  "fetchProjectSettings",
  "fetchProjectVerdicts",
  "fetchProjects",
  "fetchReviewQueueDetail",
  "fetchReviewQueues",
  "fetchRunComparisonDetail",
  "fetchRunComparisons",
  "fetchSetupState",
  "fetchSkillFormat",
  "fetchSkillVersionConvergence",
  "fetchSkillVersionCriterion",
  "fetchSkillVersionHistory",
  "fetchSkillVersionRegression",
  "fetchSkillVersionSelfConsistency",
  "fetchSkillVersions",
  "fetchTraceTest",
  "fetchTraceTests",
  "fetchTrustDigest",
  "importDatasetExamples",
  "importTrace",
  "promoteExceptionToGoldenSet",
  "pruneExpiredTraces",
  "publicApiBaseUrl",
  "recordHumanVerdict",
  "recordManualTraceTestValidation",
  "recordTraceTestFunnelEvent",
  "retireGoldenSetEntry",
  "reviseTraceTest",
  "revokeAgentSetupPairing",
  "revokeApiKey",
  "runNextUncoveredConvergenceCase",
  "runTraceTestValidation",
  "selectProject",
  "selectedProjectId",
  "setJudgeKey",
  "setupOwner",
  "signOffSkillVersion",
  "startTraceTestRun",
  "testIronsideIntegration",
  "testLangSmithIntegration",
  "testLangfuseIntegration",
  "triggerIronsideImport",
  "triggerLangSmithImport",
  "triggerLangfuseImport",
  "updateIronsideIntegration",
  "updateLangSmithIntegration",
  "updateLangfuseIntegration",
  "updateProjectSettings"
] as const;

const TYPE_ONLY_EXPORTS = new Set([
  "CompletedSkillVersionResult",
  "CreateSkillVersionResult",
  "SkillVersionBackfillEnsureResult",
  "SkillVersionBackfillSummary"
]);

const INTERNAL_TRANSPORT_EXPORTS = [
  "API_BASE",
  "apiError",
  "apiErrorFromResponse",
  "apiFetch",
  "queryPath"
] as const;

const modules = [
  ["datasets-evaluation", datasetsEvaluation],
  ["integrations", integrations],
  ["projects", projects],
  ["trace-review", traceReview],
  ["transport", transport]
] as const;

describe("web API compatibility barrel", () => {
  it("preserves the exact TypeScript export surface", () => {
    const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const entryPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
    const entry = program.getSourceFile(entryPath);
    if (!entry) throw new Error("The web API barrel was not loaded by TypeScript");
    const entrySymbol = program.getTypeChecker().getSymbolAtLocation(entry);
    if (!entrySymbol) throw new Error("The web API barrel has no module symbol");
    const actual = program.getTypeChecker().getExportsOfModule(entrySymbol).map((symbol) => symbol.getName()).sort();

    expect(actual).toEqual([...EXPECTED_PUBLIC_EXPORTS].sort());
  }, 30_000);

  it("preserves every runtime binding identity without leaking transport internals", () => {
    const expectedRuntime = EXPECTED_PUBLIC_EXPORTS.filter((name) => !TYPE_ONLY_EXPORTS.has(name));
    expect(Object.keys(api).sort()).toEqual([...expectedRuntime].sort());

    const owners = new Map<string, Array<{ module: string; value: unknown }>>();
    for (const [module, bindings] of modules) {
      for (const [name, value] of Object.entries(bindings)) {
        const entries = owners.get(name) ?? [];
        entries.push({ module, value });
        owners.set(name, entries);
      }
    }
    expect([...owners.keys()].sort()).toEqual([...expectedRuntime, ...INTERNAL_TRANSPORT_EXPORTS].sort());
    for (const name of expectedRuntime) {
      const entries = owners.get(name);
      expect(entries, `${name} must have exactly one implementation module`).toHaveLength(1);
      expect((api as Record<string, unknown>)[name], name).toBe(entries![0]!.value);
    }
    for (const name of INTERNAL_TRANSPORT_EXPORTS) expect(api).not.toHaveProperty(name);
  });
});
