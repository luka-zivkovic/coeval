import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnalysisWorkflowMeasurementReportSchema, type BinaryCalibrationArtifact } from "@coeval/shared";
import {
  analysisCalibrationTrialMeasurements,
  analysisWorkflowMeasurementReportDigest,
  deriveAnalysisGovernedDisagreement,
  deriveAnalysisTaxonomyChurn,
  exactDurationMilliseconds,
  verifyAnalysisWorkflowMeasurementReport
} from "../src/lib/analysis-measurement.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

describe("analysis workflow component measurements", () => {
  it("partitions governed disagreement with cannot-determine precedence and separate adjudication", () => {
    const measurement = deriveAnalysisGovernedDisagreement("batch", D1, [
      { requiredLabelCount: 2, assignedTaskCount: 2, activeLabels: ["pass", "pass"], adjudicationDecision: null },
      { requiredLabelCount: 2, assignedTaskCount: 2, activeLabels: ["pass", "fail"], adjudicationDecision: "pass" },
      { requiredLabelCount: 2, assignedTaskCount: 2, activeLabels: ["pass", "cannot_determine"], adjudicationDecision: null },
      { requiredLabelCount: 2, assignedTaskCount: 2, activeLabels: ["pass"], adjudicationDecision: null },
      { requiredLabelCount: 2, assignedTaskCount: 3, activeLabels: ["pass", "pass"], adjudicationDecision: null },
      { requiredLabelCount: 2, assignedTaskCount: 2, activeLabels: ["pass", "fail"], adjudicationDecision: "unresolvable" },
      { requiredLabelCount: 1, assignedTaskCount: 1, activeLabels: ["fail"], adjudicationDecision: null }
    ]);
    expect(measurement).toMatchObject({
      selectedItemCount: 7,
      unanimous: 1,
      mixedPassFail: 1,
      cannotDetermine: 1,
      coverageGap: 2,
      unresolvable: 1,
      singleRater: 1,
      adjudicated: 1
    });
  });

  it("reports taxonomy churn as separate components and ignores reorder", () => {
    const churn = deriveAnalysisTaxonomyChurn({
      taxonomyRevisionId: "revision-2",
      taxonomyRevisionDigest: D2,
      taxonomyRevisionSequence: 2,
      predecessorRevisionId: "revision-1",
      predecessorRevisionDigest: D1,
      predecessorCodes: [
        { codeId: "a", label: "A", definition: "old", status: "active" },
        { codeId: "b", label: "B", definition: "same", status: "active" }
      ],
      currentCodes: [
        { codeId: "b", label: "B", definition: "same", status: "retired" },
        { codeId: "a", label: "A2", definition: "new", status: "active" },
        { codeId: "c", label: "C", definition: "added", status: "active" }
      ],
      observationReassignments: 3
    });
    expect(churn).toMatchObject({
      additions: 1,
      labelChanges: 1,
      definitionChanges: 1,
      retirements: 1,
      observationReassignments: 3
    });
  });

  it("binds report semantics while excluding read time from its digest", () => {
    const content = {
      contractVersion: "coeval/analysis-workflow-measurement/v1" as const,
      calculationVersion: "analysis-workflow-components/v1" as const,
      projectId: "project",
      studyId: "study",
      populationId: "population",
      drawId: "draw",
      datasetRevisionId: "revision",
      studyCreatedAt: "2026-08-24T00:00:00.000Z",
      studyState: "coding_open" as const,
      coding: {
        selectedItemCount: 3,
        viewedItemCount: 2,
        inProgressItemCount: 1,
        completedItemCount: 1,
        noFailureObservedItemCount: 1,
        missingItemCount: 1
      },
      taxonomy: { state: "not_requested" as const },
      evaluatorOptions: [],
      evaluator: null
    };
    const report = AnalysisWorkflowMeasurementReportSchema.parse({
      ...content,
      reportDigest: analysisWorkflowMeasurementReportDigest(content),
      calculatedAt: "2026-08-24T01:00:00.000Z"
    });
    expect(verifyAnalysisWorkflowMeasurementReport(report)).toEqual(report);
    expect(analysisWorkflowMeasurementReportDigest(content)).toBe(
      analysisWorkflowMeasurementReportDigest({ ...content, studyState: "coding_open" })
    );
    expect(() => verifyAnalysisWorkflowMeasurementReport({
      ...report,
      coding: { ...report.coding, viewedItemCount: 3 }
    })).toThrow(/digest mismatch/);
    expect(AnalysisWorkflowMeasurementReportSchema.safeParse({ ...report, compositeScore: 0.9 }).success).toBe(false);
    const duplicateOption = {
      lifecycleId: "lifecycle",
      promotionId: "promotion",
      criterionId: "criterion",
      criterionVersionId: "criterion-version",
      skillId: "skill",
      skillVersionId: "version"
    };
    expect(AnalysisWorkflowMeasurementReportSchema.safeParse({
      ...report,
      evaluatorOptions: [duplicateOption, duplicateOption]
    }).success).toBe(false);
  });

  it("keeps missing and incomplete states distinct from zero and computes exact durations", () => {
    expect(exactDurationMilliseconds(
      "2026-08-24T00:00:00.000Z",
      "2026-08-24T00:00:01.234Z"
    )).toBe("1234");
    expect(() => exactDurationMilliseconds(
      "2026-08-24T00:00:01.000Z",
      "2026-08-24T00:00:00.000Z"
    )).toThrow(/reverse ordered/);
  });

  it("copies error directions and Wilson coverage only from the exact public aggregate artifact", () => {
    const artifact = JSON.parse(readFileSync(new URL(
      "../../../contracts/fixtures/binary-calibration-v1.complete.json",
      import.meta.url
    ), "utf8")) as BinaryCalibrationArtifact;
    const trials = analysisCalibrationTrialMeasurements(artifact);
    expect(trials).toHaveLength(1);
    expect(trials[0]).toMatchObject({
      falsePass: artifact.trials[0]!.errorDirections.falsePass,
      falseFail: artifact.trials[0]!.errorDirections.falseFail,
      classifiedCoverage: artifact.trials[0]!.metrics.classifiedCoverage
    });
    expect(JSON.stringify(trials)).not.toContain("providerIdentityGroups");
    expect(JSON.stringify(trials)).not.toContain("privateLedger");
  });
});
