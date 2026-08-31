import { describe, expect, it } from "vitest";
import * as shared from "@coeval/shared";
import * as agentAccess from "../../../packages/shared/dist/agent-access.js";
import * as analysisMeasurement from "../../../packages/shared/dist/analysis-measurement.js";
import * as analysisPopulation from "../../../packages/shared/dist/analysis-population.js";
import * as analysisStudy from "../../../packages/shared/dist/analysis-study.js";
import * as binaryCalibration from "../../../packages/shared/dist/binary-calibration.js";
import * as criterionGovernance from "../../../packages/shared/dist/criterion-governance.js";
import * as datasets from "../../../packages/shared/dist/datasets.js";
import * as evaluationRuns from "../../../packages/shared/dist/evaluation-runs.js";
import * as evaluatorLifecycle from "../../../packages/shared/dist/evaluator-lifecycle.js";
import * as governedReview from "../../../packages/shared/dist/governed-review.js";
import * as integrations from "../../../packages/shared/dist/integrations.js";
import * as judge from "../../../packages/shared/dist/judge.js";
import * as legacyReview from "../../../packages/shared/dist/legacy-review.js";
import * as projects from "../../../packages/shared/dist/projects.js";
import * as skills from "../../../packages/shared/dist/skills.js";
import * as traceTests from "../../../packages/shared/dist/trace-tests.js";
import * as traces from "../../../packages/shared/dist/traces.js";
import * as verdicts from "../../../packages/shared/dist/verdicts.js";

const rootExports = shared as Record<string, unknown>;

function expectRootIdentity(
  moduleExports: Record<string, unknown>,
  internalOnly: ReadonlySet<string> = new Set()
): void {
  for (const [name, value] of Object.entries(moduleExports)) {
    if (internalOnly.has(name)) {
      expect(rootExports).not.toHaveProperty(name);
      continue;
    }
    expect(rootExports, `missing root export ${name}`).toHaveProperty(name);
    expect(rootExports[name], `root export ${name} must preserve object identity`).toBe(value);
  }
}

describe("shared module barrel", () => {
  it("re-exports each public runtime binding by identity and keeps sibling helpers private", () => {
    expectRootIdentity(agentAccess);
    expectRootIdentity(analysisMeasurement);
    expectRootIdentity(analysisPopulation, new Set([
      "AnalysisPopulationCursorSchema",
      "AnalysisPopulationIdSchema",
      "AnalysisPopulationRequestTimestampSchema",
      "AnalysisPopulationTimestampSchema"
    ]));
    expectRootIdentity(analysisStudy, new Set([
      "AnalysisCommandIdempotencyKeySchema",
      "AnalysisIdempotencyKeySchema"
    ]));
    expectRootIdentity(binaryCalibration);
    expectRootIdentity(criterionGovernance);
    expectRootIdentity(datasets);
    expectRootIdentity(evaluationRuns);
    expectRootIdentity(evaluatorLifecycle);
    expectRootIdentity(governedReview);
    expectRootIdentity(integrations);
    expectRootIdentity(judge, new Set(["HttpUrlSchema", "UnicodeScalarValueSchema"]));
    expectRootIdentity(legacyReview);
    expectRootIdentity(projects);
    expectRootIdentity(skills);
    expectRootIdentity(traceTests);
    expectRootIdentity(traces, new Set(["TraceStepsSchema"]));
    expectRootIdentity(verdicts);
  });
});
